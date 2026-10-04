// `npm run build`, with the version from package.json baked into the screens as
// REACT_APP_VERSION. the app compares that with the club server's version to know
// when an update is out (a phone can not read package.json at run time)
const { spawnSync } = require('child_process');
const path = require('path');

const version = require('../package.json').version;
const reactScripts = require.resolve('react-scripts/bin/react-scripts.js');

const result = spawnSync(process.execPath, [reactScripts, 'build'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, REACT_APP_VERSION: version }
});

process.exit(result.status === null ? 1 : result.status);
