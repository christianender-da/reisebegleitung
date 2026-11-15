import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Journey, Leg } from '../src/core/types.ts';
import { berlinStamp, carryIrisTracks, createIris, nameScore, nameVariants } from '../src/server/iris.ts';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('Namen: Transitous ↔ IRIS', () => {
  assert.ok(nameScore('Darmstadt Hauptbahnhof', 'Darmstadt Hbf') >= 2);
  assert.ok(nameScore('Frankfurt (Main) Hauptbahnhof', 'Frankfurt(Main)Hbf') >= 2);
  assert.ok(nameScore('Langen (Hessen) Bahnhof', 'Langen(Hess)') > 0);
  assert.ok(nameScore('Weinheim, Hauptbahnhof', 'Weinheim(Bergstr)Hbf') > 0);
  assert.ok(nameScore('Mainz, Römisches Theater', 'Mainz Römisches Theater') >= 2);
  assert.ok(nameScore('Frankfurt (Main) Südbahnhof', 'Frankfurt(Main)Süd') > 0);
  assert.equal(nameScore('Frankfurt (Main) Südbahnhof', 'Frankfurt(Main)Hbf'), 0);
  assert.equal(nameScore('Darmstadt Hauptbahnhof', 'Darmstadt Nord'), 0);
  assert.ok(nameScore('Frankfurt (Main) Hauptbahnhof', 'Frankfurt(Main)Hbf') > nameScore('Frankfurt (Main) Hauptbahnhof', 'Frankfurt(Main)Hbf (tief)'));
  assert.deepEqual(nameVariants('Frankfurt (Main) Hauptbahnhof'), ['Frankfurt (Main) Hbf', 'Frankfurt(Main)Hbf', 'Frankfurt (Main) Hauptbahnhof']);
  assert.deepEqual(nameVariants('Darmstadt-Eberstadt Bahnhof'), ['Darmstadt-Eberstadt', 'Darmstadt-Eberstadt Bahnhof']);
  assert.deepEqual(berlinStamp('2026-11-15T12:30:00Z'), { day: '261115', hour: '13', stamp: '2611151330' });
});

/** IRIS-Attrappe mit echten Antworten vom 2026-11-15 (Darmstadt Hbf, Frankfurt(Main)Hbf) */
function fakeIris() {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname.replace('/iris-tts/timetable', ''));
    calls.push(path);
    const body =
      path === '/station/Darmstadt Hbf'
        ? fx('iris-station-darmstadt.xml')
        : path === '/station/Frankfurt(Main)Hbf'
          ? fx('iris-station-frankfurt.xml')
          : path.startsWith('/station/')
            ? '<stations></stations>'
            : path === '/plan/8000068/261115/13'
              ? fx('iris-plan-darmstadt.xml')
              : path === '/plan/8000105/261115/13'
                ? fx('iris-plan-frankfurt-a.xml')
                : path === '/plan/8000105/261115/14'
                  ? fx('iris-plan-frankfurt-b.xml')
                  : path === '/fchg/8000068'
                    ? fx('iris-fchg-darmstadt.xml')
                    : '<timetable></timetable>';
    return new Response(body, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { iris: createIris({ userAgent: 'test/1', fetch, cache: null, memory: new Map(), now: () => NOW }), calls };
}

const rb68 = (): Leg => ({
  kind: 'ride',
  mode: 'regional',
  line: 'RB68',
  number: '15316',
  from: { stop: { id: 'de-DELFI_de:06411:4734', name: 'Darmstadt Hauptbahnhof' }, plannedDeparture: '2026-11-15T12:30:00Z' },
  to: { stop: { id: 'de-DELFI_de:06412:10', name: 'Frankfurt (Main) Hauptbahnhof' }, plannedArrival: '2026-11-15T12:47:00Z' },
  stopovers: [{ stop: { id: 'x', name: 'Langen (Hessen) Bahnhof' }, plannedArrival: '2026-11-15T12:39:00Z' }],
  cancelled: false,
  realtime: false,
});

test('IRIS ergänzt fehlende Zuggleise (Ein- und Ausstieg)', async () => {
  const { iris, calls } = fakeIris();
  const j: Journey = { legs: [rb68()] };
  const out = await iris.enrich(j);
  const l = out.legs[0];
  assert.equal(l.from.plannedTrack, '6');
  assert.equal(l.from.trackSource, 'iris');
  assert.equal(l.to.plannedTrack, '10');
  assert.equal(l.to.track, '10');
  assert.ok(calls.includes('/station/Darmstadt Hbf'));
  assert.ok(calls.includes('/station/Frankfurt(Main)Hbf'));
});

test('IRIS: vorhandene Gleise bleiben, Bus/Tram und Abschnitte ohne Zugnummer werden nicht angefragt', async () => {
  const { iris, calls } = fakeIris();
  const withTrack = rb68();
  withTrack.from.track = '7';
  withTrack.from.plannedTrack = '7';
  const bus: Leg = { ...rb68(), mode: 'bus', number: '1' };
  const noNumber: Leg = { ...rb68(), number: undefined };
  const out = await iris.enrich({ legs: [withTrack, bus, noNumber] });
  assert.equal(out.legs[0].from.track, '7');
  assert.equal(out.legs[0].from.trackSource, undefined);
  assert.equal(out.legs[0].to.plannedTrack, '10');
  assert.equal(out.legs[1].from.track, undefined);
  assert.equal(out.legs[2].from.track, undefined);
  assert.ok(calls.every((c) => !c.includes('/1/')));
});

test('IRIS: unbekannter Zug oder Fehler → Reise unverändert', async () => {
  const { iris } = fakeIris();
  const other = { ...rb68(), number: '99999' };
  assert.deepEqual((await iris.enrich({ legs: [other] })).legs[0], other);
  const broken = createIris({ userAgent: 't', cache: null, memory: new Map(), now: () => NOW, fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch });
  assert.deepEqual((await broken.enrich({ legs: [rb68()] })).legs[0], rb68());
});

test('IRIS: Budget begrenzt Unteranfragen, gemerkte Gleise kosten nur die Änderungsabfrage', async () => {
  const { iris, calls } = fakeIris();
  // zu kleines Budget: nichts gefunden, aber höchstens so viele Anfragen
  const none = await iris.enrich({ legs: [rb68()] }, 1);
  assert.equal(none.legs[0].from.track, undefined);
  assert.equal(calls.length, 1);
  // knappes Budget: Plangleis gefunden, Gleiswechsel-Abfrage entfällt – kein Fehler
  const { iris: i2, calls: c2b } = fakeIris();
  const tight = await i2.enrich({ legs: [rb68()] }, 2);
  assert.equal(tight.legs[0].from.track, '6');
  assert.ok(c2b.length <= 2);
  calls.length = 0;
  const full = await iris.enrich({ legs: [rb68()] });
  assert.deepEqual(full.legs[0].from.irisRef, { eva: '8000068', id: full.legs[0].from.irisRef!.id });
  assert.ok(calls.length <= 16, `zu viele Anfragen: ${calls.length}`);
  // zweiter Lauf mit irisRef: nur noch Änderungen (fchg) – Rest aus dem Speicher
  const { iris: fresh, calls: c2 } = fakeIris();
  await fresh.enrich(full);
  assert.deepEqual([...new Set(c2)].sort(), ['/fchg/8000068', '/fchg/8000105']);
});

test('IRIS: nur Züge in den nächsten 24 h; Gleise überstehen das Auffrischen', async () => {
  const { iris, calls } = fakeIris();
  const later = rb68();
  later.from.plannedDeparture = '2026-11-17T12:30:00Z';
  await iris.enrich({ legs: [later] });
  assert.equal(calls.length, 0);
  const enriched = await iris.enrich({ legs: [{ ...rb68(), tripId: 't1' }] });
  // frischer Stand aus Transitous ohne Gleis → IRIS-Gleis wird übernommen, Transitous-Gleis hätte Vorrang
  const fresh: Journey = { legs: [{ ...rb68(), tripId: 't1' }] };
  const carried = carryIrisTracks(enriched, fresh);
  assert.equal(carried.legs[0].from.plannedTrack, '6');
  assert.equal(carried.legs[0].from.trackSource, 'iris');
  const withOwn: Journey = { legs: [{ ...rb68(), tripId: 't1', from: { ...rb68().from, track: '7' } }] };
  assert.equal(carryIrisTracks(enriched, withOwn).legs[0].from.track, '7');
});
