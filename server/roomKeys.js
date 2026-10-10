// end to end encrypted room chat. the server never gets the text of a room message: the members lock it with the key of the room, and
// what is stored and passed on is "r2e1:<key id>.<iv>.<locked text>".
//
// the key of a room is made by one of its members (in the app) and handed to every other member locked with the same kind of key
// that private messages use (the member's own key pair, see src/e2e.js): one locked copy per member in room_keys. the server holds the
// copies and can not open any of them. when somebody leaves or is kicked the room is flagged and a member that is online makes a new
// key for the ones who are left; somebody who joins gets the current key from a member that is online (so can read what was said
// under that key, which is everything since the last time somebody left, and what is said from then on)
//
// an app that does not know room keys can not send to the room (a plain message is refused) and is shown a note where it would
// have seen a locked message. SMP_ROOM_E2E=0 lets plain messages through again (a way back, not meant to be used)
const KID = /^[0-9a-f]{16}$/;
const ROOM_ENVELOPE = /^r2e1:[0-9a-f]{16}\.[A-Za-z0-9+/=_-]{8,40}\.[A-Za-z0-9+/=_-]{8,12000}$/;
const KEY_ENVELOPE = /^e2e1:[A-Za-z0-9+/=_-]{16,16000}$/;
const NOTE = '[private room message, update the app to read it]';

function createRoomKeys({ app, db, requireAuth, validation, logToFile = () => {}, isServerMember, broadcastToServer, wsClients, sendWs }) {
  const required = () => process.env.SMP_ROOM_E2E !== '0';

  const presentMessage = (message, canOpen) => {
    if (canOpen || !message || !db.atRest.isEnvelope(message.message)) return message;
    return { ...message, message: NOTE };
  };

  // the text of a message that somebody wants to send to a room: { ok, text } or { ok: false, error, code }
  const checkMessage = (serverId, raw) => {
    const text = String(raw == null ? '' : raw);
    if (text.startsWith('r2e1:')) {
      if (!ROOM_ENVELOPE.test(text)) return { ok: false, error: 'That message is not valid', code: 'room_bad_envelope' };
      const kid = text.slice(5, 21);
      if (!db.roomKeyKnown(serverId, kid)) return { ok: false, error: 'That message was locked with a key this room does not have', code: 'room_unknown_key' };
      return { ok: true, text };
    }
    if (required()) return { ok: false, error: 'Room messages are private now, update the app to send one', code: 'room_e2e_required' };
    const plain = validation.cleanText(text, { field: 'Message text', max: 2000, multiline: true });
    return plain.ok ? { ok: true, text: plain.value } : { ok: false, error: plain.error, code: 'bad_text' };
  };

  // every app in the room gets the message in the form it can use
  const broadcastMessage = (serverId, message) => {
    wsClients.forEach((client) => {
      if (client.serverId !== serverId) return;
      sendWs(client.ws, { type: 'chat_message', serverId, message: presentMessage(message, client.e2e === true) });
    });
  };

  const notifyChanged = (serverId) => broadcastToServer(serverId, { type: 'room_keys_changed', serverId });
  // somebody left: the key is not good for what is said from now on, a member that is online makes a new one
  const markRotate = (serverId) => {
    try {
      if (db.getRoomKeyState(serverId).current_kid) db.setRoomKeyRotate(serverId, true);
    } catch (error) {
      logToFile(`[ROOM KEYS] could not flag ${serverId} for a new key: ${error.message}`, true);
    }
    notifyChanged(serverId);
  };

  const membersOf = (serverId) => db.getServerMembers(serverId).map((member) => ({ user_id: member.user_id, username: member.username, has_key: Boolean(db.getUserKey(member.user_id)) }));

  // what the person needs to know: the current key, their own locked copies, and who is still without a copy of the current key
  app.get('/api/server/:serverId/keys', requireAuth, (req, res) => {
    try {
      const { serverId } = req.params;
      if (!isServerMember(serverId, req.session.userId)) return res.status(403).json({ error: 'Must be a server member' });
      const state = db.getRoomKeyState(serverId);
      const members = membersOf(serverId);
      const holders = state.current_kid ? db.roomKeyHolderIds(serverId, state.current_kid) : new Set();
      const missing = state.current_kid ? members.filter((member) => member.has_key && !holders.has(member.user_id)).map((member) => member.user_id) : [];
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, current_kid: state.current_kid || null, rotate: Boolean(state.rotate), mine: db.getRoomKeysForUser(serverId, req.session.userId), members, missing });
    } catch (error) {
      logToFile(`[ROOM KEYS] get error: ${error.message}`, true);
      res.status(500).json({ error: 'Could not get the room keys' });
    }
  });

  // locked copies of a key for members. with make_current it is a new key for the room (only when the room has none yet, or was
  // flagged for a new one: whoever is first wins, the others are told which key is current)
  app.put('/api/server/:serverId/keys', requireAuth, (req, res) => {
    try {
      const { serverId } = req.params;
      if (!isServerMember(serverId, req.session.userId)) return res.status(403).json({ error: 'Must be a server member' });
      const body = req.body || {};
      if (!KID.test(String(body.kid || ''))) return res.status(400).json({ error: 'bad key id' });
      const list = Array.isArray(body.envelopes) ? body.envelopes.slice(0, 200) : [];
      if (!list.length) return res.status(400).json({ error: 'no copies sent' });
      const members = new Map(membersOf(serverId).map((member) => [member.user_id, member]));
      const rows = [];
      for (const entry of list) {
        if (!entry || !members.has(entry.user_id) || !members.get(entry.user_id).has_key || !KEY_ENVELOPE.test(String(entry.wrapped || ''))) {
          return res.status(400).json({ error: 'a copy is not for a member with private messages turned on, or is not valid' });
        }
        rows.push({ user_id: entry.user_id, wrapped: entry.wrapped, wrapped_by: req.session.userId });
      }
      const state = db.getRoomKeyState(serverId);
      let madeCurrent = false;
      if (body.make_current === true) {
        if (state.current_kid && !state.rotate) {
          return res.json({ ok: true, made_current: false, current_kid: state.current_kid });
        }
        db.addRoomKeyEnvelopes(serverId, body.kid, rows);
        db.setRoomKeyCurrent(serverId, body.kid);
        madeCurrent = true;
        logToFile(`[ROOM KEYS] ${serverId} has a new key for ${rows.length} members`);
      } else {
        if (!db.roomKeyKnown(serverId, body.kid)) return res.status(400).json({ error: 'the room does not have that key' });
        db.addRoomKeyEnvelopes(serverId, body.kid, rows);
      }
      notifyChanged(serverId);
      res.json({ ok: true, made_current: madeCurrent, current_kid: madeCurrent ? body.kid : state.current_kid });
    } catch (error) {
      logToFile(`[ROOM KEYS] put error: ${error.message}`, true);
      res.status(500).json({ error: 'Could not keep the room keys' });
    }
  });

  return { checkMessage, presentMessage, broadcastMessage, markRotate, notifyChanged, NOTE };
}

module.exports = { createRoomKeys, ROOM_ENVELOPE, KEY_ENVELOPE };
