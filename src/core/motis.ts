/**
 * Umwandlung der MOTIS-2-Antworten (z. B. Transitous, API v6) in das eigene Datenmodell.
 * Feldnamen laut MOTIS-OpenAPI (Place, Leg, Itinerary, Match).
 */
import type { Journey, Leg, Mode, StopHit, Stopover } from './types.ts';

export interface MotisPlace {
  name: string;
  stopId?: string;
  parentId?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
  arrivalTimestampReason?: string;
  departureTimestampReason?: string;
}

export interface MotisLeg {
  mode: string;
  from: MotisPlace;
  to: MotisPlace;
  duration?: number;
  startTime?: string;
  endTime?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  realTime?: boolean;
  cancelled?: boolean;
  headsign?: string;
  tripId?: string;
  routeShortName?: string;
  tripShortName?: string;
  displayName?: string;
  agencyName?: string;
  intermediateStops?: MotisPlace[];
}

export interface MotisItinerary {
  duration?: number;
  startTime?: string;
  endTime?: string;
  transfers?: number;
  legs: MotisLeg[];
}

export interface MotisMatch {
  id: string;
  name: string;
  type?: string;
  modes?: string[];
  areas?: { name: string; adminLevel?: number; default?: boolean }[];
}

const MODES: Record<string, Mode> = {
  HIGHSPEED_RAIL: 'highspeed',
  LONG_DISTANCE: 'longdistance',
  NIGHT_RAIL: 'night',
  REGIONAL_FAST_RAIL: 'regional',
  REGIONAL_RAIL: 'regional',
  RAIL: 'regional',
  SUBURBAN: 'suburban',
  SUBWAY: 'subway',
  METRO: 'subway',
  TRAM: 'tram',
  CABLE_CAR: 'tram',
  FUNICULAR: 'tram',
  BUS: 'bus',
  ODM: 'bus',
  FLEX: 'bus',
  COACH: 'coach',
  FERRY: 'ferry',
  WALK: 'walk',
};

export function motisMode(m: string | undefined): Mode {
  return (m && MODES[m]) || 'other';
}

/**
 * MOTIS liefert ohne Echtzeit in departure/arrival die Planzeit. Echtzeit gilt nur, wenn der Zeitstempel-Grund
 * nicht NO_RT_DATA/INCONSISTENT_RT ist (oder – bei fehlendem Grund – der Abschnitt realTime meldet).
 */
function rt(reason: string | undefined, legRealtime: boolean): boolean {
  if (reason) return reason !== 'NO_RT_DATA' && reason !== 'INCONSISTENT_RT';
  return legRealtime;
}

export function motisStopover(p: MotisPlace, legRealtime = false): Stopover {
  const s: Stopover = {
    stop: { id: p.stopId ?? `${p.lat},${p.lon}`, name: p.name, lat: p.lat, lon: p.lon },
  };
  if (p.scheduledArrival) s.plannedArrival = p.scheduledArrival;
  if (p.scheduledDeparture) s.plannedDeparture = p.scheduledDeparture;
  if (p.arrival && (p.scheduledArrival ? rt(p.arrivalTimestampReason, legRealtime) : true)) s.arrival = p.arrival;
  if (p.departure && (p.scheduledDeparture ? rt(p.departureTimestampReason, legRealtime) : true)) s.departure = p.departure;
  // Ohne Planzeit (z. B. Fußweg) ist die gelieferte Zeit die einzige
  if (!s.plannedArrival && s.arrival) s.plannedArrival = s.arrival;
  if (!s.plannedDeparture && s.departure) s.plannedDeparture = s.departure;
  const planned = p.scheduledTrack ?? p.track;
  if (planned) s.plannedTrack = planned;
  if (p.track) s.track = p.track;
  if (p.cancelled) s.cancelled = true;
  return s;
}

/** Zugnummer ohne führende Nullen; nur wenn rein numerisch oder mit Gattung (z. B. „NJ 409“ → „409“) */
function trainNumber(l: MotisLeg): string | undefined {
  const raw = l.tripShortName?.trim();
  if (!raw) return undefined;
  const m = raw.match(/(\d+)\s*$/);
  if (!m) return undefined;
  return String(Number(m[1]));
}

export function motisLeg(l: MotisLeg): Leg {
  const mode = motisMode(l.mode);
  const realtime = Boolean(l.realTime);
  if (mode === 'walk') {
    const from = motisStopover({ ...l.from, scheduledDeparture: l.scheduledStartTime ?? l.startTime, departure: l.startTime }, false);
    const to = motisStopover({ ...l.to, scheduledArrival: l.scheduledEndTime ?? l.endTime, arrival: l.endTime }, false);
    // Fußwege haben keine Echtzeit – nur die Planzeit behalten
    delete from.departure;
    delete to.arrival;
    return { kind: 'walk', mode, from, to, stopovers: [], cancelled: false, realtime: false, walkMin: Math.round((l.duration ?? 0) / 60) };
  }
  const leg: Leg = {
    kind: 'ride',
    mode,
    from: motisStopover(l.from, realtime),
    to: motisStopover(l.to, realtime),
    stopovers: (l.intermediateStops ?? []).map((p) => motisStopover(p, realtime)),
    cancelled: Boolean(l.cancelled),
    realtime,
  };
  const number = trainNumber(l);
  if (number) leg.number = number;
  // „RE98 (15022)“ → „RE98“ (Zugnummer steht in number)
  const line = (l.displayName?.trim() || l.routeShortName?.trim())?.replace(/\s*\(\d+\)$/, '');
  if (line) leg.line = line;
  if (l.headsign) leg.headsign = l.headsign;
  if (l.agencyName) leg.operator = l.agencyName;
  if (l.tripId) leg.tripId = l.tripId;
  return leg;
}

export function motisJourney(it: MotisItinerary): Journey {
  return { legs: it.legs.map(motisLeg) };
}

/** Treffer der Haltestellensuche (nur Halte) */
export function motisStopHit(m: MotisMatch): StopHit {
  const areas = m.areas ?? [];
  const place = areas.find((a) => a.default)?.name ?? areas.filter((a) => (a.adminLevel ?? 0) <= 8).at(-1)?.name;
  const hit: StopHit = { id: m.id, name: m.name, modes: [...new Set((m.modes ?? []).map(motisMode))] };
  if (place && !m.name.includes(place)) hit.place = place;
  return hit;
}
