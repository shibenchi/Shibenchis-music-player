// audio files that live on this device only. the file itself goes into this browser's own storage (IndexedDB) and
// never leaves it; what goes into queues and playlists is a track that points at it by id (local:<hash>), so it
// syncs like any other song and shows up as a greyed entry on a device that does not have the file
import { readAudioTags } from './audioTags';

export const LOCAL_PREFIX = 'local:';
export const MAX_LOCAL_FILE_BYTES = 300 * 1024 * 1024;

export const isLocalTrack = (track) => {
  if (!track) return false;
  if (track.source === 'local' || track.provider === 'local') return true;
  const id = String(track.videoId || track.video_id || track.id || '');
  return id.startsWith(LOCAL_PREFIX);
};

const DB_NAME = 'smp-local-audio';
const STORE = 'files';
const MIME_BY_EXTENSION = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', weba: 'audio/webm'
};
export const AUDIO_ACCEPT = Object.keys(MIME_BY_EXTENSION).map((ext) => '.' + ext).join(',') + ',audio/*';

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('this browser cannot keep files'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('could not open the file storage'));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

const wrap = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function withStore(mode, run) {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('the file could not be saved (is the storage full?)'));
  });
  const result = await run(tx.objectStore(STORE));
  await done;
  return result;
}

// ---- who has which file, so rows can show a missing one ----------------------
let have = new Set();
const listeners = new Set();
const emit = () => listeners.forEach((listener) => { try { listener(have); } catch (e) { /* a listener must not break the others */ } });
export const subscribeLocalFiles = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const localFileIds = () => have;

export async function refreshLocalFiles() {
  try {
    const keys = await withStore('readonly', (store) => wrap(store.getAllKeys()));
    have = new Set(keys);
  } catch (e) {
    have = new Set();
  }
  emit();
  return have;
}

// ---- the id of a file: a hash of its size and a handful of slices of it ------
async function hashHex(buffer) {
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // no subtle crypto (an insecure origin): a plain fnv over the same bytes, doubled to the same length
  const bytes = new Uint8Array(buffer);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < bytes.length; i += 1) {
    a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
    b = Math.imul(b + bytes[i] + i, 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(4);
}

export async function localIdFor(file) {
  const SLICE = 256 * 1024;
  const parts = [new TextEncoder().encode(String(file.size) + ':')];
  if (file.size <= 4 * SLICE) {
    parts.push(new Uint8Array(await file.arrayBuffer()));
  } else {
    const at = [0, file.size - SLICE, Math.floor(file.size * 0.25), Math.floor(file.size * 0.5), Math.floor(file.size * 0.75)];
    for (const start of at) parts.push(new Uint8Array(await file.slice(start, start + SLICE).arrayBuffer()));
  }
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => { all.set(part, offset); offset += part.length; });
  return LOCAL_PREFIX + (await hashHex(all.buffer)).slice(0, 32);
}

// how long the browser says the file is, which is also the check that it can play it here at all
function probeDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const probe = new Audio();
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      probe.load();
      URL.revokeObjectURL(url);
      fn(value);
    };
    const timer = setTimeout(() => finish(resolve, 0), 12000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => finish(resolve, Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0);
    probe.onerror = () => finish(reject, new Error('this device cannot play that kind of file'));
    probe.src = url;
  });
}

const extensionOf = (name) => (/\.([a-z0-9]{2,5})$/i.exec(String(name || '')) || [])[1]?.toLowerCase() || '';

export function looksLikeAudio(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('audio/')) return true;
  return Boolean(MIME_BY_EXTENSION[extensionOf(file.name)]);
}

// keeps the file on this device and gives back the track that points at it.
// { track, duplicate } or throws with a reason a person can read
export async function addLocalFile(file) {
  if (!looksLikeAudio(file)) throw new Error('that is not an audio file');
  if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error('that file is bigger than ' + Math.round(MAX_LOCAL_FILE_BYTES / 1024 / 1024) + ' MB');
  const ext = extensionOf(file.name);
  const type = file.type && file.type.startsWith('audio/') ? file.type : MIME_BY_EXTENSION[ext] || 'audio/mpeg';
  const id = await localIdFor(file);
  const tags = await readAudioTags(file);
  const blob = file.type === type ? file : new Blob([file], { type });
  let durationMs = await probeDuration(blob);
  if (!durationMs) durationMs = tags.durationMs || 0;
  const existing = await withStore('readonly', (store) => wrap(store.getKey(id)));
  const duplicate = existing !== undefined;
  if (!duplicate) {
    const cover = tags.cover && tags.cover.bytes && tags.cover.bytes.length ? new Blob([tags.cover.bytes], { type: tags.cover.mime || 'image/jpeg' }) : null;
    await withStore('readwrite', (store) => wrap(store.put({
      id,
      blob,
      cover,
      name: file.name || '',
      size: file.size,
      type,
      title: tags.title,
      artist: tags.artist,
      durationMs,
      addedAt: Date.now()
    })));
    have = new Set(have).add(id);
    emit();
  }
  return {
    duplicate,
    track: {
      videoId: id,
      id,
      source: 'local',
      provider: 'local',
      format: ext || 'audio',
      title: tags.title,
      author: tags.artist,
      durationMs,
      thumbnail: ''
    }
  };
}

export async function removeLocalFile(id) {
  await withStore('readwrite', (store) => wrap(store.delete(id)));
  forget(id);
  have = new Set(have);
  have.delete(id);
  emit();
}

export async function localFileSizes() {
  try {
    return await withStore('readonly', (store) => new Promise((resolve, reject) => {
      const sizes = {};
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(sizes); return; }
        sizes[cursor.value.id] = cursor.value.size || 0;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    }));
  } catch (e) {
    return {};
  }
}

// ---- blob urls the audio element and the cover images use ----------------------
const urls = new Map(); // key -> url, oldest first
const MAX_URLS = 8;
function remember(key, url) {
  urls.set(key, url);
  while (urls.size > MAX_URLS) {
    const [oldKey, oldUrl] = urls.entries().next().value;
    urls.delete(oldKey);
    URL.revokeObjectURL(oldUrl);
  }
}
function forget(id) {
  ['file:' + id, 'cover:' + id].forEach((key) => {
    if (urls.has(key)) {
      URL.revokeObjectURL(urls.get(key));
      urls.delete(key);
    }
  });
}

export async function localFileUrl(id) {
  if (urls.has('file:' + id)) {
    const url = urls.get('file:' + id);
    urls.delete('file:' + id);
    urls.set('file:' + id, url); // freshest
    return url;
  }
  const record = await withStore('readonly', (store) => wrap(store.get(id))).catch(() => null);
  if (!record || !record.blob) return '';
  const url = URL.createObjectURL(record.blob);
  remember('file:' + id, url);
  return url;
}

export async function localCoverUrl(id) {
  if (urls.has('cover:' + id)) return urls.get('cover:' + id);
  const record = await withStore('readonly', (store) => wrap(store.get(id))).catch(() => null);
  if (!record || !record.cover) return '';
  const url = URL.createObjectURL(record.cover);
  remember('cover:' + id, url);
  return url;
}

// every file off this device (the songs in queues and playlists stay, as entries without a file)
export async function clearLocalFiles() {
  await withStore('readwrite', (store) => wrap(store.clear()));
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
  have = new Set();
  emit();
}

// ---- a file that came from somewhere else (a room): kept on this device like any file that was picked here
export async function getLocalFileRecord(id) {
  const record = await withStore('readonly', (store) => wrap(store.get(id))).catch(() => null);
  return record || null;
}

export async function saveLocalBlob(id, blob, meta = {}) {
  const existing = await withStore('readonly', (store) => wrap(store.getKey(id)));
  if (existing !== undefined) return false;
  let cover = meta.cover || null;
  if (!cover) {
    const tags = await readAudioTags(Object.assign(blob, { name: meta.name || '' })).catch(() => null);
    if (tags && tags.cover && tags.cover.bytes && tags.cover.bytes.length) cover = new Blob([tags.cover.bytes], { type: tags.cover.mime || 'image/jpeg' });
  }
  await withStore('readwrite', (store) => wrap(store.put({
    id,
    blob,
    cover,
    name: meta.name || '',
    size: blob.size,
    type: blob.type || meta.type || 'audio/mpeg',
    title: meta.title || '',
    artist: meta.artist || '',
    durationMs: meta.durationMs || 0,
    addedAt: Date.now()
  })));
  have = new Set(have).add(id);
  emit();
  return true;
}
