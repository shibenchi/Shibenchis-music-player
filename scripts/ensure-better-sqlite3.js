const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const packageName = 'better-sqlite3';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const guardEnvVar = 'SMP_SKIP_BETTER_SQLITE3_FIX';

function log(message) {
  console.log(`[native] ${message}`);
}

function loadBetterSqlite3() {
  try {
    const resolved = require.resolve(packageName, { paths: [projectRoot] });
    delete require.cache[resolved];
    require(resolved);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function runNpm(args, label) {
  log(label);
  const result = spawnSync(npmCommand, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      [guardEnvVar]: '1'
    },
    stdio: 'inherit'
  });

  return result.status === 0;
}

if (process.env[guardEnvVar] === '1') {
  process.exit(0);
}

const initialLoad = loadBetterSqlite3();
if (initialLoad.ok) {
  log('better-sqlite3 is ready');
  process.exit(0);
}

log(`better-sqlite3 needs repair: ${initialLoad.error.message}`);

const repairAttempts = [
  {
    args: ['rebuild', packageName, '--update-binary'],
    label: 'trying npm rebuild better-sqlite3 --update-binary'
  },
  {
    args: ['install', `${packageName}@^12.8.0`, '--no-save', '--foreground-scripts'],
    label: 'trying a no-save reinstall of better-sqlite3'
  }
];

for (const attempt of repairAttempts) {
  if (!runNpm(attempt.args, attempt.label)) {
    continue;
  }

  const loadResult = loadBetterSqlite3();
  if (loadResult.ok) {
    log('better-sqlite3 is ready');
    process.exit(0);
  }

  log(`better-sqlite3 still failed to load: ${loadResult.error.message}`);
}

console.error('[native] better-sqlite3 could not be repaired automatically');
process.exit(1);
