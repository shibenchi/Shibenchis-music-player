// the spotify helper, the part that runs on open.spotify.com (a bookmark). spotify only draws the rows that are on the screen, so this
// scrolls down the whole list of a playlist, an album or the liked songs and collects every title and artist. it opens the helper window
// of the person's own shibenchi server (spotify-send.html) where they sign in and where the list is sent to their account. the page
// of spotify only talks to that window, nothing else, and no password is typed on the spotify page.
// scripts/make-spotify-helper.js turns this file into the bookmark (__SMP_ORIGIN__ becomes the address of the server the page came from)
(function () {
  var ORIGIN = '__SMP_ORIGIN__';
  if (window.__shibenchiHelper) { window.__shibenchiHelper.open(); return; }

  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var text = function (el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; };

  // ---- a small panel on the spotify page, in the look of the app: black, a thin line in the color of the account, buttons that fill on hover
  var host = document.createElement('div');
  host.setAttribute('data-shibenchi-helper', '');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:270px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px;border-radius:5px;background-color:#000;background-image:linear-gradient(rgba(var(--a),0.08),rgba(var(--a),0.08));border:1px solid rgb(var(--a));font-family:' + FONT + ';font-size:12px;line-height:1.4;color:#fff;--a:255,89,0;';
  var style = document.createElement('style');
  style.textContent = '[data-shibenchi-helper] button{cursor:pointer;padding:4px 12px;border-radius:3px;font-family:' + FONT + ';font-size:12px;background:transparent;color:rgb(var(--a));border:1px solid rgb(var(--a));}'
    + '[data-shibenchi-helper] button:hover{background:rgb(var(--a));color:#000;}'
    + '[data-shibenchi-helper] button[data-danger]{color:#ef4444;border-color:#ef4444;}'
    + '[data-shibenchi-helper] button[data-danger]:hover{background:#ef4444;color:#000;}';
  var title = document.createElement('div');
  title.textContent = "Shibenchi's music player";
  title.style.cssText = 'font-size:13px;font-weight:700;text-align:center;color:rgb(var(--a));padding-bottom:8px;margin-bottom:10px;border-bottom:1px solid rgb(var(--a));';
  var status = document.createElement('div');
  status.style.cssText = 'min-height:34px;margin-bottom:10px;word-break:break-word;';
  var bar = document.createElement('div');
  bar.style.cssText = 'height:6px;background:rgba(255,255,255,0.08);margin-bottom:12px;overflow:hidden;border-radius:3px;';
  var fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:0%;background:rgb(var(--a));';
  bar.appendChild(fill);
  var buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
  host.appendChild(style); host.appendChild(title); host.appendChild(status); host.appendChild(bar); host.appendChild(buttons);

  var makeButton = function (label, onClick, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (danger) b.setAttribute('data-danger', '');
    b.onclick = onClick;
    buttons.appendChild(b);
    return b;
  };
  var setAccent = function (color) {
    if (!color) return;
    var part = function (n) { return Math.max(0, Math.min(255, Math.round(Number(n) || 0))); };
    host.style.setProperty('--a', part(color.r) + ',' + part(color.g) + ',' + part(color.b));
  };

  // ---- the helper window (the page of the shibenchi server, where the person signs in)
  var popup = null;
  var state = { phase: 'idle', done: 0, total: 0, name: '', count: 0, tracks: null, note: '' };
  var post = function (message) {
    if (!popup || popup.closed) return;
    var out = { shibenchi: 1, phase: state.phase, done: state.done, total: state.total, name: state.name, count: state.count, note: state.note };
    for (var key in message) out[key] = message[key];
    popup.postMessage(out, ORIGIN);
  };
  // a browser may not let a bookmark open a window (a window is only allowed after a click on the page itself): then the panel has a
  // button for it, and that click is one
  var openButton = null;
  var saveButton = null;
  var syncOpenButton = function () { if (openButton) openButton.style.display = !popup || popup.closed ? '' : 'none'; };
  var say = function (message, done, total) {
    status.textContent = message + (popup && !popup.closed ? windowNote : '. the helper window is not open');
    fill.style.width = (total ? Math.min(100, Math.round((done / total) * 100)) : done ? 100 : 0) + '%';
    syncOpenButton();
    if (saveButton) saveButton.style.display = state.phase === 'done' && state.tracks ? '' : 'none';
  };
  var windowNote = '';
  var helloSeen = false;
  var openPopup = function () {
    if (popup && !popup.closed) { popup.focus(); return true; }
    helloSeen = false;
    windowNote = '';
    popup = window.open('about:blank', 'shibenchi-helper-' + Date.now(), 'popup=yes,width=460,height=680');
    syncOpenButton();
    if (!popup) return false;
    // what the window shows until the app answers: a browser that does not let this page open the app leaves it blank for ever otherwise
    try {
      popup.document.open();
      popup.document.write('<!doctype html><title>Shibenchi\'s music player</title><body style="background:#000;color:#fff;font:13px system-ui,sans-serif;padding:24px">opening your shibenchi window...<p style="color:#9ca3af">if this stays like this, your browser is not letting the spotify page open the app. press save file on the spotify page instead and import the file in the app</p></body>');
      popup.document.close();
    } catch (e) { /* the window is already somewhere else */ }
    popup.location.href = ORIGIN + '/?view=spotify-send';
    setTimeout(function () {
      if (!helloSeen && popup && !popup.closed) { windowNote = '. the helper window has not answered, use save file'; say(status.textContent.split('. the helper window')[0], state.done, state.total); }
    }, 8000);
    return true;
  };
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.origin !== ORIGIN || !popup || event.source !== popup || !data || data.shibenchi !== 1) return;
    if (data.type === 'hello') {
      helloSeen = true;
      windowNote = '';
      post({ type: 'state', tracks: state.phase === 'done' ? state.tracks : null });
    } else if (data.type === 'theme') {
      setAccent(data.color);
    } else if (data.type === 'again') {
      if (!window.__shibenchiRunning) start();
    } else if (data.type === 'stop') {
      cancelled = true;
    } else if (data.type === 'sent') {
      say('sent to your account. import it in the app');
    }
  });

  // ---- reading the page
  var cancelled = false;
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
      if (d) { durationMs = (((parseInt(d[1] || '0', 10) * 60) + parseInt(d[2], 10)) * 60 + parseInt(d[3], 10)) * 1000; break; }
    }
    var first = cells[0] ? text(cells[0]) : '';
    var index = /^\d+$/.test(first) ? parseInt(first, 10) : parseInt((row.parentElement && row.parentElement.getAttribute('aria-rowindex')) || '0', 10);
    return { index: index, title: songTitle, author: artists.join(', ') || fallbackArtist || '', durationMs: durationMs };
  };

  var run = async function () {
    cancelled = false;
    state = { phase: 'reading', done: 0, total: 0, name: pageName(), count: 0, tracks: null, note: '' };
    var rows = findRows();
    if (!rows.length) {
      state.phase = 'error';
      state.note = 'open a playlist, an album or your liked songs first';
      say(state.note + ', then press the bookmark again');
      post({ type: 'state' });
      return;
    }
    var scroller = scrollerOf(rows[0]);
    var total = declaredCount();
    var fallbackArtist = headerArtists();
    state.total = total;
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
    var report = function (label) {
      state.done = count();
      say(label + count() + (total ? ' of ' + total : '') + ' songs', count(), total);
      post({ type: 'state' });
    };
    scroller.scrollTop = 0;
    await sleep(500);
    var atBottom = function () { return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4; };
    var stuck = 0;
    for (var step = 0; step < 6000 && !cancelled; step += 1) {
      collect();
      report('reading the list: ');
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
      for (var g = 0; g < gaps.length && !cancelled; g += 1) {
        if (found['i' + gaps[g]]) continue;
        scroller.scrollTop = Math.max(0, shape.base + (gaps[g] - 1) * shape.height - scroller.clientHeight / 2);
        var tries = 0;
        await sleep(350);
        collect();
        while (!found['i' + gaps[g]] && tries < 10 && !cancelled) { await sleep(300); tries += 1; collect(); }
        report('filling in a gap: ');
      }
    }
    collect();
    scroller.scrollTop = 0;
    if (cancelled) { state.phase = 'stopped'; say('stopped at ' + count() + ' songs'); post({ type: 'state' }); return; }

    var tracks = order.map(function (key) { return found[key]; }).sort(function (a, b) { return (a.index || 1e9) - (b.index || 1e9); }).map(function (item) { return { title: item.title, author: item.author, durationMs: item.durationMs }; });
    // spotify shows a visitor who is not logged in only the first songs of a list, so say that instead of "could not be read"
    var loggedOut = !!document.querySelector('[data-testid="login-button"], [data-testid="signup-bar"]');
    var note = '';
    if (total && tracks.length < total) note = loggedOut ? 'spotify only shows ' + tracks.length + ' songs until you log in there, then read again' : (total - tracks.length) + ' songs could not be read';
    state.phase = 'done';
    state.count = tracks.length;
    state.done = tracks.length;
    state.total = total || tracks.length;
    state.tracks = tracks;
    state.note = note;
    say(tracks.length + ' songs from "' + state.name + '"' + (note ? ' (' + note + ')' : ''), tracks.length, tracks.length);
    post({ type: 'state', tracks: tracks });
  };

  var start = function () {
    window.__shibenchiRunning = true;
    run().catch(function (error) {
      state.phase = 'error';
      state.note = 'something went wrong: ' + (error && error.message ? error.message : error);
      say(state.note);
      post({ type: 'state' });
    }).then(function () { window.__shibenchiRunning = false; });
  };

  saveButton = makeButton('save file', function () {
    if (!state.tracks) return;
    var blob = new Blob([JSON.stringify({ format: 'shibenchi-playlist', version: 1, name: state.name, source: 'spotify-helper', trackCount: state.tracks.length, tracks: state.tracks })], { type: 'application/json' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (state.name || 'spotify playlist').replace(/[^\w\- ]+/g, '').trim().toLowerCase().replace(/\s+/g, '-') + '.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 4000);
  });
  saveButton.style.display = 'none';
  openButton = makeButton('open the window', function () { if (openPopup()) post({ type: 'state', tracks: state.phase === 'done' ? state.tracks : null }); });
  openButton.style.display = 'none';
  makeButton('stop', function () { cancelled = true; });
  makeButton('close', function () { cancelled = true; host.remove(); window.__shibenchiHelper = null; }, true);
  window.__shibenchiHelper = { open: function () { if (!host.parentNode) document.body.appendChild(host); openPopup(); if (!window.__shibenchiRunning && state.phase !== 'done') start(); } };
  document.body.appendChild(host);
  openPopup();
  start();
})();
