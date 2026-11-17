/**
 * Reisebegleitung auf dem Server: Haltestellensuche, Verbindungssuche, Reisen speichern und mit Echtzeit auffrischen,
 * bei geplatzten Anschlüssen Alternativen suchen und per Web Push melden.
 *
 * Last für Transitous gering halten: /plan nur auf Nutzeranfrage bzw. bei einem neuen Auslöser (danach höchstens alle
 * 10 min erneut), Fahrtverläufe (/trip) 60 s im Cache, Live-Abfrage nur von 3 h vor Abfahrt bis 30 min nach Ankunft.
 */
import {
  lineName,
  alternativesTrigger,
  applyBoarding,
  bindingLifted,
  changeWindow,
  demoManualJourneys,
  DEMO_KEEP_LEGS,
  DEMO_SCENES,
  isReplaced,
  sharedPrefix,
  DEMO_STOP,
  demoAlternativeJourneys,
  demoJourney,
  demoScene,
  isDemoJourney,
  isDemoStop,
  matchesDemo,
  liftedFor,
  rateAlternative,
  replaceRemainder,
  createClient,
  emptyBoarding,
  journeyEnd,
  journeyPlannedStart,
  progress,
  refreshJourney,
  searchModes,
  TICKETS,
  transfers,
  TransitousError,
  type Boarding,
  type Journey,
  type Leg,
  type Progress,
  type StopHit,
  type Ticket,
  type Transfer,
  type TransitousClient,
} from '../core/index.ts';
import type { CacheLike, StoredAlternatives, TripRecord, TripStore } from './store.ts';
import { parseVapidJwk, sendPush, validSubscription, vapidPublicKey, type VapidConfig } from './webpush.ts';
import { carryIrisTracks, createIris, type Iris } from './iris.ts';

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
  /** Web Push: privater VAPID-Schlüssel (JWK als JSON, z. B. Secret) + Kontakt (mailto:/https:) – ohne: keine Benachrichtigungen */
  push?: { privateJwk: string | undefined; subject: string } | null;
  /** Ziel beim Antippen der Benachrichtigung (Standard „/“) */
  notifyUrl?: (scope: string) => string;
  /** für Tests: Versand ersetzen */
  sendPush?: typeof sendPush;
  /** fehlende Zuggleise aus DB IRIS ergänzen (inoffiziell, ohne Key) – Standard aus */
  irisPlatforms?: boolean;
  /** andere IRIS-Adresse (z. B. lokale Weiterleitung) */
  irisBase?: string;
  /** für Tests: IRIS ersetzen */
  iris?: Iris;
}

export interface TripView {
  id: string;
  ticket: Ticket;
  dticket: boolean;
  journey: Journey;
  boarding: Boarding;
  alternatives: StoredAlternatives | null;
  progress: Progress;
  transfers: Transfer[];
  refreshedAt: string | null;
  stale?: boolean;
  /** eine Alternative wurde übernommen – „Zurück zur ursprünglichen Verbindung“ möglich */
  replaced?: boolean;
  /** ab diesem Abschnitt weicht die Reise von der ursprünglichen ab (nach „Übernehmen“) */
  replacedFrom?: number;
  /** Testfahrt ab der Testhaltestelle: aktuelle Szene (wechselt jede Minute) */
  demo?: { scene: number; scenes: number; key: string; next: string };
}

export type BoardingAction = 'checkin' | 'missed' | 'undo';

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
/** mehr als 30 min vor Abfahrt nur alle 5 min auffrischen */
const EARLY_MS = 30 * 60_000;
const EARLY_REFRESH_MS = 5 * 60_000;
/** gleicher Auslöser: Alternativen höchstens so oft neu suchen */
const ALT_REFRESH_MS = 10 * 60_000;
const ALT_RESULTS = 4;
const MAX_REFRESH_PER_RUN = 3;
/** selbst gesuchte Alternativen so lange nach der Abfahrt des geplanten Anschlusses noch zeigen */
const MANUAL_KEEP_MS = 10 * 60_000;
/** Teilen-Links gelten bis so lange nach der (Echtzeit-)Ankunft */
export const SHARE_AFTER_ARRIVAL_MS = 2 * 3600_000;
const MAX_SHARES_PER_TRIP = 10;

export interface ShareInfo {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

/** Was Empfänger eines Teilen-Links sehen: wie TripView, aber ohne Ticketangaben */
export type SharedTripView = Omit<TripView, 'ticket' | 'dticket'> & { ticket?: undefined; dticket?: undefined };

export type SharedResult =
  | { status: 'ok'; trip: SharedTripView; expiresAt: string; sharedBy: string | null; avatar?: string | null }
  | { status: 'expired' }
  | { status: 'not-found' };

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Foto/Avatar: im Browser auf 256 px verkleinert (siehe ui/avatar.ts); Obergrenze als Schutz */
export const AVATAR_MAX_BYTES = 200_000;

export interface Avatar {
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
  /** ändert sich mit dem Bild (für Cache-Adressen ?v=…) */
  version: string;
}

/** data:-URL prüfen und dekodieren – nur JPEG/PNG/WebP, Dateityp anhand der ersten Bytes */
export function parseAvatar(dataUrl: unknown): Omit<Avatar, 'version'> | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > AVATAR_MAX_BYTES * 1.4 + 64) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 12 || bytes.length > AVATAR_MAX_BYTES) return null;
  const b = (i: number, ...v: number[]) => v.every((x, k) => bytes[i + k] === x);
  const type = m[1] as Avatar['type'];
  const ok =
    type === 'image/jpeg' ? b(0, 0xff, 0xd8, 0xff) : type === 'image/png' ? b(0, 0x89, 0x50, 0x4e, 0x47) : b(0, 0x52, 0x49, 0x46, 0x46) && b(8, 0x57, 0x45, 0x42, 0x50);
  return ok ? { type, bytes } : null;
}

const shareExpiry = (arriveAt: string) => new Date(Date.parse(arriveAt) + SHARE_AFTER_ARRIVAL_MS).toISOString();

/** Ist ein Live-Abgleich fällig? (3 h vor Abfahrt bis 30 min nach Ankunft; vor Abfahrt seltener) */
export function refreshDue(r: Pick<TripRecord, 'departAt' | 'arriveAt' | 'refreshedAt'>, t: number): boolean {
  const dep = Date.parse(r.departAt);
  if (t < dep - LIVE_BEFORE_MS || t > Date.parse(r.arriveAt) + LIVE_AFTER_MS) return false;
  if (!r.refreshedAt) return true;
  const age = t - Date.parse(r.refreshedAt);
  return age >= (t < dep - EARLY_MS ? EARLY_REFRESH_MS : TRIP_FRESH_S * 1000);
}
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
  const vapidJwk = parseVapidJwk(opts.push?.privateJwk);
  const vapid: VapidConfig | null = vapidJwk && opts.push ? { privateJwk: vapidJwk, subject: opts.push.subject } : null;
  const push = opts.sendPush ?? sendPush;
  const iris: Iris | null = opts.iris ?? (opts.irisPlatforms ? createIris({ userAgent: opts.userAgent, cache, base: opts.irisBase }) : null);
  const withTracks = async (j: Journey) => (iris ? iris.enrich(j).catch(() => j) : j);

  /** Alternativen pflegen: neu suchen bei neuem Auslöser (und alle 10 min), löschen, wenn alles wieder passt */
  async function maintainAlternatives(r: TripRecord, t: number): Promise<TripRecord> {
    // selbst gesuchte Alternativen bleiben bis kurz nach der geplanten Abfahrt des Anschlusses stehen (keine automatische Suche, kein Push)
    if (r.alternatives?.reason === 'manual' && t < Date.parse(r.alternatives.until ?? r.alternatives.time) + MANUAL_KEEP_MS) return r;
    const trigger = alternativesTrigger(r.journey, r.boarding, t);
    if (!trigger) {
      if (r.alternatives) await store.setAlternatives(r.id, null);
      return r.alternatives ? { ...r, alternatives: null } : r;
    }
    const prev = r.alternatives;
    if (prev && prev.key === trigger.key && t - Date.parse(prev.computedAt) < ALT_REFRESH_MS) return r;
    const ctx = { ticket: r.ticket, hasDTicket: r.dticket };
    const lifted = liftedFor(r.journey, trigger);
    const bookedTripIds = r.plannedJourney.legs.flatMap((l) => (l.tripId ? [l.tripId] : []));
    const dest = r.journey.legs.at(-1)!.to.stop;
    const alt: StoredAlternatives = { key: trigger.key, reason: trigger.reason, keepLegs: trigger.keepLegs, origin: trigger.origin, time: trigger.time, line: trigger.line, mode: trigger.mode, bindingLifted: lifted, computedAt: nowIso(), options: [] };
    try {
      const found = await client.plan({ from: trigger.origin.id, to: dest.id, time: trigger.time, modes: searchModes(ctx), results: ALT_RESULTS + 2 });
      alt.options = found
        .filter((j) => j.legs.some((l) => l.kind === 'ride'))
        .map((j) => rateAlternative(j, ctx, { bindingLifted: lifted, bookedTripIds }))
        // zuerst mit dem Ticket nutzbare, dann nach Ankunft
        .sort((a, b) => Number(b.covered) - Number(a.covered) || Date.parse(journeyEnd(a.journey) ?? '') - Date.parse(journeyEnd(b.journey) ?? ''))
        .slice(0, ALT_RESULTS);
    } catch (e) {
      alt.error = errorCode(e);
      alt.options = prev?.key === trigger.key ? prev.options : [];
    }
    await store.setAlternatives(r.id, alt);
    const next = { ...r, alternatives: alt };
    if (!prev || prev.key !== trigger.key) await notify(next);
    return next;
  }

  /** Benachrichtigung an alle Geräte des Bereichs */
  async function notify(r: TripRecord) {
    if (!vapid || !r.alternatives) return;
    const subs = await store.listPush(r.scope);
    await Promise.all(
      subs.map(async (s) => {
        const res = await push(s, { ...pushMessage(r, s.lang === 'en' ? 'en' : 'de'), url: opts.notifyUrl?.(r.scope) ?? '/', tag: `trip-${r.id}` }, vapid, { topic: `trip${r.id}` });
        if (res === 'gone') await store.removePush(s.endpoint);
      }),
    );
  }

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

  async function refresh(r: TripRecord): Promise<{ record: TripRecord; stale: boolean }> {
    const res = await refreshJourney(r.journey, cachedTrip);
    res.journey = await withTracks(carryIrisTracks(r.journey, res.journey));
    const refreshedAt = nowIso();
    const arriveAt = journeyEnd(res.journey) ?? r.arriveAt;
    await store.updateLive(r.id, res.journey, arriveAt, refreshedAt);
    const record = await maintainAlternatives({ ...r, journey: res.journey, arriveAt, refreshedAt }, Date.now());
    return { record, stale: res.failed.length > 0 };
  }

  /**
   * Testfahrt: Uhrzeiten so verschoben, dass „jetzt“ in der aktuellen Szene liegt; Alternativen fest vorgegeben.
   * Check-ins und eine übernommene Alternative gelten für die laufende Runde (9 Szenen); mit Szene 1 beginnt alles neu.
   */
  /** Testfahrt: gewählte Alternative (Index in der sortierten Liste) als Einstellung je Reise */
  const demoChoiceKey = (id: string) => `demo-alt:${id}`;
  const demoManualKey = (id: string) => `demo-manual:${id}`;

  async function demoRecord(r: TripRecord, t: number): Promise<{ record: TripRecord; demo: NonNullable<TripView['demo']>; replaced: boolean; replacedFrom?: number }> {
    const sc = demoScene(t, Date.parse(r.createdAt) || 0);
    const original = demoJourney(sc.start);
    const boarding = { checkins: r.boarding.checkins.filter((e) => Date.parse(e.at) >= sc.round), missed: r.boarding.missed.filter((e) => Date.parse(e.at) >= sc.round) };
    const ctx = { ticket: r.ticket, hasDTicket: r.dticket };
    // Anschluss an den IC ist nie zu schaffen: Zugbindung aufgehoben, Alternativen ab der Demo-Messe
    const options = demoAlternativeJourneys(sc.start)
      .map((j) => rateAlternative(j, ctx, { bindingLifted: true, bookedTripIds: [] }))
      .sort((a, b) => Number(b.covered) - Number(a.covered) || Date.parse(journeyEnd(a.journey) ?? '') - Date.parse(journeyEnd(b.journey) ?? ''));
    const rate = (js: Journey[], lifted: boolean) =>
      js
        .map((j) => rateAlternative(j, ctx, { bindingLifted: lifted, bookedTripIds: [] }))
        .sort((a, b) => Number(b.covered) - Number(a.covered) || Date.parse(journeyEnd(a.journey) ?? '') - Date.parse(journeyEnd(b.journey) ?? ''));
    // Wahl gespeichert als „<Index>@<Zeitpunkt>“ bzw. „<Index>@<Zeitpunkt>@<bleibende Abschnitte>“ (selbst gesucht)
    const [idx, when, keepRaw] = ((await store.getPref(r.scope, demoChoiceKey(r.id))) ?? '').split('@');
    const keep = Number(keepRaw) || DEMO_KEEP_LEGS;
    const chosenFrom = keepRaw ? rate(demoManualJourneys(sc.start, keep), false) : options;
    const chosen = idx && Date.parse(when) >= sc.round ? chosenFrom[Number(idx)] : undefined;
    const journey = chosen ? replaceRemainder(original, boarding, keep, chosen.journey).journey : original;
    const trigger = alternativesTrigger(journey, boarding, t);
    let alternatives: StoredAlternatives | null = trigger
      ? { key: trigger.key, reason: trigger.reason, keepLegs: trigger.keepLegs, origin: trigger.origin, time: trigger.time, line: trigger.line, mode: trigger.mode, bindingLifted: liftedFor(journey, trigger), computedAt: new Date(t).toISOString(), options }
      : null;
    // „Alternativen anzeigen“ (selbst gesucht) in dieser Runde – solange das Umstiegsfenster offen ist
    const manualAt = Date.parse((await store.getPref(r.scope, demoManualKey(r.id))) ?? '');
    const w = !chosen && manualAt >= sc.round ? changeWindow(journey, boarding, t) : null;
    if (w) {
      alternatives = {
        key: w.key,
        reason: 'manual',
        keepLegs: w.keepLegs,
        origin: w.origin,
        time: w.time,
        until: w.until,
        bindingLifted: false,
        computedAt: new Date(t).toISOString(),
        options: rate(demoManualJourneys(sc.start, w.keepLegs), false),
      };
    }
    return {
      record: { ...r, journey, boarding, alternatives, refreshedAt: new Date(t).toISOString() },
      demo: { scene: sc.index + 1, scenes: DEMO_SCENES.length, key: sc.key, next: new Date(sc.next).toISOString() },
      replaced: !!chosen,
      replacedFrom: chosen ? keep : undefined,
    };
  }

  function view(
    { record: r, stale, demo, replaced, replacedFrom }: { record: TripRecord; stale?: boolean; demo?: TripView['demo']; replaced?: boolean; replacedFrom?: number },
    t: number,
  ): TripView {
    const isRepl = replaced ?? (!demo && isReplaced(r.journey, r.plannedJourney));
    return {
      demo,
      replaced: isRepl || undefined,
      replacedFrom: isRepl ? (replacedFrom ?? sharedPrefix(r.journey, r.plannedJourney)) : undefined,
      id: r.id,
      ticket: r.ticket,
      dticket: r.dticket,
      journey: r.journey,
      boarding: r.boarding,
      alternatives: r.alternatives,
      progress: progress(r.journey, t, r.boarding),
      transfers: transfers(r.journey, { boarding: r.boarding }),
      refreshedAt: r.refreshedAt,
      stale: stale || undefined,
    };
  }


  async function avatarVersion(scope: string): Promise<string | null> {
    return (await store.getPref(scope, 'avatar_v')) || null;
  }

  async function getAvatar(scope: string): Promise<Avatar | null> {
    const [data, version] = await Promise.all([store.getPref(scope, 'avatar'), store.getPref(scope, 'avatar_v')]);
    const a = data ? parseAvatar(data) : null;
    return a && version ? { ...a, version } : null;
  }
  return {
    async searchStops(q: string): Promise<StopHit[]> {
      const text = q.trim().slice(0, 80);
      if (text.length < 2) return [];
      // Testhaltestelle: Testfahrt mit allen Zuständen (ohne Transitous); echte Treffer, soweit erreichbar
      if (matchesDemo(text)) return [DEMO_STOP, ...(await client.searchStops(text, 7).catch(() => []))];
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
      if (isDemoStop(q.from) || isDemoStop(q.to)) {
        // Testfahrt: Abfahrt in 4 min (die Szenen beginnen nach dem Anlegen)
        const journeys = [demoJourney(Math.ceil(Date.now() / 60_000) * 60_000 + 4 * 60_000)];
        const planId = randomId(12);
        if (cache) await cache.put(key(`plan/${planId}`), new Response(JSON.stringify(journeys), { headers: { 'Cache-Control': `max-age=${PLAN_TTL_S}` } }));
        else memory.set(planId, journeys);
        return { planId, journeys };
      }
      let time: string | undefined;
      if (q.time) {
        const t = Date.parse(q.time);
        if (!Number.isFinite(t) || t < Date.now() - 86400_000 || t > Date.now() + 180 * 86400_000) throw new JourneyError('bad-request');
        time = new Date(t).toISOString();
      }
      const found = (
        await client.plan({ from: q.from, to: q.to, time, arriveBy: q.arriveBy, modes: searchModes({ ticket: q.ticket, hasDTicket: q.dticket }), results: 5 })
      )
        .filter((j) => j.legs.some((l) => l.kind === 'ride'))
        .map((j) => {
          const from = q.fromName?.trim().slice(0, 100);
          const to = q.toName?.trim().slice(0, 100);
          return from && to ? { ...j, title: { from, to } } : j;
        });
      // Suchergebnisse ohne IRIS: zu viele Unteranfragen (Cloudflare Free: 50 je Aufruf); ergänzt wird nach „Übernehmen“
      const journeys = found;
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
      const chosen = journeys[b.index];
      if (!chosen) throw new JourneyError('bad-request');
      const demo = isDemoJourney(chosen);
      const j = demo ? chosen : await withTracks(chosen);
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
        departAt: demo ? t : (journeyPlannedStart(j) ?? t),
        // Testfahrt bleibt einen Tag (Teilen-Links bis 2 h danach)
        arriveAt: demo ? new Date(Date.now() + 86400_000).toISOString() : (journeyEnd(j) ?? t),
        refreshedAt: t,
        createdAt: t,
        boarding: emptyBoarding(),
        alternatives: null,
      });
      await store.setPref(scope, 'dticket', dticket ? '1' : '0');
      return id;
    },

    /** Teilen-Link anlegen; der Token wird nur jetzt zurückgegeben (gespeichert ist nur sein Hash) */
    async createShare(scope: string, tripId: string, b: { label?: unknown }, sharedBy?: string | null): Promise<ShareInfo & { token: string }> {
      const r = await store.get(scope, tripId);
      if (!r) throw new JourneyError('not-found');
      if (Date.now() > Date.parse(shareExpiry(r.arriveAt))) throw new JourneyError('expired');
      if ((await store.listShares(scope, tripId)).length >= MAX_SHARES_PER_TRIP) throw new JourneyError('too-many');
      const token = randomId(24);
      const label = typeof b.label === 'string' ? b.label.trim().slice(0, 60) : '';
      const share = { id: randomId(9), tokenHash: await sha256(token), tripId, scope, label, sharedBy: sharedBy?.trim().slice(0, 60) || null, createdAt: nowIso() };
      await store.addShare(share);
      return { id: share.id, label, createdAt: share.createdAt, expiresAt: shareExpiry(r.arriveAt), token };
    },

    async listShares(scope: string, tripId: string): Promise<ShareInfo[]> {
      const r = await store.get(scope, tripId);
      if (!r) throw new JourneyError('not-found');
      return (await store.listShares(scope, tripId)).map((s) => ({ id: s.id, label: s.label, createdAt: s.createdAt, expiresAt: shareExpiry(r.arriveAt) }));
    },

    async revokeShare(scope: string, tripId: string, shareId: string) {
      const shares = await store.listShares(scope, tripId);
      if (!shares.some((s) => s.id === shareId)) throw new JourneyError('not-found');
      await store.deleteShare(scope, shareId);
    },

    /** Reise zu einem Teilen-Link (ohne Anmeldung): Live-Stand, ohne Ticketangaben; abgelaufen = 2 h nach Ankunft */
    async shared(token: string): Promise<SharedResult> {
      if (!/^[\w-]{20,64}$/.test(token)) return { status: 'not-found' };
      const share = await store.getShare(await sha256(token));
      if (!share) return { status: 'not-found' };
      let r = await store.get(share.scope, share.tripId);
      if (!r) return { status: 'expired' };
      const t = Date.now();
      if (t > Date.parse(shareExpiry(r.arriveAt))) return { status: 'expired' };
      let stale = false;
      let demo: TripView['demo'];
      let replaced: boolean | undefined;
      if (isDemoJourney(r.journey)) ({ record: r, demo, replaced } = await demoRecord(r, t));
      else if (refreshDue(r, t)) ({ record: r, stale } = await refresh(r));
      // nach dem Auffrischen kann sich die Ankunft verschoben haben
      if (t > Date.parse(shareExpiry(r.arriveAt))) return { status: 'expired' };
      const { ticket: _t, dticket: _d, ...trip } = view({ record: r, stale, demo, replaced }, t);
      return { status: 'ok', trip, expiresAt: shareExpiry(r.arriveAt), sharedBy: share.sharedBy, avatar: await avatarVersion(share.scope) };
    },

    /** Foto des Teilenden zu einem gültigen Teilen-Link (ohne Live-Abgleich) */
    async sharedAvatar(token: string): Promise<Avatar | null> {
      if (!/^[\w-]{20,64}$/.test(token)) return null;
      const share = await store.getShare(await sha256(token));
      if (!share) return null;
      const r = await store.get(share.scope, share.tripId);
      if (!r || Date.now() > Date.parse(shareExpiry(r.arriveAt))) return null;
      return getAvatar(share.scope);
    },

    /** Version des Fotos (null = keins) */
    avatarVersion,
    avatar: getAvatar,

    /** Foto speichern ({ image: data:-URL }); Ergebnis: neue Version */
    async setAvatar(scope: string, b: { image?: unknown }): Promise<string> {
      if (!parseAvatar(b.image)) throw new JourneyError('bad-request');
      const version = (await sha256(b.image as string)).slice(0, 12);
      await store.setPref(scope, 'avatar', b.image as string);
      await store.setPref(scope, 'avatar_v', version);
      return version;
    },

    async deleteAvatar(scope: string) {
      await store.setPref(scope, 'avatar_v', '');
      await store.setPref(scope, 'avatar', '');
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
      return Promise.all(rows.map(async (r) => view(isDemoJourney(r.journey) ? await demoRecord(r, t) : refreshDue(r, t) ? await refresh(r) : { record: r }, t)));
    },

    /** Check-in, „verpasst“ oder Zurücknehmen für einen Fahrt-Abschnitt */
    async board(scope: string, id: string, leg: unknown, action: unknown): Promise<TripView> {
      if (action !== 'checkin' && action !== 'missed' && action !== 'undo') throw new JourneyError('bad-request');
      const r = await store.get(scope, id);
      if (!r) throw new JourneyError('not-found');
      if (typeof leg !== 'number' || r.journey.legs[leg]?.kind !== 'ride') throw new JourneyError('bad-request');
      if (isDemoJourney(r.journey)) {
        // Testfahrt: Check-in gilt für die aktuelle Szene; keine Suche, keine Benachrichtigung
        const t = Date.now();
        const cur = await demoRecord(r, t);
        const boarding = applyBoarding(cur.record.journey, cur.record.boarding, leg, action);
        await store.setBoarding(r.id, boarding);
        return view(await demoRecord({ ...r, boarding }, t), t);
      }
      const boarding = applyBoarding(r.journey, r.boarding, leg, action);
      await store.setBoarding(r.id, boarding);
      // „verpasst“ → sofort Alternativen suchen
      return view({ record: await maintainAlternatives({ ...r, boarding }, Date.now()) }, Date.now());
    },

    /** Gewählte Alternative übernehmen: restliche Reise ersetzen */
    async chooseAlternative(scope: string, id: string, index: unknown): Promise<TripView> {
      const r = await store.get(scope, id);
      if (!r) throw new JourneyError('not-found');
      if (isDemoJourney(r.journey)) {
        // Testfahrt: Wahl merken; die Szenen laufen mit der neuen Verbindung weiter
        const cur = await demoRecord(r, Date.now());
        if (typeof index !== 'number' || !cur.record.alternatives?.options[index]) throw new JourneyError('bad-request');
        const manual = cur.record.alternatives?.reason === 'manual';
        await store.setPref(scope, demoChoiceKey(id), manual ? `${index}@${nowIso()}@${cur.record.alternatives!.keepLegs}` : `${index}@${nowIso()}`);
        return view(await demoRecord(r, Date.now()), Date.now());
      }
      const option = typeof index === 'number' ? r.alternatives?.options[index] : undefined;
      if (!r.alternatives || !option) throw new JourneyError('bad-request');
      const { journey, boarding } = replaceRemainder(r.journey, r.boarding, r.alternatives.keepLegs, option.journey);
      const t = nowIso();
      const arriveAt = journeyEnd(journey) ?? r.arriveAt;
      await store.updateLive(r.id, journey, arriveAt, t);
      await store.setBoarding(r.id, boarding);
      await store.setAlternatives(r.id, null);
      return view({ record: { ...r, journey, boarding, arriveAt, refreshedAt: t, alternatives: null } }, Date.now());
    },

    /**
     * „Alternativen anzeigen“: kurz vor dem Umstiegshalt (bzw. beim Umsteigen) andere Verbindungen ab dort suchen – etwa ein
     * verspäteter früherer Zug. Nur auf Knopfdruck, keine Benachrichtigung; Übernehmen wie bei anderen Alternativen.
     */
    async searchAlternatives(scope: string, id: string): Promise<TripView> {
      const r = await store.get(scope, id);
      if (!r) throw new JourneyError('not-found');
      const t = Date.now();
      if (isDemoJourney(r.journey)) {
        await store.setPref(scope, demoManualKey(id), nowIso());
        return view(await demoRecord(r, t), t);
      }
      const w = changeWindow(r.journey, r.boarding, t);
      if (!w) throw new JourneyError('not-now');
      const ctx = { ticket: r.ticket, hasDTicket: r.dticket };
      // freiwillig ein anderer Zug: Zugbindung nur, wenn sie ohnehin aufgehoben ist (≥ 20 min, Anschluss weg)
      const lifted = bindingLifted(r.journey).lifted;
      const bookedTripIds = r.plannedJourney.legs.flatMap((l) => (l.tripId ? [l.tripId] : []));
      const plannedNext = r.journey.legs.slice(w.keepLegs).find((l) => l.kind === 'ride')?.tripId;
      const dest = r.journey.legs.at(-1)!.to.stop;
      const found = await client.plan({ from: w.origin.id, to: dest.id, time: w.time, modes: searchModes(ctx), results: ALT_RESULTS + 2 });
      const options = found
        .filter((j) => j.legs.some((l) => l.kind === 'ride'))
        // die geplante Weiterfahrt nicht noch einmal anbieten
        .filter((j) => !plannedNext || j.legs.find((l) => l.kind === 'ride')?.tripId !== plannedNext)
        .map((j) => rateAlternative(j, ctx, { bindingLifted: lifted, bookedTripIds }))
        .sort((a, b) => Date.parse(journeyEnd(a.journey) ?? '') - Date.parse(journeyEnd(b.journey) ?? '') || Number(b.covered) - Number(a.covered))
        .slice(0, ALT_RESULTS);
      const alt: StoredAlternatives = { key: w.key, reason: 'manual', keepLegs: w.keepLegs, origin: w.origin, time: w.time, until: w.until, bindingLifted: lifted, computedAt: nowIso(), options };
      await store.setAlternatives(r.id, alt);
      return view({ record: { ...r, alternatives: alt } }, t);
    },

    /** selbst gesuchte Alternativen ausblenden */
    async dismissAlternatives(scope: string, id: string): Promise<TripView> {
      const r = await store.get(scope, id);
      if (!r) throw new JourneyError('not-found');
      const t = Date.now();
      if (isDemoJourney(r.journey)) {
        await store.setPref(scope, demoManualKey(id), '');
        return view(await demoRecord(r, t), t);
      }
      if (r.alternatives?.reason !== 'manual') return view({ record: r }, t);
      await store.setAlternatives(r.id, null);
      return view({ record: await maintainAlternatives({ ...r, alternatives: null }, t) }, t);
    },

    /**
     * Zurück zur ursprünglich gewählten Verbindung (nach „Übernehmen“ einer Alternative). Check-ins auf dem gemeinsamen
     * Anfang bleiben; danach Live-Abgleich – passt die Verbindung weiterhin nicht, erscheinen wieder Alternativen.
     */
    async revertTrip(scope: string, id: string): Promise<TripView> {
      const r = await store.get(scope, id);
      if (!r) throw new JourneyError('not-found');
      const t = Date.now();
      if (isDemoJourney(r.journey)) {
        await store.setPref(scope, demoChoiceKey(id), '');
        await store.setPref(scope, demoManualKey(id), '');
        return view(await demoRecord(r, t), t);
      }
      if (!isReplaced(r.journey, r.plannedJourney)) return view({ record: r }, t);
      const keep = sharedPrefix(r.journey, r.plannedJourney);
      const boarding = { checkins: r.boarding.checkins.filter((e) => e.leg < keep), missed: r.boarding.missed.filter((e) => e.leg < keep) };
      const journey = r.plannedJourney;
      const arriveAt = journeyEnd(journey) ?? r.arriveAt;
      await store.updateLive(r.id, journey, arriveAt, nowIso());
      await store.setBoarding(r.id, boarding);
      await store.setAlternatives(r.id, null);
      let next: { record: TripRecord; stale?: boolean } = { record: { ...r, journey, boarding, arriveAt, alternatives: null } };
      try {
        next = await refresh(next.record);
      } catch {
        next = { ...next, stale: true };
      }
      return view(next, t);
    },

    /** öffentlicher VAPID-Schlüssel (applicationServerKey) oder null, wenn Push nicht eingerichtet ist */
    pushKey(): string | null {
      return vapid ? vapidPublicKey(vapid.privateJwk) : null;
    },

    async subscribe(scope: string, b: { subscription?: unknown; lang?: unknown }) {
      if (!vapid) throw new JourneyError('push-off');
      if (!validSubscription(b.subscription)) throw new JourneyError('bad-request');
      await store.addPush({ ...b.subscription, scope, lang: b.lang === 'en' ? 'en' : 'de' });
    },

    async unsubscribe(b: { endpoint?: unknown }) {
      if (typeof b.endpoint === 'string' && b.endpoint.length <= 1000) await store.removePush(b.endpoint);
    },

    /** Testnachricht an alle Geräte des Bereichs */
    async testPush(scope: string, lang: unknown): Promise<number> {
      if (!vapid) throw new JourneyError('push-off');
      const de = lang !== 'en';
      let sent = 0;
      for (const s of await store.listPush(scope)) {
        const res = await push(
          s,
          { title: de ? 'Reisebegleitung' : 'Journey companion', body: de ? 'Benachrichtigungen funktionieren.' : 'Notifications are working.', url: opts.notifyUrl?.(scope) ?? '/', tag: 'test' },
          vapid,
        );
        if (res === 'ok') sent++;
        if (res === 'gone') await store.removePush(s.endpoint);
      }
      return sent;
    },

    /** Hintergrund (z. B. Cron jede Minute): alle laufenden Reisen auffrischen, wenn fällig */
    async refreshActive(): Promise<{ checked: number; refreshed: number }> {
      const t = Date.now();
      const rows = await store.listActive(new Date(t + LIVE_BEFORE_MS).toISOString(), new Date(t - LIVE_AFTER_MS).toISOString());
      // höchstens 3 Reisen je Lauf (Unteranfragen-Limit), die mit der nächsten Abfahrt zuerst – der Rest folgt im nächsten Lauf
      // Testfahrten nie im Hintergrund (keine Abfragen, keine Benachrichtigungen)
      const due = rows.filter((r) => !isDemoJourney(r.journey) && refreshDue(r, t)).slice(0, MAX_REFRESH_PER_RUN);
      for (const r of due) await refresh(r).catch((e) => console.warn('reisebegleitung refresh', r.id, String(e)));
      return { checked: rows.length, refreshed: due.length };
    },
  };
}

export type JourneyService = ReturnType<typeof createJourneyService>;

const PUSH_TEXT = {
  de: {
    'missed-train': '{line} verpasst',
    manual: 'Andere Verbindungen',
    connection: 'Anschluss {line} nicht erreichbar',
    cancelled: '{line} fällt aus',
    options: '{n} Alternativen ab {stop} – früheste Ankunft {time}',
    option1: '1 Alternative ab {stop} – Ankunft {time}',
    none: 'Keine passende Alternative gefunden – bitte selbst prüfen.',
  },
  en: {
    'missed-train': 'Missed {line}',
    manual: 'Other connections',
    connection: 'Connection {line} will be missed',
    cancelled: '{line} is cancelled',
    options: '{n} alternatives from {stop} – earliest arrival {time}',
    option1: '1 alternative from {stop} – arrival {time}',
    none: 'No suitable alternative found – please check yourself.',
  },
};

/** Text der Benachrichtigung zu neuen Alternativen */
export function pushMessage(r: Pick<TripRecord, 'alternatives'>, lang: 'de' | 'en'): { title: string; body: string } {
  const a = r.alternatives!;
  const T = PUSH_TEXT[lang];
  const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((acc, [k, x]) => acc.replace(`{${k}}`, String(x)), s);
  const title = fill(T[a.reason], { line: lineName(a.line, a.mode, lang) }).trim();
  const covered = a.options.filter((o) => o.covered);
  const list = covered.length ? covered : a.options;
  if (!list.length) return { title, body: T.none };
  const earliest = Math.min(...list.map((o) => Date.parse(journeyEnd(o.journey) ?? '')));
  const time = new Date(earliest).toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return { title, body: fill(list.length === 1 ? T.option1 : T.options, { n: list.length, stop: a.origin.name, time }) };
}
