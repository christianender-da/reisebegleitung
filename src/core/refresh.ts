/**
 * Reise mit aktuellen Echtzeitdaten auffrischen: Für jede Fahrt wird der Fahrtverlauf geholt und der
 * gebuchte Teil (vom Einstiegs- bis zum Ausstiegshalt) übernommen – inklusive aller Zwischenhalte.
 */
import type { Journey, Leg, Stopover } from './types.ts';

/** Liefert den Fahrtverlauf (alle Abschnitte einer Fahrt) oder null, wenn unbekannt */
export type TripLoader = (tripId: string) => Promise<Leg[] | null>;

export interface RefreshResult {
  journey: Journey;
  /** Fahrten, die nicht aktualisiert werden konnten (tripId) */
  failed: string[];
}

function norm(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

function sameStop(a: Stopover, b: Stopover) {
  return a.stop.id === b.stop.id || norm(a.stop.name) === norm(b.stop.name);
}

/** Abschnitt einer Fahrt zwischen Ein- und Ausstieg aus dem vollständigen Fahrtverlauf schneiden */
export function cutLeg(booked: Leg, trip: Leg[]): Leg | null {
  const ride = trip.filter((l) => l.kind === 'ride');
  if (!ride.length) return null;
  const stops: Stopover[] = [];
  for (const l of ride) {
    const seq = [l.from, ...l.stopovers, l.to];
    // aufeinanderfolgende Abschnitte (Flügelung/Durchbindung) teilen sich den Übergangshalt
    if (stops.length && seq.length && sameStop(stops.at(-1)!, seq[0])) {
      const joint = stops.pop()!;
      seq[0] = { ...seq[0], plannedArrival: joint.plannedArrival, arrival: joint.arrival };
    }
    stops.push(...seq);
  }
  // Einstieg: erster passender Halt, dessen Planabfahrt zur gebuchten passt (Fahrten können Halte mehrfach anfahren)
  const fromIdx = stops.findIndex(
    (s) => sameStop(s, booked.from) && (!booked.from.plannedDeparture || !s.plannedDeparture || s.plannedDeparture === booked.from.plannedDeparture),
  );
  if (fromIdx < 0) return null;
  let toIdx = -1;
  for (let i = fromIdx + 1; i < stops.length; i++) {
    if (sameStop(stops[i], booked.to)) {
      toIdx = i;
      break;
    }
  }
  if (toIdx < 0) return null;
  const first = ride[0];
  const from = { ...stops[fromIdx] };
  const to = { ...stops[toIdx] };
  // Am Einstieg zählt nur die Abfahrt, am Ausstieg nur die Ankunft
  delete from.plannedArrival;
  delete from.arrival;
  delete to.plannedDeparture;
  delete to.departure;
  const cancelled = ride.every((l) => l.cancelled) || Boolean(from.cancelled) || Boolean(to.cancelled);
  return {
    ...booked,
    line: booked.line ?? first.line,
    number: booked.number ?? first.number,
    headsign: booked.headsign ?? first.headsign,
    operator: booked.operator ?? first.operator,
    from,
    to,
    stopovers: stops.slice(fromIdx + 1, toIdx),
    cancelled,
    realtime: ride.some((l) => l.realtime),
  };
}

/** Fußwege an die neuen Zeiten der Nachbarfahrten anpassen (nur Planzeiten, keine Echtzeit) */
function alignWalks(legs: Leg[]): Leg[] {
  return legs.map((l, i) => {
    if (l.kind !== 'walk') return l;
    const prev = legs[i - 1];
    if (!prev || prev.kind !== 'ride') return l;
    const startIso = prev.to.arrival ?? prev.to.plannedArrival;
    if (!startIso) return l;
    const end = new Date(Date.parse(startIso) + (l.walkMin ?? 0) * 60_000).toISOString().replace('.000Z', 'Z');
    return { ...l, from: { ...l.from, plannedDeparture: startIso }, to: { ...l.to, plannedArrival: end } };
  });
}

export async function refreshJourney(j: Journey, load: TripLoader): Promise<RefreshResult> {
  const failed: string[] = [];
  const legs = await Promise.all(
    j.legs.map(async (l) => {
      if (l.kind !== 'ride' || !l.tripId) return l;
      try {
        const trip = await load(l.tripId);
        const cut = trip ? cutLeg(l, trip) : null;
        if (!cut) failed.push(l.tripId);
        return cut ?? l;
      } catch {
        failed.push(l.tripId);
        return l;
      }
    }),
  );
  return { journey: { ...j, legs: alignWalks(legs) }, failed };
}
