// the two screens of the spotify helper, opened by ?view=spotify-helper and ?view=spotify-send (see index.js). they are the app's own
// screens, so they look like it, they talk to the server the app talks to (with the same second address when the first one does not
// answer) and the person never has to visit the club's address in a browser.
//  - spotify-helper: gives the bookmark that reads a long playlist on open.spotify.com
//  - spotify-send: the window the bookmark opens. the person signs in here (never on the spotify page, whose scripts could read a
//    password), and the list that the bookmark read goes to their account, where the app picks it up from the import menu
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card } from 'react-bootstrap';
import { socialFetch } from './socialApi';
import { SPOTIFY_BOOKMARK_CODE } from './spotifyHelperBookmark';

const DEFAULT_COLOR = { r: 255, g: 89, b: 0 };
const THEME_KEY = 'smp_helper_theme';
const TOKEN_KEY = 'smp_helper_token';

const rgb = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`;
const part = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));

function savedColor() {
  try {
    const c = JSON.parse(window.localStorage.getItem(THEME_KEY) || 'null');
    if (c && typeof c === 'object') return { r: part(c.r), g: part(c.g), b: part(c.b) };
  } catch (e) { /* the default */ }
  return DEFAULT_COLOR;
}

// the same variables that the app puts on the page for its theme color
function applyColor(c) {
  const root = document.documentElement;
  root.style.setProperty('--theme-primary', rgb(c));
  root.style.setProperty('--theme-primary-rgb', `${c.r}, ${c.g}, ${c.b}`);
  root.style.setProperty('--theme-primary-rgba', `rgba(${c.r}, ${c.g}, ${c.b}, 0.25)`);
  root.style.setProperty('--theme-primary-dark', `rgba(${c.r}, ${c.g}, ${c.b}, 0.15)`);
  root.style.setProperty('--theme-glow', `rgba(${c.r}, ${c.g}, ${c.b}, 0.5)`);
  root.style.setProperty('--theme-shadow', `rgba(${c.r}, ${c.g}, ${c.b}, 0.3)`);
}

// the bar at the top of the app: black, the title in the color of the account, a line under it
function TopBar({ color }) {
  return (
    <div data-topbar style={{ height: '58px', background: '#000', borderBottom: `2px solid ${rgb(color)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)' }}>
      <span data-title style={{ color: rgb(color), fontSize: '14px', fontWeight: 'bold', letterSpacing: '0.5px' }}>Shibenchi's music player</span>
    </div>
  );
}

// a heading of a box like the ones in the app's settings: white, with a line under it
function Label({ children }) {
  return <h4 style={{ fontSize: '12px', fontWeight: 'normal', color: '#fff', borderBottom: '1px solid rgba(255, 255, 255, 0.75)', paddingBottom: '4px', margin: '0 0 12px' }}>{children}</h4>;
}

function inputStyle(color) {
  return { width: '100%', background: '#000', border: `1px solid rgba(${color.r}, ${color.g}, ${color.b}, 0.55)`, borderRadius: 0, padding: '9px 10px', color: '#fff', fontSize: '12px', outline: 'none', marginBottom: '8px' };
}

function useBodyLook(color) {
  useEffect(() => {
    document.title = "Shibenchi's music player";
    document.body.style.background = '#000';
    document.body.style.minHeight = '100vh';
  }, []);
  useEffect(() => { applyColor(color); }, [color]);
}

// ---- the page that gives the bookmark
export function SpotifyHelperPage() {
  const [color] = useState(savedColor);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef(null);
  useBodyLook(color);
  const code = SPOTIFY_BOOKMARK_CODE.split('__SMP_ORIGIN__').join(window.location.origin);

  // the address is set on the element itself (the page would not let a javascript: address through its own markup)
  useEffect(() => {
    if (linkRef.current) linkRef.current.setAttribute('href', 'javascript:' + encodeURIComponent(code));
  }, [code]);

  const copy = () => {
    const text = 'javascript:' + code;
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = text; area.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
      area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  };

  const step = (n, children) => (
    <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
      <span style={{ flexShrink: 0, width: '22px', height: '22px', border: `1px solid ${rgb(color)}`, borderRadius: 'var(--border-radius-sm)', color: rgb(color), fontSize: '12px', textAlign: 'center', lineHeight: '20px' }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );

  return (
    <div style={{ background: '#000', color: '#fff', minHeight: '100vh', fontSize: '13px' }}>
      <TopBar color={color} />
      <div style={{ maxWidth: '560px', margin: '0 auto', padding: '20px 16px' }}>
        <Card className="card-hover shadow-sm" style={{ marginBottom: '16px', color: '#fff' }}>
          <Card.Body>
            <Label>spotify helper</Label>
            <p style={{ color: '#9ca3af', fontSize: '12px', marginBottom: '16px' }}>for spotify playlists with more than 100 songs. it reads the whole list on the spotify website and sends it to your account</p>
            {step(1, (
              <>
                <div>drag this button up to your bookmarks bar</div>
                <div className="d-flex gap-2 flex-wrap" style={{ marginTop: '8px' }}>
                  <a ref={linkRef} className="btn btn-outline-light btn-sm" data-bookmark draggable="true" title="drag me to the bookmarks bar" onClick={(e) => e.preventDefault()}>send to shibenchi</a>
                  <Button variant="outline-light" size="sm" data-copy-bookmark onClick={copy}>{copied ? 'copied' : 'copy the code'}</Button>
                </div>
                <div style={{ color: '#9ca3af', fontSize: '12px', marginTop: '8px' }}>the bookmark does nothing: copy the code, open the spotify page, press F12, open the console tab, paste the code there and press enter. if the window does not open, press save file on the spotify page and import the file in the app (import, from file)</div>
              </>
            ))}
            {step(2, <div>open the playlist on <strong style={{ color: rgb(color) }}>open.spotify.com</strong> in your browser and press the bookmark. a small window opens, sign in there with your shibenchi account</div>)}
            {step(3, <div>the list goes to your account on its own. in the app open a playlist, press <strong style={{ color: rgb(color) }}>import</strong>, <strong style={{ color: rgb(color) }}>from spotify</strong>, and press import on it</div>)}
          </Card.Body>
        </Card>
        <p style={{ color: '#9ca3af', fontSize: '12px' }}>the helper only reads the page you have open and sends the song names to your own account. your password is typed in its own window, never on the spotify page</p>
      </div>
    </div>
  );
}

// ---- the window that the bookmark opens
export function SpotifySendWindow() {
  const [color, setColor] = useState(savedColor);
  const [token, setToken] = useState(() => { try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } });
  const [username, setUsername] = useState('');
  const [latest, setLatest] = useState({ phase: 'idle', done: 0, total: 0, name: '', count: 0, note: '' });
  const [tracks, setTracks] = useState(null);
  const [sendState, setSendState] = useState('idle'); // idle, sending, sent, failed
  const [sendError, setSendError] = useState('');
  const [form, setForm] = useState({ user: '', pass: '', error: '', busy: false });
  const tokenRef = useRef(token);
  tokenRef.current = token;
  useBodyLook(color);

  // the page of spotify is the only one this window listens to (a local address is allowed too, for tests on this computer)
  const from = useRef(['https://open.spotify.com']);
  useEffect(() => {
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
      try { const extra = window.localStorage.getItem('smp_helper_test_origin'); if (extra) from.current.push(extra); } catch (e) { /* none */ }
    }
  }, []);
  const tell = useCallback((message) => {
    if (!window.opener || window.opener.closed) return;
    from.current.forEach((origin) => { try { window.opener.postMessage({ shibenchi: 1, ...message }, origin); } catch (e) { /* not this one */ } });
  }, []);

  const call = useCallback((method, path, body, useToken = true) => socialFetch(path, {
    method,
    headers: useToken && tokenRef.current ? { Authorization: 'Bearer ' + tokenRef.current } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then((r) => r.json().catch(() => ({})).then((json) => ({ status: r.status, json }))), []);

  const rememberColor = useCallback((c) => {
    const next = { r: part(c && c.r), g: part(c && c.g), b: part(c && c.b) };
    setColor(next);
    try { window.localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch (e) { /* none */ }
    tell({ type: 'theme', color: next });
  }, [tell]);

  const signOut = useCallback((quiet) => {
    const old = tokenRef.current;
    setToken('');
    setUsername('');
    try { window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* none */ }
    if (old && !quiet) call('POST', '/api/helper/logout').catch(() => {});
  }, [call]);

  // a sign in from earlier is picked up again, and gives the window the color of the account
  useEffect(() => {
    if (!tokenRef.current) return;
    call('GET', '/api/helper/me').then((r) => {
      if (r.status === 200) { setUsername(r.json.username); rememberColor(r.json.theme); } else signOut(true);
    }).catch(() => {});
  }, [call, rememberColor, signOut]);

  // the list goes to the account as soon as there is both a list and a sign in
  useEffect(() => {
    if (sendState !== 'idle' || !token || latest.phase !== 'done' || !tracks || !tracks.length) return;
    setSendState('sending');
    call('POST', '/api/helper/imports', { name: latest.name, tracks }).then((r) => {
      if (r.status === 200) { setSendState('sent'); tell({ type: 'sent' }); return; }
      if (r.status === 401) { signOut(true); setSendState('idle'); setForm((f) => ({ ...f, error: 'sign in again to send it' })); return; }
      setSendState('failed'); setSendError((r.json && r.json.error) || 'the list could not be sent');
    }).catch(() => { setSendState('failed'); setSendError('could not reach the server'); });
  }, [token, latest.phase, latest.name, tracks, sendState, call, tell, signOut]);

  useEffect(() => {
    const onMessage = (event) => {
      const data = event.data;
      if (event.source !== window.opener || from.current.indexOf(event.origin) < 0 || !data || data.shibenchi !== 1 || data.type !== 'state') return;
      setLatest((old) => {
        if (data.phase === 'reading' && old.phase !== 'reading') { setTracks(null); setSendState('idle'); setSendError(''); }
        return { phase: data.phase, done: data.done || 0, total: data.total || 0, name: data.name || '', count: data.count || 0, note: data.note || '' };
      });
      if (Array.isArray(data.tracks)) setTracks(data.tracks);
    };
    window.addEventListener('message', onMessage);
    tell({ type: 'hello' });
    return () => window.removeEventListener('message', onMessage);
  }, [tell]);

  const login = async () => {
    const user = form.user.trim();
    if (!user || !form.pass) { setForm((f) => ({ ...f, error: 'type your username and password' })); return; }
    setForm((f) => ({ ...f, busy: true, error: '' }));
    try {
      // its own sign in with a token that only sends lists: the person's app stays signed in
      const r = await call('POST', '/api/helper/login', { username: user, password: form.pass }, false);
      if (r.status === 200) {
        tokenRef.current = r.json.token;
        try { window.localStorage.setItem(TOKEN_KEY, r.json.token); } catch (e) { /* none */ }
        setToken(r.json.token); setUsername(r.json.username); rememberColor(r.json.theme);
        setForm({ user: '', pass: '', error: '', busy: false });
      } else {
        setForm((f) => ({ ...f, busy: false, error: r.status === 404 ? 'this server does not have the spotify helper yet' : (r.json && r.json.error) || 'could not sign in' }));
      }
    } catch (e) {
      setForm((f) => ({ ...f, busy: false, error: 'could not reach the server' }));
    }
  };

  let line = window.opener ? 'waiting for the spotify page' : 'open this window with the bookmark on a spotify playlist';
  let pct = 0;
  if (latest.phase === 'reading') { line = `reading the list: ${latest.done}${latest.total ? ' of ' + latest.total : ''} songs`; pct = latest.total ? (latest.done / latest.total) * 100 : 0; }
  if (latest.phase === 'stopped') line = `stopped at ${latest.done} songs`;
  if (latest.phase === 'error') line = latest.note || 'something went wrong';
  if (latest.phase === 'done') {
    pct = 100;
    line = `"${latest.name}", ${latest.count} songs${latest.note ? ' (' + latest.note + ')' : ''}`;
    if (sendState === 'sending') line += '. sending to your account';
    else if (sendState === 'sent') line += '. sent to your account. in the app: import, from spotify';
    else if (sendState === 'failed') line += '. ' + sendError;
    else if (!token) line += '. sign in to send it to your account';
  }

  const border = { borderRadius: '6px', color: rgb(color), border: `1px solid ${rgb(color)}` };
  return (
    <div style={{ background: '#000', color: '#fff', minHeight: '100vh', fontSize: '13px' }} data-helper-window>
      <TopBar color={color} />
      <div style={{ maxWidth: '440px', margin: '0 auto', padding: '16px' }}>
        <Card className="card-hover shadow-sm" style={{ marginBottom: '16px', color: '#fff' }}>
          <Card.Body>
            <Label>account</Label>
            {token && username ? (
              <div className="d-flex justify-content-between align-items-center" data-signed-in>
                <span>logged in as <strong style={{ color: rgb(color) }} data-who>{username}</strong></span>
                <Button variant="outline-danger" size="sm" data-logout onClick={() => signOut(false)}>logout</Button>
              </div>
            ) : (
              <div data-signed-out>
                <input style={inputStyle(color)} data-user placeholder="username" autoComplete="username" spellCheck={false} value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') document.querySelector('[data-pass]').focus(); }} />
                <input style={inputStyle(color)} data-pass type="password" placeholder="password" autoComplete="current-password" value={form.pass}
                  onChange={(e) => setForm({ ...form, pass: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') login(); }} />
                <div data-error style={{ color: '#ef4444', fontSize: '12px', minHeight: '18px', margin: '2px 0 8px' }}>{form.error}</div>
                <div className="d-flex justify-content-end">
                  <Button variant="outline-light" size="sm" data-login disabled={form.busy} onClick={login} style={border}>login</Button>
                </div>
              </div>
            )}
          </Card.Body>
        </Card>
        <Card className="card-hover shadow-sm" style={{ color: '#fff' }}>
          <Card.Body>
            <Label>playlist</Label>
            <div data-status>{line}</div>
            <div style={{ height: '6px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '3px', overflow: 'hidden', margin: '8px 0 14px' }}>
              <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: rgb(color) }} />
            </div>
            <div className="d-flex justify-content-end gap-2">
              <Button variant="outline-light" size="sm" data-again disabled={!window.opener || latest.phase === 'reading'}
                onClick={() => { setSendState('idle'); setTracks(null); setLatest({ phase: 'reading', done: 0, total: 0, name: latest.name, count: 0, note: '' }); tell({ type: 'again' }); }} style={border}>read again</Button>
              <Button variant="outline-danger" size="sm" data-stop disabled={latest.phase !== 'reading'} onClick={() => tell({ type: 'stop' })}>stop</Button>
            </div>
          </Card.Body>
        </Card>
      </div>
    </div>
  );
}
