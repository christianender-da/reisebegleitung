/**
 * Reisebegleitung auf dem Server: Haltestellensuche, Verbindungssuche, Reisen speichern und mit Echtzeit auffrischen.
 *
 * Last für Transitous gering halten: /plan nur auf Nutzeranfrage, Fahrtverläufe (/trip) 60 s im Cache,
 * Live-Abfrage nur von 3 h vor Abfahrt bis 30 min nach Ankunft.
 */
import {
  createClient,
  journeyEnd,
  journeyPlannedStart,
  progress,
  refreshJourney,
  searchModes,
  TICKETS,
  transfers,
  TransitousError,
  type Journey,
  type Leg,
  type Progress,
  type StopHit,
  type Ticket,
  type Transfer,
  type TransitousClient,
} from '../core/index.ts';
import type { CacheLike, TripStore } from './store.ts';

export interface JourneyServiceOptions {
  store: TripStore;
  /** Pflicht laut Transitous: „<Anwendung>/<Version> (+<Kontakt>)“ */
  userAgent: string;
  /** andere MOTIS-Instanz (Standard: Transitous) */
  apiBase?: string;
  /** Standard: caches.default (Workers), sonst ohne Cache */
  cache?: CacheLike | null;
  /** für Tests */
  client?: TransitousClient;
}

export interface TripView {
  id: string;
  ticket: Ticket;
  dticket: boolean;
  journey: Journey;
  progress: Progress;
  transfers: Transfer[];
  refreshedAt: string | null;
  stale?: boolean;
}

export class JourneyError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function errorCode(e: unknown): string {
  return e instanceof JourneyError || e instanceof TransitousError ? e.code : 'unavailable';
}

const TRIP_FRESH_S = 60;
const TRIP_STALE_S = 7200;
const PLAN_TTL_S = 1800;
const VISIBLE_AFTER_ARRIVAL_MS = 2 * 3600_000;
const DELETE_AFTER_ARRIVAL_MS = 2 * 86400_000;
const LIVE_BEFORE_MS = 3 * 3600_000;
const LIVE_AFTER_MS = 30 * 60_000;
const STOP_ID = /^[\w.:,@+\-]{1,200}$/;

const nowIso = () => new Date().toISOString();

function randomId(bytes = 9) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function defaultCache(): CacheLike | null {
  const c = (globalThis as { caches?: { default?: CacheLike } }).caches;
  return c?.default ?? null;
}

export function parseTicket(v: unknown): Ticket | null {
  return typeof v === 'string' && (TICKETS as string[]).includes(v) ? (v as Ticket) : null;
}

export interface PlanQuery {
  from: string;
  to: string;
  /** Anzeigenamen wie gewählt (optional) */
  fromName?: string;
  toName?: string;
  time?: string;
  arriveBy: boolean;
  ticket: Ticket;
  dticket: boolean;
}

export function createJourneyService(opts: JourneyServiceOptions) {
  const client = opts.client ?? createClient({ userAgent: opts.userAgent, baseUrl: opts.apiBase });
  const cache = opts.cache === undefined ? defaultCache() : opts.cache;
  const store = opts.store;
  const key = (path: string) => new Request(`https://cache.internal/reisebegleitung/${path}`);
  // ohne Cache-API (z. B. Tests): Suchergebnisse im Speicher
  const memory = new Map<string, Journey[]>();

  async function cachedTrip(tripId: string): Promise<Leg[] | null> {
    if (!cache) return client.trip(tripId);
    const k = key(`trip/${encodeURIComponent(tripId)}`);
    const hit = await cache.match(k);
    const cached = hit ? ((await hit.json()) as { legs: Leg[] | null; fetchedAt: string }) : null;
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < TRIP_FRESH_S * 1000) return cached.legs;
    try {
      const legs = await client.trip(tripId);
      await cache.put(k, new Response(JSON.stringify({ legs, fetchedAt: nowIso() }), { headers: { 'Cache-Control': `max-age=${TRIP_STALE_S}` } }));
      return legs;
    } catch (e) {
      if (cached) return cached.legs;
      throw e;
    }
  }

  return {
    async searchStops(q: string): Promise<StopHit[]> {
      const text = q.trim().slice(0, 80);
      if (text.length < 2) return [];
      const k = key(`stops/${encodeURIComponent(text.toLowerCase())}`);
      const hit = cache ? await cache.match(k) : undefined;
      if (hit) return hit.json();
      const hits = await client.searchStops(text, 8);
      if (cache) await cache.put(k, new Response(JSON.stringify(hits), { headers: { 'Cache-Control': 'max-age=86400' } }));
      return hits;
    },

    /** Ergebnis 30 min gemerkt, damit „Übernehmen“ nur planId + Nummer schicken muss */
    async plan(q: PlanQuery): Promise<{ planId: string; journeys: Journey[] }> {
      if (!STOP_ID.test(q.from) || !STOP_ID.test(q.to)) throw new JourneyError('bad-request');
      let time: string | undefined;
      if (q.time) {
        const t = Date.parse(q.time);
        if (!Number.isFinite(t) || t < Date.now() - 86400_000 || t > Date.now() + 180 * 86400_000) throw new JourneyError('bad-request');
        time = new Date(t).toISOString();
      }
      const journeys = (
        await client.plan({ from: q.from, to: q.to, time, arriveBy: q.arriveBy, modes: searchModes({ ticket: q.ticket, hasDTicket: q.dticket }), results: 5 })
      )
        .filter((j) => j.legs.some((l) => l.kind === 'ride'))
        .map((j) => {
          const from = q.fromName?.trim().slice(0, 100);
          const to = q.toName?.trim().slice(0, 100);
          return from && to ? { ...j, title: { from, to } } : j;
        });
      const planId = randomId(12);
      if (cache) await cache.put(key(`plan/${planId}`), new Response(JSON.stringify(journeys), { headers: { 'Cache-Control': `max-age=${PLAN_TTL_S}` } }));
      else memory.set(planId, journeys);
      return { planId, journeys };
    },

    async createTrip(scope: string, owner: string, b: { planId?: unknown; index?: unknown; ticket?: unknown; dticket?: unknown }): Promise<string> {
      const ticket = parseTicket(b.ticket);
      if (!ticket || typeof b.planId !== 'string' || !/^[\w-]{8,40}$/.test(b.planId) || typeof b.index !== 'number') throw new JourneyError('bad-request');
      let journeys: Journey[] | undefined;
      if (cache) {
        const hit = await cache.match(key(`plan/${b.planId}`));
        journeys = hit ? ((await hit.json()) as Journey[]) : undefined;
      } else journeys = memory.get(b.planId);
      if (!journeys) throw new JourneyError('plan-expired');
      const j = journeys[b.index];
      if (!j) throw new JourneyError('bad-request');
      const dticket = ticket === 'dticket' || b.dticket === true;
      const id = randomId();
      const t = nowIso();
      await store.insert({
        id,
        scope,
        owner,
        ticket,
        dticket,
        plannedJourney: j,
        journey: j,
        departAt: journeyPlannedStart(j) ?? t,
        arriveAt: journeyEnd(j) ?? t,
        refreshedAt: t,
        createdAt: t,
      });
      await store.setPref(scope, 'dticket', dticket ? '1' : '0');
      return id;
    },

    async deleteTrip(scope: string, id: string) {
      await store.delete(scope, id);
    },

    async dticketDefault(scope: string): Promise<boolean> {
      return (await store.getPref(scope, 'dticket')) === '1';
    },

    /** Reisen (bis 2 h nach Ankunft) mit Live-Stand; Alte werden nach 2 Tagen gelöscht */
    async trips(scope: string): Promise<TripView[]> {
      const t = Date.now();
      await store.purge(new Date(t - DELETE_AFTER_ARRIVAL_MS).toISOString());
      const rows = await store.list(scope, new Date(t - VISIBLE_AFTER_ARRIVAL_MS).toISOString());
      return Promise.all(
        rows.map(async (r) => {
          let journey = r.journey;
          let refreshedAt = r.refreshedAt;
          let stale = false;
          const live = t >= Date.parse(r.departAt) - LIVE_BEFORE_MS && t <= Date.parse(r.arriveAt) + LIVE_AFTER_MS;
          if (live && (!refreshedAt || t - Date.parse(refreshedAt) >= TRIP_FRESH_S * 1000)) {
            const res = await refreshJourney(journey, cachedTrip);
            journey = res.journey;
            stale = res.failed.length > 0;
            refreshedAt = nowIso();
            await store.updateLive(r.id, journey, journeyEnd(journey) ?? r.arriveAt, refreshedAt);
          }
          return {
            id: r.id,
            ticket: r.ticket,
            dticket: r.dticket,
            journey,
            progress: progress(journey, t),
            transfers: transfers(journey),
            refreshedAt,
            stale: stale || undefined,
          };
        }),
      );
    },
  };
}

export type JourneyService = ReturnType<typeof createJourneyService>;
