/** TripStore auf Cloudflare D1 (Schema: migrations/0001_journey.sql) */
import { emptyBoarding, type Boarding, type Journey, type Ticket } from '../core/index.ts';
import type { PushRecord, ShareRecord, StoredAlternatives, TripRecord, TripStore } from './store.ts';

interface ShareRow {
  id: string;
  token_hash: string;
  trip_id: string;
  scope: string;
  label: string;
  shared_by: string | null;
  created_at: string;
}

const toShare = (r: ShareRow): ShareRecord => ({ id: r.id, tokenHash: r.token_hash, tripId: r.trip_id, scope: r.scope, label: r.label, sharedBy: r.shared_by, createdAt: r.created_at });

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
  boarding: string | null;
  alternatives: string | null;
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function parseBoarding(s: string | null): Boarding {
  try {
    const b = s ? (JSON.parse(s) as Partial<Boarding>) : {};
    return { checkins: Array.isArray(b.checkins) ? b.checkins : [], missed: Array.isArray(b.missed) ? b.missed : [] };
  } catch {
    return emptyBoarding();
  }
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
    boarding: parseBoarding(r.boarding),
    alternatives: parseJson<StoredAlternatives>(r.alternatives),
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
    async get(scope, id) {
      const r = await db.prepare('SELECT * FROM journey_trips WHERE scope = ? AND id = ?').bind(scope, id).first<Row>();
      return r ? toRecord(r) : null;
    },
    async listActive(departBefore, arriveAfter) {
      const rows = await db.prepare('SELECT * FROM journey_trips WHERE depart_at <= ? AND arrive_at >= ? ORDER BY depart_at LIMIT 50').bind(departBefore, arriveAfter).all<Row>();
      return rows.results.map(toRecord);
    },
    async insert(t) {
      await db
        .prepare(
          'INSERT INTO journey_trips (id, scope, owner, ticket, dticket, planned_journey, journey, depart_at, arrive_at, refreshed_at, created_at, boarding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          t.id,
          t.scope,
          t.owner,
          t.ticket,
          t.dticket ? 1 : 0,
          JSON.stringify(t.plannedJourney),
          JSON.stringify(t.journey),
          t.departAt,
          t.arriveAt,
          t.refreshedAt,
          t.createdAt,
          JSON.stringify(t.boarding),
        )
        .run();
    },
    async setBoarding(id, boarding) {
      await db.prepare('UPDATE journey_trips SET boarding = ? WHERE id = ?').bind(JSON.stringify(boarding), id).run();
    },
    async setAlternatives(id, alternatives) {
      await db.prepare('UPDATE journey_trips SET alternatives = ? WHERE id = ?').bind(alternatives ? JSON.stringify(alternatives) : null, id).run();
    },
    async addShare(s) {
      await db
        .prepare('INSERT INTO journey_shares (id, token_hash, trip_id, scope, label, shared_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(s.id, s.tokenHash, s.tripId, s.scope, s.label, s.sharedBy, s.createdAt)
        .run();
    },
    async getShare(tokenHash) {
      const r = await db.prepare('SELECT * FROM journey_shares WHERE token_hash = ?').bind(tokenHash).first<ShareRow>();
      return r ? toShare(r) : null;
    },
    async listShares(scope, tripId) {
      const rows = await db.prepare('SELECT * FROM journey_shares WHERE scope = ? AND trip_id = ? ORDER BY created_at').bind(scope, tripId).all<ShareRow>();
      return rows.results.map(toShare);
    },
    async deleteShare(scope, id) {
      await db.prepare('DELETE FROM journey_shares WHERE scope = ? AND id = ?').bind(scope, id).run();
    },
    async addPush(p) {
      await db
        .prepare(
          'INSERT INTO journey_push (endpoint, scope, p256dh, auth, lang, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET scope = excluded.scope, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang',
        )
        .bind(p.endpoint, p.scope, p.keys.p256dh, p.keys.auth, p.lang, new Date().toISOString())
        .run();
    },
    async removePush(endpoint) {
      await db.prepare('DELETE FROM journey_push WHERE endpoint = ?').bind(endpoint).run();
    },
    async listPush(scope) {
      const rows = await db
        .prepare('SELECT endpoint, scope, p256dh, auth, lang FROM journey_push WHERE scope = ?')
        .bind(scope)
        .all<{ endpoint: string; scope: string; p256dh: string; auth: string; lang: string }>();
      return rows.results.map((r): PushRecord => ({ endpoint: r.endpoint, scope: r.scope, lang: r.lang, keys: { p256dh: r.p256dh, auth: r.auth } }));
    },
    async updateLive(id, journey, arriveAt, refreshedAt) {
      await db.prepare('UPDATE journey_trips SET journey = ?, arrive_at = ?, refreshed_at = ? WHERE id = ?').bind(JSON.stringify(journey), arriveAt, refreshedAt, id).run();
    },
    async delete(scope, id) {
      await db.batch([
        db.prepare('DELETE FROM journey_shares WHERE scope = ? AND trip_id = ?').bind(scope, id),
        db.prepare('DELETE FROM journey_trips WHERE scope = ? AND id = ?').bind(scope, id),
      ]);
    },
    async purge(arrivedBefore) {
      await db.batch([
        db.prepare('DELETE FROM journey_trips WHERE arrive_at < ?').bind(arrivedBefore),
        db.prepare('DELETE FROM journey_shares WHERE trip_id NOT IN (SELECT id FROM journey_trips)'),
      ]);
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
