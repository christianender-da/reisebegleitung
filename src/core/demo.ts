/**
 * Testfahrt ab der „Testhaltestelle“: zeigt alle Zustände der Reisebegleitung live, ohne echte Fahrplandaten.
 *
 * Die Reise ist immer dieselbe; ihre Uhrzeiten werden bei jedem Abruf so verschoben, dass „jetzt“ in einer bestimmten
 * Szene liegt. Die Szene wechselt jede Minute (Schleife über DEMO_SCENES):
 *
 *   vor Abfahrt → im Bus → Umstieg gemütlich (≥ 10 min Puffer) → in der Tram → Umstieg zügig (4–10 min) →
 *   im Regionalzug (+2, Gleiswechsel) → Umstieg knapp (< 4 min, rennt) → in der S-Bahn (+9 → Anschluss an den IC
 *   nicht erreichbar, Alternativen) → angekommen
 *
 * Zusätzlich: Steige (Bus/Tram), Gleise mit Gleiswechsel, Verspätungen, ein ausfallender Zwischenhalt.
 * Alle Halte haben IDs mit „demo:“ – daran erkennt der Server die Testfahrt (keine Transitous-/IRIS-Abfragen,
 * keine Benachrichtigungen).
 */
import type { Journey, Leg, Mode, StopHit, Stopover } from './types.ts';

export const DEMO_PREFIX = 'demo:';
export const DEMO_STOP: StopHit = { id: 'demo:testhaltestelle', name: 'Testhaltestelle', place: 'Testfahrt', modes: ['bus', 'tram', 'regional', 'suburban', 'longdistance'] };
const DEMO_DEST = 'Testhausen Hbf';

/** Passt die Eingabe zur Testhaltestelle? (ab 4 Zeichen, z. B. „Test“, „testhalt“) */
export function matchesDemo(q: string): boolean {
  const t = q.trim().toLowerCase();
  return t.length >= 4 && (DEMO_STOP.name.toLowerCase().startsWith(t) || t.startsWith('testhalt'));
}

export const isDemoStop = (id: string | undefined) => !!id?.startsWith(DEMO_PREFIX);
export const isDemoJourney = (j: Journey) => j.legs.some((l) => isDemoStop(l.from.stop.id) || isDemoStop(l.to.stop.id));

/** Szenen: Minuten ab Abfahrt, bei denen „jetzt“ liegt (Abfahrt Bus = 0) */
export const DEMO_SCENES = [
  { key: 'before', at: -4 },
  { key: 'bus', at: 3 },
  { key: 'transfer-slow', at: 12 },
  { key: 'tram', at: 23 },
  { key: 'transfer-normal', at: 30 },
  { key: 'train', at: 41 },
  { key: 'transfer-fast', at: 50 },
  { key: 'missed', at: 60 },
  { key: 'arrived', at: 100 },
] as const;

export const DEMO_SCENE_MS = 60_000;

export interface DemoScene {
  index: number;
  key: (typeof DEMO_SCENES)[number]['key'];
  /** Abfahrt des Busses (ms) */
  start: number;
  /** wann die nächste Szene beginnt (ms) */
  next: number;
}

/**
 * Aktuelle Szene; start so gewählt, dass „jetzt“ (ganze Minute) in der Szene liegt.
 * since: Beginn der Schleife (z. B. Anlegen der Reise) – dann startet die Testfahrt mit „vor Abfahrt“.
 */
export function demoScene(now: number, since = 0): DemoScene {
  const minute = Math.floor(now / DEMO_SCENE_MS);
  const n = DEMO_SCENES.length;
  const index = (((minute - Math.floor(since / DEMO_SCENE_MS)) % n) + n) % n;
  const s = DEMO_SCENES[index];
  return { index, key: s.key, start: minute * DEMO_SCENE_MS - s.at * 60_000, next: (minute + 1) * DEMO_SCENE_MS };
}

const iso = (start: number, min: number) => new Date(start + min * 60_000).toISOString();

function stop(start: number, name: string, o: { dep?: number; arr?: number; depDelay?: number; arrDelay?: number; track?: string; plannedTrack?: string; cancelled?: boolean }): Stopover {
  return {
    stop: { id: `${DEMO_PREFIX}${name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}`, name },
    plannedDeparture: o.dep !== undefined ? iso(start, o.dep) : undefined,
    departure: o.dep !== undefined ? iso(start, o.dep + (o.depDelay ?? 0)) : undefined,
    plannedArrival: o.arr !== undefined ? iso(start, o.arr) : undefined,
    arrival: o.arr !== undefined ? iso(start, o.arr + (o.arrDelay ?? 0)) : undefined,
    plannedTrack: o.plannedTrack ?? o.track,
    track: o.track,
    cancelled: o.cancelled || undefined,
  };
}

function ride(mode: Mode, line: string, from: Stopover, to: Stopover, stopovers: Stopover[] = [], number?: string): Leg {
  return { kind: 'ride', mode, line, number, headsign: to.stop.name, tripId: `${DEMO_PREFIX}${line}`, from, to, stopovers, cancelled: false, realtime: true };
}

function walk(start: number, at: Stopover, from: number, min: number): Leg {
  const s = { stop: at.stop };
  return {
    kind: 'walk',
    mode: 'walk',
    walkMin: min,
    from: { ...s, plannedDeparture: iso(start, from), departure: iso(start, from) },
    to: { ...s, plannedArrival: iso(start, from + min), arrival: iso(start, from + min) },
    stopovers: [],
    cancelled: false,
    realtime: false,
  };
}

/** Die Testfahrt mit Abfahrt des Busses um `start` (ms) */
export function demoJourney(start: number): Journey {
  const s = (name: string, o: Parameters<typeof stop>[2]) => stop(start, name, o);
  const musterplatz = s('Musterplatz', { arr: 6, track: 'C' });
  const bahnhof = s('Beispielbahnhof', { arr: 26, track: '2' });
  const probestadt = s('Probestadt Hbf', { arr: 45, arrDelay: 2, track: '7' });
  const messe = s('Demo-Messe', { arr: 60, arrDelay: 9, track: '2' });
  return {
    title: { from: DEMO_STOP.name, to: DEMO_DEST },
    legs: [
      // Bus mit Steigen
      ride('bus', '42', s(DEMO_STOP.name, { dep: 0, track: 'A' }), musterplatz, [s('Am Testweg', { arr: 3 })]),
      walk(start, musterplatz, 6, 2),
      // Tram: 14 min Umstieg bei 2 min Fußweg → gemütlich
      ride('tram', '7', s('Musterplatz', { dep: 20, track: '1' }), bahnhof, [s('Probegasse', { arr: 23 })]),
      walk(start, bahnhof, 26, 3),
      // Regionalzug: 9 min bei 3 min Fußweg → zügig; Gleiswechsel 3 → 4, +2 bei Ankunft
      ride('regional', 'RE 99', s('Beispielbahnhof', { dep: 35, track: '4', plannedTrack: '3' }), probestadt, [s('Zwischenort', { arr: 40, arrDelay: 1 })], '4711'),
      walk(start, probestadt, 47, 4),
      // S-Bahn: 6 min (wegen +2) bei 4 min Fußweg → knapp, rennen; selbst +9 → IC nicht erreichbar
      ride('suburban', 'S9', s('Probestadt Hbf', { dep: 53, track: '1' }), messe, [s('Testpark', { arr: 56, arrDelay: 5 })]),
      walk(start, messe, 69, 5),
      // IC: Anschluss verpasst; ein Zwischenhalt fällt aus
      ride(
        'longdistance',
        'IC 2026',
        s('Demo-Messe', { dep: 66, track: '5' }),
        s(DEMO_DEST, { arr: 95, track: '11' }),
        [s('Ausfallstadt', { arr: 78, cancelled: true }), s('Mittelhausen', { arr: 86 })],
        '2026',
      ),
    ],
  };
}

/** Alternativen ab „Demo-Messe“ (mit unterschiedlicher Ticket-Abdeckung, inkl. Fähre) */
export function demoAlternativeJourneys(start: number): Journey[] {
  const s = (name: string, o: Parameters<typeof stop>[2]) => stop(start, name, o);
  return [
    { legs: [ride('longdistance', 'IC 2028', s('Demo-Messe', { dep: 80, track: '5' }), s(DEMO_DEST, { arr: 109, track: '12' }), [s('Mittelhausen', { arr: 100 })], '2028')] },
    { legs: [ride('regional', 'RB 12', s('Demo-Messe', { dep: 76, track: '3' }), s(DEMO_DEST, { arr: 118, track: '1' }), [s('Mittelhausen', { arr: 104 })], '8120')] },
    {
      legs: [
        ride('ferry', 'Fähre F1', s('Demo-Messe Anleger', { dep: 82 }), s('Seeufer', { arr: 97 })),
        ride('coach', 'FB 99', s('Seeufer', { dep: 101, track: 'B' }), s(DEMO_DEST, { arr: 125, track: 'Z' })),
      ],
    },
  ];
}
