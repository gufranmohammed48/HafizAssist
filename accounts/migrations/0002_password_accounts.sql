-- Additive only: existing Google users, sessions, and checkpoints are unchanged.
-- Local identity IDs use local:<random UUID>; Google subject IDs stay unchanged.
CREATE TABLE recite_password_accounts (
  user_id TEXT PRIMARY KEY REFERENCES recite_users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE BINARY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations = 100000),
  recovery_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- HMAC identifiers avoid storing raw IP addresses or attempted usernames.
-- The compound key and atomic UPSERT make concurrent requests share a quota.
CREATE TABLE recite_auth_limits (
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, window_start)
);
CREATE INDEX recite_auth_limits_expiry ON recite_auth_limits(expires_at);
