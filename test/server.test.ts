import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { motisJourney, motisLeg } from '../src/core/motis.ts';
import type { TransitousClient } from '../src/core/transitous.ts';
import { createJourneyService } from '../src/server/service.ts';
import { handleJourneyRequest } from '../src/server/handler.ts';
import type { TripRecord, TripStore } from '../src/server/store.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const plan = fixture('plan-darmstadt-berlin.json');
const trip = fixture('trip-nj409.json');

function memoryStore(): TripStore & { rows: TripRecord[] } {
  const rows: TripRecord[] = [];
  const prefs = new Map<string, string>();
  return {
    rows,
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
  const service = createJourneyService({ store, userAgent: 'test/1', client: fakeClient, cache: null });
  const planned = await service.plan({ from: 'a:1', to: 'b:2', arriveBy: false, ticket: 'flex', dticket: false });
  const id = await service.createTrip('default', 'me', { planId: planned.planId, index: 1, ticket: 'flex' });
  const r = store.rows.find((x) => x.id === id)!;
  const t = Date.now();
  // läuft gerade, zuletzt vor 2 min aufgefrischt → fällig
  Object.assign(r, { departAt: new Date(t - 3600_000).toISOString(), arriveAt: new Date(t + 3600_000).toISOString(), refreshedAt: new Date(t - 120_000).toISOString() });
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 1 });
  assert.ok(calls.includes('trip'));
  // gerade aufgefrischt → nicht fällig
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 0 });
  // 2 h vor Abfahrt: nur alle 5 min
  Object.assign(r, { departAt: new Date(t + 2 * 3600_000).toISOString(), arriveAt: new Date(t + 5 * 3600_000).toISOString(), refreshedAt: new Date(t - 120_000).toISOString() });
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 0 });
  r.refreshedAt = new Date(t - 6 * 60_000).toISOString();
  assert.deepEqual(await service.refreshActive(), { checked: 1, refreshed: 1 });
  // Ankunft vor über 30 min → nicht mehr aktiv
  Object.assign(r, { departAt: new Date(t - 5 * 3600_000).toISOString(), arriveAt: new Date(t - 3600_000).toISOString() });
  assert.deepEqual(await service.refreshActive(), { checked: 0, refreshed: 0 });
});

test('App-Migrationen entsprechen dem Paket-Schema (Check-in)', () => {
  const a = readFileSync(new URL('../migrations/0002_boarding.sql', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../app/migrations/0003_boarding.sql', import.meta.url), 'utf8');
  assert.equal(b, a);
});
