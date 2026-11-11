// synced lyrics for the song that is playing: found by name, timed line by line.
//
// the lyrics come from LRCLIB (lrclib.net), a free open collection of time stamped lyrics that needs no account and allows requests from a web page. a song from
// YouTube or from a Spotify playlist is the same song when its cleaned up title, its artist and its length match, so both are asked the same way: the title with the
// "official video" and "feat." noise taken off, the artist (from the channel, or from the front of a "Artist - Title" title), the length in seconds. nothing
// leaves the device but those three things, and only when the lyrics button is pressed
const ENDPOINT = 'https://lrclib.net/api';
const cache = new Map();
const LOCAL_PREFIX = 'music_lyrics:v5:';
const LOCAL_LIMIT = 40;

const NOISE = /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|1080p|remaster(ed)?( \d{4})?|explicit|clean|topic|vevo|full (song|version)|with lyrics|hd audio)\b/i;

// a title without what YouTube channels put in it
export function cleanTitle(raw) {
  let text = String(raw || '').trim();
  // brackets that hold noise or a featured artist: "(Official Video)", "[Lyrics]", "(feat. X)"
  text = text.replace(/[([{][^)\]}]*[)\]}]/g, (piece) => (NOISE.test(piece) || /\b(feat|ft|featuring|prod|with)\b\.?/i.test(piece) ? '' : piece));
  // noise after a dash or a bar: " - Official Video", " | Lyrics"
  text = text.replace(/\s*[-|:]\s*(official\b.*|lyrics?\b.*|audio\b.*|video\b.*|visuali[sz]er\b.*|hd\b.*|topic\b.*)$/i, '');
  text = text.replace(/\s+(feat|ft|featuring)\.?\s+.*$/i, '');
  return text.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '').trim();
}

// the channel name of a song as the artist: "Coolio - Topic", "CoolioVEVO", "Coolio Official" -> "Coolio"
export function cleanArtist(raw) {
  return String(raw || '')
    .replace(/\s*-\s*topic\s*$/i, '')
    .replace(/vevo\s*$/i, '')
    .replace(/\s+(official|music|records|channel)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// the pieces of a title that can be the name of the song, the likeliest first, and all its pieces (as hints for the artist and the album). a piece that is only a track
// number is dropped, a number in front of a piece too ("10-It Ain't Hard to Tell"):
//   "illmatic - 10 - Nas - It Ain't Hard to Tell" -> pieces: It Ain't Hard to Tell, Nas, illmatic (and the whole title); hints: illmatic, Nas, It Ain't Hard to Tell
export function titlePieces(rawTitle) {
  const raw = String(rawTitle || '');
  const strip = (piece) => cleanTitle(piece).replace(/^\d{1,3}\s*[-–.)]\s*/, '').trim();
  // a dash with a space on at least one side splits ("Ice Cube -My Summer Vacation"), a dash inside a word does not ("Jay-Z")
  const parts = raw.split(/\s+[-–—]\s*|\s*[-–—]\s+|\s*\|\s*/).map(strip).filter((p) => p && !/^\d{1,3}$/.test(p) && !/^track\s*\d+$/i.test(p));
  const whole = strip(raw);
  const pieces = [];
  const add = (p) => { if (p && !pieces.some((x) => x.toLowerCase() === p.toLowerCase())) pieces.push(p); };
  [...parts].reverse().forEach((p) => {
    add(p);
    // "The Takeover (Nas Diss)": the name without the bracket at its end as well
    add(p.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, '').trim());
  });
  add(whole);
  return { pieces: pieces.slice(0, 6), hints: parts };
}

// the (artist, title) pairs to ask for, the likeliest first
export function candidatesFor(track) {
  const title = String((track && track.title) || '');
  const author = cleanArtist(track && track.author);
  const out = [];
  const add = (artist, name) => {
    const a = String(artist || '').trim();
    const n = cleanTitle(name);
    if (!n) return;
    if (!out.some((c) => c.artist.toLowerCase() === a.toLowerCase() && c.title.toLowerCase() === n.toLowerCase())) out.push({ artist: a, title: n });
  };
  const split = title.split(/\s+[-–—]\s+/);
  if (split.length >= 2) {
    // "Artist - Title": the front is the artist
    add(split[0], split.slice(1).join(' - '));
    // some channels put it the other way round ("Title - Artist")
    if (split.length === 2) add(cleanTitle(split[1]), split[0]);
  }
  add(author, title);
  return out;
}

// "[01:23.45] text" -> { lines: [{ t: seconds, text }], offset: seconds }. several times before one text are several lines, [offset:ms] moves them all, tags like
// [ar:], [ti:] and word times like <01:23.45> are dropped
export function parseLrc(text) {
  const lines = [];
  let offset = 0;
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const tag = raw.match(/^\s*\[(offset):\s*([+-]?\d+)\s*\]/i);
    if (tag) { offset = Number(tag[2]) / 1000; return; }
    const times = [];
    let rest = raw;
    let m;
    while ((m = rest.match(/^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/))) {
      const fraction = m[3] ? Number(`0.${m[3]}`) : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + fraction);
      rest = rest.slice(m[0].length);
    }
    if (!times.length) return;
    const clean = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s{2,}/g, ' ').trim();
    times.forEach((t) => lines.push({ t, text: clean }));
  });
  lines.sort((a, b) => a.t - b.t);
  return { lines: lines.map((line) => ({ t: Math.max(0, line.t + offset), text: line.text })), offset };
}

// the line that is being sung at this second (the last one whose time has come), or -1 before the first. lead brings a line in a little early so the eye is
// there when the voice is
export function lineIndexAt(lines, seconds, lead = 0.15) {
  if (!lines || !lines.length) return -1;
  const t = seconds + lead;
  let lo = 0; let hi = lines.length - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export const norm = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ' ').trim();
export function similarity(a, b) {
  // "The Takeover" and "Takeover" are the same name
  const x = norm(a).replace(/^the /, ''); const y = norm(b).replace(/^the /, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const wa = new Set(x.split(' ')); const wb = y.split(' ');
  const shared = wb.filter((w) => wa.has(w)).length;
  return shared / Math.max(wa.size, wb.length);
}

export function lyricsDurationFit(entry, expectedSeconds) {
  const expected = Math.round(Number(expectedSeconds) || 0);
  if (expected <= 0) return { matches: true, penalty: 0 };

  const actual = Number(entry && (entry.duration ?? entry.identity?.duration)) || 0;
  const gap = actual > 0 ? Math.abs(actual - expected) : null;
  const maxGap = Math.max(5, expected * 0.035);
  if (gap !== null && gap > maxGap) return { matches: false, penalty: Infinity };

  const lines = entry && Array.isArray(entry.lines) ? entry.lines : [];
  if (!actual && !lines.length) return { matches: false, penalty: Infinity };
  if (!lines.length) return { matches: true, penalty: gap === null ? 0.8 : gap / maxGap };

  const first = lines[0].t;
  const last = lines[lines.length - 1].t;
  const tail = expected - last;
  if (first > expected * 0.35 || last > expected + 3 || tail > Math.max(40, expected * 0.2)) {
    return { matches: false, penalty: Infinity };
  }

  return {
    matches: true,
    penalty: (gap === null ? 0.8 : gap / maxGap) + (first / expected) * 0.5 + Math.max(0, tail / expected) * 3
  };
}

function artistMatches(candidate, actual) {
  if (!candidate) return true;
  const expected = norm(candidate);
  const found = norm(actual);
  return Boolean(expected && found && (expected === found || found.includes(expected) || expected.includes(found)));
}

function readLocal(key) {
  try { return JSON.parse(window.localStorage.getItem(LOCAL_PREFIX + key)); } catch { return null; }
}
function writeLocal(key, value) {
  try {
    const names = [];
    for (let i = 0; i < window.localStorage.length; i++) { const k = window.localStorage.key(i); if (k && k.startsWith(LOCAL_PREFIX)) names.push(k); }
    if (names.length >= LOCAL_LIMIT) names.slice(0, names.length - LOCAL_LIMIT + 1).forEach((k) => window.localStorage.removeItem(k));
    window.localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value));
  } catch { /* not remembered */ }
}

// the same fetch for every caller, so the answers kept below are shared between the lyrics and the "real artist" lookups
export const sharedFetch = (...args) => fetch(...args);
const answers = new WeakMap();
const ANSWER_MS = 2 * 60 * 1000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FAILED = { failed: true };

// one request. 404 is an answer (nothing there). a 429 (too many requests) or a 5xx is asked once more after a short wait. anything else that goes wrong is FAILED
async function request(url, fetchImpl, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try { response = await fetchImpl(url, { signal }); } catch { return FAILED; }
    if (response.status === 404) return { body: null };
    if (response.ok) {
      try { return { body: await response.json() }; } catch { return FAILED; }
    }
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      const told = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : 0);
      await wait(Math.min(2500, Math.max(600, (told || 1) * 1000)));
      continue;
    }
    return FAILED;
  }
  return FAILED;
}

// the answer for a url, or null. nothing is thrown: a request that failed is counted in stats.failed, and when the first three all failed the service is not there and
// the rest of the lookup does not ask
async function getJson(url, fetchImpl, signal, stats) {
  const s = stats || { ok: 0, failed: 0 };
  if (!s.ok && s.failed >= 3) return null;
  let kept = answers.get(fetchImpl);
  if (!kept) { kept = new Map(); answers.set(fetchImpl, kept); }
  const known = kept.get(url);
  let pending;
  if (known && Date.now() - known.at < ANSWER_MS) pending = known.promise;
  else {
    pending = request(url, fetchImpl, signal);
    kept.set(url, { at: Date.now(), promise: pending });
  }
  const got = await pending;
  if (got.failed) {
    if (kept.get(url) && kept.get(url).promise === pending) kept.delete(url);
    s.failed += 1;
    return null;
  }
  s.ok += 1;
  return got.body;
}

// an entry's title as the song's name: "02 Jay-z - Takeover" -> "Takeover"
function cleanRecordTitle(title, artist) {
  let t = String(title || '').trim();
  const a = String(artist || '').trim().toLowerCase();
  // a track number in front: "02 - Takeover", "10-It Ain't Hard To Tell", or "02 Jay-z - Takeover" (a number and then the artist). a number that is part of the name ("99 Problems") stays
  const numbered = t.match(/^\d{1,3}\s*[-–.)]\s*(?=\D)/);
  if (numbered) t = t.slice(numbered[0].length);
  else {
    const plain = t.match(/^\d{1,3}\s+/);
    if (plain && a && t.slice(plain[0].length).toLowerCase().startsWith(a)) t = t.slice(plain[0].length);
  }
  if (a && t.toLowerCase().startsWith(a)) t = t.slice(a.length).replace(/^\s*[-–:]\s*/, '').trim() || t;
  return t;
}

// the answer for one record of LRCLIB
function fromRecord(record) {
  if (!record) return null;
  // the entry's own artist and title: the song's real name
  const identity = {
    artist: String(record.artistName || ''),
    title: cleanRecordTitle(record.trackName, record.artistName),
    duration: Number(record.duration) || 0
  };
  if (record.instrumental) return { kind: 'instrumental', lines: [], plain: '', identity };
  if (record.syncedLyrics) {
    const parsed = parseLrc(record.syncedLyrics);
    if (parsed.lines.length) return { kind: 'synced', lines: parsed.lines, plain: '', identity };
  }
  if (record.plainLyrics) return { kind: 'plain', lines: [], plain: String(record.plainLyrics), identity };
  return null;
}

// the best entry for a song by the title of the song alone. the pieces of the title are searched one by one (no artist: the uploader is often nobody), an entry has to
// be within five seconds of the song's length and have a title that fits the piece; the artist or the album of the entry turning up in the title, or the artist being the
// channel, add to its score. { record, score } or null
export async function searchBest(track, duration, fetchImpl, signal, stats) {
  const { pieces, hints } = titlePieces(track && track.title);
  const hintNorm = [...hints, cleanArtist(track && track.author)].map(norm).filter(Boolean);
  const author = String((track && track.author) || '');
  const titleArtistHints = /(?:-\s*topic\s*$|vevo\s*$)/i.test(author)
    ? [cleanArtist(author)]
    : [cleanArtist(author)].filter(Boolean);
  let best = null;
  const consider = (record, piece, maxGap) => {
    const gap = duration > 0 && record.duration ? Math.abs(record.duration - duration) : 0;
    const nameSim = similarity(record.trackName, piece);
    if (gap > Math.min(maxGap, Math.max(5, duration * 0.035)) || nameSim < 0.9) return;
    const lyrics = fromRecord(record);
    const timing = lyricsDurationFit(lyrics || { duration: record.duration }, duration);
    if (!timing.matches) return;
    const artistN = norm(record.artistName);
    // the artist must be the uploader or a name in the title, unless the name and the length both fit closely (within four seconds, the usual
    // difference between a YouTube upload and the lyrics database): then it is the same song whoever uploaded it. a different song with the same name
    // is a different length, so it is still refused
    const exactLength = gap <= 4;
    if (!exactLength && titleArtistHints.length && !titleArtistHints.some((hint) => artistMatches(hint, record.artistName))) return;
    const albumN = norm(record.albumName);
    // there are many versions of one song (album, single, radio edit, live, a longer upload): the one whose length is the closest to this song's is the one whose lines
    // fall at the right moments, so the length weighs more than anything but the name
    let score = nameSim * 2 - gap * 0.6 - timing.penalty + (record.syncedLyrics ? 0.6 : 0);
    if (artistN.length > 1 && hintNorm.some((h) => h === artistN || (artistN.length > 2 && h.split(' ').includes(artistN)))) score += 1.5;
    if (albumN && hintNorm.some((h) => h === albumN)) score += 0.6;
    if (!best || score > best.score) best = { record, score, nameSim, gap };
  };
  for (const piece of pieces) {
    const params = new URLSearchParams({ track_name: piece });
    const list = await getJson(`${ENDPOINT}/search?${params.toString()}`, fetchImpl, signal, stats);
    (Array.isArray(list) ? list : []).forEach((record) => consider(record, piece, 6));
    // an entry of the right name with the right artist and a length within a second and a half: no need to look further
  }
  // the artist and the song name as one free text ("Jay-Z The Takeover": the entry may be called "Takeover", and a search by name alone shows twenty other songs first).
  // the hints are the other pieces of the title and the channel
  const strong = () => best && best.gap <= 1.5 && best.nameSim >= 0.95 && best.score >= 3.4;
  if (!strong() && pieces.length) {
    const main = pieces[0];
    const names = [];
    [...hints, cleanArtist(track && track.author)].forEach((h) => {
      const n = norm(h);
      if (n && n !== norm(main) && !names.some((x) => norm(x) === n) && !pieces.some((x) => norm(x) === n)) names.push(h);
    });
    for (const artist of names.slice(0, 2)) {
      const list = await getJson(`${ENDPOINT}/search?${new URLSearchParams({ q: artist + ' ' + main }).toString()}`, fetchImpl, signal, stats);
      (Array.isArray(list) ? list : []).forEach((record) => {
        // only entries by that artist
        const artistN = norm(record.artistName);
        const hintN = norm(artist);
        if (artistN && (artistN === hintN || hintN.includes(artistN) || artistN.includes(hintN))) consider(record, main, 6);
      });
      if (strong()) break;
    }
  }
  // nothing under any piece: the whole title as one search ("artist title" in any order)
  if (!best) {
    const q = pieces.length ? pieces[pieces.length - 1] : '';
    if (q) {
      const list = await getJson(`${ENDPOINT}/search?${new URLSearchParams({ q }).toString()}`, fetchImpl, signal, stats);
      const qNorm = norm(q);
      (Array.isArray(list) ? list : []).forEach((record) => {
        const nameN = norm(record.trackName);
        const artistN = norm(record.artistName);
        // the entry's name and artist both turn up in the title
        if (nameN.length > 2 && artistN.length > 1 && qNorm.includes(nameN) && qNorm.includes(artistN)) consider(record, record.trackName, 6);
      });
    }
  }
  return best;
}

// { kind: 'synced' | 'plain' | 'instrumental' | 'none', lines, plain }. a result is kept in memory and on the device, so the same song is not asked for twice
// an instrumental answer from an exact lookup is shown only when the entry is certainly this song: its name fits the song's name almost exactly,
// its length is within two seconds and its artist is the artist the song is credited to
function sureInstrumental(record, candidate, duration) {
  if (!record || !record.trackName || !record.artistName) return false;
  const gap = duration > 0 && record.duration ? Math.abs(record.duration - duration) : 0;
  return similarity(record.trackName, candidate.title) >= 0.95 && gap <= 2 && norm(record.artistName) === norm(candidate.artist);
}

// the same for a search hit: the name almost exact, the length within a second and a half, and the artist one the song is credited to (the channel,
// or a name in the title)
function sureSearchInstrumental(hit, track) {
  const { hints } = titlePieces(track && track.title);
  const credited = [...hints, cleanArtist(track && track.author)].map(norm).filter(Boolean);
  const artist = norm(hit.record.artistName);
  return hit.nameSim >= 0.95 && hit.gap <= 1.5 && artist.length > 1 && credited.some((h) => h === artist);
}

export async function fetchLyrics(track, durationSeconds, options = {}) {
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? sharedFetch : null);
  if (!fetchImpl) return { kind: 'none', lines: [], plain: '' };
  const duration = Math.round(Number(durationSeconds) || 0);
  const key = `${(track && track.videoId) || ''}|${norm(track && track.title)}|${duration}`;
  if (cache.has(key)) return cache.get(key);
  // saved answers are kept, except an "instrumental" one (saved by an older, looser match): that one is looked up again
  const stored = readLocal(key);
  if (stored && stored.kind && stored.kind !== 'instrumental') { cache.set(key, stored); return stored; }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 9000) : null;
  const signal = controller ? controller.signal : undefined;
  let result = { kind: 'none', lines: [], plain: '' };
  let failed = false;
  const stats = { ok: 0, failed: 0 };
  try {
    const wanted = candidatesFor(track);
    let bestExact = null;
    let bestExactScore = -Infinity;
    // 1. the exact lookup (artist, title and length within two seconds), 2. the search, the entry whose length and name fit best and that has timed lines
    for (const c of wanted) {
      const params = new URLSearchParams({ artist_name: c.artist, track_name: c.title });
      if (duration > 0) params.set('duration', String(duration));
      const body = await getJson(`${ENDPOINT}/get?${params.toString()}`, fetchImpl, signal, stats);
      let got = fromRecord(body);
      if (got && got.kind === 'instrumental' && !sureInstrumental(body, c, duration)) got = null;
      const matches = got
        && similarity(got.identity.title, c.title) >= 0.9
        && artistMatches(c.artist, got.identity.artist);
      if (!matches) continue;
      const timing = lyricsDurationFit(got, duration);
      if (!timing.matches) continue;
      const score = 3 + similarity(got.identity.title, c.title) + (got.kind === 'synced' ? 0.6 : 0) - timing.penalty;
      if (score > bestExactScore) {
        bestExact = got;
        bestExactScore = score;
      }
    }
    if (bestExact) result = bestExact;
    if (result.kind === 'none' || result.kind === 'plain') {
      // not found under the name the channel gives: by the title of the song alone, the artist is whoever the entry says
      const hit = await searchBest(track, duration, fetchImpl, signal, stats);
      let got = hit ? fromRecord(hit.record) : null;
      if (got && got.kind === 'instrumental' && !(hit && sureSearchInstrumental(hit, track))) got = null;
      if (got && (got.kind === 'synced' || result.kind === 'none') && (!result.score || hit.score >= -result.score)) result = got;
    }
  } catch (error) {
    // something unexpected: not remembered, asked again next time
    failed = true;
  } finally {
    if (timer) clearTimeout(timer);
  }
  // requests that failed (no connection, a slow answer, the service down or too busy) only count when the others found nothing: a song that is not there is "none", not an error
  if (result.kind === 'none' && stats.failed > 0) failed = true;
  if (!failed) {
    cache.set(key, result);
    if (result.kind !== 'none') writeLocal(key, result);
  }
  return failed ? { kind: 'error', lines: [], plain: '' } : result;
}
