/** Hilfen rund um Zeiten, Verspätungen und Abschnitte einer Reise */
import type { Journey, Leg, Stopover } from './types.ts';

/** Tatsächliche (bzw. erwartete) Abfahrt, sonst Plan */
export function depTime(s: Stopover): string | undefined {
  return s.departure ?? s.plannedDeparture;
}

/** Tatsächliche (bzw. erwartete) Ankunft, sonst Plan */
export function arrTime(s: Stopover): string | undefined {
  return s.arrival ?? s.plannedArrival;
}

export function ms(iso: string | undefined): number {
  return iso ? Date.parse(iso) : NaN;
}

/** Verspätung in ganzen Minuten (negativ = zu früh); undefined ohne Echtzeit */
export function delayMin(planned?: string, actual?: string): number | undefined {
  if (!planned || !actual) return undefined;
  return Math.round((Date.parse(actual) - Date.parse(planned)) / 60_000);
}

export function depDelay(s: Stopover) {
  return delayMin(s.plannedDeparture, s.departure);
}

export function arrDelay(s: Stopover) {
  return delayMin(s.plannedArrival, s.arrival);
}

/** Abschnitte in einem Verkehrsmittel (ohne Fußwege) */
export function rides(j: Journey): Leg[] {
  return j.legs.filter((l) => l.kind === 'ride');
}

export function firstRide(j: Journey): Leg | undefined {
  return rides(j)[0];
}

export function lastRide(j: Journey): Leg | undefined {
  return rides(j).at(-1);
}

/** Abfahrt am Start (Echtzeit, sonst Plan) */
export function journeyStart(j: Journey): string | undefined {
  const l = j.legs[0];
  return l ? depTime(l.from) : undefined;
}

export function journeyPlannedStart(j: Journey): string | undefined {
  return j.legs[0]?.from.plannedDeparture;
}

/** Ankunft am Ziel (Echtzeit, sonst Plan) */
export function journeyEnd(j: Journey): string | undefined {
  const l = j.legs.at(-1);
  return l ? arrTime(l.to) : undefined;
}

export function journeyPlannedEnd(j: Journey): string | undefined {
  return j.legs.at(-1)?.to.plannedArrival;
}

/** Start- und Zielname (erster/letzter Halt der Reise) */
export function journeyEnds(j: Journey): { from: string; to: string } {
  return { from: j.legs[0]?.from.stop.name ?? '', to: j.legs.at(-1)?.to.stop.name ?? '' };
}

/** Alle Halte eines Abschnitts in Reihenfolge (from, Zwischenhalte, to) */
export function allStops(l: Leg): Stopover[] {
  return [l.from, ...l.stopovers, l.to];
}
