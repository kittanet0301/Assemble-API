-- Assemble's Node API connects through DATABASE_URL. The browser does not use
-- Supabase Data API for these tables, and the `assemble` schema should stay
-- out of the project's exposed API schemas.

CREATE SCHEMA IF NOT EXISTS assemble;
REVOKE ALL ON SCHEMA assemble FROM PUBLIC;
REVOKE ALL ON SCHEMA assemble FROM anon, authenticated;
GRANT USAGE ON SCHEMA assemble TO postgres;

CREATE TABLE IF NOT EXISTS assemble.members (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  avatar TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  seat TEXT UNIQUE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  appearance TEXT
);

CREATE TABLE IF NOT EXISTS assemble.invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES assemble.members(id),
  expires_at BIGINT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS assemble.sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT REFERENCES assemble.members(id),
  guest_name TEXT,
  guest_id TEXT,
  invite_id TEXT REFERENCES assemble.invites(id),
  expires_at BIGINT NOT NULL,
  appearance TEXT
);

CREATE TABLE IF NOT EXISTS assemble.messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  appearance TEXT
);

CREATE INDEX IF NOT EXISTS messages_channel_time
  ON assemble.messages(channel, created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry
  ON assemble.sessions(expires_at);

ALTER TABLE assemble.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE assemble.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE assemble.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assemble.messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA assemble FROM PUBLIC, anon, authenticated;
