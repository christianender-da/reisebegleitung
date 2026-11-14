/**
 * Live-Fortschritt einer Reise und Prüfung der Umstiege.
 */
import { allStops, arrDelay, arrTime, depTime, journeyEnd, journeyPlannedEnd, journeyStart, ms } from './journey.ts';
import type { Journey, Leg, Stopover } from './types.ts';

export type Phase =
  /** vor der ersten Abfahrt */
  | { kind: 'before'; legIndex: number; departsAt: string }
  /** in einem Verkehrsmittel unterwegs */
  | {
      kind: 'riding';
      legIndex: number;
      /** zuletzt erreichter/passierter Halt */
      last: Stopover;
      /** nächster Halt */
      next: Stopover;
      /** Fortschritt im Abschnitt (0–1) */
      fraction: number;
    }
  /** beim Umsteigen (zwischen zwei Fahrten) */
  | { kind: 'transfer'; legIndex: number; at: Stopover; departsAt: string }
  | { kind: 'arrived'; arrivedAt: string };

export interface Progress {
  phase: Phase;
  /** Gesamtfortschritt nach Zeit (0–1) */
  fraction: number;
  /** erwartete Ankunft am Ziel (Echtzeit, sonst Plan) */
  arrival?: string;
  plannedArrival?: string;
  /** Verspätung am Ziel in Minuten (ohne Echtzeit undefined) */
  delayMin?: number;
}

const clamp = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function rideIndexes(j: Journey): number[] {
  return j.legs.flatMap((l, i) => (l.kind === 'ride' ? [i] : []));
}

/** Wo im Abschnitt befindet sich die Fahrt zum Zeitpunkt now? */
function positionInLeg(l: Leg, now: number): { last: Stopover; next: Stopover; fraction: number } {
  const stops = allStops(l);
  let lastIdx = 0;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    // Halt gilt als erreicht, sobald die Ankunft (bzw. am Start die Abfahrt) vorbei ist
    const t = ms(i === 0 ? depTime(s) : arrTime(s) ?? depTime(s));
    if (Number.isFinite(t) && t <= now) lastIdx = i;
  }
  const nextIdx = Math.min(lastIdx + 1, stops.length - 1);
  const start = ms(depTime(l.from));
  const end = ms(arrTime(l.to));
  return { last: stops[lastIdx], next: stops[nextIdx], fraction: clamp((now - start) / (end - start)) };
}

export function progress(j: Journey, now = Date.now()): Progress {
  const start = ms(journeyStart(j));
  const endIso = journeyEnd(j);
  const end = ms(endIso);
  const plannedArrival = journeyPlannedEnd(j);
  const last = j.legs.at(-1);
  const base = {
    fraction: clamp((now - start) / (end - start)),
    arrival: endIso,
    plannedArrival,
    delayMin: last ? arrDelay(last.to) : undefined,
  };
  const ridesIdx = rideIndexes(j);
  if (!ridesIdx.length) return { ...base, phase: { kind: 'arrived', arrivedAt: endIso ?? '' } };

  for (let k = 0; k < ridesIdx.length; k++) {
    const i = ridesIdx[k];
    const l = j.legs[i];
    const dep = ms(depTime(l.from));
    const arr = ms(arrTime(l.to));
    if (now < dep) {
      if (k === 0) return { ...base, phase: { kind: 'before', legIndex: i, departsAt: depTime(l.from)! } };
      const prev = j.legs[ridesIdx[k - 1]];
      return { ...base, phase: { kind: 'transfer', legIndex: i, at: prev.to, departsAt: depTime(l.from)! } };
    }
    if (now < arr) return { ...base, phase: { kind: 'riding', legIndex: i, ...positionInLeg(l, now) } };
  }
  if (now < end) {
    // Fußweg am Ende
    const lastRide = j.legs[ridesIdx.at(-1)!];
    return { ...base, phase: { kind: 'transfer', legIndex: j.legs.length - 1, at: lastRide.to, departsAt: depTime(last!.from) ?? '' } };
  }
  return { ...base, fraction: 1, phase: { kind: 'arrived', arrivedAt: endIso ?? '' } };
}

export type TransferState = 'ok' | 'tight' | 'missed' | 'cancelled';

export interface Transfer {
  /** Index des ankommenden und des abfahrenden Abschnitts in journey.legs */
  fromLeg: number;
  toLeg: number;
  at: string;
  /** verfügbare Zeit laut Echtzeit (Minuten) */
  bufferMin: number;
  /** verfügbare Zeit laut Plan (Minuten) */
  plannedBufferMin: number;
  /** nötige Zeit (Fußweg, mindestens minTransferMin) */
  neededMin: number;
  state: TransferState;
}

export interface TransferOptions {
  /** Mindestumstiegszeit ohne eigenen Fußweg (Standard 2 min) */
  minTransferMin?: number;
  /** „knapp“, wenn der Puffer weniger als so viele Minuten über der nötigen Zeit liegt (Standard 3) */
  tightMarginMin?: number;
}

/** Alle Umstiege zwischen aufeinanderfolgenden Fahrten mit Ampel */
export function transfers(j: Journey, opt: TransferOptions = {}): Transfer[] {
  const minTransfer = opt.minTransferMin ?? 2;
  const margin = opt.tightMarginMin ?? 3;
  const idx = rideIndexes(j);
  const out: Transfer[] = [];
  for (let k = 1; k < idx.length; k++) {
    const a = j.legs[idx[k - 1]];
    const b = j.legs[idx[k]];
    const walk = j.legs.slice(idx[k - 1] + 1, idx[k]).reduce((sum, l) => sum + (l.walkMin ?? 0), 0);
    const needed = Math.max(walk, minTransfer);
    const buffer = Math.round((ms(depTime(b.from)) - ms(arrTime(a.to))) / 60_000);
    const planned = Math.round((ms(b.from.plannedDeparture) - ms(a.to.plannedArrival)) / 60_000);
    let state: TransferState = 'ok';
    if (b.cancelled || b.from.cancelled || a.cancelled || a.to.cancelled) state = 'cancelled';
    else if (buffer < needed) state = 'missed';
    else if (buffer < needed + margin) state = 'tight';
    out.push({ fromLeg: idx[k - 1], toLeg: idx[k], at: a.to.stop.name, bufferMin: buffer, plannedBufferMin: planned, neededMin: needed, state });
  }
  return out;
}
