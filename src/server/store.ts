/**
 * Speicher für Reisen. Mitgeliefert: D1 (Cloudflare) – siehe d1.ts und migrations/0001_journey.sql.
 * „scope“ trennt unabhängige Reiselisten (z. B. je Dashboard-Widget; eigenständige App: „default“).
 */
import type { AlternativeOption, AlternativeReason, Boarding, Journey, Stop, Ticket } from '../core/index.ts';
import type { PushSubscriptionJSON } from './webpush.ts';

export interface TripRecord {
  id: string;
  scope: string;
  owner: string;
  ticket: Ticket;
  /** Deutschlandticket vorhanden */
  dticket: boolean;
  /** Verbindung wie gewählt */
  plannedJourney: Journey;
  /** Verbindung mit letztem Echtzeitstand */
  journey: Journey;
  /** geplante Abfahrt am Start (ISO, UTC) */
  departAt: string;
  /** erwartete Ankunft am Ziel (Echtzeit, sonst Plan) */
  arriveAt: string;
  refreshedAt: string | null;
  createdAt: string;
  /** Check-ins und als verpasst markierte Abschnitte */
  boarding: Boarding;
  /** gefundene Alternativen, solange die Reise so nicht klappt */
  alternatives: StoredAlternatives | null;
}

export interface StoredAlternatives {
  key: string;
  reason: AlternativeReason;
  keepLegs: number;
  origin: Stop;
  /** ab wann gesucht wurde */
  time: string;
  line?: string;
  bindingLifted: boolean;
  computedAt: string;
  options: AlternativeOption[];
  /** Suche fehlgeschlagen (wird später wiederholt) */
  error?: string;
}

export interface PushRecord extends PushSubscriptionJSON {
  scope: string;
  lang: string;
}

export interface TripStore {
  /** Reisen eines Bereichs, die nach `arrivingAfter` ankommen, nach Abfahrt sortiert */
  list(scope: string, arrivingAfter: string): Promise<TripRecord[]>;
  get(scope: string, id: string): Promise<TripRecord | null>;
  /** Reisen aller Bereiche, die vor `departBefore` abfahren und nach `arriveAfter` ankommen (für die Hintergrund-Aktualisierung) */
  listActive(departBefore: string, arriveAfter: string): Promise<TripRecord[]>;
  insert(trip: TripRecord): Promise<void>;
  setBoarding(id: string, boarding: Boarding): Promise<void>;
  setAlternatives(id: string, alternatives: StoredAlternatives | null): Promise<void>;
  addPush(p: PushRecord): Promise<void>;
  removePush(endpoint: string): Promise<void>;
  listPush(scope: string): Promise<PushRecord[]>;
  updateLive(id: string, journey: Journey, arriveAt: string, refreshedAt: string): Promise<void>;
  delete(scope: string, id: string): Promise<void>;
  /** Reisen löschen, die vor `arrivedBefore` angekommen sind */
  purge(arrivedBefore: string): Promise<void>;
  getPref(scope: string, key: string): Promise<string | null>;
  setPref(scope: string, key: string, value: string): Promise<void>;
}

/** Minimaler Cache (Cache-API, z. B. caches.default in Workers) */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
