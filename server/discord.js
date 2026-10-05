// Discord rich presence for the desktop app: what is playing shows on the person's Discord
// profile as "Listening to ...". the Discord app on the same computer listens on a local
// pipe (windows) or socket (mac, linux) called discord-ipc-0, so nothing here goes over the
// internet and nothing has to be installed. the talk is frames of
// [opcode int32 LE][length int32 LE][json]

const net = require('net');
const path = require('path');
const crypto = require('crypto');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

// the application id of the Discord app that carries the name "Listening to ...". it is
// public (it is in every client that uses it), set by the maker in the Discord developer portal
const DEFAULT_CLIENT_ID = '1556469860219748363';
// the app's own icon (from the public repository): the small picture on the status, and the big one
// for a song that has no cover
const ICON_URL = 'https://raw.githubusercontent.com/shibenchi/Shibenchis-music-player/main/src-tauri/icons/icon.png';
const APP_NAME = "Shibenchi's Music Player";
const RELEASES_URL = 'https://github.com/shibenchi/Shibenchis-music-player/releases/latest';
const MIN_GAP_MS = 4000; // discord allows five updates per twenty seconds
const RETRY_MS = 15000; // between tries to reach a Discord that is not running
const HANDSHAKE_TIMEOUT_MS = 4000;
const REPLY_TIMEOUT_MS = 5000;

function candidatePaths() {
  const paths = [];
  for (let i = 0; i < 10; i += 1) {
    if (process.platform === 'win32') {
      paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    } else {
      const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
      paths.push(path.join(base, `discord-ipc-${i}`));
      if (process.platform === 'linux') {
        paths.push(path.join(base, 'app', 'com.discordapp.Discord', `discord-ipc-${i}`));
        paths.push(path.join(base, 'snap.discord', `discord-ipc-${i}`));
      }
    }
  }
  return paths;
}

function encode(opcode, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

// takes the bytes received so far, returns the whole frames in them and what is left over
function decode(buffer) {
  const frames = [];
  let rest = buffer;
  while (rest.length >= 8) {
    const opcode = rest.readInt32LE(0);
    const length = rest.readInt32LE(4);
    if (length < 0 || length > 1024 * 1024) return { frames, rest: Buffer.alloc(0), broken: true };
    if (rest.length < 8 + length) break;
    let message = null;
    try { message = JSON.parse(rest.slice(8, 8 + length).toString('utf8')); } catch { /* not json */ }
    frames.push({ opcode, message });
    rest = rest.slice(8 + length);
  }
  return { frames, rest, broken: false };
}

// discord wants these lines between 2 and 128 characters
function line(text, fallback = '') {
  let value = String(text == null ? '' : text).replace(/[\u0000-\u001f]/g, ' ').trim();
  if (!value) value = fallback;
  if (value.length < 2) value = (value + '  ').slice(0, 2);
  return value.slice(0, 128);
}

// what the page sends, cleaned up and with the spot in the song turned into start and end times
function cleanInfo(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const duration = Number(raw.duration);
  const position = Number(raw.position);
  const playing = raw.playing !== false;
  const info = {
    title,
    artist: String(raw.artist || '').trim(),
    playing,
    shared: Boolean(raw.shared),
    device: raw.device === 'phone' ? 'phone' : '',
    thumbnail: typeof raw.thumbnail === 'string' && /^https:\/\//i.test(raw.thumbnail) && raw.thumbnail.length <= 256 ? raw.thumbnail : '',
    start: 0,
    end: 0
  };
  if (playing && Number.isFinite(duration) && duration > 0 && Number.isFinite(position) && position >= 0 && position <= duration + 5) {
    info.start = Math.round(now - position * 1000);
    info.end = Math.round(info.start + duration * 1000);
  } else if (playing && Number.isFinite(position) && position >= 0) {
    info.start = Math.round(now - position * 1000);
  }
  return info;
}

// the activity as Discord takes it. type 2 is "Listening to" and status_display_type 2 makes the
// line under a person's name in the member list show the song instead of the app's name. an old
// client may refuse any of them (or the image addresses), so each can be left out
function buildActivity(info, { useType = true, useImages = true, useDisplay = true } = {}) {
  const activity = {
    details: line(info.title),
    state: line(info.playing ? (info.artist || 'unknown artist') : `${info.artist || 'unknown artist'} (paused)`),
    instance: false,
    buttons: [{ label: 'get the app', url: RELEASES_URL }]
  };
  if (useType) activity.type = 2;
  if (useType && useDisplay) activity.status_display_type = 2;
  if (info.playing && info.start) {
    activity.timestamps = info.end ? { start: info.start, end: info.end } : { start: info.start };
  }
  if (useImages) {
    const caption = line(info.shared ? 'listening together in a room' : (info.device === 'phone' ? 'listening on a phone' : APP_NAME));
    activity.assets = info.thumbnail
      ? { large_image: info.thumbnail, large_text: caption, small_image: ICON_URL, small_text: line(APP_NAME) }
      : { large_image: ICON_URL, large_text: caption };
  }
  return activity;
}

function createPresence({ clientId = DEFAULT_CLIENT_ID, log = () => {}, ipcPaths = null, minGapMs = MIN_GAP_MS, retryMs = RETRY_MS } = {}) {
  let socket = null;
  let ready = false;
  let buffer = Buffer.alloc(0);
  let connecting = null;
  let handshakeWaiter = null;
  const replyWaiters = new Map();
  let pending; // undefined: nothing to send, null: clear the activity, object: the info to show
  let lastSentAt = 0;
  let lastAttemptAt = 0;
  let flushTimer = null;
  let lastError = '';
  let closeReason = ''; // what Discord said when it ended a handshake
  let useType = true;
  let useImages = true;
  let useDisplay = true;

  function closeSocket() {
    ready = false;
    buffer = Buffer.alloc(0);
    if (socket) {
      const old = socket;
      socket = null;
      try { old.removeAllListeners('data'); old.destroy(); } catch { /* gone */ }
    }
    replyWaiters.forEach((resolve) => resolve(null));
    replyWaiters.clear();
  }

  function write(opcode, payload) {
    if (!socket || socket.destroyed) return false;
    try { socket.write(encode(opcode, payload)); return true; } catch { return false; }
  }

  function onFrame(opcode, message) {
    if (opcode === OP_PING) { write(OP_PONG, message || {}); return; }
    if (opcode === OP_CLOSE) {
      closeReason = message && message.message ? String(message.message) : 'Discord closed the connection';
      lastError = closeReason;
      closeSocket();
      return;
    }
    if (opcode !== OP_FRAME || !message) return;
    if (message.evt === 'READY') {
      ready = true;
      if (handshakeWaiter) { handshakeWaiter(true); handshakeWaiter = null; }
      return;
    }
    if (message.nonce && replyWaiters.has(message.nonce)) {
      const resolve = replyWaiters.get(message.nonce);
      replyWaiters.delete(message.nonce);
      resolve(message);
    }
  }

  function tryPath(ipcPath) {
    return new Promise((resolve) => {
      const candidate = net.createConnection(ipcPath);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) { try { candidate.destroy(); } catch { /* gone */ } }
        resolve(ok);
      };
      const timer = setTimeout(() => { handshakeWaiter = null; done(false); }, HANDSHAKE_TIMEOUT_MS);
      candidate.on('error', () => done(false));
      candidate.on('close', () => { if (socket === candidate) closeSocket(); done(false); });
      candidate.on('connect', () => {
        socket = candidate;
        buffer = Buffer.alloc(0);
        candidate.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          const result = decode(buffer);
          buffer = result.rest;
          if (result.broken) { closeSocket(); return; }
          result.frames.forEach((frame) => onFrame(frame.opcode, frame.message));
        });
        handshakeWaiter = done;
        write(OP_HANDSHAKE, { v: 1, client_id: String(clientId) });
      });
    });
  }

  async function connect() {
    if (ready) return true;
    if (connecting) return connecting;
    if (Date.now() - lastAttemptAt < retryMs) return false;
    lastAttemptAt = Date.now();
    closeReason = '';
    connecting = (async () => {
      for (const ipcPath of (ipcPaths || candidatePaths())) {
        // eslint-disable-next-line no-await-in-loop
        if (await tryPath(ipcPath)) return true;
        if (socket && !ready) closeSocket();
      }
      lastError = closeReason || 'Discord is not running';
      return false;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function request(args) {
    return new Promise((resolve) => {
      const nonce = crypto.randomUUID();
      const timer = setTimeout(() => { replyWaiters.delete(nonce); resolve(null); }, REPLY_TIMEOUT_MS);
      replyWaiters.set(nonce, (message) => { clearTimeout(timer); resolve(message); });
      if (!write(OP_FRAME, { cmd: 'SET_ACTIVITY', args, nonce })) {
        clearTimeout(timer);
        replyWaiters.delete(nonce);
        resolve(null);
      }
    });
  }

  function schedule(delayMs) {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, Math.max(0, delayMs)); // eslint-disable-line no-use-before-define
    if (flushTimer.unref) flushTimer.unref();
  }

  async function flush() {
    flushTimer = null;
    if (pending === undefined) return;
    const wait = lastSentAt + minGapMs - Date.now();
    if (wait > 0) { schedule(wait); return; }
    if (!(await connect())) {
      // not there yet: try again later while there is still something to show
      if (pending !== undefined) schedule(retryMs);
      return;
    }
    const sending = pending;
    pending = undefined;
    lastSentAt = Date.now();
    const send = () => request({
      pid: process.pid,
      activity: sending === null ? undefined : buildActivity(sending, { useType, useImages, useDisplay })
    });
    let reply = await send();
    // an older Discord may refuse the status line setting, the listening type or an image
    // address: leave them out one at a time until it takes the rest
    if (reply && reply.evt === 'ERROR' && sending) {
      if (useDisplay) { useDisplay = false; reply = await send(); }
      if (reply && reply.evt === 'ERROR' && useType) { useType = false; reply = await send(); }
      if (reply && reply.evt === 'ERROR' && useImages) { useImages = false; reply = await send(); }
    }
    if (!reply) {
      lastError = 'Discord did not answer';
      closeSocket();
      if (pending === undefined && sending) pending = sending; // show it after the next connect
      schedule(retryMs);
      return;
    }
    lastError = reply.evt === 'ERROR' ? String((reply.data && reply.data.message) || 'Discord refused the activity') : '';
    log(`[DISCORD] ${reply.evt === 'ERROR' ? 'refused' : 'accepted'}: ${JSON.stringify(reply.data || {}).slice(0, 300)}`);
    if (pending !== undefined) schedule(minGapMs);
  }

  return {
    available: Boolean(clientId),
    // what is playing now (or null to clear it). only the latest is kept, a burst of changes
    // becomes one update
    update(raw) {
      if (!clientId) return false;
      const info = raw === null ? null : cleanInfo(raw);
      if (raw !== null && !info) return false;
      pending = info;
      schedule(0);
      return true;
    },
    clear() { return this.update(null); },
    status() { return { available: Boolean(clientId), connected: ready, error: lastError, shape: { type: useType, display: useDisplay, images: useImages } }; },
    close() {
      clearTimeout(flushTimer);
      flushTimer = null;
      closeSocket();
    }
  };
}

module.exports = { createPresence, buildActivity, cleanInfo, encode, decode, candidatePaths, DEFAULT_CLIENT_ID, RELEASES_URL, ICON_URL };
