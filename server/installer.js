// installing a new version of the desktop app from inside the app, after the person pressed
// update. the installer is downloaded from the project's github release (its address, size and
// hash come from the manifest the maker signed, see updates.js, so a server that was taken over
// can not hand out another file), checked against that hash, and then a small script closes the
// app, runs the installer (windows asks for permission itself) and opens the app again
//
// only an installed app can do this (app.exe sits next to the node that runs this server), a
// run from the source folder or a hosted server has nothing to replace

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { compareVersions } = require('./updates');

const RELEASE_PREFIX = 'https://github.com/shibenchi/Shibenchis-Music-Player/releases/download/';
const NAME_PATTERN = /^Shibenchis-Music-Player_[0-9A-Za-z.-]{1,32}_x64_en-US\.msi$/;
const MAX_BYTES = 400 * 1024 * 1024;
const IDLE_MS = 30000;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// the installer of the manifest, checked: where it is, what it is called, how big, what hash
function installerEntry(manifest, prefixes) {
  const entry = manifest && manifest.installers && manifest.installers.windows;
  if (!entry) throw coded('no_installer', 'this update has no installer to download');
  const url = String(entry.url || '');
  if (!prefixes.some((prefix) => url.startsWith(prefix))) throw coded('bad_installer', 'the installer is not on the project releases');
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    throw coded('bad_installer', 'the installer address is not valid');
  }
  if (!NAME_PATTERN.test(name)) throw coded('bad_installer', 'the installer has an unexpected name');
  const size = Number(entry.size);
  const sha256 = String(entry.sha256 || '').toLowerCase();
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES || !/^[0-9a-f]{64}$/.test(sha256)) throw coded('bad_installer', 'the installer entry is not valid');
  return { url, name, size, sha256 };
}

// the script that does the replacing. it runs on its own after this app is closed
// installCommand is only replaced when the script itself is tested
function buildScript({ appPid, installDir, msiPath, logPath, installCommand }) {
  const q = (value) => `"${value}"`;
  return [
    '@echo off',
    'rem written by the app: closes it, runs the installer, opens the app again',
    `echo %date% %time% closing the app >> ${q(logPath)}`,
    'ping -n 3 127.0.0.1 >nul',
    `taskkill /f /t /pid ${Number(appPid)} >nul 2>&1`,
    'ping -n 3 127.0.0.1 >nul',
    `echo %date% %time% running the installer >> ${q(logPath)}`,
    installCommand || `start /wait "" msiexec /i ${q(msiPath)} /passive /norestart`,
    `echo %date% %time% the installer finished with code %errorlevel% >> ${q(logPath)}`,
    // the app opens again either way: the new one after an install, the old one if it was cancelled
    `echo %date% %time% opening the app >> ${q(logPath)}`,
    `start "" ${q(path.join(installDir, 'app.exe'))}`,
    ''
  ].join('\r\n');
}

// starts the script as a process of its own. it goes through powershell so that it is not a
// child of this app: closing the app (and everything under it) must not close the script
function runDetached(scriptPath) {
  const quoted = scriptPath.replace(/'/g, "''");
  const command = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','"${quoted}"' -WindowStyle Hidden`;
  // encoded, so no quote of the script's path can be mangled on the way to powershell
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
  child.unref();
}

function createInstaller({ dataDir, installDir, appPid, shellVersion, getManifest, log = () => {}, prefixes, dryRun = false, launch = runDetached }) {
  const allowedPrefixes = prefixes && prefixes.length ? prefixes : [RELEASE_PREFIX];
  const dir = path.join(dataDir, 'installers');
  const available = process.platform === 'win32' && Boolean(installDir) && fs.existsSync(path.join(installDir, 'app.exe'));
  let state = { state: 'idle' };
  let busy = false;

  function status() {
    return { ...state };
  }

  function removeQuietly(file) {
    try { fs.rmSync(file, { force: true }); } catch { /* left for next time */ }
  }

  function download(entry, part, final) {
    return axios.get(entry.url, { responseType: 'stream', timeout: 30000, maxRedirects: 5, validateStatus: (s) => s === 200 }).then((response) => new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let done = 0;
      let watchdog = null;
      const fail = (error) => { clearTimeout(watchdog); response.data.destroy(); out.destroy(); reject(error); };
      const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => fail(new Error('the download stopped')), IDLE_MS); };
      arm();
      response.data.on('data', (chunk) => {
        arm();
        done += chunk.length;
        if (done > entry.size) { fail(new Error('the installer is bigger than it should be')); return; }
        hash.update(chunk);
        state = { state: 'downloading', done, total: entry.size };
      });
      response.data.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        clearTimeout(watchdog);
        if (done !== entry.size) return reject(new Error('the installer has the wrong size'));
        if (hash.digest('hex') !== entry.sha256) return reject(new Error('the installer does not match its hash'));
        try { fs.renameSync(part, final); } catch (error) { return reject(error); }
        resolve();
      });
      response.data.pipe(out);
    }));
  }

  async function job() {
    let part = '';
    try {
      state = { state: 'checking' };
      const manifest = await getManifest();
      if (compareVersions(manifest.version, shellVersion) <= 0) throw coded('up_to_date', 'already up to date');
      const entry = installerEntry(manifest, allowedPrefixes);
      fs.mkdirSync(dir, { recursive: true });
      for (const old of fs.readdirSync(dir)) {
        if (old !== entry.name) removeQuietly(path.join(dir, old));
      }
      const final = path.join(dir, entry.name);
      part = `${final}.part`;
      removeQuietly(final);
      state = { state: 'downloading', done: 0, total: entry.size };
      await download(entry, part, final);

      const scriptPath = path.join(dir, 'install-update.cmd');
      fs.writeFileSync(scriptPath, buildScript({ appPid, installDir, msiPath: final, logPath: path.join(dir, 'install-update.log') }));
      if (dryRun) {
        state = { state: 'ready', version: manifest.version, file: final, script: scriptPath };
        log(`[UPDATE] installer for ${manifest.version} downloaded and checked (dry run, not started)`);
        return;
      }
      state = { state: 'installing', version: manifest.version };
      log(`[UPDATE] installer for ${manifest.version} downloaded and checked, closing the app to run it`);
      launch(scriptPath);
    } catch (error) {
      if (part) removeQuietly(part);
      log(`[UPDATE] install failed: ${error.message}`, true);
      state = { state: 'failed', code: error.code || 'failed', error: error.message || 'failed' };
    } finally {
      busy = false;
    }
  }

  function start() {
    if (!available) throw coded('not_installed', 'this is not an installed app');
    if (busy) throw coded('busy', 'an update is already running');
    busy = true;
    state = { state: 'checking' };
    job();
  }

  return { available, start, status };
}

module.exports = { createInstaller, installerEntry, buildScript, runDetached, RELEASE_PREFIX };
