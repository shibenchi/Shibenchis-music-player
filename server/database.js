const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// tauri sets APP_DATA_DIR to a proper per-user writable spot
// (AppData\Roaming\<id>) once its installed — program files, where the app
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

// turn on foreign keys
db.pragma('foreign_keys = ON');

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

// make shibenchi (me lol) admin if that account already exists
try {
  db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run('shibenchi');
} catch (err) {
  // account doesnt exist yet, itll get set on first creation instead
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
  ['server_messages', 'sender_theme_color', 'TEXT DEFAULT NULL']
];

columnMigrations.forEach(([table, column, definition]) => {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (err) {
    // already exists, whatever, moving on
  }
});

// fixing busted foreign keys on server_queue / server_player_state — the
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
  // table doesnt exist yet, or this migration already ran — either way we're fine
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
  // table doesnt exist yet, or this migration already ran — either way we're fine
}

const statements = {
  // user stuff
  createUser: db.prepare(`
    INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)
  `),
  getUserByUsername: db.prepare(`
    SELECT * FROM users WHERE username = ?
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
    INSERT INTO user_settings (user_id, theme_color_r, theme_color_g, theme_color_b, debug_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET
      theme_color_r = excluded.theme_color_r,
      theme_color_g = excluded.theme_color_g,
      theme_color_b = excluded.theme_color_b,
      debug_mode = excluded.debug_mode,
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
    SELECT * FROM collab_playlist_tracks WHERE playlist_id = ? ORDER BY added_at
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

  // server chat history
  createServerMessage: db.prepare(`
    INSERT INTO server_messages (id, server_id, user_id, username, message, sender_theme_color)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getServerMessages: db.prepare(`
    SELECT * FROM server_messages WHERE server_id = ? ORDER BY created_at DESC LIMIT ?
  `),

  // active servers
  createActiveServer: db.prepare(`
    INSERT INTO active_servers (id, name, host_id, host_username, ws_port)
    VALUES (?, ?, ?, ?, ?)
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
  // reusing the shared ones — more reliable this way
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

module.exports = {
  db,
  statements,
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
    const isAdmin = username === 'shibenchi' ? 1 : 0;

    // stick the user in with their admin flag
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(
      id, username, passwordHash, isAdmin
    );

    // give em default settings so they've got something to start with
    statements.upsertSettings.run(id, 255, 89, 0, 0);

    return { id, username, is_admin: isAdmin === 1 };
  },

  authenticateUser: (username, password) => {
    const user = statements.getUserByUsername.get(username);
    if (!user) return null;

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
    // kill any existing session for this user first — only one at a time allowed
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
      debug_mode: 0
    };
  },

  saveSettings: (userId, settings) => {
    statements.upsertSettings.run(
      userId,
      settings.theme_color_r,
      settings.theme_color_g,
      settings.theme_color_b,
      settings.debug_mode ? 1 : 0
    );
  },

  // friend requests
  createFriendRequest: (senderId, receiverId) => {
    // already friends? bail, dont need a request for that
    const existingFriend = statements.isFriend.get(senderId, receiverId);
    if (existingFriend) {
      return { error: 'already_friends' };
    }

    // request already out there in either direction? dont send a dupe
    const existingRequest = statements.getFriendRequestByUsers.get(senderId, receiverId)
      || statements.getFriendRequestByUsers.get(receiverId, senderId);
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
        const playlistId = String(playlist.id || `playlist_${crypto.randomUUID()}`).trim();
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

  // server chat history
  createServerMessage: (serverId, userId, username, message, senderThemeColor = null) => {
    const id = createServerMessageId();
    const trimmedMessage = String(message || '').trim();
    const themeColorJson = senderThemeColor ? JSON.stringify(senderThemeColor) : null;

    statements.createServerMessage.run(id, serverId, userId, username, trimmedMessage, themeColorJson);
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
    return statements.getServerMessages.all(serverId, limit).reverse();
  },

  // active servers
  createActiveServer: (name, hostId, hostUsername, wsPort) => {
    const id = createServerId();
    statements.createActiveServer.run(id, name, hostId, hostUsername, wsPort);
    // host gets added as admin automatically, makes sense they'd own their own server
    const memberId = createServerMemberId();
    statements.addServerMember.run(memberId, id, hostId, hostUsername, 1);
    return { id, name, host_id: hostId, host_username: hostUsername, ws_port: wsPort };
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

  // dms
  getConversations: (userId) => {
    return statements.getConversations.all(userId, userId, userId, userId, userId);
  },

  getDirectMessages: (userId1, userId2) => {
    return statements.getDirectMessages.all(userId1, userId2, userId2, userId1);
  },

  createDirectMessage: (senderId, senderUsername, receiverId, receiverUsername, message, senderThemeColor = null) => {
    const id = `dm_${crypto.randomUUID()}`;
    const themeColorJson = senderThemeColor ? JSON.stringify(senderThemeColor) : null;
    statements.createDirectMessage.run(id, senderId, senderUsername, receiverId, receiverUsername, message, themeColorJson);
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
  }
};
