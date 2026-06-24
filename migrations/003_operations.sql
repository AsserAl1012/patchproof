CREATE TABLE IF NOT EXISTS github_deliveries (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL DEFAULT '',
  repository TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_deliveries_received ON github_deliveries(received_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
