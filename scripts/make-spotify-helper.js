// turns scripts/spotify-helper.source.js (the bookmark that reads a long playlist on open.spotify.com) into src/spotifyHelperBookmark.js,
// which the helper screen (src/SpotifyHelper.js) hands out with the address of the app filled in. run it after changing the source:
//   node scripts/make-spotify-helper.js
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'spotify-helper.source.js'), 'utf8');
  const result = await minify(source, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
  if (!result.code) throw new Error('nothing came out of the minifier');
  const out = '// made by scripts/make-spotify-helper.js from scripts/spotify-helper.source.js, change that one and run the script\n'
    + '// __SMP_ORIGIN__ becomes the address of the app that hands the bookmark out (see SpotifyHelper.js)\n'
    + 'export const SPOTIFY_BOOKMARK_CODE = ' + JSON.stringify(result.code) + ';\n';
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'spotifyHelperBookmark.js'), out);
  // the plain minified code, for a test that wants to run it on a page without the bookmark around it
  if (process.env.SPOTIFY_HELPER_MIN) fs.writeFileSync(process.env.SPOTIFY_HELPER_MIN, result.code);
  console.log('bookmark code written, ' + result.code.length + ' characters');
})();
