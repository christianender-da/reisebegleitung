/**
 * HTTP-Schnittstelle der Reisebegleitung – ohne Framework (Request → Response), damit sie sich in jede
 * Worker-/Hono-/sonstige App einhängen lässt. Die Anmeldung macht die einbettende App und übergibt das Ergebnis.
 *
 *   GET    /trips          Reisen mit Live-Stand (+ dticket-Vorgabe, wenn canEdit)
 *   POST   /trips          { planId, index, ticket, dticket }          (canEdit)
 *   DELETE /trips/<id>                                                   (canEdit)
 *   POST   /trips/<id>/boarding  { leg, action: checkin|missed|undo }    (canEdit)
 *   POST   /trips/<id>/alternative  { index }                           (canEdit)
 *   GET    /trips/<id>/shares                                           (canEdit)  → { shares }
 *   POST   /trips/<id>/shares  { label }                                (canEdit)  → { share: { id, token, expiresAt, … } }
 *   DELETE /trips/<id>/shares/<shareId>                                 (canEdit)
 *
 * Teilen-Links (ohne Anmeldung): handleSharedRequest() bzw. renderSharedLite() unter einem eigenen Pfad einhängen.
 *   GET    /push/key                                                    (canEdit)  → { key } (null = Push nicht eingerichtet)
 *   POST   /push/subscribe   { subscription, lang }                    (canEdit)
 *   POST   /push/unsubscribe { endpoint }                              (canEdit)
 *   POST   /push/test        { lang }                                  (canEdit)  → { sent }
 *   GET    /avatar?v=…     Foto (für alle, die die Reisen sehen; 404 = keins)
 *   PUT    /avatar  { image: data:-URL (JPEG/PNG/WebP, ≤ 200 KB) }    (canEdit)  → { avatar: version }
 *   DELETE /avatar                                                      (canEdit)
 *   GET    /stops?q=                                                     (canEdit)
 *   GET    /plan?from&to&time&arriveBy=1&ticket&dticket=1                (canEdit)
 */
import { errorCode, parseTicket, type Avatar, type JourneyService } from './service.ts';

export interface JourneyRequestContext {
  /** Anzeigename für Empfänger von Teilen-Links (optional) */
  ownerName?: string | null;
  /** getrennte Reiseliste, z. B. Widget-ID oder „default“ */
  scope: string;
  /** wer anlegt (für spätere Auswertung) */
  owner: string;
  /** darf suchen, anlegen, löschen */
  canEdit: boolean;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Bild ausliefern; die Adresse enthält die Version (?v=…), darf also lange im Cache bleiben */
function image(a: Avatar | null, maxAge: number): Response {
  if (!a) return json({ error: 'not-found' }, 404);
  return new Response(a.bytes as Uint8Array<ArrayBuffer>, {
    headers: { 'Content-Type': a.type, 'Cache-Control': `private, max-age=${maxAge}`, 'X-Content-Type-Options': 'nosniff', ETag: `"${a.version}"` },
  });
}

const status = (code: string) =>
  code === 'bad-request' || code === 'plan-expired' ? 400 : code === 'not-found' ? 404 : code === 'push-off' || code === 'too-many' ? 409 : code === 'expired' ? 410 : 502;

/**
 * path: Pfad unterhalb des Einhängepunkts, z. B. „/trips“ (bei Einhängen unter /api/journey der Rest nach /api/journey)
 */
export async function handleJourneyRequest(service: JourneyService, request: Request, path: string, ctx: JourneyRequestContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  const q = (k: string) => url.searchParams.get(k) ?? '';
  try {
    if (parts[0] === 'trips' && parts.length === 1 && method === 'GET') {
      const trips = await service.trips(ctx.scope);
      return json({ trips, dticket: ctx.canEdit ? await service.dticketDefault(ctx.scope) : undefined, avatar: await service.avatarVersion(ctx.scope) });
    }
    if (parts[0] === 'avatar' && parts.length === 1 && method === 'GET') return image(await service.avatar(ctx.scope), 31_536_000);
    if (!ctx.canEdit) return json({ error: 'forbidden' }, 403);
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PUT') {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        /* leer */
      }
    }
    if (parts[0] === 'trips' && parts.length === 1 && method === 'POST') {
      return json({ id: await service.createTrip(ctx.scope, ctx.owner, body) }, 201);
    }
    if (parts[0] === 'trips' && parts.length === 3 && parts[2] === 'boarding' && method === 'POST') {
      return json({ trip: await service.board(ctx.scope, decodeURIComponent(parts[1]), body.leg, body.action) });
    }
    if (parts[0] === 'trips' && parts.length === 2 && method === 'DELETE') {
      await service.deleteTrip(ctx.scope, decodeURIComponent(parts[1]));
      return json({ ok: true });
    }
    if (parts[0] === 'trips' && parts[2] === 'shares') {
      const tripId = decodeURIComponent(parts[1]);
      if (parts.length === 3 && method === 'GET') return json({ shares: await service.listShares(ctx.scope, tripId) });
      if (parts.length === 3 && method === 'POST') return json({ share: await service.createShare(ctx.scope, tripId, body, ctx.ownerName) }, 201);
      if (parts.length === 4 && method === 'DELETE') {
        await service.revokeShare(ctx.scope, tripId, decodeURIComponent(parts[3]));
        return json({ ok: true });
      }
    }
    if (parts[0] === 'trips' && parts.length === 3 && parts[2] === 'alternative' && method === 'POST') {
      return json({ trip: await service.chooseAlternative(ctx.scope, decodeURIComponent(parts[1]), body.index) });
    }
    if (parts[0] === 'avatar' && parts.length === 1 && method === 'PUT') return json({ avatar: await service.setAvatar(ctx.scope, body) });
    if (parts[0] === 'avatar' && parts.length === 1 && method === 'DELETE') {
      await service.deleteAvatar(ctx.scope);
      return json({ ok: true });
    }
    if (parts[0] === 'push' && parts.length === 2) {
      if (parts[1] === 'key' && method === 'GET') return json({ key: service.pushKey() });
      if (parts[1] === 'subscribe' && method === 'POST') {
        await service.subscribe(ctx.scope, body);
        return json({ ok: true });
      }
      if (parts[1] === 'unsubscribe' && method === 'POST') {
        await service.unsubscribe(body);
        return json({ ok: true });
      }
      if (parts[1] === 'test' && method === 'POST') return json({ sent: await service.testPush(ctx.scope, body.lang) });
    }
    if (parts[0] === 'stops' && parts.length === 1 && method === 'GET') {
      try {
        return json({ hits: await service.searchStops(q('q')) });
      } catch (e) {
        return json({ hits: [], error: errorCode(e) });
      }
    }
    if (parts[0] === 'plan' && parts.length === 1 && method === 'GET') {
      const ticket = parseTicket(q('ticket'));
      if (!ticket) return json({ error: 'bad-request' }, 400);
      return json(
        await service.plan({ from: q('from'), to: q('to'), fromName: q('fromName') || undefined, toName: q('toName') || undefined, time: q('time') || undefined, arriveBy: q('arriveBy') === '1', ticket, dticket: q('dticket') === '1' }),
      );
    }
    return json({ error: 'not-found' }, 404);
  } catch (e) {
    const code = errorCode(e);
    if (code === 'unavailable') console.warn('reisebegleitung', path, String(e));
    return json({ error: code }, status(code));
  }
}

/**
 * Öffentliche Daten eines Teilen-Links (ohne Anmeldung): 200 { trip, expiresAt, sharedBy } · 410 { error: 'expired' } · 404.
 * Ungültige Tokens bitte in der einbettenden App per Rate-Limit begrenzen.
 */
export async function handleSharedRequest(service: JourneyService, token: string): Promise<Response> {
  try {
    const r = await service.shared(token);
    if (r.status === 'ok') return json({ trip: r.trip, expiresAt: r.expiresAt, sharedBy: r.sharedBy, avatar: r.avatar ?? null });
    return json({ error: r.status }, r.status === 'expired' ? 410 : 404);
  } catch (e) {
    console.warn('reisebegleitung shared', String(e));
    return json({ error: 'unavailable' }, 502);
  }
}

/** Foto des Teilenden zu einem Teilen-Link (z. B. unter /r/<token>/avatar einhängen); 404 ohne Foto oder nach Ablauf */
export async function handleSharedAvatar(service: JourneyService, token: string): Promise<Response> {
  try {
    return image(await service.sharedAvatar(token), 86_400);
  } catch (e) {
    console.warn('reisebegleitung shared avatar', String(e));
    return json({ error: 'unavailable' }, 502);
  }
}
