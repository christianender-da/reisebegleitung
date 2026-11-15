/** Client für die HTTP-Schnittstelle (server/handler.ts), eingehängt unter `base` */
import type { Journey, StopHit, Ticket } from '../core/index.ts';
import type { ShareInfo, TripView } from '../server/service.ts';

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
  trips(): Promise<{ trips: TripView[]; dticket?: boolean; avatar?: string | null }>;
  /** Adresse des Fotos zu einer Version (aus trips().avatar) */
  avatarUrl(version: string): string;
  setAvatar(image: string): Promise<{ avatar: string }>;
  deleteAvatar(): Promise<void>;
  createTrip(body: { planId: string; index: number; ticket: Ticket; dticket: boolean }): Promise<{ id: string }>;
  deleteTrip(id: string): Promise<void>;
  board(id: string, leg: number, action: 'checkin' | 'missed' | 'undo'): Promise<{ trip: TripView }>;
  chooseAlternative(id: string, index: number): Promise<{ trip: TripView }>;
  /** zurück zur ursprünglichen Verbindung */
  revertTrip(id: string): Promise<{ trip: TripView }>;
  shares(id: string): Promise<{ shares: ShareInfo[] }>;
  createShare(id: string, label: string): Promise<{ share: ShareInfo & { token: string } }>;
  revokeShare(id: string, shareId: string): Promise<void>;
  pushKey(): Promise<{ key: string | null }>;
  subscribe(subscription: unknown, lang: string): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  testPush(lang: string): Promise<{ sent: number }>;
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
    avatarUrl: (version) => `${root}/avatar?v=${encodeURIComponent(version)}`,
    setAvatar: (image) => call('/avatar', { method: 'PUT', body: { image } }),
    deleteAvatar: async () => {
      await call('/avatar', { method: 'DELETE' });
    },
    createTrip: (body) => call('/trips', { body }),
    deleteTrip: async (id) => {
      await call(`/trips/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    board: (id, leg, action) => call(`/trips/${encodeURIComponent(id)}/boarding`, { body: { leg, action } }),
    chooseAlternative: (id, index) => call(`/trips/${encodeURIComponent(id)}/alternative`, { body: { index } }),
    revertTrip: (id) => call(`/trips/${encodeURIComponent(id)}/original`, { body: {} }),
    shares: (id) => call(`/trips/${encodeURIComponent(id)}/shares`),
    createShare: (id, label) => call(`/trips/${encodeURIComponent(id)}/shares`, { body: { label } }),
    revokeShare: async (id, shareId) => {
      await call(`/trips/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
    },
    pushKey: () => call('/push/key'),
    subscribe: async (subscription, lang) => {
      await call('/push/subscribe', { body: { subscription, lang } });
    },
    unsubscribe: async (endpoint) => {
      await call('/push/unsubscribe', { body: { endpoint } });
    },
    testPush: (lang) => call('/push/test', { body: { lang } }),
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
