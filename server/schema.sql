CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#E04E0E',
  root_path TEXT NOT NULL DEFAULT '',  -- user-defined project folder (local or network path)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  email TEXT DEFAULT '',
  avatar_color TEXT DEFAULT '#0B7268',
  api_key TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  current_version INTEGER DEFAULT 1,
  size_bytes INTEGER DEFAULT 0,
  checksum TEXT DEFAULT '',
  locked_by_id INTEGER DEFAULT NULL REFERENCES members(id) ON DELETE SET NULL,
  locked_at TIMESTAMP DEFAULT NULL,
  lock_reason TEXT DEFAULT '',
  lock_group_id TEXT DEFAULT NULL,   -- shared by files locked together (e.g. .fbx + .fbx.meta)
  last_synced_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  checksum TEXT NOT NULL,
  author_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  message TEXT DEFAULT '',
  storage_filename TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_id, version)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  file_path TEXT DEFAULT '',
  version INTEGER DEFAULT NULL,
  detail TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- In-flight resumable uploads. A row is created at /upload/init, advanced by each
-- /upload PATCH chunk, and removed at /complete or /abort (or GCed when stale).
-- The partial blob lives at {storage_root}/{project_id}/uploads/{id}.part until then.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,                 -- random hex token, also the .part filename stem
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  force INTEGER NOT NULL DEFAULT 0,
  message TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings VALUES ('server_version', '0.1.0');
INSERT OR IGNORE INTO settings VALUES ('storage_root', './storage');
INSERT OR IGNORE INTO settings VALUES ('max_file_size_mb', '2048');
INSERT OR IGNORE INTO settings VALUES ('auto_unlock_hours', '24');
INSERT OR IGNORE INTO settings VALUES ('upload_session_ttl_hours', '24');

CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_locked ON files(locked_by_id);
CREATE INDEX IF NOT EXISTS idx_versions_file ON versions(file_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_updated ON upload_sessions(updated_at);
