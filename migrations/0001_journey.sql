-- reisebegleitung: Reisen und Einstellungen (D1/SQLite)

CREATE TABLE IF NOT EXISTS journey_trips (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                  -- getrennte Reiselisten (z. B. je Widget; eigenständig: 'default')
  owner TEXT NOT NULL,
  ticket TEXT NOT NULL,                 -- flex | spar | bc100 | dticket | other
  dticket INTEGER NOT NULL DEFAULT 0,   -- Deutschlandticket vorhanden
  planned_journey TEXT NOT NULL,        -- JSON wie gewählt
  journey TEXT NOT NULL,                -- JSON mit letztem Echtzeitstand
  depart_at TEXT NOT NULL,              -- geplante Abfahrt (UTC, ISO)
  arrive_at TEXT NOT NULL,              -- erwartete Ankunft (Echtzeit, sonst Plan)
  refreshed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journey_trips_scope ON journey_trips(scope, depart_at);

CREATE TABLE IF NOT EXISTS journey_prefs (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
