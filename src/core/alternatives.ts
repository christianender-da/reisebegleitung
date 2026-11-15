/**
 * Alternativen, wenn die Reise so nicht mehr klappt.
 *
 * Auslöser (der erste zutreffende):
 * - Zug als verpasst markiert („Nein, verpasst“) → ab dessen Einstiegshalt, ab jetzt
 * - Umstieg nicht erreichbar oder Anschluss fällt aus → ab dem Umstiegshalt, ab (erwarteter) Ankunft dort
 * - erster Zug fällt aus → ab dem Starthalt
 *
 * Die Suche selbst macht der Server (Transitous /plan); hier: Auslöser, Ticket-Abdeckung je Alternative,
 * Ersetzen der restlichen Reise.
 */
import { boardingState, type Boarding } from './boarding.ts';
import { arrTime, depTime, journeyEnd, ms } from './journey.ts';
import { transfers } from './progress.ts';
import { bindingLifted, coverage, type Coverage, type TicketContext } from './tickets.ts';
import type { Journey, Mode, Stop } from './types.ts';

export type AlternativeReason =
  /** Zug selbst verpasst (nicht durch Verspätung) */
  | 'missed-train'
  /** Umstieg wegen Verspätung nicht erreichbar */
  | 'connection'
  /** Anschluss bzw. Zug fällt aus */
  | 'cancelled';

export interface AlternativeTrigger {
  reason: AlternativeReason;
  /** so viele Abschnitte der Reise bleiben (bereits gefahren bzw. der aktuelle Zug bis zum Umstiegshalt) */
  keepLegs: number;
  /** ab hier neu suchen */
  origin: Stop;
  /** frühestens ab dieser Zeit (ISO) */
  time: string;
  /** betroffener Zug (für Texte) */
  line?: string;
  /** dessen Verkehrsmittel (für „Bus 42“ statt „42“, siehe lineName) */
  mode?: Mode;
  /** stabiler Schlüssel: gleicher Auslöser → keine neue Suche/Benachrichtigung */
  key: string;
}

export function alternativesTrigger(j: Journey, boarding: Boarding | undefined, now = Date.now()): AlternativeTrigger | null {
  if (now > ms(journeyEnd(j))) return null;
  const nowIso = new Date(now).toISOString();
  const later = (iso: string | undefined) => (iso && ms(iso) > now ? iso : nowIso);
  const make = (reason: AlternativeReason, keepLegs: number, origin: Stop, time: string, leg?: { line?: string; mode: Mode }): AlternativeTrigger => ({
    reason,
    keepLegs,
    origin,
    time,
    line: leg?.line,
    mode: leg?.mode,
    key: `${reason}:${keepLegs}:${origin.id}`,
  });

  const bs = boardingState(j, boarding, now);
  if (bs.prompt?.kind === 'missed') {
    const l = j.legs[bs.prompt.leg];
    return make('missed-train', bs.prompt.leg, l.from.stop, nowIso, l);
  }

  for (const t of transfers(j, { boarding })) {
    if (t.state !== 'missed' && t.state !== 'cancelled') continue;
    const next = j.legs[t.toLeg];
    // längst vorbei (Anschluss wäre schon angekommen) → nicht mehr relevant
    if (ms(arrTime(next.to)) < now) continue;
    const arriving = j.legs[t.fromLeg];
    return make(t.state === 'cancelled' ? 'cancelled' : 'connection', t.fromLeg + 1, arriving.to.stop, later(arrTime(arriving.to)), next);
  }

  const first = j.legs.findIndex((l) => l.kind === 'ride');
  if (first >= 0 && bs.lastCheckin === null) {
    const l = j.legs[first];
    if ((l.cancelled || l.from.cancelled) && now < ms(depTime(l.from)) + 30 * 60_000) return make('cancelled', first, l.from.stop, later(depTime(l.from)), l);
  }
  return null;
}

export interface AlternativeOption {
  journey: Journey;
  /** Abdeckung je Abschnitt (gleiche Reihenfolge wie journey.legs) */
  coverage: Coverage[];
  /** alle Abschnitte mit dem Ticket (bzw. D-Ticket / aufgehobener Zugbindung) nutzbar */
  covered: boolean;
}

/** Ticket-Abdeckung einer Alternative. bookedTripIds: Fahrten der ursprünglichen Reise (bei Sparpreis immer erlaubt). */
export function rateAlternative(alt: Journey, ctx: TicketContext, opts: { bindingLifted: boolean; bookedTripIds: string[] }): AlternativeOption {
  const cov = alt.legs.map((l) =>
    coverage(l.mode, ctx, { bindingLifted: opts.bindingLifted, booked: !!l.tripId && opts.bookedTripIds.includes(l.tripId) }),
  );
  return { journey: alt, coverage: cov, covered: cov.every((c) => c !== 'not-covered') };
}

/** Ist die Zugbindung für diesen Auslöser aufgehoben? (selbst verpasst: nur, wenn ohnehin ≥ 20 min Verspätung) */
export function liftedFor(j: Journey, trigger: AlternativeTrigger): boolean {
  if (trigger.reason === 'missed-train') return bindingLifted(j).reason === 'delay';
  return true;
}

/** Restliche Reise durch die gewählte Alternative ersetzen; Check-ins der ersetzten Abschnitte entfallen */
/** Kennung eines Abschnitts (Fahrt bzw. Fußweg) zum Vergleich zweier Verbindungen */
function legKey(l: Journey['legs'][number]): string {
  return l.kind === 'ride' ? (l.tripId ?? `${l.line}|${l.from.stop.id}|${l.from.plannedDeparture}`) : `walk|${l.from.stop.id}|${l.to.stop.id}`;
}

/** Wie viele Abschnitte am Anfang stimmen überein? */
export function sharedPrefix(a: Journey, b: Journey): number {
  let k = 0;
  while (k < a.legs.length && k < b.legs.length && legKey(a.legs[k]) === legKey(b.legs[k])) k++;
  return k;
}

/** Wurde (per Alternative) eine andere Verbindung übernommen als ursprünglich gewählt? (Vergleich der Fahrten) */
export function isReplaced(current: Journey, original: Journey): boolean {
  const rides = (j: Journey) => j.legs.filter((l) => l.kind === 'ride').map(legKey).join('>');
  return rides(current) !== rides(original);
}

export function replaceRemainder(j: Journey, boarding: Boarding, keepLegs: number, alt: Journey): { journey: Journey; boarding: Boarding } {
  const journey: Journey = { ...j, legs: [...j.legs.slice(0, keepLegs), ...alt.legs] };
  const b: Boarding = {
    checkins: boarding.checkins.filter((e) => e.leg < keepLegs),
    missed: boarding.missed.filter((e) => e.leg < keepLegs),
  };
  return { journey, boarding: b };
}
