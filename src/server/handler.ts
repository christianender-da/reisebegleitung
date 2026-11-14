/**
 * HTTP-Schnittstelle der Reisebegleitung – ohne Framework (Request → Response), damit sie sich in jede
 * Worker-/Hono-/sonstige App einhängen lässt. Die Anmeldung macht die einbettende App und übergibt das Ergebnis.
 *
 *   GET    /trips          Reisen mit Live-Stand (+ dticket-Vorgabe, wenn canEdit)
 *   POST   /trips          { planId, index, ticket, dticket }          (canEdit)
 *   DELETE /trips/<id>                                                   (canEdit)
 *   POST   /trips/<id>/boarding  { leg, action: checkin|missed|undo }    (canEdit)
 *   GET    /stops?q=                                                     (canEdit)
 *   GET    /plan?from&to&time&arriveBy=1&ticket&dticket=1                (canEdit)
 */
import { errorCode, parseTicket, type JourneyService } from './service.ts';

export interface JourneyRequestContext {
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

const status = (code: string) => (code === 'bad-request' || code === 'plan-expired' ? 400 : code === 'not-found' ? 404 : 502);

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
      return json({ trips, dticket: ctx.canEdit ? await service.dticketDefault(ctx.scope) : undefined });
    }
    if (!ctx.canEdit) return json({ error: 'forbidden' }, 403);
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
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
