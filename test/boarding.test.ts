import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyBoarding, boardingState, emptyBoarding } from '../src/core/boarding.ts';
import { motisJourney } from '../src/core/motis.ts';
import { progress, transfers } from '../src/core/progress.ts';

const plan = JSON.parse(readFileSync(new URL('./fixtures/plan-darmstadt-berlin.json', import.meta.url), 'utf8'));
/** legs[0] S6 22:35→23:03 (Frankfurt Süd), legs[1] Fußweg, legs[2] NJ 409 ab 23:34 (Plan 23:28) → Berlin 06:22 */
const j = motisJourney(plan.itineraries[1]);
const at = (iso: string) => Date.parse(iso);

test('Nachfrage: Check-in erst 30 min vor Abfahrt, „verpasst?“ 2 min nach Abfahrt', () => {
  const b = emptyBoarding();
  assert.equal(boardingState(j, b, at('2026-11-14T22:00:00Z')).prompt, null);
  assert.deepEqual(boardingState(j, b, at('2026-11-14T22:10:00Z')).prompt, { kind: 'checkin', leg: 0 });
  assert.deepEqual(boardingState(j, b, at('2026-11-14T22:36:00Z')).prompt, { kind: 'checkin', leg: 0 });
  assert.deepEqual(boardingState(j, b, at('2026-11-14T22:40:00Z')).prompt, { kind: 'missed?', leg: 0 });
});

test('Check-in: an Bord, danach Nachfrage für den Anschluss', () => {
  const b = applyBoarding(j, emptyBoarding(), 0, 'checkin', '2026-11-14T22:36:00Z');
  const riding = boardingState(j, b, at('2026-11-14T22:40:00Z'));
  assert.equal(riding.onBoard, 0);
  assert.equal(riding.prompt, null);
  const p = progress(j, at('2026-11-14T22:40:00Z'), b).phase;
  assert.equal(p.kind, 'riding');
  if (p.kind === 'riding') assert.equal(p.onBoard, true);

  // ausgestiegen (S6 an 23:03 + 2 min), NJ fährt 23:34 → Check-in anbieten
  const change = boardingState(j, b, at('2026-11-14T23:10:00Z'));
  assert.equal(change.onBoard, null);
  assert.deepEqual(change.prompt, { kind: 'checkin', leg: 2 });
  assert.equal(transfers(j, { boarding: b })[0].state, 'ok');

  const b2 = applyBoarding(j, b, 2, 'checkin', '2026-11-14T23:30:00Z');
  assert.equal(transfers(j, { boarding: b2 })[0].state, 'done');
  // eingecheckt, obwohl der Zug laut Daten noch nicht abgefahren ist → trotzdem „unterwegs“
  const early = progress(j, at('2026-11-14T23:31:00Z'), b2).phase;
  assert.equal(early.kind, 'riding');
  if (early.kind === 'riding') assert.equal(early.legIndex, 2);
});

test('Verpasst markieren, zurücknehmen, doch eingestiegen', () => {
  const missed = applyBoarding(j, emptyBoarding(), 2, 'missed', '2026-11-14T23:40:00Z');
  assert.deepEqual(boardingState(j, missed, at('2026-11-14T23:45:00Z')).prompt, { kind: 'missed', leg: 2 });
  assert.deepEqual(applyBoarding(j, missed, 2, 'undo'), emptyBoarding());
  const boarded = applyBoarding(j, missed, 2, 'checkin', '2026-11-14T23:46:00Z');
  assert.deepEqual(boarded.missed, []);
  assert.equal(boardingState(j, boarded, at('2026-11-14T23:50:00Z')).onBoard, 2);
});

test('Ohne Check-in: vergangene Abschnitte blockieren spätere Nachfragen nicht; Fußwege sind kein Check-in', () => {
  // S6 ist vorbei, NJ läuft seit 23:34 → Nachfrage für den NJ
  assert.deepEqual(boardingState(j, emptyBoarding(), at('2026-11-15T02:00:00Z')).prompt, { kind: 'missed?', leg: 2 });
  assert.deepEqual(applyBoarding(j, emptyBoarding(), 1, 'checkin'), emptyBoarding());
  assert.deepEqual(applyBoarding(j, emptyBoarding(), 99, 'checkin'), emptyBoarding());
  // nach Ankunft keine Nachfrage mehr
  assert.equal(boardingState(j, emptyBoarding(), at('2026-11-15T07:00:00Z')).prompt, null);
});
