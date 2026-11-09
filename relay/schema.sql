CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  credential_digest TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('apns','fcm')),
  token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  last_sent INTEGER NOT NULL DEFAULT 0
);
/* A registration expires once neither its token nor a send has touched it for a week. */
CREATE INDEX IF NOT EXISTS devices_activity ON devices(MAX(updated, last_sent));
/* Registrations per network (a SHA-256 digest of the IPv4 address or IPv6 /64) in the current
   hour; `period` is the Unix hour. */
CREATE TABLE IF NOT EXISTS enrollment_limits (
  network TEXT PRIMARY KEY,
  period INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
