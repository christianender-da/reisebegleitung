/**
 * Ticketregeln für die Suche nach Verbindungen und (später) nach Alternativen.
 *
 * Vereinfachte Fahrgastrechte (DB, Stand 2026): Bei Sparpreisen entfällt die Zugbindung, wenn am Ziel eine
 * Verspätung von mindestens 20 Minuten zu erwarten ist oder ein Anschluss verpasst wird. Mit Deutschlandticket
 * dürfen Nahverkehrszüge immer genutzt werden. Einzelne IC-Strecken mit D-Ticket-Freigabe werden nicht berücksichtigt.
 */
import { journeyEnd, journeyPlannedEnd } from './journey.ts';
import { transfers } from './progress.ts';
import type { Journey, Mode } from './types.ts';

export type Ticket =
  /** Flexpreis: alle Züge der Strecke */
  | 'flex'
  /** Sparpreis/Super Sparpreis: Zugbindung */
  | 'spar'
  /** BahnCard 100: alle Züge */
  | 'bc100'
  /** nur Deutschlandticket: nur Nahverkehr */
  | 'dticket'
  /** Verbund-/sonstiges Ticket: keine Annahmen */
  | 'other';

export const TICKETS: Ticket[] = ['flex', 'spar', 'bc100', 'dticket', 'other'];

export interface TicketContext {
  ticket: Ticket;
  /** Deutschlandticket vorhanden (bei ticket = 'dticket' immer true) */
  hasDTicket: boolean;
}

/** Fernverkehr (nicht mit D-Ticket nutzbar) */
export const LONG_DISTANCE_MODES: Mode[] = ['highspeed', 'longdistance', 'night', 'coach'];
export const LOCAL_MODES: Mode[] = ['regional', 'suburban', 'subway', 'tram', 'bus', 'ferry'];

export function isLocal(mode: Mode): boolean {
  return LOCAL_MODES.includes(mode) || mode === 'walk';
}

export function hasDTicket(ctx: TicketContext): boolean {
  return ctx.ticket === 'dticket' || ctx.hasDTicket;
}

/** Alle Verkehrsmittel außer Fernbus (Fernbusse gelten mit keinem DB-Ticket) */
export const RAIL_TICKET_MODES: Mode[] = ['highspeed', 'longdistance', 'night', ...LOCAL_MODES];

/** Verkehrsmittel für die Verbindungssuche beim Anlegen (undefined = alle) */
export function searchModes(ctx: TicketContext): Mode[] | undefined {
  if (ctx.ticket === 'dticket') return [...LOCAL_MODES];
  if (ctx.ticket === 'other') return undefined;
  return [...RAIL_TICKET_MODES];
}

/** Ist die Zugbindung eines Sparpreises aufgehoben? (≥ 20 min am Ziel oder Anschluss verpasst) */
export function bindingLifted(j: Journey): { lifted: boolean; reason?: 'delay' | 'connection'; delayMin?: number } {
  const planned = journeyPlannedEnd(j);
  const actual = journeyEnd(j);
  const delay = planned && actual ? Math.round((Date.parse(actual) - Date.parse(planned)) / 60_000) : 0;
  if (delay >= 20) return { lifted: true, reason: 'delay', delayMin: delay };
  if (transfers(j).some((t) => t.state === 'missed' || t.state === 'cancelled')) return { lifted: true, reason: 'connection', delayMin: delay };
  return { lifted: false, delayMin: delay };
}

export type Coverage = 'ticket' | 'dticket' | 'binding-lifted' | 'not-covered';

/**
 * Darf ein Abschnitt mit diesem Verkehrsmittel (als Alternative) genutzt werden?
 * booked: bei Sparpreis ein gebuchter Zug – dieser ist immer erlaubt.
 */
export function coverage(mode: Mode, ctx: TicketContext, opts: { bindingLifted?: boolean; booked?: boolean } = {}): Coverage {
  if (mode === 'walk') return 'ticket';
  if (mode === 'coach') return ctx.ticket === 'other' ? 'ticket' : 'not-covered';
  const local = isLocal(mode);
  switch (ctx.ticket) {
    case 'dticket':
      return local ? 'dticket' : 'not-covered';
    case 'flex':
    case 'bc100':
      return 'ticket';
    case 'spar':
      if (opts.booked) return 'ticket';
      if (opts.bindingLifted) return 'binding-lifted';
      if (local && ctx.hasDTicket) return 'dticket';
      // Nahverkehr gehört bei Sparpreisen meist zur gebuchten Strecke, aber nicht frei wählbar
      return 'not-covered';
    case 'other':
    default:
      return local && ctx.hasDTicket ? 'dticket' : local ? 'ticket' : 'not-covered';
  }
}
