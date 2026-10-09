// turns scripts/spotify-helper.source.js into the bookmark and into the helper page that hands it out (public/spotify-helper.html).
// run it after changing the source: node scripts/make-spotify-helper.js
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const root = path.join(__dirname, '..');
const sourcePath = path.join(__dirname, 'spotify-helper.source.js');
const pagePath = path.join(root, 'public', 'spotify-helper.html');

const page = (code) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spotify helper</title>
<link rel="icon" href="data:,">
<style>
  :root { --accent: 255, 89, 0; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px; line-height: 1.5; color: #e5e7eb; background: #050505;
    background-image: radial-gradient(60% 50% at 50% 0%, rgba(var(--accent), 0.16), transparent 70%);
    display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px;
  }
  .card {
    width: 100%; max-width: 560px; padding: 22px; border-radius: 8px;
    background: rgba(8, 8, 8, 0.74); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; color: rgb(var(--accent)); }
  .lead { margin: 0 0 18px; color: #9ca3af; font-size: 13px; }
  ol { margin: 0; padding: 0; list-style: none; counter-reset: step; }
  li { counter-increment: step; position: relative; padding: 0 0 18px 34px; }
  li:last-child { padding-bottom: 0; }
  li::before {
    content: counter(step); position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 50%;
    border: 1px solid rgb(var(--accent)); color: rgb(var(--accent)); font-size: 12px; text-align: center; line-height: 20px;
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .btn {
    display: inline-block; cursor: pointer; text-decoration: none; padding: 6px 14px; border-radius: 6px; font: inherit; font-size: 13px;
    color: rgb(var(--accent)); background: transparent; border: 1px solid rgb(var(--accent));
  }
  .btn:hover { background: rgb(var(--accent)); color: #000; }
  .note { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(255, 255, 255, 0.08); color: #9ca3af; font-size: 12px; }
  b { color: #fff; font-weight: 600; }
</style>
</head>
<body>
<div class="card">
  <h1>spotify helper</h1>
  <p class="lead">for spotify playlists with more than 100 songs. it reads the whole list the way you see it on the spotify website and hands it to the app.</p>
  <ol>
    <li>
      drag this button up to your bookmarks bar
      <div class="row">
        <a class="btn" id="bookmark" draggable="true" title="drag me to the bookmarks bar" onclick="return false">send to shibenchi</a>
        <button class="btn" id="copy" type="button">copy the code</button>
      </div>
      <div class="note" style="border:0;padding:0;margin-top:8px">no bookmarks bar: make a new bookmark by hand and paste the copied code where the address goes</div>
    </li>
    <li>open the playlist on <b>open.spotify.com</b> in your browser (the website, not the spotify app) and press the bookmark. it scrolls down the list and copies every song</li>
    <li>
      in shibenchi open a playlist, press <b>import</b>, then <b>from spotify</b>, then <b>paste from helper</b>
      <div class="note" style="border:0;padding:0;margin-top:8px">an older version without that button: press <b>save file</b> on the helper panel, then <b>import</b>, <b>from file</b></div>
    </li>
  </ol>
  <div class="note">nothing is sent anywhere. the helper only reads the page you have open and copies the list to your clipboard.</div>
</div>
<script>
  var CODE = ${JSON.stringify('javascript:' + encodeURIComponent(code)).replace(/</g, '\\u003c')};
  var link = document.getElementById('bookmark');
  link.setAttribute('href', CODE);
  link.addEventListener('click', function (event) { event.preventDefault(); });
  document.getElementById('copy').addEventListener('click', function (event) {
    var button = event.currentTarget;
    var done = function () { button.textContent = 'copied'; setTimeout(function () { button.textContent = 'copy the code'; }, 2000); };
    var fallback = function () {
      var area = document.createElement('textarea'); area.value = CODE; area.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); done(); } catch (e) { button.textContent = 'could not copy'; }
      area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(CODE).then(done, fallback); else fallback();
  });
</script>
</body>
</html>
`;

(async () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = await minify(source, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
  if (!result.code) throw new Error('nothing came out of the minifier');
  fs.writeFileSync(pagePath, page(result.code));
  // the plain minified code, for a test that wants to run it on a page without the bookmark around it
  if (process.env.SPOTIFY_HELPER_MIN) fs.writeFileSync(process.env.SPOTIFY_HELPER_MIN, result.code);
  console.log('helper page written, code is ' + result.code.length + ' characters, the bookmark ' + ('javascript:' + encodeURIComponent(result.code)).length);
})();
