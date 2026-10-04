-- Multi-user RBAC: Kubernetes identity mapping on users, and per-cluster grants.

ALTER TABLE users ADD COLUMN k8s_user TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN k8s_groups TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN updated_at TIMESTAMP NULL;

-- One row per (user, cluster). namespaces is a JSON array; empty/NULL = all namespaces.
CREATE TABLE IF NOT EXISTS cluster_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',
  namespaces TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL,
  UNIQUE (user_id, cluster_id)
);
CREATE INDEX IF NOT EXISTS cluster_grants_user ON cluster_grants(user_id);
