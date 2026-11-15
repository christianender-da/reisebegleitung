/**
 * Gleise aus DB IRIS ergänzen (iris.noncd.db.de, ohne Key, inoffiziell – kann wegfallen).
 *
 * Transitous/DELFI hat für viele Regionalzüge und S-Bahnen kein Gleis. IRIS kennt Plan- und geänderte Gleise je Bahnhof.
 * IRIS findet Bahnhöfe nur über den exakten Namen (keine Platzhalter) – daher:
 *  1. einen „Anker“ suchen: einen Halt des Abschnitts, dessen Name sich (in üblichen Schreibweisen) als IRIS-Bahnhof findet
 *     und in dessen Fahrplan der Zug (Zugnummer) zur geplanten Stunde vorkommt;
 *  2. aus dem Laufweg des Zugs (ppth) die exakten IRIS-Namen von Ein- und Ausstieg bestimmen;
 *  3. dort Plan (pp) und Änderungen (cp) lesen.
 * Nur Zug-Abschnitte mit Zugnummer; vorhandene Gleise aus Transitous bleiben, ergänzt wird nur, was fehlt.
 */
import type { Journey, Leg, Mode, Stopover } from '../core/index.ts';
import type { CacheLike } from './store.ts';

export const IRIS_BASE = 'https://iris.noncd.db.de/iris-tts/timetable';
const RAIL: Mode[] = ['highspeed', 'longdistance', 'night', 'regional', 'suburban'];

type Attrs = Record<string, string>;
interface IrisStop {
  id: string;
  tl: Attrs;
  ar?: Attrs;
  dp?: Attrs;
}

function attrs(tag: string): Attrs {
  const out: Attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return out;
}

/** <s id>…</s> eines Fahrplans bzw. der Änderungen */
export function parseIris(xml: string): IrisStop[] {
  const out: IrisStop[] = [];
  for (const m of xml.matchAll(/<s\s([^>]*)>([\s\S]*?)<\/s>/g)) {
    const s = attrs(m[1]);
    const b = m[2];
    const tag = (n: string) => {
      const t = b.match(new RegExp(`<${n}\\s([^>]*?)\\/?>`));
      return t ? attrs(t[1]) : undefined;
    };
    out.push({ id: s.id, tl: tag('tl') ?? {}, ar: tag('ar'), dp: tag('dp') });
  }
  return out;
}

export function parseStations(xml: string): { name: string; eva: string }[] {
  return [...xml.matchAll(/<station\s([^>]*?)\/?>/g)].map((m) => attrs(m[1])).filter((a) => a.name && a.eva).map((a) => ({ name: a.name, eva: a.eva }));
}

/** Vergleichsform: klein, ohne Akzente, Hauptbahnhof→hbf, ohne „Bahnhof“, ohne Satzzeichen */
export function normName(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/hauptbahnhof/g, 'hbf')
    .replace(/bahnhof\b|\bbf\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Passt ein IRIS-Name zu einem Namen aus Transitous? Alle wesentlichen Wörter des einen müssen im anderen vorkommen
 * („Weinheim, Hauptbahnhof“ ↔ „Weinheim(Bergstr)Hbf“, „Langen (Hessen) Bahnhof“ ↔ „Langen(Hess)“). 0 = passt nicht.
 */
export function nameScore(transitous: string, iris: string): number {
  const a = normName(transitous);
  const b = normName(iris);
  const ca = a.join('');
  const cb = b.join('');
  if (!ca || !cb) return 0;
  if (ca === cb) return 3;
  const sig = (w: string) => w.length >= 3 || w === 'hbf';
  const aInB = a.filter(sig).every((w) => cb.includes(w) || (w.length > 4 && cb.includes(w.slice(0, 4))));
  const bInA = b.filter(sig).every((w) => ca.includes(w) || (w.length > 4 && ca.includes(w.slice(0, 4))));
  if (aInB && bInA) return 2;
  return aInB || bInA ? 1 : 0;
}

/** Schreibweisen eines Transitous-Namens, wie IRIS sie führen könnte */
export function nameVariants(name: string): string[] {
  const v1 = name.replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const v2 = v1.replace(/Hauptbahnhof/g, 'Hbf');
  const v3 = v2.replace(/\s+(Bahnhof|Bf)$/, '').trim();
  const v4 = v3.replace(/\s*\(([^)]*)\)\s*/g, '($1)');
  return [...new Set([v3, v4, v2, v1])].filter(Boolean);
}

/** Datum/Stunde in Berlin im IRIS-Format: { day: YYMMDD, hour: HH, stamp: YYMMDDHHmm } */
export function berlinStamp(iso: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}${p.month}${p.day}`, hour: p.hour, stamp: `${p.year}${p.month}${p.day}${p.hour}${p.minute}` };
}

export interface IrisOptions {
  userAgent: string;
  cache?: CacheLike | null;
  fetch?: typeof fetch;
  base?: string;
}

export function createIris(opts: IrisOptions) {
  const base = (opts.base ?? IRIS_BASE).replace(/\/$/, '');
  const doFetch = opts.fetch ?? fetch;
  const cache = opts.cache ?? null;
  const memo = new Map<string, Promise<string>>();

  /** GET mit Cache (maxAge in s); 404 → leer */
  async function get(path: string, maxAge: number): Promise<string> {
    const key = new Request(`https://cache.internal/reisebegleitung/iris${path}`);
    if (cache) {
      const hit = await cache.match(key);
      if (hit) return hit.text();
    }
    const m = memo.get(path);
    if (m) return m;
    const p = (async () => {
      const res = await doFetch(base + path, { headers: { 'User-Agent': opts.userAgent, Accept: 'application/xml' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok && res.status !== 404) throw new Error(`IRIS ${res.status}`);
      const text = res.status === 404 ? '' : await res.text();
      if (cache) await cache.put(key, new Response(text, { headers: { 'Cache-Control': `max-age=${maxAge}` } }));
      return text;
    })();
    memo.set(path, p);
    try {
      return await p;
    } finally {
      memo.delete(path);
    }
  }

  /** Bahnhof per exaktem Namen (1 Tag im Cache, auch „nicht gefunden“) */
  async function station(name: string): Promise<{ name: string; eva: string } | null> {
    const hits = parseStations(await get(`/station/${encodeURIComponent(name)}`, 86400));
    return hits.find((h) => h.name === name) ?? hits[0] ?? null;
  }

  async function findStation(transitousName: string) {
    for (const v of nameVariants(transitousName)) {
      const s = await station(v);
      if (s && nameScore(transitousName, s.name) > 0) return s;
    }
    return null;
  }

  async function plan(eva: string, iso: string): Promise<IrisStop[]> {
    const { day, hour } = berlinStamp(iso);
    return parseIris(await get(`/plan/${eva}/${day}/${hour}`, 3600));
  }

  async function changes(eva: string): Promise<IrisStop[]> {
    return parseIris(await get(`/fchg/${eva}`, 60));
  }

  /** Eintrag des Zugs (Zugnummer) im Fahrplan um die geplante Zeit */
  function findTrain(stops: IrisStop[], number: string, kind: 'ar' | 'dp', iso: string | undefined) {
    const stamp = iso ? berlinStamp(iso).stamp : undefined;
    const cands = stops.filter((s) => s.tl.n === number && s[kind]);
    return cands.find((s) => !stamp || s[kind]!.pt === stamp) ?? cands[0];
  }

  async function trackAt(name: string, number: string, kind: 'ar' | 'dp', iso: string | undefined): Promise<{ planned?: string; actual?: string } | null> {
    if (!iso) return null;
    const st = await station(name);
    if (!st) return null;
    const entry = findTrain(await plan(st.eva, iso), number, kind, iso);
    if (!entry) return null;
    const planned = entry[kind]!.pp;
    const ch = (await changes(st.eva)).find((c) => c.id === entry.id)?.[kind]?.cp;
    return { planned, actual: ch ?? planned };
  }

  /** Gleise eines Zug-Abschnitts aus IRIS (null = nicht gefunden) */
  async function legTracks(l: Leg): Promise<{ from: { planned?: string; actual?: string } | null; to: { planned?: string; actual?: string } | null } | null> {
    if (l.kind !== 'ride' || !l.number || !RAIL.includes(l.mode)) return null;
    const stops = [l.from, l.to, ...l.stopovers].slice(0, 6);
    for (const s of stops) {
      const st = await findStation(s.stop.name);
      if (!st) continue;
      const iso = s.plannedDeparture ?? s.plannedArrival;
      if (!iso) continue;
      const fahrplan = await plan(st.eva, iso);
      const entry = fahrplan.find((x) => x.tl.n === l.number);
      if (!entry) continue;
      // Laufweg mit exakten IRIS-Namen: vorherige Halte | Anker | folgende Halte
      const route = [...(entry.ar?.ppth?.split('|') ?? []), st.name, ...(entry.dp?.ppth?.split('|') ?? [])].filter(Boolean);
      const pick = (name: string) => route.map((r) => ({ r, s: nameScore(name, r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.r;
      const fromName = pick(l.from.stop.name);
      const toName = pick(l.to.stop.name);
      return {
        from: fromName ? await trackAt(fromName, l.number, 'dp', l.from.plannedDeparture) : null,
        to: toName ? await trackAt(toName, l.number, 'ar', l.to.plannedArrival) : null,
      };
    }
    return null;
  }

  function apply(s: Stopover, t: { planned?: string; actual?: string } | null): Stopover {
    if (!t?.planned && !t?.actual) return s;
    // Transitous-Angaben haben Vorrang, sofern vorhanden
    if (s.track && s.trackSource !== 'iris') return s;
    return { ...s, plannedTrack: t.planned ?? s.plannedTrack, track: t.actual ?? t.planned, trackSource: 'iris' };
  }

  return {
    /** Fehlende Gleise der Zug-Abschnitte ergänzen (Fehler je Abschnitt werden ignoriert) */
    async enrich(j: Journey): Promise<Journey> {
      const legs = await Promise.all(
        j.legs.map(async (l) => {
          const needs = (l.from.trackSource === 'iris' || !l.from.track) || (l.to.trackSource === 'iris' || !l.to.track);
          if (l.kind !== 'ride' || !needs) return l;
          try {
            const t = await legTracks(l);
            return t ? { ...l, from: apply(l.from, t.from), to: apply(l.to, t.to) } : l;
          } catch {
            return l;
          }
        }),
      );
      return { ...j, legs };
    },
  };
}

export type Iris = ReturnType<typeof createIris>;
