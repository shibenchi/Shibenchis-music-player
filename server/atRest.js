// stored chat text is scrambled with a key that lives next to the data folder, not in the database. a copy of
// the database file, a backup of it, or a look through it with a database tool shows nothing readable.
// this does not keep the text from whoever can read BOTH the database and the key file (the person who runs the
// machine): for that, direct messages are also encrypted end to end by the apps themselves (see e2e on the
// page), and the server only ever holds their ciphertext
//
// a scrambled value looks like "enc1:" + base64(iv, tag, ciphertext) (AES-256-GCM)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc1:';
const E2E_PREFIX = 'e2e1:';
// a message in a room that was locked by the members (see roomKeys.js), stored as it came
const ROOM_E2E_PREFIX = 'r2e1:';
let key = null;

function loadKey(dir) {
  if (process.env.SMP_MESSAGE_KEY && /^[0-9a-f]{64}$/i.test(process.env.SMP_MESSAGE_KEY)) {
    return Buffer.from(process.env.SMP_MESSAGE_KEY, 'hex');
  }
  const file = path.join(dir, 'message.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch {
    // none yet
  }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, fresh.toString('hex'), { mode: 0o600 });
  return fresh;
}

function init(dir) {
  key = loadKey(dir);
}

const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);
const isEnvelope = (value) => typeof value === 'string' && (value.startsWith(E2E_PREFIX) || value.startsWith(ROOM_E2E_PREFIX));

// text -> scrambled text. an end to end envelope (already ciphertext) and an already scrambled value stay as they are
function seal(text) {
  const value = String(text == null ? '' : text);
  if (!key || isSealed(value) || isEnvelope(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

// scrambled text -> text. anything else (an envelope, an old plain row) is handed back unchanged
function open(value) {
  if (!isSealed(value)) return value;
  if (!key) return '[this message can not be read]';
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return '[this message can not be read]';
  }
}

module.exports = { init, seal, open, isSealed, isEnvelope, PREFIX, E2E_PREFIX, ROOM_E2E_PREFIX };
