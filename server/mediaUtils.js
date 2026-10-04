// audio cache, range serving and youtube rate limit handling. used by the local
// helper and by the full server's own media endpoints, so both behave the same.
const fs = require('fs');
const path = require('path');

// same format pick everywhere: audio only, m4a first. the android client only
// exposes a muxed 360p stream these days, so the default client is used
const AUDIO_FORMAT_SELECTOR = 'bestaudio[ext=m4a]/bestaudio/best';

const MEDIA_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
};

// youtube answering with a bot check or a 429 means it is unhappy with this
// ip, not that the video is bad
const BOT_CHECK_PATTERN = /confirm you.?re not a bot|sign in to confirm|http error 429|too many requests|unusual traffic/i;

function isBotCheckError(err) {
  return BOT_CHECK_PATTERN.test(String((err && (err.stderr || err.message)) || err || ''));
}

// a cache file only counts if it is a whole mp4/m4a: big enough, and starting
// with the "ftyp" box every one of them has. a half written or half
// post-processed file used to get served as if it was fine
function isCompleteAudioFile(filePath) {
  let fd;
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 10000) return false;
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    return head.toString('latin1', 4, 8) === 'ftyp';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// yt-dlp leaves .part / .temp / .f140 files next to its output while it works
// and after a failure. everything for one download shares a prefix
function removeWorkFiles(dir, prefix) {
  try {
    fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .forEach((name) => {
        try { fs.unlinkSync(path.join(dir, name)); } catch {}
      });
  } catch {}
}

// leftovers from a process that was killed mid download
function sweepLeftoverDownloads(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir)
      .filter((name) => name.includes('.dl-'))
      .forEach((name) => {
        try { fs.unlinkSync(path.join(dir, name)); } catch {}
      });
  } catch {}
}

function serveLocalFile(req, res, filePath, contentType, extraHeaders = {}) {
  const fileSize = fs.statSync(filePath).size;

  let start = 0;
  let end = fileSize - 1;
  let status = 200;

  // a range header that does not parse is ignored and the whole file goes
  // out, one that asks for bytes past the end gets a 416. suffix ranges
  // ("bytes=-500", the last 500 bytes) used to turn into NaN headers
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (match && (match[1] !== '' || match[2] !== '')) {
    if (match[1] === '') {
      start = Math.max(0, fileSize - parseInt(match[2], 10));
    } else {
      start = parseInt(match[1], 10);
      if (match[2] !== '') end = Math.min(parseInt(match[2], 10), fileSize - 1);
    }
    if (start >= fileSize || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, ...MEDIA_CORS_HEADERS, ...extraHeaders });
      return res.end();
    }
    status = 206;
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
    ...MEDIA_CORS_HEADERS,
    ...extraHeaders
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;

  // without these, a file that vanishes mid stream throws an unhandled error
  // event and takes the whole process down, and a client that skipped away
  // leaves the read stream open
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  res.writeHead(status, headers);
  stream.pipe(res);
}

// ytdlp: the configured yt-dlp runner. log: (message) => void
function createMediaTools({ ytdlp, log = () => {} }) {
  // while youtube is rate limiting us the background work (prefetch, cache
  // warming) stops so we dont keep poking it, which only makes the block last
  // longer. the wait doubles each time, up to 10 minutes, and resets after one
  // success. playing a track you clicked still tries
  let cooldownUntil = 0;
  let cooldownMs = 0;

  function noteYoutubeFailure(err) {
    if (!isBotCheckError(err)) return false;
    cooldownMs = Math.min(cooldownMs ? cooldownMs * 2 : 60 * 1000, 10 * 60 * 1000);
    cooldownUntil = Date.now() + cooldownMs;
    log(`youtube bot check / rate limit hit, pausing background work for ${Math.round(cooldownMs / 1000)}s`);
    return true;
  }

  function noteYoutubeSuccess() {
    cooldownMs = 0;
    cooldownUntil = 0;
  }

  function inYoutubeCooldown() {
    return Date.now() < cooldownUntil;
  }

  // error response for anything that talked to youtube. the bot check case
  // gets its own status and a plain message instead of yt-dlp's raw output
  function sendYoutubeError(res, error, fallbackMessage) {
    if (isBotCheckError(error)) {
      const retryAfterSec = Math.max(30, Math.ceil(Math.max(0, cooldownUntil - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(503).json({
        error: 'YouTube is asking for a sign-in check right now. Wait a few minutes and try again.',
        code: 'youtube_bot_check',
        retryAfterSec
      });
    }
    return res.status(500).json({ error: (error && error.message) || fallbackMessage });
  }

  // one in-flight download per videoId, shared between the background
  // cache-warmer and the fast-path fallback so we never spawn yt-dlp twice
  // for the same track at the same time
  const inFlightDownloads = new Map();

  // downloads under a throwaway name and only moves the result to the real
  // cache name once it is finished and checked. until then nothing can see it
  function downloadToCache(videoId, audioFile) {
    if (inFlightDownloads.has(videoId)) return inFlightDownloads.get(videoId);

    const dir = path.dirname(audioFile);
    const workPrefix = `${videoId}.dl-${process.pid}-${Date.now()}`;
    const workFile = path.join(dir, `${workPrefix}.m4a`);

    const promise = (async () => {
      try {
        await ytdlp(`https://www.youtube.com/watch?v=${videoId}`, {
          // audio only. without a format yt-dlp grabs the best video+audio
          // and strips the video afterward
          format: AUDIO_FORMAT_SELECTOR,
          extractAudio: true,
          audioFormat: 'm4a',
          output: workFile,
          noWarnings: true,
          noCheckCertificate: true,
          quiet: true
        });

        if (!isCompleteAudioFile(workFile)) {
          throw new Error('downloaded audio file is incomplete');
        }
        // someone else may have finished first, then theirs is already good
        if (!fs.existsSync(audioFile)) {
          fs.renameSync(workFile, audioFile);
        }
        noteYoutubeSuccess();
      } catch (err) {
        noteYoutubeFailure(err);
        throw err;
      } finally {
        removeWorkFiles(dir, workPrefix);
        inFlightDownloads.delete(videoId);
      }
    })();

    inFlightDownloads.set(videoId, promise);
    return promise;
  }

  return {
    isBotCheckError,
    noteYoutubeFailure,
    noteYoutubeSuccess,
    inYoutubeCooldown,
    sendYoutubeError,
    isCompleteAudioFile,
    downloadToCache,
    serveLocalFile,
    sweepLeftoverDownloads
  };
}

module.exports = {
  AUDIO_FORMAT_SELECTOR,
  MEDIA_CORS_HEADERS,
  isBotCheckError,
  isCompleteAudioFile,
  serveLocalFile,
  createMediaTools
};
