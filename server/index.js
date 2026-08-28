const path = require('path');
const fs = require('fs');
// videoId goes straight from the query string into path.join() for every
// file this app touches (stream cache, downloads, thumbnail sidecars) —
// with nothing checking its shape, a request like
// videoId=../../../../whatever could read/write files way outside
// temp_audio/downloads. both local servers listen on all interfaces too (no
// host restriction on .listen()), so this isnt just a same-machine thing —
// anything on the network can hit them. real youtube video ids are always
// exactly 11 of these chars, so just requiring that shape closes the
// traversal hole off entirely without touching every call site individually
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
function isValidVideoId(id) {
  return YOUTUBE_ID_RE.test(id);
}
const http = require('http');
const express = require('express');
const cors = require('cors');
const ytdlpBin = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
// yt-dlp-exec's bundled yt-dlp.exe is a pyinstaller "onefile" build, which
// re-extracts its whole embedded python runtime to a temp dir on EVERY
// single launch — measured a consistent ~5.3s of pure startup overhead on
// this machine before a single network request even goes out, which was
// most of what made "buffering" feel so long. the "onedir" distribution
// (unpacked once at node_modules/yt-dlp-exec/bin/yt-dlp-fast/, see the repo
// readme for how its set up) skips that re-extraction and starts in ~2.3s
// instead. falls back to the bundled binary if that folder isnt there (e.g
// a fresh install elsewhere that hasnt set it up yet)
const fastYtdlpPath = path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp-fast', 'yt-dlp.exe');
const ytdlpExec = fs.existsSync(fastYtdlpPath) ? ytdlpBin.create(fastYtdlpPath) : ytdlpBin;
// bundling ffmpeg via ffmpeg-static so audio extraction just works out of
// the box — yt-dlp's postprocessing (format conversion) hard-requires
// ffmpeg/ffprobe on PATH otherwise, and most people dont have that installed
const ytdlp = (url, options = {}) => ytdlpExec(url, { ffmpegLocation: ffmpegPath, ...options });
const ytSearch = require('yt-search');
const axios = require('axios');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const WebSocket = require('ws');
const crypto = require('crypto');

// detect local helper mode (runs alongside the vps, just handles yt-dlp/ffmpeg endpoints)
const IS_LOCAL_HELPER = process.argv.includes('--local-helper') || process.env.LOCAL_HELPER === '1';
const LOCAL_HELPER_PORT = Number(process.env.LOCAL_HELPER_PORT || process.env.PORT || 3002);

// tauri sets APP_DATA_DIR once installed, pointing at a proper per-user
// writable location (AppData\Roaming\<id>) instead of wherever this code
// happens to be sitting — an installed app's own folder (program files)
// isnt writable by a normal user account. falls back to the project root
// for plain `node server/index.js` dev runs where nothing set that var
const APP_DATA_DIR = process.env.APP_DATA_DIR || path.join(__dirname, '..');
function appDataPath(...segments) {
  const full = path.join(APP_DATA_DIR, ...segments);
  const dir = segments.length && segments[segments.length - 1].includes('.') ? path.dirname(full) : full;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return full;
}

if (IS_LOCAL_HELPER) {
  // === local helper mode: just yt-dlp/ffmpeg, no auth, no db, no ws ===
  const helperApp = require('express')();

  // same rust_debug.log the tauri side (and the frontend, via frontend_log)
  // writes to, so ONE combined timeline shows what every layer saw for a
  // given play/search instead of three separate logs to cross-reference
  const debugLogPath = path.join(APP_DATA_DIR, 'rust_debug.log');
  function helperLog(msg) {
    try {
      fs.appendFileSync(debugLogPath, `[${Date.now()}] [helper] ${msg}\n`);
    } catch {
      // logging should never be the reason playback breaks
    }
  }

  // cors for any origin
  helperApp.use(require('cors')({ origin: true, credentials: true }));
  helperApp.use(require('express').json());

  // version check
  helperApp.get('/api/version', (req, res) => {
    res.json({ version: 'local-helper', mode: 'helper' });
  });

  // search (invidious primary, yt-search fallback)
  helperApp.get('/api/search', async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    const INVIDIOUS = [
      'https://invidious.io.lol',
      'https://invidious.flokinet.to',
      'https://inv.nadeko.net',
      'https://yt.artemislena.eu',
      'https://invidious.lunar.icu'
    ];

    // race every instance at once instead of trying them one at a time —
    // going sequentially with a 5s timeout each meant a search could take up
    // to 25s if the first few instances were down/slow, brutal. Promise.any
    // resolves as soon as the fastest instance returns a non-empty result,
    // and only falls through to yt-search if literally every one fails
    let results = [];
    try {
      const data = await Promise.any(
        INVIDIOUS.map(async (instance) => {
          const resp = await axios.get(`${instance}/api/v1/search`, {
            params: { q: query, type: 'video' },
            timeout: 4000
          });
          if (!Array.isArray(resp.data) || resp.data.length === 0) throw new Error('empty');
          return resp.data;
        })
      );
      results = data.slice(0, 20).map(v => ({
        videoId: v.videoId,
        title: v.title || '',
        author: v.author || v.authorId || '',
        duration: v.lengthSeconds || 0,
        thumbnail: v.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
      }));
    } catch {
      // every invidious instance failed or came back empty — fall through
      // to the yt-search fallback below, plan b time
    }

    if (results.length === 0) {
      try {
        const sr = await ytSearch(query);
        results = (sr.videos || []).slice(0, 20).map(v => ({
          videoId: v.videoId, title: v.title, author: v.author.name || v.author,
          duration: v.seconds, thumbnail: v.thumbnail
        }));
      } catch (e) {
        return res.status(500).json({ error: 'Search failed: ' + e.message });
      }
    }
    res.json({ query, results });
  });

  // playlist
  helperApp.get('/api/playlist', async (req, res) => {
    const playlistId = String(req.query.list || req.query.playlistId || '').trim();
    if (!playlistId) return res.status(400).json({ error: 'Missing playlist ID' });
    try {
      const url = `https://www.youtube.com/playlist?list=${playlistId}`;
      const raw = await ytdlp(url, { dumpSingleJson: true, noWarnings: true, noCheckCertificate: true, skipDownload: true, flatPlaylist: true });
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const title = info.title || `Playlist ${playlistId.slice(-6)}`;
      const entries = Array.isArray(info.entries) ? info.entries : [];
      const items = entries.filter(e => e && e.id).map(e => ({
        videoId: e.id, title: e.title || e.title_short || `Track ${e.id}`,
        author: e.uploader || e.uploader_id || ''
      }));
      res.json({ playlistId, title, items });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to fetch playlist' });
    }
  });

  // video info
  helperApp.get('/api/info', async (req, res) => {
    const videoId = String(req.query.videoId || '').trim();
    if (!videoId) return res.status(400).json({ error: 'Missing videoId query parameter' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const raw = await ytdlp(url, { dumpSingleJson: true, noWarnings: true, noCheckCertificate: true, skipDownload: true });
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      res.json({ videoId, title: info.title || '', author: info.uploader || info.channel || '' });
    } catch (error) {
      res.status(500).json({ error: error.message || 'Failed to fetch video info' });
    }
  });

  // one in-flight download per videoId, shared between the background
  // cache-warmer and the fast-path fallback so we never spawn yt-dlp twice
  // for the same track at the same time
  const backgroundDownloads = new Map();
  function downloadToCache(videoId, audioFile) {
    if (backgroundDownloads.has(videoId)) return backgroundDownloads.get(videoId);
    const promise = ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
      extractAudio: true,
      audioFormat: 'm4a',
      output: audioFile,
      noWarnings: true,
      noCheckCertificate: true,
      quiet: true
    }).finally(() => backgroundDownloads.delete(videoId));
    backgroundDownloads.set(videoId, promise);
    return promise;
  }

  function serveLocalFile(req, res, filePath, contentType) {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  }

  // resolved direct-cdn urls, kept around for a while so replaying a track
  // or skipping back doesnt pay the yt-dlp resolve cost again — these urls
  // are normally valid for several hours, this just caches for less than
  // that so we stay well clear of them actually expiring mid-play
  const resolvedUrlCache = new Map(); // videoId -> { url, expiresAt }
  const RESOLVED_URL_TTL_MS = 3 * 60 * 60 * 1000;
  const inFlightResolves = new Map(); // videoId -> Promise<string>, shared between prefetch and actual playback

  // the yt-dlp resolve is what actually makes clicking a new track feel
  // slow (youtube-side extraction time, not something more client/flag
  // tweaking gets around) — everything else here just avoids paying that
  // cost twice: once via the resolved-url cache above, and once via
  // /api/prefetch getting called ahead of time for whatevers up next in queue
  function resolveDirectUrl(videoId) {
    const cached = resolvedUrlCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) {
      helperLog(`resolveDirectUrl(${videoId}): cache hit, instant`);
      return Promise.resolve(cached.url);
    }
    if (inFlightResolves.has(videoId)) {
      helperLog(`resolveDirectUrl(${videoId}): joining in-flight resolve`);
      return inFlightResolves.get(videoId);
    }

    const startedAt = Date.now();
    helperLog(`resolveDirectUrl(${videoId}): starting cold yt-dlp resolve`);
    const promise = (async () => {
      const raw = await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificate: true,
        skipDownload: true,
        format: 'bestaudio/best',
        // the android client skips past most of the web client's js
        // player + signature-decryption round trips, way faster
        extractorArgs: 'youtube:player_client=android'
      });
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!info.url) throw new Error('no direct stream url resolved');
      resolvedUrlCache.set(videoId, { url: info.url, expiresAt: Date.now() + RESOLVED_URL_TTL_MS });
      helperLog(`resolveDirectUrl(${videoId}): resolved in ${Date.now() - startedAt}ms`);
      return info.url;
    })()
      .catch((err) => {
        helperLog(`resolveDirectUrl(${videoId}): FAILED after ${Date.now() - startedAt}ms - ${err.message}`);
        throw err;
      })
      .finally(() => inFlightResolves.delete(videoId));

    inFlightResolves.set(videoId, promise);
    return promise;
  }

  // fire-and-forget: warms resolvedUrlCache for a track ahead of the user
  // actually clicking it (called by the frontend for whatevers next in
  // queue while the current track is still playing) so that by the time
  // they get there, /api/stream hits the cache instead of resolving cold
  helperApp.get('/api/prefetch', async (req, res) => {
    const videoId = String(req.query.videoId || '').trim();
    if (!videoId) return res.status(400).json({ error: 'Missing videoId query parameter' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
    helperLog(`/api/prefetch(${videoId}): request received`);
    try {
      await resolveDirectUrl(videoId);
      res.json({ ok: true });
    } catch (error) {
      helperLog(`/api/prefetch(${videoId}): failed - ${error.message}`);
      // not fatal — /api/stream will just resolve cold when it actually plays
      res.json({ ok: false, error: error.message });
    }
  });

  // stream
  helperApp.get('/api/stream', async (req, res) => {
    const videoId = String(req.query.videoId || '').trim();
    if (!videoId) return res.status(400).json({ error: 'Missing videoId query parameter' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
    const reqStartedAt = Date.now();
    helperLog(`/api/stream(${videoId}): request received`);

    const tempDir = path.join(APP_DATA_DIR, 'temp_audio');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const audioFile = path.join(tempDir, `${videoId}.m4a`);

    // already cached from a previous play (or a finished background
    // download below) — serve straight off disk. this is also what makes
    // offline playback of anything youve listened to before work
    if (fs.existsSync(audioFile)) {
      helperLog(`/api/stream(${videoId}): serving from disk cache, ${Date.now() - reqStartedAt}ms`);
      try {
        return serveLocalFile(req, res, audioFile, 'audio/m4a');
      } catch (error) {
        return res.status(500).json({ error: error.message || 'Stream failed' });
      }
    }

    // not cached to disk yet. resolving a direct cdn url (no download) and
    // proxying it live gets audio flowing without waiting for yt-dlp to
    // download+transcode the whole track first. proxied (not redirected) so
    // playback stays same-origin — the web audio analyser powering the eq
    // and visualizer taints/goes silent on cross-origin media elements, learned
    // that one the hard way
    //
    // the background cache-warm is deliberately delayed a few seconds: it
    // spawns its own yt-dlp + ffmpeg transcode, and starting it at the same
    // instant as the resolve below just makes them fight over cpu/network
    // right when the resolve latency is what the user's staring at
    setTimeout(() => {
      downloadToCache(videoId, audioFile).catch(() => {
        // background cache-warm failed; the fallback path below will retry
        // it inline if the fast path also fails too, otherwise just skip
        // caching this once instead of breaking playback over it
      });
    }, 4000);

    try {
      const directUrl = await resolveDirectUrl(videoId);

      let upstream;
      try {
        upstream = await axios.get(directUrl, {
          headers: req.headers.range ? { range: req.headers.range } : {},
          responseType: 'stream',
          timeout: 15000,
          validateStatus: (status) => status >= 200 && status < 300
        });
      } catch (upstreamError) {
        // cached url stopped working (expired early / revoked) — drop it
        // and let the outer catch fall through to a full re-resolve
        resolvedUrlCache.delete(videoId);
        throw upstreamError;
      }

      helperLog(`/api/stream(${videoId}): upstream connected, ${Date.now() - reqStartedAt}ms total before first byte`);
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers['content-type'] || 'audio/webm',
        ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}),
        ...(upstream.headers['content-range'] ? { 'Content-Range': upstream.headers['content-range'] } : {}),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      });
      upstream.data.pipe(res);
      upstream.data.on('error', () => res.end());
    } catch (fastPathError) {
      helperLog(`/api/stream(${videoId}): fast path FAILED at ${Date.now() - reqStartedAt}ms - ${fastPathError.message}, falling back to full download`);
      // fast path failed (throttled/blocked/expired url) — fall back to the
      // original download-then-serve approach so playback still works
      try {
        await downloadToCache(videoId, audioFile);
        helperLog(`/api/stream(${videoId}): fallback download done, ${Date.now() - reqStartedAt}ms total`);
        serveLocalFile(req, res, audioFile, 'audio/m4a');
      } catch (fallbackError) {
        res.status(500).json({ error: fallbackError.message || 'Stream failed' });
      }
    }
  });

  // download
  helperApp.get('/api/download', async (req, res) => {
    const videoId = String(req.query.videoId || '').trim();
    const title = String(req.query.title || 'audio').trim();
    const format = String(req.query.format || 'mp3').toLowerCase();
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

    const validFormats = ['mp3', 'wav', 'ogg', 'flac', 'm4a'];
    const chosenFormat = validFormats.includes(format) ? format : 'mp3';
    const safeName = title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, '_').slice(0, 200);
    const downloadsDir = path.join(APP_DATA_DIR, 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    const audioPath = path.join(downloadsDir, `${safeName}.${chosenFormat}`);

    try {
      await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        // without an explicit format, yt-dlp defaults to the best *overall*
        // stream (often a combined video+audio one) and strips the video
        // afterward — that combined stream's audio bitrate is typically
        // lower than youtube's dedicated audio-only stream. asking for
        // bestaudio directly means the encode below starts from the
        // highest-bitrate source actually available
        format: 'bestaudio/best',
        extractAudio: true, audioFormat: chosenFormat, audioQuality: '0',
        output: audioPath, embedThumbnail: true, noWarnings: true, noCheckCertificate: true, quiet: true
      });
      const stats = fs.statSync(audioPath);
      if (stats.size < 10000) throw new Error(`File too small (${stats.size} bytes)`);

      res.setHeader('Content-Type', chosenFormat === 'wav' ? 'audio/wav' : chosenFormat === 'ogg' ? 'audio/ogg' : chosenFormat === 'flac' ? 'audio/flac' : 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${chosenFormat}"`);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(audioPath).pipe(res);
    } catch (error) {
      res.status(500).json({ error: error.message || 'Download failed' });
    }
  });

  helperApp.listen(LOCAL_HELPER_PORT, () => {
    console.log(`[LOCAL HELPER] yt-dlp helper running on http://localhost:${LOCAL_HELPER_PORT}`);
    console.log(`[LOCAL HELPER] Endpoints: /api/search, /api/info, /api/stream, /api/prefetch, /api/download, /api/playlist`);
  });
} else {
  // === full server mode (vps) ===

// resolve a project-root file path
function projectPath(...segments) {
  const relPath = path.join(__dirname, ...segments);
  if (fs.existsSync(relPath)) return relPath;
  // fallback for dev layout (server/index.js)
  return path.join(__dirname, '..', ...segments);
}

// logs live in the writable app-data dir, not "wherever this process
// happened to be launched from" — process.cwd() isnt meaningful once
// this runs as a bundled sidecar

// logging setup
const logFile = path.join(logsDir, `server-${new Date().toISOString().split('T')[0]}.log`);
const errorLogFile = path.join(logsDir, `errors-${new Date().toISOString().split('T')[0]}.log`);

function logToFile(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  try {
    fs.appendFileSync(logFile, logMessage);
    if (isError) {
      fs.appendFileSync(errorLogFile, logMessage);
    }
    console.log(message);
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

// log server startup
logToFile('=== SERVER STARTUP ===');
logToFile(`Node version: ${process.version}`);
logToFile(`Platform: ${process.platform}`);
logToFile(`Working directory: ${process.cwd()}`);
logToFile(`Logs directory: ${logsDir}`);

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === '1' || IS_PRODUCTION;
const SESSION_COOKIE_SECURE = String(process.env.SESSION_COOKIE_SECURE || '').toLowerCase() === '1' || IS_PRODUCTION;
const APP_ORIGIN = String(process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
const PUBLIC_WS_URL = String(process.env.PUBLIC_WS_URL || '').trim().replace(/\/+$/, '');
// gotta be NOT '/ws' — that collides with webpack-dev-server's own hmr
// socket, which defaults to '/ws' too and steals the upgrade before it
// reaches this server when running behind the CRA dev proxy (npm run dev
// / react-start). took me a min to figure out why messages werent arriving
const WS_PATH = process.env.WS_PATH || '/smp-ws';

let activeWsPort = Number(PORT) || 0;
let globalWss = null; // global ws server for broadcasting
const wsClients = new Map();
const userSocketCounts = new Map();

function getRequestProtocol(req) {
  const forwardedProto = req?.headers?.['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto.length > 0) {
    return forwardedProto.split(',')[0].trim();
  }

  if (typeof req?.protocol === 'string' && req.protocol.length > 0) {
    return req.protocol;
  }

  return SESSION_COOKIE_SECURE ? 'https' : 'http';
}

function getRequestHost(req) {
  const forwardedHost = req?.headers?.['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && forwardedHost.length > 0) {
    return forwardedHost.split(',')[0].trim();
  }

  return req?.headers?.host || `localhost:${PORT}`;
}

function getPublicAppUrl(req = null) {
  if (APP_ORIGIN) return APP_ORIGIN;
  return `${getRequestProtocol(req)}://${getRequestHost(req)}`;
}

function getPublicWsUrl(req = null) {
  if (PUBLIC_WS_URL) return PUBLIC_WS_URL;
  return `${getPublicAppUrl(req).replace(/^http/i, 'ws')}${WS_PATH}`;
}

function incrementUserSocketCount(userId) {
  const nextCount = (userSocketCounts.get(userId) || 0) + 1;
  userSocketCounts.set(userId, nextCount);
  return nextCount;
}

function decrementUserSocketCount(userId) {
  const currentCount = userSocketCounts.get(userId) || 0;
  const nextCount = Math.max(0, currentCount - 1);

  if (nextCount === 0) {
    userSocketCounts.delete(userId);
  } else {
    userSocketCounts.set(userId, nextCount);
  }

  return nextCount;
}

// pull in the db module
// auth token store, for cross-origin requests
global.authTokens = global.authTokens || new Map();

const db = require('./database');

function buildServerPayload(serverRecord, req = null) {
  if (!serverRecord) return null;
  return {
    ...serverRecord,
    wsUrl: getPublicWsUrl(req),
    wsPath: WS_PATH,
    members: db.getServerMembers(serverRecord.id)
  };
}

function buildServerListPayload(servers, req = null) {
  return servers.map(serverRecord => buildServerPayload(serverRecord, req));
}

function sendWs(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sanitizeListeningState(listening) {
  if (!listening || typeof listening !== 'object') {
    return null;
  }

  const title = String(listening.title || '').trim();
  const author = String(listening.author || '').trim();
  const source = String(listening.source || 'personal').trim().toLowerCase() || 'personal';
  const serverId = typeof listening.server_id === 'string'
    ? listening.server_id.trim()
    : (typeof listening.serverId === 'string' ? listening.serverId.trim() : '');

  if (!title) {
    return null;
  }

  return {
    title,
    author,
    source,
    server_id: serverId || null,
    is_playing: listening.is_playing !== false
  };
}

function getConnectedUsers() {
  const connectedUsers = new Map();

  wsClients.forEach((client) => {
    if (!client.userId || !client.username) return;

    const existing = connectedUsers.get(client.userId);
    const listeningState = client.listeningState || existing?.listening_to || null;
    const currentServerId = client.serverId || existing?.current_server_id || null;

    connectedUsers.set(client.userId, {
      id: client.userId,
      username: client.username,
      current_server_id: currentServerId,
      listening_to: listeningState
    });
  });

  return Array.from(connectedUsers.values());
}

function broadcastWs(payload, filter = null, excludeClientId = null) {
  wsClients.forEach((client, clientId) => {
    if (excludeClientId && clientId === excludeClientId) return;
    if (filter && !filter(client)) return;
    sendWs(client.ws, payload);
  });
}

function broadcastPresence(excludeClientId = null) {
  const users = getConnectedUsers();
  broadcastWs({ type: 'presence_update', users }, null, excludeClientId);
}

function broadcastToServer(serverId, payload, excludeClientId = null) {
  broadcastWs(payload, client => client.serverId === serverId, excludeClientId);
}

function broadcastServerQueue(serverId) {
  broadcastToServer(serverId, {
    type: 'server_queue_updated',
    serverId,
    queue: db.getServerQueue(serverId)
  });
}

function broadcastServerPlayerState(serverId) {
  broadcastToServer(serverId, {
    type: 'server_player_updated',
    serverId,
    state: db.getServerPlayerState(serverId),
    server_now_ms: Date.now()
  });
}

function broadcastServerMembers(serverId) {
  broadcastToServer(serverId, {
    type: 'server_members_updated',
    serverId,
    members: db.getServerMembers(serverId)
  });
}

function setClientServerForUser(userId, serverId = null) {
  wsClients.forEach((client) => {
    if (client.userId === userId) {
      client.serverId = serverId || null;
    }
  });
}

function clearClientServer(serverId) {
  wsClients.forEach((client) => {
    if (client.serverId === serverId) {
      client.serverId = null;
    }
  });
}

function sendServerState(ws, serverId, req = null) {
  const serverRecord = db.getActiveServerById(serverId);

  sendWs(ws, {
    type: 'initial_state',
    serverId,
    server: buildServerPayload(serverRecord, req),
    messages: db.getServerMessages(serverId),
    queue: db.getServerQueue(serverId),
    player: db.getServerPlayerState(serverId),
    server_now_ms: Date.now(),
    members: db.getServerMembers(serverId),
    users: getConnectedUsers()
  });
}

function isServerMember(serverId, userId) {
  return db.isServerMember(serverId, userId);
}

function createWebSocketServer(server, sessionMiddleware) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const urlParts = request.url ? request.url.split('?') : ['', ''];
    const pathname = urlParts[0];
    const query = urlParts[1] ? new URLSearchParams(urlParts[1]) : new URLSearchParams();

    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    // cross-origin: check authTokens or session store for sid
    const sidFromQuery = query.get('sid');
    if (sidFromQuery) {
      // try authTokens first (fast for cross-origin token auth)
      if (global.authTokens && global.authTokens.has(sidFromQuery)) {
        const userId = global.authTokens.get(sidFromQuery);
        const user = db.getUserById(userId);
        if (user) {
          request.session = { userId: user.id, username: user.username, isAdmin: user.is_admin };
          request.sessionID = sidFromQuery;
          logToFile(`[WS] auth via token: ${user.username}`);
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
          return;
        }
      }

      // fallback to session store (standard cookies)
      if (sessionStore) {
        sessionStore.get(sidFromQuery, (err, session) => {
          if (!err && session && session.userId) {
            request.session = session;
            request.sessionID = sidFromQuery;
            logToFile(`[WS] auth via session store: ${session.username}`);
            wss.handleUpgrade(request, socket, head, (ws) => {
              wss.emit('connection', ws, request);
            });
          } else {
            logToFile(`[WS] auth failed for sid: ${sidFromQuery}`, true);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
          }
        });
        return;
      }
    }

    sessionMiddleware(request, {}, () => {
      if (!request.session || !request.session.userId) {
        logToFile(`[WS] auth failed for request at ${request.url}`, true);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
  });

  activeWsPort = Number(PORT) || 0;
  logToFile(`[WS] WebSocket server listening on ${getPublicWsUrl()}`);

  return wss;
}

if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// cors and body parsers (run these early)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// request logging
app.use((req, res, next) => {
  const q = Object.keys(req.query).length ? ` query=${JSON.stringify(req.query)}` : '';
  const b = req.body && Object.keys(req.body).length ? ` body=${JSON.stringify(req.body)}` : '';
  logToFile(`[HTTP] ${req.method} ${req.path}${q}${b}`);

  res.on('finish', () => {
    const contentType = res.get('Content-Type') || 'not set';
    if (res.statusCode >= 400) {
      logToFile(`[HTTP RESPONSE] ${req.method} ${req.path} - Status: ${res.statusCode}, Content-Type: ${contentType}`, true);
    } else {
      logToFile(`[HTTP RESPONSE] ${req.method} ${req.path} - Status: ${res.statusCode}`);
    }
  });
  
  next();
});

// session and token auth middleware
const sessionStore = new session.MemoryStore();
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'shibenchi-music-player-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  proxy: TRUST_PROXY,
  cookie: {
    secure: SESSION_COOKIE_SECURE,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});
app.use(sessionMiddleware);

// token-based auth for cross-origin requests
app.use((req, res, next) => {
  // skip if already authed via cookie
  if (req.session && req.session.userId) return next();

  const token = req.headers['x-auth-token'] || req.query['token'] || req.query['sid'];
  
  if (token && global.authTokens) {
    const userId = global.authTokens.get(token);
    if (userId) {
      const user = db.getUserById(userId);
      if (user) {
        // populate session for this request
        if (!req.session) req.session = {};
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.isAdmin = user.is_admin;
        req.sessionID = token;

        // dummy touch function for compatibility
        if (typeof req.session.touch !== 'function') {
          req.session.touch = () => {};
        }
      } else {
        logToFile(`[AUTH] token valid but user ${userId} not found`, true);
      }
    } else if (token.startsWith('tok_')) {
      logToFile(`[AUTH] invalid or expired token: ${token}`, true);
    }
  }
  next();
});

// auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

// admin middleware — checks if the user is an admin
const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // check if user is admin in db
  const user = db.getUserById(req.session.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// invidious instances for fast yt search (no scraping, instant results),
// ordered by response speed, fastest first
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.io.lol',
  'https://yt.artemislena.eu',
  'https://invidious.flokinet.to',
  'https://vid.puffyan.us',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://inv.tux.pizza',
  'https://invidious.projectsegfau.lt',
  'https://iv.dali.zone'
];

let currentInvidiousIndex = 0;
let instanceFailureCounts = new Map();

// simple in-memory cache for search results (10 min ttl)
const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const item = searchCache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL) {
    return item.data;
  }
  searchCache.delete(key);
  return null;
}

function setCached(key, data) {
  searchCache.set(key, { data, timestamp: Date.now() });
  // limit cache size
  if (searchCache.size > 200) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
}

async function searchWithGoogleApi(query, limit = 10) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('No YouTube API key configured');

  const url = 'https://www.googleapis.com/youtube/v3/search';
  const res = await axios.get(url, {
    params: {
      key: apiKey,
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: limit
    },
    timeout: 1000
  });

  return (res.data.items || []).map((item) => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title,
    author: item.snippet?.channelTitle,
    thumbnail: item.snippet?.thumbnails?.default?.url || ''
  }));
}

async function searchWithInvidious(query, limit = 10) {
  const timeout = 800;

  const promises = [];
  for (let i = 0; i < 5; i++) {
    const instance = INVIDIOUS_INSTANCES[(currentInvidiousIndex + i) % INVIDIOUS_INSTANCES.length];

    const failureCount = instanceFailureCounts.get(instance) || 0;
    if (failureCount > 5) continue;

    promises.push(
      axios.get(`${instance}/api/v1/search`, {
        params: { q: query, type: 'video' },
        timeout
      }).then(res => {
        currentInvidiousIndex = (currentInvidiousIndex + i) % INVIDIOUS_INSTANCES.length;
        instanceFailureCounts.set(instance, 0);
        return res.data;
      }).catch(err => {
        instanceFailureCounts.set(instance, (instanceFailureCounts.get(instance) || 0) + 1);
        throw err;
      })
    );
  }

  if (promises.length === 0) {
    throw new Error('No available Invidious instances');
  }

  return Promise.any(promises);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

// auth routes

// register new user
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    // check if username taken
    const existingUser = db.statements.getUserByUsername.get(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // create user
    const user = db.createUser(username, password);

    // create session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    // create db session record
    db.createUserSession(user.id, req.sessionID);
    db.setOnlineStatus(user.id);

    logToFile(`[AUTH] User registered: ${username}`);
    const authToken = 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 32);
    global.authTokens.set(authToken, user.id);
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, is_admin: user.is_admin },
      authToken
    });
  } catch (error) {
    logToFile(`[AUTH] Registration error: ${error.message}`, true);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = db.authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // sign out any existing session (one session per user)
    db.deleteUserSessionsByUserId(user.id);

    // create new session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    // create db session record
    db.createUserSession(user.id, req.sessionID);

    // set user as online
    db.setOnlineStatus(user.id);

    logToFile(`[AUTH] User logged in: ${username} (previous sessions terminated)`);
    const authToken = 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 32);
    global.authTokens.set(authToken, user.id);
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, is_admin: user.is_admin },
      authToken
    });
  } catch (error) {
    logToFile(`[AUTH] Login error: ${error.message}`, true);
    res.status(500).json({ error: 'Login failed' });
  }
});

// logout
app.post('/api/auth/logout', (req, res) => {
  const username = req.session.username;
  const userId = req.session.userId;

  // set user as offline
  if (userId) {
    db.setOfflineStatus(userId);
  }

  // remove db session record
  if (req.sessionID) {
    db.deleteUserSession(req.sessionID);
  }

  req.session.destroy((err) => {
    if (err) {
      logToFile(`[AUTH] Logout error: ${err.message}`, true);
      return res.status(500).json({ error: 'Logout failed' });
    }
    logToFile(`[AUTH] User logged out: ${username}`);
    res.json({ ok: true });
  });
});

// get current user session
app.get('/api/auth/session', (req, res) => {
  if (req.session && req.session.userId) {
    // get user info including admin status
    const user = db.getUserById(req.session.userId);
    res.json({
      ok: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        is_admin: user?.is_admin || false
      }
    });
  } else {
    res.json({ ok: true, user: null });
  }
});

// get session ID for WebSocket connections (cross-origin support)
app.get('/api/auth/session-id', (req, res) => {
  res.json({ ok: true, sessionId: req.sessionID || null });
});

// user data routes

// get user settings
app.get('/api/user/settings', requireAuth, (req, res) => {
  try {
    const settings = db.getSettings(req.session.userId);
    res.json({ 
      ok: true, 
      settings: {
        theme_color_r: settings.theme_color_r,
        theme_color_g: settings.theme_color_g,
        theme_color_b: settings.theme_color_b,
        debug_mode: settings.debug_mode === 1
      } 
    });
  } catch (error) {
    logToFile(`[SETTINGS] Get error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// save user settings
app.post('/api/user/settings', requireAuth, (req, res) => {
  try {
    const { theme_color_r, theme_color_g, theme_color_b, debug_mode } = req.body;
    db.saveSettings(req.session.userId, {
      theme_color_r,
      theme_color_g,
      theme_color_b,
      debug_mode
    });
    logToFile(`[SETTINGS] Saved for user: ${req.session.username}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SETTINGS] Save error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// get user playlists
app.get('/api/user/playlists', requireAuth, (req, res) => {
  try {
    const playlists = db.getUserPlaylists(req.session.userId);
    res.json({ ok: true, playlists });
  } catch (error) {
    logToFile(`[PLAYLISTS] Get error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get playlists' });
  }
});

// create playlist
app.post('/api/user/playlists', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Playlist name required' });
    }
    const playlist = db.createPlaylist(req.session.userId, name);
    logToFile(`[PLAYLISTS] Created "${name}" for user: ${req.session.username}`);
    res.json({ ok: true, playlist });
  } catch (error) {
    logToFile(`[PLAYLISTS] Create error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// update playlist
app.put('/api/user/playlists/:id', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    const { id } = req.params;
    if (!name) {
      return res.status(400).json({ error: 'Playlist name required' });
    }
    db.updatePlaylist(id, req.session.userId, name);
    logToFile(`[PLAYLISTS] Updated "${name}" for user: ${req.session.username}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[PLAYLISTS] Update error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

// delete playlist
app.delete('/api/user/playlists/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.deletePlaylist(id, req.session.userId);
    logToFile(`[PLAYLISTS] Deleted "${id}" for user: ${req.session.username}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[PLAYLISTS] Delete error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// add track to playlist
app.post('/api/user/playlists/:id/tracks', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const track = req.body;

    // verify playlist belongs to user
    const playlist = db.getPlaylistById(id, req.session.userId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    
    const newTrack = db.addTrackToPlaylist(id, track);
    res.json({ ok: true, track: newTrack });
  } catch (error) {
    logToFile(`[PLAYLISTS] Add track error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to add track' });
  }
});

// remove track from playlist
app.delete('/api/user/playlists/:playlistId/tracks/:trackId', requireAuth, (req, res) => {
  try {
    const { playlistId, trackId } = req.params;
    db.removeTrackFromPlaylist(trackId, playlistId);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[PLAYLISTS] Remove track error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to remove track' });
  }
});

// clear playlist
app.delete('/api/user/playlists/:id/tracks', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.clearPlaylist(id);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[PLAYLISTS] Clear error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to clear playlist' });
  }
});

// sync all playlists (bulk save from client)
app.put('/api/user/playlists-sync', requireAuth, (req, res) => {
  try {
    const { playlists } = req.body;
    if (!Array.isArray(playlists)) {
      return res.status(400).json({ error: 'Playlists must be an array' });
    }

    const syncedPlaylists = db.replaceUserPlaylists(req.session.userId, playlists);

    logToFile(`[PLAYLISTS] Synced ${playlists.length} playlists for user: ${req.session.username}`);
    res.json({ ok: true, playlists: syncedPlaylists });
  } catch (error) {
    logToFile(`[PLAYLISTS] Sync error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to sync playlists' });
  }
});

// === COLLAB PLAYLISTS API ===

// get all collab playlists for a server
app.get('/api/servers/:serverId/collab-playlists', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to view collab playlists' });
    }

    const playlists = db.getCollabPlaylists(serverId);
    // get tracks for each playlist
    const playlistsWithTracks = playlists.map((pl) => {
      const tracks = db.getCollabPlaylistTracks(pl.id);
      return { ...pl, tracks };
    });

    res.json({ ok: true, playlists: playlistsWithTracks });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Get error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get collab playlists' });
  }
});

// create a collab playlist
app.post('/api/servers/:serverId/collab-playlists', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const { id, name, createdBy } = req.body;

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to create collab playlists' });
    }

    const playlist = db.createCollabPlaylist(id, serverId, name, createdBy || req.session.userId);
    logToFile(`[COLLAB PLAYLISTS] Created "${name}" in server ${serverId} by ${req.session.username}`);
    res.json({ ok: true, playlist });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Create error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to create collab playlist' });
  }
});

// rename a collab playlist
app.put('/api/servers/:serverId/collab-playlists/:playlistId', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId } = req.params;
    const { name } = req.body;

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to rename collab playlists' });
    }

    db.updateCollabPlaylistName(playlistId, serverId, name);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Rename error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to rename collab playlist' });
  }
});

// delete a collab playlist
app.delete('/api/servers/:serverId/collab-playlists/:playlistId', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId } = req.params;

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to delete collab playlists' });
    }

    db.deleteCollabPlaylist(playlistId, serverId);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Delete error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to delete collab playlist' });
  }
});

// add track to collab playlist
app.post('/api/servers/:serverId/collab-playlists/:playlistId/tracks', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId } = req.params;
    const track = req.body;

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to add tracks' });
    }

    const playlist = db.getCollabPlaylist(playlistId, serverId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const trackId = `cpt_${crypto.randomUUID()}`;
    const newTrack = db.addTrackToCollabPlaylist(
      trackId, playlistId, track.video_id || track.videoId, track.title, track.author,
      track.format || 'mp3', track.source || 'youtube', track.thumbnail, track.external_url,
      track.duration_ms || 0, req.session.userId
    );

    res.json({ ok: true, track: newTrack });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Add track error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to add track to collab playlist' });
  }
});

// remove track from collab playlist
app.delete('/api/servers/:serverId/collab-playlists/:playlistId/tracks/:trackId', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId, trackId } = req.params;

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to remove tracks' });
    }

    db.removeTrackFromCollabPlaylist(trackId, playlistId);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Remove track error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to remove track from collab playlist' });
  }
});

// clear collab playlist
app.delete('/api/servers/:serverId/collab-playlists/:playlistId/tracks', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId } = req.params;

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to clear playlist' });
    }

    db.clearCollabPlaylist(playlistId);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Clear error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to clear collab playlist' });
  }
});

// get downloaded tracks
app.get('/api/user/downloads', requireAuth, (req, res) => {
  try {
    const tracks = db.getDownloadedTracks(req.session.userId);
    res.json({ ok: true, tracks });
  } catch (error) {
    logToFile(`[DOWNLOADS] Get error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get downloads' });
  }
});

// add downloaded track
app.post('/api/user/downloads', requireAuth, (req, res) => {
  try {
    const track = req.body;
    db.addDownloadedTrack(req.session.userId, track);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[DOWNLOADS] Add error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to save download' });
  }
});

// get user queue
app.get('/api/user/queue', requireAuth, (req, res) => {
  try {
    const queue = db.getUserQueue(req.session.userId);
    res.json({ ok: true, queue });
  } catch (error) {
    logToFile(`[QUEUE] Get error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get queue' });
  }
});

// add track to user queue
app.post('/api/user/queue', requireAuth, (req, res) => {
  try {
    const track = req.body;
    const newTrack = db.addToUserQueue(req.session.userId, track);
    logToFile(`[QUEUE] Track added for user ${req.session.username}: ${track.title}`);
    res.json({ ok: true, track: newTrack });
  } catch (error) {
    logToFile(`[QUEUE] Add error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

// update user queue (replace entire queue)
app.put('/api/user/queue', requireAuth, (req, res) => {
  try {
    const { queue } = req.body;
    if (!Array.isArray(queue)) {
      return res.status(400).json({ error: 'Queue must be an array' });
    }

    // clear existing queue
    db.clearUserQueue(req.session.userId);

    // add all tracks from new queue
    queue.forEach((track, index) => {
      db.addToUserQueue(req.session.userId, track, index);
    });

    logToFile(`[QUEUE] Queue updated for user ${req.session.username}: ${queue.length} tracks`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[QUEUE] Update error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to update queue' });
  }
});

// remove track from user queue
app.delete('/api/user/queue/:trackId', requireAuth, (req, res) => {
  try {
    const { trackId } = req.params;
    db.removeFromUserQueue(trackId, req.session.userId);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[QUEUE] Remove error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to remove track from queue' });
  }
});

// clear user queue
app.delete('/api/user/queue', requireAuth, (req, res) => {
  try {
    db.clearUserQueue(req.session.userId);
    logToFile(`[QUEUE] Queue cleared for user ${req.session.username}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[QUEUE] Clear error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to clear queue' });
  }
});

// client can send log entries for visibility
app.post('/api/log', (req, res) => {
  const payload = req.body || {};
  const message = payload.message || 'No message';
  const meta = payload.meta ? ` ${JSON.stringify(payload.meta)}` : '';
  logToFile(`[CLIENT] ${message}${meta}`);
  res.json({ ok: true });
});

app.get('/api/info', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();

  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId query parameter' });
  }
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const raw = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      skipDownload: true
    });

    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const title = info.title || '';
    const author = info.uploader || info.channel || '';
    res.json({ videoId, title, author });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch video info' });
  }
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  // check cache first
  const cached = getCached(query);
  if (cached) {
    return res.json({ query, results: cached });
  }

  // set hard timeout for search (3 sec max)
  const searchTimeout = 3000;

  let results = [];

  // prefer youtube data api if key configured (fastest & most reliable)
  if (process.env.YOUTUBE_API_KEY) {
    try {
      results = await searchWithGoogleApi(query, 10);
      logToFile(`Google API returned ${results.length} results for query=${query}`);
    } catch (error) {
      const msg = `Google API search failed for query=${query}: ${error.message}`;
      logToFile(msg, 'error');
    }
  }

  // if still no results, fall back to invidious (fast, no api key)
  if (results.length === 0) {
    try {
      const searchResult = await Promise.race([
        searchWithInvidious(query, 10),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Search timeout')), searchTimeout)
        )
      ]);

      const rawItems = Array.isArray(searchResult) ? searchResult : [];
      results = rawItems
        .map((item) => {
          const videoId = item.videoId || item.id;
          return {
            videoId,
            title: item.title || item.name || '',
            author: item.author || item.channel || item.author?.name || '',
            thumbnail:
              item.videoThumbnails?.[0]?.url ||
              item.thumbnail ||
              item.bestThumbnail?.url ||
              ''
          };
        })
        .filter((item) => item.videoId && item.title)
        .slice(0, 10);

      if (results.length === 0) {
        logToFile(`Invidious returned 0 results for query=${query}`);
      }
    } catch (error) {
      const msg = `Invidious search failed for query=${query}: ${error.message}`;
      logToFile(msg, 'error');
    }
  }

  // if enabled, try yt-search fallback
  if (results.length === 0 && true) {
    try {
      const ytResult = await ytSearch(query);
      results = (ytResult.videos || [])
        .map((item) => ({
          videoId: item.videoId,
          title: item.title,
          author: item.author?.name || item.author || '',
          thumbnail: item.thumbnail || item.image || ''
        }))
        .slice(0, 10);
      logToFile(`yt-search fallback returned ${results.length} videos for query=${query}`);
    } catch (ytErr) {
      logToFile(`yt-search fallback failed for query=${query}: ${ytErr.message}`, true);
    }
  }

  // fall back to yt-search if no results from invidious
  if (results.length === 0) {
    try {
      const ytResult = await ytSearch(query);
      results = (ytResult.videos || [])
        .map((item) => ({
          videoId: item.videoId,
          title: item.title,
          author: item.author?.name || item.author || '',
          thumbnail: item.thumbnail || item.image || ''
        }))
        .slice(0, 10);
      logToFile(`yt-search fallback returned ${results.length} videos for query=${query}`);
    } catch (ytErr) {
      logToFile(`yt-search fallback failed for query=${query}: ${ytErr.message}`, true);
    }
  }

  if (results.length > 0) {
    setCached(query, results);
  }

  return res.json({ query, results });
});

// fetch playlist items (yt playlist url or id)
app.get('/api/playlist', async (req, res) => {
  const playlistId = String(req.query.list || req.query.playlistId || '').trim();
  if (!playlistId) {
    return res.status(400).json({ error: 'Missing playlist ID' });
  }

  try {
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    const raw = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      skipDownload: true,
      flatPlaylist: true
    });

    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const title = info.title || `Playlist ${playlistId.slice(-6)}`;
    const entries = Array.isArray(info.entries) ? info.entries : [];
    const items = entries
      .filter((entry) => entry && entry.id)
      .map((entry) => ({
        videoId: entry.id,
        title: entry.title || entry.title_short || `Track ${entry.id}`,
        author: entry.uploader || entry.uploader_id || ''
      }));

    res.json({ playlistId, title, items });
  } catch (error) {
    const msg = `Playlist fetch failed for ${playlistId}: ${error.message}`;
    logToFile(msg, 'error');
    res.status(500).json({ error: msg });
  }
});

app.get('/api/download', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();
  const title = String(req.query.title || 'music').trim();
  const format = String(req.query.format || 'mp3').trim().toLowerCase();

  logToFile(`[DOWNLOAD] Request received: videoId=${videoId}, title=${title}, format=${format}`);
  console.log('[DOWNLOAD] Request received:', { videoId, title, format });

  if (!videoId) {
    logToFile('[DOWNLOAD] Error: Missing videoId');
    return res.status(400).json({ error: 'Missing videoId query parameter' });
  }
  if (!isValidVideoId(videoId)) {
    logToFile('[DOWNLOAD] Error: Invalid videoId');
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  const allowedFormats = ['mp3', 'ogg', 'flac', 'wav'];
  const chosenFormat = allowedFormats.includes(format) ? format : 'mp3';
  logToFile(`[DOWNLOAD] Using format: ${chosenFormat}`);

  const safeName = title
    .replace(/[^a-z0-9-_\. ]/gi, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200);

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // working filename is keyed by videoId, NOT the (user-supplied,
  // title-based) display name — two different tracks can sanitize down to
  // the same "safeName" (or a batch download can race), which used to mean
  // one video's yt-dlp output/thumbnail temp files could collide with
  // another's and get embedded into the wrong track lol. videoId is unique
  // per request so theres nothing to collide anymore. safeName is still
  // used for the filename the browser sees (Content-Disposition), thats
  // purely cosmetic
  const audioPath = path.join(downloadsDir, `${videoId}.${chosenFormat}`);

  function cleanupThumbnailSidecars() {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
      const sidecar = path.join(downloadsDir, `${videoId}${ext}`);
      fs.unlink(sidecar, () => {}); // best-effort, fine if it never existed
    }
  }

  try {
    logToFile('[DOWNLOAD] Downloading audio with yt-dlp...');
    console.log('[DOWNLOAD] Downloading audio with yt-dlp...');

    // yt-dlp automatically embeds the video thumbnail as metadata in the output file, nice
    await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
      extractAudio: true,
      audioFormat: chosenFormat,
      audioQuality: '0',
      output: audioPath,
      embedThumbnail: true,
      noWarnings: true,
      noCheckCertificate: true,
      quiet: true
    });

    const stats = fs.statSync(audioPath);
    if (stats.size < 10000) {
      throw new Error(`File too small (${stats.size} bytes) - download may have failed`);
    }

    logToFile(`[DOWNLOAD] File ready: ${stats.size} bytes, streaming to client`);
    console.log(`[DOWNLOAD] File ready: ${stats.size} bytes`);
    cleanupThumbnailSidecars();

    // stream the file to the client
    res.setHeader('Content-Type', chosenFormat === 'wav' ? 'audio/wav' : chosenFormat === 'ogg' ? 'audio/ogg' : chosenFormat === 'flac' ? 'audio/flac' : 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${chosenFormat}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Accept-Ranges', 'bytes');
    const fileStream = fs.createReadStream(audioPath);
    fileStream.pipe(res);
    fileStream.on('error', (err) => {
      logToFile(`[DOWNLOAD] Stream error: ${err.message}`, 'error');
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });

  } catch (error) {
    // fallback: try with browser cookies, sometimes youtube gets weird w/o em
    logToFile(`[DOWNLOAD] Primary download failed: ${error.message}, trying with Chrome cookies...`);
    console.log('[DOWNLOAD] Trying with Chrome cookies...');

    try {
      await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        format: 'bestaudio/best',
        extractAudio: true,
        audioFormat: chosenFormat,
        audioQuality: '0',
        output: audioPath,
        embedThumbnail: true,
        cookiesFromBrowser: 'chrome',
        noWarnings: true,
        noCheckCertificate: true,
        quiet: true
      });

      const stats = fs.statSync(audioPath);
      if (stats.size < 10000) {
        throw new Error(`File too small (${stats.size} bytes)`);
      }

      logToFile(`[DOWNLOAD] File ready (chrome cookies): ${stats.size} bytes`);
      console.log(`[DOWNLOAD] File ready (chrome cookies): ${stats.size} bytes`);
      cleanupThumbnailSidecars();

      res.setHeader('Content-Type', chosenFormat === 'wav' ? 'audio/wav' : chosenFormat === 'ogg' ? 'audio/ogg' : chosenFormat === 'flac' ? 'audio/flac' : 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${chosenFormat}"`);
      res.setHeader('Content-Length', stats.size);
      const fileStream = fs.createReadStream(audioPath);
      fileStream.pipe(res);
    } catch (finalError) {
      logToFile(`[DOWNLOAD] All methods failed: ${finalError.message}`, 'error');
      console.error('[DOWNLOAD] All methods failed:', finalError);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed', message: finalError.message });
      }
    }
  }
});

// note: dont cache stream urls, they expire quick and caching em causes
// 302/403 errors once the url dies

/**
 * grabs a fresh audio streaming url from youtube for the given videoId.
 * returns the url string, or null if it fails
 */
async function getFreshAudioUrl(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificate: true,
      skipDownload: true,
      format: 'bestaudio[ext=m4a]/bestaudio'
    });
    const videoInfo = typeof info === 'string' ? JSON.parse(info) : info;
    if (videoInfo.formats) {
      const m4aFormat = videoInfo.formats.find(f =>
        f.acodec !== 'none' && f.vcodec === 'none' && f.ext === 'm4a'
      );
      if (m4aFormat?.url) return m4aFormat.url;
      const audioFormat = videoInfo.formats.find(f =>
        f.acodec !== 'none' && f.vcodec === 'none'
      );
      if (audioFormat?.url) return audioFormat.url;
    }
    if (videoInfo.url) return videoInfo.url;
    return null;
  } catch {
    return null;
  }
}

// handle preflight options for stream endpoint
app.options('/api/stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.sendStatus(204);
});

app.get('/api/stream', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();
  if (!videoId) {
    logToFile('[Stream] Missing videoId parameter', true);
    return res.status(400).json({ error: 'Missing videoId query parameter' });
  }
  if (!isValidVideoId(videoId)) {
    logToFile('[Stream] Invalid videoId parameter', true);
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  logToFile(`[Stream] Request for videoId: ${videoId}`);

  const tempDir = path.join(__dirname, '..', 'temp_audio');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const audioFile = path.join(tempDir, `${videoId}.m4a`);

  try {
    // download audio if not already cached
    if (!fs.existsSync(audioFile)) {
      logToFile(`[Stream] Downloading audio to temp file...`);
      await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        extractAudio: true,
        audioFormat: 'm4a',
        output: audioFile,
        noWarnings: true,
        noCheckCertificate: true,
        quiet: true
      });
      logToFile(`[Stream] Audio downloaded to ${audioFile}`);
    }

    const stats = fs.statSync(audioFile);
    const fileSize = stats.size;
    const range = req.headers.range;

    logToFile(`[Stream] Serving audio, fileSize: ${fileSize}, range: ${range || 'none'}`);

    const contentType = 'audio/m4a';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      logToFile(`[Stream] Range request: bytes ${start}-${end}/${fileSize}`);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      });

      fs.createReadStream(audioFile, { start, end }).pipe(res);
    } else {
      logToFile(`[Stream] Full request: bytes 0-${fileSize - 1}/${fileSize}`);

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      });

      fs.createReadStream(audioFile).pipe(res);
    }
  } catch (error) {
    logToFile(`[Stream] Streaming error: ${error.message}`, 'error');
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Streaming failed' });
    } else {
      res.end();
    }
  }
});

// global error handler - must be before static files but after routes
app.use((err, req, res, next) => {
  logToFile(`[ERROR] Unhandled error: ${err.message}`, true);
  logToFile(`[ERROR] Stack: ${err.stack}`, true);
  logToFile(`[ERROR] Path: ${req.method} ${req.path}`, true);

  // dont send html — always json for api routes
  if (req.path.startsWith('/api/')) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } else {
    next();
  }
});

// serve react static files - note: catch-all moved to end
const resolvedBuildPath = projectPath('build');
if (fs.existsSync(resolvedBuildPath)) {
  app.use(express.static(resolvedBuildPath));
} else {
  logToFile('React build folder not found; frontend will not be served from this server. Run `npm run react-start` or `npm run dev` to start the UI.');
}

// serve package.json for version check
app.get('/package.json', (req, res) => {
  res.sendFile(projectPath('package.json'), (err) => {
    if (err) {
      res.status(404).send('Package not found');
    }
  });
});

// add version endpoint
app.get('/api/version', (req, res) => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(projectPath('package.json'), 'utf8'));
    res.json({ version: packageJson.version });
  } catch (err) {
    res.status(500).json({ error: 'Could not read version' });
  }
});

// used to decide whether to show the first-run welcome dialog — a genuinely
// fresh install has no registered users at all. NOT "have i shown this
// before" (thats a client-side localStorage flag, since a guest who never
// registers should still only see it once)
app.get('/api/first-run-status', (req, res) => {
  try {
    const { count } = db.db.prepare('SELECT COUNT(*) as count FROM users').get();
    res.json({ isFreshInstall: count === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Could not check first-run status' });
  }
});

// temp diagnostic: plain http endpoint, no tauri ipc involved at all —
// isolates "does frontend js even execute in the native window" from every
// other layer of uncertainty (invoke, __TAURI__ global, event bus, etc)
app.post('/api/debug-log', (req, res) => {
  try {
    fs.appendFileSync(
      path.join(APP_DATA_DIR, 'rust_debug.log'),
      `[${Date.now()}] [http-diag] ${JSON.stringify(req.body)}\n`
    );
  } catch {}
  res.json({ ok: true });
});

// collab port discovery endpoint
app.get('/api/collab/port', (req, res) => {
  res.json({
    wsPort: activeWsPort,
    wsPath: WS_PATH,
    url: getPublicWsUrl(req)
  });
});

// user search endpoint - search users by username
app.get('/api/users/search', (req, res) => {
  try {
    const query = req.query.q;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return res.json({ users: [] });
    }

    // grab all users from db and filter by username
    const allUsers = db.db.prepare('SELECT id, username FROM users').all();
    const matchingUsers = allUsers
      .filter(user => user.username.toLowerCase().includes(normalized))
      .map(user => ({ id: user.id, username: user.username }));

    res.json({ users: matchingUsers });
  } catch (err) {
    console.error('[API] Error searching users:', err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// friend requests & friends routes

// get all users (with online status)
app.get('/api/users', requireAuth, (req, res) => {
  console.log('[API /api/users] Request received, userId:', req.session?.userId);
  try {
    const allUsers = db.getAllUsers().filter(u => u.id !== req.session.userId);
    const presenceUsers = getConnectedUsers();
    const presenceMap = new Map(presenceUsers.map((user) => [user.id, user]));

    // get online users (may fail if the table doesnt exist)
    let onlineIds = new Set();
    let onlineStatusMap = new Map();
    try {
      const onlineUsers = db.getOnlineUsers();
      onlineIds = new Set(onlineUsers.map(u => u.id));
      onlineStatusMap = new Map(onlineUsers.map((user) => [user.id, user]));
      console.log('[API /api/users] Online users:', onlineUsers.length);
    } catch (onlineErr) {
      console.error('[API /api/users] Online status error:', onlineErr.message);
      logToFile(`[USERS] Could not get online status: ${onlineErr.message}`, true);
      // eh, just continue without online status then
    }

    // grab theme colors for all users
    const userThemeColors = {};
    allUsers.forEach(u => {
      try {
        const settings = db.getSettings(u.id);
        if (settings) {
          userThemeColors[u.id] = {
            r: settings.theme_color_r || 255,
            g: settings.theme_color_g || 89,
            b: settings.theme_color_b || 0
          };
        }
      } catch {}
    });

    // slap online status + theme color onto every user
    const usersWithStatus = allUsers.map((u) => {
      const livePresence = presenceMap.get(u.id);
      const onlineStatus = onlineStatusMap.get(u.id);
      const isOnline = Boolean(livePresence || onlineIds.has(u.id));

      return {
        ...u,
        is_online: isOnline,
        current_server_id: livePresence?.current_server_id || onlineStatus?.current_server_id || null,
        last_seen: onlineStatus?.last_seen || null,
        listening_to: livePresence?.listening_to || null,
        theme_color: userThemeColors[u.id] || { r: 255, g: 89, b: 0 }
      };
    });

    console.log('[API /api/users] Sending response with', usersWithStatus.length, 'users');
    res.json({ ok: true, users: usersWithStatus });
  } catch (error) {
    console.error('[API /api/users] Error:', error.message);
    logToFile(`[USERS] Get error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// delete user (global admin only)
app.delete('/api/users/:userId', requireAuth, (req, res) => {
  try {
    if (!req.session.isAdmin) {
      return res.status(403).json({ error: 'Admin privileges required' });
    }

    const { userId } = req.params;
    if (userId === req.session.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const targetUser = db.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // kick em from any server theyre in first
    const userServers = db.getUserServers(userId);
    userServers.forEach(s => {
      db.removeServerMember(s.server_id, userId);
      if (globalWss) {
        broadcastWs({
          type: 'server_member_left',
          serverId: s.server_id,
          userId
        });
        broadcastServerMembers(s.server_id);
      }
    });

    db.deleteUser(userId);
    logToFile(`[ADMIN] User ${req.session.username} deleted user ${targetUser.username} (${userId})`);

    if (globalWss) {
      broadcastWs({
        type: 'user_deleted',
        userId
      });
      broadcastPresence();
    }

    res.json({ ok: true });
  } catch (error) {
    logToFile(`[ADMIN] Delete user error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// send friend request
app.post('/api/friends/request', requireAuth, (req, res) => {
  try {
    const { receiverId } = req.body;
    if (!receiverId) {
      return res.status(400).json({ error: 'receiverId required' });
    }

    if (receiverId === req.session.userId) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    }

    const result = db.createFriendRequest(req.session.userId, receiverId);
    if (result.error) {
      if (result.error === 'already_friends') {
        return res.status(400).json({ error: 'Already friends with this user' });
      } else if (result.error === 'request_exists') {
        return res.status(400).json({ error: 'Friend request already sent' });
      }
      return res.status(400).json({ error: result.error });
    }

    logToFile(`[FRIENDS] Friend request sent from ${req.session.username} to ${receiverId}`);
    res.json({ ok: true, request: result });
  } catch (error) {
    logToFile(`[FRIENDS] Send request error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

// get pending friend requests
app.get('/api/friends/requests', requireAuth, (req, res) => {
  try {
    const requests = db.getPendingFriendRequests(req.session.userId);
    res.json({ ok: true, requests });
  } catch (error) {
    logToFile(`[FRIENDS] Get requests error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get friend requests' });
  }
});

// diagnose friend request
app.get('/api/friends/requests/:id/diagnose', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const requestId = String(id).trim();
    
    if (!requestId) {
      return res.status(400).json({ error: 'Missing request ID' });
    }
    
    // grab the raw request row straight from the db
    const request = db.db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);

    if (!request) {
      return res.json({ found: false, message: 'Friend request not found in database' });
    }

    // make sure sender and receiver actually exist
    const sender = db.db.prepare('SELECT id, username FROM users WHERE id = ?').get(request.sender_id);
    const receiver = db.db.prepare('SELECT id, username FROM users WHERE id = ?').get(request.receiver_id);

    // are they already friends somehow?
    const isFriendship = db.db.prepare('SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').all(request.sender_id, request.receiver_id, request.receiver_id, request.sender_id);
    
    res.json({
      found: true,
      request: {
        id: request.id,
        sender_id: request.sender_id,
        receiver_id: request.receiver_id,
        status: request.status,
        created_at: request.created_at
      },
      sender: sender ? { id: sender.id, username: sender.username } : null,
      receiver: receiver ? { id: receiver.id, username: receiver.username } : null,
      already_friends: isFriendship.length > 0,
      friend_count: isFriendship.length,
      can_accept: request.receiver_id === req.session.userId && request.status === 'pending' && sender && receiver
    });
  } catch (error) {
    logToFile(`[FRIENDS] Diagnose request error: ${error.message}`, true);
    res.status(500).json({ error: `Diagnostic failed: ${error.message}` });
  }
});

// accept friend request
app.post('/api/friends/requests/:id/accept', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const requestId = String(id).trim();
    const receiverId = req.session.userId;
    
    if (!requestId) {
      return res.status(400).json({ error: 'Missing request ID' });
    }
    
    logToFile(`[FRIENDS] Accepting friend request: id=${requestId}, receiver=${receiverId}`);
    
    const result = db.acceptFriendRequest(requestId, receiverId);
    if (result.error) {
      logToFile(`[FRIENDS] Accept request validation error: ${result.error}`);
      if (result.error === 'forbidden') {
        return res.status(403).json({ error: 'You can only accept requests sent to you' });
      }
      return res.status(404).json({ error: 'Friend request not found' });
    }

    logToFile(`[FRIENDS] Friend request accepted: ${requestId} by ${receiverId}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[FRIENDS] Accept request error (requestId=${req.params?.id || 'unknown'}, receiverId=${req.session?.userId || 'unknown'}): ${error.stack || error.message}`, true);
    res.status(500).json({ error: `Failed to accept friend request: ${error.message}` });
  }
});

// decline friend request
app.post('/api/friends/requests/:id/decline', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const result = db.declineFriendRequest(id, req.session.userId);
    if (result.error) {
      if (result.error === 'forbidden') {
        return res.status(403).json({ error: 'You can only decline requests sent to you' });
      }
      return res.status(404).json({ error: 'Friend request not found' });
    }
    logToFile(`[FRIENDS] Friend request declined: ${id}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[FRIENDS] Decline request error (requestId=${req.params?.id || 'unknown'}, receiverId=${req.session?.userId || 'unknown'}): ${error.stack || error.message}`, true);
    res.status(500).json({ error: 'Failed to decline friend request' });
  }
});

// get friends list
app.get('/api/friends', requireAuth, (req, res) => {
  try {
    const friends = db.getFriends(req.session.userId);
    res.json({ ok: true, friends });
  } catch (error) {
    logToFile(`[FRIENDS] Get friends error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// remove friend
app.delete('/api/friends/:friendId', requireAuth, (req, res) => {
  try {
    const { friendId } = req.params;
    db.removeFriend(req.session.userId, friendId);
    logToFile(`[FRIENDS] Friend removed: ${friendId}`);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[FRIENDS] Remove friend error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// direct messaging

// get conversation list
app.get('/api/messages/conversations', requireAuth, (req, res) => {
  try {
    const conversations = db.getConversations(req.session.userId);
    res.json({ ok: true, conversations });
  } catch (error) {
    logToFile(`[MESSAGES] Get conversations error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// get messages with a specific user
app.get('/api/messages/:userId', requireAuth, (req, res) => {
  try {
    const { userId } = req.params;
    const uid = req.session.userId;
    const messages = db.getDirectMessages(uid, userId, userId, uid);
    res.json({ ok: true, messages });
  } catch (error) {
    logToFile(`[MESSAGES] Get messages error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// send a message
app.post('/api/messages/:userId', requireAuth, (req, res) => {
  try {
    const { userId } = req.params;
    const { message, text, sender_theme_color } = req.body;
    const content = (message || text || '').trim();
    if (!content) {
      return res.status(400).json({ error: 'Message required' });
    }

    const targetUser = db.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const msg = db.createDirectMessage(req.session.userId, req.session.username, userId, targetUser.username, content, sender_theme_color || null);

    // ping the recipient over ws if theyre online
    if (globalWss) {
      broadcastWs({
        type: 'direct_message',
        message: msg
      }, (client) => client.userId === userId || client.userId === req.session.userId);
    }

    res.json({ ok: true, message: msg });
  } catch (error) {
    logToFile(`[MESSAGES] Send message error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// active server management routes

// get all active servers
app.get('/api/servers', requireAuth, (req, res) => {
  console.log('[API /api/servers] Request received, userId:', req.session?.userId);
  try {
    const servers = db.getAllActiveServers();
    const serversWithDetails = buildServerListPayload(servers, req);
    console.log('[API /api/servers] Sending response with', serversWithDetails.length, 'servers');
    res.json({ ok: true, servers: serversWithDetails });
  } catch (error) {
    console.error('[API /api/servers] Error:', error.message);
    logToFile(`[SERVERS] Get servers error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get servers' });
  }
});

// create new server
app.post('/api/servers', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Server name required' });
    }

    const wsPort = activeWsPort;
    const server = db.createActiveServer(name, req.session.userId, req.session.username, wsPort);
    const serverWithDetails = buildServerPayload(server, req);
    logToFile(`[SERVERS] Server created: ${name} by ${req.session.username}`);

    // let ws clients know theres a new server
    if (globalWss) {
      broadcastWs({
        type: 'server_created',
        server: serverWithDetails
      });
    }
    
    res.json({ ok: true, server: serverWithDetails });
  } catch (error) {
    logToFile(`[SERVERS] Create server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

// join server
app.post('/api/servers/:serverId/join', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const server = db.getActiveServerById(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const member = db.addServerMember(serverId, req.session.userId, req.session.username, 0);
    if (member.error) {
      return res.status(400).json({ error: 'Already a member of this server' });
    }

    // update online status with the current server
    db.updateOnlineServer(req.session.userId, serverId);
    setClientServerForUser(req.session.userId, serverId);

    logToFile(`[SERVERS] User ${req.session.username} joined server ${serverId}`);

    // let ws clients know theres a new member
    if (globalWss) {
      broadcastWs({
        type: 'server_member_joined',
        serverId,
        member
      });
      broadcastServerMembers(serverId);
      broadcastPresence();
    }

    // return the server with full details
    res.json({
      ok: true,
      member,
      server: buildServerPayload(server, req)
    });
  } catch (error) {
    logToFile(`[SERVERS] Join server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to join server' });
  }
});

// leave server
app.post('/api/servers/:serverId/leave', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    db.removeServerMember(serverId, req.session.userId);
    db.updateOnlineServer(req.session.userId, null);
    setClientServerForUser(req.session.userId, null);
    logToFile(`[SERVERS] User ${req.session.username} left server ${serverId}`);

    // let ws clients know a member left
    if (globalWss) {
      broadcastWs({
        type: 'server_member_left',
        serverId,
        userId: req.session.userId
      });
      broadcastServerMembers(serverId);
      broadcastPresence();
    }
    
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVERS] Leave server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to leave server' });
  }
});

// delete server (admin/owner only)
app.delete('/api/servers/:serverId', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const server = db.getActiveServerById(serverId);
    
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // is this person the owner (host) or an admin?
    const isOwner = server.host_id === req.session.userId;
    const isAdmin = db.isServerAdmin(serverId, req.session.userId);

    if (!isOwner && !isAdmin && !req.session.isAdmin) {
      // global admins get to delete any server too
      if (!req.session.isAdmin) {
        return res.status(403).json({ error: 'Only server owner or admins can delete this server' });
      }
    }

    const serverMembers = db.getServerMembers(serverId);
    serverMembers.forEach((member) => {
      db.updateOnlineServer(member.user_id, null);
    });

    db.deleteActiveServer(serverId);
    clearClientServer(serverId);
    logToFile(`[SERVERS] Server ${serverId} deleted by ${req.session.username}`);

    // let ws clients know the server's gone
    if (globalWss) {
      broadcastWs({
        type: 'server_deleted',
        serverId
      });
      broadcastPresence();
    }
    
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVERS] Delete server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

// get server members
app.get('/api/servers/:serverId/members', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!serverId) {
      return res.status(400).json({ error: 'Server ID required' });
    }
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to view members' });
    }
    const members = db.getServerMembers(serverId);
    res.json({ ok: true, members });
  } catch (error) {
    logToFile(`[SERVERS] Get members error: ${error.message}`, true);
    logToFile(`[SERVERS] Stack: ${error.stack}`, true);
    res.status(500).json({ error: 'Failed to get server members' });
  }
});

// kick user from server (admin only)
app.post('/api/servers/:serverId/kick/:userId', requireAuth, (req, res) => {
  try {
    const { serverId, userId } = req.params;

    // gotta be admin to kick someone
    const isAdmin = db.isServerAdmin(serverId, req.session.userId);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only server admins can kick users' });
    }

    db.removeServerMember(serverId, userId);
    db.updateOnlineServer(userId, null);
    setClientServerForUser(userId, null);
    logToFile(`[SERVERS] User ${userId} kicked from server ${serverId} by ${req.session.username}`);

    // let ws clients know someone got kicked
    if (globalWss) {
      broadcastWs({
        type: 'user_kicked',
        serverId,
        userId
      });
      broadcastServerMembers(serverId);
      broadcastPresence();
    }
    
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVERS] Kick user error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to kick user' });
  }
});

// get user's servers
app.get('/api/servers/my', requireAuth, (req, res) => {
  try {
    const userServers = db.getUserServers(req.session.userId);
    const serversWithDetails = buildServerListPayload(userServers, req);
    res.json({ ok: true, servers: serversWithDetails });
  } catch (error) {
    logToFile(`[SERVERS] Get user servers error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get user servers' });
  }
});

// server queue & player state routes

// get server chat history
app.get('/api/server/:serverId/messages', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to view messages' });
    }

    const messages = db.getServerMessages(serverId);
    res.json({ ok: true, messages });
  } catch (error) {
    logToFile(`[SERVER CHAT] Get messages error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get server messages' });
  }
});

// send server chat message
app.post('/api/server/:serverId/messages', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to send messages' });
    }

    if (!text) {
      return res.status(400).json({ error: 'Message text required' });
    }

    const settings = db.getSettings(req.session.userId);
    const senderThemeColor = settings ? { r: settings.theme_color_r || 255, g: settings.theme_color_g || 89, b: settings.theme_color_b || 0 } : null;
    const message = db.createServerMessage(serverId, req.session.userId, req.session.username, text, senderThemeColor);
    logToFile(`[SERVER CHAT] Message sent in ${serverId} by ${req.session.username}`);

    if (globalWss) {
      broadcastToServer(serverId, {
        type: 'chat_message',
        serverId,
        message
      });
    }

    res.json({ ok: true, message });
  } catch (error) {
    logToFile(`[SERVER CHAT] Send message error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to send server message' });
  }
});

// add track to server queue
app.post('/api/server/:serverId/queue', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const { videoId, title, author, format, source, thumbnail, externalUrl, durationMs } = req.body;

    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to update the queue' });
    }

    if (!videoId || !title) {
      return res.status(400).json({ error: 'videoId and title required' });
    }

    const track = db.addToServerQueue(serverId, { 
      videoId, 
      title, 
      author, 
      format: format || 'mp3',
      source,
      thumbnail,
      externalUrl,
      durationMs
    }, req.session.username);
    logToFile(`[SERVER QUEUE] Track added to ${serverId}: ${title}`);

    if (globalWss) {
      broadcastServerQueue(serverId);
    }

    res.json({ ok: true, track });
  } catch (error) {
    logToFile(`[SERVER QUEUE] Add track error: ${error.message}`, true);
    logToFile(`[SERVER QUEUE] Full error: ${error.stack}`, true);
    logToFile(`[SERVER QUEUE] Request body: ${JSON.stringify(req.body)}`, true);
    res.status(500).json({ error: `Failed to add track to queue: ${error.message}` });
  }
});

// get server queue
app.get('/api/server/:serverId/queue', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to view the queue' });
    }
    const queue = db.getServerQueue(serverId);
    res.json({ ok: true, queue });
  } catch (error) {
    logToFile(`[SERVER QUEUE] Get queue error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get server queue' });
  }
});

// remove track from server queue
app.delete('/api/server/:serverId/queue/:trackId', requireAuth, (req, res) => {
  try {
    const { serverId, trackId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to update the queue' });
    }
    db.removeFromServerQueue(trackId, serverId);
    logToFile(`[SERVER QUEUE] Track removed from ${serverId}: ${trackId}`);

    if (globalWss) {
      broadcastServerQueue(serverId);
    }

    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVER QUEUE] Remove track error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to remove track from queue' });
  }
});

// clear server queue
app.delete('/api/server/:serverId/queue', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to update the queue' });
    }
    db.clearServerQueue(serverId);
    logToFile(`[SERVER QUEUE] Queue cleared for ${serverId}`);

    if (globalWss) {
      broadcastServerQueue(serverId);
    }

    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVER QUEUE] Clear queue error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to clear server queue' });
  }
});

// update server player state
app.post('/api/server/:serverId/player', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const { current_track_id, is_playing, current_time, volume, sync_updated_at_ms } = req.body;

    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to update player state' });
    }

    db.updateServerPlayerState(serverId, {
      current_track_id,
      is_playing,
      current_time,
      volume,
      sync_updated_at_ms
    });

    logToFile(`[SERVER PLAYER] State updated for ${serverId}`);

    if (globalWss) {
      broadcastServerPlayerState(serverId);
    }

    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVER PLAYER] Update state error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to update player state' });
  }
});

// get server player state
app.get('/api/server/:serverId/player', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to view player state' });
    }
    const state = db.getServerPlayerState(serverId);
    res.json({ ok: true, state, server_now_ms: Date.now() });
  } catch (error) {
    logToFile(`[SERVER PLAYER] Get state error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get player state' });
  }
});

// clear server player state
app.delete('/api/server/:serverId/player', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to update player state' });
    }
    db.deleteServerPlayerState(serverId);
    logToFile(`[SERVER PLAYER] State cleared for ${serverId}`);

    if (globalWss) {
      broadcastServerPlayerState(serverId);
    }

    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVER PLAYER] Clear state error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to clear player state' });
  }
});

// debug logs endpoint
app.get('/api/debug/logs', (req, res) => {
  try {
    const lineLimit = Math.min(Number(req.query.lines) || 200, 2000);
    const readLastLines = (filePath, maxLines) => {
      if (!fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      // strip empty lines and just take the last N
      const nonEmpty = lines.filter(l => l.trim());
      return nonEmpty.slice(-maxLines);
    };

    const serverLines = readLastLines(logFile, lineLimit);
    const errorLines = readLastLines(errorLogFile, Math.floor(lineLimit / 2));

    res.json({ server_lines: serverLines, error_lines: errorLines });
  } catch (error) {
    logToFile(`[DEBUG] Failed to load debug logs: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to load debug logs', details: error.message });
  }
});

// serve react app catch-all (must be after all api routes)
if (fs.existsSync(resolvedBuildPath)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(resolvedBuildPath, 'index.html'));
  });
} else {
  // simple fallback page so the server never returns enoent for '/'
  app.get('*', (req, res) => {
    res.type('html').send(`<!doctype html>
      <html><head><meta charset="utf-8"><title>Shibenchi's music player</title></head>
      <body style="background:#050505;color:#f9b233;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;">
        <h1 style="margin:0 0 12px;">Shibenchi's music player</h1>
        <p style="margin:0 0 16px;">Frontend build not found.</p>
        <p style="margin:0;">Run <code style="color:#fff;background:#222;padding:4px 8px;border-radius:6px;">npm run build</code> or <code style="color:#fff;background:#222;padding:4px 8px;border-radius:6px;">npm run dev</code>.</p>
      </body></html>`);
  });
}

const server = http.createServer({
  maxHeaderSize: 16 * 1024 // 16KB for headers (increased from 8KB default)
}, app);

const wss = createWebSocketServer(server, sessionMiddleware);
globalWss = wss; // store global reference

wss.on('connection', (ws, request) => {
  const clientId = require('crypto').randomBytes(8).toString('hex');
  const userId = request.session.userId;
  const username = request.session.username;
  const existingStatus = db.getUserOnlineStatus(userId);
  const currentServerId = existingStatus?.current_server_id || null;

  wsClients.set(clientId, {
    ws,
    userId,
    username,
    serverId: currentServerId,
    listeningState: null
  });

  incrementUserSocketCount(userId);
  db.setOnlineStatus(userId);
  
  console.log(`[WS] Client connected: ${clientId} (${username})`);
  console.log(`[WS] Total clients: ${wsClients.size}`);
  
  // send em a connection confirmation
  sendWs(ws, {
    type: 'connected',
    clientId,
    userId,
    username,
    current_server_id: currentServerId,
    wsUrl: getPublicWsUrl(request),
    wsPath: WS_PATH,
    users: getConnectedUsers()
  });

  // broadcast the new user to everyone else
  broadcastWs({
    type: 'user_joined',
    user: {
      id: userId,
      username,
      current_server_id: currentServerId
    },
    users: getConnectedUsers()
  }, null, clientId);
  broadcastPresence(clientId);

  if (currentServerId && isServerMember(currentServerId, userId)) {
    sendServerState(ws, currentServerId, request);
  }
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const client = wsClients.get(clientId);
      if (!client) return;
      
      switch (data.type) {
        case 'set_username':
          sendWs(ws, {
            type: 'username_set',
            username: client.username
          });
          break;

        case 'set_listening_state': {
          const nextListeningState = sanitizeListeningState(data.listening);
          const previousSerialized = JSON.stringify(client.listeningState || null);
          const nextSerialized = JSON.stringify(nextListeningState || null);

          client.listeningState = nextListeningState;
          sendWs(ws, {
            type: 'listening_state_set',
            listening_to: nextListeningState
          });

          if (previousSerialized !== nextSerialized) {
            broadcastPresence();
          }
          break;
        }

        case 'join_server': {
          const targetServerId = data.serverId;

          if (!targetServerId) {
            sendWs(ws, { type: 'error', error: 'Server ID required' });
            break;
          }

          if (!isServerMember(targetServerId, userId)) {
            sendWs(ws, { type: 'error', error: 'Must be a server member to connect' });
            break;
          }

          client.serverId = targetServerId;
          db.updateOnlineServer(userId, targetServerId);

          sendWs(ws, {
            type: 'joined_server',
            serverId: targetServerId
          });
          sendServerState(ws, targetServerId, request);
          broadcastPresence();
          broadcastServerMembers(targetServerId);
          break;
        }

        case 'leave_server': {
          const previousServerId = client.serverId;
          client.serverId = null;
          db.updateOnlineServer(userId, null);

          sendWs(ws, { type: 'left_server', serverId: previousServerId });
          if (previousServerId) {
            broadcastServerMembers(previousServerId);
          }
          broadcastPresence();
          break;
        }

        case 'chat':
        case 'chat_message': {
          const targetServerId = data.serverId || client.serverId;
          const text = typeof data.text === 'string' ? data.text.trim() : '';

          if (!targetServerId || !text) {
            break;
          }

          if (!isServerMember(targetServerId, userId)) {
            sendWs(ws, { type: 'error', error: 'Must be a server member to chat' });
            break;
          }

          const sSettings = db.getSettings(userId);
          const sSenderThemeColor = sSettings ? { r: sSettings.theme_color_r || 255, g: sSettings.theme_color_g || 89, b: sSettings.theme_color_b || 0 } : null;
          const serverMessage = db.createServerMessage(targetServerId, userId, username, text, sSenderThemeColor);
          broadcastToServer(targetServerId, {
            type: 'chat_message',
            serverId: targetServerId,
            message: serverMessage
          });
          break;
        }

        case 'share_track':
        case 'track_shared': {
          const targetServerId = data.serverId || client.serverId;

          if (!targetServerId) {
            break;
          }

          if (!isServerMember(targetServerId, userId)) {
            sendWs(ws, { type: 'error', error: 'Must be a server member to share tracks' });
            break;
          }

          const track = data.track || {
            videoId: data.videoId,
            title: data.title,
            author: data.author
          };

          broadcastToServer(targetServerId, {
            type: 'track_shared',
            serverId: targetServerId,
            track: {
              ...track,
              user: username,
              timestamp: Date.now()
            }
          });
          break;
        }

        case 'request_state': {
          const targetServerId = data.serverId || client.serverId;

          if (!targetServerId) {
            sendWs(ws, {
              type: 'initial_state',
              users: getConnectedUsers(),
              messages: [],
              queue: [],
              player: null
            });
            break;
          }

          if (!isServerMember(targetServerId, userId)) {
            sendWs(ws, { type: 'error', error: 'Must be a server member to request state' });
            break;
          }

          sendServerState(ws, targetServerId, request);
          break;
        }
      }
    } catch (err) {
      console.error('[WS] Message error:', err);
    }
  });
  
  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${clientId}`);

    const client = wsClients.get(clientId);
    wsClients.delete(clientId);
    console.log(`[WS] Total clients: ${wsClients.size}`);

    if (client?.userId) {
      const remainingConnections = decrementUserSocketCount(client.userId);
      const remainingClient = Array.from(wsClients.values()).find(c => c.userId === client.userId);

      if (remainingConnections === 0) {
        db.setOfflineStatus(client.userId);
      } else {
        db.setOnlineStatus(client.userId);
        db.updateOnlineServer(client.userId, remainingClient?.serverId || null);
      }

      if (client.serverId) {
        broadcastServerMembers(client.serverId);
      }

      broadcastWs({
        type: 'user_left',
        user: {
          id: client.userId,
          username: client.username,
          current_server_id: remainingClient?.serverId || null
        },
        users: getConnectedUsers()
      });
      broadcastPresence();
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error with client ${clientId}:`, err);
  });
});

wss.on('error', (err) => {
  logToFile(`[WS] WebSocket server error: ${err.message}`, true);
});

server.listen(PORT, () => {
  logToFile(`Server listening on http://localhost:${PORT}`);
  logToFile(`Public app url: ${getPublicAppUrl()}`);
  logToFile(`Public ws url: ${getPublicWsUrl()}`);
  logToFile(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logToFile(`YouTube API Key configured: ${!!process.env.YOUTUBE_API_KEY}`);
  logToFile(`Search: Invidious (primary) + yt-search (fallback)`);
  
  // print a helpful startup message so it's obvious the server's actually up
  if (fs.existsSync(resolvedBuildPath)) {
    logToFile('=== SERVER READY ===');
    logToFile('open http://localhost:3001 in your browser');
  } else {
    logToFile('=== SERVER READY (backend only) ===');
    logToFile('frontend not built yet - run: npm run build');
    logToFile('or run dev mode: npm run dev');
  }
});
} // end FULL SERVER MODE
