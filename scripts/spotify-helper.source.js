// the spotify helper: a bookmark that runs on a spotify playlist, album or liked songs page in a browser. Spotify only draws the rows
// that are on the screen, so this scrolls down the whole list, collects every title and artist, and gives them back in the format the
// app's import understands (the same json as a playlist export). nothing is sent anywhere: the list is copied, and pasted into the app
// by the person. scripts/make-spotify-helper.js turns this file into the bookmark and the helper page (public/spotify-helper.html)
(function () {
  if (window.__shibenchiHelper) { window.__shibenchiHelper.open(); return; }

  var ACCENT = '255, 89, 0';
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var text = function (el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };

  // ---- the panel, in the look of the app: dark glass, a thin outline in the theme color, buttons that fill on hover
  var host = document.createElement('div');
  host.setAttribute('data-shibenchi-helper', '');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:14px;border-radius:8px;background:rgba(8,8,8,0.86);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);box-shadow:0 8px 28px rgba(0,0,0,0.5);font-family:' + FONT + ';font-size:13px;line-height:1.4;color:#e5e7eb;';
  var title = document.createElement('div');
  title.textContent = 'shibenchi spotify helper';
  title.style.cssText = 'font-size:14px;font-weight:600;color:rgb(' + ACCENT + ');margin-bottom:8px;';
  var status = document.createElement('div');
  status.style.cssText = 'min-height:36px;margin-bottom:10px;color:#e5e7eb;word-break:break-word;';
  var bar = document.createElement('div');
  bar.style.cssText = 'height:6px;border-radius:6px;background:rgba(255,255,255,0.1);overflow:hidden;margin-bottom:12px;';
  var fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:0%;background:rgb(' + ACCENT + ');';
  bar.appendChild(fill);
  var buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  host.appendChild(title); host.appendChild(status); host.appendChild(bar); host.appendChild(buttons);

  var makeButton = function (label, onClick, danger) {
    var color = danger ? '239, 68, 68' : ACCENT;
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    var rest = 'cursor:pointer;padding:5px 12px;border-radius:6px;font-family:' + FONT + ';font-size:12px;background:transparent;color:rgb(' + color + ');border:1px solid rgb(' + color + ');';
    var hover = 'cursor:pointer;padding:5px 12px;border-radius:6px;font-family:' + FONT + ';font-size:12px;background:rgb(' + color + ');color:#000;border:1px solid rgb(' + color + ');';
    b.style.cssText = rest;
    b.onmouseenter = function () { if (!b.disabled) b.style.cssText = hover; };
    b.onmouseleave = function () { b.style.cssText = rest; };
    b.onclick = onClick;
    b.setLabel = function (next) { b.textContent = next; };
    buttons.appendChild(b);
    return b;
  };

  var cancelled = false;
  var result = null;
  var say = function (message, done, total) {
    status.textContent = message;
    fill.style.width = (total ? Math.min(100, Math.round((done / total) * 100)) : done ? 100 : 0) + '%';
  };

  // ---- reading the page
  var findRows = function () { return Array.prototype.slice.call(document.querySelectorAll('[data-testid="tracklist-row"]')); };
  var scrollerOf = function (row) {
    var el = row && row.parentElement;
    while (el && el !== document.documentElement) {
      var overflow = getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  var pageName = function () {
    var h = document.querySelector('[data-testid="entityTitle"] h1, h1[data-testid="entityTitle"], [data-testid="entityTitle"]');
    var name = text(h);
    if (!name) name = String(document.title || '').split(/\s[|–-]\s/)[0].trim();
    return name || 'spotify playlist';
  };
  var declaredCount = function () {
    var spans = document.querySelectorAll('[data-testid="playlist-page"] span, [data-testid="album-page"] span, main span, section span');
    for (var i = 0; i < spans.length; i += 1) {
      var m = /^([\d,.\s]+)\s+(songs?|tracks?)$/i.exec(text(spans[i]));
      if (m) { var n = parseInt(m[1].replace(/[^\d]/g, ''), 10); if (n > 0) return n; }
    }
    return 0;
  };
  var headerArtists = function () {
    // only an album has one artist for every row (on a playlist the creator is the person who made it)
    var links = document.querySelectorAll('[data-testid="album-page"] [data-testid="creator-link"], [data-testid="album-page"] a[href^="/artist/"]');
    var names = [];
    for (var i = 0; i < links.length; i += 1) { var t = text(links[i]); if (t && names.indexOf(t) < 0) names.push(t); }
    return names.join(', ');
  };
  var readRow = function (row, fallbackArtist) {
    var titleLink = row.querySelector('a[data-testid="internal-track-link"]') || row.querySelector('a[href^="/track/"]');
    var songTitle = text(titleLink);
    if (!songTitle) return null;
    var seen = {};
    var artists = [];
    var links = row.querySelectorAll('a[href^="/artist/"]');
    for (var i = 0; i < links.length; i += 1) { var t = text(links[i]); if (t && !seen[t]) { seen[t] = true; artists.push(t); } }
    var durationMs = 0;
    var cells = row.querySelectorAll('[role="gridcell"]');
    for (var c = cells.length - 1; c >= 0; c -= 1) {
      var d = /^(?:(\d+):)?(\d{1,2}):(\d\d)$/.exec(text(cells[c]));
      if (d) { durationMs = (((parseInt(d[1] || '0', 10) * 60) + parseInt(d[2], 10)) * 60 + parseInt(d[3], 10)) * 1000; if (!d[1]) durationMs = (parseInt(d[2], 10) * 60 + parseInt(d[3], 10)) * 1000; break; }
    }
    var first = cells[0] ? text(cells[0]) : '';
    var index = /^\d+$/.test(first) ? parseInt(first, 10) : parseInt((row.parentElement && row.parentElement.getAttribute('aria-rowindex')) || '0', 10);
    return { index: index, title: songTitle, author: artists.join(', ') || fallbackArtist || '', durationMs: durationMs };
  };

  var run = async function () {
    cancelled = false;
    result = null;
    copyButton.disabled = true; saveButton.disabled = true;
    var rows = findRows();
    if (!rows.length) {
      say('open a playlist, an album or your liked songs first, then press this again');
      return;
    }
    var scroller = scrollerOf(rows[0]);
    var total = declaredCount();
    var fallbackArtist = headerArtists();
    var found = {};
    var order = [];
    var count = function () { return order.length; };
    var collect = function () {
      var list = findRows();
      for (var i = 0; i < list.length; i += 1) {
        var item = readRow(list[i], fallbackArtist);
        if (!item) continue;
        var key = item.index > 0 ? 'i' + item.index : 't' + item.title + '|' + item.author + '|' + i;
        if (!found[key]) { found[key] = item; order.push(key); }
      }
    };
    scroller.scrollTop = 0;
    await sleep(500);
    var atBottom = function () { return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4; };
    var stuck = 0;
    for (var step = 0; step < 6000 && !cancelled; step += 1) {
      collect();
      say('reading the list: ' + count() + (total ? ' of ' + total : '') + ' songs', count(), total);
      if (total && count() >= total) break;
      var before = count();
      scroller.scrollTop += Math.max(200, Math.floor(scroller.clientHeight * 0.8));
      await sleep(220);
      collect();
      // spotify draws placeholders for rows it has not loaded yet: while nothing new shows up, wait a few seconds for them
      var waited = 0;
      while (count() === before && waited < 6000 && !cancelled) { await sleep(200); waited += 200; collect(); }
      if (count() === before) {
        if (atBottom()) break;
        stuck += 1;
        if (stuck >= 3) break;
      } else {
        stuck = 0;
      }
    }

    // a row that went by while the next ones were still loading is looked for again, at the place where it must be
    var missingRows = function () {
      var top = total || 0;
      order.forEach(function (key) { if (found[key].index > top) top = found[key].index; });
      var list = [];
      for (var n = 1; n <= top; n += 1) if (!found['i' + n]) list.push(n);
      return list;
    };
    var geometry = function () {
      var visible = findRows().map(function (row) { var item = readRow(row, ''); return item && item.index > 0 ? { index: item.index, top: row.getBoundingClientRect().top + scroller.scrollTop } : null; }).filter(Boolean);
      if (visible.length < 2) return null;
      var a = visible[0]; var b = visible[visible.length - 1];
      if (b.index === a.index) return null;
      var height = (b.top - a.top) / (b.index - a.index);
      return { height: height, base: a.top - (a.index - 1) * height };
    };
    for (var pass = 0; pass < 3 && !cancelled && missingRows().length; pass += 1) {
      var shape = geometry();
      if (!shape) break;
      var gaps = missingRows();
      var from = 0;
      for (var g = 0; g < gaps.length && !cancelled; g += 1) {
        if (found['i' + gaps[g]]) continue;
        scroller.scrollTop = Math.max(0, shape.base + (gaps[g] - 1) * shape.height - scroller.clientHeight / 2);
        var tries = 0;
        await sleep(350);
        collect();
        while (!found['i' + gaps[g]] && tries < 10 && !cancelled) { await sleep(300); tries += 1; collect(); }
        from += 1;
        say('filling in a gap: ' + count() + (total ? ' of ' + total : '') + ' songs', count(), total);
      }
    }
    collect();
    scroller.scrollTop = 0;
    if (cancelled) { say('stopped at ' + count() + ' songs'); return; }

    var tracks = order.map(function (key) { return found[key]; }).sort(function (a, b) { return (a.index || 1e9) - (b.index || 1e9); }).map(function (item) { return { title: item.title, author: item.author, durationMs: item.durationMs }; });
    var name = pageName();
    result = JSON.stringify({ format: 'shibenchi-playlist', version: 1, name: name, source: 'spotify-helper', trackCount: tracks.length, tracks: tracks });
    // spotify shows a visitor who is not logged in only the first songs of a list, so say that instead of "could not be read"
    var loggedOut = !!document.querySelector('[data-testid="login-button"], [data-testid="signup-bar"]');
    var missing = total && tracks.length < total
      ? (loggedOut ? ' (spotify only shows ' + tracks.length + ' songs until you log in there, then press read again)' : ' (' + (total - tracks.length) + ' could not be read)')
      : '';
    say(tracks.length + ' songs from "' + name + '"' + missing + '. copy them and paste in the app', tracks.length, tracks.length);
    copyButton.disabled = false; saveButton.disabled = false;
    copy(true);
  };

  var copy = function (quiet) {
    if (!result) return;
    var done = function () { copyButton.setLabel('copied'); setTimeout(function () { copyButton.setLabel('copy'); }, 2000); };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = result; area.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(area); area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      if (ok) done(); else if (!quiet) say('the browser would not copy it, use save file instead');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(result).then(done, fallback); else fallback();
  };
  var save = function () {
    if (!result) return;
    var blob = new Blob([result], { type: 'application/json' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = pageName().replace(/[^\w\- ]+/g, '').trim().toLowerCase().replace(/\s+/g, '-') + '.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 4000);
  };

  var copyButton = makeButton('copy', function () { copy(false); });
  var saveButton = makeButton('save file', save);
  var againButton = makeButton('read again', function () { if (!window.__shibenchiRunning) start(); });
  var stopButton = makeButton('stop', function () { cancelled = true; });
  var closeButton = makeButton('close', function () { cancelled = true; host.remove(); window.__shibenchiHelper = null; }, true);
  copyButton.disabled = true; saveButton.disabled = true;

  var start = function () {
    window.__shibenchiRunning = true;
    run().catch(function (error) { say('something went wrong: ' + (error && error.message ? error.message : error)); }).then(function () { window.__shibenchiRunning = false; });
  };
  window.__shibenchiHelper = { open: function () { if (!host.parentNode) document.body.appendChild(host); } };
  document.body.appendChild(host);
  start();
})();
