// input rules for accounts and user typed text. the server is the only place
// these are actually enforced, the client just mirrors them for nicer errors.
// every query is parameterized so sql injection was never the issue, this is
// about names that break the app in other ways (the string "null", names that
// collide with js object keys, lookalike unicode, huge or non-string values)
const crypto = require('crypto');

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt only reads this much, anything past it is silently ignored
const LOGIN_FIELD_MAX = 256;

// letters, digits and underscore only. ascii only on purpose so nobody can
// register a lookalike of someone else with cyrillic letters or invisible chars
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

// names that would be confusing, impersonate staff, or read as a missing value
const RESERVED_USERNAMES = new Set([
  'null', 'undefined', 'nan', 'nil', 'none', 'true', 'false', 'void',
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'sudo',
  'mod', 'moderator', 'staff', 'support', 'help', 'owner', 'server', 'bot',
  'anonymous', 'anon', 'guest', 'everyone', 'here', 'channel', 'deleted',
  'unknown', 'user', 'username', 'me', 'you', 'self', 'api', 'auth', 'login',
  'logout', 'register', 'signup', 'shibenchi', 'shibenchis'
]);

// every property name on Object.prototype, lowercased: __proto__, constructor,
// toString, hasOwnProperty and friends. anything that would hit the prototype
// if a username ever gets used as an object key. lowercased on both sides so
// "TOSTRING" is caught too
const PROTOTYPE_NAMES = new Set(
  Object.getOwnPropertyNames(Object.prototype).map((prop) => prop.toLowerCase())
);
PROTOTYPE_NAMES.add('prototype');

function isReservedUsername(name) {
  const lowered = String(name).toLowerCase();
  if (RESERVED_USERNAMES.has(lowered)) return true;
  if (PROTOTYPE_NAMES.has(lowered)) return true;
  // "ad_min" and "admin_" should not get around the list above
  const squashed = lowered.replace(/_/g, '');
  if (squashed !== lowered && RESERVED_USERNAMES.has(squashed)) return true;
  return false;
}

// registration rules. allowReserved lets the configured admin names through
function validateNewUsername(raw, { allowReserved = [] } = {}) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Username must be text' };
  }

  const value = raw.trim();
  if (value !== raw) {
    return { ok: false, error: 'Username cannot start or end with a space' };
  }
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    return { ok: false, error: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters` };
  }
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, error: 'Username can only use letters, numbers and underscores' };
  }
  if (!/[A-Za-z0-9]/.test(value)) {
    return { ok: false, error: 'Username needs at least one letter or number' };
  }
  const allowed = allowReserved.map((n) => n.toLowerCase());
  if (isReservedUsername(value) && !allowed.includes(value.toLowerCase())) {
    return { ok: false, error: 'That username is not available' };
  }

  return { ok: true, value };
}

function validateNewPassword(raw, username = '') {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Password must be text' };
  }
  if (raw.length < PASSWORD_MIN) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN} characters` };
  }
  if (Buffer.byteLength(raw, 'utf8') > PASSWORD_MAX_BYTES) {
    return { ok: false, error: `Password is too long (max ${PASSWORD_MAX_BYTES} bytes)` };
  }
  if (!raw.trim()) {
    return { ok: false, error: 'Password cannot be only spaces' };
  }
  if (username && raw.toLowerCase() === String(username).toLowerCase()) {
    return { ok: false, error: 'Password cannot be the same as your username' };
  }
  return { ok: true, value: raw };
}

// login is looser than register so older accounts keep working, it only
// guards against the wrong types and absurd lengths
function readLoginFields(body) {
  const username = body && body.username;
  const password = body && body.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return { ok: false, error: 'Username and password required' };
  }
  if (!username.trim() || !password) {
    return { ok: false, error: 'Username and password required' };
  }
  if (username.length > LOGIN_FIELD_MAX || password.length > LOGIN_FIELD_MAX) {
    return { ok: false, error: 'Invalid username or password' };
  }
  return { ok: true, username: username.trim(), password };
}

// control chars, zero width chars and bidi overrides. these let someone make
// text that looks like something else or flips the direction of what follows
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// cleans free text (playlist names, server names, chat). returns
// { ok, value } or { ok: false, error }. multiline keeps real newlines
function cleanText(raw, { field = 'Text', min = 1, max = 100, multiline = false } = {}) {
  if (typeof raw !== 'string') {
    return { ok: false, error: `${field} must be text` };
  }

  let value = raw.normalize('NFC').replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
  if (multiline) {
    value = value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    value = value.replace(/[\r\n\t]+/g, ' ');
  }
  value = value.trim();

  if (value.length < min) {
    return { ok: false, error: `${field} required` };
  }
  if (value.length > max) {
    return { ok: false, error: `${field} is too long (max ${max} characters)` };
  }
  return { ok: true, value };
}

// ids sent by the client (collab playlist ids). only accept a boring shape
function cleanClientId(raw) {
  if (typeof raw !== 'string') return null;
  return /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : null;
}

// tiny fixed window limiter, keyed by whatever string you give it
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60 * 1000));
  if (typeof sweep.unref === 'function') sweep.unref();

  return {
    // returns { allowed, retryAfterSec }
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      };
    },
    reset(key) {
      hits.delete(key);
    }
  };
}

// auth tokens for cross-origin clients. random, expiring, revocable.
// (they used to be built from Math.random and lived forever)
const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// storage is optional: { save, get, remove, removeUser, removeExpired } keyed by the
// sha256 of the token. with it, logins survive a restart of the server, without
// it (tests) they only live in memory. it is given as a function because the
// database is loaded after the store is made
function createAuthTokenStore(getStorage = null) {
  const tokens = new Map(); // token -> { userId, expiresAt }
  const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const storage = () => {
    try {
      return typeof getStorage === 'function' ? getStorage() : null;
    } catch {
      return null;
    }
  };
  const safely = (fn) => {
    try {
      fn();
    } catch {
      // a token that could not be written down still works until the next restart
    }
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of tokens) {
      if (entry.expiresAt <= now) tokens.delete(token);
    }
    const store = storage();
    if (store) safely(() => store.removeExpired(now));
  }, 10 * 60 * 1000);
  if (typeof sweep.unref === 'function') sweep.unref();

  return {
    issue(userId) {
      const token = 'tok_' + crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + AUTH_TOKEN_TTL_MS;
      tokens.set(token, { userId, expiresAt });
      const store = storage();
      if (store) safely(() => store.save(hashOf(token), userId, expiresAt));
      return token;
    },
    // returns the user id or null
    resolve(token) {
      if (typeof token !== 'string' || !token) return null;
      let entry = tokens.get(token);
      if (!entry) {
        // not seen since the last restart: ask the database
        const store = storage();
        let row = null;
        if (store) safely(() => { row = store.get(hashOf(token)); });
        if (!row) return null;
        entry = { userId: row.user_id, expiresAt: Number(row.expires_at) };
        tokens.set(token, entry);
      }
      if (entry.expiresAt <= Date.now()) {
        tokens.delete(token);
        const store = storage();
        if (store) safely(() => store.remove(hashOf(token)));
        return null;
      }
      return entry.userId;
    },
    revoke(token) {
      if (typeof token !== 'string') return;
      tokens.delete(token);
      const store = storage();
      if (store) safely(() => store.remove(hashOf(token)));
    },
    revokeUser(userId) {
      for (const [token, entry] of tokens) {
        if (entry.userId === userId) tokens.delete(token);
      }
      const store = storage();
      if (store) safely(() => store.removeUser(userId));
    }
  };
}

// keys whose values never go into a log file
const SECRET_KEYS = new Set([
  'password', 'newpassword', 'currentpassword', 'confirmpassword',
  'token', 'authtoken', 'sid', 'sessionid', 'secret', 'apikey'
]);

function redactForLog(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 300) {
      return value.slice(0, 300) + `...(${value.length} chars)`;
    }
    return value;
  }
  if (depth > 4) return '[nested]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => redactForLog(item, depth + 1));
    if (value.length > 20) items.push(`...(${value.length} items)`);
    return items;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : redactForLog(value[key], depth + 1);
  }
  return out;
}

// is this request coming from the same machine, with nothing in front of it
// from the outside? a reverse proxy on the same box still shows a loopback
// socket, so any forwarded-for entry that is not loopback means "someone else"
function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr).trim().replace(/^::ffff:/i, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || /^127\./.test(a);
}

function isLocalRequest(req) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const entries = String(forwarded).split(',');
    if (!entries.every((entry) => isLoopbackAddress(entry))) return false;
  }
  if (req.headers['x-real-ip'] && !isLoopbackAddress(req.headers['x-real-ip'])) return false;
  return true;
}

function isPrivateAddress(addr) {
  if (!addr) return false;
  const a = String(addr).trim().replace(/^::ffff:/i, '');
  if (isLoopbackAddress(a)) return true;
  return /^10\./.test(a)
    || /^192\.168\./.test(a)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
    || /^169\.254\./.test(a)
    || /^f[cd][0-9a-f]{2}:/i.test(a)
    || /^fe80:/i.test(a);
}

// same idea as isLocalRequest but a phone or laptop on the same home network
// counts too (the desktop app is reachable by lan ip on purpose). anything
// with a public address in the chain, directly or through a proxy, does not
function isPrivateNetworkRequest(req) {
  if (!isPrivateAddress(req.socket && req.socket.remoteAddress)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const entries = String(forwarded).split(',');
    if (!entries.every((entry) => isPrivateAddress(entry))) return false;
  }
  if (req.headers['x-real-ip'] && !isPrivateAddress(req.headers['x-real-ip'])) return false;
  return true;
}

module.exports = {
  isPrivateNetworkRequest,
  USERNAME_MIN,
  USERNAME_MAX,
  PASSWORD_MIN,
  validateNewUsername,
  validateNewPassword,
  readLoginFields,
  cleanText,
  cleanClientId,
  createRateLimiter,
  createAuthTokenStore,
  redactForLog,
  isLocalRequest,
  isReservedUsername
};
