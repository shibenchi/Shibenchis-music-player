// turns a finished desktop build of the screens into the files the club server
// publishes for in-app updates: update-files/ui/** and a signed update-files/manifest.json
//
//   node scripts/make-update-bundle.js [buildDir] [outDir]
//
// buildDir has to be the build made WITH the club server addresses in the
// environment (the one `npm run desktop-build` leaves in build/), a build without
// them would point every updated app at itself. the signing key is read from
// SMP_UPDATE_KEY or ~/.smp-update-signing-key.pem and never leaves this computer
//
// "smp.minShell" in package.json is the oldest installer the bundle can run on.
// raise it to the current version whenever a change needs something that is not in
// the screens (native code, the local server code, a new permission). SMP_MIN_SHELL
// in the environment overrides it for one run
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const buildDir = path.resolve(root, process.argv[2] || 'build');
const outDir = path.resolve(root, process.argv[3] || 'update-files');
const minShell = process.env.SMP_MIN_SHELL || (pkg.smp && pkg.smp.minShell) || pkg.version;
const keyFile = process.env.SMP_UPDATE_KEY || path.join(os.homedir(), '.smp-update-signing-key.pem');

function fail(message) {
  console.error(`make-update-bundle: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(buildDir, 'index.html'))) fail(`no build found in ${buildDir}`);
if (!fs.existsSync(keyFile)) fail(`signing key not found at ${keyFile}`);

const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const rel = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
  return rel.endsWith('.map') ? [] : [rel];
});
const names = walk(buildDir).sort();

// the build has to carry the server addresses and the version it is published as
const mainScripts = names.filter((name) => /^static\/js\/main\..*\.js$/.test(name));
if (!mainScripts.length) fail('no main script in the build');
const mainText = mainScripts.map((name) => fs.readFileSync(path.join(buildDir, name), 'utf8')).join('\n');
if (!mainText.includes('shibenchi.members.purduehackers.com')) fail('this build has no club server address in it, build it with the REACT_APP_SOCIAL_* variables set');
if (!mainText.includes(`"${pkg.version}"`)) fail(`this build was not made at version ${pkg.version}, run the build again`);

const uiDir = path.join(outDir, 'ui');
fs.rmSync(uiDir, { recursive: true, force: true });
const files = names.map((name) => {
  const bytes = fs.readFileSync(path.join(buildDir, name));
  const target = path.join(uiDir, ...name.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});

const manifest = JSON.stringify({
  version: pkg.version,
  minShell: minShell,
  createdAt: new Date().toISOString(),
  files
});
const signature = crypto.sign(null, Buffer.from(manifest, 'utf8'), crypto.createPrivateKey(fs.readFileSync(keyFile))).toString('base64');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ manifest, signature }));

const total = files.reduce((sum, f) => sum + f.size, 0);
console.log(`update bundle for ${pkg.version}: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB, minShell ${minShell} -> ${outDir}`);
