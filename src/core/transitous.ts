/**
 * Client für die MOTIS-2-API von Transitous (https://transitous.org/api/).
 *
 * Nutzungsregeln von Transitous beachten: nicht kommerziell, Open Source, wenig Last
 * (> 720 /plan-Anfragen pro Tag nur nach Absprache), User-Agent mit Anwendungsname, Version und Kontakt,
 * sichtbarer Link auf https://transitous.org/sources/.
 */
import { motisJourney, motisLeg, motisStopHit, type MotisItinerary, type MotisLeg, type MotisMatch } from './motis.ts';
import type { Journey, Leg, Mode, StopHit } from './types.ts';

export const TRANSITOUS_API = 'https://api.transitous.org';
export const TRANSITOUS_SOURCES = 'https://transitous.org/sources/';

export type TransitousErrorCode = 'unavailable' | 'not-found' | 'bad-request';

export class TransitousError extends Error {
  code: TransitousErrorCode;
  constructor(code: TransitousErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ClientOptions {
  /** Pflicht: „<Anwendung>/<Version> (+<Kontakt-URL oder E-Mail>)“ */
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  language?: string;
}

export interface PlanOptions {
  /** Halt-ID (aus searchStops) oder „lat,lon“ */
  from: string;
  to: string;
  /** Zeitpunkt (ISO); Standard: jetzt */
  time?: string;
  /** true: time ist die gewünschte Ankunft */
  arriveBy?: boolean;
  /** erlaubte Verkehrsmittel (eigene Modi); leer/undefined = alle */
  modes?: Mode[];
  /** Mindestumstiegszeit in Minuten */
  minTransferMin?: number;
  maxTransfers?: number;
  results?: number;
}

/** Eigene Modi → MOTIS-transitModes */
const MOTIS_MODES: Record<Exclude<Mode, 'walk' | 'other'>, string[]> = {
  highspeed: ['HIGHSPEED_RAIL'],
  longdistance: ['LONG_DISTANCE'],
  night: ['NIGHT_RAIL'],
  regional: ['REGIONAL_FAST_RAIL', 'REGIONAL_RAIL'],
  suburban: ['SUBURBAN'],
  subway: ['SUBWAY'],
  tram: ['TRAM', 'CABLE_CAR', 'FUNICULAR'],
  bus: ['BUS'],
  coach: ['COACH'],
  ferry: ['FERRY'],
};

export function transitModes(modes?: Mode[]): string | undefined {
  if (!modes?.length) return undefined;
  const out = new Set<string>();
  for (const m of modes) for (const x of MOTIS_MODES[m as keyof typeof MOTIS_MODES] ?? []) out.add(x);
  return [...out].join(',');
}

export interface TransitousClient {
  searchStops(text: string, results?: number): Promise<StopHit[]>;
  plan(opts: PlanOptions): Promise<Journey[]>;
  /** Fahrtverlauf einer Fahrt mit Echtzeit (alle Halte); null, wenn die Fahrt unbekannt ist */
  trip(tripId: string): Promise<Leg[] | null>;
}

export function createClient(opts: ClientOptions): TransitousClient {
  if (!opts.userAgent?.trim()) throw new TypeError('userAgent ist Pflicht (Nutzungsregeln Transitous)');
  const base = (opts.baseUrl ?? TRANSITOUS_API).replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  const language = opts.language ?? 'de';

  async function get<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let res: Response | undefined;
    // ein zweiter Versuch bei Netzfehlern und 429/5xx (kurze Aussetzer)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await doFetch(url.toString(), {
          headers: { Accept: 'application/json', 'User-Agent': opts.userAgent },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
        });
        if (res.status !== 429 && res.status < 500) break;
      } catch (e) {
        if (attempt === 1) throw new TransitousError('unavailable', `Transitous nicht erreichbar: ${String(e)}`);
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
    if (!res) throw new TransitousError('unavailable', 'Transitous nicht erreichbar');
    if (res.status === 404) throw new TransitousError('not-found', `Transitous 404 ${path}`);
    if (res.status === 400 || res.status === 422) throw new TransitousError('bad-request', `Transitous ${res.status} ${path}`);
    if (!res.ok) throw new TransitousError('unavailable', `Transitous ${res.status} ${path}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new TransitousError('unavailable', 'Transitous: keine JSON-Antwort');
    }
  }

  return {
    async searchStops(text, results = 8) {
      const q = text.trim();
      if (q.length < 2) return [];
      const matches = await get<MotisMatch[]>('/api/v1/geocode', { text: q, type: 'STOP', numResults: results, language });
      const hits = (Array.isArray(matches) ? matches : []).filter((m) => !m.type || m.type === 'STOP').map(motisStopHit);
      // Einträge ohne Verkehrsmittel sind meist Dubletten aus anderen Datensätzen
      const served = hits.filter((h) => h.modes.length > 0);
      return served.length ? served : hits;
    },

    async plan(p) {
      const res = await get<{ itineraries?: MotisItinerary[] }>('/api/v6/plan', {
        fromPlace: p.from,
        toPlace: p.to,
        time: p.time,
        arriveBy: p.arriveBy ? true : undefined,
        transitModes: transitModes(p.modes),
        minTransferTime: p.minTransferMin,
        maxTransfers: p.maxTransfers,
        numItineraries: p.results ?? 5,
        detailedLegs: false,
        joinInterlinedLegs: true,
        language,
      });
      return (res.itineraries ?? []).map(motisJourney);
    },

    async trip(tripId) {
      try {
        const it = await get<{ legs?: MotisLeg[] }>('/api/v6/trip', { tripId, detailedLegs: false, language });
        return (it.legs ?? []).map(motisLeg);
      } catch (e) {
        if (e instanceof TransitousError && (e.code === 'not-found' || e.code === 'bad-request')) return null;
        throw e;
      }
    },
  };
}
