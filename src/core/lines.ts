/**
 * Linienname für Texte („Bus 42 ist abgefahren“, „An Bord: Tram 7“): bloßen Nummern wird das Verkehrsmittel vorangestellt.
 * Bus, Tram, Fähre und Fernbus immer (dort sagt die Linie nichts über die Art), Züge nur bei reinen Nummern –
 * „ICE 375“, „RE 99“, „S9“, „U4“ bleiben, wie sie sind. Die Linien-Plaketten zeigen weiter nur die Linie (daneben steht das Icon).
 */
import type { Mode } from './types.ts';

const WORD: Record<'de' | 'en', Partial<Record<Mode, string>>> = {
  de: { bus: 'Bus', coach: 'Fernbus', tram: 'Tram', ferry: 'Fähre', subway: 'U-Bahn', suburban: 'S-Bahn', regional: 'Zug', longdistance: 'Zug', highspeed: 'Zug', night: 'Nachtzug' },
  en: { bus: 'Bus', coach: 'Coach', tram: 'Tram', ferry: 'Ferry', subway: 'Subway', suburban: 'S-Bahn', regional: 'Train', longdistance: 'Train', highspeed: 'Train', night: 'Night train' },
};
const ALWAYS: Mode[] = ['bus', 'coach', 'tram', 'ferry'];

export function lineName(line: string | undefined, mode: Mode | undefined, lang: 'de' | 'en' = 'de'): string {
  const l = (line ?? '').trim();
  const w = mode ? WORD[lang][mode] : undefined;
  if (!w) return l || '?';
  if (!l) return w;
  if (l.toLowerCase().startsWith(w.toLowerCase())) return l;
  return ALWAYS.includes(mode!) || /^\d/.test(l) ? `${w} ${l}` : l;
}
