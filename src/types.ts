/**
 * Datenmodell der Reisebegleitung – unabhängig von der Datenquelle.
 * Alle Zeitpunkte sind ISO-8601-Zeichenketten in UTC (z. B. „2026-11-14T21:20:00Z“).
 */

/** Verkehrsmittel (grob, für Anzeige und Ticketregeln) */
export type Mode =
  | 'highspeed' // ICE, TGV, Railjet …
  | 'longdistance' // IC/EC, Nachtzug-Abschnitte ohne eigene Kennung …
  | 'night' // Nachtzüge
  | 'regional' // RE/RB/IRE
  | 'suburban' // S-Bahn
  | 'subway' // U-Bahn
  | 'tram'
  | 'bus'
  | 'coach' // Fernbus
  | 'ferry'
  | 'other'
  | 'walk';

export interface Stop {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
}

/** Halt einer Fahrt mit Plan- und (falls vorhanden) Echtzeitdaten */
export interface Stopover {
  stop: Stop;
  plannedArrival?: string;
  /** Echtzeit/Prognose; fehlt, wenn keine Echtzeit vorliegt */
  arrival?: string;
  plannedDeparture?: string;
  departure?: string;
  plannedTrack?: string;
  track?: string;
  cancelled?: boolean;
}

export interface Leg {
  kind: 'ride' | 'walk';
  mode: Mode;
  /** Anzeigename, z. B. „ICE 597“, „RB68“, „S6“ */
  line?: string;
  /** Zugnummer, falls bekannt (ohne führende Nullen) */
  number?: string;
  headsign?: string;
  operator?: string;
  /** ID der Fahrt beim Datenanbieter (für Aktualisierung) */
  tripId?: string;
  from: Stopover;
  to: Stopover;
  /** Zwischenhalte (ohne from/to) */
  stopovers: Stopover[];
  cancelled: boolean;
  /** Echtzeitdaten vorhanden */
  realtime: boolean;
  /** Fußweg/Umstieg: Dauer in Minuten */
  walkMin?: number;
}

export interface Journey {
  legs: Leg[];
}

export interface StopHit {
  id: string;
  name: string;
  /** Ort/Region zur Unterscheidung gleichnamiger Halte */
  place?: string;
  modes: Mode[];
}
