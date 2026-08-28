// social stuff (auth, friends, dms, servers, collab playlists, chat) all
// runs off the SAME local backend as everything else now, no separate
// remote server anymore.
//
// REACT_APP_SOCIAL_API_BASE_URL / REACT_APP_SOCIAL_WS_BASE only matter if i
// ever point this at an actual hosted backend later (free uni cloud
// hosting maybe lol). leave unset for normal local use, relative paths
// already just work in dev and prod, and they still work fine if my phone
// hits the desktop's LAN IP instead of localhost
const SOCIAL_API_BASE_URL = (process.env.REACT_APP_SOCIAL_API_BASE_URL || '').replace(/\/+$/, '');

function defaultSocialWsBase() {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // gotta be '/smp-ws' not '/ws' — CRA's own hot-reload socket squats on
  // '/ws' in dev and steals the connection otherwise, took me a bit to
  // figure out why messages just werent showing up
  return `${protocol}//${window.location.host}/smp-ws`;
}

const SOCIAL_WS_BASE = process.env.REACT_APP_SOCIAL_WS_BASE || defaultSocialWsBase();

// ws url, optionally with a session id tacked on
function getSocialWsUrl(sessionId = null) {
  if (sessionId) {
    return `${SOCIAL_WS_BASE}?sid=${encodeURIComponent(sessionId)}`;
  }
  return SOCIAL_WS_BASE;
}

// these prefixes get the auth-token/credentials treatment (matters when a
// phone on the lan hits the desktop's ip directly), they just dont get
// redirected off to some other host anymore by default
const SOCIAL_PREFIXES = [
  '/api/auth/',
  '/api/users',
  '/api/friends',
  '/api/messages/',
  '/api/servers',
  '/api/server/',
  '/api/collab/',
  '/api/user/'
];

// is this path one of the "social" endpoints (gets auth handling)? stuff
// like /api/stream, /api/download, /api/search stays local, doesnt need this
function isSocialEndpoint(path) {
  return SOCIAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// full url for a social endpoint - just the relative path unless i've set
// a base url at build time
function socialUrl(path) {
  if (!SOCIAL_API_BASE_URL) {
    return path; // same server as everything else, dont overthink it
  }
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return `${SOCIAL_API_BASE_URL}${cleanPath}`;
}

// fetch wrapper that adds the auth token/credentials automatically so i
// dont have to remember to do it everywhere
async function socialFetch(path, options = {}) {
  const url = socialUrl(path);
  const authToken = typeof window !== 'undefined' ? window.localStorage.getItem('music_auth_token') : null;

  const fetchOptions = {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { 'X-Auth-Token': authToken } : {}),
      ...options.headers
    }
  };

  return fetch(url, fetchOptions);
}

export { SOCIAL_API_BASE_URL, SOCIAL_WS_BASE, getSocialWsUrl, socialUrl, socialFetch, isSocialEndpoint };
