// a connected YouTube account, and reading Spotify playlists. a person connects their YouTube account once (the usual sign
// in page of Google, opened in the browser, comes back to this server), and can then send a playlist of the app to it as a
// new playlist, or pick one of their own playlists to bring in. a Spotify playlist is read from its public embed page, which
// needs no account (and holds the first 100 songs of a playlist).
//
// Spotify has no account connection here: since 2026 its api refuses every call of an app (even /me) with a 403 "Active
// premium subscription required for the owner of the app" while the Spotify account that made the app has no Premium.
//
// what has to be set on the server for the YouTube part to work (nothing is offered to the people while it is not):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET     an OAuth client of type "web application" of a Google Cloud project that has
//                                              the YouTube Data API v3 turned on
//   OAUTH_REDIRECT_BASE (or APP_ORIGIN)        the public address of this server, the redirect address registered with
//                                              Google is  <that address>/api/integrations/youtube/callback
// GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, YOUTUBE_API_BASE and SPOTIFY_EMBED_BASE replace the real addresses, for tests against a
// stand in.
//
// tokens are stored scrambled (database.js). the key of the person's own account never leaves this server and no
// other person can use it: every call is made for the signed in account only.
const crypto = require('crypto');

const PROVIDERS = ['youtube'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "Childish Gambino - Topic" and "TheWeekndVEVO" -> the name of the artist
function cleanArtist(author) {
  return String(author || '').replace(/\s*-\s*topic$/i, '').replace(/\s*vevo$/i, '').replace(/\s*official$/i, '').trim();
}

// ---------------------------------------------------------------- reading a Spotify playlist
function spotifyIdFromUrl(input) {
  const text = String(input || '').trim();
  let m = text.match(/^spotify:(playlist|album):([A-Za-z0-9]{10,30})$/);
  if (!m) m = text.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2,5}\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{10,30})(?:[?#/].*)?$/i);
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

// the public embed page of a playlist carries its first songs as json
function parseEmbedTracks(html) {
  const match = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  const entity = data?.props?.pageProps?.state?.data?.entity || data?.props?.pageProps?.state?.data || null;
  if (!entity) return null;
  // the list of songs is the first array of things with a title and an artist line
  const find = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === 'object' && typeof x.title === 'string' && (typeof x.subtitle === 'string' || Array.isArray(x.artists)))) return node;
      for (const child of node) { const found = find(child, depth + 1); if (found) return found; }
      return null;
    }
    for (const key of Object.keys(node)) { const found = find(node[key], depth + 1); if (found) return found; }
    return null;
  };
  const list = Array.isArray(entity.trackList) ? entity.trackList : find(entity);
  if (!list) return null;
  const tracks = list.map((item) => ({
    title: String(item.title || '').trim(),
    author: String(item.subtitle || (item.artists || []).map((a) => a.name).join(', ') || '').split(String.fromCharCode(160)).join(' ').trim(),
    durationMs: Number(item.duration || item.durationMs || 0) || 0
  })).filter((t) => t.title);
  return { name: String(entity.name || entity.title || '').trim(), tracks };
}

// what the public page holds of a playlist (it stops at 100 songs)
const EMBED_LIMIT = 100;

// ---------------------------------------------------------------- the module
function createIntegrations({ app, db, requireAuth, validation, logToFile, getPublicAppUrl, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
  const exportLimiter = validation.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
  const importLimiter = validation.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
  const connectLimiter = validation.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });

  // read each time, so a change of the environment of a test is seen
  const config = () => ({
    id: env.GOOGLE_CLIENT_ID || '', secret: env.GOOGLE_CLIENT_SECRET || '',
    auth: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    api: env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3',
    scope: 'https://www.googleapis.com/auth/youtube'
  });
  const configured = () => { const c = config(); return Boolean(c.id && c.secret); };
  const redirectUri = (provider, req) => `${String(env.OAUTH_REDIRECT_BASE || '').replace(/\/+$/, '') || getPublicAppUrl(req)}/api/integrations/${provider}/callback`;
  const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
  const QUOTA_MESSAGE = "i've run out of youtube quota for the day, i'm sorry";

  async function call(method, url, { token, form, json, headers } = {}) {
    const options = { method, headers: { Accept: 'application/json', ...(headers || {}) }, signal: AbortSignal.timeout(25000) };
    if (token) options.headers.Authorization = `Bearer ${token}`;
    if (form) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(form).toString();
    } else if (json !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(json);
    }
    const response = await fetchImpl(url, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, ok: response.ok, data, text };
  }

  // ---- tokens
  const pendingStates = new Map();
  const outcomes = new Map(); // `user:service` -> { problem, at }
  const noteOutcome = (userId, provider, problem) => {
    if (problem) outcomes.set(`${userId}:${provider}`, { problem, at: Date.now() });
    else outcomes.delete(`${userId}:${provider}`);
  };
  const recentProblem = (userId, provider) => {
    const found = outcomes.get(`${userId}:${provider}`);
    return found && Date.now() - found.at < 10 * 60 * 1000 ? found.problem : '';
  };
  setInterval(() => { const now = Date.now(); pendingStates.forEach((entry, key) => { if (entry.expires < now) pendingStates.delete(key); }); }, 60 * 1000).unref();

  async function tokenRequest(provider, form) {
    const c = config();
    const result = await call('POST', c.token, { form: { ...form, client_id: c.id, client_secret: c.secret } });
    if (!result.ok || !result.data || !result.data.access_token) {
      throw fail('token_failed', (result.data && (result.data.error_description || result.data.error)) || `the sign in was refused (${result.status})`, 502);
    }
    return result.data;
  }

  async function freshToken(userId, provider, force = false) {
    const record = db.getIntegration(userId, provider);
    if (!record) throw fail('not_connected', 'Connect your account first', 409);
    if (!force && record.expires_at - 60 > Math.floor(Date.now() / 1000)) return record.access_token;
    if (!record.refresh_token) throw fail('not_connected', 'Connect your account again', 409);
    let data;
    try {
      data = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: record.refresh_token });
    } catch (error) {
      // the account took the permission back (or the token ran out): the person connects again
      db.deleteIntegration(userId, provider);
      throw fail('not_connected', 'Connect your account again', 409);
    }
    db.saveIntegration(userId, provider, {
      access_token: data.access_token,
      refresh_token: data.refresh_token || record.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
      account_name: record.account_name
    });
    return data.access_token;
  }

  // a call with the account's token, tried again once with a fresh token when the provider says it ran out
  async function authed(userId, provider, method, url, options = {}) {
    let token = await freshToken(userId, provider);
    let result = await call(method, url, { ...options, token });
    if (result.status === 401) {
      token = await freshToken(userId, provider, true);
      result = await call(method, url, { ...options, token });
    }
    return result;
  }

  // ---- connecting
  app.get('/api/integrations', requireAuth, (req, res) => {
    const providers = {};
    for (const provider of PROVIDERS) {
      const record = db.getIntegration(req.session.userId, provider);
      providers[provider] = { configured: configured(), connected: Boolean(record), account: record ? record.account_name : '', problem: record ? '' : recentProblem(req.session.userId, provider) };
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, providers });
  });

  app.post('/api/integrations/:provider/connect', requireAuth, (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown service' });
    if (!configured()) return res.status(501).json({ error: 'This is not set up on the server', code: 'not_configured' });
    const limit = connectLimiter.hit(req.session.userId);
    if (!limit.allowed) return res.status(429).json({ error: 'Too many tries, wait a bit' });
    const c = config();
    noteOutcome(req.session.userId, provider, '');
    const state = crypto.randomBytes(24).toString('hex');
    pendingStates.set(state, { userId: req.session.userId, provider, expires: Date.now() + 10 * 60 * 1000 });
    const url = new URL(c.auth);
    url.searchParams.set('client_id', c.id);
    url.searchParams.set('redirect_uri', redirectUri(provider, req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', c.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    res.json({ ok: true, url: url.toString() });
  });

  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const page = (title, line) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>`
    + `<body style="background:#000;color:#ff5900;font-family:system-ui,sans-serif;text-align:center;padding:64px 24px"><div style="font-size:20px">${line}</div></body></html>`;

  // the browser comes back here after the person said yes (or no) on the page of Google
  app.get('/api/integrations/:provider/callback', async (req, res) => {
    const provider = req.params.provider;
    res.set('Cache-Control', 'no-store');
    if (!PROVIDERS.includes(provider) || !configured()) return res.status(404).send(page('not found', 'not found'));
    const entry = pendingStates.get(String(req.query.state || ''));
    pendingStates.delete(String(req.query.state || ''));
    if (!entry || entry.provider !== provider || entry.expires < Date.now()) {
      return res.status(400).send(page('expired', 'that took too long, go back to the app and try again'));
    }
    if (req.query.error || !req.query.code) {
      noteOutcome(entry.userId, provider, 'cancelled');
      return res.send(page('cancelled', 'cancelled, nothing was connected'));
    }
    try {
      const data = await tokenRequest(provider, { grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(provider, req) });
      const c = config();
      let account = '';
      try {
        const me = await call('GET', `${c.api}/channels?part=snippet&mine=true`, { token: data.access_token });
        account = (me.data && me.data.items && me.data.items[0] && me.data.items[0].snippet && me.data.items[0].snippet.title) || '';
      } catch { /* the name is only for show */ }
      db.saveIntegration(entry.userId, provider, {
        access_token: data.access_token,
        refresh_token: data.refresh_token || '',
        expires_at: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
        account_name: account
      });
      noteOutcome(entry.userId, provider, '');
      logToFile(`[INTEGRATIONS] ${provider} connected for ${entry.userId}`);
      res.send(page('connected', account ? `connected as <b>${escapeHtml(account)}</b><br><br>you can close this tab and go back to the app` : 'connected<br><br>you can close this tab and go back to the app'));
    } catch (error) {
      noteOutcome(entry.userId, provider, 'failed');
      logToFile(`[INTEGRATIONS] ${provider} connect failed: ${error.message}`, true);
      res.status(502).send(page('failed', 'that did not work, go back to the app and try again'));
    }
  });

  app.delete('/api/integrations/:provider', requireAuth, async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown service' });
    const record = db.getIntegration(req.session.userId, provider);
    db.deleteIntegration(req.session.userId, provider);
    if (record && record.access_token) {
      // best effort: the permission is taken back at Google too
      call('POST', 'https://oauth2.googleapis.com/revoke', { form: { token: record.refresh_token || record.access_token } }).catch(() => {});
    }
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- exporting
  const jobs = new Map();
  setInterval(() => { const cutoff = Date.now() - 60 * 60 * 1000; jobs.forEach((job, key) => { if (job.created < cutoff) jobs.delete(key); }); }, 5 * 60 * 1000).unref();

  const cleanName = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'my playlist';
  const cleanTracks = (value) => (Array.isArray(value) ? value : []).slice(0, 300).map((t) => ({
    title: String((t && t.title) || '').slice(0, 200),
    author: String((t && t.author) || '').slice(0, 120),
    videoId: String((t && t.videoId) || '').slice(0, 20)
  })).filter((t) => t.title || t.videoId);

  async function exportToYoutube(userId, name, tracks, job) {
    const c = config();
    const created = await authed(userId, 'youtube', 'POST', `${c.api}/playlists?part=snippet,status`, {
      json: { snippet: { title: name, description: "from Shibenchi's Music Player" }, status: { privacyStatus: 'unlisted' } }
    });
    if (!created.ok || !created.data || !created.data.id) {
      const reason = created.data && created.data.error && (created.data.error.errors && created.data.error.errors[0] && created.data.error.errors[0].reason);
      throw fail(reason === 'quotaExceeded' ? 'quota' : 'create_failed', reason === 'quotaExceeded' ? QUOTA_MESSAGE : 'YouTube would not make the playlist', 502);
    }
    const playlistId = created.data.id;
    let added = 0; let skipped = 0; let failed = 0; let quota = false;
    for (const track of tracks) {
      job.done += 1;
      if (!/^[\w-]{11}$/.test(track.videoId)) { skipped += 1; continue; }
      const result = await authed(userId, 'youtube', 'POST', `${c.api}/playlistItems?part=snippet`, {
        json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: track.videoId } } }
      });
      if (result.ok) {
        added += 1;
      } else {
        const reason = result.data && result.data.error && result.data.error.errors && result.data.error.errors[0] && result.data.error.errors[0].reason;
        if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') { quota = true; break; }
        if (result.status === 404 || reason === 'videoNotFound' || reason === 'videoAlreadyInPlaylist' || reason === 'forbidden') skipped += 1; else failed += 1;
      }
      await sleep(Number(env.EXPORT_STEP_MS) || 150);
    }
    return { url: `https://www.youtube.com/playlist?list=${playlistId}`, added, skipped, failed, quota, total: tracks.length };
  }

  app.post('/api/export/:provider', requireAuth, (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown service' });
    if (!configured()) return res.status(501).json({ error: 'This is not set up on the server', code: 'not_configured' });
    if (!db.getIntegration(req.session.userId, provider)) return res.status(409).json({ error: 'Connect your account first', code: 'not_connected' });
    const running = [...jobs.values()].find((job) => job.userId === req.session.userId && job.state === 'running');
    if (running) return res.status(409).json({ error: 'An export is still running', code: 'busy', jobId: running.id });
    const limit = exportLimiter.hit(req.session.userId);
    if (!limit.allowed) return res.status(429).json({ error: 'Too many exports for now, try again later' });
    const tracks = cleanTracks((req.body || {}).tracks);
    if (!tracks.length) return res.status(400).json({ error: 'The playlist is empty' });
    const name = cleanName((req.body || {}).name);
    const job = { id: crypto.randomBytes(12).toString('hex'), userId: req.session.userId, provider, state: 'running', done: 0, total: tracks.length, created: Date.now(), result: null, error: null, code: null };
    jobs.set(job.id, job);
    exportToYoutube(req.session.userId, name, tracks, job)
      .then((result) => { job.result = result; job.state = 'done'; logToFile(`[INTEGRATIONS] ${provider} export of ${tracks.length} songs for ${req.session.userId}: ${result.added} added`); })
      .catch((error) => { job.state = 'failed'; job.error = error.message || 'It did not work'; job.code = error.code || 'failed'; logToFile(`[INTEGRATIONS] ${provider} export failed: ${error.message}`, true); });
    res.json({ ok: true, jobId: job.id, total: job.total });
  });

  app.get('/api/export/jobs/:id', requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.session.userId) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, job: { id: job.id, provider: job.provider, state: job.state, done: job.done, total: job.total, result: job.result, error: job.error, code: job.code } });
  });

  // ---------------------------------------------------------------- reading a Spotify playlist (the public page, no account)
  async function readSpotifyEmbed(ref) {
    const base = env.SPOTIFY_EMBED_BASE || 'https://open.spotify.com';
    const response = await call('GET', `${base}/embed/${ref.type}/${ref.id}`, { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; ShibenchiMusicPlayer)' } });
    if (!response.ok) return null;
    const parsed = parseEmbedTracks(response.text);
    return parsed && parsed.tracks.length ? { name: parsed.name, tracks: parsed.tracks } : null;
  }

  app.post('/api/import/spotify', requireAuth, async (req, res) => {
    const limit = importLimiter.hit(req.session.userId);
    if (!limit.allowed) return res.status(429).json({ error: 'Too many imports for now, try again later' });
    const ref = spotifyIdFromUrl((req.body || {}).url);
    if (!ref) return res.status(400).json({ error: 'That is not a link to a Spotify playlist', code: 'bad_link' });
    try {
      const found = await readSpotifyEmbed(ref);
      if (!found || !found.tracks.length) {
        return res.status(404).json({ error: 'That playlist could not be read. It has to be public.', code: 'not_found' });
      }
      const tracks = found.tracks.slice(0, EMBED_LIMIT).map((t) => ({ title: String(t.title).slice(0, 200), author: String(t.author || '').slice(0, 160), durationMs: t.durationMs || 0 }));
      // the page stops at 100: a list that is that long may well be longer
      res.json({ ok: true, name: String(found.name || 'spotify playlist').slice(0, 100), tracks, total: tracks.length, partial: found.tracks.length >= EMBED_LIMIT });
    } catch (error) {
      logToFile(`[INTEGRATIONS] spotify import failed: ${error.message}`, true);
      res.status(502).json({ error: 'Spotify could not be reached', code: 'failed' });
    }
  });

  // ---------------------------------------------------------------- the person's own YouTube playlists, to pick from
  const apiReason = (result) => result && result.data && result.data.error && result.data.error.errors && result.data.error.errors[0] && result.data.error.errors[0].reason;

  async function listYoutubePlaylists(userId) {
    const c = config();
    const lists = [];
    const channel = await authed(userId, 'youtube', 'GET', `${c.api}/channels?part=contentDetails&mine=true`);
    const first = channel.ok && channel.data && channel.data.items && channel.data.items[0];
    const likes = first && first.contentDetails && first.contentDetails.relatedPlaylists && first.contentDetails.relatedPlaylists.likes;
    if (likes) lists.push({ id: likes, name: 'liked videos', count: null });
    let pageToken = '';
    for (let page = 0; page < 6; page += 1) {
      const result = await authed(userId, 'youtube', 'GET', `${c.api}/playlists?part=snippet,contentDetails&mine=true&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (!result.ok || !result.data) {
        throw fail(apiReason(result) === 'quotaExceeded' ? 'quota' : 'list_failed', apiReason(result) === 'quotaExceeded' ? QUOTA_MESSAGE : 'YouTube would not show your playlists', 502);
      }
      for (const item of result.data.items || []) {
        if (item && item.id) lists.push({ id: item.id, name: cleanName(item.snippet && item.snippet.title), count: item.contentDetails && Number.isFinite(item.contentDetails.itemCount) ? item.contentDetails.itemCount : null });
      }
      pageToken = result.data.nextPageToken || '';
      if (!pageToken) break;
    }
    return lists;
  }

  app.get('/api/import/:provider/playlists', requireAuth, async (req, res) => {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown service' });
    if (!configured()) return res.status(501).json({ error: 'This is not set up on the server', code: 'not_configured' });
    if (!db.getIntegration(req.session.userId, provider)) return res.status(409).json({ error: 'Connect your account first', code: 'not_connected' });
    const limit = importLimiter.hit(req.session.userId);
    if (!limit.allowed) return res.status(429).json({ error: 'Too many tries for now, try again later' });
    try {
      const playlists = await listYoutubePlaylists(req.session.userId);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, playlists });
    } catch (error) {
      logToFile(`[INTEGRATIONS] ${provider} playlist list failed: ${error.message}`, true);
      res.status(error.status || 502).json({ error: error.message || 'It did not work', code: error.code || 'failed' });
    }
  });

  // a playlist of the person's own YouTube account, with the video ids already known (nothing to look up)
  async function readYoutubePlaylist(userId, playlistId) {
    const c = config();
    let name = '';
    const info = await authed(userId, 'youtube', 'GET', `${c.api}/playlists?part=snippet&id=${encodeURIComponent(playlistId)}`);
    if (info.ok && info.data && info.data.items && info.data.items[0] && info.data.items[0].snippet) name = info.data.items[0].snippet.title || '';
    const tracks = [];
    let skipped = 0; let total = 0; let pageToken = '';
    for (let page = 0; page < 20; page += 1) {
      const result = await authed(userId, 'youtube', 'GET', `${c.api}/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (!result.ok || !result.data) {
        if (tracks.length) break;
        const reason = apiReason(result);
        throw fail(reason === 'playlistNotFound' ? 'not_found' : (reason === 'quotaExceeded' ? 'quota' : 'read_failed'), reason === 'playlistNotFound' ? 'That playlist could not be found' : (reason === 'quotaExceeded' ? QUOTA_MESSAGE : 'YouTube would not show that playlist'), reason === 'playlistNotFound' ? 404 : 502);
      }
      total = (result.data.pageInfo && result.data.pageInfo.totalResults) || total;
      for (const item of result.data.items || []) {
        const snippet = (item && item.snippet) || {};
        const videoId = snippet.resourceId && snippet.resourceId.videoId;
        if (!/^[\w-]{11}$/.test(String(videoId || '')) || /^(deleted|private) video$/i.test(String(snippet.title || ''))) { skipped += 1; continue; }
        tracks.push({ videoId, title: String(snippet.title || videoId).slice(0, 200), author: cleanArtist(snippet.videoOwnerChannelTitle).slice(0, 160), durationMs: 0 });
      }
      pageToken = result.data.nextPageToken || '';
      if (!pageToken) break;
    }
    return { name, tracks, skipped, total };
  }

  app.post('/api/import/youtube', requireAuth, async (req, res) => {
    if (!configured()) return res.status(501).json({ error: 'This is not set up on the server', code: 'not_configured' });
    if (!db.getIntegration(req.session.userId, 'youtube')) return res.status(409).json({ error: 'Connect your account first', code: 'not_connected' });
    const limit = importLimiter.hit(req.session.userId);
    if (!limit.allowed) return res.status(429).json({ error: 'Too many imports for now, try again later' });
    const playlistId = String((req.body || {}).playlistId || '').trim();
    if (!/^[\w-]{2,64}$/.test(playlistId)) return res.status(400).json({ error: 'That is not a YouTube playlist', code: 'bad_link' });
    try {
      const found = await readYoutubePlaylist(req.session.userId, playlistId);
      if (!found.tracks.length) return res.status(404).json({ error: 'There are no songs in that playlist that could be read', code: 'not_found' });
      const tracks = found.tracks.slice(0, 1000);
      res.json({ ok: true, name: cleanName(found.name || 'youtube playlist'), tracks, total: found.total || tracks.length, skipped: found.skipped, partial: tracks.length < (found.total - found.skipped) });
    } catch (error) {
      logToFile(`[INTEGRATIONS] youtube import failed: ${error.message}`, true);
      res.status(error.status || 502).json({ error: error.message || 'YouTube could not be reached', code: error.code || 'failed' });
    }
  });

  return { configured, PROVIDERS };
}

module.exports = { createIntegrations, spotifyIdFromUrl, parseEmbedTracks };
