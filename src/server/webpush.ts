/**
 * Web Push ohne Abhängigkeiten (WebCrypto): VAPID (RFC 8292, ES256) und Verschlüsselung aes128gcm (RFC 8291).
 * Läuft in Cloudflare Workers, Browsern und Node ≥ 20.
 *
 * Schlüssel: ein P-256-Schlüsselpaar als JWK (mit d, x, y) – erzeugen mit `npm run vapid-keys`.
 * Der öffentliche Schlüssel (applicationServerKey) wird daraus abgeleitet.
 */

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidConfig {
  /** privater Schlüssel als JWK (kty EC, crv P-256, d, x, y) */
  privateJwk: JsonWebKey;
  /** Kontakt für Push-Dienste: „mailto:…“ oder „https://…“ */
  subject: string;
}

const enc = { encode: (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s)) };

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Öffentlicher Schlüssel (unkomprimiert, 65 Bytes) aus dem JWK – als applicationServerKey für den Browser */
export function vapidPublicKey(jwk: JsonWebKey): string {
  if (!jwk.x || !jwk.y) throw new TypeError('VAPID-JWK ohne x/y');
  return b64urlEncode(concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y)));
}

export function parseVapidJwk(json: string | undefined): JsonWebKey | null {
  if (!json) return null;
  try {
    const k = JSON.parse(json) as JsonWebKey;
    return k.kty === 'EC' && k.crv === 'P-256' && k.d && k.x && k.y ? k : null;
  } catch {
    return null;
  }
}

/** Erlaubte Push-Dienste (keine beliebigen Ziele für Server-Anfragen) */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];

export function validSubscription(v: unknown): v is PushSubscriptionJSON {
  const s = v as PushSubscriptionJSON;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys) return false;
  if (typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return false;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return false;
  try {
    return b64urlDecode(s.keys.p256dh).length === 65 && b64urlDecode(s.keys.auth).length === 16;
  } catch {
    return false;
  }
}

/** VAPID-Header (Authorization: vapid t=<JWT>, k=<öffentlicher Schlüssel>) */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, now = Date.now()): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey('jwk', { ...vapid.privateJwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto liefert die Signatur bereits als r‖s (64 Bytes) – passend für JWS
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapidPublicKey(vapid.privateJwk)}`;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array((await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8)) as ArrayBuffer);
}

/** Nutzlast verschlüsseln (aes128gcm, ein Datensatz). salt/localKeys nur für Tests. */
export async function encryptPayload(
  payload: Uint8Array,
  sub: PushSubscriptionJSON,
  opts: { salt?: Uint8Array<ArrayBuffer>; localKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(sub.keys.p256dh);
  const authSecret = b64urlDecode(sub.keys.auth);
  const local = opts.localKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Standard-Feld „public“ (die Workers-Typen nennen es „$public“, die Laufzeit erwartet „public“)
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const shared = new Uint8Array((await crypto.subtle.deriveBits(ecdh, local.privateKey, 256)) as ArrayBuffer);
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // letzter (einziger) Datensatz: Trennzeichen 0x02
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export type PushResult = 'ok' | 'gone' | 'failed';

/** Benachrichtigung senden. „gone“: Abo existiert nicht mehr (löschen). */
export async function sendPush(
  sub: PushSubscriptionJSON,
  message: unknown,
  vapid: VapidConfig,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string; fetch?: typeof fetch } = {},
): Promise<PushResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttl ?? 3600),
    Urgency: opts.urgency ?? 'high',
  };
  // Topic ersetzt eine noch nicht zugestellte Nachricht mit gleichem Thema (max. 32 Zeichen, base64url)
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const res = await (opts.fetch ?? fetch)(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
