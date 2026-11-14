import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { motisJourney, motisLeg } from '../src/motis.ts';
import { progress, transfers } from '../src/progress.ts';
import { cutLeg, refreshJourney } from '../src/refresh.ts';
import { bindingLifted, coverage, searchModes } from '../src/tickets.ts';
import { transitModes } from '../src/transitous.ts';
import type { Journey } from '../src/types.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const plan = fixture('plan-darmstadt-berlin.json');
const trip = fixture('trip-nj409.json');

/** Darmstadt Hbf → S6 → Frankfurt Süd → NJ 409 → Berlin Hbf (Echtzeit NJ +6) */
const nightJourney = (): Journey => motisJourney(plan.itineraries[1]);
const clone = <T>(x: T): T => structuredClone(x);
const at = (iso: string) => Date.parse(iso);

test('MOTIS-Verbindung wird umgewandelt', () => {
  const j = nightJourney();
  assert.deepEqual(
    j.legs.map((l) => l.kind),
    ['ride', 'walk', 'ride'],
  );
  const nj = j.legs[2];
  assert.equal(nj.mode, 'longdistance');
  assert.equal(nj.number, '409');
  assert.equal(nj.from.stop.name, 'Frankfurt (Main) Südbahnhof');
  assert.equal(nj.from.plannedDeparture, '2026-11-14T23:28:00Z');
  assert.equal(nj.from.departure, '2026-11-14T23:34:00Z');
  assert.equal(nj.realtime, true);
  assert.equal(j.legs[1].walkMin, 5);
  assert.equal(j.legs[0].line, 'S6');
  assert.equal(j.legs[0].number, '36680');
});

test('ohne Echtzeit bleibt nur die Planzeit', () => {
  const ice = motisJourney(plan.itineraries[0]).legs[0];
  assert.equal(ice.line, 'ICE 1272');
  assert.equal(ice.realtime, false);
  assert.equal(ice.from.departure, undefined);
  assert.equal(ice.from.plannedDeparture, '2026-11-14T22:40:00Z');
  assert.equal(ice.from.track, '3');
});

test('Fortschritt: vor Abfahrt, unterwegs, Umstieg, angekommen', () => {
  const j = nightJourney();
  assert.equal(progress(j, at('2026-11-14T22:00:00Z')).phase.kind, 'before');

  const riding = progress(j, at('2026-11-14T22:40:00Z')).phase;
  assert.equal(riding.kind, 'riding');
  if (riding.kind === 'riding') assert.equal(riding.legIndex, 0);

  const transfer = progress(j, at('2026-11-14T23:10:00Z')).phase;
  assert.equal(transfer.kind, 'transfer');
  if (transfer.kind === 'transfer') {
    assert.equal(transfer.at.stop.name, 'Frankfurt (Main) Südbahnhof');
    assert.equal(transfer.departsAt, '2026-11-14T23:34:00Z');
  }

  const night = progress(j, at('2026-11-15T02:00:00Z'));
  assert.equal(night.phase.kind, 'riding');
  if (night.phase.kind === 'riding') assert.equal(night.phase.legIndex, 2);
  assert.ok(night.fraction > 0.3 && night.fraction < 0.6);

  const done = progress(j, at('2026-11-15T07:00:00Z'));
  assert.equal(done.phase.kind, 'arrived');
  assert.equal(done.fraction, 1);
});

test('Umstiege: ok, knapp, verpasst, Ausfall', () => {
  const j = nightJourney();
  const [tr] = transfers(j);
  assert.equal(tr.at, 'Frankfurt (Main) Südbahnhof');
  assert.equal(tr.state, 'ok');
  assert.equal(tr.bufferMin, 31);
  assert.equal(tr.neededMin, 5);

  const tight = clone(j);
  tight.legs[0].to.arrival = '2026-11-14T23:27:00Z';
  assert.equal(transfers(tight)[0].state, 'tight');

  const missed = clone(j);
  missed.legs[0].to.arrival = '2026-11-14T23:31:00Z';
  assert.equal(transfers(missed)[0].state, 'missed');

  const cancelled = clone(j);
  cancelled.legs[2].cancelled = true;
  assert.equal(transfers(cancelled)[0].state, 'cancelled');
});

test('Fahrtverlauf: gebuchten Teil ausschneiden', () => {
  const booked = nightJourney().legs[2];
  const legs = trip.legs.map(motisLeg);
  const cut = cutLeg(booked, legs);
  assert.ok(cut);
  assert.equal(cut.from.stop.name, 'Frankfurt (Main) Südbahnhof');
  assert.equal(cut.from.departure, '2026-11-14T23:35:00Z');
  assert.equal(cut.from.arrival, undefined);
  assert.deepEqual(
    cut.stopovers.map((s) => s.stop.name),
    ['Leipzig Hbf', 'S Südkreuz Bhf (Berlin)'],
  );
  assert.equal(cut.to.stop.name, 'S+U Berlin Hauptbahnhof');
  assert.equal(cut.to.departure, undefined);
});

test('Auffrischen: Fehler bei einer Fahrt behält den alten Stand', async () => {
  const j = nightJourney();
  const res = await refreshJourney(j, async (id) => {
    if (id === j.legs[2].tripId) return trip.legs.map(motisLeg);
    throw new Error('offline');
  });
  assert.deepEqual(res.failed, [j.legs[0].tripId]);
  assert.equal(res.journey.legs[0], j.legs[0]);
  assert.equal(res.journey.legs[2].from.departure, '2026-11-14T23:35:00Z');
});

test('Tickets: Suche und Zugbindung', () => {
  assert.equal(searchModes({ ticket: 'other', hasDTicket: true }), undefined);
  assert.ok(!searchModes({ ticket: 'flex', hasDTicket: true })?.includes('coach'));
  assert.ok(searchModes({ ticket: 'spar', hasDTicket: false })?.includes('highspeed'));
  assert.equal(coverage('coach', { ticket: 'bc100', hasDTicket: true }), 'not-covered');
  assert.ok(searchModes({ ticket: 'dticket', hasDTicket: true })?.every((m) => !['highspeed', 'longdistance', 'night', 'coach'].includes(m)));
  assert.equal(transitModes(['regional', 'tram']), 'REGIONAL_FAST_RAIL,REGIONAL_RAIL,TRAM,CABLE_CAR,FUNICULAR');

  const spar = { ticket: 'spar' as const, hasDTicket: true };
  assert.equal(coverage('highspeed', spar), 'not-covered');
  assert.equal(coverage('highspeed', spar, { bindingLifted: true }), 'binding-lifted');
  assert.equal(coverage('regional', spar), 'dticket');
  assert.equal(coverage('regional', { ticket: 'spar', hasDTicket: false }), 'not-covered');
  assert.equal(coverage('highspeed', { ticket: 'dticket', hasDTicket: true }), 'not-covered');
  assert.equal(coverage('highspeed', { ticket: 'bc100', hasDTicket: false }), 'ticket');

  const j = nightJourney();
  assert.equal(bindingLifted(j).lifted, false);
  const late = clone(j);
  late.legs[2].to.arrival = '2026-11-15T06:45:00Z';
  assert.deepEqual(bindingLifted(late), { lifted: true, reason: 'delay', delayMin: 23 });
  const missed = clone(j);
  missed.legs[0].to.arrival = '2026-11-14T23:31:00Z';
  assert.equal(bindingLifted(missed).reason, 'connection');
});
