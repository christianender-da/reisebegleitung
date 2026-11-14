/**
 * Speicher für Reisen. Mitgeliefert: D1 (Cloudflare) – siehe d1.ts und migrations/0001_journey.sql.
 * „scope“ trennt unabhängige Reiselisten (z. B. je Dashboard-Widget; eigenständige App: „default“).
 */
import type { Journey, Ticket } from '../core/index.ts';

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
}

export interface TripStore {
  /** Reisen eines Bereichs, die nach `arrivingAfter` ankommen, nach Abfahrt sortiert */
  list(scope: string, arrivingAfter: string): Promise<TripRecord[]>;
  insert(trip: TripRecord): Promise<void>;
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
