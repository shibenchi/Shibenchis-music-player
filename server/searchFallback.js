// searching youtube when the usual way gives up.
//
// yt-search (the library the search normally ends up with) throws for a whole query when one result on the page has a shape it does not
// know (searching "fractrick" does that, and takes about 13 seconds to fail), and the public Invidious sites it is tried after are mostly down.
// yt-dlp is slower to start (a few seconds, most of it starting up) but it is the same tool that plays the songs, so it is there wherever
// playback is, and it does not trip on one odd result.
const MAX_QUERY = 200;

async function searchWithYtdlp(ytdlp, query, limit = 10) {
  const text = String(query || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  if (!text) return [];
  const count = Math.max(1, Math.min(30, Number(limit) || 10));
  const raw = await ytdlp(`ytsearch${count}:${text}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    noCheckCertificate: true,
    skipDownload: true,
    socketTimeout: 20
  });
  const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const entries = Array.isArray(info && info.entries) ? info.entries : [];
  return entries
    .filter((entry) => entry && /^[A-Za-z0-9_-]{11}$/.test(entry.id || '') && entry.title)
    .map((entry) => ({
      videoId: entry.id,
      title: entry.title,
      author: entry.channel || entry.uploader || '',
      duration: Number(entry.duration) || 0,
      thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
    }));
}

// several ways to search at the same time, the first one that brings results wins. an attempt with a delay waits that long before it starts
// (the costly ones: it is not started at all when another already answered), and starts at once when every attempt before it has failed or
// come back empty. -> { results, source, error }: error is the first thing that went wrong, for when nothing was found at all
function firstResults(attempts, { onFail = () => {} } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    let firstError = null;
    const started = new Array(attempts.length).fill(false);
    const timers = [];
    let running = 0;

    const done = (value) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      resolve({ results: [], source: '', error: firstError, ...value });
    };
    const startNext = () => {
      const index = started.indexOf(false);
      if (index >= 0) start(index);
    };
    function start(index) {
      if (finished || started[index]) return;
      started[index] = true;
      running += 1;
      const { name = String(index), run } = attempts[index];
      Promise.resolve()
        .then(run)
        .then((list) => {
          if (Array.isArray(list) && list.length) done({ results: list, source: name });
          else onFail(name, null);
        })
        .catch((error) => {
          firstError = firstError || error;
          onFail(name, error);
        })
        .finally(() => {
          running -= 1;
          if (finished) return;
          // nothing came of this one: the next does not wait for its turn
          if (started.includes(false)) startNext();
          else if (running === 0) done({});
        });
    }

    attempts.forEach((attempt, index) => {
      if (attempt.delay) timers.push(setTimeout(() => start(index), attempt.delay));
      else start(index);
    });
  });
}

module.exports = { searchWithYtdlp, firstResults };
