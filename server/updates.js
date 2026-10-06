// updating the app's screens without a new installer.
//
// the club server keeps the newest build of the screens (update-files/) with a
// manifest that lists every file and its hash. the manifest is signed with a key
// that only lives on the maker's computer, and the matching public key is in
// here. an installed desktop app downloads the files, checks the signature and
// every hash, and only then starts serving them instead of the ones it came
// with. a server that was broken into can not make an app run its own code
// this way, the signature would not match
//
// only the screens (the react build) can change like this. anything native, or
// this server code itself, still needs a new installer, the manifest says which
// installer version a bundle needs (minShell)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWEpnNncXYfK8hZcPBwkGBZMsE8Z5XfTJIUb9ok6McJw=
-----END PUBLIC KEY-----`;

const DEFAULT_BASES = [
  'https://shibenchi.members.purduehackers.com',
  'https://shibenchi-music.tail55b1b3.ts.net'
];

const MAX_FILES = 600;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
  const pb = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// the envelope is { manifest: "<json text>", signature: "<base64>" }. the signature
// covers the text exactly as it was sent, so nothing has to be re-serialised
function readSignedManifest(envelope) {
  try {
    if (!envelope || typeof envelope.manifest !== 'string' || typeof envelope.signature !== 'string') return null;
    const key = crypto.createPublicKey(PUBLIC_KEY_PEM);
    const good = crypto.verify(null, Buffer.from(envelope.manifest, 'utf8'), key, Buffer.from(envelope.signature, 'base64'));
    if (!good) return null;
    const manifest = JSON.parse(envelope.manifest);
    if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) return null;
    return manifest;
  } catch {
    return null;
  }
}

// a file path from a manifest, as a safe relative path, or null
function safeRelativePath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /^[a-zA-Z]:/.test(text) || text.includes('\0')) return null;
  const parts = text.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function createUpdater({ appDataDir, bundledDir, shellVersion, log = () => {}, bases }) {
  const stateDir = path.join(appDataDir, 'ui-update');
  const metaFile = path.join(stateDir, 'meta.json');
  const sources = (bases && bases.length ? bases : (process.env.SMP_UPDATE_BASES ? process.env.SMP_UPDATE_BASES.split(',').map((b) => b.trim()).filter(Boolean) : DEFAULT_BASES))
    .map((base) => base.replace(/\/+$/, ''));

  let active = null; // { version, dir } of a downloaded bundle that is in use
  let applying = false;
  let cachedCheck = null; // { at, result }

  function readMeta() {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (!meta || typeof meta.version !== 'string' || typeof meta.folder !== 'string') return null;
      const dir = path.join(stateDir, meta.folder);
      if (!fs.existsSync(path.join(dir, 'index.html'))) return null;
      return { version: meta.version, dir };
    } catch {
      return null;
    }
  }

  function removeFolder(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for next time */ }
  }

  // a downloaded bundle is only used while it is newer than what the installer came
  // with, after a new installer the old download is deleted
  function load() {
    const meta = readMeta();
    if (meta && compareVersions(meta.version, shellVersion) > 0) {
      active = meta;
    } else {
      active = null;
      if (fs.existsSync(stateDir)) removeFolder(stateDir);
    }
    return active;
  }
  load();

  function activeDir() {
    return active ? active.dir : bundledDir;
  }

  function uiVersion() {
    return active ? active.version : shellVersion;
  }

  async function fetchManifest() {
    let lastError = 'no server answered';
    for (const base of sources) {
      try {
        const response = await axios.get(`${base}/api/update/manifest`, { timeout: 8000, responseType: 'json', validateStatus: (s) => s === 200 });
        const manifest = readSignedManifest(response.data);
        if (manifest) return { base, manifest };
        lastError = 'the manifest was not signed by the maker';
      } catch (error) {
        lastError = error.message || String(error);
      }
    }
    const failure = new Error(lastError);
    failure.code = 'no_manifest';
    throw failure;
  }

  // what the server offers and whether this install can take it. cached for a minute
  async function check(force = false) {
    if (!force && cachedCheck && Date.now() - cachedCheck.at < 60000) return cachedCheck.result;
    const { manifest } = await fetchManifest();
    const result = {
      shell: shellVersion,
      ui: uiVersion(),
      latest: manifest.version,
      newer: compareVersions(manifest.version, uiVersion()) > 0,
      canApply: compareVersions(shellVersion, manifest.minShell || manifest.version) >= 0,
      // this version has an installer the app can download and run itself (see installer.js)
      installer: Boolean(manifest.installers && manifest.installers.windows),
      // newer than the installer this app came with, which is what an installer is compared to
      installerNewer: compareVersions(manifest.version, shellVersion) > 0
    };
    cachedCheck = { at: Date.now(), result };
    return result;
  }

  async function download(base, entry, destination) {
    const response = await axios.get(`${base}/api/update/ui/${entry.path.split('/').map(encodeURIComponent).join('/')}`, {
      timeout: 60000,
      responseType: 'arraybuffer',
      maxContentLength: MAX_FILE_BYTES,
      validateStatus: (s) => s === 200
    });
    const bytes = Buffer.from(response.data);
    if (bytes.length !== entry.size) throw new Error(`${entry.path} has the wrong size`);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== String(entry.sha256).toLowerCase()) throw new Error(`${entry.path} does not match its hash`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }

  async function apply() {
    if (applying) {
      const busy = new Error('an update is already running');
      busy.code = 'busy';
      throw busy;
    }
    applying = true;
    let staging = null;
    try {
      const { base, manifest } = await fetchManifest();
      if (compareVersions(manifest.version, uiVersion()) <= 0) {
        const none = new Error('already up to date');
        none.code = 'up_to_date';
        throw none;
      }
      if (compareVersions(shellVersion, manifest.minShell || manifest.version) < 0) {
        const needs = new Error('this update needs the installer');
        needs.code = 'needs_installer';
        throw needs;
      }

      const files = manifest.files.map((entry) => ({
        path: safeRelativePath(entry && entry.path),
        size: Number(entry && entry.size),
        sha256: String((entry && entry.sha256) || '')
      }));
      if (!files.length || files.length > MAX_FILES || files.some((f) => !f.path || !Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES || !/^[0-9a-f]{64}$/i.test(f.sha256))) {
        throw new Error('the manifest is not valid');
      }
      if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) throw new Error('the update is too big');
      if (!files.some((f) => f.path === 'index.html')) throw new Error('the update has no index.html');

      const folder = `v${manifest.version.replace(/[^0-9a-zA-Z.-]/g, '_')}`;
      staging = path.join(stateDir, `${folder}.partial`);
      removeFolder(staging);
      fs.mkdirSync(staging, { recursive: true });

      for (const entry of files) {
        const destination = path.join(staging, ...entry.path.split('/'));
        if (!destination.startsWith(staging + path.sep)) throw new Error('a file points outside the update folder');
        await download(base, entry, destination);
      }

      const finalDir = path.join(stateDir, folder);
      removeFolder(finalDir);
      fs.renameSync(staging, finalDir);
      staging = null;

      // the meta file is replaced in one step, so a crash leaves the old bundle or the new one
      const tmpMeta = `${metaFile}.tmp`;
      fs.writeFileSync(tmpMeta, JSON.stringify({ version: manifest.version, folder, at: Date.now() }));
      fs.renameSync(tmpMeta, metaFile);

      const previous = active;
      active = { version: manifest.version, dir: finalDir };
      cachedCheck = null;
      if (previous && previous.dir !== finalDir) removeFolder(previous.dir);
      log(`[UPDATE] screens updated to ${manifest.version} (installer ${shellVersion})`);
      return { version: manifest.version };
    } finally {
      if (staging) removeFolder(staging);
      applying = false;
    }
  }

  // the verified manifest, for the installer
  async function manifest() {
    return (await fetchManifest()).manifest;
  }

  return { activeDir, uiVersion, check, apply, manifest, sources };
}

module.exports = { createUpdater, compareVersions, readSignedManifest, safeRelativePath };
