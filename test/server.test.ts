import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { motisJourney, motisLeg } from '../src/core/motis.ts';
import type { TransitousClient } from '../src/core/transitous.ts';
import { createJourneyService } from '../src/server/service.ts';
import { handleJourneyRequest } from '../src/server/handler.ts';
import type { PushRecord, ShareRecord, TripRecord, TripStore } from '../src/server/store.ts';
import { handleSharedRequest } from '../src/server/handler.ts';
import { renderSharedLite } from '../src/server/lite.ts';
import { emptyBoarding } from '../src/core/boarding.ts';
import type { Journey } from '../src/core/types.ts';
import { pushMessage } from '../src/server/service.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const plan = fixture('plan-darmstadt-berlin.json');
const trip = fixture('trip-nj409.json');

function memoryStore(): TripStore & { rows: TripRecord[]; pushes: Map<string, PushRecord> } {
  const rows: TripRecord[] = [];
  const prefs = new Map<string, string>();
  const pushes = new Map<string, PushRecord>();
  const shares: ShareRecord[] = [];
  return {
    rows,
    pushes,
    async list(scope, after) {
      return rows.filter((r) => r.scope === scope && r.arriveAt >= after).sort((a, b) => a.departAt.localeCompare(b.departAt));
    },
    async get(scope, id) {
      return rows.find((r) => r.scope === scope && r.id === id) ?? null;
    },
    async listActive(departBefore, arriveAfter) {
      return rows.filter((r) => r.departAt <= departBefore && r.arriveAt >= arriveAfter);
    },
    async insert(t) {
      rows.push(structuredClone(t));
    },
    async setBoarding(id, boarding) {
      rows.find((r) => r.id === id)!.boarding = boarding;
    },
    async setAlternatives(id, alternatives) {
      rows.find((r) => r.id === id)!.alternatives = alternatives;
    },
    async addShare(x) {
      shares.push({ ...x });
    },
    async getShare(hash) {
      return shares.find((x) => x.tokenHash === hash) ?? null;
    },
    async listShares(scope, tripId) {
      return shares.filter((x) => x.scope === scope && x.tripId === tripId);
    },
    async deleteShare(scope, id) {
      const i = shares.findIndex((x) => x.scope === scope && x.id === id);
      if (i >= 0) shares.splice(i, 1);
    },
    async addPush(p) {
      pushes.set(p.endpoint, p);
    },
    async removePush(endpoint) {
      pushes.delete(endpoint);
    },
    async listPush(scope) {
      return [...pushes.values()].filter((p) => p.scope === scope);
    },
    async updateLive(id, journey, arriveAt, refreshedAt) {
      Object.assign(rows.find((r) => r.id === id)!, { journey, arriveAt, refreshedAt });
    },
    async delete(scope, id) {
      const i = rows.findIndex((r) => r.scope === scope && r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    async purge(before) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].arriveAt < before) rows.splice(i, 1);
    },
    async getPref(scope, key) {
      return prefs.get(`${scope}/${key}`) ?? null;
    },
    async setPref(scope, key, value) {
      prefs.set(`${scope}/${key}`, value);
    },
  };
}

const calls: string[] = [];
const fakeClient: TransitousClient = {
  async searchStops(q) {
    calls.push(`stops:${q}`);
    return [{ id: 'de-DELFI_de:06411:4734', name: 'Darmstadt Hauptbahnhof', modes: ['regional'] }];
  },
  async plan(p) {
    calls.push(`plan:${p.from}->${p.to}:${(p.modes ?? []).includes('coach')}`);
    return plan.itineraries.map(motisJourney);
  },
  async trip() {
    calls.push('trip');
    return trip.legs.map(motisLeg);
  },
};

const req = (path: string, init?: RequestInit) => new Request(`https://example.org/api${path}`, init);

test('Handler: suchen, anlegen, auflisten, löschen', async () => {
  const store = memoryStore();
  const service = createJourneyService({ store, userAgent: 'test/1', client: fakeClient, cache: null });
  const ctx = { scope: 'default', owner: 'me', canEdit: true };

  const stops = await (await handleJourneyRequest(service, req('/stops?q=Darmstadt'), '/stops', ctx)).json();
  assert.equal(stops.hits[0].name, 'Darmstadt Hauptbahnhof');

  const planRes = await handleJourneyRequest(service, req('/plan?from=a:1&to=b:2&fromName=Darmstadt%20Hbf&toName=Berlin%20Hbf&ticket=spar&dticket=1'), '/plan', ctx);
  assert.equal(planRes.status, 200);
  const planned = await planRes.json();
  assert.equal(planned.journeys.length, 2);
  assert.deepEqual(planned.journeys[0].title, { from: 'Darmstadt Hbf', to: 'Berlin Hbf' });
  assert.ok(calls.includes('plan:a:1->b:2:false'), 'Sparpreis sucht ohne Fernbus');

  const created = await handleJourneyRequest(
    service,
    req('/trips', { method: 'POST', body: JSON.stringify({ planId: planned.planId, index: 1, ticket: 'spar', dticket: true }) }),
    '/trips',
    ctx,
  );
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal(store.rows[0].ticket, 'spar');
  assert.equal(store.rows[0].arriveAt, '2026-11-15T06:22:00Z');

  // Reisen von 2026 liegen für den Test in der Vergangenheit → ausgeblendet/aufgeräumt; Ankunft in die Zukunft legen
  store.rows[0].arriveAt = new Date(Date.now() + 3600_000).toISOString();
  store.rows[0].departAt = new Date(Date.now() - 3600_000).toISOString();
  const list = await (await handleJourneyRequest(service, req('/trips'), '/trips', ctx)).json();
  assert.equal(list.trips.length, 1);
  assert.equal(list.dticket, true);
  assert.equal(list.trips[0].transfers.length, 1);

  // Check-in für den Nachtzug (Abschnitt 2), Fußweg (1) ist kein Fahrt-Abschnitt
  const post = (body: unknown) => req(`/trips/${id}/boarding`, { method: 'POST', body: JSON.stringify(body) });
  const ok = await handleJourneyRequest(service, post({ leg: 2, action: 'checkin' }), `/trips/${id}/boarding`, ctx);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).trip.boarding.checkins[0].leg, 2);
  assert.equal(store.rows[0].boarding.checkins.length, 1);
  assert.equal((await handleJourneyRequest(service, post({ leg: 1, action: 'checkin' }), `/trips/${id}/boarding`, ctx)).status, 400);
  assert.equal((await handleJourneyRequest(service, post({ leg: 2, action: 'fly' }), `/trips/${id}/boarding`, ctx)).status, 400);
  assert.equal((await handleJourneyRequest(service, post({ leg: 2, action: 'checkin' }), '/trips/unbekannt/boarding', ctx)).status, 404);
  const viewer = { ...ctx, canEdit: false };
  assert.equal((await handleJourneyRequest(service, post({ leg: 2, action: 'undo' }), `/trips/${id}/boarding`, viewer)).status, 403);

  const del = await handleJourneyRequest(service, req(`/trips/${id}`, { method: 'DELETE' }), `/trips/${id}`, ctx);
  assert.equal(del.status, 200);
  assert.equal(store.rows.length, 0);
});

test('Handler: ohne Bearbeitungsrecht nur ansehen', async () => {
  const service = createJourneyService({ store: memoryStore(), userAgent: 'test/1', client: fakeClient, cache: null });
  const ctx = { scope: 'default', owner: 'viewer', canEdit: false };
  const list = await (await handleJourneyRequest(service, req('/trips'), '/trips', ctx)).json();
  assert.deepEqual(list, { trips: [] });
  assert.equal((await handleJourneyRequest(service, req('/stops?q=x'), '/stops', ctx)).status, 403);
  assert.equal((await handleJourneyRequest(service, req('/trips', { method: 'POST', body: '{}' }), '/trips', ctx)).status, 403);
});

test('Handler: abgelaufene Suche und falsche Eingaben', async () => {
  const service = createJourneyService({ store: memoryStore(), userAgent: 'test/1', client: fakeClient, cache: null });
  const ctx = { scope: 'default', owner: 'me', canEdit: true };
  const expired = await handleJourneyRequest(
    service,
    req('/trips', { method: 'POST', body: JSON.stringify({ planId: 'abcdefghijkl', index: 0, ticket: 'flex' }) }),
    '/trips',
    ctx,
  );
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, 'plan-expired');
  assert.equal((await handleJourneyRequest(service, req('/plan?from=a&to=b&ticket=gold'), '/plan', ctx)).status, 400);
  assert.equal((await handleJourneyRequest(service, req('/plan?from=a%20b&to=b&ticket=flex'), '/plan', ctx)).status, 400);
  assert.equal((await handleJourneyRequest(service, req('/nope'), '/nope', ctx)).status, 404);
});

test('App-Migration entspricht dem Paket-Schema', () => {
  const a = readFileSync(new URL('../migrations/0001_journey.sql', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../app/migrations/0002_journey.sql', import.meta.url), 'utf8');
  assert.equal(b, a);
});

test('Hintergrund: nur fällige Reisen auffrischen', async () => {
  const store = memoryStore();
  calls.length = 0;
  const service = createJourneyService({ store, userAgent: 'test/1', client: { ...fakeClient, trip: async () => (calls.push('trip'), null) }, cache: null });
  const base = motisJourney(plan.itineraries[1]);
  /** Reise so verschieben, dass die erste Abfahrt `offset` ms von jetzt liegt */
  const put = (offset: number, refreshedAgo: number) => {
    const j = shift(base, Date.now() + offset - Date.parse(base.legs[0].from.plannedDeparture!));
    store.rows.length = 0;
    store.rows.push({ id: 't', scope: 'default', owner: 'me', ticket: 'flex', dticket: false, plannedJourney: j, journey: j, departAt: j.legs[0].from.plannedDeparture!, arriveAt: j.legs[2].to.plannedArrival!, refreshedAt: new Date(Date.now() - refreshedAgo).toISOString(), createdAt: '', boarding: emptyBoarding(), alternatives: null });
  };
  // läuft gerade, zuletzt vor 2 min aufgefrischt → fällig
  put(-3600_000, 120_000);
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 1 });
  assert.ok(calls.includes('trip'));
  // gerade aufgefrischt → nicht fällig
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 0 });
  // 2 h vor Abfahrt: nur alle 5 min
  put(2 * 3600_000, 120_000);
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 0 });
  put(2 * 3600_000, 6 * 60_000);
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 1 });
  // Ankunft vor über 30 min → nicht mehr aktiv
  put(-12 * 3600_000, 6 * 60_000);
  assert.deepEqual(await service.refreshActive(), { checked: 0, refreshed: 0 });
});

test('App-Migrationen entsprechen dem Paket-Schema (Check-in)', () => {
  const a = readFileSync(new URL('../migrations/0002_boarding.sql', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../app/migrations/0003_boarding.sql', import.meta.url), 'utf8');
  assert.equal(b, a);
});

/** alle Zeitangaben einer Reise verschieben */
function shift(j: Journey, ms: number): Journey {
  return JSON.parse(JSON.stringify(j), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(Date.parse(v) + ms).toISOString() : v));
}

test('Anschluss platzt: Alternativen, eine Benachrichtigung, Übernehmen', async () => {
  const store = memoryStore();
  const sent: { title: string; body: string }[] = [];
  const jwk = await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair).privateKey);
  const client: TransitousClient = { ...fakeClient, trip: async () => null };
  const service = createJourneyService({
    store,
    userAgent: 'test/1',
    client,
    cache: null,
    push: { privateJwk: JSON.stringify(jwk), subject: 'mailto:a@b.de' },
    sendPush: async (_s, msg) => {
      sent.push(msg as { title: string; body: string });
      return 'ok';
    },
  });
  const ctx = { scope: 'w1', owner: 'me', canEdit: true };
  // S6 fährt in 10 min, kommt aber 28 min zu spät in Frankfurt Süd an → Umstieg zum NJ nicht erreichbar
  const base = motisJourney(plan.itineraries[1]);
  const j = shift(base, Date.now() + 10 * 60_000 - Date.parse(base.legs[0].from.plannedDeparture!));
  j.legs[0].to.arrival = new Date(Date.parse(j.legs[0].to.plannedArrival!) + 28 * 60_000).toISOString();
  const t = new Date().toISOString();
  store.rows.push({ id: 'trip1', scope: 'w1', owner: 'me', ticket: 'spar', dticket: false, plannedJourney: j, journey: j, departAt: j.legs[0].from.plannedDeparture!, arriveAt: j.legs[2].to.plannedArrival!, refreshedAt: '2026-01-01T00:00:00Z', createdAt: t, boarding: emptyBoarding(), alternatives: null });
  await store.addPush({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', scope: 'w1', lang: 'de', keys: { p256dh: 'x', auth: 'y' } });

  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 1 });
  const alt = store.rows[0].alternatives!;
  assert.equal(alt.reason, 'connection');
  assert.equal(alt.keepLegs, 1);
  assert.equal(alt.origin.name, 'Frankfurt (Main) Südbahnhof');
  assert.equal(alt.bindingLifted, true);
  assert.equal(alt.options.length, 2);
  assert.ok(alt.options.every((o) => o.covered), 'Sparpreis mit aufgehobener Zugbindung');
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /^Anschluss .+ nicht erreichbar$/);
  assert.match(sent[0].body, /^2 Alternativen ab Frankfurt \(Main\) Südbahnhof – früheste Ankunft \d\d:\d\d$/);

  // gleicher Auslöser → keine zweite Nachricht
  store.rows[0].refreshedAt = '2026-01-01T00:00:00Z';
  await service.refreshActive();
  assert.equal(sent.length, 1);

  // Übernehmen: S6 bleibt, Rest = Alternative 0
  const res = await handleJourneyRequest(service, req('/trips/trip1/alternative', { method: 'POST', body: '{"index":0}' }), '/trips/trip1/alternative', ctx);
  assert.equal(res.status, 200);
  const trip = (await res.json()).trip;
  assert.equal(trip.alternatives, null);
  assert.equal(trip.journey.legs[0].line, 'S6');
  assert.equal(trip.journey.legs.length, 1 + alt.options[0].journey.legs.length);
  assert.equal(store.rows[0].alternatives, null);
  assert.equal((await handleJourneyRequest(service, req('/trips/trip1/alternative', { method: 'POST', body: '{"index":0}' }), '/trips/trip1/alternative', ctx)).status, 400);
});

test('Push-Endpunkte', async () => {
  const jwk = await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair).privateKey);
  const store = memoryStore();
  const on = createJourneyService({ store, userAgent: 'test/1', client: fakeClient, cache: null, push: { privateJwk: JSON.stringify(jwk), subject: 'mailto:a@b.de' } });
  const off = createJourneyService({ store, userAgent: 'test/1', client: fakeClient, cache: null });
  const ctx = { scope: 'w1', owner: 'me', canEdit: true };
  const key = await (await handleJourneyRequest(on, req('/push/key'), '/push/key', ctx)).json();
  assert.equal(key.key.length, 87);
  assert.deepEqual(await (await handleJourneyRequest(off, req('/push/key'), '/push/key', ctx)).json(), { key: null });
  const p256dh = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh, auth: Buffer.alloc(16, 1).toString('base64url') } };
  const post = (path: string, body: unknown) => req(path, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await handleJourneyRequest(on, post('/push/subscribe', { subscription: sub, lang: 'en' }), '/push/subscribe', ctx)).status, 200);
  assert.equal(store.pushes.get(sub.endpoint)?.lang, 'en');
  assert.equal((await handleJourneyRequest(on, post('/push/subscribe', { subscription: { ...sub, endpoint: 'https://evil.example/x' } }), '/push/subscribe', ctx)).status, 400);
  assert.equal((await handleJourneyRequest(off, post('/push/subscribe', { subscription: sub }), '/push/subscribe', ctx)).status, 409);
  assert.equal((await handleJourneyRequest(on, post('/push/subscribe', { subscription: sub }), '/push/subscribe', { ...ctx, canEdit: false })).status, 403);
  assert.equal((await handleJourneyRequest(on, post('/push/unsubscribe', { endpoint: sub.endpoint }), '/push/unsubscribe', ctx)).status, 200);
  assert.equal(store.pushes.size, 0);
});

test('Benachrichtigungstext ohne Alternativen', () => {
  const m = pushMessage({ alternatives: { key: 'k', reason: 'cancelled', keepLegs: 0, origin: { id: 'x', name: 'Mainz Hbf' }, time: '', line: 'RE 2', bindingLifted: true, computedAt: '', options: [] } }, 'de');
  assert.deepEqual(m, { title: 'RE 2 fällt aus', body: 'Keine passende Alternative gefunden – bitte selbst prüfen.' });
});

test('App-Migrationen entsprechen dem Paket-Schema (Alternativen)', () => {
  const a = readFileSync(new URL('../migrations/0003_alternatives.sql', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../app/migrations/0004_alternatives.sql', import.meta.url), 'utf8');
  assert.equal(b, a);
});

test('Teilen-Links: anlegen, ansehen ohne Ticket, Ablauf 2 h nach Ankunft, widerrufen, Lite-Seite', async () => {
  const store = memoryStore();
  const service = createJourneyService({ store, userAgent: 'test/1', client: { ...fakeClient, trip: async () => null }, cache: null });
  const ctx = { scope: 'w1', owner: 'me', canEdit: true, ownerName: 'Christian' };
  const base = motisJourney(plan.itineraries[1]);
  const j = { ...shift(base, Date.now() - 10 * 60_000 - Date.parse(base.legs[0].from.plannedDeparture!)), title: { from: 'Darmstadt Hbf', to: 'Berlin <Hbf>' } };
  const t = new Date().toISOString();
  store.rows.push({ id: 'trip1', scope: 'w1', owner: 'me', ticket: 'spar', dticket: true, plannedJourney: j, journey: j, departAt: j.legs[0].from.plannedDeparture!, arriveAt: j.legs[2].to.plannedArrival!, refreshedAt: t, createdAt: t, boarding: { checkins: [{ leg: 0, at: t }], missed: [] }, alternatives: null });

  const post = (body: unknown) => req('/trips/trip1/shares', { method: 'POST', body: JSON.stringify(body) });
  const created = await handleJourneyRequest(service, post({ label: 'Mama' }), '/trips/trip1/shares', ctx);
  assert.equal(created.status, 201);
  const { share } = await created.json();
  assert.match(share.token, /^[\w-]{32}$/);
  assert.equal(share.label, 'Mama');
  assert.equal(Date.parse(share.expiresAt), Date.parse(j.legs[2].to.plannedArrival!) + 2 * 3600_000);
  // nur der Hash ist gespeichert
  assert.ok(!JSON.stringify(store.rows).includes(share.token));

  const list = await (await handleJourneyRequest(service, req('/trips/trip1/shares'), '/trips/trip1/shares', ctx)).json();
  assert.deepEqual(list.shares.map((x: { label: string }) => x.label), ['Mama']);
  assert.ok(!('token' in list.shares[0]));

  const pub = await handleSharedRequest(service, share.token);
  assert.equal(pub.status, 200);
  const data = await pub.json();
  assert.equal(data.sharedBy, 'Christian');
  assert.equal(data.trip.ticket, undefined);
  assert.equal(data.trip.dticket, undefined);
  assert.equal(data.trip.boarding.checkins[0].leg, 0);
  assert.equal(data.trip.progress.phase.onBoard, true);

  const html = renderSharedLite(await service.shared(share.token), 'de');
  assert.match(html, /<title>Darmstadt Hbf → Berlin &lt;Hbf&gt;<\/title>/);
  assert.match(html, /An Bord: S6/);
  assert.match(html, /meta http-equiv="refresh"/);
  assert.ok(!/<script/i.test(html));

  // falsches Token, Betrachter ohne Rechte, unbekannte Reise
  assert.equal((await handleSharedRequest(service, 'x'.repeat(32))).status, 404);
  assert.equal((await handleSharedRequest(service, '../etc')).status, 404);
  assert.equal((await handleJourneyRequest(service, post({}), '/trips/trip1/shares', { ...ctx, canEdit: false })).status, 403);
  assert.equal((await handleJourneyRequest(service, req('/trips/nope/shares', { method: 'POST', body: '{}' }), '/trips/nope/shares', ctx)).status, 404);

  // Ablauf: Ankunft vor mehr als 2 h → 410, Lite zeigt „abgelaufen“
  const arrive = store.rows[0].arriveAt;
  store.rows[0].arriveAt = new Date(Date.now() - 2 * 3600_000 - 60_000).toISOString();
  const gone = await handleSharedRequest(service, share.token);
  assert.equal(gone.status, 410);
  assert.match(renderSharedLite(await service.shared(share.token), 'de'), /Link ist abgelaufen/);
  assert.equal((await handleJourneyRequest(service, post({}), '/trips/trip1/shares', ctx)).status, 410);
  store.rows[0].arriveAt = arrive;

  // widerrufen
  const del = await handleJourneyRequest(service, req(`/trips/trip1/shares/${share.id}`, { method: 'DELETE' }), `/trips/trip1/shares/${share.id}`, ctx);
  assert.equal(del.status, 200);
  assert.equal((await handleSharedRequest(service, share.token)).status, 404);
});

test('Teilen-Links: höchstens 10 pro Reise', async () => {
  const store = memoryStore();
  const service = createJourneyService({ store, userAgent: 'test/1', client: fakeClient, cache: null });
  const j = shift(motisJourney(plan.itineraries[1]), 86400_000 * 400);
  store.rows.push({ id: 'trip1', scope: 'w1', owner: 'me', ticket: 'flex', dticket: false, plannedJourney: j, journey: j, departAt: j.legs[0].from.plannedDeparture!, arriveAt: j.legs[2].to.plannedArrival!, refreshedAt: null, createdAt: '', boarding: emptyBoarding(), alternatives: null });
  for (let k = 0; k < 10; k++) await service.createShare('w1', 'trip1', {});
  await assert.rejects(service.createShare('w1', 'trip1', {}), /too-many/);
});

test('App-Migrationen entsprechen dem Paket-Schema (Teilen)', () => {
  const a = readFileSync(new URL('../migrations/0004_shares.sql', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../app/migrations/0005_shares.sql', import.meta.url), 'utf8');
  assert.equal(b, a);
});
