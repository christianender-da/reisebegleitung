/**
 * Teilen-Link als einfache Seite ohne JavaScript (z. B. Kindle, alte Browser): serverseitig gerendert, schwarz-weiß,
 * große Schrift, lädt sich selbst neu. Die einbettende App liefert sie mit
 * `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` aus (nur Inline-CSS, kein Skript).
 */
import { arrDelay, arrTime, boardingState, depDelay, depTime, journeyEnds, progress, TRANSITOUS_SOURCES, transfers, type Journey, type Mode, type Stopover } from '../core/index.ts';
import { i18n, trackText, type I18n, type Lang } from '../ui/i18n.ts';
import type { SharedResult } from './service.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function delay(d: number | undefined) {
  if (d === undefined) return '';
  return d > 0 ? ` <b>+${d}</b>` : '';
}

function stopLine(i: I18n, s: Stopover, kind: 'dep' | 'arr', mode?: Mode) {
  const planned = kind === 'dep' ? s.plannedDeparture : s.plannedArrival;
  const tr = s.track ?? s.plannedTrack;
  const changed = s.track && s.plannedTrack && s.track !== s.plannedTrack;
  return `<tr><td class="t">${planned ? i.time(planned) : '–'}${delay(kind === 'dep' ? depDelay(s) : arrDelay(s))}</td><td>${esc(s.stop.name)}${s.cancelled ? ` (${esc(i.t('cancelled'))})` : ''}</td><td class="p">${tr ? (changed ? '<b>' : '') + esc(trackText(i, mode, tr)) + (changed ? '</b>' : '') : ''}</td></tr>`;
}

function statusText(i: I18n, j: Journey, b: Parameters<typeof progress>[2], now: number): { text: string; sub: string } {
  const bs = boardingState(j, b, now);
  if (bs.prompt?.kind === 'missed') {
    const l = j.legs[bs.prompt.leg];
    return { text: i.t('altMissedTrain', { line: l.line ?? '' }), sub: l.from.stop.name };
  }
  const ph = progress(j, now, b).phase;
  if (ph.kind === 'before') {
    const l = j.legs[ph.legIndex];
    return { text: i.t('departsAt', { time: i.time(ph.departsAt) }), sub: [l.line, l.from.stop.name].filter(Boolean).join(' · ') };
  }
  if (ph.kind === 'riding') {
    const at = arrTime(ph.next) ?? depTime(ph.next);
    return { text: i.t(ph.onBoard ? 'onBoard' : 'riding', { line: j.legs[ph.legIndex].line ?? '' }), sub: i.t('nextStop', { name: ph.next.stop.name, time: at ? i.time(at) : '–' }) };
  }
  if (ph.kind === 'transfer') {
    const l = j.legs[ph.legIndex];
    return { text: i.t('changeAt', { at: ph.at.stop.name }), sub: l.kind === 'ride' ? i.t('nextLeg', { line: l.line ?? '', time: i.time(ph.departsAt) }) : '' };
  }
  return { text: i.t('arrived', { time: i.time(ph.arrivedAt) }), sub: '' };
}

export function renderSharedLite(result: SharedResult, lang: Lang = 'de', opts: { refreshSeconds?: number; now?: number } = {}): string {
  const i = i18n(lang);
  const now = opts.now ?? Date.now();
  const refresh = opts.refreshSeconds ?? 120;
  let body: string;
  let title = i.t('sharedTitle');
  if (result.status !== 'ok') {
    body = `<p class="big">${esc(i.t(result.status === 'expired' ? 'sharedExpired' : 'sharedNotFound'))}</p>`;
  } else {
    const { trip } = result;
    const j = trip.journey;
    const ends = journeyEnds(j);
    title = `${ends.from} → ${ends.to}`;
    const st = statusText(i, j, trip.boarding, now);
    const p = trip.progress;
    const trs = transfers(j, { boarding: trip.boarding });
    const rows: string[] = [];
    j.legs.forEach((l, k) => {
      if (l.kind !== 'ride') return;
      const tr = trs.find((x) => x.toLeg === k);
      if (tr) {
        const warn = tr.state === 'missed' ? i.t('missed') : tr.state === 'cancelled' ? i.t('transferCancelled') : tr.state === 'tight' ? i.t('tight') : '';
        rows.push(`<p class="chg">${esc(tr.state === 'done' ? i.t('transferDone') : i.t('buffer', { n: tr.bufferMin }))}${warn ? ` – <b>${esc(warn)}</b>` : ''}</p>`);
      }
      const onBoard = boardingState(j, trip.boarding, now).onBoard === k;
      rows.push(
        `<div class="leg"><p class="line"><b>${esc(l.line ?? '?')}</b>${l.headsign ? ` → ${esc(l.headsign)}` : ''}${l.cancelled ? ` <b>(${esc(i.t('cancelled'))})</b>` : ''}${onBoard ? ` <span class="tag">${esc(i.t('onBoardBadge'))}</span>` : ''}</p><table>${stopLine(i, l.from, 'dep', l.mode)}${stopLine(i, l.to, 'arr', l.mode)}</table></div>`,
      );
    });
    const arr = p.plannedArrival ? i.time(p.plannedArrival) : '–';
    const late = p.delayMin !== undefined && p.delayMin > 0 && p.arrival ? ` <b>+${p.delayMin}</b> → ${i.time(p.arrival)}` : p.delayMin !== undefined ? ` (${esc(i.t('onTime'))})` : '';
    const alt = trip.alternatives
      ? `<p class="warn">${esc(i.t(trip.alternatives.reason === 'connection' ? 'altConnection' : trip.alternatives.reason === 'cancelled' ? 'altCancelled' : 'altMissedTrain', { line: trip.alternatives.line ?? '' }))}</p>`
      : '';
    body = `
<p class="big">${esc(st.text)}</p>${st.sub ? `<p>${esc(st.sub)}</p>` : ''}
<p>${esc(i.t('arrival', { time: arr }))}${late}</p>
<div class="bar"><div style="width:${Math.round(p.fraction * 100)}%"></div></div>
${alt}
${rows.join('\n')}
<p class="small">${result.sharedBy ? esc(i.t('sharedBy', { name: result.sharedBy })) + ' · ' : ''}${esc(i.t('linkValidUntil', { time: `${i.day(result.expiresAt)} ${i.time(result.expiresAt)}` }))} · ${esc(i.t('asOfNow', { time: i.time(now) }))}</p>`;
  }
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${result.status === 'ok' ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)}</title>
<style>
body{margin:0;padding:16px 20px;background:#fff;color:#000;font-family:Georgia,serif;font-size:24px;line-height:1.35}
h1{font-size:28px;margin:0 0 8px}
p{margin:4px 0}
.big{font-size:32px;font-weight:bold}
.small{font-size:18px;margin-top:14px}
.bar{border:2px solid #000;height:12px;margin:8px 0 12px}.bar div{background:#000;height:12px}
.leg{border-top:1px solid #000;padding:6px 0}
.line{font-size:24px}
table{width:100%;border-collapse:collapse;font-size:22px}
td{padding:2px 4px;vertical-align:top}
td.t{white-space:nowrap;width:120px}
td.p{white-space:nowrap;text-align:right}
.chg{font-size:20px;padding-left:8px}
.warn{border:2px solid #000;padding:6px;font-weight:bold}
.tag{border:2px solid #000;padding:0 6px;font-size:18px}
.beta{font-size:16px;border-top:1px solid #000;margin-top:16px;padding-top:6px}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${body}
<p class="beta">${esc(i.t('beta'))} – ${esc(i.t('disclaimer'))} ${esc(i.t('sources'))}: ${esc(TRANSITOUS_SOURCES)}</p>
</body>
</html>`;
}
