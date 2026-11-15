/**
 * Reisebegleitung – eigenständige App (Cloudflare Worker + D1).
 *
 * /api/auth/*      Passkey-Anmeldung (Rate-Limit pro IP)
 * /api/journey/*   Reisebegleitung (nur angemeldet) – siehe src/server/handler.ts
 * /r/<token>       Teilen-Link ohne Anmeldung: Seite, /data (JSON), /avatar (Foto), /lite (ohne JavaScript)
 * sonst            Oberfläche (Assets, SPA)
 * Cron (jede Minute): laufende Reisen mit Echtzeit auffrischen
 */
import { Hono, type Context } from 'hono';
import { createJourneyService, d1Store, handleJourneyRequest, handleSharedAvatar, handleSharedRequest, renderSharedLite, type JourneyService } from '../../src/server/index.ts';
import * as auth from './auth.ts';
import { contactOk, VERSION } from './config.ts';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AUTH_LIMIT?: RateLimit;
  /** Pflicht: Kontakt (E-Mail oder URL) für den User-Agent an Transitous */
  CONTACT?: string;
  /** optional: andere MOTIS-Instanz (z. B. eigene oder lokale Weiterleitung) */
  TRANSITOUS_URL?: string;
  /** optional (Secret): privater VAPID-Schlüssel als JWK für Benachrichtigungen – npm run vapid-keys */
  VAPID_PRIVATE_JWK?: string;
  /** optional: Name, den Empfänger von Teilen-Links sehen („Geteilt von …“) */
  OWNER_NAME?: string;
  /** "1": fehlende Zuggleise aus DB IRIS ergänzen (inoffiziell, ohne Key) */
  IRIS_PLATFORMS?: string;
  /** optional: andere IRIS-Adresse (z. B. lokale Weiterleitung) */
  IRIS_URL?: string;
}

type App = { Bindings: Env };
const app = new Hono<App>();

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

app.use('*', async (c, next) => {
  await next();
  // Antworten aus ASSETS sind unveränderlich → kopieren
  c.res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  if (new URL(c.req.url).pathname.startsWith('/api/')) c.res.headers.set('Cache-Control', 'no-store');
});

let service: JourneyService | null = null;
let serviceKey = '';
function journeyService(env: Env): JourneyService | null {
  if (!contactOk(env.CONTACT)) return null;
  const k = `${env.CONTACT}|${env.TRANSITOUS_URL ?? ''}|${env.VAPID_PRIVATE_JWK ?? ''}|${env.IRIS_PLATFORMS ?? ''}|${env.IRIS_URL ?? ''}`;
  if (!service || serviceKey !== k) {
    const contact = env.CONTACT!.trim();
    service = createJourneyService({
      store: d1Store(env.DB),
      userAgent: `reisebegleitung/${VERSION} (+${contact})`,
      apiBase: env.TRANSITOUS_URL || undefined,
      irisPlatforms: env.IRIS_PLATFORMS === '1',
      irisBase: env.IRIS_URL || undefined,
      // Push-Dienste verlangen einen Kontakt als mailto: oder https:
      push: { privateJwk: env.VAPID_PRIVATE_JWK, subject: contact.includes('@') && !contact.startsWith('http') ? `mailto:${contact}` : contact },
    });
    serviceKey = k;
  }
  return service;
}

async function limited(c: Context<App>) {
  if (!c.env.AUTH_LIMIT) return false;
  const { success } = await c.env.AUTH_LIMIT.limit({ key: c.req.header('CF-Connecting-IP') ?? 'local' });
  return !success;
}

async function body<T>(c: Context<App>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

// ---------- Anmeldung ----------

app.get('/api/auth/status', async (c) =>
  c.json({ loggedIn: await auth.loggedIn(c.env, c.req.raw), hasPasskey: await auth.hasPasskey(c.env), configured: contactOk(c.env.CONTACT), version: VERSION }),
);

app.post('/api/auth/register/options', async (c) => {
  if (await limited(c)) return c.json({ error: 'rate-limited' }, 429);
  const r = await auth.registerOptions(c.env, c.req.raw, await body(c), await auth.loggedIn(c.env, c.req.raw));
  return r ? c.json(r) : c.json({ error: 'code' }, 403);
});

app.post('/api/auth/register/verify', async (c) => {
  if (await limited(c)) return c.json({ error: 'rate-limited' }, 429);
  try {
    const r = await auth.registerVerify(c.env, c.req.raw, await body(c), await auth.loggedIn(c.env, c.req.raw));
    if (!r) return c.json({ error: 'failed' }, 400);
    c.header('Set-Cookie', r.cookie);
    return c.json({ ok: true, recoveryCode: r.recoveryCode });
  } catch (e) {
    console.warn('register', String(e));
    return c.json({ error: 'failed' }, 400);
  }
});

app.post('/api/auth/login/options', async (c) => {
  if (await limited(c)) return c.json({ error: 'rate-limited' }, 429);
  return c.json(await auth.loginOptions(c.env, c.req.raw));
});

app.post('/api/auth/login/verify', async (c) => {
  if (await limited(c)) return c.json({ error: 'rate-limited' }, 429);
  try {
    const cookie = await auth.loginVerify(c.env, c.req.raw, await body(c));
    if (!cookie) return c.json({ error: 'failed' }, 401);
    c.header('Set-Cookie', cookie);
    return c.json({ ok: true });
  } catch (e) {
    console.warn('login', String(e));
    return c.json({ error: 'failed' }, 401);
  }
});

app.post('/api/auth/logout', async (c) => {
  c.header('Set-Cookie', await auth.logout(c.env, c.req.raw));
  return c.json({ ok: true });
});

// ---------- Reisebegleitung ----------

app.all('/api/journey/*', async (c) => {
  if (!(await auth.loggedIn(c.env, c.req.raw))) return c.json({ error: 'unauthorized' }, 401);
  const s = journeyService(c.env);
  if (!s) return c.json({ error: 'no-contact' }, 503);
  const path = new URL(c.req.url).pathname.slice('/api/journey'.length);
  return handleJourneyRequest(s, c.req.raw, path, { scope: 'default', owner: 'owner', canEdit: true, ownerName: c.env.OWNER_NAME ?? null });
});

app.all('/api/*', (c) => c.json({ error: 'not-found' }, 404));

// ---------- Teilen-Links (ohne Anmeldung) ----------

const TOKEN = /^[\w-]{20,64}$/;
const langOf = (c: Context<App>) => ((c.req.header('Accept-Language') ?? '').toLowerCase().startsWith('de') ? 'de' : 'en');

app.get('/r/:token/data', async (c) => {
  const s = journeyService(c.env);
  if (!s) return c.json({ error: 'no-contact' }, 503);
  const res = await handleSharedRequest(s, c.req.param('token'));
  // ungültige Tokens bremsen (Raten verhindern)
  if (res.status === 404 && (await limited(c))) return c.json({ error: 'rate-limited' }, 429);
  return res;
});

app.get('/r/:token/avatar', async (c) => {
  const s = journeyService(c.env);
  if (!s) return c.json({ error: 'no-contact' }, 503);
  const res = await handleSharedAvatar(s, c.req.param('token'));
  if (res.status === 404 && (await limited(c))) return c.json({ error: 'rate-limited' }, 429);
  return res;
});

app.get('/r/:token/lite', async (c) => {
  const s = journeyService(c.env);
  if (!s) return c.text('Not configured', 503);
  const result = await s.shared(c.req.param('token'));
  if (result.status === 'not-found' && (await limited(c))) return c.text('Too many requests', 429);
  return c.body(renderSharedLite(result, langOf(c)), result.status === 'ok' ? 200 : result.status === 'expired' ? 410 : 404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // nur Inline-CSS, kein Skript (alte Browser, Kindle)
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
});

app.get('/r/:token', async (c) => {
  if (!TOKEN.test(c.req.param('token'))) return c.text('Not found', 404);
  const page = await c.env.ASSETS.fetch(new Request(new URL('/share.html', c.req.url)));
  return new Response(page.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
});

// ---------- Oberfläche ----------

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------- Hintergrund: laufende Reisen jede Minute auffrischen (Cron in wrangler.jsonc) ----------

async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
  const s = journeyService(env);
  if (!s) return;
  ctx.waitUntil(
    s.refreshActive().catch((e) => {
      console.warn('refreshActive', String(e));
    }),
  );
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
