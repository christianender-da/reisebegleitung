-- Anmeldung (ein Besitzer, Passkeys)
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,           -- Credential-ID (base64url)
  public_key TEXT NOT NULL,      -- base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,               -- JSON
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- Sitzungen: nur der SHA-256 des Cookie-Werts
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,            -- register | login
  expires_at TEXT NOT NULL
);

-- setup_code_hash, setup_code_expires, recovery_code_hash
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
