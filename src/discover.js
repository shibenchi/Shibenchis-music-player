// discover: keeps the queue filled with songs that fit what the person is playing. the songs come from youtube's own mix for a few
// songs of the queue (the seeds), are put in order and filtered here, and go into the queue like any song the person added
// (so they can be removed, moved or played), 10 ahead of the one that is playing.
//
// the choosing is kept apart from the page (App.js) so it can be tested alone

export const DISCOVER_AHEAD = 10;
const MIN_SECONDS = 45;
const MAX_SECONDS = 600; // a song, not a compilation or a live recording of hours
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

// "Eazy E", "Eazy-E - Topic" and "EazyEVEVO" are one artist for the purpose of not queueing only that artist
export function artistKey(author) {
  return String(author || '')
    .toLowerCase()
    .replace(/\s*-\s*topic$/, '')
    .replace(/vevo$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// how many songs are left to play after the current one. with shuffle on it is the songs not played lately
export function aheadCount({ queue, playIndex, shuffle, history = [] }) {
  const list = Array.isArray(queue) ? queue : [];
  if (!shuffle) return Math.max(0, list.length - (playIndex >= 0 ? playIndex + 1 : 0));
  const played = new Set(history);
  return list.filter((track, index) => index !== playIndex && !played.has(track.videoId)).length;
}

// the ids of the songs discover added on this device that the person has not shown they like. kept apart from the songs themselves: the
// account queue on the server has no place for the mark on a song, so a queue loaded from it would count every one of them as chosen
const ADDED_KEY = 'music_discover_added';
const ADDED_MAX = 500;
export function loadAdded(storage) {
  try {
    const raw = JSON.parse(storage.getItem(ADDED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
export function saveAdded(storage, set) {
  try {
    storage.setItem(ADDED_KEY, JSON.stringify([...set].slice(-ADDED_MAX)));
  } catch {
    // full or blocked: the mark on the songs themselves still works for this session
  }
}

// the songs to ask youtube about. ONLY songs the person chose themselves: asking about a song discover added made the taste drift (old
// rap, then the new rap that was suggested, then pop that came with that, then 80s, and round again). discover songs are seeds only
// when the queue holds nothing else. among the person's own songs the one that is playing comes first, and a song that was asked about
// before comes after one that was not (the answer would be the same for a while), so every one of their songs gets its turn
export function pickSeeds({ queue, playIndex, seedUse = new Map(), max = 2, rng = Math.random, added = new Set() }) {
  const list = Array.isArray(queue) ? queue : [];
  const scored = [];
  list.forEach((track, index) => {
    const id = youtubeId(track);
    if (!id) return;
    const distance = playIndex >= 0 ? Math.abs(index - playIndex) : index;
    // the random part keeps it from asking about the same few songs every time
    const score = (seedUse.get(id) || 0) * 10 + Math.min(distance, 50) / 10 + (index === playIndex ? -5 : 0) + rng() * 4;
    scored.push({ track, id, score, own: !track.discover && !added.has(id) });
  });
  scored.sort((a, b) => a.score - b.score);
  const own = scored.filter((entry) => entry.own);
  if (own.length) scored.splice(0, scored.length, ...own);
  // different artists first: a mix made from two songs of one artist is that artist's songs
  const seen = new Set();
  const artists = new Set();
  const out = [];
  for (const entry of scored) {
    if (seen.has(entry.id)) continue;
    const artist = artistKey(entry.track.author);
    if (artist && artists.has(artist)) continue;
    seen.add(entry.id);
    if (artist) artists.add(artist);
    out.push(entry.track);
    if (out.length >= max) return out;
  }
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
// a song that shows up under several seeds comes first, then the ones near the top of a mix. then the artists take turns: the
// best song of every artist first (an artist that already has songs ahead in the queue waits behind the ones that have none),
// then the second best of every artist, and so on, so a batch of ten is as many different artists as the mixes hold
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
  ahead.forEach((track) => {
    const artist = artistKey(track.author);
    if (artist) counts.set(artist, (counts.get(artist) || 0) + 1);
  });
  const turns = new Map();
  const seenKeys = new Set();
  const turnOrder = [];
  for (const item of ordered) {
    const key = songKey(item.title);
    if (key && seenKeys.has(key)) continue;
    if (key) seenKeys.add(key);
    const artist = artistKey(item.author);
    const already = artist ? (counts.get(artist) || 0) : 0;
    const taken = artist ? (turns.get(artist) || 0) : 0;
    turnOrder.push({ item, rank: already + taken });
    if (artist) turns.set(artist, taken + 1);
  }
  // a stable sort: inside one round the order of fit stays
  turnOrder.sort((a, b) => a.rank - b.rank);
  return turnOrder.map((entry) => entry.item);
}

// what is kept for the next top up: not more than a few batches
export const trimReservoir = (list) => list.slice(0, RESERVOIR_MAX);
