import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_KEEP_LEGS, DEMO_SCENES, DEMO_STOP, demoAlternativeJourneys, demoJourney, demoScene, isDemoJourney, matchesDemo } from '../src/core/demo.ts';
import { progress, transfers } from '../src/core/progress.ts';
import { createJourneyService } from '../src/server/service.ts';
import type { TransitousClient } from '../src/core/transitous.ts';
import type { TripRecord, TripStore } from '../src/server/store.ts';

const MIN = 60_000;
const slack = (t: { bufferMin: number; neededMin: number }) => t.bufferMin - t.neededMin;

test('Testhaltestelle: Suche passt ab 4 Zeichen', () => {
  assert.ok(matchesDemo('Test'));
  assert.ok(matchesDemo('testhaltestelle'));
  assert.ok(matchesDemo('Testhalt'));
  assert.ok(!matchesDemo('Tes'));
  assert.ok(!matchesDemo('Testerberg'));
});

test('Testfahrt: jede Szene zeigt ihren Zustand – über die ganze Minute', () => {
  const since = Date.parse('2026-11-15T10:00:00Z');
  for (let k = 0; k < DEMO_SCENES.length; k++) {
    for (const offset of [0, 59_999]) {
      const now = since + k * MIN + offset;
      const sc = demoScene(now, since);
      assert.equal(sc.index, k);
      assert.equal(sc.next, since + (k + 1) * MIN);
      const j = demoJourney(sc.start);
      const ph = progress(j, now).phase;
      const tr = transfers(j);
      const key = DEMO_SCENES[k].key;
      const expect: Record<string, [string, number?]> = {
        before: ['before', 0],
        bus: ['riding', 0],
        'transfer-slow': ['transfer', 2],
        tram: ['riding', 2],
        'transfer-normal': ['transfer', 4],
        train: ['riding', 4],
        'transfer-fast': ['transfer', 6],
        missed: ['riding', 6],
        arrived: ['arrived'],
      };
      const [kind, leg] = expect[key];
      assert.equal(ph.kind, kind, `${key} @${offset}`);
      if (leg !== undefined) assert.equal((ph as { legIndex: number }).legIndex, leg, `${key} @${offset}`);
      // Umstiege: gemütlich, zügig, knapp (rennt), nicht erreichbar
      assert.deepEqual(
        tr.map((t) => t.state),
        ['ok', 'ok', 'tight', 'missed'],
      );
      assert.ok(slack(tr[0]) >= 10);
      assert.ok(slack(tr[1]) >= 4 && slack(tr[1]) < 10);
      assert.ok(slack(tr[2]) >= 0 && slack(tr[2]) < 4);
    }
  }
  // angekommen auch mit der spätesten Alternative
  const sc = demoScene(since + (DEMO_SCENES.length - 1) * MIN, since);
  for (const alt of demoAlternativeJourneys(sc.start)) assert.ok(Date.parse(alt.legs.at(-1)!.to.plannedArrival!) < since + (DEMO_SCENES.length - 1) * MIN);
  // Schleife: nach der letzten Szene wieder „vor Abfahrt“
  assert.equal(demoScene(since + DEMO_SCENES.length * MIN, since).key, 'before');
});

test('Testfahrt: Verkehrsmittel, Steige, Gleiswechsel, Ausfall, Alternativen mit Fähre', () => {
  const j = demoJourney(Date.parse('2026-11-15T10:00:00Z'));
  assert.ok(isDemoJourney(j));
  assert.deepEqual(
    j.legs.filter((l) => l.kind === 'ride').map((l) => l.mode),
    ['bus', 'tram', 'regional', 'suburban', 'longdistance'],
  );
  assert.equal(j.legs[0].from.stop.id, DEMO_STOP.id);
  const re = j.legs[4];
  assert.equal(re.from.plannedTrack, '3');
  assert.equal(re.from.track, '4');
  assert.ok(j.legs[8].stopovers.some((s) => s.cancelled));
  const alts = demoAlternativeJourneys(Date.parse('2026-11-15T10:00:00Z'));
  assert.ok(alts.some((a) => a.legs.some((l) => l.mode === 'ferry')));
  assert.ok(alts.every(isDemoJourney));
});

function memStore(): TripStore & { rows: TripRecord[] } {
  const rows: TripRecord[] = [];
  const prefs = new Map<string, string>();
  return {
    rows,
    list: async (scope) => rows.filter((r) => r.scope === scope),
    get: async (scope, id) => rows.find((r) => r.scope === scope && r.id === id) ?? null,
    listActive: async () => rows,
    insert: async (t) => void rows.push(t),
    setBoarding: async (id, b) => void (rows.find((r) => r.id === id)!.boarding = b),
    setAlternatives: async (id, a) => void (rows.find((r) => r.id === id)!.alternatives = a),
    addShare: async () => {},
    getShare: async () => null,
    listShares: async () => [],
    deleteShare: async () => {},
    addPush: async () => {},
    removePush: async () => {},
    listPush: async () => [],
    updateLive: async (id, journey) => void (rows.find((r) => r.id === id)!.journey = journey),
    delete: async () => {},
    purge: async () => {},
    getPref: async (s, k) => prefs.get(`${s}/${k}`) ?? null,
    setPref: async (s, k, v) => void prefs.set(`${s}/${k}`, v),
  };
}

test('Testfahrt im Service: ohne Transitous, ohne IRIS, nicht im Hintergrund', async () => {
  const calls: string[] = [];
  const client: TransitousClient = {
    searchStops: async (q) => (calls.push(`stops:${q}`), Promise.reject(new Error('offline'))),
    plan: async () => (calls.push('plan'), []),
    trip: async () => (calls.push('trip'), null),
    geocode: undefined as never,
  } as unknown as TransitousClient;
  const store = memStore();
  const service = createJourneyService({ store, userAgent: 'test/1', client, cache: null, irisPlatforms: true, iris: { enrich: async () => (calls.push('iris'), Promise.reject(new Error('nein'))) } as never });

  // Suche: Testhaltestelle auch, wenn Transitous nicht erreichbar ist
  const hits = await service.searchStops('Testhalt');
  assert.equal(hits[0].id, DEMO_STOP.id);

  const res = await service.plan({ from: DEMO_STOP.id, to: 'de-DELFI_de:06411:4734', arriveBy: false, ticket: 'spar', dticket: false });
  assert.equal(res.journeys.length, 1);
  const id = await service.createTrip('w1', 'me', { planId: res.planId, index: 0, ticket: 'spar', dticket: false });
  assert.ok(id);

  const [v] = await service.trips('w1');
  assert.equal(v.demo?.scene, 1);
  assert.equal(v.demo?.key, 'before');
  assert.equal(v.progress.phase.kind, 'before');
  // Anschluss an den IC ist nie zu schaffen → Alternativen (fest vorgegeben), Sparpreis: Zugbindung aufgehoben
  assert.equal(v.alternatives?.reason, 'connection');
  assert.equal(v.alternatives?.options.length, 3);
  assert.equal(v.alternatives?.bindingLifted, true);
  assert.equal(v.alternatives?.keepLegs, DEMO_KEEP_LEGS);

  // Check-in, Übernehmen, zurück: ohne Suche
  const checked = await service.board('w1', id, 0, 'checkin');
  assert.equal(checked.boarding.checkins.length, 1);
  const taken = await service.chooseAlternative('w1', id, 0);
  assert.equal(taken.replaced, true);
  assert.equal(taken.alternatives, null, 'mit der Alternative passt der Anschluss');
  assert.equal(taken.journey.legs[7].line, v.alternatives?.options[0].journey.legs[0].line);
  assert.equal((await service.trips('w1'))[0].replaced, true);
  const back = await service.revertTrip('w1', id);
  assert.equal(back.replaced, undefined);
  assert.equal(back.journey.legs[8].line, 'IC 2026');
  assert.equal(back.alternatives?.options.length, 3);
  const bg = await service.refreshActive();
  assert.equal(bg.refreshed, 0);
  assert.deepEqual(calls.filter((c) => !c.startsWith('stops:')), []);
});

test('Testfahrt: „Alternativen anzeigen“ im Bus, früherer verspäteter RE übernehmen, zurück', async () => {
  const store = memStore();
  const client = { searchStops: async () => [], plan: async () => { throw new Error('kein Netz'); }, trip: async () => null } as unknown as TransitousClient;
  const service = createJourneyService({ store, userAgent: 'test/1', client, cache: null });
  const res = await service.plan({ from: DEMO_STOP.id, to: DEMO_STOP.id, arriveBy: false, ticket: 'flex', dticket: false });
  const id = await service.createTrip('w1', 'me', { planId: res.planId, index: 0, ticket: 'flex', dticket: false });
  // auf Szene 2 (im Bus, kurz vor Musterplatz) stellen: Anlegen 1 min zurückdatieren
  store.rows[0].createdAt = new Date(Date.now() - 60_000).toISOString();
  const v = await service.searchAlternatives('w1', id);
  assert.equal(v.demo?.key, 'bus');
  assert.equal(v.alternatives?.reason, 'manual');
  assert.equal(v.alternatives?.origin.name, 'Musterplatz');
  assert.deepEqual(v.alternatives?.options.map((o) => o.journey.legs[0].line), ['RE 98', 'RB 12']);
  const taken = await service.chooseAlternative('w1', id, 0);
  assert.equal(taken.replaced, true);
  assert.equal(taken.replacedFrom, 1);
  assert.equal(taken.journey.legs[1].line, 'RE 98');
  const back = await service.revertTrip('w1', id);
  assert.equal(back.journey.legs[2].line, '7');
  assert.notEqual(back.alternatives?.reason, 'manual');
});
