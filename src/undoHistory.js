// the list of recent changes to playlists and the queue, newest first, and how to take each one back. it is kept on this device (per account) so
// a song removed by accident can still be put back after the app was closed. everything here is plain data in, plain data out: App.js owns
// the state and calls these.
//
// an entry: { id, at (ms), kind, label (what to show), data (what is needed to undo it) }
//   track-removed    { playlistId, index, track, beforeKey, afterKey }   (the keys of the songs that were next to it)
//   playlist-cleared { playlistId, tracks }
//   playlist-deleted { playlist, index }
//   playlist-renamed { playlistId, from, to }
//   playlist-created { playlistId }
//   track-added      { playlistId, videoId, addedAt }
//   tracks-added     { playlistId, keys: ['videoId:addedAt', ...] }
//   queue-removed    { index, track, beforeId, afterId }
//   queue-cleared    { tracks }
//   queue-added      { videoIds }   (taking it back takes the last copies of those songs out of the queue)
//   collab-track-removed { serverId, playlistId, track }

export const HISTORY_LIMIT = 40;

const trackKey = (track) => `${track && track.videoId}:${track && track.addedAt}`;

export function makeEntry(kind, label, data, now = Date.now()) {
  return { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: now, kind, label, data };
}

export function loadHistory(storage, key) {
  try {
    const raw = storage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((entry) => entry && entry.id && entry.kind && entry.label).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveHistory(storage, key, list) {
  try {
    storage.setItem(key, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    // not remembered after a restart
  }
}

export function pushEntry(list, entry) {
  return [entry, ...list].slice(0, HISTORY_LIMIT);
}

export function dropEntry(list, id) {
  return list.filter((entry) => entry.id !== id);
}

// "3 min ago", "2 h ago", "yesterday", then the date
export function agoText(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

// takes one change back on the list of playlists. { ok: true, playlists, playlistId? } (playlistId: the playlist to show afterwards) or
// { ok: false, reason }
export function undoOnPlaylists(playlists, entry) {
  const d = entry.data || {};
  const has = (id) => playlists.some((p) => p.id === id);
  switch (entry.kind) {
    case 'track-removed': {
      if (!has(d.playlistId)) return { ok: false, reason: 'that playlist is gone' };
      return {
        ok: true,
        playlistId: d.playlistId,
        playlists: playlists.map((p) => {
          if (p.id !== d.playlistId) return p;
          // back before the song that followed it, else after the one that came before it, else where it was by number. this way a
          // change that is taken back out of order (not the last one first) still ends up in the right place
          const next = d.beforeKey ? p.tracks.findIndex((track) => trackKey(track) === d.beforeKey) : -1;
          const prev = d.afterKey ? p.tracks.findIndex((track) => trackKey(track) === d.afterKey) : -1;
          const at = next >= 0 ? next : prev >= 0 ? prev + 1 : Math.max(0, Math.min(Number(d.index) || 0, p.tracks.length));
          return { ...p, tracks: [...p.tracks.slice(0, at), d.track, ...p.tracks.slice(at)] };
        })
      };
    }
    case 'playlist-cleared': {
      if (!has(d.playlistId)) return { ok: false, reason: 'that playlist is gone' };
      return {
        ok: true,
        playlistId: d.playlistId,
        playlists: playlists.map((p) => {
          if (p.id !== d.playlistId) return p;
          const back = new Set((d.tracks || []).map(trackKey));
          // what was put in the playlist since stays, after the songs that come back
          return { ...p, tracks: [...(d.tracks || []), ...p.tracks.filter((track) => !back.has(trackKey(track)))] };
        })
      };
    }
    case 'playlist-deleted': {
      if (!d.playlist) return { ok: false, reason: 'nothing to bring back' };
      if (has(d.playlist.id)) return { ok: false, reason: 'that playlist is already there' };
      const at = Math.max(0, Math.min(Number(d.index) || 0, playlists.length));
      return { ok: true, playlistId: d.playlist.id, playlists: [...playlists.slice(0, at), d.playlist, ...playlists.slice(at)] };
    }
    case 'playlist-renamed': {
      if (!has(d.playlistId)) return { ok: false, reason: 'that playlist is gone' };
      return { ok: true, playlistId: d.playlistId, playlists: playlists.map((p) => (p.id === d.playlistId ? { ...p, name: d.from } : p)) };
    }
    case 'playlist-created': {
      if (!has(d.playlistId)) return { ok: false, reason: 'that playlist is gone' };
      if (playlists.filter((p) => p.type !== 'collab').length <= 1) return { ok: false, reason: 'it is the only playlist' };
      return { ok: true, playlists: playlists.filter((p) => p.id !== d.playlistId) };
    }
    case 'track-added': {
      if (!has(d.playlistId)) return { ok: false, reason: 'that playlist is gone' };
      let found = false;
      const next = playlists.map((p) => {
        if (p.id !== d.playlistId) return p;
        const at = p.tracks.findIndex((track) => track.videoId === d.videoId && track.addedAt === d.addedAt);
        if (at < 0) return p;
        found = true;
        return { ...p, tracks: p.tracks.filter((_, i) => i !== at) };
      });
      return found ? { ok: true, playlistId: d.playlistId, playlists: next } : { ok: false, reason: 'that song is not in the playlist any more' };
    }
    case 'tracks-added': {
      if (!has(d.playlistId)) return { ok: false, reason: 'that playlist is gone' };
      const keys = new Set(d.keys || []);
      let removed = 0;
      const next = playlists.map((p) => {
        if (p.id !== d.playlistId) return p;
        const tracks = p.tracks.filter((track) => {
          if (keys.has(trackKey(track))) { removed += 1; return false; }
          return true;
        });
        return { ...p, tracks };
      });
      return removed ? { ok: true, playlistId: d.playlistId, playlists: next } : { ok: false, reason: 'those songs are not in the playlist any more' };
    }
    default:
      return { ok: false, reason: 'cannot undo that here' };
  }
}

// the same for the queue. playIndex is where the player stands in it (-1 for none), it moves along when songs come back before it
export function undoOnQueue(queue, entry, playIndex = -1) {
  const d = entry.data || {};
  if (entry.kind === 'queue-removed') {
    const next = d.beforeId ? queue.findIndex((track) => track.videoId === d.beforeId) : -1;
    const prev = d.afterId ? queue.findIndex((track) => track.videoId === d.afterId) : -1;
    const at = next >= 0 ? next : prev >= 0 ? prev + 1 : Math.max(0, Math.min(Number(d.index) || 0, queue.length));
    return { ok: true, queue: [...queue.slice(0, at), d.track, ...queue.slice(at)], playIndex: playIndex >= 0 && at <= playIndex ? playIndex + 1 : playIndex };
  }
  if (entry.kind === 'queue-added') {
    const left = [...queue];
    const removedAt = [];
    (d.videoIds || []).forEach((id) => {
      for (let i = left.length - 1; i >= 0; i -= 1) {
        if (left[i].videoId === id) {
          removedAt.push(i);
          left.splice(i, 1);
          break;
        }
      }
    });
    if (!removedAt.length) return { ok: false, reason: 'those songs are not in the queue any more' };
    // the song that is playing keeps its place: the songs taken out before it move it back by one each
    let nextPlay = playIndex;
    removedAt.forEach((at) => { if (nextPlay >= 0 && at < nextPlay) nextPlay -= 1; });
    if (nextPlay >= left.length) nextPlay = left.length - 1;
    return { ok: true, queue: left, playIndex: nextPlay };
  }
  if (entry.kind === 'queue-cleared') {
    const back = new Set((d.tracks || []).map((track) => track.videoId));
    return { ok: true, queue: [...(d.tracks || []), ...queue.filter((track) => !back.has(track.videoId))], playIndex: playIndex >= 0 ? playIndex + (d.tracks || []).length : playIndex };
  }
  return { ok: false, reason: 'cannot undo that here' };
}

export const keysOf = (tracks) => tracks.map(trackKey);
