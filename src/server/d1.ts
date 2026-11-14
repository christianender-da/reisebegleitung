/** TripStore auf Cloudflare D1 (Schema: migrations/0001_journey.sql) */
import type { Journey, Ticket } from '../core/index.ts';
import type { TripRecord, TripStore } from './store.ts';

/** Nur die Teile von D1, die gebraucht werden (keine Abhängigkeit von @cloudflare/workers-types) */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface Row {
  id: string;
  scope: string;
  owner: string;
  ticket: string;
  dticket: number;
  planned_journey: string;
  journey: string;
  depart_at: string;
  arrive_at: string;
  refreshed_at: string | null;
  created_at: string;
}

function toRecord(r: Row): TripRecord {
  return {
    id: r.id,
    scope: r.scope,
    owner: r.owner,
    ticket: r.ticket as Ticket,
    dticket: r.dticket === 1,
    plannedJourney: JSON.parse(r.planned_journey) as Journey,
    journey: JSON.parse(r.journey) as Journey,
    departAt: r.depart_at,
    arriveAt: r.arrive_at,
    refreshedAt: r.refreshed_at,
    createdAt: r.created_at,
  };
}

export function d1Store(db: D1Like): TripStore {
  return {
    async list(scope, arrivingAfter) {
      const rows = await db
        .prepare('SELECT * FROM journey_trips WHERE scope = ? AND arrive_at >= ? ORDER BY depart_at')
        .bind(scope, arrivingAfter)
        .all<Row>();
      return rows.results.map(toRecord);
    },
    async insert(t) {
      await db
        .prepare(
          'INSERT INTO journey_trips (id, scope, owner, ticket, dticket, planned_journey, journey, depart_at, arrive_at, refreshed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(t.id, t.scope, t.owner, t.ticket, t.dticket ? 1 : 0, JSON.stringify(t.plannedJourney), JSON.stringify(t.journey), t.departAt, t.arriveAt, t.refreshedAt, t.createdAt)
        .run();
    },
    async updateLive(id, journey, arriveAt, refreshedAt) {
      await db.prepare('UPDATE journey_trips SET journey = ?, arrive_at = ?, refreshed_at = ? WHERE id = ?').bind(JSON.stringify(journey), arriveAt, refreshedAt, id).run();
    },
    async delete(scope, id) {
      await db.prepare('DELETE FROM journey_trips WHERE scope = ? AND id = ?').bind(scope, id).run();
    },
    async purge(arrivedBefore) {
      await db.prepare('DELETE FROM journey_trips WHERE arrive_at < ?').bind(arrivedBefore).run();
    },
    async getPref(scope, key) {
      const row = await db.prepare('SELECT value FROM journey_prefs WHERE scope = ? AND key = ?').bind(scope, key).first<{ value: string }>();
      return row?.value ?? null;
    },
    async setPref(scope, key, value) {
      await db
        .prepare('INSERT INTO journey_prefs (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value')
        .bind(scope, key, value)
        .run();
    },
  };
}
