// a song's YouTube Mix: the list of related songs youtube builds from one song (its "radio"). it is not a real playlist, youtube makes it
// on the spot and it differs every time, so this only hands the songs over and the app decides what to do with them.
// the lookup is yt-dlp work, so like the other media routes it belongs to the local helper on the person's own computer
const MIX_TTL_MS = 60 * 60 * 1000;
const MIX_CACHE_MAX = 200;
const MIX_PARALLEL = 2;
const MIX_TIMEOUT_MS = 45000;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;

function createMixes({ ytdlp, isValidVideoId, noteYoutubeSuccess = () => {}, noteYoutubeFailure = () => {}, sendYoutubeError, log = () => {} }) {
  const cache = new Map(); // videoId -> { at, items }
  const inflight = new Map(); // videoId -> promise
  let running = 0;
  const waiting = [];

  // at most a couple of lookups at the same time, so a burst never takes the helper away from playing songs
  const takeSlot = () => new Promise((resolve) => {
    if (running < MIX_PARALLEL) {
      running += 1;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });
  const freeSlot = () => {
    running -= 1;
    const next = waiting.shift();
    if (next) {
      running += 1;
      next();
    }
  };

  async function lookup(videoId, limit) {
    await takeSlot();
    let timer = null;
    try {
      const child = ytdlp(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`, {
        dumpSingleJson: true,
        flatPlaylist: true,
        playlistEnd: limit + 1,
        noWarnings: true,
        noCheckCertificate: true,
        skipDownload: true,
        socketTimeout: 20
      });
      timer = setTimeout(() => {
        try { if (child && typeof child.kill === 'function') child.kill(); } catch { /* already gone */ }
      }, MIX_TIMEOUT_MS);
      const raw = await child;
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const entries = Array.isArray(info && info.entries) ? info.entries : [];
      return entries
        .filter((entry) => entry && isValidVideoId(entry.id) && entry.id !== videoId)
        .map((entry) => ({
          videoId: entry.id,
          title: entry.title || '',
          author: entry.channel || entry.uploader || '',
          duration: Number(entry.duration) || 0
        }))
        .slice(0, limit);
    } finally {
      if (timer) clearTimeout(timer);
      freeSlot();
    }
  }

  // from the cache while it is fresh. asking again for a mix that is being looked up joins that lookup
  async function getMix(videoId, limit = DEFAULT_LIMIT) {
    const kept = cache.get(videoId);
    if (kept && Date.now() - kept.at < MIX_TTL_MS && kept.wanted >= limit) {
      return kept.items.slice(0, limit);
    }
    if (inflight.has(videoId)) return (await inflight.get(videoId)).slice(0, limit);
    const job = lookup(videoId, Math.max(limit, DEFAULT_LIMIT)).then((items) => {
      cache.set(videoId, { at: Date.now(), items, wanted: Math.max(limit, DEFAULT_LIMIT) });
      while (cache.size > MIX_CACHE_MAX) cache.delete(cache.keys().next().value);
      return items;
    });
    inflight.set(videoId, job);
    try {
      return (await job).slice(0, limit);
    } finally {
      inflight.delete(videoId);
    }
  }

  function register(app) {
    // does this helper know the route (an older one answers 404): the page asks before it shows its button
    app.get('/api/mix/status', (req, res) => {
      res.json({ ok: true, available: true });
    });

    app.get('/api/mix', async (req, res) => {
      const videoId = String(req.query.videoId || '').trim();
      if (!videoId) return res.status(400).json({ error: 'Missing videoId query parameter' });
      if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
      const asked = Number.parseInt(req.query.limit, 10);
      const limit = Number.isFinite(asked) ? Math.min(MAX_LIMIT, Math.max(5, asked)) : DEFAULT_LIMIT;
      try {
        const items = await getMix(videoId, limit);
        noteYoutubeSuccess();
        res.json({ videoId, items });
      } catch (error) {
        log(`mix lookup failed for ${videoId}: ${error && error.message}`);
        noteYoutubeFailure(error);
        sendYoutubeError(res, error, 'Failed to fetch the mix');
      }
    });
  }

  return { register, getMix };
}

module.exports = { createMixes };
