CREATE TABLE IF NOT EXISTS login_attempts (
  key       TEXT PRIMARY KEY,
  count     INT NOT NULL DEFAULT 1,
  blocked_until TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_expires ON login_attempts (expires_at);
