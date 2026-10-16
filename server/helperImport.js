// the spotify helper (public/spotify-helper.html, public/spotify-send.html) reads a long playlist from the spotify website and sends it to
// the person's own account. the person signs in on the helper's own page (never on the spotify page, whose scripts could read a password),
// which gets a helper token: it is good for sending lists and nothing else. the lists wait in the account (pending_imports) until the
// app, which can look the songs up on YouTube, picks them up from the import menu
const crypto = require('crypto');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TRACKS = 5000;
const MAX_TOKENS_PER_USER = 5;

function createHelperImport({ app, db, requireAuth, validation, logToFile = () => {}, sendToUser = () => {}, themeColorOf, loginIpLimiter, loginAttemptLimiter, getClientKey, tooManyAttempts }) {
  const tokens = new Map(); // token -> { userId, username, expires }
  const sendLimiter = validation.createRateLimiter({ windowMs: 60 * 60 * 1000, max: 40 });

  const sweepTokens = () => {
    const now = Date.now();
    tokens.forEach((entry, token) => { if (entry.expires < now) tokens.delete(token); });
  };
  const timer = setInterval(sweepTokens, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  // lists nobody picked up are not kept for ever
  try { db.purgePendingImports(30 * 24 * 60 * 60); } catch (error) { /* next time */ }

  const theme = (userId) => {
    try { return themeColorOf(db.getSettings(userId)); } catch (error) { return { r: 255, g: 89, b: 0 }; }
  };
  const readToken = (req) => {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer (hlp_[0-9a-f]{48})$/.exec(header);
    if (!match) return null;
    const entry = tokens.get(match[1]);
    if (!entry || entry.expires < Date.now()) { tokens.delete(match[1]); return null; }
    return { token: match[1], ...entry };
  };
  const needToken = (req, res, next) => {
    const entry = readToken(req);
    if (!entry) return res.status(401).json({ error: 'sign in again' });
    req.helper = entry;
    next();
  };

  app.post('/api/helper/login', (req, res) => {
    try {
      const fields = validation.readLoginFields(req.body);
      if (!fields.ok) return res.status(400).json({ error: fields.error });
      const { username, password } = fields;
      const clientKey = getClientKey(req);
      const ipLimit = loginIpLimiter.hit(clientKey);
      if (!ipLimit.allowed) return tooManyAttempts(res, ipLimit.retryAfterSec);
      const attemptKey = `${clientKey}|${username.toLowerCase()}`;
      const attemptLimit = loginAttemptLimiter.hit(attemptKey);
      if (!attemptLimit.allowed) return tooManyAttempts(res, attemptLimit.retryAfterSec);
      const user = db.authenticateUser(username, password);
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      loginAttemptLimiter.reset(attemptKey);
      // a few helper sign ins per account at a time, the oldest one goes
      const own = [...tokens.entries()].filter(([, entry]) => entry.userId === user.id).sort((a, b) => a[1].expires - b[1].expires);
      while (own.length >= MAX_TOKENS_PER_USER) tokens.delete(own.shift()[0]);
      const token = 'hlp_' + crypto.randomBytes(24).toString('hex');
      tokens.set(token, { userId: user.id, username: user.username, expires: Date.now() + TOKEN_TTL_MS });
      logToFile(`[HELPER] ${user.username} signed in to the spotify helper`);
      res.json({ ok: true, token, username: user.username, theme: theme(user.id) });
    } catch (error) {
      logToFile(`[HELPER] login error: ${error.message}`, true);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.get('/api/helper/me', needToken, (req, res) => {
    res.json({ ok: true, username: req.helper.username, theme: theme(req.helper.userId) });
  });

  app.post('/api/helper/logout', needToken, (req, res) => {
    tokens.delete(req.helper.token);
    res.json({ ok: true });
  });

  // the list that the helper read: only titles, artists and lengths
  app.post('/api/helper/imports', needToken, (req, res) => {
    try {
      const limit = sendLimiter.hit(req.helper.userId);
      if (!limit.allowed) return tooManyAttempts(res, limit.retryAfterSec);
      const body = req.body || {};
      const nameCheck = validation.cleanText(body.name, { field: 'Playlist name', max: 100 });
      const name = nameCheck.ok ? nameCheck.value : 'spotify playlist';
      if (!Array.isArray(body.tracks) || !body.tracks.length) return res.status(400).json({ error: 'there are no songs in that list' });
      if (body.tracks.length > MAX_TRACKS) return res.status(413).json({ error: `a list can have up to ${MAX_TRACKS} songs` });
      const tracks = [];
      for (const track of body.tracks) {
        if (!track || typeof track.title !== 'string') continue;
        const title = track.title.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!title) continue;
        tracks.push({
          title,
          author: typeof track.author === 'string' ? track.author.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
          durationMs: Math.max(0, Math.min(Number(track.durationMs) || 0, 6 * 60 * 60 * 1000))
        });
      }
      if (!tracks.length) return res.status(400).json({ error: 'there are no songs in that list' });
      const created = db.createPendingImport(req.helper.userId, { name, source: 'spotify', tracks });
      logToFile(`[HELPER] ${req.helper.username} sent "${name}" with ${tracks.length} songs`);
      sendToUser(req.helper.userId, { type: 'import_waiting', id: created.id, name: created.name, count: created.track_count });
      res.json({ ok: true, import: created });
    } catch (error) {
      logToFile(`[HELPER] send error: ${error.message}`, true);
      res.status(500).json({ error: 'Could not keep the list' });
    }
  });

  // the app of the person: what is waiting, the songs of one list, and taking one off the list once it is in
  app.get('/api/user/imports', requireAuth, (req, res) => {
    res.json({ ok: true, imports: db.listPendingImports(req.session.userId) });
  });
  app.get('/api/user/imports/:id', requireAuth, (req, res) => {
    const found = db.getPendingImport(req.session.userId, req.params.id);
    if (!found) return res.status(404).json({ error: 'that list is not waiting any more' });
    res.json({ ok: true, import: found });
  });
  app.delete('/api/user/imports/:id', requireAuth, (req, res) => {
    db.deletePendingImport(req.session.userId, req.params.id);
    res.json({ ok: true });
  });

  return { tokenCount: () => tokens.size };
}

module.exports = { createHelperImport };
