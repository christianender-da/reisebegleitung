/** Client für die HTTP-Schnittstelle (server/handler.ts), eingehängt unter `base` */
import type { Journey, StopHit, Ticket } from '../core/index.ts';
import type { TripView } from '../server/service.ts';

export class JourneyApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface PlanParams {
  from: string;
  to: string;
  fromName?: string;
  toName?: string;
  time: string;
  arriveBy: boolean;
  ticket: Ticket;
  dticket: boolean;
}

export interface JourneyApi {
  trips(): Promise<{ trips: TripView[]; dticket?: boolean }>;
  createTrip(body: { planId: string; index: number; ticket: Ticket; dticket: boolean }): Promise<{ id: string }>;
  deleteTrip(id: string): Promise<void>;
  board(id: string, leg: number, action: 'checkin' | 'missed' | 'undo'): Promise<{ trip: TripView }>;
  stops(q: string): Promise<{ hits: StopHit[]; error?: string }>;
  plan(p: PlanParams): Promise<{ planId: string; journeys: Journey[] }>;
}

export interface ApiOptions {
  /** z. B. Login-Seite zeigen */
  onUnauthorized?: () => void;
}

export function createJourneyApi(base: string, opts: ApiOptions = {}): JourneyApi {
  const root = base.replace(/\/$/, '');
  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(root + path, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* kein JSON */
    }
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      throw new JourneyApiError(res.status, (data as { error?: string } | null)?.error ?? String(res.status));
    }
    return data as T;
  }
  return {
    trips: () => call('/trips'),
    createTrip: (body) => call('/trips', { body }),
    deleteTrip: async (id) => {
      await call(`/trips/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    board: (id, leg, action) => call(`/trips/${encodeURIComponent(id)}/boarding`, { body: { leg, action } }),
    stops: (q) => call(`/stops?q=${encodeURIComponent(q)}`),
    plan: (p) =>
      call(
        `/plan?${new URLSearchParams({
          from: p.from,
          to: p.to,
          fromName: p.fromName ?? '',
          toName: p.toName ?? '',
          time: p.time,
          arriveBy: p.arriveBy ? '1' : '0',
          ticket: p.ticket,
          dticket: p.dticket ? '1' : '0',
        })}`,
      ),
  };
}
