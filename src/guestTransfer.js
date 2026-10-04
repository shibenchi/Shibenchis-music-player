import { socialFetch } from './socialApi';

// what someone built before making an account (their queue, playlists, theme
// color and player settings) lives in this browser under "guest" keys. when an
// account with nothing in it signs in, that data is carried over so signing up
// does not mean starting from scratch. an account that already has its own
// playlists or queue is never touched.

const DEFAULT_COLOR = { r: 255, g: 89, b: 0 };

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function parseColor(raw) {
  if (!raw) return null;
  const [r, g, b] = String(raw).split(',').map(Number);
  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null;
  return { r, g, b };
}

function isDefaultColor(color) {
  return color.r === DEFAULT_COLOR.r && color.g === DEFAULT_COLOR.g && color.b === DEFAULT_COLOR.b;
}

async function callApi(path, options) {
  const res = await socialFetch(path, options);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

// the per-user local keys (player settings, eq, visualizer) are copied across
// when the account has none of its own yet
function copyLocalSettings(userId) {
  ['music_player_prefs', 'music_eq', 'music_visualizer_preset'].forEach((base) => {
    try {
      const guestValue = window.localStorage.getItem(`${base}:guest`);
      const userKey = `${base}:${userId}`;
      if (guestValue !== null && window.localStorage.getItem(userKey) === null) {
        window.localStorage.setItem(userKey, guestValue);
      }
    } catch {
      // storage can be blocked, nothing to do about it
    }
  });
}

// returns what was moved, e.g. { playlists: 2, tracks: 153, queue: 40, color: true }
export async function transferGuestDataToAccount(user) {
  const moved = {};
  if (!user || !user.id || typeof window === 'undefined') return moved;

  copyLocalSettings(user.id);

  const guestPlaylists = readJson('music_playlists_guest', [])
    .filter((p) => p && Array.isArray(p.tracks) && (p.tracks.length > 0 || p.id !== 'default'));
  const guestQueue = (readJson('music_queue_state:guest', {}).queue || [])
    .filter((track) => track && (track.videoId || track.video_id || track.id));
  const guestColor = parseColor(window.localStorage.getItem('music_theme_color_guest'));
  const hasGuestColor = guestColor && !isDefaultColor(guestColor);

  if (!guestPlaylists.length && !guestQueue.length && !hasGuestColor) return moved;

  // what the account already holds
  let accountPlaylists = [];
  let accountQueue = [];
  let accountSettings = null;
  try { accountPlaylists = (await callApi('/api/user/playlists')).playlists || []; } catch { /* treated as empty */ }
  try { accountQueue = (await callApi('/api/user/queue')).queue || []; } catch { /* treated as empty */ }
  try { accountSettings = (await callApi('/api/user/settings')).settings || null; } catch { /* treated as default */ }

  const accountHasTracks = accountPlaylists.some((p) => Array.isArray(p.tracks) && p.tracks.length > 0);

  if (!accountHasTracks && guestPlaylists.length) {
    try {
      await callApi('/api/user/playlists-sync', {
        method: 'PUT',
        body: JSON.stringify({ playlists: guestPlaylists })
      });
      moved.playlists = guestPlaylists.length;
      moved.tracks = guestPlaylists.reduce((sum, p) => sum + p.tracks.length, 0);
    } catch (error) {
      console.warn('Could not move guest playlists:', error);
    }
  }

  if (!accountQueue.length && guestQueue.length) {
    try {
      await callApi('/api/user/queue', {
        method: 'PUT',
        body: JSON.stringify({ queue: guestQueue })
      });
      moved.queue = guestQueue.length;
    } catch (error) {
      console.warn('Could not move guest queue:', error);
    }
  }

  // the color only moves if the account is still on the default one
  const accountColor = accountSettings
    ? { r: accountSettings.theme_color_r, g: accountSettings.theme_color_g, b: accountSettings.theme_color_b }
    : DEFAULT_COLOR;
  if (hasGuestColor && isDefaultColor(accountColor)) {
    try {
      await callApi('/api/user/settings', {
        method: 'POST',
        body: JSON.stringify({
          theme_color_r: guestColor.r,
          theme_color_g: guestColor.g,
          theme_color_b: guestColor.b,
          debug_mode: Boolean(accountSettings && accountSettings.debug_mode)
        })
      });
      moved.color = true;
    } catch (error) {
      console.warn('Could not move guest theme color:', error);
    }
  }

  if (Object.keys(moved).length) {
    try {
      window.sessionStorage.setItem('music_guest_transfer_note', JSON.stringify(moved));
    } catch {
      // the note is only a courtesy
    }
  }
  return moved;
}
