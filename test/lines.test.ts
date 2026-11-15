import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineName } from '../src/core/lines.ts';

test('Linienname mit Verkehrsmittel', () => {
  assert.equal(lineName('42', 'bus'), 'Bus 42');
  assert.equal(lineName('X1', 'bus'), 'Bus X1');
  assert.equal(lineName('7', 'tram'), 'Tram 7');
  assert.equal(lineName('M10', 'tram'), 'Tram M10');
  assert.equal(lineName('F1', 'ferry'), 'Fähre F1');
  assert.equal(lineName('Fähre F1', 'ferry'), 'Fähre F1');
  assert.equal(lineName('Bus 42', 'bus'), 'Bus 42');
  assert.equal(lineName('FB 99', 'coach'), 'Fernbus FB 99');
  // Züge: Name sagt schon, was es ist
  assert.equal(lineName('ICE 375', 'highspeed'), 'ICE 375');
  assert.equal(lineName('RE 99', 'regional'), 'RE 99');
  assert.equal(lineName('S9', 'suburban'), 'S9');
  assert.equal(lineName('U4', 'subway'), 'U4');
  // nur Nummer
  assert.equal(lineName('4711', 'regional'), 'Zug 4711');
  assert.equal(lineName('4711', 'regional', 'en'), 'Train 4711');
  assert.equal(lineName('42', 'bus', 'en'), 'Bus 42');
  // ohne Angaben
  assert.equal(lineName(undefined, 'bus'), 'Bus');
  assert.equal(lineName('42', undefined), '42');
  assert.equal(lineName(undefined, undefined), '?');
});
