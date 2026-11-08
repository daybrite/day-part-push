CREATE TABLE IF NOT EXISTS enrollments (
  digest TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
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
CREATE INDEX IF NOT EXISTS devices_updated ON devices(updated);
