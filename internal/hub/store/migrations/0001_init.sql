CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  cluster_info_json TEXT NOT NULL DEFAULT '{}',
  last_heartbeat TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  agent_token_hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS catalog_snapshots (
  cluster_id TEXT PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  json BLOB NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  time TIMESTAMP NOT NULL,
  user TEXT NOT NULL,
  cluster_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_events_cluster_time ON audit_events(cluster_id, time DESC);
