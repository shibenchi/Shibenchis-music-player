// audio files that people add to a room from their own device. they live in the memory of this server only, never on its disk, for as
// long as the room needs them: a file goes when its song leaves the room's queue, when the queue is cleared, when nobody has been in
// the room for a while, or after twelve hours. a restart empties it all. the whole thing is switched off unless SMP_ROOM_FILES=1 is set
const crypto = require('crypto');
const express = require('express');

const MB = 1024 * 1024;
const FILE_ID = /^local:[0-9a-f]{32}$/;
const SERVER_ID = /^[\w-]{1,80}$/;

// the same id the apps give a file (src/localAudio.js, localIdFor): a hash of the size and a handful of slices of the file
function fileIdFor(buffer) {
  const SLICE = 256 * 1024;
  const parts = [Buffer.from(String(buffer.length) + ':')];
  if (buffer.length <= 4 * SLICE) {
    parts.push(buffer);
  } else {
    [0, buffer.length - SLICE, Math.floor(buffer.length * 0.25), Math.floor(buffer.length * 0.5), Math.floor(buffer.length * 0.75)].forEach((start) => {
      parts.push(buffer.subarray(start, start + SLICE));
    });
  }
  return 'local:' + crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex').slice(0, 32);
}

function createRoomFiles({ env = process.env, isServerMember, getQueueFileIds, isRoomOccupied, logToFile = () => {}, now = () => Date.now() } = {}) {
  const enabled = env.SMP_ROOM_FILES === '1';
  const maxFile = Math.max(1, Number(env.SMP_ROOM_FILE_MAX_MB) || 60) * MB;
  const maxRoom = Math.max(1, Number(env.SMP_ROOM_MAX_MB) || 100) * MB;
  const maxTotal = Math.max(1, Number(env.SMP_ROOM_FILES_TOTAL_MB) || 400) * MB;
  const ttlMs = (Number(env.SMP_ROOM_FILE_TTL_HOURS) || 12) * 60 * 60 * 1000;
  const emptyMs = (Number(env.SMP_ROOM_EMPTY_MINUTES) || 10) * 60 * 1000;
  const orphanMs = (Number(env.SMP_ROOM_ORPHAN_SECONDS) || 180) * 1000;
  // long enough for a long song with seeking; the address only opens this one file of this one room
  const linkMs = 3 * 60 * 60 * 1000;
  const secret = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

  const rooms = new Map(); // serverId -> { files: Map(fileId -> entry), emptySince }
  let uploading = 0;

  const roomOf = (serverId, create = false) => {
    let room = rooms.get(serverId);
    if (!room && create) {
      room = { files: new Map(), emptySince: null };
      rooms.set(serverId, room);
    }
    return room || null;
  };
  const roomBytes = (room) => { let sum = 0; room.files.forEach((entry) => { sum += entry.size; }); return sum; };
  const totalBytes = () => { let sum = 0; rooms.forEach((room) => { sum += roomBytes(room); }); return sum; };

  const drop = (serverId, fileId, why) => {
    const room = roomOf(serverId);
    if (!room || !room.files.has(fileId)) return;
    const entry = room.files.get(fileId);
    room.files.delete(fileId);
    if (!room.files.size) rooms.delete(serverId);
    logToFile(`[ROOM FILES] removed ${(entry.size / MB).toFixed(1)} MB from room ${serverId} (${why})`);
  };
  const dropRoom = (serverId, why) => {
    const room = roomOf(serverId);
    if (!room) return;
    [...room.files.keys()].forEach((fileId) => drop(serverId, fileId, why));
  };

  const sign = (serverId, fileId, expires) => crypto.createHmac('sha256', secret).update(`${serverId}|${fileId}|${expires}`).digest('hex');
  const validSignature = (serverId, fileId, expires, signature) => {
    if (!/^\d{10,16}$/.test(String(expires)) || Number(expires) < now()) return false;
    const expected = Buffer.from(sign(serverId, fileId, String(expires)), 'hex');
    const given = Buffer.from(String(signature || ''), 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  // songs that are no longer in a room's queue lose their files (a file that was only just uploaded gets a few minutes to be queued)
  const prune = (serverId, graceMs = 0) => {
    const room = roomOf(serverId);
    if (!room) return;
    const queued = new Set(getQueueFileIds ? getQueueFileIds(serverId) : []);
    room.files.forEach((entry, fileId) => {
      if (!queued.has(fileId) && now() - entry.at >= graceMs) drop(serverId, fileId, 'its song left the queue');
    });
  };

  // every minute: files that are too old, files nobody queued, rooms that have been empty for a while
  const sweep = () => {
    [...rooms.keys()].forEach((serverId) => {
      const room = roomOf(serverId);
      if (!room) return;
      room.files.forEach((entry, fileId) => { if (now() - entry.at > ttlMs) drop(serverId, fileId, 'too old'); });
      const live = roomOf(serverId);
      if (!live) return;
      if (isRoomOccupied && isRoomOccupied(serverId)) {
        live.emptySince = null;
      } else if (!live.emptySince) {
        live.emptySince = now();
      } else if (now() - live.emptySince > emptyMs) {
        dropRoom(serverId, 'the room is empty');
        return;
      }
      prune(serverId, orphanMs);
    });
  };
  const timer = enabled ? setInterval(sweep, (Number(env.SMP_ROOM_SWEEP_SECONDS) || 60) * 1000) : null;
  if (timer && timer.unref) timer.unref();

  const off = (res) => res.status(404).json({ error: 'audio files are not shared on this server' });

  const serve = (req, res, entry) => {
    const size = entry.size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          start = Math.max(0, size - parseInt(m[2], 10));
        } else {
          start = parseInt(m[1], 10);
          if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
        }
        if (!(start <= end) || start >= size) {
          res.status(416).set('Content-Range', `bytes */${size}`).end();
          return;
        }
        status = 206;
      }
    }
    res.status(status);
    res.set({
      'Content-Type': entry.type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
    });
    if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    entry.lastUsed = now();
    res.end(req.method === 'HEAD' ? undefined : entry.buf.subarray(start, end + 1));
  };

  const register = (app, requireAuth) => {
    // what the apps ask before offering to share a file in a room
    app.get('/api/room-files/status', requireAuth, (req, res) => {
      res.json({ enabled, maxFileBytes: maxFile, maxRoomBytes: maxRoom, maxTotalBytes: maxTotal, usedBytes: totalBytes() });
    });

    // which files of a room are on the server right now
    app.get('/api/server/:serverId/files', requireAuth, (req, res) => {
      if (!enabled) return off(res);
      const { serverId } = req.params;
      if (!SERVER_ID.test(serverId) || !isServerMember(serverId, req.session.userId)) return res.status(403).json({ error: 'Must be a server member' });
      const room = roomOf(serverId);
      res.json({ ok: true, files: room ? [...room.files.entries()].map(([id, entry]) => ({ id, size: entry.size })) : [] });
    });

    // a member adds the file of a song: raw bytes, checked against the id they are sent under
    app.put('/api/server/:serverId/files/:fileId', requireAuth, (req, res, next) => {
      if (!enabled) return off(res);
      const { serverId, fileId } = req.params;
      if (!SERVER_ID.test(serverId) || !FILE_ID.test(fileId)) return res.status(400).json({ error: 'bad file id' });
      if (!isServerMember(serverId, req.session.userId)) return res.status(403).json({ error: 'Must be a server member to add files' });
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!/^audio\/[\w.+-]+$/.test(type)) return res.status(415).json({ error: 'only audio files can be added' });
      const length = Number(req.headers['content-length'] || 0);
      if (length > maxFile) return res.status(413).json({ error: `that file is bigger than ${Math.round(maxFile / MB)} MB` });
      const existing = roomOf(serverId);
      if (existing && existing.files.has(fileId)) {
        existing.files.get(fileId).at = now();
        req.resume();
        return res.json({ ok: true, size: existing.files.get(fileId).size, already: true });
      }
      if (length && roomBytes(existing || { files: new Map() }) + length > maxRoom) return res.status(413).json({ error: `the room can hold ${Math.round(maxRoom / MB)} MB of audio files, remove a song first` });
      if (length && totalBytes() + length > maxTotal) return res.status(507).json({ error: 'the server has no room for more audio files right now' });
      if (uploading >= 2) return res.status(429).json({ error: 'busy with other files, try again in a moment' });
      uploading += 1;
      let finished = false;
      const release = () => { if (!finished) { finished = true; uploading -= 1; } };
      res.on('close', release);
      express.raw({ type: () => true, limit: maxFile })(req, res, (error) => {
        if (error) {
          release();
          return res.status(error.status || 400).json({ error: error.type === 'entity.too.large' ? `that file is bigger than ${Math.round(maxFile / MB)} MB` : 'the upload did not work' });
        }
        next();
      });
    }, (req, res) => {
      const { serverId, fileId } = req.params;
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ error: 'the file is empty' });
      if (fileIdFor(buf) !== fileId) return res.status(400).json({ error: 'the file does not match its id' });
      const room = roomOf(serverId, true);
      if (roomBytes(room) + buf.length > maxRoom) return res.status(413).json({ error: `the room can hold ${Math.round(maxRoom / MB)} MB of audio files, remove a song first` });
      if (totalBytes() + buf.length > maxTotal) return res.status(507).json({ error: 'the server has no room for more audio files right now' });
      room.files.set(fileId, { buf, size: buf.length, type, owner: req.session.userId, at: now(), lastUsed: now() });
      room.emptySince = null;
      logToFile(`[ROOM FILES] stored ${(buf.length / MB).toFixed(1)} MB in room ${serverId}`);
      res.json({ ok: true, size: buf.length });
    });

    // an address for the player or for keeping a copy that stops working after a few hours: the audio element cannot send a login with its request
    app.get('/api/server/:serverId/files/:fileId/link', requireAuth, (req, res) => {
      if (!enabled) return off(res);
      const { serverId, fileId } = req.params;
      if (!SERVER_ID.test(serverId) || !FILE_ID.test(fileId)) return res.status(400).json({ error: 'bad file id' });
      if (!isServerMember(serverId, req.session.userId)) return res.status(403).json({ error: 'Must be a server member' });
      const room = roomOf(serverId);
      const entry = room && room.files.get(fileId);
      if (!entry) return res.status(404).json({ error: 'that file is no longer in the room' });
      const expires = String(now() + linkMs);
      res.json({ ok: true, size: entry.size, type: entry.type, path: `/api/room-files/${serverId}/${encodeURIComponent(fileId)}?exp=${expires}&sig=${sign(serverId, fileId, expires)}` });
    });

    // the file itself, with ranges so that the player can seek and start at once. the signed address is the login
    const download = (req, res) => {
      if (!enabled) return off(res);
      const { serverId, fileId } = req.params;
      if (!SERVER_ID.test(serverId) || !FILE_ID.test(fileId)) return res.status(400).json({ error: 'bad file id' });
      if (!validSignature(serverId, fileId, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'this address has run out, ask for a new one' });
      const room = roomOf(serverId);
      const entry = room && room.files.get(fileId);
      if (!entry) return res.status(404).json({ error: 'that file is no longer in the room' });
      serve(req, res, entry);
    };
    app.get('/api/room-files/:serverId/:fileId', download);
    app.head('/api/room-files/:serverId/:fileId', download);
    app.options('/api/room-files/:serverId/:fileId', (req, res) => {
      res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '600' }).status(204).end();
    });

    app.delete('/api/server/:serverId/files/:fileId', requireAuth, (req, res) => {
      if (!enabled) return off(res);
      const { serverId, fileId } = req.params;
      if (!SERVER_ID.test(serverId) || !FILE_ID.test(fileId)) return res.status(400).json({ error: 'bad file id' });
      if (!isServerMember(serverId, req.session.userId)) return res.status(403).json({ error: 'Must be a server member' });
      const room = roomOf(serverId);
      const entry = room && room.files.get(fileId);
      if (!entry) return res.json({ ok: true });
      if (entry.owner !== req.session.userId && !req.session.isAdmin) return res.status(403).json({ error: 'only the person who added it can remove it' });
      drop(serverId, fileId, 'removed by its owner');
      res.json({ ok: true });
    });
  };

  return {
    enabled,
    register,
    has: (serverId, fileId) => { const room = roomOf(serverId); return Boolean(room && room.files.has(fileId)); },
    prune,
    dropRoom,
    sweep,
    stats: () => ({ rooms: rooms.size, bytes: totalBytes(), uploading }),
    stop: () => { if (timer) clearInterval(timer); }
  };
}

module.exports = { createRoomFiles, fileIdFor };
