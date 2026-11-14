import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { alternativesTrigger, liftedFor, rateAlternative, replaceRemainder } from '../src/core/alternatives.ts';
import { applyBoarding, emptyBoarding } from '../src/core/boarding.ts';
import { motisJourney } from '../src/core/motis.ts';

const plan = JSON.parse(readFileSync(new URL('./fixtures/plan-darmstadt-berlin.json', import.meta.url), 'utf8'));
/** legs[0] S6 22:35→23:03 Frankfurt Süd, legs[1] Fußweg 5 min, legs[2] NJ 409 ab 23:34 (Plan 23:28) → Berlin 06:22 */
const base = () => motisJourney(plan.itineraries[1]);
/** ICE 1272 Frankfurt Hbf 22:40 → Berlin (ohne Echtzeit) */
const ice = () => motisJourney(plan.itineraries[0]);
const at = (iso: string) => Date.parse(iso);

test('kein Auslöser, solange alles passt', () => {
  assert.equal(alternativesTrigger(base(), emptyBoarding(), at('2026-11-14T22:40:00Z')), null);
});

test('Umstieg nicht erreichbar → ab Umstiegshalt, ab erwarteter Ankunft', () => {
  const j = base();
  j.legs[0].to.arrival = '2026-11-14T23:31:00Z'; // S6 +28 → nur 3 min für 5 min Weg
  const t = alternativesTrigger(j, emptyBoarding(), at('2026-11-14T22:50:00Z'));
  assert.ok(t);
  assert.equal(t.reason, 'connection');
  assert.equal(t.keepLegs, 1);
  assert.equal(t.origin.name, 'Frankfurt (Main) Südbahnhof');
  assert.equal(t.time, '2026-11-14T23:31:00Z');
  assert.equal(t.line, j.legs[2].line);
  assert.equal(t.key, `connection:1:${j.legs[0].to.stop.id}`);
  assert.equal(liftedFor(j, t), true);
  // nach dem Umstieg (in den NJ eingecheckt) kein Auslöser mehr
  const b = applyBoarding(j, emptyBoarding(), 2, 'checkin');
  assert.equal(alternativesTrigger(j, b, at('2026-11-14T23:40:00Z')), null);
});

test('Anschluss fällt aus → Grund „cancelled“', () => {
  const j = base();
  j.legs[2].cancelled = true;
  const t = alternativesTrigger(j, emptyBoarding(), at('2026-11-14T22:50:00Z'));
  assert.equal(t?.reason, 'cancelled');
  assert.equal(t?.keepLegs, 1);
});

test('erster Zug fällt aus → ab Starthalt', () => {
  const j = ice();
  j.legs[0].cancelled = true;
  const t = alternativesTrigger(j, emptyBoarding(), at('2026-11-14T22:00:00Z'));
  assert.equal(t?.reason, 'cancelled');
  assert.equal(t?.keepLegs, 0);
  assert.equal(t?.origin.name, 'Frankfurt (Main) Hauptbahnhof');
  assert.equal(t?.time, '2026-11-14T22:40:00Z');
});

test('Zug selbst verpasst → ab Einstiegshalt, ab jetzt; Zugbindung bleibt', () => {
  const j = base();
  const b = applyBoarding(j, emptyBoarding(), 0, 'missed');
  const t = alternativesTrigger(j, b, at('2026-11-14T22:45:00Z'));
  assert.equal(t?.reason, 'missed-train');
  assert.equal(t?.keepLegs, 0);
  assert.equal(t?.time, '2026-11-14T22:45:00.000Z');
  assert.equal(liftedFor(j, t!), false);
});

test('Ticket-Abdeckung je Alternative', () => {
  const alt = ice();
  const spar = { ticket: 'spar' as const, hasDTicket: true };
  assert.deepEqual(rateAlternative(alt, spar, { bindingLifted: true, bookedTripIds: [] }).coverage, ['binding-lifted']);
  const notLifted = rateAlternative(alt, spar, { bindingLifted: false, bookedTripIds: [] });
  assert.equal(notLifted.covered, false);
  assert.equal(rateAlternative(alt, spar, { bindingLifted: false, bookedTripIds: [alt.legs[0].tripId!] }).covered, true);
  const local = rateAlternative(base(), { ticket: 'dticket', hasDTicket: true }, { bindingLifted: false, bookedTripIds: [] });
  assert.deepEqual(local.coverage, ['dticket', 'ticket', 'not-covered']);
});

test('Restreise ersetzen: gefahrene Abschnitte bleiben, Check-ins danach entfallen', () => {
  const j = { ...base(), title: { from: 'Darmstadt Hbf', to: 'Berlin Hbf' } };
  const b = applyBoarding(j, applyBoarding(j, emptyBoarding(), 0, 'checkin'), 2, 'missed');
  const alt = ice();
  const r = replaceRemainder(j, b, 1, alt);
  assert.equal(r.journey.legs.length, 2);
  assert.equal(r.journey.legs[0], j.legs[0]);
  assert.equal(r.journey.legs[1].line, 'ICE 1272');
  assert.deepEqual(r.journey.title, j.title);
  assert.deepEqual(r.boarding.checkins.map((e) => e.leg), [0]);
  assert.deepEqual(r.boarding.missed, []);
});
