-- reisebegleitung 0.4: Alternativen bei geplatzten Anschlüssen, Web-Push-Abos
ALTER TABLE journey_trips ADD COLUMN alternatives TEXT;

CREATE TABLE IF NOT EXISTS journey_push (
  endpoint TEXT PRIMARY KEY,   -- Push-Dienst-URL des Geräts
  scope TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'de',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journey_push_scope ON journey_push(scope);
