/**
 * Anmeldung der eigenständigen App: genau ein Besitzer, Passkeys (WebAuthn).
 *
 * - Erster Passkey: Einrichtungscode (npm run app:setup-code, 30 min, einmalig) → danach Wiederherstellungscode (einmal angezeigt).
 * - Weitere Geräte: angemeldet „Passkey hinzufügen“. Notfall: Wiederherstellungscode → neuer Passkey, neuer Code.
 * - Sitzung: Cookie __Host-rb (HttpOnly, Secure, SameSite=Lax, 30 Tage); in D1 nur der SHA-256.
 * - Relying Party = aufgerufener Hostname (workers.dev oder eigene Domain).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

export interface AuthEnv {
  DB: D1Database;
}

const SESSION_DAYS = 30;
const OWNER = 'owner';
const enc = new TextEncoder();

export const nowIso = () => new Date().toISOString();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

function safeEqual(a: string, b: string) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const isHttp = (req: Request) => new URL(req.url).protocol === 'http:';
/** __Host- verlangt Secure – lokal (http://localhost) daher ohne Präfix */
const cookieName = (req: Request) => (isHttp(req) ? 'rb' : '__Host-rb');

function rp(req: Request) {
  const u = new URL(req.url);
  return { rpID: u.hostname, origin: u.origin };
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function meta(env: AuthEnv, key: string) {
  return (await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
}

async function setMeta(env: AuthEnv, key: string, value: string) {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

export async function hasPasskey(env: AuthEnv) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

// ---------- Sitzung ----------

export async function loggedIn(env: AuthEnv, req: Request): Promise<boolean> {
  const v = readCookie(req, cookieName(req));
  if (!v || v.length > 100) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').bind(await sha256(v)).first<{ expires_at: string }>();
  return !!row && row.expires_at > nowIso();
}

async function createSession(env: AuthEnv, req: Request): Promise<string> {
  const value = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)').bind(await sha256(value), nowIso(), inMinutes(SESSION_DAYS * 1440)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()),
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(nowIso()),
  ]);
  return `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttp(req) ? '' : '; Secure'}`;
}

export async function logout(env: AuthEnv, req: Request): Promise<string> {
  const v = readCookie(req, cookieName(req));
  if (v) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(v)).run();
  return `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttp(req) ? '' : '; Secure'}`;
}

// ---------- Challenges ----------

async function storeChallenge(env: AuthEnv, kind: 'register' | 'login', challenge: string) {
  const id = randomToken(16);
  await env.DB.prepare('INSERT INTO challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)').bind(id, challenge, kind, inMinutes(5)).run();
  return id;
}

async function takeChallenge(env: AuthEnv, kind: string, id: unknown) {
  if (typeof id !== 'string' || id.length > 40) return null;
  const row = await env.DB.prepare('DELETE FROM challenges WHERE id = ? AND kind = ? AND expires_at > ? RETURNING challenge')
    .bind(id, kind, nowIso())
    .first<{ challenge: string }>();
  return row?.challenge ?? null;
}

// ---------- Codes ----------

/** Lesbarer Code (ohne 0/O/1/I), Prüfung ohne Bindestriche und Groß/Klein */
export function readableCode(groups = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = [...crypto.getRandomValues(new Uint8Array(groups * 4))].map((b) => alphabet[b % alphabet.length]);
  return Array.from({ length: groups }, (_, i) => chars.slice(i * 4, i * 4 + 4).join('')).join('-');
}

const normCode = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

async function checkCode(env: AuthEnv, code: unknown): Promise<'setup' | 'recovery' | null> {
  if (typeof code !== 'string' || code.length < 8 || code.length > 80) return null;
  const hash = await sha256(normCode(code));
  const setup = await meta(env, 'setup_code_hash');
  const expires = await meta(env, 'setup_code_expires');
  if (setup && expires && expires > nowIso() && safeEqual(hash, setup)) return 'setup';
  const recovery = await meta(env, 'recovery_code_hash');
  if (recovery && safeEqual(hash, recovery)) return 'recovery';
  return null;
}

async function newRecoveryCode(env: AuthEnv) {
  const code = readableCode();
  await setMeta(env, 'recovery_code_hash', await sha256(normCode(code)));
  return code;
}

// ---------- Registrierung ----------

export async function registerOptions(env: AuthEnv, req: Request, body: { code?: unknown }, isLoggedIn: boolean) {
  if (!isLoggedIn && !(await checkCode(env, body.code))) return null;
  const existing = await env.DB.prepare('SELECT id, transports FROM credentials').all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: 'Reisebegleitung',
    rpID: rp(req).rpID,
    userID: new Uint8Array(enc.encode(OWNER)),
    userName: 'Reisebegleitung',
    attestationType: 'none',
    excludeCredentials: existing.results.map((c) => ({ id: c.id, transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return { options, challengeId: await storeChallenge(env, 'register', options.challenge) };
}

export async function registerVerify(
  env: AuthEnv,
  req: Request,
  body: { challengeId?: unknown; response?: RegistrationResponseJSON; code?: unknown },
  isLoggedIn: boolean,
): Promise<{ cookie: string; recoveryCode: string | null } | null> {
  const grant = isLoggedIn ? null : await checkCode(env, body.code);
  if (!isLoggedIn && !grant) return null;
  const challenge = await takeChallenge(env, 'register', body.challengeId);
  if (!challenge || !body.response) return null;
  const { rpID, origin } = rp(req);
  const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) return null;
  const { credential } = v.registrationInfo;
  await env.DB.prepare('INSERT INTO credentials (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(credential.id, b64url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), deviceName(req), nowIso())
    .run();
  if (grant === 'setup') await env.DB.prepare("DELETE FROM meta WHERE key IN ('setup_code_hash', 'setup_code_expires')").run();
  const recoveryCode = grant ? await newRecoveryCode(env) : null;
  return { cookie: await createSession(env, req), recoveryCode };
}

function deviceName(req: Request) {
  const ua = req.headers.get('User-Agent') ?? '';
  for (const [re, n] of [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Macintosh/, 'Mac'], [/Android/, 'Android'], [/Windows/, 'Windows']] as const) if (re.test(ua)) return n;
  return 'Passkey';
}

// ---------- Anmeldung ----------

export async function loginOptions(env: AuthEnv, req: Request) {
  const options = await generateAuthenticationOptions({ rpID: rp(req).rpID, userVerification: 'required' });
  return { options, challengeId: await storeChallenge(env, 'login', options.challenge) };
}

export async function loginVerify(env: AuthEnv, req: Request, body: { challengeId?: unknown; response?: AuthenticationResponseJSON }) {
  const challenge = await takeChallenge(env, 'login', body.challengeId);
  if (!challenge || !body.response?.id) return null;
  const cred = await env.DB.prepare('SELECT id, public_key, counter, transports FROM credentials WHERE id = ?')
    .bind(body.response.id)
    .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
  if (!cred) return null;
  const { rpID, origin } = rp(req);
  const v = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: cred.id,
      publicKey: fromB64url(cred.public_key),
      counter: cred.counter,
      transports: cred.transports ? (JSON.parse(cred.transports) as AuthenticatorTransport[]) : undefined,
    },
  });
  if (!v.verified) return null;
  await env.DB.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').bind(v.authenticationInfo.newCounter, nowIso(), cred.id).run();
  return createSession(env, req);
}
