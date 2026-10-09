const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// tauri sets APP_DATA_DIR to a proper per-user writable spot
// (AppData\Roaming\<id>) once its installed - program files, where the app
// actually lives, isnt writable by a normal user account, learned that one
// the hard way. falls back to the old project-relative path for plain
// `node server` dev runs where this var never gets set anyway
const dataDir = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'data')
  : path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'music.db');
const fs = require('fs');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// stored chat text is scrambled with a key kept outside the database (see atRest.js)
const atRest = require('./atRest');
atRest.init(process.env.APP_DATA_DIR || dataDir);

// usernames that get admin when the account is created. comma separated list
// in ADMIN_USERNAMES, defaults to the project owner, matched ignoring case.
// register the admin account first after a fresh deploy, since whoever
// claims one of these names gets admin
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'shibenchi')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

// bcrypt compare against this when the username doesnt exist, so a wrong
// username takes as long as a wrong password and cant be told apart by timing
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// turn on foreign keys
db.pragma('foreign_keys = ON');

// a changed or deleted row is overwritten with zeros instead of staying readable in the file (scrambling the old
// messages would otherwise leave their text behind in the freed space)
db.pragma('secure_delete = ON');

// make the tables
db.exec(`
  -- users, the basics
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- user sessions, one per user so logins dont fight each other
  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT UNIQUE,
    connected_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_seen INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- login tokens, kept as a hash so a restart (a deploy) does not log everybody out
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- whos online right now
  CREATE TABLE IF NOT EXISTS online_status (
    user_id TEXT PRIMARY KEY,
    is_online INTEGER DEFAULT 0,
    last_seen INTEGER DEFAULT (strftime('%s', 'now')),
    current_server_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- user settings, theme color n other prefs
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    theme_color_r INTEGER DEFAULT 255,
    theme_color_g INTEGER DEFAULT 89,
    theme_color_b INTEGER DEFAULT 0,
    debug_mode INTEGER DEFAULT 0,
    hide_listening INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- pending friend requests
  CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(sender_id, receiver_id)
  );

  -- actual friends (post-accept)
  CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, friend_id)
  );

  -- dms between users
  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    sender_username TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    receiver_username TEXT NOT NULL,
    message TEXT NOT NULL,
    sender_theme_color TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- playlists themselves
  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- tracks living inside a playlist
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT DEFAULT 'mp3',
    source TEXT DEFAULT 'youtube',
    thumbnail TEXT,
    external_url TEXT,
    duration_ms INTEGER DEFAULT 0,
    added_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
  );

  -- collab playlists, shared w/ everyone in a server
  CREATE TABLE IF NOT EXISTS collab_playlists (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  );

  -- tracks inside a collab playlist
  CREATE TABLE IF NOT EXISTS collab_playlist_tracks (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT DEFAULT 'mp3',
    source TEXT DEFAULT 'youtube',
    thumbnail TEXT,
    external_url TEXT,
    duration_ms INTEGER DEFAULT 0,
    added_by TEXT,
    added_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (playlist_id) REFERENCES collab_playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
  );

  -- download history
  CREATE TABLE IF NOT EXISTS downloaded_tracks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT DEFAULT 'mp3',
    source TEXT DEFAULT 'youtube',
    thumbnail TEXT,
    external_url TEXT,
    downloaded_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- personal queue, saved so it survives a restart
  CREATE TABLE IF NOT EXISTS user_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT DEFAULT 'mp3',
    source TEXT DEFAULT 'youtube',
    thumbnail TEXT,
    external_url TEXT,
    duration_ms INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    added_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- active servers (the multiplayer/collab rooms)
  CREATE TABLE IF NOT EXISTS active_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_id TEXT NOT NULL,
    host_username TEXT NOT NULL,
    ws_port INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- shared queue for a server
  CREATE TABLE IF NOT EXISTS server_queue (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    format TEXT DEFAULT 'mp3',
    source TEXT DEFAULT 'youtube',
    thumbnail TEXT,
    external_url TEXT,
    duration_ms INTEGER DEFAULT 0,
    added_by TEXT,
    position INTEGER DEFAULT 0,
    added_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE
  );

  -- synced player state for a server (whats playing, position, etc)
  CREATE TABLE IF NOT EXISTS server_player_state (
    server_id TEXT PRIMARY KEY,
    current_track_id TEXT,
    is_playing INTEGER DEFAULT 0,
    current_time REAL DEFAULT 0,
    volume REAL DEFAULT 1,
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    sync_updated_at_ms INTEGER DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE
  );

  -- repeat and shuffle of a room's player, shared by everyone in it
  CREATE TABLE IF NOT EXISTS server_play_modes (
    server_id TEXT PRIMARY KEY,
    repeat_mode TEXT NOT NULL DEFAULT 'off',
    shuffle INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE
  );

  -- server chat log
  CREATE TABLE IF NOT EXISTS server_messages (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    sender_theme_color TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- whos in which server
  CREATE TABLE IF NOT EXISTS server_members (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(server_id, user_id)
  );

  -- indexes so lookups dont crawl
  CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_downloaded_tracks_user_id ON downloaded_tracks(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_queue_user_id ON user_queue(user_id);
  -- the key pair of an account for end to end encrypted direct messages. the public half is for anyone to use
  -- when writing to this person, the private half is stored locked with the person's password (the apps do
  -- the locking and unlocking, the server only keeps the locked blob and can not open it)
  CREATE TABLE IF NOT EXISTS user_keys (
    user_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    kid TEXT NOT NULL,
    wrapped_private TEXT NOT NULL,
    wrap_salt TEXT NOT NULL,
    wrap_iv TEXT NOT NULL,
    wrap_iters INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- what each account has listened to, for its own stats. one row is a stretch of one song (a pause and a
  -- resume a few minutes later extend the row), plays is 0 on the row that only continues a song
  CREATE TABLE IF NOT EXISTS listen_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    track_key TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'personal',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    seconds INTEGER NOT NULL,
    plays INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_listen_events_user_time ON listen_events(user_id, started_at);

  -- a friend asking another friend to come to a room. gone when answered, when the room goes, or after a day
  CREATE TABLE IF NOT EXISTS room_invites (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE,
    FOREIGN KEY (from_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(server_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS idx_room_invites_to ON room_invites(to_id);

  -- a YouTube or Spotify account connected to an account of the app (to export playlists to it). the tokens are
  -- stored scrambled like the messages (see atRest.js)
  CREATE TABLE IF NOT EXISTS integrations (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    account_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_id);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver ON friend_requests(receiver_id);
  CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);
  CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);
  CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages(receiver_id);
  CREATE INDEX IF NOT EXISTS idx_dm_created ON direct_messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_server_queue_server_id ON server_queue(server_id);
  CREATE INDEX IF NOT EXISTS idx_server_messages_server_id ON server_messages(server_id);
  CREATE INDEX IF NOT EXISTS idx_active_servers_host ON active_servers(host_id);
  CREATE INDEX IF NOT EXISTS idx_server_members_server_id ON server_members(server_id);
  CREATE INDEX IF NOT EXISTS idx_server_members_user_id ON server_members(user_id);
`);

// migration: add is_admin col for older dbs that dont have it yet
try {
  db.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: add updated_at col to user_settings
try {
  db.prepare('ALTER TABLE user_settings ADD COLUMN updated_at INTEGER DEFAULT (strftime(\'%s\', \'now\'))').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: hide what the account is listening to from other people
try {
  db.prepare('ALTER TABLE user_settings ADD COLUMN hide_listening INTEGER DEFAULT 0').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: add sender_theme_color col to dms
try {
  db.prepare('ALTER TABLE direct_messages ADD COLUMN sender_theme_color TEXT DEFAULT NULL').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: add receiver_username col to dms
try {
  db.prepare('ALTER TABLE direct_messages ADD COLUMN receiver_username TEXT DEFAULT \'\'').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: add updated_at col to friend_requests
try {
  db.prepare('ALTER TABLE friend_requests ADD COLUMN updated_at INTEGER DEFAULT (strftime(\'%s\', \'now\'))').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: add status col to friend_requests
try {
  db.prepare('ALTER TABLE friend_requests ADD COLUMN status TEXT DEFAULT \'pending\'').run();
} catch (err) {
  // already exists, whatever, moving on
}

// migration: add sync_updated_at_ms so multiplayer sync has a clock to compare against
try {
  db.prepare('ALTER TABLE server_player_state ADD COLUMN sync_updated_at_ms INTEGER DEFAULT 0').run();
} catch (err) {
  // already exists, whatever, moving on
}

try {
  db.prepare('ALTER TABLE collab_playlist_tracks ADD COLUMN position INTEGER').run();
} catch (err) {
  // already there
}

// make the configured admin accounts admin if they already exist
try {
  ADMIN_USERNAMES.forEach((name) => {
    db.prepare('UPDATE users SET is_admin = 1 WHERE lower(username) = ?').run(name);
  });
} catch (err) {
  // account doesnt exist yet, itll get set on first creation instead
}

// usernames are unique ignoring case, so "Bob" and "bob" cant both exist and
// pass for each other. an older db with a clash already in it skips this and
// the check in the register route still blocks new clashes
try {
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)').run();
} catch (err) {
  console.warn('[DB] could not add the case-insensitive username index (existing names clash):', err.message);
}

// migration: make sure online_status table exists (older dbs might predate it)
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS online_status (
      user_id TEXT PRIMARY KEY,
      is_online INTEGER DEFAULT 0,
      last_seen INTEGER DEFAULT (strftime('%s', 'now')),
      current_server_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `).run();
} catch (err) {
  // already there, ignore
}

const columnMigrations = [
  ['playlist_tracks', 'source', "TEXT DEFAULT 'youtube'"],
  ['playlist_tracks', 'thumbnail', 'TEXT'],
  ['playlist_tracks', 'external_url', 'TEXT'],
  ['playlist_tracks', 'duration_ms', 'INTEGER DEFAULT 0'],
  ['downloaded_tracks', 'source', "TEXT DEFAULT 'youtube'"],
  ['downloaded_tracks', 'thumbnail', 'TEXT'],
  ['downloaded_tracks', 'external_url', 'TEXT'],
  ['user_queue', 'source', "TEXT DEFAULT 'youtube'"],
  ['user_queue', 'thumbnail', 'TEXT'],
  ['user_queue', 'external_url', 'TEXT'],
  ['user_queue', 'duration_ms', 'INTEGER DEFAULT 0'],
  ['server_queue', 'source', "TEXT DEFAULT 'youtube'"],
  ['server_queue', 'thumbnail', 'TEXT'],
  ['server_queue', 'external_url', 'TEXT'],
  ['server_queue', 'duration_ms', 'INTEGER DEFAULT 0'],
  ['server_messages', 'sender_theme_color', 'TEXT DEFAULT NULL'],
  // private channels: listed in the directory, joined only with the code
  ['active_servers', 'is_private', 'INTEGER DEFAULT 0'],
  ['active_servers', 'join_code', 'TEXT DEFAULT NULL']
];

columnMigrations.forEach(([table, column, definition]) => {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (err) {
    // already exists, whatever, moving on
  }
});

// fixing busted foreign keys on server_queue / server_player_state - the
// original schema had them pointing at users(id) instead of
// active_servers(id), my bad. CREATE TABLE IF NOT EXISTS wont touch a table
// that already exists so gotta rebuild these ones by hand here
try {
  const sqInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='server_queue'").get();
  if (sqInfo && sqInfo.sql && sqInfo.sql.includes('REFERENCES users(id)')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec('ALTER TABLE server_queue RENAME TO _server_queue_old');
      db.exec(`
        CREATE TABLE server_queue (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          video_id TEXT NOT NULL,
          title TEXT NOT NULL,
          author TEXT,
          format TEXT DEFAULT 'mp3',
          source TEXT DEFAULT 'youtube',
          thumbnail TEXT,
          external_url TEXT,
          duration_ms INTEGER DEFAULT 0,
          added_by TEXT,
          position INTEGER DEFAULT 0,
          added_at INTEGER DEFAULT (strftime('%s', 'now')),
          FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE
        )
      `);
      db.exec('INSERT INTO server_queue SELECT * FROM _server_queue_old');
      db.exec('DROP TABLE _server_queue_old');
    })();
    db.pragma('foreign_keys = ON');
  }
} catch (err) {
  // table doesnt exist yet, or this migration already ran - either way we're fine
}

try {
  const spInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='server_player_state'").get();
  if (spInfo && spInfo.sql && spInfo.sql.includes('REFERENCES users(id)')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec('ALTER TABLE server_player_state RENAME TO _server_player_state_old');
      db.exec(`
        CREATE TABLE server_player_state (
          server_id TEXT PRIMARY KEY,
          current_track_id TEXT,
          is_playing INTEGER DEFAULT 0,
          current_time REAL DEFAULT 0,
          volume REAL DEFAULT 1,
          updated_at INTEGER DEFAULT (strftime('%s', 'now')),
          sync_updated_at_ms INTEGER DEFAULT 0,
          FOREIGN KEY (server_id) REFERENCES active_servers(id) ON DELETE CASCADE
        )
      `);
      db.exec('INSERT INTO server_player_state SELECT * FROM _server_player_state_old');
      db.exec('DROP TABLE _server_player_state_old');
    })();
    db.pragma('foreign_keys = ON');
  }
} catch (err) {
  // table doesnt exist yet, or this migration already ran - either way we're fine
}

const statements = {
  // user stuff
  createUser: db.prepare(`
    INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)
  `),
  getUserByUsername: db.prepare(`
    SELECT * FROM users WHERE username = ?
  `),
  getUserByUsernameNoCase: db.prepare(`
    SELECT * FROM users WHERE username = ? COLLATE NOCASE
  `),
  getUserById: db.prepare(`
    SELECT * FROM users WHERE id = ?
  `),
  getAllUsers: db.prepare(`
    SELECT id, username, created_at FROM users ORDER BY username
  `),

  // sessions
  createUserSession: db.prepare(`
    INSERT INTO user_sessions (id, user_id, session_id) VALUES (?, ?, ?)
  `),
  getUserSession: db.prepare(`
    SELECT * FROM user_sessions WHERE session_id = ?
  `),
  getUserActiveSession: db.prepare(`
    SELECT * FROM user_sessions WHERE user_id = ?
  `),
  updateUserSessionLastSeen: db.prepare(`
    UPDATE user_sessions SET last_seen = strftime('%s', 'now') WHERE session_id = ?
  `),
  deleteUserSession: db.prepare(`
    DELETE FROM user_sessions WHERE session_id = ?
  `),
  deleteUserSessionsByUserId: db.prepare(`
    DELETE FROM user_sessions WHERE user_id = ?
  `),

  // settings
  getSettings: db.prepare(`
    SELECT * FROM user_settings WHERE user_id = ?
  `),
  upsertSettings: db.prepare(`
    INSERT INTO user_settings (user_id, theme_color_r, theme_color_g, theme_color_b, debug_mode, hide_listening, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET
      theme_color_r = excluded.theme_color_r,
      theme_color_g = excluded.theme_color_g,
      theme_color_b = excluded.theme_color_b,
      debug_mode = excluded.debug_mode,
      hide_listening = excluded.hide_listening,
      updated_at = strftime('%s', 'now')
  `),

  // friend requests
  createFriendRequest: db.prepare(`
    INSERT INTO friend_requests (id, sender_id, receiver_id) VALUES (?, ?, ?)
  `),
  getFriendRequestByUsers: db.prepare(`
    SELECT * FROM friend_requests WHERE sender_id = ? AND receiver_id = ?
  `),
  getFriendRequestById: db.prepare(`
    SELECT * FROM friend_requests WHERE id = ?
  `),
  getPendingFriendRequests: db.prepare(`
    SELECT fr.*, u.username as sender_username FROM friend_requests fr
    JOIN users u ON fr.sender_id = u.id
    WHERE fr.receiver_id = ? AND fr.status = 'pending'
  `),
  updateFriendRequestStatus: db.prepare(`
    UPDATE friend_requests SET status = ?, updated_at = strftime('%s', 'now') WHERE id = ?
  `),
  deleteFriendRequest: db.prepare(`
    DELETE FROM friend_requests WHERE id = ?
  `),

  // friends
  addFriend: db.prepare(`
    INSERT OR IGNORE INTO friends (id, user_id, friend_id) VALUES (?, ?, ?)
  `),
  getFriends: db.prepare(`
    SELECT f.*, u.username, u.id as friend_id FROM friends f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? ORDER BY u.username
  `),
  isFriend: db.prepare(`
    SELECT * FROM friends WHERE user_id = ? AND friend_id = ?
  `),
  removeFriend: db.prepare(`
    DELETE FROM friends WHERE id = ?
  `),

  // playlists
  createPlaylist: db.prepare(`
    INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)
  `),
  createPlaylistWithId: db.prepare(`
    INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)
  `),
  playlistIdExists: db.prepare(`
    SELECT 1 FROM playlists WHERE id = ?
  `),
  getUserPlaylists: db.prepare(`
    SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at
  `),
  getPlaylistById: db.prepare(`
    SELECT * FROM playlists WHERE id = ? AND user_id = ?
  `),
  updatePlaylist: db.prepare(`
    UPDATE playlists SET name = ?, updated_at = strftime('%s', 'now') WHERE id = ? AND user_id = ?
  `),
  deletePlaylist: db.prepare(`
    DELETE FROM playlists WHERE id = ? AND user_id = ?
  `),
  deleteUserPlaylists: db.prepare(`
    DELETE FROM playlists WHERE user_id = ?
  `),

  // playlist tracks
  addTrackToPlaylist: db.prepare(`
    INSERT INTO playlist_tracks (
      id,
      playlist_id,
      video_id,
      title,
      author,
      format,
      source,
      thumbnail,
      external_url,
      duration_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getPlaylistTracks: db.prepare(`
    SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY added_at
  `),
  removeTrackFromPlaylist: db.prepare(`
    DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?
  `),
  clearPlaylist: db.prepare(`
    DELETE FROM playlist_tracks WHERE playlist_id = ?
  `),

  // collab playlists
  createCollabPlaylist: db.prepare(`
    INSERT INTO collab_playlists (id, server_id, name, created_by) VALUES (?, ?, ?, ?)
  `),
  getCollabPlaylists: db.prepare(`
    SELECT cp.*, u.username as created_by_username
    FROM collab_playlists cp
    JOIN users u ON cp.created_by = u.id
    WHERE cp.server_id = ?
    ORDER BY cp.created_at
  `),
  getCollabPlaylistById: db.prepare(`
    SELECT cp.*, u.username as created_by_username
    FROM collab_playlists cp
    JOIN users u ON cp.created_by = u.id
    WHERE cp.id = ? AND cp.server_id = ?
  `),
  updateCollabPlaylistName: db.prepare(`
    UPDATE collab_playlists SET name = ?, updated_at = strftime('%s', 'now') WHERE id = ? AND server_id = ?
  `),
  deleteCollabPlaylist: db.prepare(`
    DELETE FROM collab_playlists WHERE id = ? AND server_id = ?
  `),
  deleteCollabPlaylistsByServer: db.prepare(`
    DELETE FROM collab_playlists WHERE server_id = ?
  `),

  // collab playlist tracks
  addTrackToCollabPlaylist: db.prepare(`
    INSERT INTO collab_playlist_tracks (
      id, playlist_id, video_id, title, author, format, source, thumbnail, external_url, duration_ms, added_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getCollabPlaylistTracks: db.prepare(`
    SELECT * FROM collab_playlist_tracks WHERE playlist_id = ? ORDER BY COALESCE(position, 1000000000 + added_at), rowid
  `),
  setCollabTrackPosition: db.prepare(`
    UPDATE collab_playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?
  `),
  removeTrackFromCollabPlaylist: db.prepare(`
    DELETE FROM collab_playlist_tracks WHERE id = ? AND playlist_id = ?
  `),
  clearCollabPlaylist: db.prepare(`
    DELETE FROM collab_playlist_tracks WHERE playlist_id = ?
  `),
  reorderCollabPlaylistTracks: db.prepare(`
    UPDATE collab_playlist_tracks SET id = ? WHERE id = ? AND playlist_id = ?
  `),

  // download history
  getDownloadedTracks: db.prepare(`
    SELECT * FROM downloaded_tracks WHERE user_id = ? ORDER BY downloaded_at DESC
  `),
  addDownloadedTrack: db.prepare(`
    INSERT INTO downloaded_tracks (id, user_id, video_id, title, author, format, source, thumbnail, external_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  removeDownloadedTrack: db.prepare(`
    DELETE FROM downloaded_tracks WHERE id = ? AND user_id = ?
  `),

  // user queue
  getUserQueue: db.prepare(`
    SELECT * FROM user_queue WHERE user_id = ? ORDER BY position, added_at
  `),
  addToUserQueue: db.prepare(`
    INSERT INTO user_queue (
      id,
      user_id,
      video_id,
      title,
      author,
      format,
      source,
      thumbnail,
      external_url,
      duration_ms,
      position
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  removeFromUserQueue: db.prepare(`
    DELETE FROM user_queue WHERE id = ? AND user_id = ?
  `),
  clearUserQueue: db.prepare(`
    DELETE FROM user_queue WHERE user_id = ?
  `),
  updateUserQueuePosition: db.prepare(`
    UPDATE user_queue SET position = ? WHERE id = ?
  `),
  upsertUserQueue: db.prepare(`
    INSERT INTO user_queue (
      id,
      user_id,
      video_id,
      title,
      author,
      format,
      source,
      thumbnail,
      external_url,
      duration_ms,
      position
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      position = excluded.position,
      title = excluded.title,
      author = excluded.author,
      format = excluded.format,
      source = excluded.source,
      thumbnail = excluded.thumbnail,
      external_url = excluded.external_url,
      duration_ms = excluded.duration_ms
  `),

  // server queue
  addToServerQueue: db.prepare(`
    INSERT INTO server_queue (
      id,
      server_id,
      video_id,
      title,
      author,
      format,
      source,
      thumbnail,
      external_url,
      duration_ms,
      added_by,
      position
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getServerQueue: db.prepare(`
    SELECT * FROM server_queue WHERE server_id = ? ORDER BY position, added_at
  `),
  removeFromServerQueue: db.prepare(`
    DELETE FROM server_queue WHERE id = ? AND server_id = ?
  `),
  clearServerQueue: db.prepare(`
    DELETE FROM server_queue WHERE server_id = ?
  `),
  updateServerQueuePosition: db.prepare(`
    UPDATE server_queue SET position = ? WHERE id = ?
  `),

  // server player state
  upsertServerPlayerState: db.prepare(`
    INSERT INTO server_player_state (server_id, current_track_id, is_playing, current_time, volume, updated_at, sync_updated_at_ms)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'), ?)
    ON CONFLICT(server_id) DO UPDATE SET
      current_track_id = excluded.current_track_id,
      is_playing = excluded.is_playing,
      current_time = excluded.current_time,
      volume = excluded.volume,
      updated_at = strftime('%s', 'now'),
      sync_updated_at_ms = excluded.sync_updated_at_ms
  `),
  getServerPlayerState: db.prepare(`
    SELECT * FROM server_player_state WHERE server_id = ?
  `),
  deleteServerPlayerState: db.prepare(`
    DELETE FROM server_player_state WHERE server_id = ?
  `),
  getServerPlayModes: db.prepare(`
    SELECT repeat_mode, shuffle FROM server_play_modes WHERE server_id = ?
  `),
  upsertServerPlayModes: db.prepare(`
    INSERT INTO server_play_modes (server_id, repeat_mode, shuffle) VALUES (?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET repeat_mode = excluded.repeat_mode, shuffle = excluded.shuffle
  `),

  // server chat history
  createServerMessage: db.prepare(`
    INSERT INTO server_messages (id, server_id, user_id, username, message, sender_theme_color)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getServerMessages: db.prepare(`
    SELECT * FROM server_messages WHERE server_id = ? ORDER BY created_at DESC LIMIT ?
  `),

  // login tokens
  saveAuthToken: db.prepare(`
    INSERT OR REPLACE INTO auth_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)
  `),
  getAuthToken: db.prepare(`
    SELECT user_id, expires_at FROM auth_tokens WHERE token_hash = ?
  `),
  deleteAuthToken: db.prepare(`
    DELETE FROM auth_tokens WHERE token_hash = ?
  `),
  deleteAuthTokensForUser: db.prepare(`
    DELETE FROM auth_tokens WHERE user_id = ?
  `),
  deleteExpiredAuthTokens: db.prepare(`
    DELETE FROM auth_tokens WHERE expires_at <= ?
  `),

  // active servers
  createActiveServer: db.prepare(`
    INSERT INTO active_servers (id, name, host_id, host_username, ws_port, is_private, join_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getActiveServerByJoinCode: db.prepare(`
    SELECT * FROM active_servers WHERE is_private = 1 AND join_code = ?
  `),
  getAllActiveServers: db.prepare(`
    SELECT * FROM active_servers ORDER BY created_at DESC
  `),
  getActiveServerById: db.prepare(`
    SELECT * FROM active_servers WHERE id = ?
  `),
  deleteActiveServer: db.prepare(`
    DELETE FROM active_servers WHERE id = ?
  `),
  updateActiveServer: db.prepare(`
    UPDATE active_servers SET updated_at = strftime('%s', 'now') WHERE id = ?
  `),

  // server members
  addServerMember: db.prepare(`
    INSERT INTO server_members (id, server_id, user_id, username, is_admin)
    VALUES (?, ?, ?, ?, ?)
  `),
  getServerMembers: db.prepare(`
    SELECT * FROM server_members WHERE server_id = ? ORDER BY joined_at
  `),
  getServerMemberByUserId: db.prepare(`
    SELECT * FROM server_members WHERE server_id = ? AND user_id = ?
  `),
  removeServerMember: db.prepare(`
    DELETE FROM server_members WHERE id = ? AND server_id = ?
  `),
  removeServerMemberByUserId: db.prepare(`
    DELETE FROM server_members WHERE server_id = ? AND user_id = ?
  `),
  getUserServers: db.prepare(`
    SELECT s.*, sm.is_admin, sm.joined_at FROM server_members sm
    JOIN active_servers s ON sm.server_id = s.id
    WHERE sm.user_id = ?
    ORDER BY s.created_at DESC
  `),

  // online status
  setOnlineStatus: db.prepare(`
    INSERT INTO online_status (user_id, is_online, last_seen, current_server_id)
    VALUES (?, 1, strftime('%s', 'now'), NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      is_online = 1,
      last_seen = strftime('%s', 'now')
  `),
  setOfflineStatus: db.prepare(`
    UPDATE online_status SET is_online = 0, last_seen = strftime('%s', 'now'), current_server_id = NULL
    WHERE user_id = ?
  `),
  updateOnlineServer: db.prepare(`
    UPDATE online_status SET current_server_id = ?, last_seen = strftime('%s', 'now')
    WHERE user_id = ?
  `),
  clearOnlineServer: db.prepare(`
    UPDATE online_status SET current_server_id = NULL, last_seen = strftime('%s', 'now')
    WHERE user_id = ?
  `),
  deleteUserById: db.prepare(`
    DELETE FROM users WHERE id = ?
  `),
  deleteUserSessionsByUserId: db.prepare(`
    DELETE FROM user_sessions WHERE user_id = ?
  `),
  deleteUserFriendsByUserId: db.prepare(`
    DELETE FROM friends WHERE user_id = ? OR friend_id = ?
  `),
  deleteUserFriendRequestsByUserId: db.prepare(`
    DELETE FROM friend_requests WHERE sender_id = ? OR receiver_id = ?
  `),
  deleteUserPlaylistsByUserId: db.prepare(`
    DELETE FROM playlists WHERE user_id = ?
  `),
  deleteUserServerMemberships: db.prepare(`
    DELETE FROM server_members WHERE user_id = ?
  `),
  deleteUserServerMessages: db.prepare(`
    DELETE FROM server_messages WHERE user_id = ?
  `),
  deleteUserDirectMessages: db.prepare(`
    DELETE FROM direct_messages WHERE sender_id = ? OR receiver_id = ?
  `),
  getConversations: db.prepare(`
    WITH ranked_conversations AS (
      SELECT
        CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as user_id,
        CASE WHEN sender_id = ? THEN receiver_username ELSE sender_username END as username,
        message as last_message,
        sender_username as last_sender_username,
        sender_id as last_sender_id,
        created_at as last_message_at,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
          ORDER BY created_at DESC, id DESC
        ) as row_rank
      FROM direct_messages
      WHERE sender_id = ? OR receiver_id = ?
    )
    SELECT
      user_id,
      username,
      last_message,
      last_sender_username,
      last_sender_id,
      last_message_at,
      0 as unread_count
    FROM ranked_conversations
    WHERE row_rank = 1
    ORDER BY last_message_at DESC, user_id ASC
  `),
  getAllOnlineStatus: db.prepare(`SELECT user_id, is_online, last_seen FROM online_status`),
  getUserKey: db.prepare(`SELECT * FROM user_keys WHERE user_id = ?`),
  createUserKey: db.prepare(`
    INSERT OR IGNORE INTO user_keys (user_id, public_key, kid, wrapped_private, wrap_salt, wrap_iv, wrap_iters)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  listUserKeyIds: db.prepare(`SELECT user_id FROM user_keys`),
  getIntegration: db.prepare(`SELECT * FROM integrations WHERE user_id = ? AND provider = ?`),
  saveIntegration: db.prepare(`
    INSERT INTO integrations (user_id, provider, access_token, refresh_token, expires_at, account_name)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at, account_name = excluded.account_name
  `),
  deleteIntegration: db.prepare(`DELETE FROM integrations WHERE user_id = ? AND provider = ?`),
  getSentFriendRequests: db.prepare(`
    SELECT fr.*, u.username AS receiver_username FROM friend_requests fr
    JOIN users u ON fr.receiver_id = u.id
    WHERE fr.sender_id = ? AND fr.status = 'pending'
  `),
  lastListen: db.prepare(`SELECT * FROM listen_events WHERE user_id = ? ORDER BY id DESC LIMIT 1`),
  insertListen: db.prepare(`
    INSERT INTO listen_events (user_id, track_key, title, author, source, started_at, ended_at, seconds, plays)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  extendListen: db.prepare(`UPDATE listen_events SET seconds = seconds + ?, ended_at = ? WHERE id = ?`),
  upsertInvite: db.prepare(`
    INSERT INTO room_invites (id, server_id, from_id, to_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(server_id, to_id) DO UPDATE SET id = excluded.id, from_id = excluded.from_id, created_at = strftime('%s', 'now')
  `),
  getInvitesFor: db.prepare(`
    SELECT ri.id, ri.server_id, ri.from_id, ri.created_at, u.username AS from_username, s.name AS server_name, s.is_private
    FROM room_invites ri
    JOIN users u ON u.id = ri.from_id
    JOIN active_servers s ON s.id = ri.server_id
    WHERE ri.to_id = ? AND ri.created_at >= ?
    ORDER BY ri.created_at DESC
  `),
  getInviteById: db.prepare(`SELECT * FROM room_invites WHERE id = ?`),
  hasInvite: db.prepare(`SELECT 1 AS yes FROM room_invites WHERE server_id = ? AND to_id = ? AND created_at >= ?`),
  deleteInvite: db.prepare(`DELETE FROM room_invites WHERE id = ?`),
  clearInvitesFor: db.prepare(`DELETE FROM room_invites WHERE server_id = ? AND to_id = ?`),
  purgeInvites: db.prepare(`DELETE FROM room_invites WHERE created_at < ?`),
  getDirectMessages: db.prepare(`
    SELECT * FROM direct_messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC
  `),
  createDirectMessage: db.prepare(`
    INSERT INTO direct_messages (id, sender_id, sender_username, receiver_id, receiver_username, message, sender_theme_color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
  `),
  getOnlineUsers: db.prepare(`
    SELECT u.id, u.username, os.is_online, os.current_server_id, os.last_seen
    FROM users u
    LEFT JOIN online_status os ON u.id = os.user_id
    WHERE os.is_online = 1
    ORDER BY u.username
  `),
  getUserOnlineStatus: db.prepare(`
    SELECT u.id, u.username, os.is_online, os.current_server_id, os.last_seen
    FROM users u
    LEFT JOIN online_status os ON u.id = os.user_id
    WHERE u.id = ?
  `)
};

// little id generator helpers, all just uuid w/ a prefix so you can tell
// what kind of thing an id belongs to at a glance
const createPlaylistTrackId = () => `pt_${crypto.randomUUID()}`;
const createDownloadedTrackId = () => `dt_${crypto.randomUUID()}`;
const createSessionId = () => `session_${crypto.randomUUID()}`;
const createFriendRequestId = () => `fr_${crypto.randomUUID()}`;
const createFriendId = () => `friend_${crypto.randomUUID()}`;
const createServerQueueId = () => `sq_${crypto.randomUUID()}`;
const createServerId = () => `server_${crypto.randomUUID()}`;
const createServerMemberId = () => `sm_${crypto.randomUUID()}`;
const createServerMessageId = () => `msg_${crypto.randomUUID()}`;

function normalizeTrackInput(track = {}) {
  return {
    videoId: String(track.videoId || track.video_id || track.id || '').trim(),
    title: String(track.title || '').trim(),
    author: String(track.author || track.artist || '').trim(),
    format: String(track.format || 'mp3').trim().toLowerCase(),
    source: String(track.source || track.provider || 'youtube').trim().toLowerCase() || 'youtube',
    thumbnail: String(track.thumbnail || '').trim(),
    externalUrl: String(track.externalUrl || track.external_url || '').trim(),
    durationMs: Number(track.durationMs || track.duration_ms || 0) || 0
  };
}

function normalizeStoredTrack(track = {}) {
  return {
    ...track,
    videoId: track.video_id,
    source: track.source || 'youtube',
    thumbnail: track.thumbnail || '',
    externalUrl: track.external_url || '',
    external_url: track.external_url || '',
    durationMs: Number(track.duration_ms || 0) || 0,
    duration_ms: Number(track.duration_ms || 0) || 0
  };
}

const acceptFriendRequestTxn = db.transaction((requestId, receiverId = null) => {
  // prepping statements right here inside the transaction instead of
  // reusing the shared ones - more reliable this way
  const getFriendReq = db.prepare('SELECT * FROM friend_requests WHERE id = ?');
  const checkFriend = db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?');
  const addFriendStmt = db.prepare('INSERT OR IGNORE INTO friends (id, user_id, friend_id) VALUES (?, ?, ?)');
  const deleteFriendReq = db.prepare('DELETE FROM friend_requests WHERE id = ?');
  
  const request = getFriendReq.get(requestId);
  if (!request || (request.status && request.status !== 'pending')) {
    return { error: 'not_found' };
  }
  if (receiverId && request.receiver_id !== receiverId) {
    return { error: 'forbidden' };
  }

  if (!checkFriend.get(request.receiver_id, request.sender_id)) {
    const id1 = createFriendId();
    addFriendStmt.run(id1, request.receiver_id, request.sender_id);
  }
  if (!checkFriend.get(request.sender_id, request.receiver_id)) {
    const id2 = createFriendId();
    addFriendStmt.run(id2, request.sender_id, request.receiver_id);
  }

  deleteFriendReq.run(requestId);
  return { ok: true, request };
});

const declineFriendRequestTxn = db.transaction((requestId, receiverId = null) => {
  // same deal, prep em locally inside the transaction
  const getFriendReq = db.prepare('SELECT * FROM friend_requests WHERE id = ?');
  const deleteFriendReq = db.prepare('DELETE FROM friend_requests WHERE id = ?');
  
  const request = getFriendReq.get(requestId);
  if (!request || (request.status && request.status !== 'pending')) {
    return { error: 'not_found' };
  }
  if (receiverId && request.receiver_id !== receiverId) {
    return { error: 'forbidden' };
  }

  deleteFriendReq.run(requestId);
  return { ok: true, request };
});

// ---- invites
const INVITE_TTL_SECONDS = 24 * 60 * 60;

// ---- listening stats
const MERGE_GAP_SECONDS = 10 * 60;
const MAX_SEGMENT_SECONDS = 4 * 60 * 60;
const trackKeyOf = (title, author) => `${String(title).trim().toLowerCase()}|${String(author || '').trim().toLowerCase()}`;

// one stretch of listening to one song. a stretch that continues the last one (same song, a few minutes apart, same
// hour so the hours chart stays right) is added to its row, a song that comes back later is a new play
function recordListening(userId, track, startedAt, endedAt) {
  const start = Math.floor(startedAt);
  const end = Math.floor(endedAt);
  const seconds = Math.min(end - start, MAX_SEGMENT_SECONDS);
  if (!userId || !track || !String(track.title || '').trim() || !(seconds >= 1)) return false;
  const title = String(track.title).trim().slice(0, 200);
  const author = String(track.author || '').trim().slice(0, 120);
  const key = trackKeyOf(title, author);
  const last = statements.lastListen.get(userId);
  const continues = last && last.track_key === key && start - last.ended_at <= MERGE_GAP_SECONDS && start >= last.ended_at - 60;
  if (continues && Math.floor(last.started_at / 3600) === Math.floor(start / 3600)) {
    statements.extendListen.run(seconds, Math.max(last.ended_at, start + seconds), last.id);
  } else {
    statements.insertListen.run(userId, key, title, author, String(track.source || 'personal').slice(0, 20), start, start + seconds, seconds, continues ? 0 : 1);
  }
  return true;
}

// the bounds of a range in local days (offsetMin is the minutes the person's clock is east of UTC)
function statsRange(range, nowSec, offsetMin) {
  const offset = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(Number(offsetMin) || 0))) * 60;
  const today = Math.floor((nowSec + offset) / 86400);
  const length = { week: 7, month: 30, year: 365 }[range] || 0;
  const from = length ? (today - length + 1) * 86400 - offset : 0;
  const to = (today + 1) * 86400 - offset;
  const previousFrom = length ? from - length * 86400 : 0;
  return { range: length ? range : 'all', offset, today, length, from, to, previousFrom };
}

const dayName = (dayIndex) => new Date(dayIndex * 86400000).toISOString().slice(0, 10);

function getListeningStats(userId, { range = 'week', offsetMin = 0, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const r = statsRange(range, nowSec, offsetMin);
  const q = (sql, ...params) => db.prepare(sql).all(...params);
  const where = 'user_id = ? AND started_at >= ? AND started_at < ?';
  const base = [userId, r.from, r.to];

  const totals = q(`SELECT COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(plays), 0) AS plays,
      COUNT(DISTINCT track_key) AS tracks, COUNT(DISTINCT CASE WHEN author <> '' THEN lower(author) END) AS artists
    FROM listen_events WHERE ${where}`, ...base)[0];
  const previous = r.length
    ? q(`SELECT COALESCE(SUM(seconds), 0) AS seconds FROM listen_events WHERE user_id = ? AND started_at >= ? AND started_at < ?`, userId, r.previousFrom, r.from)[0].seconds
    : null;

  const topTracks = q(`SELECT title, author, SUM(seconds) AS seconds, SUM(plays) AS plays FROM listen_events WHERE ${where}
    GROUP BY track_key ORDER BY seconds DESC, plays DESC LIMIT 25`, ...base);
  const topArtists = q(`SELECT MIN(author) AS author, SUM(seconds) AS seconds, SUM(plays) AS plays, COUNT(DISTINCT track_key) AS tracks
    FROM listen_events WHERE ${where} AND author <> '' GROUP BY lower(author) ORDER BY seconds DESC, plays DESC LIMIT 25`, ...base);

  const hours = new Array(24).fill(0);
  q(`SELECT (CAST(started_at + ? AS INTEGER) % 86400) / 3600 AS h, SUM(seconds) AS s FROM listen_events WHERE ${where} GROUP BY h`, r.offset, ...base)
    .forEach((row) => { hours[row.h] = row.s; });
  const weekdays = new Array(7).fill(0);
  q(`SELECT ((CAST(started_at + ? AS INTEGER) / 86400) + 4) % 7 AS d, SUM(seconds) AS s FROM listen_events WHERE ${where} GROUP BY d`, r.offset, ...base)
    .forEach((row) => { weekdays[row.d] = row.s; });

  // the last 30 days, one bar each (today last)
  const perDay = new Map(q(`SELECT CAST(started_at + ? AS INTEGER) / 86400 AS d, SUM(seconds) AS s FROM listen_events
    WHERE user_id = ? AND started_at >= ? GROUP BY d`, r.offset, userId, (r.today - 29) * 86400 - r.offset).map((row) => [row.d, row.s]));
  const days = [];
  for (let d = r.today - 29; d <= r.today; d += 1) days.push({ day: dayName(d), seconds: perDay.get(d) || 0 });

  // the last 12 months, one bar each
  const monthRows = new Map(q(`SELECT strftime('%Y-%m', started_at + ?, 'unixepoch') AS m, SUM(seconds) AS s FROM listen_events
    WHERE user_id = ? GROUP BY m ORDER BY m DESC LIMIT 12`, r.offset, userId).map((row) => [row.m, row.s]));
  const months = [];
  const nowDate = new Date((nowSec + r.offset) * 1000);
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({ month: key, seconds: monthRows.get(key) || 0 });
  }

  // days in a row with something played (today does not break it before it is over)
  const activeDays = q(`SELECT DISTINCT CAST(started_at + ? AS INTEGER) / 86400 AS d FROM listen_events WHERE user_id = ? ORDER BY d DESC LIMIT 1000`, r.offset, userId).map((row) => row.d);
  let current = 0;
  let cursor = activeDays[0] === r.today ? r.today : r.today - 1;
  for (const d of activeDays) {
    if (d === cursor) { current += 1; cursor -= 1; } else if (d < cursor) break;
  }
  let best = 0; let run = 0; let prev = null;
  for (const d of activeDays) {
    run = prev !== null && prev - d === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }

  // songs and artists heard for the first time in this range
  const firstSeen = (column) => q(`SELECT COUNT(*) AS n FROM (SELECT MIN(started_at) AS f FROM listen_events WHERE user_id = ? ${column === 'artist' ? "AND author <> ''" : ''} GROUP BY ${column === 'artist' ? 'lower(author)' : 'track_key'}) WHERE f >= ? AND f < ?`, userId, r.from, r.to)[0].n;
  const first = q('SELECT MIN(started_at) AS f FROM listen_events WHERE user_id = ?', userId)[0].f;

  // the day with the most listening in this range, and the single longest stretch of one song
  const bestDayRow = q(`SELECT CAST(started_at + ? AS INTEGER) / 86400 AS d, SUM(seconds) AS s FROM listen_events WHERE ${where}
    GROUP BY d ORDER BY s DESC LIMIT 1`, r.offset, ...base)[0];
  const longestRow = q(`SELECT title, author, seconds FROM listen_events WHERE ${where} ORDER BY seconds DESC LIMIT 1`, ...base)[0];

  return {
    range: r.range,
    from: r.from,
    to: r.to,
    days_in_range: r.length || (first ? Math.max(1, r.today - Math.floor((first + r.offset) / 86400) + 1) : 1),
    totals: {
      seconds: totals.seconds, plays: totals.plays, tracks: totals.tracks, artists: totals.artists,
      previous_seconds: previous, new_tracks: firstSeen('track'), new_artists: firstSeen('artist')
    },
    today_seconds: perDay.get(r.today) || 0,
    top_tracks: topTracks,
    top_artists: topArtists,
    hours,
    weekdays,
    days,
    months,
    streak: { current, best, active_days: activeDays.length },
    best_day: bestDayRow ? { day: dayName(bestDayRow.d), seconds: bestDayRow.s } : null,
    longest: longestRow ? { title: longestRow.title, author: longestRow.author, seconds: longestRow.seconds } : null,
    since: first || null
  };
}

// how much each of these accounts listened in a range (for a list of friends)
function getListeningBoard(userIds, { range = 'week', offsetMin = 0, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const r = statsRange(range, nowSec, offsetMin);
  const out = [];
  const total = db.prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM listen_events WHERE user_id = ? AND started_at >= ? AND started_at < ?');
  const artist = db.prepare(`SELECT MIN(author) AS author FROM listen_events WHERE user_id = ? AND started_at >= ? AND started_at < ? AND author <> ''
    GROUP BY lower(author) ORDER BY SUM(seconds) DESC LIMIT 1`);
  for (const userId of userIds) {
    const seconds = total.get(userId, r.from, r.to).s;
    out.push({ user_id: userId, seconds, top_artist: seconds ? (artist.get(userId, r.from, r.to) || {}).author || null : null });
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

// every chat row written before the scrambling existed is plain text. it is scrambled once, here, at start
// (a row that is already scrambled, or already an end to end envelope, is left alone)
function scrambleStoredMessages() {
  let changed = 0;
  const run = db.transaction(() => {
    for (const [table, column] of [['direct_messages', 'message'], ['server_messages', 'message']]) {
      const rows = db.prepare(`SELECT id, ${column} AS text FROM ${table} WHERE ${column} NOT LIKE 'enc1:%' AND ${column} NOT LIKE 'e2e1:%'`).all();
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        update.run(atRest.seal(row.text), row.id);
        changed += 1;
      }
    }
  });
  try {
    run();
  } catch (error) {
    console.error('could not scramble the stored messages:', error.message);
  }
  return changed;
}
const scrambledAtStart = scrambleStoredMessages();
if (scrambledAtStart > 0) {
  console.log(`[PRIVACY] ${scrambledAtStart} stored messages were scrambled`);
  // rewrite the file so no old copy of the text is left in pages that were freed
  try {
    db.exec('VACUUM');
  } catch (error) {
    console.error('could not compact the database after scrambling:', error.message);
  }
}

module.exports = {
  db,
  statements,
  atRest,
  ADMIN_USERNAMES,
  createPlaylistTrackId,
  createDownloadedTrackId,
  createSessionId,
  createFriendRequestId,
  createFriendId,
  createServerQueueId,
  createServerId,
  createServerMemberId,
  createServerMessageId,
  normalizeTrackInput,
  normalizeStoredTrack,

  // user management
  createUser: (username, password) => {
    const id = `user_${crypto.randomUUID()}`;
    const passwordHash = bcrypt.hashSync(password, 10);
    const isAdmin = ADMIN_USERNAMES.includes(String(username).toLowerCase()) ? 1 : 0;

    // stick the user in with their admin flag
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(
      id, username, passwordHash, isAdmin
    );

    // give em default settings so they've got something to start with
    statements.upsertSettings.run(id, 255, 89, 0, 0, 0);

    return { id, username, is_admin: isAdmin === 1 };
  },

  // exact match first so an old db with two names that differ only by case
  // still logs each one in correctly, then fall back to ignoring case
  findUserByUsername: (username) => {
    return statements.getUserByUsername.get(username)
      || statements.getUserByUsernameNoCase.get(username)
      || null;
  },

  authenticateUser: (username, password) => {
    const user = statements.getUserByUsername.get(username)
      || statements.getUserByUsernameNoCase.get(username);
    if (!user) {
      bcrypt.compareSync(password, DUMMY_PASSWORD_HASH);
      return null;
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return null;

    return { id: user.id, username: user.username, is_admin: user.is_admin === 1 };
  },

  getUserById: (id) => {
    const user = statements.getUserById.get(id);
    if (!user) return null;
    return { ...user, is_admin: user.is_admin === 1 };
  },

  getAllUsers: () => {
    return statements.getAllUsers.all();
  },

  // sessions
  createUserSession: (userId, sessionId = null) => {
    // kill any existing session for this user first - only one at a time allowed
    statements.deleteUserSessionsByUserId.run(userId);

    const id = `session_${crypto.randomUUID()}`;
    const actualSessionId = sessionId || id;
    statements.createUserSession.run(id, userId, actualSessionId);
    return { id, user_id: userId, session_id: actualSessionId };
  },

  getUserSession: (sessionId) => {
    return statements.getUserSession.get(sessionId);
  },

  getUserActiveSession: (userId) => {
    return statements.getUserActiveSession.get(userId);
  },

  updateUserSessionLastSeen: (sessionId) => {
    statements.updateUserSessionLastSeen.run(sessionId);
  },

  deleteUserSession: (sessionId) => {
    statements.deleteUserSession.run(sessionId);
  },

  deleteUserSessionsByUserId: (userId) => {
    statements.deleteUserSessionsByUserId.run(userId);
  },

  // settings
  getSettings: (userId) => {
    return statements.getSettings.get(userId) || {
      theme_color_r: 255,
      theme_color_g: 89,
      theme_color_b: 0,
      debug_mode: 0,
      hide_listening: 0
    };
  },

  saveSettings: (userId, settings) => {
    // an older app saves its settings without this field, that must not switch it back
    const hideListening = settings.hide_listening === undefined
      ? ((statements.getSettings.get(userId) || {}).hide_listening || 0)
      : (settings.hide_listening ? 1 : 0);
    statements.upsertSettings.run(
      userId,
      settings.theme_color_r,
      settings.theme_color_g,
      settings.theme_color_b,
      settings.debug_mode ? 1 : 0,
      hideListening
    );
  },

  // friend requests
  createFriendRequest: (senderId, receiverId) => {
    // already friends? bail, dont need a request for that
    const existingFriend = statements.isFriend.get(senderId, receiverId);
    if (existingFriend) {
      return { error: 'already_friends' };
    }

    // the other person already asked you: asking back is the same as saying yes
    const reverse = statements.getFriendRequestByUsers.get(receiverId, senderId);
    if (reverse && (!reverse.status || reverse.status === 'pending')) {
      const accepted = acceptFriendRequestTxn(reverse.id, senderId);
      if (!accepted.error) {
        return { auto_accepted: true, id: reverse.id, sender_id: senderId, receiver_id: receiverId, status: 'accepted' };
      }
    }

    // request already out there? dont send a dupe
    const existingRequest = statements.getFriendRequestByUsers.get(senderId, receiverId) || reverse;
    if (existingRequest) {
      return { error: 'request_exists' };
    }
    
    const id = createFriendRequestId();
    statements.createFriendRequest.run(id, senderId, receiverId);
    return { id, sender_id: senderId, receiver_id: receiverId, status: 'pending' };
  },

  getPendingFriendRequests: (userId) => {
    return statements.getPendingFriendRequests.all(userId);
  },

  // the requests this person sent that have not been answered
  getSentFriendRequests: (userId) => statements.getSentFriendRequests.all(userId),

  // takes a request back (only the one who sent it can)
  cancelFriendRequest: (requestId, senderId) => {
    const request = statements.getFriendRequestById.get(requestId);
    if (!request || (request.status && request.status !== 'pending')) return { error: 'not_found' };
    if (request.sender_id !== senderId) return { error: 'forbidden' };
    statements.deleteFriendRequest.run(requestId);
    return { ok: true, request };
  },

  friendIdsOf: (userId) => new Set(statements.getFriends.all(userId).map((row) => row.friend_id)),

  acceptFriendRequest: (requestId, receiverId = null) => {
    return acceptFriendRequestTxn(requestId, receiverId);
  },

  declineFriendRequest: (requestId, receiverId = null) => {
    return declineFriendRequestTxn(requestId, receiverId);
  },

  // friends
  getFriends: (userId) => {
    return statements.getFriends.all(userId);
  },

  isFriend: (userId, friendId) => {
    return !!statements.isFriend.get(userId, friendId);
  },

  removeFriend: (userId, friendId) => {
    // gotta nuke both directions of the friendship row, its stored twice
    const friendship1 = statements.isFriend.get(userId, friendId);
    const friendship2 = statements.isFriend.get(friendId, userId);
    
    if (friendship1) statements.removeFriend.run(friendship1.id);
    if (friendship2) statements.removeFriend.run(friendship2.id);
    
    return { ok: true };
  },

  // playlists
  createPlaylist: (userId, name) => {
    const id = `playlist_${crypto.randomUUID()}`;
    statements.createPlaylist.run(id, userId, name);
    return { id, user_id: userId, name };
  },

  getUserPlaylists: (userId) => {
    const playlists = statements.getUserPlaylists.all(userId);
    return playlists.map(playlist => ({
      ...playlist,
      tracks: statements.getPlaylistTracks.all(playlist.id).map(normalizeStoredTrack)
    }));
  },

  getPlaylistById: (playlistId, userId) => {
    const playlist = statements.getPlaylistById.get(playlistId, userId);
    if (!playlist) return null;

    return {
      ...playlist,
      tracks: statements.getPlaylistTracks.all(playlist.id).map(normalizeStoredTrack)
    };
  },

  updatePlaylist: (playlistId, userId, newName) => {
    statements.updatePlaylist.run(newName, playlistId, userId);
  },

  deletePlaylist: (playlistId, userId) => {
    statements.deletePlaylist.run(playlistId, userId);
  },

  replaceUserPlaylists: (userId, playlists) => {
    const replacePlaylists = db.transaction((incomingPlaylists) => {
      statements.deleteUserPlaylists.run(userId);

      incomingPlaylists.forEach((playlist) => {
        let playlistId = String(playlist.id || `playlist_${crypto.randomUUID()}`).trim();
        // this user's own playlists were just cleared, so an id that still
        // exists belongs to someone else (or repeats in this batch). take a
        // fresh id instead of failing the whole sync on the primary key
        if (statements.playlistIdExists.get(playlistId)) {
          playlistId = `playlist_${crypto.randomUUID()}`;
        }
        const playlistName = String(playlist.name || 'untitled playlist').trim();
        statements.createPlaylistWithId.run(playlistId, userId, playlistName);

        const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
        tracks.forEach((track) => {
          const normalizedTrack = normalizeTrackInput(track);
          const trackId = createPlaylistTrackId();

          statements.addTrackToPlaylist.run(
            trackId,
            playlistId,
            normalizedTrack.videoId,
            normalizedTrack.title,
            normalizedTrack.author,
          normalizedTrack.format,
          normalizedTrack.source,
          normalizedTrack.thumbnail,
          normalizedTrack.externalUrl,
          normalizedTrack.durationMs
        );
        });
      });
    });

    replacePlaylists(Array.isArray(playlists) ? playlists : []);
    return module.exports.getUserPlaylists(userId);
  },

  addTrackToPlaylist: (playlistId, track) => {
    const normalizedTrack = normalizeTrackInput(track);
    const id = createPlaylistTrackId();
    statements.addTrackToPlaylist.run(
      id,
      playlistId,
      normalizedTrack.videoId,
      normalizedTrack.title,
      normalizedTrack.author,
      normalizedTrack.format,
      normalizedTrack.source,
      normalizedTrack.thumbnail,
      normalizedTrack.externalUrl,
      normalizedTrack.durationMs
    );
    return normalizeStoredTrack({ id, playlist_id: playlistId, video_id: normalizedTrack.videoId, title: normalizedTrack.title, author: normalizedTrack.author, format: normalizedTrack.format, source: normalizedTrack.source, thumbnail: normalizedTrack.thumbnail, external_url: normalizedTrack.externalUrl, duration_ms: normalizedTrack.durationMs });
  },

  getPlaylistTracks: (playlistId) => {
    return statements.getPlaylistTracks.all(playlistId).map(normalizeStoredTrack);
  },

  removeTrackFromPlaylist: (trackId, playlistId) => {
    statements.removeTrackFromPlaylist.run(trackId, playlistId);
  },

  clearPlaylist: (playlistId) => {
    statements.clearPlaylist.run(playlistId);
  },

  // download history
  getDownloadedTracks: (userId) => {
    return statements.getDownloadedTracks.all(userId).map(normalizeStoredTrack);
  },

  addDownloadedTrack: (userId, track) => {
    const normalizedTrack = normalizeTrackInput(track);
    const id = createDownloadedTrackId();
    statements.addDownloadedTrack.run(
      id,
      userId,
      normalizedTrack.videoId,
      normalizedTrack.title,
      normalizedTrack.author,
      normalizedTrack.format,
      normalizedTrack.source,
      normalizedTrack.thumbnail,
      normalizedTrack.externalUrl
    );
    return normalizeStoredTrack({ id, user_id: userId, video_id: normalizedTrack.videoId, title: normalizedTrack.title, author: normalizedTrack.author, format: normalizedTrack.format, source: normalizedTrack.source, thumbnail: normalizedTrack.thumbnail, external_url: normalizedTrack.externalUrl });
  },

  removeDownloadedTrack: (trackId, userId) => {
    statements.removeDownloadedTrack.run(trackId, userId);
  },

  // user queue
  getUserQueue: (userId) => {
    return statements.getUserQueue.all(userId).map(normalizeStoredTrack);
  },

  addToUserQueue: (userId, track, position = null) => {
    const normalizedTrack = normalizeTrackInput(track);
    const id = createServerQueueId(); // yeah reusing the server queue id gen here, its just a uuid prefix, works fine
    const maxPos = db.prepare('SELECT MAX(position) as maxPos FROM user_queue WHERE user_id = ?').get(userId);
    const newPos = position !== null ? position : (maxPos.maxPos || 0) + 1;

    statements.addToUserQueue.run(
      id,
      userId,
      normalizedTrack.videoId,
      normalizedTrack.title,
      normalizedTrack.author,
      normalizedTrack.format,
      normalizedTrack.source,
      normalizedTrack.thumbnail,
      normalizedTrack.externalUrl,
      normalizedTrack.durationMs,
      newPos
    );
    return normalizeStoredTrack({ id, user_id: userId, video_id: normalizedTrack.videoId, title: normalizedTrack.title, author: normalizedTrack.author, format: normalizedTrack.format, source: normalizedTrack.source, thumbnail: normalizedTrack.thumbnail, external_url: normalizedTrack.externalUrl, duration_ms: normalizedTrack.durationMs, position: newPos });
  },

  removeFromUserQueue: (trackId, userId) => {
    statements.removeFromUserQueue.run(trackId, userId);
  },

  clearUserQueue: (userId) => {
    statements.clearUserQueue.run(userId);
  },

  updateUserQueuePosition: (trackId, newPosition) => {
    statements.updateUserQueuePosition.run(newPosition, trackId);
  },

  // server queue
  addToServerQueue: (serverId, track, addedBy, position = null) => {
    const normalizedTrack = normalizeTrackInput(track);
    const id = createServerQueueId();
    const maxPos = db.prepare('SELECT MAX(position) as maxPos FROM server_queue WHERE server_id = ?').get(serverId);
    const newPos = position !== null ? position : (maxPos?.maxPos || 0) + 1;

    try {
      statements.addToServerQueue.run(
        id,
        serverId,
        normalizedTrack.videoId,
        normalizedTrack.title,
        normalizedTrack.author || null,
        normalizedTrack.format,
        normalizedTrack.source || 'youtube',
        normalizedTrack.thumbnail || null,
        normalizedTrack.externalUrl || null,
        normalizedTrack.durationMs || 0,
        addedBy,
        newPos
      );
      return normalizeStoredTrack({ id, server_id: serverId, video_id: normalizedTrack.videoId, title: normalizedTrack.title, author: normalizedTrack.author, format: normalizedTrack.format, source: normalizedTrack.source, thumbnail: normalizedTrack.thumbnail, external_url: normalizedTrack.externalUrl, duration_ms: normalizedTrack.durationMs, added_by: addedBy, position: newPos });
    } catch (error) {
      throw new Error(`Failed to add track to server queue: ${error.message}. Track: ${JSON.stringify(normalizedTrack)}, Server: ${serverId}`);
    }
  },

  getServerQueue: (serverId) => {
    return statements.getServerQueue.all(serverId).map(normalizeStoredTrack);
  },

  removeFromServerQueue: (trackId, serverId) => {
    statements.removeFromServerQueue.run(trackId, serverId);
  },

  clearServerQueue: (serverId) => {
    statements.clearServerQueue.run(serverId);
  },

  updateServerQueuePosition: (trackId, newPosition) => {
    statements.updateServerQueuePosition.run(newPosition, trackId);
  },

  // server player state
  updateServerPlayerState: (serverId, state) => {
    const syncMs = state.sync_updated_at_ms || Date.now();
    statements.upsertServerPlayerState.run(
      serverId,
      state.current_track_id || null,
      state.is_playing ? 1 : 0,
      state.current_time || 0,
      state.volume !== undefined ? state.volume : 1,
      syncMs
    );
  },

  getServerPlayerState: (serverId) => {
    const state = statements.getServerPlayerState.get(serverId);
    if (!state) return null;
    return {
      ...state,
      is_playing: state.is_playing === 1
    };
  },

  deleteServerPlayerState: (serverId) => {
    statements.deleteServerPlayerState.run(serverId);
  },

  // repeat ('off' | 'all' | 'one') and shuffle of a room's player
  getServerPlayModes: (serverId) => {
    const row = statements.getServerPlayModes.get(serverId);
    return row ? { repeat_mode: row.repeat_mode, shuffle: row.shuffle === 1 } : { repeat_mode: 'off', shuffle: false };
  },

  setServerPlayModes: (serverId, modes) => {
    statements.upsertServerPlayModes.run(serverId, modes.repeat_mode, modes.shuffle ? 1 : 0);
  },

  // server chat history
  createServerMessage: (serverId, userId, username, message, senderThemeColor = null) => {
    const id = createServerMessageId();
    const trimmedMessage = String(message || '').trim();
    const themeColorJson = senderThemeColor ? JSON.stringify(senderThemeColor) : null;

    statements.createServerMessage.run(id, serverId, userId, username, atRest.seal(trimmedMessage), themeColorJson);
    return {
      id,
      server_id: serverId,
      user_id: userId,
      username,
      message: trimmedMessage,
      sender_theme_color: senderThemeColor,
      created_at: Math.floor(Date.now() / 1000)
    };
  },

  getServerMessages: (serverId, limit = 100) => {
    return statements.getServerMessages.all(serverId, limit).reverse()
      .map((row) => ({ ...row, message: atRest.open(row.message) }));
  },

  // active servers
  createActiveServer: (name, hostId, hostUsername, wsPort, isPrivate = false) => {
    const id = createServerId();
    // a private channel gets a code: 8 characters without the ones that look
    // alike (0/O, 1/I/L), so it can be read out or typed from a message
    let joinCode = null;
    if (isPrivate) {
      const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      for (let attempt = 0; attempt < 25 && !joinCode; attempt += 1) {
        let candidate = '';
        for (let i = 0; i < 8; i += 1) candidate += alphabet[crypto.randomInt(alphabet.length)];
        if (!statements.getActiveServerByJoinCode.get(candidate)) joinCode = candidate;
      }
      if (!joinCode) throw new Error('could not make a join code');
    }
    statements.createActiveServer.run(id, name, hostId, hostUsername, wsPort, isPrivate ? 1 : 0, joinCode);
    // host gets added as admin automatically, makes sense they'd own their own server
    const memberId = createServerMemberId();
    statements.addServerMember.run(memberId, id, hostId, hostUsername, 1);
    return { id, name, host_id: hostId, host_username: hostUsername, ws_port: wsPort, is_private: isPrivate ? 1 : 0, join_code: joinCode };
  },

  // login tokens: only the hash of a token is stored
  authTokenStorage: {
    save: (tokenHash, userId, expiresAt) => { statements.saveAuthToken.run(tokenHash, userId, expiresAt); },
    get: (tokenHash) => statements.getAuthToken.get(tokenHash) || null,
    remove: (tokenHash) => { statements.deleteAuthToken.run(tokenHash); },
    removeUser: (userId) => { statements.deleteAuthTokensForUser.run(userId); },
    removeExpired: (now) => { statements.deleteExpiredAuthTokens.run(now); }
  },

  // the channel a code belongs to. spaces, dashes and case do not matter
  getActiveServerByJoinCode: (rawCode) => {
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) return null;
    return statements.getActiveServerByJoinCode.get(code) || null;
  },

  getAllActiveServers: () => {
    const servers = statements.getAllActiveServers.all();
    return servers.map(server => ({
      ...server,
      memberCount: statements.getServerMembers.all(server.id).length
    }));
  },

  getActiveServerById: (serverId) => {
    const server = statements.getActiveServerById.get(serverId);
    if (!server) return null;
    return {
      ...server,
      members: statements.getServerMembers.all(serverId)
    };
  },

  deleteActiveServer: (serverId) => {
    statements.deleteActiveServer.run(serverId);
  },

  // server members
  addServerMember: (serverId, userId, username, isAdmin = 0) => {
    // already in? dont double up on the membership row
    const existing = statements.getServerMemberByUserId.get(serverId, userId);
    if (existing) return { error: 'already_member' };

    const id = createServerMemberId();
    statements.addServerMember.run(id, serverId, userId, username, isAdmin);
    return { id, server_id: serverId, user_id: userId, username, is_admin: isAdmin };
  },

  getServerMembers: (serverId) => {
    return statements.getServerMembers.all(serverId);
  },

  getServerMember: (serverId, userId) => {
    return statements.getServerMemberByUserId.get(serverId, userId);
  },

  removeServerMember: (serverId, userId) => {
    statements.removeServerMemberByUserId.run(serverId, userId);
  },

  getUserServers: (userId) => {
    return statements.getUserServers.all(userId);
  },

  isServerAdmin: (serverId, userId) => {
    const member = statements.getServerMemberByUserId.get(serverId, userId);
    return member?.is_admin === 1;
  },

  isServerMember: (serverId, userId) => {
    return !!statements.getServerMemberByUserId.get(serverId, userId);
  },

  leaveServer: (serverId, userId) => {
    statements.removeServerMemberByUserId.run(serverId, userId);
    statements.clearOnlineServer.run(userId);
  },

  deleteUser: (userId) => {
    const run = db.transaction(() => {
      statements.deleteUserDirectMessages.run(userId, userId);
      statements.deleteUserFriendRequestsByUserId.run(userId, userId);
      statements.deleteUserFriendsByUserId.run(userId, userId);
      statements.deleteUserPlaylistsByUserId.run(userId);
      statements.deleteUserServerMessages.run(userId);
      statements.deleteUserServerMemberships.run(userId);
      statements.deleteUserSessionsByUserId.run(userId);
      statements.deleteUserById.run(userId);
    });
    run();
  },

  // online status
  setOnlineStatus: (userId) => {
    statements.setOnlineStatus.run(userId);
  },

  setOfflineStatus: (userId) => {
    statements.setOfflineStatus.run(userId);
  },

  updateOnlineServer: (userId, serverId) => {
    statements.updateOnlineServer.run(serverId, userId);
  },

  getOnlineUsers: () => {
    return statements.getOnlineUsers.all();
  },

  getUserOnlineStatus: (userId) => {
    return statements.getUserOnlineStatus.get(userId);
  },

  getAllOnlineStatus: () => statements.getAllOnlineStatus.all(),

  // dms
  getConversations: (userId) => {
    return statements.getConversations.all(userId, userId, userId, userId, userId)
      .map((row) => ({ ...row, last_message: atRest.open(row.last_message) }));
  },

  getDirectMessages: (userId1, userId2) => {
    return statements.getDirectMessages.all(userId1, userId2, userId2, userId1)
      .map((row) => ({ ...row, message: atRest.open(row.message) }));
  },

  // the account keys of end to end encrypted direct messages
  getUserKey: (userId) => statements.getUserKey.get(userId) || null,
  createUserKey: (userId, key) => {
    const result = statements.createUserKey.run(userId, key.public_key, key.kid, key.wrapped_private, key.wrap_salt, key.wrap_iv, key.wrap_iters);
    return result.changes > 0;
  },
  userIdsWithKeys: () => statements.listUserKeyIds.all().map((row) => row.user_id),

  // ---- invites to rooms (kept a day)
  INVITE_TTL_SECONDS,
  createRoomInvite: (serverId, fromId, toId) => {
    const id = `invite_${crypto.randomUUID()}`;
    statements.upsertInvite.run(id, serverId, fromId, toId);
    return id;
  },
  getRoomInvites: (userId) => statements.getInvitesFor.all(userId, Math.floor(Date.now() / 1000) - INVITE_TTL_SECONDS)
    .map((row) => ({ ...row, is_private: row.is_private === 1 })),
  getRoomInvite: (inviteId) => statements.getInviteById.get(inviteId) || null,
  hasRoomInvite: (serverId, userId) => !!statements.hasInvite.get(serverId, userId, Math.floor(Date.now() / 1000) - INVITE_TTL_SECONDS),
  deleteRoomInvite: (inviteId) => statements.deleteInvite.run(inviteId).changes > 0,
  clearRoomInvites: (serverId, userId) => statements.clearInvitesFor.run(serverId, userId),
  purgeRoomInvites: () => statements.purgeInvites.run(Math.floor(Date.now() / 1000) - INVITE_TTL_SECONDS).changes,

  // ---- connected YouTube / Spotify accounts (the tokens are stored scrambled)
  getIntegration: (userId, provider) => {
    const row = statements.getIntegration.get(userId, provider);
    if (!row) return null;
    return { ...row, access_token: atRest.open(row.access_token), refresh_token: row.refresh_token ? atRest.open(row.refresh_token) : '' };
  },
  saveIntegration: (userId, provider, record) => {
    statements.saveIntegration.run(userId, provider, atRest.seal(String(record.access_token || '')), record.refresh_token ? atRest.seal(String(record.refresh_token)) : '', Math.floor(Number(record.expires_at) || 0), String(record.account_name || '').slice(0, 120));
  },
  deleteIntegration: (userId, provider) => statements.deleteIntegration.run(userId, provider).changes > 0,

  // ---- listening stats
  recordListening: (userId, track, startedAt, endedAt) => recordListening(userId, track, startedAt, endedAt),
  getListeningStats: (userId, options) => getListeningStats(userId, options),
  getListeningBoard: (userIds, options) => getListeningBoard(userIds, options),

  createDirectMessage: (senderId, senderUsername, receiverId, receiverUsername, message, senderThemeColor = null) => {
    const id = `dm_${crypto.randomUUID()}`;
    const themeColorJson = senderThemeColor ? JSON.stringify(senderThemeColor) : null;
    // what is stored is scrambled (an end to end envelope is stored as it is, it already is ciphertext)
    statements.createDirectMessage.run(id, senderId, senderUsername, receiverId, receiverUsername, atRest.seal(message), themeColorJson);
    return {
      id,
      sender_id: senderId,
      sender_username: senderUsername,
      receiver_id: receiverId,
      receiver_username: receiverUsername,
      message,
      sender_theme_color: senderThemeColor,
      created_at: Math.floor(Date.now() / 1000)
    };
  },

  // collab playlists
  createCollabPlaylist: (id, serverId, name, createdBy) => {
    statements.createCollabPlaylist.run(id, serverId, name, createdBy);
    return { id, server_id: serverId, name, created_by: createdBy, created_at: Math.floor(Date.now() / 1000) };
  },

  getCollabPlaylists: (serverId) => {
    return statements.getCollabPlaylists.all(serverId);
  },

  getCollabPlaylist: (playlistId, serverId) => {
    return statements.getCollabPlaylistById.get(playlistId, serverId);
  },

  updateCollabPlaylistName: (playlistId, serverId, newName) => {
    statements.updateCollabPlaylistName.run(newName, playlistId, serverId);
  },

  deleteCollabPlaylist: (playlistId, serverId) => {
    statements.deleteCollabPlaylist.run(playlistId, serverId);
  },

  deleteCollabPlaylistsByServer: (serverId) => {
    statements.deleteCollabPlaylistsByServer.run(serverId);
  },

  addTrackToCollabPlaylist: (id, playlistId, videoId, title, author, format, source, thumbnail, externalUrl, durationMs, addedBy) => {
    statements.addTrackToCollabPlaylist.run(id, playlistId, videoId, title, author, format, source, thumbnail, externalUrl, durationMs, addedBy);
    return { id, playlist_id: playlistId, video_id: videoId, title, author, format, source, thumbnail, external_url: externalUrl, duration_ms: durationMs, added_by: addedBy, added_at: Math.floor(Date.now() / 1000) };
  },

  getCollabPlaylistTracks: (playlistId) => {
    return statements.getCollabPlaylistTracks.all(playlistId);
  },

  removeTrackFromCollabPlaylist: (trackId, playlistId) => {
    statements.removeTrackFromCollabPlaylist.run(trackId, playlistId);
  },

  clearCollabPlaylist: (playlistId) => {
    statements.clearCollabPlaylist.run(playlistId);
  },

  // the tracks of a playlist in the order given (ids not listed keep their place after them)
  reorderCollabPlaylist: (playlistId, trackIds) => {
    const apply = db.transaction((ids) => {
      ids.forEach((trackId, index) => statements.setCollabTrackPosition.run(index, trackId, playlistId));
    });
    apply(trackIds);
  }
};
