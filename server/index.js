const path = require('path');
const fs = require('fs');
// videoId goes straight from the query string into path.join() for every
// file this app touches (stream cache, downloads, thumbnail sidecars) -
// with nothing checking its shape, a request like
// videoId=../../../../whatever could read/write files way outside
// temp_audio/downloads. both local servers listen on all interfaces too (no
// host restriction on .listen()), so this isnt just a same-machine thing -
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
// single launch - measured a consistent ~5.3s of pure startup overhead on
// this machine before a single network request even goes out, which was
// most of what made "buffering" feel so long. the "onedir" distribution
// (unpacked once at node_modules/yt-dlp-exec/bin/yt-dlp-fast/, see the repo
// readme for how its set up) skips that re-extraction and starts in ~2.3s
// instead. falls back to the bundled binary if that folder isnt there (e.g
// a fresh install elsewhere that hasnt set it up yet)
const fastYtdlpPath = path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp-fast', 'yt-dlp.exe');
const ytdlpExec = fs.existsSync(fastYtdlpPath) ? ytdlpBin.create(fastYtdlpPath) : ytdlpBin;
// bundling ffmpeg via ffmpeg-static so audio extraction just works out of
// the box - yt-dlp's postprocessing (format conversion) hard-requires
// ffmpeg/ffprobe on PATH otherwise, and most people dont have that installed
const ytdlp = (url, options = {}) => ytdlpExec(url, { ffmpegLocation: ffmpegPath, ...options });
const ytSearch = require('yt-search');
const axios = require('axios');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const WebSocket = require('ws');
const crypto = require('crypto');
const validation = require('./validation');
const { createMediaTools, AUDIO_FORMAT_SELECTOR } = require('./mediaUtils');

// detect local helper mode (runs alongside the vps, just handles yt-dlp/ffmpeg endpoints)
const IS_LOCAL_HELPER = process.argv.includes('--local-helper') || process.env.LOCAL_HELPER === '1';
const LOCAL_HELPER_PORT = Number(process.env.LOCAL_HELPER_PORT || process.env.PORT || 3002);

// tauri sets APP_DATA_DIR once installed, pointing at a proper per-user
// writable location (AppData\Roaming\<id>) instead of wherever this code
// happens to be sitting - an installed app's own folder (program files)
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

    // race every instance at once instead of trying them one at a time -
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
      // every invidious instance failed or came back empty - fall through
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
    // the id goes straight into a url, so keep it to the characters real ids use
    if (!/^[A-Za-z0-9_-]{2,80}$/.test(playlistId)) return res.status(400).json({ error: 'Invalid playlist ID' });
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
      noteYoutubeSuccess();
      res.json({ playlistId, title, items });
    } catch (error) {
      noteYoutubeFailure(error);
      sendYoutubeError(res, error, 'Failed to fetch playlist');
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
      noteYoutubeSuccess();
      res.json({ videoId, title: info.title || '', author: info.uploader || info.channel || '' });
    } catch (error) {
      noteYoutubeFailure(error);
      sendYoutubeError(res, error, 'Failed to fetch video info');
    }
  });

  // cache, range serving and youtube rate limit handling live in mediaUtils.js,
  // shared with the full server's own media endpoints
  const {
    isBotCheckError, noteYoutubeFailure, noteYoutubeSuccess, inYoutubeCooldown,
    sendYoutubeError, isCompleteAudioFile, downloadToCache, serveLocalFile, sweepLeftoverDownloads
  } = createMediaTools({ ytdlp, log: helperLog });
  sweepLeftoverDownloads(path.join(APP_DATA_DIR, 'temp_audio'));

  // resolved direct-cdn urls, kept around for a while so replaying a track
  // or skipping back doesnt pay the yt-dlp resolve cost again - these urls
  // are normally valid for several hours, this just caches for less than
  // that so we stay well clear of them actually expiring mid-play
  const resolvedUrlCache = new Map(); // videoId -> { url, expiresAt }
  const RESOLVED_URL_TTL_MS = 3 * 60 * 60 * 1000;
  const inFlightResolves = new Map(); // videoId -> Promise<string>, shared between prefetch and actual playback

  // the yt-dlp resolve is what actually makes clicking a new track feel
  // slow (youtube-side extraction time, not something more client/flag
  // tweaking gets around) - everything else here just avoids paying that
  // cost twice: once via the resolved-url cache above, and once via
  // /api/prefetch getting called ahead of time for whatevers up next in queue
  // videos that YouTube says are not there (removed, private, blocked). remembered for half an hour, so a second try is
  // answered at once instead of spending another 20 seconds in yt-dlp (a song like that was tried over and over:
  // every try ran the resolve, then a full download, and the player showed "slow connection" the whole time)
  const unavailableVideos = new Map(); // videoId -> until
  const UNAVAILABLE_TTL_MS = 30 * 60 * 1000;
  const UNAVAILABLE_PATTERN = /video unavailable|this video is (not available|unavailable|private|no longer available)|private video|has been removed|removed by the uploader|account (associated with this video )?has been terminated|blocked it in your country|not available in your country|not made this video available|video is not available/i;
  const isUnavailableError = (error) => Boolean(error && (error.unavailable || UNAVAILABLE_PATTERN.test(String(error.stderr || '') + ' ' + String(error.message || ''))));
  function unavailableNow(videoId) {
    const until = unavailableVideos.get(videoId);
    if (!until) return false;
    if (until < Date.now()) { unavailableVideos.delete(videoId); return false; }
    return true;
  }
  function markUnavailable(videoId) {
    unavailableVideos.set(videoId, Date.now() + UNAVAILABLE_TTL_MS);
  }
  // YouTube's own answer to "is this video there": 404 is removed or private, and it comes in a few hundred
  // milliseconds where yt-dlp needs 6 to 19 seconds to reach the same conclusion. only a 404 settles this promise
  // (rejecting), everything else leaves the decision to yt-dlp
  function unavailableAtYoutube(videoId) {
    return axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: 4000,
      validateStatus: () => true
    }).then((response) => {
      if (response.status === 404) throw Object.assign(new Error('Video unavailable'), { unavailable: true });
      return new Promise(() => {});
    }, () => new Promise(() => {}));
  }

  function resolveDirectUrl(videoId) {
    if (unavailableNow(videoId)) {
      helperLog(`resolveDirectUrl(${videoId}): known to be unavailable, not asking again`);
      return Promise.reject(Object.assign(new Error('This video is not available on YouTube'), { unavailable: true }));
    }
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
      const gone = unavailableAtYoutube(videoId);
      gone.catch(() => {});
      const run = ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificate: true,
        skipDownload: true,
        // the android client used to be picked here for speed (skips most
        // of the web client's js/signature round trips) but youtube has
        // since locked it down to a single muxed 360p video+audio format
        // (itag 18) - no audio-only formats at all anymore. bestaudio/best
        // was then falling all the way through to that muxed format, which
        // is what was actually producing the corrupt/undecodable streams
        // (DEMUXER_ERROR_COULD_NOT_OPEN) and the cascading track-skip
        // failures. the default client still resolves proper audio-only
        // m4a (itag 140) at basically the same wall-clock cost, verified
        // both ways against several of the failing videoIds
        format: AUDIO_FORMAT_SELECTOR
      });
      run.catch(() => {});
      let raw;
      try {
        raw = await Promise.race([run, gone]);
      } catch (error) {
        // YouTube said the video is not there: yt-dlp is stopped, it would only come to the same answer later
        if (error && error.unavailable && typeof run.kill === 'function') { try { run.kill(); } catch { /* already over */ } }
        throw error;
      }
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!info.url) throw new Error('no direct stream url resolved');
      resolvedUrlCache.set(videoId, { url: info.url, expiresAt: Date.now() + RESOLVED_URL_TTL_MS });
      noteYoutubeSuccess();
      helperLog(`resolveDirectUrl(${videoId}): resolved in ${Date.now() - startedAt}ms`);
      return info.url;
    })()
      .catch((err) => {
        if (isUnavailableError(err)) {
          err.unavailable = true;
          markUnavailable(videoId);
        } else {
          noteYoutubeFailure(err);
        }
        helperLog(`resolveDirectUrl(${videoId}): FAILED after ${Date.now() - startedAt}ms - ${String(err.message).split('\n')[0].slice(0, 300)}`);
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
    // prefetch is a guess about what plays next, so it backs off completely
    // while youtube is rate limiting us
    if (inYoutubeCooldown()) {
      helperLog(`/api/prefetch(${videoId}): skipped, youtube cooldown active`);
      return res.json({ ok: false, error: 'paused while youtube is rate limiting', code: 'youtube_bot_check' });
    }
    try {
      await resolveDirectUrl(videoId);
      res.json({ ok: true });
    } catch (error) {
      helperLog(`/api/prefetch(${videoId}): failed - ${String(error.message).split('\n')[0].slice(0, 300)}`);
      // not fatal - /api/stream will just resolve cold when it actually plays
      res.json({ ok: false, error: error.message, ...(error.unavailable ? { code: 'unavailable' } : {}) });
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
    // download below) - serve straight off disk. this is also what makes
    // offline playback of anything youve listened to before work
    if (fs.existsSync(audioFile)) {
      if (isCompleteAudioFile(audioFile)) {
        helperLog(`/api/stream(${videoId}): serving from disk cache, ${Date.now() - reqStartedAt}ms`);
        try {
          return serveLocalFile(req, res, audioFile, 'audio/m4a');
        } catch (error) {
          return res.status(500).json({ error: error.message || 'Stream failed' });
        }
      }
      // a truncated or corrupt file from an older run. drop it and fetch
      // the track fresh below instead of serving something undecodable
      helperLog(`/api/stream(${videoId}): cached file is incomplete, discarding it`);
      try { fs.unlinkSync(audioFile); } catch {}
    }

    // not cached to disk yet. resolving a direct cdn url (no download) and
    // proxying it live gets audio flowing without waiting for yt-dlp to
    // download+transcode the whole track first. proxied (not redirected) so
    // playback stays same-origin - the web audio analyser powering the eq
    // and visualizer taints/goes silent on cross-origin media elements, learned
    // that one the hard way
    //
    // the background cache-warm is deliberately delayed a few seconds: it
    // spawns its own yt-dlp + ffmpeg transcode, and starting it at the same
    // instant as the resolve below just makes them fight over cpu/network
    // right when the resolve latency is what the user's staring at
    setTimeout(() => {
      if (inYoutubeCooldown() || unavailableNow(videoId)) return;
      downloadToCache(videoId, audioFile).catch(() => {
        // background cache-warm failed; the fallback path below will retry
        // it inline if the fast path also fails too, otherwise just skip
        // caching this once instead of breaking playback over it
      });
    }, 4000);

    try {
      const directUrl = await resolveDirectUrl(videoId);

      let upstream;
      // axios' timeout option is an idle socket timeout, and on a streamed
      // body it kept running after the headers came back. a browser reads
      // ahead and then sits idle while the song plays, so after 15 quiet
      // seconds axios killed the connection mid-song and the player went
      // into its retry-then-skip path. the 15 seconds now only covers
      // waiting for youtube to start answering, and is cleared the moment
      // it does
      const connectAbort = new AbortController();
      const connectTimer = setTimeout(() => connectAbort.abort(), 15000);
      try {
        upstream = await axios.get(directUrl, {
          headers: req.headers.range ? { range: req.headers.range } : {},
          responseType: 'stream',
          signal: connectAbort.signal,
          validateStatus: (status) => status >= 200 && status < 300
        });
        clearTimeout(connectTimer);
      } catch (upstreamError) {
        clearTimeout(connectTimer);
        // cached url stopped working (expired early / revoked) - drop it
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
      // client skipped to another track or closed the page: stop pulling from
      // youtube instead of leaving the upstream connection open
      res.on('close', () => upstream.data.destroy());
      upstream.data.on('error', () => res.destroy());

      // a connection that has really died (youtube stopped sending while the
      // browser is waiting for more) still needs to be cut, otherwise the
      // player just hangs. but only count quiet time while we are not the
      // slow side: if the browser has stopped reading, nothing arriving from
      // youtube is expected
      let lastUpstreamDataAt = Date.now();
      upstream.data.on('data', () => { lastUpstreamDataAt = Date.now(); });
      const deadStreamWatch = setInterval(() => {
        if (!res.writableNeedDrain && Date.now() - lastUpstreamDataAt > 25000) {
          helperLog(`/api/stream(${videoId}): upstream sent nothing for 25s while the client was waiting, closing`);
          upstream.data.destroy();
          res.destroy();
        }
      }, 5000);
      res.on('close', () => clearInterval(deadStreamWatch));
      upstream.data.on('close', () => clearInterval(deadStreamWatch));

      upstream.data.pipe(res);
    } catch (fastPathError) {
      // a bot check on the resolve means the full download below would hit the
      // same wall, so dont double up on youtube, answer right away
      if (isBotCheckError(fastPathError)) {
        helperLog(`/api/stream(${videoId}): youtube bot check, not retrying`);
        if (!res.headersSent) return sendYoutubeError(res, fastPathError, 'Stream failed');
        return res.destroy();
      }
      // removed, private or blocked: there is nothing to fall back to. answered at once, with a status the page can read
      if (isUnavailableError(fastPathError)) {
        markUnavailable(videoId);
        helperLog(`/api/stream(${videoId}): not available on youtube, answered after ${Date.now() - reqStartedAt}ms`);
        if (!res.headersSent) return res.status(410).json({ error: 'This video is not available on YouTube', code: 'unavailable' });
        return res.destroy();
      }
      helperLog(`/api/stream(${videoId}): fast path FAILED at ${Date.now() - reqStartedAt}ms - ${fastPathError.message}, falling back to full download`);
      // fast path failed (throttled/blocked/expired url) - fall back to the
      // original download-then-serve approach so playback still works
      try {
        await downloadToCache(videoId, audioFile);
        helperLog(`/api/stream(${videoId}): fallback download done, ${Date.now() - reqStartedAt}ms total`);
        serveLocalFile(req, res, audioFile, 'audio/m4a');
      } catch (fallbackError) {
        helperLog(`/api/stream(${videoId}): fallback FAILED - ${fallbackError.message}`);
        if (!res.headersSent) {
          sendYoutubeError(res, fallbackError, 'Stream failed');
        } else {
          res.destroy();
        }
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
        // afterward - that combined stream's audio bitrate is typically
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
      noteYoutubeFailure(error);
      sendYoutubeError(res, error, 'Download failed');
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
// happened to be launched from" - process.cwd() isnt meaningful once
// this runs as a bundled sidecar
const logsDir = path.join(APP_DATA_DIR, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// logging setup
const logFile = path.join(logsDir, `server-${new Date().toISOString().split('T')[0]}.log`);
const errorLogFile = path.join(logsDir, `errors-${new Date().toISOString().split('T')[0]}.log`);

// the app on a computer: a person is sitting at it, a server that logged a problem and went on is better for them
// than a dead one (the Discord crash took the whole local server down with it)
if (process.env.APP_DATA_DIR && process.env.DISABLE_MEDIA_ENDPOINTS !== '1') {
  process.on('uncaughtException', (error) => {
    try { logToFile('[SERVER] uncaught error, going on: ' + ((error && error.stack) || error), true); } catch { /* the log itself is the problem */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { logToFile('[SERVER] unhandled rejection, going on: ' + ((reason && reason.stack) || reason), true); } catch { /* the log itself is the problem */ }
  });
}

function logToFile(message, isError = false) {
  const timestamp = new Date().toISOString();
  // one entry per line, so a name or message with a newline in it cant fake a log line
  const logMessage = `[${timestamp}] ${String(message).replace(/[\r\n]+/g, ' ')}\n`;

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
// gotta be NOT '/ws' - that collides with webpack-dev-server's own hmr
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
// auth token store, for cross-origin requests. tokens are random, expire
// after 7 days and get revoked on logout
const authTokens = validation.createAuthTokenStore(() => db.authTokenStorage);

// slow down password guessing and mass account creation. keyed by ip, and for
// logins also by the username being tried
const loginAttemptLimiter = validation.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const loginIpLimiter = validation.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 });
const registerLimiter = validation.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

// who a request counts as for rate limiting. req.ip follows the forwarded
// header when TRUST_PROXY is on, so set that when running behind caddy or every
// visitor shares the proxy's address and one limit
function getClientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function tooManyAttempts(res, retryAfterSec) {
  res.set('Retry-After', String(retryAfterSec));
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return res.status(429).json({ error: `Too many attempts, try again in ${minutes} minute${minutes === 1 ? '' : 's'}` });
}

const db = require('./database');

// viewer: a user id, or true when the receiver is known to be a member. the
// join code of a private channel is only included for members, everyone else
// sees that it is private and nothing more
function buildServerPayload(serverRecord, req = null, viewer = null) {
  if (!serverRecord) return null;
  const members = db.getServerMembers(serverRecord.id);
  const viewerIsMember = viewer === true || (typeof viewer === 'string' && members.some((member) => member.user_id === viewer));
  const payload = {
    ...serverRecord,
    is_private: serverRecord.is_private ? 1 : 0,
    wsUrl: getPublicWsUrl(req),
    wsPath: WS_PATH,
    members
  };
  if (!viewerIsMember) delete payload.join_code;
  return payload;
}

// a theme color channel can really be 0 (pure red has no green and no blue), so only
// a missing value falls back to the default. using || turned every 0 into the default
// and a pink (255, 0, 85) came out as a salmon (255, 89, 85)
function themeColorOf(settings) {
  const channel = (value, fallback) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));
  return {
    r: channel(settings && settings.theme_color_r, 255),
    g: channel(settings && settings.theme_color_g, 89),
    b: channel(settings && settings.theme_color_b, 0)
  };
}

function buildServerListPayload(servers, req = null, viewer = null) {
  return servers.map(serverRecord => buildServerPayload(serverRecord, req, viewer));
}

function sendWs(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// what one device is playing, passed on to the account's other devices so they
// can show "playing on your phone". text is cut to size and the picture must be
// a web address, nothing else is trusted
function sanitizeDeviceState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim().slice(0, 200);
  if (!title) return null;
  const number = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
  const thumbnail = String(raw.thumbnail || '').trim().slice(0, 300);
  return {
    title,
    author: String(raw.author || '').trim().slice(0, 200),
    videoId: String(raw.videoId || '').trim().slice(0, 32),
    thumbnail: /^https?:\/\//i.test(thumbnail) ? thumbnail : '',
    source: raw.source === 'shared' ? 'shared' : 'personal',
    playing: raw.playing === true,
    position: number(raw.position),
    duration: number(raw.duration),
    at: Date.now()
  };
}

function sanitizeDevice(raw) {
  const device = raw && typeof raw === 'object' ? raw : {};
  const kind = ['phone', 'computer', 'browser'].includes(device.kind) ? device.kind : 'browser';
  return {
    id: String(device.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
    name: String(device.name || kind).trim().slice(0, 40) || kind,
    kind
  };
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

// accounts that keep what they listen to from other people. looked up in the db
// once, then kept here until the account saves its settings again
const hiddenListeningCache = new Map();
function isListeningHidden(userId) {
  if (!hiddenListeningCache.has(userId)) {
    let hidden = false;
    try { hidden = db.getSettings(userId).hide_listening === 1; } catch { /* shown */ }
    hiddenListeningCache.set(userId, hidden);
  }
  return hiddenListeningCache.get(userId);
}

// every open connection of one account
function sendToUser(userId, payload) {
  wsClients.forEach((client) => {
    if (client.userId === userId) sendWs(client.ws, payload);
  });
}

// ---- what people listen to, counted for their own stats. a connection that says it is playing something starts
// a stretch, any change (another song, a pause, the connection going away) and every half minute while it plays
// close it and add it to the account's stats. two devices playing at once do not count twice
const listeningCredited = new Map();
// flushing: the stretch is still going, so a piece that is too short to count is left to grow instead of dropped.
// when a stretch ends, a short one is dropped (somebody skipping through songs), unless part of it was counted already
function commitListening(client, nowMs, flushing = false) {
  const state = client.listeningState;
  const since = client.listeningSince;
  if (!client.userId || !state || !since || state.is_playing === false) {
    client.listeningSince = null;
    client.listeningCounted = 0;
    return;
  }
  const end = Math.floor(nowMs / 1000);
  const start = Math.max(Math.floor(since / 1000), listeningCredited.get(client.userId) || 0);
  if (end - start < (client.listeningCounted ? 1 : 5)) {
    if (flushing) return;
    client.listeningSince = null;
    client.listeningCounted = 0;
    return;
  }
  try {
    if (db.recordListening(client.userId, state, start, end)) {
      listeningCredited.set(client.userId, end);
      client.listeningCounted = (client.listeningCounted || 0) + (end - start);
    }
  } catch (error) {
    logToFile(`[STATS] Could not record listening: ${error.message}`, true);
  }
  client.listeningSince = flushing ? nowMs : null;
  if (!flushing) client.listeningCounted = 0;
}
// the stretch so far is counted and goes on (the person's stats page is then up to the second)
function flushListening(userId = null) {
  const now = Date.now();
  wsClients.forEach((client) => {
    if (!client.listeningSince || (userId && client.userId !== userId)) return;
    commitListening(client, now, true);
  });
}
setInterval(() => flushListening(), 30 * 1000).unref();

// invites to rooms are kept a day
try { db.purgeRoomInvites(); } catch { /* nothing to clean */ }
setInterval(() => { try { db.purgeRoomInvites(); } catch { /* next time */ } }, 60 * 60 * 1000).unref();

function getConnectedUsers() {
  const connectedUsers = new Map();

  wsClients.forEach((client) => {
    if (!client.userId || !client.username) return;

    const existing = connectedUsers.get(client.userId);
    // the kinds of device (phone, computer) the person has the app open on, from every connection
    const platforms = new Set(existing?.platforms || []);
    if (client.platform === 'mobile' || client.platform === 'pc') platforms.add(client.platform);
    const listeningState = isListeningHidden(client.userId) ? null : (client.listeningState || existing?.listening_to || null);
    const currentServerId = client.serverId || existing?.current_server_id || null;

    connectedUsers.set(client.userId, {
      id: client.userId,
      username: client.username,
      current_server_id: currentServerId,
      listening_to: listeningState,
      platforms: Array.from(platforms)
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

// === synced playback ===
// every play, resume, seek and skip goes through a short "preparing" phase:
// each member's player loads the track at the right spot and says it is ready,
// and only once everyone is ready does the server hand out one shared start
// time. so everybody hears the same audio at the same moment instead of
// whoever's connection is fastest starting first. pause is instant.
// the session lives in memory, a restart just leaves the channel paused.
const SYNC_LEAD_MS = 700; // gap between "all ready" and the start, covers network delay
// nobody starts before everyone listening is ready. a player that has not got
// ready after this long is taken out of the sync (it is told, and can rejoin by
// pressing play) so one broken player cannot hold a room silent forever. it is
// never started out of step with the others
const SYNC_DROP_AFTER_MS = 60000;
// once the first player is ready the rest get this long, not the whole minute. a player that
// works is ready a few seconds after the first one, and one that has not made it by now is
// not going to (its audio helper can not find the song, it lost its connection), while the
// whole room waits for it. it is taken out of the start like a straggler at the end of the
// minute is, and told, and it can join again by pressing play.
// 40 s (it was 20): a song that nobody had looked up yet takes a player 15 to 25 s to find on youtube, and a player left
// out of the start was out of step until it pressed play. SMP_SYNC_LATE_GRACE_MS changes it (the tests use a short one)
const SYNC_LATE_GRACE_MS = Number(process.env.SMP_SYNC_LATE_GRACE_MS) || 40000;
// a player that was taken out of a start is not waited for again by the starts after it, unless
// it presses play itself or proves it can get ready, for this long. without that it rejoined
// on its own and held up the next song for a minute again
const SYNC_RECENT_DROP_MS = 5 * 60 * 1000;

function clearSyncTimers(session) {
  if (!session) return;
  clearTimeout(session.timer);
  clearTimeout(session.graceTimer);
  session.timer = null;
  session.graceTimer = null;
}

// does a start wait for this connection
function isSyncParticipant(client, serverId) {
  if (!client || client.serverId !== serverId) return false;
  if (client.syncMode === 'yes') return true;
  if (client.syncMode !== 'auto') return false;
  return !(client.syncDroppedAt && Date.now() - client.syncDroppedAt < SYNC_RECENT_DROP_MS);
}
const syncSessions = new Map(); // serverId -> session
let syncRevisionCounter = 0;

function newSyncRevision() {
  syncRevisionCounter += 1;
  return `${Date.now()}-${syncRevisionCounter}`;
}

// where the shared track is right now, in seconds
function getSyncPosition(session, nowMs = Date.now()) {
  if (!session) return 0;
  if (session.phase === 'playing') {
    return session.position + Math.max(0, (nowMs - session.startAtMs) / 1000);
  }
  return session.position;
}

// repeat and shuffle belong to the room, everyone in it sees and can change them
const playModesCache = new Map(); // serverId -> { repeat_mode, shuffle }
function getPlayModes(serverId) {
  let modes = playModesCache.get(serverId);
  if (!modes) {
    try {
      modes = db.getServerPlayModes(serverId);
    } catch {
      modes = { repeat_mode: 'off', shuffle: false };
    }
    playModesCache.set(serverId, modes);
  }
  return modes;
}

// who a start is still waiting on and why, one entry per person
function getSyncWaiting(serverId, session) {
  const seen = new Map();
  wsClients.forEach((client, clientId) => {
    if (!isSyncParticipant(client, serverId)) return;
    if (session.ready.has(clientId)) return;
    const status = client.syncStatus && client.syncStatus.revision === session.revision ? client.syncStatus : null;
    if (!seen.has(client.userId)) {
      seen.set(client.userId, {
        user_id: client.userId,
        username: client.username,
        reason: status ? status.reason : 'getting ready'
      });
    }
  });
  return [...seen.values()];
}

function getSyncedPlayerState(serverId) {
  const base = db.getServerPlayerState(serverId);
  const session = syncSessions.get(serverId);
  const modes = getPlayModes(serverId);
  const modeFields = { repeat_mode: modes.repeat_mode, shuffle: modes.shuffle };

  if (!session) {
    if (!base) {
      if (modes.repeat_mode === 'off' && !modes.shuffle) return null;
      return { server_id: serverId, current_track_id: null, is_playing: false, current_time: 0, volume: 1, sync_phase: 'paused', start_at_ms: null, ...modeFields };
    }
    // nothing live in memory (fresh start): the channel is simply paused
    return { ...base, ...modeFields, is_playing: false, sync_phase: 'paused', start_at_ms: null };
  }

  return {
    ...(base || {}),
    ...modeFields,
    server_id: serverId,
    current_track_id: session.trackId,
    is_playing: session.phase === 'playing',
    current_time: session.position,
    sync_updated_at_ms: session.phase === 'playing' ? session.startAtMs : session.updatedAtMs,
    sync_phase: session.phase,
    revision: session.revision,
    start_at_ms: session.phase === 'playing' ? session.startAtMs : null,
    sync_waiting: session.phase === 'preparing' ? getSyncWaiting(serverId, session) : []
  };
}

function persistSyncSession(serverId, session) {
  db.updateServerPlayerState(serverId, {
    current_track_id: session.trackId,
    is_playing: session.phase !== 'paused',
    current_time: session.position,
    volume: 1,
    sync_updated_at_ms: session.phase === 'playing' ? session.startAtMs : session.updatedAtMs
  });
}

// the sockets that have to be ready before a start: connections in this channel
// that are playing along ("yes") or are about to join in on their own ("auto",
// they are on the shared tab with nothing else playing). someone busy with their
// own music ("no") neither hears it nor holds everyone up
function getSyncParticipantIds(serverId) {
  const ids = [];
  wsClients.forEach((client, clientId) => {
    if (isSyncParticipant(client, serverId)) {
      ids.push(clientId);
    }
  });
  return ids;
}

// whoever sends a play request is by definition listening to the shared player,
// even if their own "yes" report hasnt landed yet
function markUserListening(serverId, userId) {
  wsClients.forEach((client) => {
    if (client.serverId === serverId && client.userId === userId) client.syncMode = 'yes';
  });
}

function startSyncSession(serverId) {
  const session = syncSessions.get(serverId);
  if (!session || session.phase !== 'preparing') return;

  clearSyncTimers(session);
  session.phase = 'playing';
  session.startAtMs = Date.now() + SYNC_LEAD_MS;
  session.revision = newSyncRevision();
  persistSyncSession(serverId, session);
  logToFile(`[SYNC] ${serverId} start at +${SYNC_LEAD_MS}ms, ${session.ready.size} ready`);
  broadcastServerPlayerState(serverId);
}

// the guard timer of a start that has waited too long: whoever is still not ready
// is taken out of the sync and told, then the room starts for everyone who is
function dropSyncStragglers(serverId, revision, when = `${SYNC_DROP_AFTER_MS}ms`) {
  const session = syncSessions.get(serverId);
  if (!session || session.phase !== 'preparing' || session.revision !== revision) return;
  getSyncParticipantIds(serverId).forEach((clientId) => {
    if (session.ready.has(clientId)) return;
    const client = wsClients.get(clientId);
    if (!client) return;
    client.syncMode = 'no';
    client.syncDroppedAt = Date.now();
    sendWs(client.ws, { type: 'sync_dropped', serverId, reason: 'your player did not get ready in time, press play to join the room again' });
    logToFile(`[SYNC] ${serverId} dropped ${client.username} after ${when}: ${client.syncStatus ? client.syncStatus.reason : 'no status'}`);
  });
  startSyncSession(serverId);
}

// a connection that has gone silent (a phone that fell asleep, a page that was closed without
// telling anyone) can never get ready. the room used to wait for it until the guard above ran
// out, and for a whole minute again each time the song changed in the meantime. every player
// in a start is pinged when the start begins: one that has not answered in a few seconds is
// gone, not slow (a slow player still answers, the browser does that by itself), and it is
// not waited for
const SYNC_PING_GRACE_MS = 6000;
function dropUnresponsiveParticipants(serverId, revision) {
  const askedAt = Date.now();
  getSyncParticipantIds(serverId).forEach((clientId) => {
    const client = wsClients.get(clientId);
    if (client && client.ws && client.ws.readyState === 1) {
      try { client.ws.ping(); } catch { /* closing */ }
    }
  });
  const timer = setTimeout(() => {
    const session = syncSessions.get(serverId);
    if (!session || session.phase !== 'preparing' || session.revision !== revision) return;
    getSyncParticipantIds(serverId).forEach((clientId) => {
      if (session.ready.has(clientId)) return;
      const client = wsClients.get(clientId);
      if (!client || !client.ws) return;
      if ((client.ws.lastPongAt || 0) >= askedAt) return; // it answered, it is only slow
      client.syncMode = 'no';
      sendWs(client.ws, { type: 'sync_dropped', serverId, reason: 'your connection stopped answering, press play to join the room again' });
      logToFile(`[SYNC] ${serverId} not waiting for ${client.username}: no answer to a ping in ${SYNC_PING_GRACE_MS}ms`);
    });
    const stillWaiting = getSyncWaiting(serverId, session);
    if (stillWaiting.length) {
      logToFile(`[SYNC] ${serverId} after ${SYNC_PING_GRACE_MS}ms still waiting on: ${stillWaiting.map((w) => `${w.username} (${w.reason})`).join(', ')}`);
    }
    scheduleWaitingBroadcast(serverId);
    maybeStartSyncSession(serverId);
  }, SYNC_PING_GRACE_MS);
  if (timer.unref) timer.unref();
}

// a player's reason for not being ready yet changed: tell the room, at most a
// few times a second and only when the list of who is waiting actually changed
const waitingBroadcastTimers = new Map();
function scheduleWaitingBroadcast(serverId) {
  const session = syncSessions.get(serverId);
  if (!session || session.phase !== 'preparing' || waitingBroadcastTimers.has(serverId)) return;
  waitingBroadcastTimers.set(serverId, setTimeout(() => {
    waitingBroadcastTimers.delete(serverId);
    const live = syncSessions.get(serverId);
    if (!live || live.phase !== 'preparing') return;
    const key = JSON.stringify(getSyncWaiting(serverId, live));
    if (live.lastWaitingKey === key) return;
    live.lastWaitingKey = key;
    broadcastServerPlayerState(serverId);
  }, 400));
}

function maybeStartSyncSession(serverId) {
  const session = syncSessions.get(serverId);
  if (!session || session.phase !== 'preparing') return;
  const participants = getSyncParticipantIds(serverId);
  if (participants.every((clientId) => session.ready.has(clientId))) {
    startSyncSession(serverId);
  }
}

function handleSyncReady(serverId, clientId, revision) {
  const session = syncSessions.get(serverId);
  if (!session || session.phase !== 'preparing' || session.revision !== revision) return;
  session.ready.add(clientId);
  // it can get ready, so it is waited for again
  const readyClient = wsClients.get(clientId);
  if (readyClient) readyClient.syncDroppedAt = 0;
  maybeStartSyncSession(serverId);
  // the first player to be ready starts the clock for the others
  if (session.phase === 'preparing' && !session.graceTimer) {
    const graceRevision = session.revision;
    session.graceTimer = setTimeout(() => dropSyncStragglers(serverId, graceRevision, `${SYNC_LATE_GRACE_MS}ms after the first player was ready`), SYNC_LATE_GRACE_MS);
  }
}

// a play/pause/seek/skip request from a member. returns what happened
function applySyncCommand(serverId, cmd) {
  const now = Date.now();
  const session = syncSessions.get(serverId);
  const persisted = db.getServerPlayerState(serverId);
  const currentTrackId = session ? session.trackId : (persisted ? persisted.current_track_id : null);
  const livePosition = session ? getSyncPosition(session, now) : Number((persisted && persisted.current_time) || 0);

  // two people finishing the same song at once both ask for the next one, only
  // the first should count. the request says which track it saw end
  if (cmd.auto_advance_from && currentTrackId !== cmd.auto_advance_from) {
    return { ignored: true };
  }

  const trackId = cmd.current_track_id || currentTrackId;
  if (!trackId) return { ignored: true };
  const requestedTime = Number.isFinite(cmd.current_time) && cmd.current_time >= 0 ? cmd.current_time : livePosition;

  if (!cmd.is_playing) {
    clearSyncTimers(session);
    const paused = {
      trackId,
      phase: 'paused',
      position: trackId === currentTrackId ? requestedTime : 0,
      updatedAtMs: now,
      startAtMs: null,
      revision: newSyncRevision(),
      ready: new Set(),
      timer: null
    };
    syncSessions.set(serverId, paused);
    persistSyncSession(serverId, paused);
    broadcastServerPlayerState(serverId);
    return { phase: 'paused' };
  }

  // already playing (or already preparing) this very spot: a repeat of the
  // same request, nothing to redo
  const sameTrack = session && session.trackId === trackId;
  if (sameTrack && session.phase === 'playing' && Math.abs(requestedTime - livePosition) < 1.2) {
    return { noop: true };
  }
  if (sameTrack && session.phase === 'preparing' && Math.abs(requestedTime - session.position) < 1.2) {
    return { noop: true };
  }

  clearSyncTimers(session);
  const preparing = {
    trackId,
    phase: 'preparing',
    position: requestedTime,
    updatedAtMs: now,
    startAtMs: null,
    revision: newSyncRevision(),
    ready: new Set(),
    timer: null,
    graceTimer: null
  };
  preparing.timer = setTimeout(() => dropSyncStragglers(serverId, preparing.revision), SYNC_DROP_AFTER_MS);
  syncSessions.set(serverId, preparing);
  persistSyncSession(serverId, preparing);
  broadcastServerPlayerState(serverId);
  maybeStartSyncSession(serverId); // starts right away when nobody is connected to wait for
  dropUnresponsiveParticipants(serverId, preparing.revision);
  return { phase: 'preparing' };
}

// the song that is playing (or paused on) was taken out of the queue. the room
// must not be left pointing at a song that is gone (every player showed a blank
// record and kept playing it): it moves on to the song that took its place, from
// the start and playing if the room was, or lets go of the player when the queue
// is now empty
function handleCurrentTrackRemoved(serverId, removedTrackId, queueBefore) {
  const session = syncSessions.get(serverId);
  const persisted = db.getServerPlayerState(serverId);
  const currentId = session ? session.trackId : (persisted ? persisted.current_track_id : null);
  if (!currentId || currentId !== removedTrackId) return;
  const queueNow = db.getServerQueue(serverId);
  if (!queueNow.length) {
    resetRoomPlayback(serverId);
    return;
  }
  const index = Math.max(0, queueBefore.findIndex((track) => track.id === removedTrackId));
  const next = queueNow[Math.min(index, queueNow.length - 1)];
  const wasPlaying = Boolean(session && session.phase !== 'paused');
  logToFile(`[SYNC] ${serverId} the playing song was removed, moving on to ${next.id}`);
  applySyncCommand(serverId, { current_track_id: next.id, is_playing: wasPlaying, current_time: 0 });
}

// nothing to play any more (the queue was cleared): the room's player is reset
function resetRoomPlayback(serverId) {
  const session = syncSessions.get(serverId);
  clearSyncTimers(session);
  syncSessions.delete(serverId);
  db.deleteServerPlayerState(serverId);
  broadcastServerPlayerState(serverId);
}

function broadcastServerPlayerState(serverId) {
  broadcastToServer(serverId, {
    type: 'server_player_updated',
    serverId,
    state: getSyncedPlayerState(serverId),
    server_now_ms: Date.now()
  });
}

function broadcastServerMembers(serverId) {
  broadcastToServer(serverId, {
    type: 'server_members_updated',
    serverId,
    members: db.getServerMembers(serverId)
  });
  // a new member needs a copy of the room's key (see roomKeys.js)
  broadcastToServer(serverId, { type: 'room_keys_changed', serverId });
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
  let openable = false;
  wsClients.forEach((candidate) => { if (candidate.ws === ws && candidate.e2e === true) openable = true; });

  sendWs(ws, {
    type: 'initial_state',
    serverId,
    server: buildServerPayload(serverRecord, req, true),
    messages: db.getServerMessages(serverId).map((message) => roomKeys.presentMessage(message, openable)),
    queue: db.getServerQueue(serverId),
    player: getSyncedPlayerState(serverId),
    server_now_ms: Date.now(),
    members: db.getServerMembers(serverId),
    users: getConnectedUsers()
  });
}

function isServerMember(serverId, userId) {
  return db.isServerMember(serverId, userId);
}

function createWebSocketServer(server, sessionMiddleware) {
  // 1MB is plenty for chat and track shares, the default is 100MB
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });

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
      const tokenUserId = authTokens.resolve(sidFromQuery);
      if (tokenUserId) {
        const user = db.getUserById(tokenUserId);
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
          if (!err && session && session.userId && db.getUserById(session.userId)) {
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
      if (!request.session || !request.session.userId || !db.getUserById(request.session.userId)) {
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// request logging. passwords and tokens get redacted before anything is
// written, the log file is readable through the debug console
app.use((req, res, next) => {
  const q = Object.keys(req.query).length ? ` query=${JSON.stringify(validation.redactForLog(req.query))}` : '';
  const b = req.body && Object.keys(req.body).length ? ` body=${JSON.stringify(validation.redactForLog(req.body))}` : '';
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
  // cookie session: make sure the account still exists (it may have been
  // deleted by an admin since login) and pick up its current admin flag
  if (req.session && req.session.userId) {
    const sessionUser = db.getUserById(req.session.userId);
    if (!sessionUser) {
      delete req.session.userId;
      delete req.session.username;
      delete req.session.isAdmin;
    } else {
      req.session.isAdmin = sessionUser.is_admin;
      return next();
    }
  }

  // header values are strings, but a repeated query param shows up as an array
  const rawToken = req.headers['x-auth-token'] || req.query['token'] || req.query['sid'];
  const token = typeof rawToken === 'string' ? rawToken : '';

  if (token) {
    const userId = authTokens.resolve(token);
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
      logToFile(`[AUTH] invalid or expired token: ${token.slice(0, 8)}...`, true);
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

// admin middleware - checks if the user is an admin
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
    const body = req.body || {};

    // the admin names are reserved for whoever claims them first, everything
    // else on the reserved list (null, admin, constructor, ...) is refused
    const usernameCheck = validation.validateNewUsername(body.username, { allowReserved: db.ADMIN_USERNAMES });
    if (!usernameCheck.ok) {
      return res.status(400).json({ error: usernameCheck.error });
    }
    const username = usernameCheck.value;

    const passwordCheck = validation.validateNewPassword(body.password, username);
    if (!passwordCheck.ok) {
      return res.status(400).json({ error: passwordCheck.error });
    }
    const password = passwordCheck.value;

    const limit = registerLimiter.hit(getClientKey(req));
    if (!limit.allowed) {
      return tooManyAttempts(res, limit.retryAfterSec);
    }

    // check if username taken, ignoring case
    if (db.findUserByUsername(username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // create user
    let user;
    try {
      user = db.createUser(username, password);
    } catch (createErr) {
      // two people registering the same name at the same moment
      if (String(createErr.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      throw createErr;
    }

    // create session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;

    // create db session record
    db.createUserSession(user.id, req.sessionID);
    db.setOnlineStatus(user.id);

    logToFile(`[AUTH] User registered: ${username}`);
    const authToken = authTokens.issue(user.id);
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
    const fields = validation.readLoginFields(req.body);
    if (!fields.ok) {
      return res.status(400).json({ error: fields.error });
    }
    const { username, password } = fields;

    const clientKey = getClientKey(req);
    const ipLimit = loginIpLimiter.hit(clientKey);
    if (!ipLimit.allowed) {
      return tooManyAttempts(res, ipLimit.retryAfterSec);
    }
    const attemptKey = `${clientKey}|${username.toLowerCase()}`;
    const attemptLimit = loginAttemptLimiter.hit(attemptKey);
    if (!attemptLimit.allowed) {
      return tooManyAttempts(res, attemptLimit.retryAfterSec);
    }

    const user = db.authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    loginAttemptLimiter.reset(attemptKey);

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

    logToFile(`[AUTH] User logged in: ${user.username} (previous sessions terminated)`);
    const authToken = authTokens.issue(user.id);
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

  // the token has to die too or it keeps working after logout
  const rawToken = req.headers['x-auth-token'];
  if (typeof rawToken === 'string') {
    authTokens.revoke(rawToken);
  }

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

// every device a person is signed in on hears about a change the moment it is
// saved, so a song added on the phone is on the computer a beat later. the app
// that made the change hears it as well and skips it by its client id.
// announcements only go out when the content really changed, otherwise two
// devices saving the same data back and forth would announce forever. what is
// compared is a short signature, not the rows, because every save rewrites the
// track rows under new ids
const accountDataSignatures = new Map(); // `${userId}:${scope}` -> signature last announced

function accountDataSignature(userId, scope) {
  if (scope === 'playlists') {
    return JSON.stringify(db.getUserPlaylists(userId).map((p) => [p.id, p.name, p.tracks.map((t) => t.videoId)]));
  }
  if (scope === 'queue') {
    return JSON.stringify(db.getUserQueue(userId).map((t) => t.videoId));
  }
  const s = db.getSettings(userId);
  return JSON.stringify([s.theme_color_r, s.theme_color_g, s.theme_color_b, s.debug_mode, s.hide_listening]);
}

function announceAccountChange(userId, scope, req) {
  try {
    const signature = crypto.createHash('sha1').update(accountDataSignature(userId, scope)).digest('hex');
    const key = `${userId}:${scope}`;
    if (accountDataSignatures.get(key) === signature) return;
    accountDataSignatures.set(key, signature);
    const origin = String(req.get('x-client-id') || '').slice(0, 64);
    broadcastWs({ type: 'account_data_changed', scope, origin }, (client) => client.userId === userId);
  } catch (error) {
    logToFile(`[ACCOUNT SYNC] announce failed: ${error.message}`, true);
  }
}

app.use('/api/user', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.session || !req.session.userId) return;
    const path = req.originalUrl || '';
    const scope = path.startsWith('/api/user/settings') ? 'settings'
      : path.startsWith('/api/user/queue') ? 'queue'
        : path.startsWith('/api/user/playlists') ? 'playlists' : null;
    if (scope) announceAccountChange(req.session.userId, scope, req);
  });
  next();
});

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
        debug_mode: settings.debug_mode === 1,
        hide_listening: settings.hide_listening === 1
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
    const { theme_color_r, theme_color_g, theme_color_b, debug_mode, hide_listening } = req.body;
    const wasHidden = isListeningHidden(req.session.userId);
    db.saveSettings(req.session.userId, {
      theme_color_r,
      theme_color_g,
      theme_color_b,
      debug_mode,
      hide_listening
    });
    // everyone sees the change straight away, not at the next song
    hiddenListeningCache.delete(req.session.userId);
    if (isListeningHidden(req.session.userId) !== wasHidden) broadcastPresence();
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
    const nameCheck = validation.cleanText((req.body || {}).name, { field: 'Playlist name', max: 100 });
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const name = nameCheck.value;
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
    const { id } = req.params;
    const nameCheck = validation.cleanText((req.body || {}).name, { field: 'Playlist name', max: 100 });
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const name = nameCheck.value;
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
    // only the owner can touch a playlist's tracks
    if (!db.getPlaylistById(playlistId, req.session.userId)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
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
    if (!db.getPlaylistById(id, req.session.userId)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
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
    const { playlists: rawPlaylists } = req.body || {};
    if (!Array.isArray(rawPlaylists)) {
      return res.status(400).json({ error: 'Playlists must be an array' });
    }

    // clean the names, and only keep ids that look like ids. a bad name just
    // falls back to a default instead of failing the whole sync
    const playlists = rawPlaylists
      .filter((playlist) => playlist && typeof playlist === 'object')
      .map((playlist) => {
        const nameCheck = validation.cleanText(playlist.name, { field: 'Playlist name', max: 100 });
        return {
          ...playlist,
          id: validation.cleanClientId(playlist.id) || undefined,
          name: nameCheck.ok ? nameCheck.value : 'untitled playlist'
        };
      });

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

// what happens to a channel's collab playlists reaches everyone in the channel
// right away. the apps used to tell each other over the websocket, which the
// server never passed on, so the other members saw nothing until they rejoined
function broadcastCollab(serverId, payload) {
  if (globalWss) broadcastToServer(serverId, { ...payload, serverId });
}

// create a collab playlist
app.post('/api/servers/:serverId/collab-playlists', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const body = req.body || {};

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to create collab playlists' });
    }

    const nameCheck = validation.cleanText(body.name, { field: 'Playlist name', max: 100 });
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const name = nameCheck.value;
    // the client picks the id so it can show the playlist right away, but it
    // has to be a plain id. the creator is always whoever is logged in, a
    // client supplied createdBy used to let anyone credit someone else
    const id = validation.cleanClientId(body.id) || `collab_${crypto.randomUUID()}`;

    let playlist;
    try {
      playlist = db.createCollabPlaylist(id, serverId, name, req.session.userId);
    } catch (createErr) {
      if (String(createErr.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'Playlist id already in use' });
      }
      throw createErr;
    }
    logToFile(`[COLLAB PLAYLISTS] Created "${name}" in server ${serverId} by ${req.session.username}`);
    broadcastCollab(serverId, {
      type: 'collab_playlist_created',
      playlist: { id: playlist.id, name: playlist.name, tracks: [], createdBy: req.session.userId, createdAt: Date.now() }
    });
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

    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to rename collab playlists' });
    }

    const nameCheck = validation.cleanText((req.body || {}).name, { field: 'Playlist name', max: 100 });
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }

    db.updateCollabPlaylistName(playlistId, serverId, nameCheck.value);
    broadcastCollab(serverId, { type: 'collab_playlist_renamed', playlistId, name: nameCheck.value });
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
    broadcastCollab(serverId, { type: 'collab_playlist_deleted', playlistId });
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

    const videoId = track && (track.video_id || track.videoId);
    if (!videoId || !track.title) {
      return res.status(400).json({ error: 'A track needs a video id and a title' });
    }
    if (String(videoId).startsWith('local:') || track.source === 'local') {
      if (!roomFiles.enabled) return res.status(400).json({ error: 'audio files cannot be shared in a room on this server' });
      if (!roomFiles.has(serverId, String(videoId))) return res.status(409).json({ error: 'the file of this song is not on the server, send it first' });
    }
    const trackId = `cpt_${crypto.randomUUID()}`;
    const newTrack = db.addTrackToCollabPlaylist(
      trackId, playlistId, videoId, track.title, track.author,
      track.format || 'mp3', track.source || 'youtube', track.thumbnail, track.external_url || track.externalUrl,
      track.duration_ms || track.durationMs || 0, req.session.userId
    );
    broadcastCollab(serverId, { type: 'collab_playlist_track_added', playlistId, track: newTrack });

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
    broadcastCollab(serverId, { type: 'collab_playlist_track_removed', playlistId, trackId });
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
    broadcastCollab(serverId, { type: 'collab_playlist_cleared', playlistId });
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Clear error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to clear collab playlist' });
  }
});

// add many tracks at once (the whole room queue, say)
app.post('/api/servers/:serverId/collab-playlists/:playlistId/tracks-bulk', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId } = req.params;
    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to add tracks' });
    }
    const playlist = db.getCollabPlaylist(playlistId, serverId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    const list = Array.isArray((req.body || {}).tracks) ? req.body.tracks.slice(0, 200) : [];
    const added = [];
    list.forEach((track) => {
      const videoId = track && (track.video_id || track.videoId);
      if (!videoId || !track.title) return;
      // a song of a file needs its file in the room, the others of the list go in all the same
      if ((String(videoId).startsWith('local:') || track.source === 'local') && !(roomFiles.enabled && roomFiles.has(serverId, String(videoId)))) return;
      added.push(db.addTrackToCollabPlaylist(
        `cpt_${crypto.randomUUID()}`, playlistId, videoId, track.title, track.author,
        track.format || 'mp3', track.source || 'youtube', track.thumbnail, track.external_url || track.externalUrl,
        track.duration_ms || track.durationMs || 0, req.session.userId
      ));
    });
    if (added.length) broadcastCollab(serverId, { type: 'collab_playlist_tracks_added', playlistId, tracks: added });
    res.json({ ok: true, tracks: added });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Bulk add error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to add tracks to collab playlist' });
  }
});

// put the tracks of a collab playlist in a new order
app.put('/api/servers/:serverId/collab-playlists/:playlistId/order', requireAuth, (req, res) => {
  try {
    const { serverId, playlistId } = req.params;
    const member = db.getServerMember(serverId, req.session.userId);
    if (!member) {
      return res.status(403).json({ error: 'Must be a server member to reorder tracks' });
    }
    if (!db.getCollabPlaylist(playlistId, serverId)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    const ids = Array.isArray((req.body || {}).trackIds) ? req.body.trackIds.filter((id) => typeof id === 'string').slice(0, 1000) : [];
    db.reorderCollabPlaylist(playlistId, ids);
    broadcastCollab(serverId, { type: 'collab_playlist_reordered', playlistId, trackIds: ids });
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[COLLAB PLAYLISTS] Reorder error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to reorder collab playlist' });
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

// yt-dlp work for a track (stream, download, info, search, playlist) belongs on
// the user's own machine, through the local helper, because youtube blocks
// datacenter ips and every request here costs the host cpu, disk and a ban
// risk. so these endpoints only answer requests from the same machine or the
// same home network. set DISABLE_MEDIA_ENDPOINTS=1 on a hosted server to turn
// them off completely
const MEDIA_API_PATHS = new Set(['/api/stream', '/api/download', '/api/info', '/api/search', '/api/playlist']);
app.use((req, res, next) => {
  if (!MEDIA_API_PATHS.has(req.path) || req.method === 'OPTIONS') return next();
  if (process.env.DISABLE_MEDIA_ENDPOINTS === '1' || !validation.isPrivateNetworkRequest(req)) {
    return res.status(403).json({ error: 'Audio is handled by the local helper on your own computer, not by this server' });
  }
  next();
});

const fullServerMedia = createMediaTools({ ytdlp, log: (message) => logToFile(`[MEDIA] ${message}`) });
fullServerMedia.sweepLeftoverDownloads(path.join(APP_DATA_DIR, 'temp_audio'));

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
    fullServerMedia.noteYoutubeFailure(error);
    fullServerMedia.sendYoutubeError(res, error, 'Failed to fetch video info');
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
  // the id goes straight into a url, so keep it to the characters real ids use
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(playlistId)) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
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
    logToFile(`Playlist fetch failed for ${playlistId}: ${error.message}`, true);
    fullServerMedia.noteYoutubeFailure(error);
    fullServerMedia.sendYoutubeError(res, error, `Playlist fetch failed for ${playlistId}`);
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

  // app data dir, not next to the code: once installed the code lives in
  // program files where a normal user account cant write
  const downloadsDir = path.join(APP_DATA_DIR, 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // working filename is keyed by videoId, NOT the (user-supplied,
  // title-based) display name - two different tracks can sanitize down to
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

  // same cache folder the helper uses, and a writable one once installed
  const tempDir = path.join(APP_DATA_DIR, 'temp_audio');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const audioFile = path.join(tempDir, `${videoId}.m4a`);

  try {
    // a cached file only counts if it is whole, a truncated one gets redone
    if (fs.existsSync(audioFile) && !fullServerMedia.isCompleteAudioFile(audioFile)) {
      logToFile('[Stream] Cached file is incomplete, discarding it');
      try { fs.unlinkSync(audioFile); } catch {}
    }

    // download audio if not already cached (written under a temp name and
    // moved into place when finished, so a half written file is never served)
    if (!fs.existsSync(audioFile)) {
      logToFile('[Stream] Downloading audio to temp file...');
      await fullServerMedia.downloadToCache(videoId, audioFile);
      logToFile(`[Stream] Audio downloaded to ${audioFile}`);
    }

    fullServerMedia.serveLocalFile(req, res, audioFile, 'audio/m4a', {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range'
    });
  } catch (error) {
    logToFile(`[Stream] Streaming error: ${error.message}`, true);
    if (!res.headersSent) {
      fullServerMedia.sendYoutubeError(res, error, 'Streaming failed');
    } else {
      res.destroy();
    }
  }
});

// global error handler - must be before static files but after routes
app.use((err, req, res, next) => {
  logToFile(`[ERROR] Unhandled error: ${err.message}`, true);
  logToFile(`[ERROR] Stack: ${err.stack}`, true);
  logToFile(`[ERROR] Path: ${req.method} ${req.path}`, true);

  // dont send html - always json for api routes
  if (req.path.startsWith('/api/')) {
    // a malformed or oversized body is the client's fault, not a server error
    // (body-parser tags these with a 4xx status)
    const clientStatus = Number(err.status || err.statusCode);
    if (clientStatus >= 400 && clientStatus < 500) {
      const message = clientStatus === 413 ? 'Request body too large' : 'Invalid request body';
      return res.status(clientStatus).json({ error: message });
    }
    // the raw error message can name files and internals, dev only
    const body = { error: 'Internal server error' };
    if (!IS_PRODUCTION) body.details = err.message;
    res.status(500).json(body);
  } else {
    next();
  }
});

// serve react static files - note: catch-all moved to end
const resolvedBuildPath = projectPath('build');

// the screens can be replaced by a newer signed bundle from the club server without
// a new installer (see updates.js). on the installed app this decides whether the
// files that came with it or a downloaded newer set are served
const uiUpdates = require('./updates');
let installerVersion = '0.0.0';
try { installerVersion = JSON.parse(fs.readFileSync(projectPath('package.json'), 'utf8')).version || installerVersion; } catch { /* unknown */ }
const uiUpdater = createUiUpdater();
function createUiUpdater() {
  try {
    return uiUpdates.createUpdater({ appDataDir: APP_DATA_DIR, bundledDir: resolvedBuildPath, shellVersion: installerVersion, log: (message) => logToFile(message) });
  } catch (error) {
    logToFile(`[UPDATE] updater not available: ${error.message}`, true);
    return null;
  }
}
const bundledStatic = express.static(resolvedBuildPath);
let downloadedStatic = null;
let downloadedStaticDir = null;
function activeBuildDir() {
  return uiUpdater ? uiUpdater.activeDir() : resolvedBuildPath;
}
if (fs.existsSync(resolvedBuildPath)) {
  app.use((req, res, next) => {
    const dir = activeBuildDir();
    if (dir === resolvedBuildPath) return bundledStatic(req, res, next);
    if (downloadedStaticDir !== dir) {
      downloadedStatic = express.static(dir);
      downloadedStaticDir = dir;
    }
    return downloadedStatic(req, res, next);
  });
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

// add version endpoint. `ui` is the version of the screens being served, which on
// an installed app can be newer than `version` (the installer's own)
app.get('/api/version', (req, res) => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(projectPath('package.json'), 'utf8'));
    res.json({ version: packageJson.version, ui: uiUpdater ? uiUpdater.uiVersion() : packageJson.version });
  } catch (err) {
    res.status(500).json({ error: 'Could not read version' });
  }
});

// ---- updates of the screens
// the club server publishes them: update-files/manifest.json (signed) and the files
// themselves under update-files/ui/. nothing is published when the folder is missing
const updateFilesDir = projectPath('update-files');
app.get('/api/update/manifest', (req, res) => {
  const manifestFile = path.join(updateFilesDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return res.status(404).json({ error: 'No update published' });
  res.set('Cache-Control', 'no-store');
  res.type('json').send(fs.readFileSync(manifestFile, 'utf8'));
});
app.use('/api/update/ui', express.static(path.join(updateFilesDir, 'ui'), { index: false, dotfiles: 'deny', maxAge: 0 }));

// an installed app asks its own server (this machine only) what is on offer and
// has it fetched. a hosted server never does this for itself
function updateAllowedHere(req) {
  return Boolean(uiUpdater) && process.env.DISABLE_MEDIA_ENDPOINTS !== '1' && validation.isLocalRequest(req);
}
app.get('/api/update/status', async (req, res) => {
  if (!updateAllowedHere(req)) return res.status(403).json({ error: 'Not available here' });
  try {
    res.json({ ok: true, ...(await uiUpdater.check(req.query.force === '1')), canInstall: Boolean(updateInstaller && updateInstaller.available) });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not reach the update server' });
  }
});
// the installed app can also download a newer installer, check it against the signed manifest and
// run it (see installer.js). only from a page on this computer: the window of the app, never
// another website that happens to reach this port
const updateInstallers = require('./installer');
const updateInstaller = uiUpdater
  ? updateInstallers.createInstaller({
    dataDir: APP_DATA_DIR,
    installDir: path.dirname(process.execPath),
    appPid: process.ppid,
    shellVersion: installerVersion,
    getManifest: () => uiUpdater.manifest(),
    log: (message, isError) => logToFile(message, isError),
    // SMP_INSTALLER_URL_PREFIX and SMP_UPDATE_DRY_RUN are for testing: another address to accept
    // the installer from, and downloading it without closing the app
    prefixes: process.env.SMP_INSTALLER_URL_PREFIX ? process.env.SMP_INSTALLER_URL_PREFIX.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
    dryRun: process.env.SMP_UPDATE_DRY_RUN === '1'
  })
  : null;
function installAllowedHere(req) {
  if (!updateInstaller || !updateAllowedHere(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'tauri.localhost';
  } catch {
    return false;
  }
}
app.post('/api/update/install', (req, res) => {
  if (!installAllowedHere(req)) return res.status(403).json({ error: 'Not available here' });
  try {
    updateInstaller.start();
    res.json({ ok: true });
  } catch (error) {
    res.status(error.code === 'busy' || error.code === 'not_installed' ? 409 : 500).json({ ok: false, code: error.code || 'failed', error: error.message || 'Could not start' });
  }
});
app.get('/api/update/install-state', (req, res) => {
  if (!installAllowedHere(req)) return res.status(403).json({ error: 'Not available here' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ...updateInstaller.status() });
});
app.post('/api/update/apply', async (req, res) => {
  if (!updateAllowedHere(req)) return res.status(403).json({ error: 'Not available here' });
  try {
    const result = await uiUpdater.apply();
    res.json({ ok: true, version: result.version });
  } catch (error) {
    logToFile(`[UPDATE] apply failed: ${error.message}`, true);
    const status = error.code === 'needs_installer' ? 409 : error.code === 'up_to_date' ? 200 : 502;
    res.status(status).json({ ok: error.code === 'up_to_date', code: error.code || 'failed', error: error.message || 'Update failed' });
  }
});

// ---- Discord rich presence (the desktop app only, see discord.js). what is playing shows on
// the Discord running on this same computer. a hosted server never does this, and a web page
// from somewhere else can not set what a person's profile says
// SMP_DISCORD_CLIENT_ID and SMP_DISCORD_IPC replace the built in application id and the pipe, for testing
const discordModule = require('./discord');
const discordPresence = discordModule.createPresence({
  clientId: process.env.SMP_DISCORD_CLIENT_ID || discordModule.DEFAULT_CLIENT_ID,
  ipcPaths: process.env.SMP_DISCORD_IPC ? [process.env.SMP_DISCORD_IPC] : null,
  log: (message) => logToFile(message)
});
function discordAllowedHere(req) {
  if (process.env.DISABLE_MEDIA_ENDPOINTS === '1' || !validation.isLocalRequest(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}
app.get('/api/discord/status', (req, res) => {
  if (!discordAllowedHere(req)) return res.json({ available: false });
  res.json(discordPresence.status());
});
app.post('/api/discord/activity', (req, res) => {
  if (!discordAllowedHere(req) || !discordPresence.available) return res.status(403).json({ error: 'Not available here' });
  const body = req.body || {};
  res.json({ ok: body.clear ? discordPresence.clear() : discordPresence.update(body) });
});

// used to decide whether to show the first-run welcome dialog - a genuinely
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

// temp diagnostic: plain http endpoint, no tauri ipc involved at all -
// isolates "does frontend js even execute in the native window" from every
// other layer of uncertainty (invoke, __TAURI__ global, event bus, etc)
app.post('/api/debug-log', (req, res) => {
  // only the desktop shell on this machine ever calls this
  if (!validation.isLocalRequest(req)) {
    return res.status(403).json({ error: 'Local requests only' });
  }
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

const USERNAME_SEARCH_MAX = 40;

// user search endpoint - search users by username
app.get('/api/users/search', requireAuth, (req, res) => {
  try {
    const query = req.query.q;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const normalized = query.trim().toLowerCase().slice(0, USERNAME_SEARCH_MAX);
    if (normalized.length === 0) {
      return res.json({ users: [] });
    }

    // grab all users from db and filter by username, capped so a one letter
    // search on a big server doesnt send back everyone
    const allUsers = db.db.prepare('SELECT id, username FROM users').all();
    const matchingUsers = allUsers
      .filter(user => user.username.toLowerCase().includes(normalized))
      .slice(0, 25)
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
          userThemeColors[u.id] = themeColorOf(settings);
        }
      } catch {}
    });

    // slap online status + theme color onto every user
    // when somebody was last seen is for an admin and for their friends to know, nobody else gets it for the ones who are offline
    const isAdminRequest = Boolean(db.getUserById(req.session.userId)?.is_admin);
    const friendIds = db.friendIdsOf(req.session.userId);
    const lastSeenAll = new Map(db.getAllOnlineStatus().map((row) => [row.user_id, row.last_seen]));
    const usersWithKeys = new Set(db.userIdsWithKeys());
    const usersWithStatus = allUsers.map((u) => {
      const livePresence = presenceMap.get(u.id);
      const onlineStatus = onlineStatusMap.get(u.id);
      const isOnline = Boolean(livePresence || onlineIds.has(u.id));

      return {
        ...u,
        is_online: isOnline,
        current_server_id: livePresence?.current_server_id || onlineStatus?.current_server_id || null,
        last_seen: onlineStatus?.last_seen || ((isAdminRequest || friendIds.has(u.id)) ? (lastSeenAll.get(u.id) || null) : null),
        is_friend: friendIds.has(u.id),
        has_e2e: usersWithKeys.has(u.id),
        listening_to: livePresence?.listening_to || null,
        platforms: livePresence?.platforms || [],
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
app.delete('/api/users/:userId', requireAuth, requireAdmin, (req, res) => {
  try {

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
    authTokens.revokeUser(userId);
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
const friendRequestLimiter = validation.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 40 });
app.post('/api/friends/request', requireAuth, (req, res) => {
  try {
    const { receiverId } = req.body;
    if (!receiverId) {
      return res.status(400).json({ error: 'receiverId required' });
    }

    if (receiverId === req.session.userId) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    }

    if (!db.getUserById(receiverId)) {
      return res.status(404).json({ error: 'User not found' });
    }
    const limit = friendRequestLimiter.hit(req.session.userId);
    if (!limit.allowed) {
      return tooManyAttempts(res, limit.retryAfterSec);
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
    if (result.auto_accepted) {
      // they had asked first, so this is a yes
      sendToUser(receiverId, { type: 'friend_accepted', from: req.session.username, from_id: req.session.userId });
    } else {
      sendToUser(receiverId, { type: 'friend_request_received', from: req.session.username, from_id: req.session.userId, request_id: result.id });
    }
    res.json({ ok: true, request: result, auto_accepted: Boolean(result.auto_accepted) });
  } catch (error) {
    logToFile(`[FRIENDS] Send request error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

// get pending friend requests
app.get('/api/friends/requests', requireAuth, (req, res) => {
  try {
    const requests = db.getPendingFriendRequests(req.session.userId);
    // the ones this person sent and nobody answered yet
    const sent = db.getSentFriendRequests(req.session.userId);
    res.json({ ok: true, requests, sent });
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
    if (result.request) {
      sendToUser(result.request.sender_id, { type: 'friend_accepted', from: req.session.username, from_id: receiverId });
    }
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

// take back a request that was sent
app.delete('/api/friends/requests/:id', requireAuth, (req, res) => {
  try {
    const result = db.cancelFriendRequest(req.params.id, req.session.userId);
    if (result.error === 'forbidden') {
      return res.status(403).json({ error: 'You can only take back your own requests' });
    }
    if (result.error) {
      return res.status(404).json({ error: 'Friend request not found' });
    }
    sendToUser(result.request.receiver_id, { type: 'friend_request_cancelled', from_id: req.session.userId, request_id: req.params.id });
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[FRIENDS] Cancel request error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to take the request back' });
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
    sendToUser(friendId, { type: 'friend_removed', from_id: req.session.userId });
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[FRIENDS] Remove friend error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// direct messaging

// get conversation list
// ---- listening stats: what an account has listened to, for that account (and a friends list for comparing)
const STATS_RANGES = ['week', 'month', 'year', 'all'];
app.get('/api/stats', requireAuth, (req, res) => {
  try {
    const range = STATS_RANGES.includes(req.query.range) ? req.query.range : 'week';
    flushListening(req.session.userId);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, stats: db.getListeningStats(req.session.userId, { range, offsetMin: Number(req.query.tz) || 0 }) });
  } catch (error) {
    logToFile(`[STATS] Get stats error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get your stats' });
  }
});

// how much the person and their friends listened in a range. a friend who keeps their listening to themselves is not in it
app.get('/api/stats/friends', requireAuth, (req, res) => {
  try {
    const range = STATS_RANGES.includes(req.query.range) ? req.query.range : 'week';
    const me = req.session.userId;
    flushListening();
    const friends = db.getFriends(me).filter((friend) => !isListeningHidden(friend.friend_id));
    const names = new Map(friends.map((friend) => [friend.friend_id, friend.username]));
    names.set(me, req.session.username);
    const board = db.getListeningBoard([...names.keys()], { range, offsetMin: Number(req.query.tz) || 0 })
      .map((row) => ({ ...row, username: names.get(row.user_id), me: row.user_id === me }));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, range, board });
  } catch (error) {
    logToFile(`[STATS] Get friends board error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get the list' });
  }
});

// ---- connected YouTube and Spotify accounts: exporting playlists to them, reading a Spotify playlist (see integrations.js)
require('./integrations').createIntegrations({ app, db, requireAuth, validation, logToFile, getPublicAppUrl });

// ---- audio files that people add to a room from their own device, kept in memory only for as long as the room needs them.
// off unless SMP_ROOM_FILES=1 (see roomFiles.js)
const roomFiles = require('./roomFiles').createRoomFiles({
  isServerMember,
  getQueueFileIds: (serverId) => {
    const ids = db.getServerQueue(serverId).map((track) => track.videoId || track.video_id).filter(Boolean);
    // the songs of the shared playlists of the room keep their files too
    db.getCollabPlaylists(serverId).forEach((playlist) => {
      db.getCollabPlaylistTracks(playlist.id).forEach((track) => { if (track.video_id) ids.push(track.video_id); });
    });
    return ids;
  },
  isRoomOccupied: (serverId) => [...wsClients.values()].some((client) => client.serverId === serverId),
  logToFile
});
roomFiles.register(app, requireAuth);

// ---- end to end encrypted room chat: the keys of a room and the rules for its messages (see roomKeys.js)
const roomKeys = require('./roomKeys').createRoomKeys({ app, db, requireAuth, validation, logToFile, isServerMember, broadcastToServer, wsClients, sendWs });

// ---- the spotify helper sends the long playlists it read to the person's account (see helperImport.js)
require('./helperImport').createHelperImport({ app, db, requireAuth, validation, logToFile, sendToUser, themeColorOf, loginIpLimiter, loginAttemptLimiter, getClientKey, tooManyAttempts });

// ---- end to end encrypted direct messages
// the apps lock a message with a key only the two people have, the server stores and passes on what it can not read.
// each account has one key pair: the public half is handed to anyone who wants to write to the person, the private
// half is stored locked with the person's password by the app (the server keeps the locked blob, it can not open it).
// an app older than this has no idea what a locked message is, so it is handed a note instead of the gibberish
const E2E_NOTE = '[private message, update the app to read it]';
const wantsE2e = (req) => req.headers['x-smp-e2e'] === '1';
function presentDirectMessage(message, canOpen) {
  if (canOpen || !message || !db.atRest.isEnvelope(message.message)) return message;
  return { ...message, message: E2E_NOTE };
}
const ENVELOPE_PATTERN = /^e2e1:[A-Za-z0-9+/=_-]{16,16000}$/;

function publicKeyOf(userId) {
  const key = db.getUserKey(userId);
  return key ? { public_key: key.public_key, kid: key.kid } : null;
}

// the person's own key (public half and the locked private half)
app.get('/api/e2e/key', requireAuth, (req, res) => {
  const key = db.getUserKey(req.session.userId);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    key: key ? { public_key: key.public_key, kid: key.kid, wrapped_private: key.wrapped_private, wrap_salt: key.wrap_salt, wrap_iv: key.wrap_iv, wrap_iters: key.wrap_iters } : null
  });
});

// the first device of an account makes the key and stores it here. there is no way to replace a key that exists
// (two devices making one at the same moment end up with the first one, the second gets it back in the answer)
app.put('/api/e2e/key', requireAuth, (req, res) => {
  const body = req.body || {};
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  let jwk = null;
  try { jwk = JSON.parse(body.public_key); } catch { jwk = null; }
  const validKey = jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && text(jwk.x, 64) && text(jwk.y, 64) && !jwk.d;
  const iters = Number(body.wrap_iters);
  if (!validKey || !text(body.kid, 64) || !text(body.wrapped_private, 4096) || !text(body.wrap_salt, 128) || !text(body.wrap_iv, 64) || !Number.isInteger(iters) || iters < 100000 || iters > 5000000) {
    return res.status(400).json({ error: 'That key is not valid' });
  }
  const created = db.createUserKey(req.session.userId, {
    public_key: body.public_key, kid: body.kid, wrapped_private: body.wrapped_private, wrap_salt: body.wrap_salt, wrap_iv: body.wrap_iv, wrap_iters: iters
  });
  const key = db.getUserKey(req.session.userId);
  res.json({
    ok: true,
    created,
    key: { public_key: key.public_key, kid: key.kid, wrapped_private: key.wrapped_private, wrap_salt: key.wrap_salt, wrap_iv: key.wrap_iv, wrap_iters: key.wrap_iters }
  });
});

// the public key of somebody, or none when that person has not turned private messages on (their app is older)
app.get('/api/e2e/public/:userId', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, key: publicKeyOf(req.params.userId) });
});

app.get('/api/messages/conversations', requireAuth, (req, res) => {
  try {
    const canOpen = wantsE2e(req);
    const conversations = db.getConversations(req.session.userId)
      .map((entry) => (canOpen || !db.atRest.isEnvelope(entry.last_message) ? entry : { ...entry, last_message: E2E_NOTE }));
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
    const canOpen = wantsE2e(req);
    const messages = db.getDirectMessages(uid, userId, userId, uid).map((entry) => presentDirectMessage(entry, canOpen));
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
    const { message, text, sender_theme_color } = req.body || {};

    const targetUser = db.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // a message made by an app that knows end to end encryption arrives as an envelope the server can not read
    const raw = String(message || text || '');
    const senderKey = db.getUserKey(req.session.userId);
    const receiverKey = db.getUserKey(userId);
    let content;
    if (raw.startsWith('e2e1:')) {
      if (!ENVELOPE_PATTERN.test(raw)) return res.status(400).json({ error: 'That message is not valid' });
      if (!senderKey || !receiverKey) return res.status(400).json({ error: 'Both people need private messages turned on', code: 'e2e_missing_key' });
      // the envelope says which keys it was made with (not secret), they have to be the two people's
      try {
        const head = JSON.parse(Buffer.from(raw.slice(5), 'base64').toString('utf8'));
        if (head.s !== senderKey.kid || head.r !== receiverKey.kid) return res.status(400).json({ error: 'That message was made with the wrong keys', code: 'e2e_wrong_key' });
      } catch {
        return res.status(400).json({ error: 'That message is not valid' });
      }
      content = raw;
    } else {
      // plain text is only for two people whose apps do not know about private messages yet. once either has
      // them on (or the server is told to require them) a plain message is refused
      if (process.env.SMP_REQUIRE_E2E === '1' || senderKey || receiverKey) {
        return res.status(400).json({ error: 'Messages are private now, update the app to send one', code: 'e2e_required' });
      }
      const contentCheck = validation.cleanText(raw, { field: 'Message', max: 2000, multiline: true });
      if (!contentCheck.ok) {
        return res.status(400).json({ error: contentCheck.error });
      }
      content = contentCheck.value;
    }

    const msg = db.createDirectMessage(req.session.userId, req.session.username, userId, targetUser.username, content, sender_theme_color || null);

    // ping the recipient (and the sender's other devices) over ws if they are online. an app that does not know
    // private messages gets the note instead of the ciphertext
    if (globalWss) {
      wsClients.forEach((client) => {
        if (client.userId !== userId && client.userId !== req.session.userId) return;
        sendWs(client.ws, { type: 'direct_message', message: presentDirectMessage(msg, client.e2e === true) });
      });
    }

    res.json({ ok: true, message: presentDirectMessage(msg, wantsE2e(req)) });
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
    const serversWithDetails = buildServerListPayload(servers, req, req.session.userId);
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
    const nameCheck = validation.cleanText((req.body || {}).name, { field: 'Server name', max: 50 });
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const name = nameCheck.value;

    const wsPort = activeWsPort;
    const body = req.body || {};
    const isPrivate = body.isPrivate === true || body.isPrivate === 1 || body.isPrivate === '1' || body.isPrivate === 'true';
    const server = db.createActiveServer(name, req.session.userId, req.session.username, wsPort, isPrivate);
    logToFile(`[SERVERS] ${isPrivate ? 'Private server' : 'Server'} created: ${name} by ${req.session.username}`);

    // let ws clients know theres a new server. everyone is told about it, so the
    // join code of a private one is left out of what is broadcast
    if (globalWss) {
      broadcastWs({
        type: 'server_created',
        server: buildServerPayload(server, req)
      });
    }

    // the host gets it with the code in it
    res.json({ ok: true, server: buildServerPayload(server, req, req.session.userId) });
  } catch (error) {
    logToFile(`[SERVERS] Create server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

// guessing codes: a handful of tries, then wait
const joinCodeLimiter = validation.createRateLimiter({ windowMs: 10 * 60 * 1000, max: 12 });

// put the signed in user into a server (the checks on who may are done by the caller)
function joinServerAsUser(req, res, server) {
  const serverId = server.id;
  try {
    // the host comes back as an admin
    const member = db.addServerMember(serverId, req.session.userId, req.session.username, server.host_id === req.session.userId ? 1 : 0);
    if (member.error) {
      return res.status(400).json({ error: 'Already a member of this server' });
    }

    // update online status with the current server
    db.updateOnlineServer(req.session.userId, serverId);
    setClientServerForUser(req.session.userId, serverId);

    db.clearRoomInvites(serverId, req.session.userId);
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
      server: buildServerPayload(server, req, true)
    });
  } catch (error) {
    logToFile(`[SERVERS] Join server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to join server' });
  }
}

// join server. a private one needs its code, unless you are in it already
app.post('/api/servers/:serverId/join', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const server = db.getActiveServerById(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // a private one needs its code, the host who stepped out of it does not
    if (server.is_private && server.host_id !== req.session.userId && !db.isServerMember(serverId, req.session.userId) && !db.hasRoomInvite(serverId, req.session.userId)) {
      const limit = joinCodeLimiter.hit(`${req.session.userId}:${getClientKey(req)}`);
      if (!limit.allowed) {
        return tooManyAttempts(res, limit.retryAfterSec);
      }
      const given = String((req.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const real = String(server.join_code || '').toUpperCase();
      if (!given || !real || given !== real) {
        return res.status(403).json({ error: 'This server is private. Enter its code to join.', needs_code: true });
      }
    }

    return joinServerAsUser(req, res, server);
  } catch (error) {
    logToFile(`[SERVERS] Join server error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to join server' });
  }
});

// join with just a code, without picking the channel from the directory first
app.post('/api/servers/join-code', requireAuth, (req, res) => {
  try {
    const limit = joinCodeLimiter.hit(`${req.session.userId}:${getClientKey(req)}`);
    if (!limit.allowed) {
      return tooManyAttempts(res, limit.retryAfterSec);
    }
    const server = db.getActiveServerByJoinCode((req.body || {}).code);
    if (!server) {
      return res.status(404).json({ error: 'No server has that code' });
    }
    const full = db.getActiveServerById(server.id);
    if (db.isServerMember(server.id, req.session.userId)) {
      return res.json({ ok: true, alreadyMember: true, server: buildServerPayload(full, req, true) });
    }
    return joinServerAsUser(req, res, full);
  } catch (error) {
    logToFile(`[SERVERS] Join by code error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to join server' });
  }
});

// a member asks a friend to come to the room. the invite also lets the friend into a private room without its code
const inviteLimiter = validation.createRateLimiter({ windowMs: 60 * 1000, max: 12 });
app.post('/api/servers/:serverId/invite', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const me = req.session.userId;
    const toId = String((req.body || {}).userId || '');
    const limit = inviteLimiter.hit(me);
    if (!limit.allowed) {
      return tooManyAttempts(res, limit.retryAfterSec);
    }
    const server = db.getActiveServerById(serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    if (!db.isServerMember(serverId, me)) {
      return res.status(403).json({ error: 'Only people in the room can invite' });
    }
    if (!toId || toId === me) {
      return res.status(400).json({ error: 'Pick a friend to invite' });
    }
    if (!db.getUserById(toId)) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!db.isFriend(me, toId)) {
      return res.status(403).json({ error: 'You can only invite your friends' });
    }
    if (db.isServerMember(serverId, toId)) {
      return res.status(400).json({ error: 'They are in the room already' });
    }
    const id = db.createRoomInvite(serverId, me, toId);
    sendToUser(toId, {
      type: 'room_invite',
      invite: {
        id,
        server_id: serverId,
        server_name: server.name,
        from_id: me,
        from_username: req.session.username,
        is_private: Boolean(server.is_private),
        created_at: Math.floor(Date.now() / 1000)
      }
    });
    logToFile(`[SERVERS] ${req.session.username} invited ${toId} to ${serverId}`);
    res.json({ ok: true, id });
  } catch (error) {
    logToFile(`[SERVERS] Invite error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to send the invite' });
  }
});

// the invites waiting for the person (the ones for a room they are in already are not shown)
app.get('/api/invites', requireAuth, (req, res) => {
  try {
    const me = req.session.userId;
    const invites = db.getRoomInvites(me).filter((invite) => !db.isServerMember(invite.server_id, me));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, invites });
  } catch (error) {
    logToFile(`[SERVERS] Get invites error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to get invites' });
  }
});

app.post('/api/invites/:id/decline', requireAuth, (req, res) => {
  try {
    const invite = db.getRoomInvite(req.params.id);
    if (!invite || invite.to_id !== req.session.userId) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    db.deleteRoomInvite(invite.id);
    res.json({ ok: true });
  } catch (error) {
    logToFile(`[SERVERS] Decline invite error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to decline the invite' });
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
    roomKeys.markRotate(serverId);

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
    roomKeys.markRotate(serverId);

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
    const serversWithDetails = buildServerListPayload(userServers, req, req.session.userId);
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

    const canOpen = wantsE2e(req);
    const messages = db.getServerMessages(serverId).map((message) => roomKeys.presentMessage(message, canOpen));
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
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to send messages' });
    }

    // what comes in is a message locked by the members, the server never gets the text
    const checked = roomKeys.checkMessage(serverId, req.body && (req.body.text || req.body.message));
    if (!checked.ok) {
      return res.status(400).json({ error: checked.error, code: checked.code });
    }

    const settings = db.getSettings(req.session.userId);
    const senderThemeColor = settings ? themeColorOf(settings) : null;
    const message = db.createServerMessage(serverId, req.session.userId, req.session.username, checked.text, senderThemeColor);
    logToFile(`[SERVER CHAT] Message sent in ${serverId} by ${req.session.username}`);

    if (globalWss) {
      roomKeys.broadcastMessage(serverId, message);
    }

    res.json({ ok: true, message: roomKeys.presentMessage(message, wantsE2e(req)) });
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

    // a song that is a file from somebody's device is only added once its file is on this server for the room
    if (String(videoId).startsWith('local:') || source === 'local') {
      if (!roomFiles.enabled) return res.status(400).json({ error: 'audio files cannot be shared in a room on this server' });
      if (!roomFiles.has(serverId, String(videoId))) return res.status(409).json({ error: 'the file of this song is not on the server, send it first' });
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
    const queueBefore = db.getServerQueue(serverId);
    db.removeFromServerQueue(trackId, serverId);
    roomFiles.prune(serverId);
    logToFile(`[SERVER QUEUE] Track removed from ${serverId}: ${trackId}`);

    if (globalWss) {
      broadcastServerQueue(serverId);
    }
    handleCurrentTrackRemoved(serverId, trackId, queueBefore);

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
    roomFiles.prune(serverId);
    logToFile(`[SERVER QUEUE] Queue cleared for ${serverId}`);

    if (globalWss) {
      broadcastServerQueue(serverId);
    }
    resetRoomPlayback(serverId);

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
    const body = req.body || {};

    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to update player state' });
    }

    const trackId = typeof body.current_track_id === 'string' && body.current_track_id.length <= 120
      ? body.current_track_id
      : null;
    if (body.is_playing === true) markUserListening(serverId, req.session.userId);
    const result = applySyncCommand(serverId, {
      current_track_id: trackId,
      is_playing: body.is_playing === true,
      current_time: typeof body.current_time === 'number' ? body.current_time : undefined,
      auto_advance_from: typeof body.auto_advance_from === 'string' ? body.auto_advance_from : null
    });

    logToFile(`[SERVER PLAYER] ${serverId} ${body.is_playing === true ? 'play' : 'pause'} -> ${result.phase || (result.noop ? 'no change' : 'ignored')}`);

    res.json({ ok: true, ...result });
  } catch (error) {
    logToFile(`[SERVER PLAYER] Update state error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to update player state' });
  }
});

// repeat and shuffle of the room's player. any member can change them
app.post('/api/server/:serverId/player-modes', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    const body = req.body || {};
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to change the player' });
    }
    const current = getPlayModes(serverId);
    const repeat = ['off', 'all', 'one'].includes(body.repeat_mode) ? body.repeat_mode : current.repeat_mode;
    const shuffle = typeof body.shuffle === 'boolean' ? body.shuffle : current.shuffle;
    const next = { repeat_mode: repeat, shuffle };
    db.setServerPlayModes(serverId, next);
    playModesCache.set(serverId, next);
    logToFile(`[SERVER PLAYER] ${serverId} modes repeat=${repeat} shuffle=${shuffle}`);
    broadcastServerPlayerState(serverId);
    res.json({ ok: true, ...next });
  } catch (error) {
    logToFile(`[SERVER PLAYER] Modes error: ${error.message}`, true);
    res.status(500).json({ error: 'Failed to change the player' });
  }
});

// get server player state
app.get('/api/server/:serverId/player', requireAuth, (req, res) => {
  try {
    const { serverId } = req.params;
    if (!isServerMember(serverId, req.session.userId)) {
      return res.status(403).json({ error: 'Must be a server member to view player state' });
    }
    const state = getSyncedPlayerState(serverId);
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
    const clearedSession = syncSessions.get(serverId);
    if (clearedSession && clearedSession.timer) clearTimeout(clearedSession.timer);
    syncSessions.delete(serverId);
    playModesCache.delete(serverId);
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

// debug logs endpoint. no login needed when you are on the same machine as the
// server (the desktop app and plain localhost dev), anyone else has to be an
// admin. the logs hold usernames, ips and request details
app.get('/api/debug/logs', (req, res) => {
  const isAdminUser = Boolean(req.session && req.session.userId && db.getUserById(req.session.userId)?.is_admin);
  if (!validation.isLocalRequest(req) && !isAdminUser) {
    return res.status(403).json({ error: 'Debug logs are only available on the host machine or to admins' });
  }
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
    res.sendFile(path.join(activeBuildDir(), 'index.html'));
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

// keep every connection busy. something on the way from the apps to this server closes a
// connection that has been quiet for 60 seconds (idle devices were dropping and coming back
// every minute, which also flickered them offline for everyone else and made each phone
// download its account again), and a ping now and then counts as traffic both ways. a
// browser answers a ping by itself, no app code is involved. a connection that answers
// nothing for two rounds in a row is really gone and is closed here
const HEARTBEAT_MS = 40000;
wss.on('connection', (ws) => {
  ws.missedPings = 0;
  ws.on('pong', () => {
    ws.missedPings = 0;
    ws.lastPongAt = Date.now();
  });
});
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.missedPings >= 2) {
      try { ws.terminate(); } catch { /* already gone */ }
      return;
    }
    ws.missedPings = (ws.missedPings || 0) + 1;
    try { ws.ping(); } catch { /* closing */ }
  });
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

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
    listeningState: null,
    syncMode: 'no' // the client reports its real mode right after connecting
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

  // what the account's other devices are playing right now
  const otherDevices = [];
  wsClients.forEach((other, otherId) => {
    if (otherId !== clientId && other.userId === userId && other.deviceState) {
      otherDevices.push({ clientId: otherId, device: other.device, state: other.deviceState });
    }
  });
  if (otherDevices.length) sendWs(ws, { type: 'device_states', devices: otherDevices });
  
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

          // what was playing until now is counted, then the new state starts its own stretch
          commitListening(client, Date.now());
          client.listeningState = nextListeningState;
          client.listeningSince = nextListeningState && nextListeningState.is_playing !== false ? Date.now() : null;
          sendWs(ws, {
            type: 'listening_state_set',
            listening_to: nextListeningState
          });

          // a person who keeps their listening to themselves does not make a presence update for it
          if (previousSerialized !== nextSerialized && !(client.userId && isListeningHidden(client.userId))) {
            broadcastPresence();
          }
          break;
        }

        case 'device_state': {
          const nextDevice = sanitizeDevice(data.device);
          const nextState = sanitizeDeviceState(data.state);
          client.device = nextDevice;
          client.deviceState = nextState;
          broadcastWs({
            type: 'device_state_changed',
            from: { clientId, device: nextDevice },
            state: nextState
          }, (other) => other.userId === userId, clientId);
          break;
        }

        case 'device_command': {
          // "pause there" / "resume there" from another of the same account's devices
          const command = ['pause', 'play'].includes(data.command) ? data.command : null;
          if (!command || typeof data.to !== 'string' || data.to === clientId) break;
          const target = wsClients.get(data.to);
          if (target && target.userId === userId) {
            sendWs(target.ws, { type: 'device_command', command, from: { clientId, device: client.device || null } });
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
            // they might have been the only one the others were waiting on
            maybeStartSyncSession(previousServerId);
          }
          broadcastPresence();
          break;
        }

        case 'client_info': {
          // the kind of device this connection is on, for the icons next to the person's name
          const platform = data.platform === 'mobile' || data.platform === 'pc' ? data.platform : null;
          // this app can read private messages (an older one is sent a note instead)
          const couldOpenBefore = client.e2e === true;
          client.e2e = data.e2e === true;
          // the room state was sent when the connection opened, before this app said what it can read: it got notes in
          // place of the locked room messages, so it is given the history again in the form it can open
          if (client.e2e && !couldOpenBefore && client.serverId && isServerMember(client.serverId, userId)) {
            sendWs(ws, { type: 'chat_history', serverId: client.serverId, messages: db.getServerMessages(client.serverId).map((message) => roomKeys.presentMessage(message, true)) });
          }
          if (platform && client.platform !== platform) {
            client.platform = platform;
            broadcastPresence();
          }
          break;
        }

        case 'sync_presence': {
          if (data.mode === 'yes' || data.mode === 'auto' || data.mode === 'no') {
            client.syncMode = data.mode;
            // going to "no" may be exactly what the others were waiting on
            if (client.serverId) maybeStartSyncSession(client.serverId);
          }
          break;
        }

        case 'sync_status': {
          // why this player is not ready yet, shown to the room as the reason
          // the start is waiting. text only, cut to size
          const statusServerId = client.serverId;
          if (statusServerId && typeof data.revision === 'string' && typeof data.reason === 'string') {
            client.syncStatus = {
              revision: data.revision,
              reason: data.reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80) || 'getting ready',
              at: Date.now()
            };
            scheduleWaitingBroadcast(statusServerId);
          }
          break;
        }

        case 'sync_ready': {
          // this player has loaded the track at the requested spot and is
          // buffered enough to start
          const readyServerId = client.serverId;
          if (readyServerId && typeof data.revision === 'string') {
            handleSyncReady(readyServerId, clientId, data.revision);
          }
          break;
        }

        case 'chat':
        case 'chat_message': {
          const targetServerId = data.serverId || client.serverId;
          if (!targetServerId) {
            break;
          }

          if (!isServerMember(targetServerId, userId)) {
            sendWs(ws, { type: 'error', error: 'Must be a server member to chat' });
            break;
          }

          const wsChecked = roomKeys.checkMessage(targetServerId, data.text);
          if (!wsChecked.ok) {
            sendWs(ws, { type: 'error', error: wsChecked.error, code: wsChecked.code });
            break;
          }

          const sSettings = db.getSettings(userId);
          const sSenderThemeColor = sSettings ? themeColorOf(sSettings) : null;
          const serverMessage = db.createServerMessage(targetServerId, userId, username, wsChecked.text, sSenderThemeColor);
          roomKeys.broadcastMessage(targetServerId, serverMessage);
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
    if (client) commitListening(client, Date.now());
    wsClients.delete(clientId);
    console.log(`[WS] Total clients: ${wsClients.size}`);

    // a dropped connection must not leave the room waiting for it
    if (client?.serverId) {
      maybeStartSyncSession(client.serverId);
    }

    // this device is gone, so the others stop showing it as playing
    if (client?.deviceState) {
      broadcastWs({
        type: 'device_state_changed',
        from: { clientId, device: client.device },
        state: null
      }, (other) => other.userId === client.userId);
    }

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
