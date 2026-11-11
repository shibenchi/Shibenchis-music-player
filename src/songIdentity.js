// who a song is really by. a song that was uploaded by somebody who is not the artist ("illmatic - 10 - Nas - It Ain't Hard to Tell" from a channel nobody knows) is credited to
// the uploader everywhere the player says "by": the stats, what friends see. this finds the song in two public collections that allow requests from a web page, by the TITLE of
// the song and its length: LRCLIB first (the same search the lyrics use), then the iTunes Search API (Apple's public catalogue, no account). the answer is only used when it is
// sure: the entry's title fits a piece of the title almost exactly (0.9) and its length is within three seconds of the song's.
// a channel that is "Artist - Topic" or "ArtistVEVO" is the artist already and is left alone. every answer, a miss too, is kept on the device for good (a miss for a week)
import { norm, searchBest, similarity, titlePieces, cleanArtist, sharedFetch } from './lyrics';

const memory = new Map();
const LOCAL_PREFIX = 'music_identity:';
const MISS_MS = 7 * 24 * 60 * 60 * 1000;
const ITUNES = 'https://itunes.apple.com/search';

const isTrusted = (author) => /-\s*topic\s*$/i.test(String(author || '')) || /vevo\s*$/i.test(String(author || ''));

function readLocal(key) {
  try { return JSON.parse(window.localStorage.getItem(LOCAL_PREFIX + key)); } catch { return null; }
}
function writeLocal(key, value) {
  try { window.localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value)); } catch { /* not remembered */ }
}

async function viaItunes(track, duration, fetchImpl, signal) {
  const { pieces, hints } = titlePieces(track.title);
  const hintNorm = [...hints, cleanArtist(track.author)].map(norm).filter(Boolean);
  for (const piece of pieces.slice(0, 2)) {
    const params = new URLSearchParams({ term: piece, entity: 'song', limit: '10' });
    const response = await fetchImpl(`${ITUNES}?${params.toString()}`, { signal });
    if (!response.ok) continue;
    const body = await response.json();
    let best = null;
    (Array.isArray(body.results) ? body.results : []).forEach((record) => {
      const seconds = record.trackTimeMillis ? record.trackTimeMillis / 1000 : 0;
      const gap = duration > 0 && seconds ? Math.abs(seconds - duration) : 0;
      const nameSim = similarity(record.trackName, piece);
      if (gap > 3 || nameSim < 0.9) return;
      const artistN = norm(record.artistName);
      let score = nameSim * 2 - gap / 3;
      if (artistN.length > 1 && hintNorm.some((h) => h === artistN || (artistN.length > 2 && h.split(' ').includes(artistN)))) score += 1.5;
      if (!best || score > best.score) best = { record, score };
    });
    if (best) return { artist: String(best.record.artistName || ''), title: String(best.record.trackName || '') };
  }
  return null;
}

// { artist, title } for the song, or null (it is already credited right, or nothing sure was found, or there is no connection: asked again later)
export async function identifyTrack(track, durationSeconds, options = {}) {
  if (!track || !track.title || isTrusted(track.author)) return null;
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? sharedFetch : null);
  const duration = Math.round(Number(durationSeconds) || 0);
  if (!fetchImpl || duration <= 0) return null;
  const key = `${track.videoId || norm(track.title)}`;
  if (memory.has(key)) return memory.get(key);
  const stored = readLocal(key);
  if (stored && stored.artist) { memory.set(key, stored); return stored; }
  if (stored && stored.miss && Date.now() - stored.miss < MISS_MS) { memory.set(key, null); return null; }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 9000) : null;
  const signal = controller ? controller.signal : undefined;
  let found = null;
  let failed = false;
  const stats = { ok: 0, failed: 0 };
  try {
    const hit = await searchBest(track, duration, fetchImpl, signal, stats);
    if (hit && hit.nameSim >= 0.9 && hit.gap <= 3 && hit.record.artistName) found = { artist: String(hit.record.artistName), title: String(hit.record.trackName || track.title) };
    if (!found) found = await viaItunes(track, duration, fetchImpl, signal);
  } catch (error) {
    failed = true;
  } finally {
    if (timer) clearTimeout(timer);
  }
  // a request that failed only counts when nothing was found by the others (a miss is kept, an error is asked again later)
  if (!found && stats.failed > 0) failed = true;
  if (failed) return null;
  // the same name as the channel gives is nothing to change
  const unchanged = found && norm(found.artist) === norm(cleanArtist(track.author)) && norm(found.title) === norm(track.title);
  const answer = found && !unchanged ? found : null;
  memory.set(key, answer);
  writeLocal(key, answer || { miss: Date.now() });
  return answer;
}
