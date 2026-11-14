/**
 * Check-in: In welchem Zug sitzt die reisende Person tatsächlich?
 *
 * - Check-in je Fahrt-Abschnitt („Ich bin eingestiegen“). Ab dann gilt sie als an Bord, bis der Zug am Ausstiegshalt ist.
 * - Ist der nächste Zug ohne Check-in abgefahren, fragt die Oberfläche nach („Zug verpasst?“).
 * - „Verpasst“ markiert den Abschnitt; die Oberfläche bietet dann eine neue Verbindung ab dem Einstiegshalt an.
 */
import { arrTime, depTime, ms } from './journey.ts';
import type { Journey, Leg } from './types.ts';

export interface BoardingEvent {
  /** Index in journey.legs (nur Fahrt-Abschnitte) */
  leg: number;
  at: string;
}

export interface Boarding {
  checkins: BoardingEvent[];
  missed: BoardingEvent[];
}

export const emptyBoarding = (): Boarding => ({ checkins: [], missed: [] });

/** Nachfrage frühestens so lange vor Abfahrt anbieten */
export const CHECKIN_WINDOW_MIN = 30;
/** „Zug verpasst?“ erst, wenn der Zug so lange weg ist */
export const MISSED_GRACE_MIN = 2;
/** Nach Ankunft noch so lange als „an Bord“ zählen (Aussteigen) */
const ALIGHT_GRACE_MS = 2 * 60_000;

export type BoardingPrompt =
  /** nächster Zug fährt bald bzw. steht bereit: „Eingestiegen“ anbieten */
  | { kind: 'checkin'; leg: number }
  /** Zug ist ohne Check-in abgefahren */
  | { kind: 'missed?'; leg: number }
  /** als verpasst markiert: neue Verbindung ab dem Einstiegshalt anbieten */
  | { kind: 'missed'; leg: number };

export interface BoardingState {
  /** Abschnitt, in dem die Person laut Check-in sitzt */
  onBoard: number | null;
  /** zuletzt eingecheckter Abschnitt (auch wenn schon ausgestiegen) */
  lastCheckin: number | null;
  /** nächster Fahrt-Abschnitt ohne Check-in */
  next: number | null;
  prompt: BoardingPrompt | null;
}

export function isRide(j: Journey, leg: unknown): leg is number {
  return typeof leg === 'number' && Number.isInteger(leg) && j.legs[leg]?.kind === 'ride';
}

/** Check-in, Verpasst oder Zurücknehmen anwenden (ungültige Abschnitte → unverändert) */
export function applyBoarding(j: Journey, b: Boarding, leg: number, action: 'checkin' | 'missed' | 'undo', at = new Date().toISOString()): Boarding {
  if (!isRide(j, leg)) return b;
  const checkins = b.checkins.filter((e) => e.leg !== leg);
  const missed = b.missed.filter((e) => e.leg !== leg);
  if (action === 'checkin') {
    // Ein späterer Check-in ersetzt Nachfragen zu früheren Abschnitten nicht – sie sind erledigt
    return { checkins: [...checkins, { leg, at }].sort((x, y) => x.leg - y.leg), missed: missed.filter((e) => e.leg > leg) };
  }
  if (action === 'missed') return { checkins, missed: [...missed, { leg, at }].sort((x, y) => x.leg - y.leg) };
  return { checkins, missed };
}

export function boardingState(j: Journey, b: Boarding | undefined, now = Date.now()): BoardingState {
  const rides = j.legs.flatMap((l, i) => (l.kind === 'ride' ? [i] : []));
  const checked = new Set((b?.checkins ?? []).map((e) => e.leg));
  const missed = new Set((b?.missed ?? []).map((e) => e.leg));
  const lastCheckin = rides.filter((i) => checked.has(i)).at(-1) ?? null;

  let onBoard: number | null = null;
  if (lastCheckin !== null) {
    const arr = ms(arrTime(j.legs[lastCheckin].to));
    if (!(now > arr + ALIGHT_GRACE_MS)) onBoard = lastCheckin;
  }

  // nächster Abschnitt: nach dem letzten Check-in, ohne Check-in, noch nicht am Ziel angekommen
  const next =
    rides.find((i) => (lastCheckin === null || i > lastCheckin) && !checked.has(i) && (missed.has(i) || now < ms(arrTime(j.legs[i].to)))) ?? null;
  let prompt: BoardingPrompt | null = null;
  const firstMissed = rides.find((i) => missed.has(i) && (lastCheckin === null || i > lastCheckin));
  if (firstMissed !== undefined) prompt = { kind: 'missed', leg: firstMissed };
  else if (next !== null && onBoard === null) {
    const l: Leg = j.legs[next];
    const dep = ms(depTime(l.from));
    const arr = ms(arrTime(l.to));
    if (!l.cancelled && now > dep + MISSED_GRACE_MIN * 60_000 && now < arr) prompt = { kind: 'missed?', leg: next };
    else if (now >= dep - CHECKIN_WINDOW_MIN * 60_000 && now < arr) prompt = { kind: 'checkin', leg: next };
  }
  return { onBoard, lastCheckin, next, prompt };
}
