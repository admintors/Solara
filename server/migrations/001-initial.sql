CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  favorites_version INTEGER NOT NULL DEFAULT 1 CHECK (favorites_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite','password_reset')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((purpose = 'invite' AND user_id IS NULL) OR (purpose = 'password_reset' AND user_id IS NOT NULL))
);
CREATE INDEX auth_tokens_purpose_expiry_idx ON auth_tokens(purpose, expires_at);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('queue','custom')),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, user_id)
);
CREATE UNIQUE INDEX playlists_one_queue_per_user ON playlists(user_id) WHERE kind = 'queue';
CREATE UNIQUE INDEX playlists_custom_name_per_user ON playlists(user_id, name) WHERE kind = 'custom';
CREATE INDEX playlists_owner_idx ON playlists(user_id, kind, created_at);

CREATE TABLE playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  track_id TEXT NOT NULL,
  song_json TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE(playlist_id, source, track_id),
  UNIQUE(playlist_id, position),
  FOREIGN KEY(playlist_id, user_id) REFERENCES playlists(id, user_id) ON DELETE CASCADE
);
CREATE INDEX playlist_items_owner_order_idx ON playlist_items(user_id, playlist_id, position);

CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  track_id TEXT NOT NULL,
  song_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, source, track_id)
);
CREATE INDEX favorites_page_idx ON favorites(user_id, created_at DESC, source, track_id);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL
);

CREATE TABLE playback_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, device_id)
);
CREATE INDEX playback_states_recent_idx ON playback_states(user_id, updated_at DESC);

CREATE TABLE data_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, source_type, source_digest)
);
CREATE INDEX data_imports_owner_idx ON data_imports(user_id, created_at DESC);

CREATE TABLE import_unresolved (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES data_imports(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raw_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX import_unresolved_owner_idx ON import_unresolved(user_id, import_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_id TEXT,
  action TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);

CREATE TRIGGER protect_last_active_admin
BEFORE UPDATE OF role, status ON users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
  AND (NEW.role != 'admin' OR NEW.status != 'active')
  AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ACTIVE_ADMIN');
END;

CREATE TRIGGER protect_last_active_admin_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
  AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') <= 1
BEGIN
  SELECT RAISE(ABORT, 'LAST_ACTIVE_ADMIN');
END;
