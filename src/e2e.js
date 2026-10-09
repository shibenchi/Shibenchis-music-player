// end to end encryption of direct messages. the server stores and passes on ciphertext it can not read.
//
// every account has one P-256 key pair. the public half is stored on the server for anyone to use when writing to
// that person. the private half is stored on the server too, but locked with a key made from the person's password
// (PBKDF2 then AES-GCM, done here in the app), so a new device can get it back by typing the password and the
// server (or someone looking through its files) has nothing but a locked blob. each device keeps the unlocked
// private key in its own storage so the password is only typed once per device
//
// a message to somebody is locked with a key both of them can work out: ECDH between my private key and their
// public key (the same number comes out from their private key and my public key), stretched with HKDF, used
// with AES-256-GCM and a fresh random IV for every message. the ids of the two people are bound into the lock so
// a message can not be moved to another conversation. what the server gets is "e2e1:" + base64 of a small
// envelope { v, s: sender key id, r: receiver key id, iv, ct }
//
// what this protects against: anybody who reads the server's database, logs or backups (including the person who
// runs the server). what it does not: a server that is changed to hand out the wrong public key or to catch the
// password at login (a first seen key is remembered here and a later change is refused, which catches the first),
// the same key lasting forever (no forward secrecy), the length of a message (it shows)

export const PREFIX = 'e2e1:';
const KDF_ITERATIONS = 250000;
const CONTEXT = 'smp-dm-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

export const e2eSupported = () => Boolean(subtle());
export const isEnvelope = (text) => typeof text === 'string' && text.startsWith(PREFIX);

function toB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// the part of a key that is public, in a fixed shape
const cleanPublic = (jwk) => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });

// a short id for a public key, which the envelope names so the other side knows which key was used
async function kidOf(publicJwk) {
  const digest = await subtle().digest('SHA-256', encoder.encode(`${publicJwk.x}.${publicJwk.y}`));
  return Array.from(new Uint8Array(digest).subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveWrapKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// a new key pair, with its private half locked by the password. local is what the device keeps, remote is what the server gets
export async function createAccountKey(password) {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicJwk = cleanPublic(await subtle().exportKey('jwk', pair.publicKey));
  const exported = await subtle().exportKey('jwk', pair.privateKey);
  const privateJwk = { ...cleanPublic(exported), d: exported.d };
  const kid = await kidOf(publicJwk);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrapKey = await deriveWrapKey(password, salt, KDF_ITERATIONS);
  const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv }, wrapKey, encoder.encode(JSON.stringify(privateJwk)));
  return {
    local: { privateJwk, publicJwk, kid },
    remote: {
      public_key: JSON.stringify(publicJwk),
      kid,
      wrapped_private: toB64(wrapped),
      wrap_salt: toB64(salt),
      wrap_iv: toB64(iv),
      wrap_iters: KDF_ITERATIONS
    }
  };
}

// the locked key from the server, opened with the password. throws "wrong password" when it does not open
export async function openAccountKey(password, remote) {
  let privateJwk;
  try {
    const wrapKey = await deriveWrapKey(password, fromB64(remote.wrap_salt), Number(remote.wrap_iters));
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(remote.wrap_iv) }, wrapKey, fromB64(remote.wrapped_private));
    privateJwk = JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error('wrong password');
  }
  // the public half is worked out from what was inside the lock, not taken from what the server said next to it
  const publicJwk = cleanPublic(privateJwk);
  const kid = await kidOf(publicJwk);
  if (kid !== remote.kid) throw new Error('the stored key does not match');
  return { privateJwk, publicJwk, kid };
}

// the AES key for one conversation: the same on both sides
async function conversationKey(local, peer) {
  const priv = await subtle().importKey('jwk', local.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle().importKey('jwk', peer.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const material = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const kids = [local.kid, peer.kid].sort().join('|');
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(CONTEXT), info: encoder.encode(kids) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const aadFor = (senderId, receiverId) => encoder.encode(`${CONTEXT}|${senderId}|${receiverId}`);

// ---- what a device keeps
const keyName = (userId) => `smp_e2e_key:${userId}`;
const peersName = (userId) => `smp_e2e_peers:${userId}`;
const storageOf = (given) => given || (typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage);

export function loadLocalKey(userId, given) {
  try {
    const parsed = JSON.parse(storageOf(given).getItem(keyName(userId)));
    if (parsed && parsed.privateJwk && parsed.publicJwk && parsed.kid) return parsed;
  } catch {
    // none
  }
  return null;
}
function saveLocalKey(userId, local, given) {
  try { storageOf(given).setItem(keyName(userId), JSON.stringify(local)); } catch { /* the device would ask for the password again */ }
}
// this device forgets the account's key (signing out): the password brings it back
export function forgetLocalKey(userId, given) {
  try {
    storageOf(given).removeItem(keyName(userId));
    storageOf(given).removeItem(peersName(userId));
  } catch {
    // nothing to forget
  }
}

// one of these per signed in account. api is { get(path), put(path, body) } answering with the parsed json
export function createE2e({ userId, api, storage }) {
  let local = loadLocalKey(userId, storage);
  const peerCache = new Map();

  function loadPeers() {
    try { return JSON.parse(storageOf(storage).getItem(peersName(userId))) || {}; } catch { return {}; }
  }
  function rememberPeer(peerId, peer) {
    const all = loadPeers();
    all[peerId] = { kid: peer.kid, publicJwk: peer.publicJwk };
    try { storageOf(storage).setItem(peersName(userId), JSON.stringify(all)); } catch { /* looked up again next time */ }
  }

  // somebody's public key, from the server the first time and remembered from then on. a different key later is refused
  async function peerKey(peerId) {
    if (peerCache.has(peerId)) return peerCache.get(peerId);
    const answer = await api.get(`/api/e2e/public/${encodeURIComponent(peerId)}`);
    const remote = answer && answer.key;
    const known = loadPeers()[peerId] || null;
    if (!remote) {
      if (known) {
        peerCache.set(peerId, known);
        return known;
      }
      return null;
    }
    const publicJwk = cleanPublic(JSON.parse(remote.public_key));
    const kid = await kidOf(publicJwk);
    if (kid !== remote.kid) throw new Error('their key is not valid');
    if (known && known.kid !== kid) {
      const error = new Error('their key changed');
      error.code = 'key_changed';
      throw error;
    }
    const peer = { kid, publicJwk };
    if (!known) rememberPeer(peerId, peer);
    peerCache.set(peerId, peer);
    return peer;
  }

  return {
    get ready() { return Boolean(local); },
    get kid() { return local ? local.kid : ''; },

    // is the key this device holds the one the server has for the account? (a device that was handed a new key by
    // another device, or an account that was reset, has to ask for the password again)
    async check() {
      if (!local) return false;
      const answer = await api.get('/api/e2e/key');
      if (!answer || !answer.key || answer.key.kid !== local.kid) {
        local = null;
        forgetLocalKey(userId, storage);
        return false;
      }
      return true;
    },

    // with the password: makes the account's key the first time, brings it to this device after that
    async setup(password) {
      const answer = await api.get('/api/e2e/key');
      if (answer && answer.key) {
        local = await openAccountKey(password, answer.key);
      } else {
        const made = await createAccountKey(password);
        const stored = await api.put('/api/e2e/key', made.remote);
        // two devices at the same moment: the first one's key is the account's
        local = stored && stored.created ? made.local : await openAccountKey(password, stored.key);
      }
      saveLocalKey(userId, local, storage);
      return true;
    },

    // does this person have private messages turned on? (null: their app is older)
    async hasKey(peerId) {
      return Boolean(await peerKey(peerId));
    },

    // text -> the envelope the server stores
    async encrypt(peerId, text, senderId, receiverId) {
      if (!local) throw Object.assign(new Error('locked'), { code: 'locked' });
      const peer = await peerKey(peerId);
      if (!peer) throw Object.assign(new Error('they have not turned private messages on'), { code: 'peer_no_key' });
      const key = await conversationKey(local, peer);
      const iv = randomBytes(12);
      const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(senderId, receiverId) }, key, encoder.encode(text));
      const head = { v: 1, s: local.kid, r: peer.kid, iv: toB64(iv), ct: toB64(ciphertext) };
      return PREFIX + toB64(encoder.encode(JSON.stringify(head)));
    },

    // the envelope -> the text. throws when it can not be opened (code locked / key_changed / other)
    async decrypt(envelope, senderId, receiverId) {
      if (!local) throw Object.assign(new Error('locked'), { code: 'locked' });
      const head = JSON.parse(decoder.decode(fromB64(envelope.slice(PREFIX.length))));
      if (head.v !== 1) throw new Error('a newer kind of message');
      const iAmSender = senderId === userId;
      const peerId = iAmSender ? receiverId : senderId;
      if ((iAmSender ? head.s : head.r) !== local.kid) throw new Error('made for another key');
      const peer = await peerKey(peerId);
      if (!peer || peer.kid !== (iAmSender ? head.r : head.s)) throw new Error('made with another key');
      const key = await conversationKey(local, peer);
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(head.iv), additionalData: aadFor(senderId, receiverId) }, key, fromB64(head.ct));
      return decoder.decode(plain);
    }
  };
}
