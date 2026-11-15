-- reisebegleitung 0.5: Teilen-Links (nur der SHA-256 des Tokens; gültig bis 2 h nach der Ankunft der Reise)
CREATE TABLE IF NOT EXISTS journey_shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  trip_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',   -- für wen (nur für den Besitzer sichtbar)
  shared_by TEXT,                   -- Anzeigename des Teilenden
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journey_shares_trip ON journey_shares(scope, trip_id);
