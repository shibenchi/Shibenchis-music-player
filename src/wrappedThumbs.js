import { isLocalTrack } from './localAudio';

// the songs this device knows about (the queue, the playlists, the song playing), so the wrapped story can put a picture to a song that
// the account listened to before the server kept the video of each stretch. a song is found by its title and artist, the way the server
// counts them. the person's own audio files have no picture on youtube, so they are left out
const keyOf = (title, author) => `${String(title || '').trim().toLowerCase()}|${String(author || '').trim().toLowerCase()}`;

export function buildTrackIndex(lists) {
  const byKey = new Map();
  const byAuthor = new Map();
  const tracks = [];
  (Array.isArray(lists) ? lists : []).forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((track) => {
      if (!track || !String(track.title || '').trim() || isLocalTrack(track)) return;
      const videoId = /^[\w-]{11}$/.test(String(track.videoId || '')) ? String(track.videoId) : '';
      const thumbnail = typeof track.thumbnail === 'string' && /^https?:\/\//.test(track.thumbnail) ? track.thumbnail : '';
      if (!videoId && !thumbnail) return;
      const key = keyOf(track.title, track.author);
      if (byKey.has(key)) return;
      const entry = { videoId, thumbnail, title: String(track.title).trim(), author: String(track.author || '').trim() };
      byKey.set(key, entry);
      tracks.push(entry);
      const authorKey = entry.author.toLowerCase();
      if (authorKey && !byAuthor.has(authorKey)) byAuthor.set(authorKey, entry);
    });
  });
  return {
    // a song by title and artist, or (with no title) any song of the artist
    lookup: (title, author) => (String(title || '').trim() ? byKey.get(keyOf(title, author)) : byAuthor.get(String(author || '').trim().toLowerCase())) || null,
    tracks
  };
}
