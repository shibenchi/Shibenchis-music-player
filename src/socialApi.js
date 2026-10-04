// social stuff (auth, friends, dms, servers, collab playlists, chat) all
// runs off the SAME local backend as everything else now, no separate
// remote server anymore.
//
// REACT_APP_SOCIAL_API_BASE_URL / REACT_APP_SOCIAL_WS_BASE point the app at a
// hosted backend (the purdue hackers club server). leave them unset for normal
// local use, relative paths already just work in dev and prod, and they still
// work fine if my phone hits the desktop's LAN IP instead of localhost
//
// REACT_APP_SOCIAL_API_FALLBACK_URL is a second address for the same server.
// some networks (purdue residence wifi) cannot reach the club server's address
// at all, so the same server is also published through a tunnel on another
// address. the app uses the main one when it answers and the tunnel one when it
// does not, and remembers which worked last
// names this copy of the app to the server. a change saved from here comes back
// over the websocket like it does for every other device, and this id is how the
// app tells its own change from someone else's
const CLIENT_ID = `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const clean = (value) => String(value || '').trim().replace(/\/+$/, '');

const SOCIAL_API_BASE_URL = clean(process.env.REACT_APP_SOCIAL_API_BASE_URL);
const SOCIAL_FALLBACK_URL = clean(process.env.REACT_APP_SOCIAL_API_FALLBACK_URL);
// the addresses the app may talk to, main one first. fewer than two means there
// is nothing to switch between and every call behaves exactly as it always did
const SOCIAL_BASES = [SOCIAL_API_BASE_URL, SOCIAL_FALLBACK_URL].filter((base, index, all) => base && all.indexOf(base) === index);

const BASE_STORAGE_KEY = 'music_social_base';
const WS_PATH = '/smp-ws';

function defaultSocialWsBase() {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // `npm run dev` serves the page from CRA on port 3000 and proxies api calls
  // to the app server on 3001. that proxy also carries websockets, and it
  // takes the whole dev server down with an unhandled ECONNRESET whenever a tab
  // with a live socket closes. so in dev the socket goes straight to 3001 on
  // whatever host the page was opened from (works from another device on the
  // network too). anywhere else it is just the page's own origin
  if (process.env.NODE_ENV === 'development' && window.location.port === '3000') {
    return `${protocol}//${window.location.hostname}:3001/smp-ws`;
  }
  // gotta be '/smp-ws' not '/ws' - CRA's own hot-reload socket squats on
  // '/ws' in dev and steals the connection otherwise, took me a bit to
  // figure out why messages just werent showing up
  return `${protocol}//${window.location.host}/smp-ws`;
}

const SOCIAL_WS_BASE = process.env.REACT_APP_SOCIAL_WS_BASE || defaultSocialWsBase();

// the websocket address that goes with one of the http addresses
function wsBaseFor(base) {
  if (!base) return SOCIAL_WS_BASE;
  if (base === SOCIAL_API_BASE_URL && process.env.REACT_APP_SOCIAL_WS_BASE) return process.env.REACT_APP_SOCIAL_WS_BASE;
  return `${base.replace(/^http/i, 'ws')}${WS_PATH}`;
}

// which address is in use right now. starts on the one that worked last time
// (so a launch on residence wifi does not wait for the blocked one), the main
// one otherwise
let activeBase = SOCIAL_API_BASE_URL;
let baseWasRemembered = false;
if (SOCIAL_BASES.length > 1 && typeof window !== 'undefined') {
  try {
    const saved = window.localStorage.getItem(BASE_STORAGE_KEY);
    if (saved && SOCIAL_BASES.includes(saved)) {
      activeBase = saved;
      baseWasRemembered = true;
    }
  } catch {
    // storage can be blocked, the main address is fine
  }
}

const baseListeners = new Set();

function setActiveBase(next) {
  if (!next || next === activeBase) return false;
  activeBase = next;
  try {
    window.localStorage.setItem(BASE_STORAGE_KEY, next);
  } catch {
    // not remembered, picked again next launch
  }
  baseListeners.forEach((listener) => {
    try { listener(next); } catch { /* a listener failing is not our problem */ }
  });
  return true;
}

// told when the app switches addresses, so the websocket can reconnect to the
// new one. returns the function that stops listening
function onSocialBaseChange(listener) {
  baseListeners.add(listener);
  return () => baseListeners.delete(listener);
}

// does this address answer? any good reply from the server counts
async function answers(base, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/auth/session`, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let choosing = null;
let lastChosenAt = 0;

// finds the address to use. both are tried at the same moment and the main one
// gets a head start: if it has not answered in a second and a half it is
// probably blocked on this network and the tunnel one is taken as soon as it
// answers. only one search runs at a time. resolves true if the address changed
function chooseSocialBase() {
  if (SOCIAL_BASES.length < 2) return Promise.resolve(false);
  if (choosing) return choosing;
  const [main, backup] = SOCIAL_BASES;
  choosing = (async () => {
    const mainTry = answers(main, 6000);
    const backupTry = answers(backup, 6000);
    const quick = await Promise.race([mainTry, new Promise((resolve) => setTimeout(() => resolve(false), 1500))]);
    let winner = quick ? main : null;
    if (!winner) {
      winner = await new Promise((resolve) => {
        let waiting = 2;
        const settle = (base, ok) => {
          if (ok) resolve(base);
          else if (--waiting === 0) resolve(null);
        };
        mainTry.then((ok) => settle(main, ok));
        backupTry.then((ok) => settle(backup, ok));
      });
    }
    // neither answered: offline. stay where we are, the next call looks again
    return setActiveBase(winner);
  })().finally(() => {
    choosing = null;
    lastChosenAt = Date.now();
  });
  return choosing;
}

// a call to the active address failed to connect: look again, unless we only
// just looked. resolves true if the address changed so the call can be retried
async function retargetSocialBase() {
  if (SOCIAL_BASES.length < 2) return false;
  if (!choosing && Date.now() - lastChosenAt < 5000) return false;
  return chooseSocialBase();
}

// the very first launch has no remembered address, so calls wait for this to
// finish before they go out. on later launches it still runs (the network may
// have changed since) but nothing waits for it
let firstPick = null;
if (SOCIAL_BASES.length > 1 && typeof window !== 'undefined') {
  const pick = chooseSocialBase();
  if (!baseWasRemembered) firstPick = pick;
  // and again whenever the device says it is back online
  window.addEventListener('online', () => { chooseSocialBase(); });
}

// ws url, optionally with a session id tacked on
function getSocialWsUrl(sessionId = null) {
  const base = SOCIAL_BASES.length > 1 ? wsBaseFor(activeBase) : SOCIAL_WS_BASE;
  if (sessionId) {
    return `${base}?sid=${encodeURIComponent(sessionId)}`;
  }
  return base;
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
  if (!activeBase) {
    return path; // same server as everything else, dont overthink it
  }
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return `${activeBase}${cleanPath}`;
}

// one try against the address in use. when there are two addresses a call that
// gets no answer in 15 seconds is cut off, otherwise a blocked network leaves it
// hanging for minutes before the other address ever gets a turn
async function fetchOnce(path, options) {
  if (SOCIAL_BASES.length < 2) return fetch(socialUrl(path), options);

  const controller = new AbortController();
  const caller = options.signal;
  const onCallerAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(socialUrl(path), { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (caller) caller.removeEventListener('abort', onCallerAbort);
  }
}

// runs a call and, if it could not connect and the other address works, runs it
// once more there. a call the caller itself gave up on is not retried
async function withFailover(run, callerSignal) {
  if (firstPick) await firstPick;
  try {
    return await run();
  } catch (error) {
    if (SOCIAL_BASES.length < 2) throw error;
    if (callerSignal?.aborted) {
      retargetSocialBase();
      throw error;
    }
    if (!(await retargetSocialBase())) throw error;
    return run();
  }
}

// fetch wrapper that adds the auth token/credentials automatically so i
// dont have to remember to do it everywhere
async function socialFetch(path, options = {}) {
  const authToken = typeof window !== 'undefined' ? window.localStorage.getItem('music_auth_token') : null;

  const fetchOptions = {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': CLIENT_ID,
      ...(authToken ? { 'X-Auth-Token': authToken } : {}),
      ...options.headers
    }
  };

  return withFailover(() => fetchOnce(path, fetchOptions), options.signal);
}

export {
  CLIENT_ID,
  SOCIAL_API_BASE_URL,
  SOCIAL_WS_BASE,
  getSocialWsUrl,
  onSocialBaseChange,
  retargetSocialBase,
  socialUrl,
  socialFetch,
  isSocialEndpoint
};
