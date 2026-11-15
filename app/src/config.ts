export const VERSION = '0.5.1-beta.1';

/** Kontakt prüfen: E-Mail-Adresse oder http(s)-URL (Pflicht laut Transitous) */
export function contactOk(v: string | undefined): v is string {
  const s = v?.trim() ?? '';
  return s.length <= 200 && (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^https?:\/\/\S+$/.test(s));
}
