// discover: keeps the queue filled with songs that fit what the person is playing. the songs come from youtube's own mix for a few
// songs of the queue (the seeds), are put in order and filtered here, and go into the queue like any song the person added
// (so they can be removed, moved or played), 10 ahead of the one that is playing.
//
// the choosing is kept apart from the page (App.js) so it can be tested alone

export const DISCOVER_AHEAD = 10;
const MIN_SECONDS = 45;
const MAX_SECONDS = 600; // a song, not a compilation or a live recording of hours
const PER_ARTIST = 2; // in what is ahead and in one batch
const RESERVOIR_MAX = 30;
const NOT_A_SONG = /\b(\d+\s*(hours?|hrs?)|full album|compilation|playlist|live ?stream|non-?stop|mashup|reaction|tutorial)\b/i;
const FILLER = new Set(['official', 'video', 'music', 'audio', 'lyrics', 'lyric', 'hd', 'hq', '4k', 'remastered', 'remaster', 'mv', 'visualizer']);

// the id of a song that youtube can give a mix for (not a file of the person, not another service)
export function youtubeId(track) {
  if (!track) return '';
  const source = String(track.source || track.provider || 'youtube').toLowerCase();
  const id = track.videoId || track.video_id || '';
  return source === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
}

// "Artist - Song (Official Video) [4K]" and "artist song" are the same song for the purpose of not queueing it twice
export function songKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word && !FILLER.has(word))
    .join(' ')
    .trim();
}

// how many songs are left to play after the current one. with shuffle on it is the songs not played lately
export function aheadCount({ queue, playIndex, shuffle, history = [] }) {
  const list = Array.isArray(queue) ? queue : [];
  if (!shuffle) return Math.max(0, list.length - (playIndex >= 0 ? playIndex + 1 : 0));
  const played = new Set(history);
  return list.filter((track, index) => index !== playIndex && !played.has(track.videoId)).length;
}

// the songs to ask youtube about: the ones of the queue the person chose themselves before the ones discover added, the one that is
// playing first, and a song that was asked about before comes after one that was not (the answer would be the same for a while)
export function pickSeeds({ queue, playIndex, seedUse = new Map(), max = 2 }) {
  const list = Array.isArray(queue) ? queue : [];
  const scored = [];
  list.forEach((track, index) => {
    const id = youtubeId(track);
    if (!id) return;
    const distance = playIndex >= 0 ? Math.abs(index - playIndex) : index;
    const score = (seedUse.get(id) || 0) * 10 + (track.discover ? 15 : 0) + Math.min(distance, 50) / 10 + (index === playIndex ? -5 : 0);
    scored.push({ track, id, score });
  });
  scored.sort((a, b) => a.score - b.score);
  const seen = new Set();
  const out = [];
  for (const entry of scored) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry.track);
    if (out.length >= max) break;
  }
  return out;
}

// what can not be suggested: already in the queue (same id or same song under another upload), heard lately, taken out by the
// person, known not to play, not a song
function allowed(item, { queueIds, queueKeys, rejected, recent }) {
  if (!item || !item.videoId || !item.title) return false;
  if (queueIds.has(item.videoId) || rejected.has(item.videoId) || recent.has(item.videoId)) return false;
  if (!(item.duration >= MIN_SECONDS && item.duration <= MAX_SECONDS)) return false;
  if (NOT_A_SONG.test(item.title)) return false;
  const key = songKey(item.title);
  if (key && queueKeys.has(key)) return false;
  return true;
}

// the lists youtube gave (one per seed) and what was left over last time -> one list in order of how well the songs fit.
// a song that shows up under several seeds comes first, then the ones near the top of a mix. no artist more than twice in the
// batch or in what is already ahead in the queue
export function rankCandidates({ mixes = [], leftover = [], queue = [], ahead = [], rejected = new Set(), recent = new Set(), rng = Math.random }) {
  const queueIds = new Set(queue.map((track) => track.videoId));
  const queueKeys = new Set(queue.map((track) => songKey(track.title)).filter(Boolean));
  const context = { queueIds, queueKeys, rejected, recent };
  const pool = new Map();
  leftover.forEach((item, index) => {
    if (allowed(item, context)) pool.set(item.videoId, { ...item, score: 1 / (1 + index / 8) + 0.5 });
  });
  mixes.forEach((mix) => {
    (mix.items || []).forEach((item, position) => {
      if (!allowed(item, context)) return;
      const add = 1 / (1 + position / 8);
      const kept = pool.get(item.videoId);
      if (kept) kept.score += add;
      else pool.set(item.videoId, { ...item, score: add });
    });
  });
  const ordered = [...pool.values()].map((item) => ({ ...item, score: item.score + rng() * 0.05 })).sort((a, b) => b.score - a.score);

  const counts = new Map();
  const authorOf = (item) => String(item.author || '').toLowerCase().trim();
  ahead.forEach((track) => {
    const author = authorOf(track);
    if (author) counts.set(author, (counts.get(author) || 0) + 1);
  });
  const picked = [];
  const skipped = [];
  const seenKeys = new Set();
  for (const item of ordered) {
    const key = songKey(item.title);
    if (key && seenKeys.has(key)) continue;
    const author = authorOf(item);
    if (author && (counts.get(author) || 0) >= PER_ARTIST) {
      skipped.push(item);
      continue;
    }
    if (key) seenKeys.add(key);
    if (author) counts.set(author, (counts.get(author) || 0) + 1);
    picked.push(item);
  }
  return picked.concat(skipped);
}

// what is kept for the next top up: not more than a few batches
export const trimReservoir = (list) => list.slice(0, RESERVOIR_MAX);
