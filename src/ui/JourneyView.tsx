/**
 * Reisebegleitung – Oberfläche (Preact): Reisen mit Live-Stand, Reise anlegen.
 * Eigenständig nutzbar und als Dashboard-Widget; Stile in styles.css (Klassen „rb-…“, Farben über CSS-Variablen).
 * Aktualisierung alle 60 s, solange sichtbar. Der Quellenlink zu Transitous ist Pflicht und bleibt sichtbar.
 */
import { createContext, type JSX } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  arrDelay,
  arrTime,
  boardingState,
  type AlternativeOption,
  type Boarding,
  type BoardingEvent,
  type Coverage,
  depDelay,
  depTime,
  journeyEnds,
  progress,
  rides,
  TRANSITOUS_SOURCES,
  transfers as transfersOf,
  type Journey,
  type Leg,
  type Mode,
  type StopHit,
  type Stopover,
  type Ticket,
  type Transfer,
} from '../core/index.ts';
import type { ShareInfo, SharedTripView, TripView } from '../server/service.ts';
import { JourneyApiError, type JourneyApi } from './api.ts';
import { prepareAvatar } from './avatar.ts';
import { MissedIcon, VehicleIcon, WalkerIcon, walkPace } from './icons.tsx';
import { i18n, trackText, type I18n, type Key, type Lang } from './i18n.ts';

/** avatar: Adresse des Fotos (falls vorhanden) */
const Ctx = createContext<{ api: JourneyApi; i: I18n; shareUrl: (token: string) => string; avatar?: string }>(null as never);
/** Reise in der Oberfläche: eigene (mit Ticket) oder geteilte (ohne Ticketangaben) */
type AnyTrip = Omit<TripView, 'ticket' | 'dticket'> & { ticket?: Ticket; dticket?: boolean };
const defaultShareUrl = (token: string) => `${location.origin}/r/${token}`;
const useI = () => useContext(Ctx).i;

const TICKET_KEYS: Record<Ticket, Key> = {
  flex: 'ticket_flex',
  spar: 'ticket_spar',
  bc100: 'ticket_bc100',
  dticket: 'ticket_dticket',
  other: 'ticket_other',
};

/** Testfahrt: zum nächsten Szenenwechsel neu laden */
function useDemoReload(trips: { demo?: { next: string } }[] | undefined, load: () => void) {
  const next = trips?.reduce((m, t) => (t.demo ? Math.min(m, Date.parse(t.demo.next)) : m), Infinity) ?? Infinity;
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const id = setTimeout(load, Math.max(1000, next - Date.now() + 1500));
    return () => clearTimeout(id);
  }, [next, load]);
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const berlinDay = (x: string | number) => new Date(x).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

/** Zeit relativ (bis 20 min) oder als Uhrzeit, an anderen Tagen mit Datum */
function when(i: I18n, iso: string) {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (min <= 0 && min > -2) return i.t('now');
  if (min > 0 && min < 20) return i.t('inMin', { n: min });
  return berlinDay(iso) === berlinDay(Date.now()) ? i.time(iso) : `${i.day(iso)} ${i.time(iso)}`;
}

function modeClass(m: Mode) {
  if (m === 'highspeed' || m === 'longdistance' || m === 'night') return 'fv';
  if (m === 'regional') return 'rail';
  return m;
}

function Delay({ d }: { d?: number }) {
  if (d === undefined) return null;
  if (d <= 0) return <span class="rb-ontime">{d < 0 ? d : '+0'}</span>;
  return <span class={d >= 5 ? 'rb-late' : 'rb-slight'}>+{d}</span>;
}

function Track({ s, mode }: { s: Stopover; mode?: Mode }) {
  const i = useI();
  const tr = s.track ?? s.plannedTrack;
  if (!tr) return null;
  const changed = s.track && s.plannedTrack && s.track !== s.plannedTrack;
  return <span class={`rb-track ${changed ? 'changed' : ''}`}>{trackText(i, mode, tr)}</span>;
}

/** Zugnummern nur bei Zügen anzeigen (bei Tram/Bus sind es Umlaufnummern) */
const isTrain = (m: Mode) => ['highspeed', 'longdistance', 'night', 'regional', 'suburban'].includes(m);

function LineBadge({ l }: { l: Leg }) {
  return <span class={`rb-line mode-${modeClass(l.mode)}`}>{l.line ?? '?'}</span>;
}

function StopRow({ s, kind, cls = '', mode }: { s: Stopover; kind: 'dep' | 'arr'; cls?: string; mode?: Mode }) {
  const i = useI();
  const planned = kind === 'dep' ? s.plannedDeparture : s.plannedArrival;
  return (
    <div class={`rb-stop ${cls} ${s.cancelled ? 'cancelled' : ''}`}>
      <span class="rb-time">
        {planned ? i.time(planned) : '–'} <Delay d={kind === 'dep' ? depDelay(s) : arrDelay(s)} />
      </span>
      <span class="rb-name">{s.stop.name}</span>
      <Track s={s} mode={mode} />
    </div>
  );
}

function TransferRow({ tr, walk, active }: { tr: Transfer; walk?: number; active: boolean }) {
  const i = useI();
  const lost = tr.state === 'missed' || tr.state === 'cancelled';
  const text = tr.state === 'cancelled' ? i.t('transferCancelled') : tr.state === 'missed' ? i.t('missed') : tr.state === 'tight' ? i.t('tight') : '';
  if (tr.state === 'done')
    return (
      <li class="rb-transfer state-done">
        <span class="rb-dot" aria-hidden="true" />
        <span>{i.t('transferDone')}</span>
      </li>
    );
  return (
    <li class={`rb-transfer state-${tr.state} ${active ? 'active' : ''}`}>
      <span class="rb-dot" aria-hidden="true" />
      {lost ? <MissedIcon /> : <WalkerIcon pace={walkPace(tr.bufferMin - tr.neededMin)} moving={active} />}
      <span>
        {i.t('buffer', { n: tr.bufferMin })}
        {walk ? ` · ${i.t('walk', { n: walk })}` : ''}
        {text && <strong> · {text}</strong>}
      </span>
    </li>
  );
}

function LegItem({ l, current, now, onBoard, checkin }: { l: Leg; current: boolean; now: number; onBoard: boolean; checkin?: BoardingEvent }) {
  const i = useI();
  const passed = (s: Stopover) => {
    const x = Date.parse(arrTime(s) ?? depTime(s) ?? '');
    return Number.isFinite(x) && x <= now;
  };
  return (
    <li class={`rb-leg ${current ? 'current' : ''} ${l.cancelled ? 'cancelled' : ''}`}>
      <div class="rb-leg-head">
        <VehicleIcon mode={l.mode} moving={current} />
        <LineBadge l={l} />
        <span class="rb-dir">{l.headsign ? i.t('towards', { d: l.headsign }) : ''}</span>
        {l.number && isTrain(l.mode) && !(l.line ?? '').includes(l.number) && <span class="rb-muted rb-small">{i.t('train', { n: l.number })}</span>}
        {l.cancelled && <span class="rb-late">{i.t('cancelled')}</span>}
        {onBoard ? <span class="rb-onboard">{i.t('onBoardBadge')}</span> : checkin ? <span class="rb-muted rb-small">✓ {i.t('checkedIn', { time: i.time(checkin.at) })}</span> : null}
      </div>
      <StopRow s={l.from} kind="dep" mode={l.mode} cls={passed(l.from) ? 'passed' : ''} />
      {l.stopovers.length > 0 && (
        <details class="rb-inner" open={current}>
          <summary class="rb-muted rb-small">{l.stopovers.length === 1 ? i.t('stop1') : i.t('stops', { n: l.stopovers.length })}</summary>
          {l.stopovers.map((s, k) => (
            <StopRow s={s} kind="arr" mode={l.mode} key={k} cls={`inner ${passed(s) ? 'passed' : ''}`} />
          ))}
        </details>
      )}
      <StopRow s={l.to} kind="arr" mode={l.mode} cls={passed(l.to) ? 'passed' : ''} />
    </li>
  );
}

function Status({ j, now, boarding }: { j: Journey; now: number; boarding: Boarding }) {
  const i = useI();
  const p = progress(j, now, boarding);
  const ph = p.phase;
  const bs = boardingState(j, boarding, now);
  let kind: 'on' | 'busy' | 'off' | 'warn' = 'on';
  let text = '';
  let sub = '';
  if (bs.prompt?.kind === 'missed') {
    const l = j.legs[bs.prompt.leg];
    kind = 'warn';
    text = i.t('altMissedTrain', { line: l.line ?? '' });
    sub = l.from.stop.name;
  } else if (ph.kind === 'before') {
    const l = j.legs[ph.legIndex];
    kind = 'off';
    text = i.t('departsAt', { time: when(i, ph.departsAt) });
    const tr = l.from.track ?? l.from.plannedTrack;
    sub = [l.line, l.from.stop.name, tr ? trackText(i, l.mode, tr) : ''].filter(Boolean).join(' · ');
  } else if (ph.kind === 'riding') {
    kind = 'busy';
    text = i.t(ph.onBoard ? 'onBoard' : 'riding', { line: j.legs[ph.legIndex].line ?? '' });
    const at = arrTime(ph.next) ?? depTime(ph.next);
    sub = i.t('nextStop', { name: ph.next.stop.name, time: at ? i.time(at) : '–' });
  } else if (ph.kind === 'transfer') {
    const l = j.legs[ph.legIndex];
    kind = 'busy';
    text = i.t('changeAt', { at: ph.at.stop.name });
    const tr = l.from.track ?? l.from.plannedTrack;
    sub = [l.kind === 'ride' ? i.t('nextLeg', { line: l.line ?? '', time: when(i, ph.departsAt) }) : '', tr ? trackText(i, l.mode, tr) : '']
      .filter(Boolean)
      .join(' · ');
  } else {
    text = i.t('arrived', { time: i.time(ph.arrivedAt) });
  }
  const pct = Math.round(p.fraction * 100);
  return (
    <>
      <div class={`rb-state rb-state-${kind}`}>
        <span class="rb-dot" aria-hidden="true" />
        <span class="rb-state-text">{text}</span>
        {sub && <span class="rb-muted rb-state-sub">{sub}</span>}
      </div>
      <div class="rb-arrival">
        <span>{i.t('arrival', { time: p.plannedArrival ? i.time(p.plannedArrival) : '–' })}</span>
        {p.delayMin !== undefined && (p.delayMin > 0 ? <Delay d={p.delayMin} /> : <span class="rb-ontime">{i.t('onTime')}</span>)}
        {p.delayMin !== undefined && p.delayMin > 0 && p.arrival && <span class="rb-muted"> → {i.time(p.arrival)}</span>}
      </div>
      <div class="rb-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}

function TripCard({ trip, canEdit, onChanged, onReplan }: { trip: AnyTrip; canEdit: boolean; onChanged: () => void; onReplan: (from: StopHit, to: StopHit) => void }) {
  const { api, i, avatar } = useContext(Ctx);
  const j = trip.journey;
  const boarding = trip.boarding ?? { checkins: [], missed: [] };
  const now = Date.now();
  const ends = journeyEnds(j);
  const ph = progress(j, now, boarding).phase;
  const bs = boardingState(j, boarding, now);
  const currentLeg = ph.kind === 'riding' && bs.prompt?.kind !== 'missed' ? ph.legIndex : -1;
  const trs = transfersOf(j, { boarding });
  const start = j.legs[0]?.from.plannedDeparture;
  const items: JSX.Element[] = [];
  j.legs.forEach((l, k) => {
    if (l.kind !== 'ride') return;
    const tr = trs.find((x) => x.toLeg === k);
    if (tr) {
      const walk = j.legs.slice(tr.fromLeg + 1, k).reduce((s, w) => s + (w.walkMin ?? 0), 0);
      items.push(<TransferRow tr={tr} walk={walk} active={ph.kind === 'transfer' && ph.legIndex === k} key={`t${k}`} />);
    }
    items.push(<LegItem l={l} current={k === currentLeg} now={now} onBoard={bs.onBoard === k} checkin={boarding.checkins.find((e) => e.leg === k)} key={`l${k}`} />);
  });
  const last = j.legs.at(-1);
  const lastWalk = last?.kind === 'walk' ? last.walkMin : undefined;

  const [sharing, setSharing] = useState(false);

  async function remove() {
    if (!confirm(i.t('confirmDelete'))) return;
    await api.deleteTrip(trip.id);
    onChanged();
  }

  return (
    <section class="rb-trip">
      <div class="rb-head">
        {avatar && <Avatar src={avatar} />}
        <div class="rb-head-text">
          <h3>
            {ends.from} → {ends.to}
          </h3>
          <div class="rb-muted rb-small">
            {[start ? i.day(start) : '', trip.ticket ? i.t(TICKET_KEYS[trip.ticket]) : '', trip.ticket && trip.dticket && trip.ticket !== 'dticket' ? i.t('withDTicket') : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>
      {trip.demo && (
        <p class="rb-demo rb-small">
          🧪{' '}
          {i.t('demoNote', { n: trip.demo.scene, total: trip.demo.scenes, scene: i.t(`demo_${trip.demo.key.replace(/-/g, '_')}` as Key), time: i.time(trip.demo.next) })}
        </p>
      )}
      <Status j={j} now={now} boarding={boarding} />
      {trip.alternatives && <AlternativesBox trip={trip} canEdit={canEdit} onChanged={onChanged} />}
      {canEdit && bs.prompt && !(bs.prompt.kind === 'missed' && trip.alternatives?.options.length) && (
        <BoardingPrompt trip={trip} prompt={bs.prompt} onChanged={onChanged} onReplan={onReplan} />
      )}
      <ol class="rb-legs">{items}</ol>
      {lastWalk ? <p class="rb-muted rb-small">{i.t('walk', { n: lastWalk })}</p> : null}
      {trip.stale && trip.refreshedAt && <p class="rb-muted rb-small">{i.t('stale', { time: i.time(trip.refreshedAt) })}</p>}
      {canEdit && sharing && <SharePanel trip={trip} />}
      {canEdit && (
        <div class="rb-row">
          <button type="button" class={`rb-btn rb-btn-small ${sharing ? 'rb-primary' : ''}`} onClick={() => setSharing(!sharing)}>
            ↗ {i.t('share')}
          </button>
          <span class="rb-spacer" />
          <button type="button" class="rb-btn rb-btn-small rb-danger" onClick={remove}>
            {i.t('deleteTrip')}
          </button>
        </div>
      )}
    </section>
  );
}

export interface JourneyViewProps {
  api: JourneyApi;
  /** darf suchen, anlegen, löschen */
  canEdit: boolean;
  lang?: Lang;
  /** Aktualisierung in ms (Standard 60 s) */
  refreshMs?: number;
  /** Adresse eines Teilen-Links aus dem Token (Standard: <origin>/r/<token>) */
  shareUrl?: (token: string) => string;
}

/** Hauptansicht: alle Reisen mit Live-Stand + (für Berechtigte) „Reise anlegen“ */
export function JourneyView({ api, canEdit, lang = 'de', refreshMs = 60_000, shareUrl = defaultShareUrl }: JourneyViewProps) {
  const i = useMemo(() => i18n(lang), [lang]);
  const [data, setData] = useState<{ trips: TripView[]; dticket?: boolean; avatar?: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  /** false = Liste; sonst „Reise anlegen“, ggf. mit Start/Ziel vorbelegt */
  const [creating, setCreating] = useState<false | { from?: StopHit; to?: StopHit }>(false);
  const avatarVersion = data?.avatar ?? null;
  const ctx = useMemo(() => ({ api, i, shareUrl, avatar: avatarVersion ? api.avatarUrl(avatarVersion) : undefined }), [api, i, shareUrl, avatarVersion]);
  useTick(30_000);

  const load = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    api
      .trips()
      .then((r) => {
        setData(r);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [api]);

  useEffect(() => {
    load();
    const id = setInterval(load, refreshMs);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, [load, refreshMs]);
  useDemoReload(data?.trips, load);

  return (
    <Ctx.Provider value={ctx}>
      <div class="rb-root">
        {creating ? (
          <NewTrip
            initialFrom={creating.from}
            initialTo={creating.to}
            defaultDTicket={data?.dticket ?? false}
            onDone={(saved) => {
              setCreating(false);
              if (saved) load();
            }}
          />
        ) : (
          <>
            {!data && <p class="rb-muted">{failed ? i.t('unavailable') : i.t('loading')}</p>}
            {data && data.trips.length === 0 && <p class="rb-muted">{i.t('none')}</p>}
            {data?.trips.map((tr) => (
              <TripCard trip={tr} canEdit={canEdit} onChanged={load} onReplan={(from, to) => setCreating({ from, to })} key={tr.id} />
            ))}
            {data && failed && <p class="rb-muted rb-small">{i.t('unavailable')}</p>}
            <div class="rb-row">
              {canEdit && (
                <button type="button" class="rb-btn rb-btn-small" onClick={() => setCreating({})}>
                  + {i.t('newTrip')}
                </button>
              )}
              <span class="rb-spacer" />
              <a class="rb-muted rb-small" href={TRANSITOUS_SOURCES} target="_blank" rel="noopener noreferrer">
                {i.t('sources')}
              </a>
            </div>
            {canEdit && <PushToggle />}
            {canEdit && data && <PhotoSetting hasPhoto={!!avatarVersion} onChanged={load} />}
            <Disclaimer />
          </>
        )}
      </div>
    </Ctx.Provider>
  );
}

/** Beta-Kennzeichen + Haftungsausschluss (bleibt in jeder Ansicht sichtbar) */
function Disclaimer() {
  const i = useI();
  return (
    <p class="rb-disclaimer rb-muted rb-small">
      <span class="rb-beta">{i.t('beta')}</span> {i.t('disclaimer')}
    </p>
  );
}

/** Teilen-Links einer Reise: anlegen (Token nur einmal sichtbar), senden/kopieren, widerrufen */
function SharePanel({ trip }: { trip: AnyTrip }) {
  const { api, i, shareUrl } = useContext(Ctx);
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);
  const ends = journeyEnds(trip.journey);

  const load = useCallback(() => {
    api
      .shares(trip.id)
      .then((r) => setShares(r.shares))
      .catch(() => setShares([]));
  }, [api, trip.id]);
  useEffect(load, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { share } = await api.createShare(trip.id, label);
      setFresh(shareUrl(share.token));
      setLabel('');
      setCopied(false);
      load();
    } catch (e) {
      setError(e instanceof JourneyApiError && e.code === 'too-many' ? 'shareTooMany' : 'shareFailed');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
    } catch {
      /* Zwischenablage gesperrt – Link steht ja im Feld */
    }
  }

  async function send() {
    if (!fresh) return;
    try {
      await navigator.share({ title: i.t('shareTitle'), text: i.t('shareText', { from: ends.from, to: ends.to }), url: fresh });
    } catch {
      /* abgebrochen */
    }
  }

  async function revoke(id: string) {
    if (!confirm(i.t('confirmDelete'))) return;
    await api.revokeShare(trip.id, id).catch(() => {});
    load();
  }

  return (
    <div class="rb-share">
      <p class="rb-share-title">{i.t('shareTitle')}</p>
      <p class="rb-muted rb-small">{i.t('shareHint')}</p>
      {fresh && (
        <div class="rb-share-new">
          <p class="rb-small">{i.t('shareNew')}</p>
          <input readOnly value={fresh} onFocus={(e) => (e.target as HTMLInputElement).select()} />
          <div class="rb-row rb-wrap">
            {'share' in navigator && (
              <button type="button" class="rb-btn rb-btn-small rb-primary" onClick={send}>
                {i.t('shareSend')}
              </button>
            )}
            <button type="button" class="rb-btn rb-btn-small" onClick={copy}>
              {copied ? i.t('shareCopied') : i.t('shareCopy')}
            </button>
          </div>
        </div>
      )}
      <div class="rb-row rb-wrap rb-share-form">
        <input value={label} maxLength={60} placeholder={i.t('shareLabel')} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <button type="button" class="rb-btn rb-btn-small" disabled={busy} onClick={create}>
          {i.t('shareCreate')}
        </button>
      </div>
      {error && <p class="rb-error rb-small">{i.t(error)}</p>}
      {shares && shares.length === 0 && !fresh && <p class="rb-muted rb-small">{i.t('shareNone')}</p>}
      {shares && shares.length > 0 && (
        <ul class="rb-share-list">
          {shares.map((s) => (
            <li key={s.id}>
              <span>{s.label || i.t('shareUnnamed', { time: `${i.day(s.createdAt)} ${i.time(s.createdAt)}` })}</span>
              <span class="rb-muted rb-small"> · {i.t('linkValidUntil', { time: `${i.day(s.expiresAt)} ${i.time(s.expiresAt)}` })}</span>
              <button type="button" class="rb-btn rb-btn-small rb-danger" onClick={() => revoke(s.id)}>
                {i.t('shareRevoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Kurzer Hinweis, warum eine Alternative mit dem Ticket nutzbar ist (oder nicht) */
function CoverageNote({ option }: { option: AlternativeOption }) {
  const i = useI();
  if (!option.covered) return <span class="rb-chip rb-chip-bad">{i.t('covNot')}</span>;
  const set = new Set(option.coverage);
  return (
    <>
      {set.has('binding-lifted') && <span class="rb-chip">{i.t('covLifted')}</span>}
      {set.has('dticket') && <span class="rb-chip">{i.t('covDTicket')}</span>}
    </>
  );
}

/** Alternativen, wenn die Reise so nicht mehr klappt (Anschluss weg, Ausfall, Zug verpasst) */
function AlternativesBox({ trip, canEdit, onChanged }: { trip: AnyTrip; canEdit: boolean; onChanged: () => void }) {
  const { api, i } = useContext(Ctx);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const a = trip.alternatives!;
  const title = i.t(a.reason === 'connection' ? 'altConnection' : a.reason === 'cancelled' ? 'altCancelled' : 'altMissedTrain', { line: a.line ?? '' });

  async function take(index: number) {
    if (!confirm(i.t('altConfirm'))) return;
    setBusy(true);
    setError(false);
    try {
      await api.chooseAlternative(trip.id, index);
      onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="rb-alts">
      <p class="rb-alts-title">{title}</p>
      <p class="rb-muted rb-small">
        {i.t('altFrom', { stop: a.origin.name, time: i.time(a.time) })}
        {a.bindingLifted && trip.ticket === 'spar' ? ` · ${i.t('altLiftedNote')}` : ''}
      </p>
      {a.options.length > 0 ? (
        <ul class="rb-results">
          {a.options.map((o, k) => (
            <ResultItem j={o.journey} option={o} busy={busy} onTake={canEdit ? () => take(k) : undefined} key={k} />
          ))}
        </ul>
      ) : (
        <p class="rb-small">{a.error ? i.t('altRetry') : i.t('altNone')}</p>
      )}
      <p class="rb-muted rb-small">{i.t('altAsOf', { time: i.time(a.computedAt) })}</p>
      {error && <p class="rb-error rb-small">{i.t('boardFailed')}</p>}
    </div>
  );
}

function urlKey(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Rundes Foto; verschwindet, wenn es nicht lädt */
function Avatar({ src, size = 40 }: { src: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) return null;
  return <img class="rb-avatar" src={src} alt="" width={size} height={size} style={{ width: `${size}px`, height: `${size}px` }} onError={() => setBroken(true)} />;
}

/** Foto hochladen/ändern/entfernen (nur wer bearbeiten darf) */
function PhotoSetting({ hasPhoto, onChanged }: { hasPhoto: boolean; onChanged: () => void }) {
  const { api, i, avatar } = useContext(Ctx);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function choose(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    setBusy(true);
    setNote('');
    try {
      await api.setAvatar(await prepareAvatar(file));
      onChanged();
    } catch {
      setNote(i.t('photoFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(i.t('confirmDelete'))) return;
    setBusy(true);
    try {
      await api.deleteAvatar();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="rb-photo rb-small">
      <div class="rb-row rb-wrap">
        {hasPhoto && avatar ? <Avatar src={avatar} size={32} /> : <span class="rb-avatar rb-avatar-empty" aria-hidden="true" />}
        <button type="button" class="rb-btn rb-btn-small" disabled={busy} onClick={() => input.current?.click()}>
          {hasPhoto ? i.t('photoChange') : i.t('photoChoose')}
        </button>
        {hasPhoto && (
          <button type="button" class="rb-btn rb-btn-small" disabled={busy} onClick={remove}>
            {i.t('photoRemove')}
          </button>
        )}
        <input ref={input} type="file" accept="image/*" hidden onChange={choose} />
      </div>
      <p class="rb-muted">{note || i.t('photoHint')}</p>
    </div>
  );
}

/** Benachrichtigungen (Web Push) für dieses Gerät ein-/ausschalten */
function PushToggle() {
  const { api, i } = useContext(Ctx);
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<'unsupported' | 'off' | 'on' | 'denied' | 'busy'>('busy');
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      const k = await api.pushKey().then((r) => r.key).catch(() => null);
      if (!alive) return;
      setKey(k);
      if (!k) return;
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setState('unsupported');
      if (Notification.permission === 'denied') return setState('denied');
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (alive) setState(sub ? 'on' : 'off');
    })().catch(() => alive && setState('unsupported'));
    return () => {
      alive = false;
    };
  }, [api]);

  if (!key) return null;

  async function enable() {
    setState('busy');
    setNote('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') return setState('denied');
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key!) }));
      await api.subscribe(sub.toJSON(), i.lang);
      setState('on');
    } catch {
      setState('off');
      setNote(i.t('pushFailed'));
    }
  }

  async function disable() {
    setState('busy');
    try {
      const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
    } finally {
      setState('off');
    }
  }

  async function test() {
    const r = await api.testPush(i.lang).catch(() => ({ sent: 0 }));
    setNote(r.sent ? i.t('pushTestSent') : i.t('pushFailed'));
  }

  return (
    <div class="rb-push rb-small">
      {state === 'on' && (
        <div class="rb-row rb-wrap">
          <span>🔔 {i.t('pushOn')}</span>
          <button type="button" class="rb-btn rb-btn-small" onClick={test}>
            {i.t('pushTest')}
          </button>
          <button type="button" class="rb-btn rb-btn-small" onClick={disable}>
            {i.t('pushDisable')}
          </button>
        </div>
      )}
      {state === 'off' && (
        <button type="button" class="rb-btn rb-btn-small" onClick={enable}>
          🔔 {i.t('pushEnable')}
        </button>
      )}
      {state === 'denied' && <span class="rb-muted">{i.t('pushDenied')}</span>}
      {state === 'unsupported' && <span class="rb-muted">{i.t('pushUnsupported')}</span>}
      {note && <span class="rb-muted"> {note}</span>}
    </div>
  );
}

/** Check-in-Nachfrage für den nächsten Zug bzw. „Zug verpasst?“ (nur wer bearbeiten darf) */
function BoardingPrompt({
  trip,
  prompt,
  onChanged,
  onReplan,
}: {
  trip: AnyTrip;
  prompt: NonNullable<ReturnType<typeof boardingState>['prompt']>;
  onChanged: () => void;
  onReplan: (from: StopHit, to: StopHit) => void;
}) {
  const { api, i } = useContext(Ctx);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const j = trip.journey;
  const l = j.legs[prompt.leg];
  const line = l.line ?? '?';
  const dep = depTime(l.from);
  const track = l.from.track ?? l.from.plannedTrack;

  async function act(action: 'checkin' | 'missed' | 'undo') {
    setBusy(true);
    setError(false);
    try {
      await api.board(trip.id, prompt.leg, action);
      onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  function replan() {
    const last = j.legs.at(-1)!;
    onReplan(
      { id: l.from.stop.id, name: l.from.stop.name, modes: [] },
      { id: last.to.stop.id, name: journeyEnds(j).to, modes: [] },
    );
  }

  let text: string;
  let buttons: JSX.Element;
  if (prompt.kind === 'checkin') {
    text = i.t('checkinQuestion', { line, time: dep ? when(i, dep) : '–', track: track ? `, ${trackText(i, l.mode, track)}` : '' });
    buttons = (
      <button type="button" class="rb-btn rb-primary" disabled={busy} onClick={() => act('checkin')}>
        {i.t('checkinBtn')}
      </button>
    );
  } else if (prompt.kind === 'missed?') {
    text = i.t('missedQuestion', { line });
    buttons = (
      <>
        <button type="button" class="rb-btn rb-primary" disabled={busy} onClick={() => act('checkin')}>
          {i.t('yesBoarded')}
        </button>
        <button type="button" class="rb-btn" disabled={busy} onClick={() => act('missed')}>
          {i.t('noMissed')}
        </button>
      </>
    );
  } else {
    text = i.t('missedText', { line });
    buttons = (
      <>
        <button type="button" class="rb-btn rb-primary" disabled={busy} onClick={replan}>
          {i.t('replan', { stop: l.from.stop.name })}
        </button>
        <button type="button" class="rb-btn rb-btn-small" disabled={busy} onClick={() => act('undo')}>
          {i.t('undo')}
        </button>
      </>
    );
  }
  return (
    <div class={`rb-prompt rb-prompt-${prompt.kind === 'checkin' ? 'checkin' : 'missed'}`}>
      <p>{text}</p>
      <div class="rb-row rb-wrap">{buttons}</div>
      {error && <p class="rb-error rb-small">{i.t('boardFailed')}</p>}
    </div>
  );
}

// ---------- Reise anlegen ----------

function StopField({ label, value, onChange }: { label: string; value: StopHit | null; onChange: (h: StopHit | null) => void }) {
  const { api, i } = useContext(Ctx);
  const [text, setText] = useState('');
  const [hits, setHits] = useState<StopHit[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api
        .stops(q)
        .then((r) => {
          if (!alive) return;
          setHits(r.hits);
          setError(Boolean(r.error));
        })
        .catch(() => alive && setError(true));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, api]);

  return (
    <div class="rb-field">
      <label>
        {label}
        <input
          type="search"
          value={value && !text ? value.name : text}
          placeholder={i.t('stopPlaceholder')}
          autocomplete="off"
          onInput={(e) => {
            setText((e.target as HTMLInputElement).value);
            if (value) onChange(null);
          }}
        />
      </label>
      {error && <p class="rb-muted rb-small">{i.t('searchFailed')}</p>}
      {!error && hits?.length === 0 && <p class="rb-muted rb-small">{i.t('noHits')}</p>}
      {hits && hits.length > 0 && (
        <ul class="rb-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(h);
                  setText('');
                  setHits(null);
                }}
              >
                <span>{h.name}</span>
                {h.place && <span class="rb-muted rb-small"> {h.place}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function localInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function duration(j: Journey) {
  const a = Date.parse(depTime(j.legs[0].from) ?? '');
  const b = Date.parse(arrTime(j.legs.at(-1)!.to) ?? '');
  const min = Math.round((b - a) / 60000);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`;
}

function ResultItem({ j, onTake, busy, option }: { j: Journey; onTake?: () => void; busy: boolean; option?: AlternativeOption }) {
  const i = useI();
  const r = rides(j);
  const cov = (l: Leg): Coverage | undefined => option?.coverage[j.legs.indexOf(l)];
  const depTr = r[0] ? (r[0].from.track ?? r[0].from.plannedTrack) : undefined;
  const lastRide = r.at(-1);
  const arrTr = lastRide ? (lastRide.to.track ?? lastRide.to.plannedTrack) : undefined;
  const first = j.legs[0];
  const last = j.legs.at(-1)!;
  const n = r.length - 1;
  return (
    <li class="rb-result">
      <div class="rb-result-times">
        <strong>
          {first.from.plannedDeparture ? i.time(first.from.plannedDeparture) : '–'} <Delay d={depDelay(first.from)} />
          {' → '}
          {last.to.plannedArrival ? i.time(last.to.plannedArrival) : '–'} <Delay d={arrDelay(last.to)} />
        </strong>
        <span class="rb-muted rb-small">
          {duration(j)} · {n === 0 ? i.t('direct') : n === 1 ? i.t('transfer1') : i.t('transfers', { n })}
        </span>
        {(depTr || arrTr) && (
          <span class="rb-muted rb-small">
            {[depTr ? i.t('depTrack', { t: trackText(i, r[0]?.mode, depTr) }) : '', arrTr ? i.t('arrTrack', { t: trackText(i, r.at(-1)?.mode, arrTr) }) : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>
      <div class="rb-result-lines">
        {r.map((l, k) => (
          <span class={cov(l) === 'not-covered' ? 'rb-uncovered' : ''} key={k}>
            <LineBadge l={l} />
          </span>
        ))}
        {r.some((l) => l.cancelled) && <span class="rb-late">{i.t('cancelled')}</span>}
        {option && <CoverageNote option={option} />}
      </div>
      {onTake && (
        <button type="button" class="rb-btn rb-btn-small rb-primary" disabled={busy} onClick={onTake}>
          {i.t('take')}
        </button>
      )}
    </li>
  );
}

function NewTrip({
  defaultDTicket,
  onDone,
  initialFrom,
  initialTo,
}: {
  defaultDTicket: boolean;
  onDone: (saved: boolean) => void;
  initialFrom?: StopHit;
  initialTo?: StopHit;
}) {
  const { api, i } = useContext(Ctx);
  const [from, setFrom] = useState<StopHit | null>(initialFrom ?? null);
  const [to, setTo] = useState<StopHit | null>(initialTo ?? null);
  const [time, setTime] = useState(localInput(new Date()));
  const [arriveBy, setArriveBy] = useState(false);
  const [ticket, setTicket] = useState<Ticket>('flex');
  const [dticket, setDticket] = useState(defaultDTicket);
  const [result, setResult] = useState<{ planId: string; journeys: Journey[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const hasD = dticket || ticket === 'dticket';

  async function search(at?: string, later = false) {
    if (!from || !to) {
      setError('pickStops');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await api.plan({ from: from.id, to: to.id, fromName: from.name, toName: to.name, time: at ?? new Date(time).toISOString(), arriveBy: arriveBy && !later, ticket, dticket: hasD }));
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  }

  async function take(index: number) {
    if (!result) return;
    setBusy(true);
    try {
      await api.createTrip({ planId: result.planId, index, ticket, dticket: hasD });
      onDone(true);
    } catch (e) {
      setError(e instanceof JourneyApiError && e.code === 'plan-expired' ? 'planExpired' : 'unavailable');
      setBusy(false);
    }
  }

  const laterFrom = () => {
    const starts = result?.journeys.map((j) => Date.parse(j.legs[0].from.plannedDeparture ?? '')).filter(Number.isFinite) ?? [];
    return starts.length ? new Date(Math.max(...starts) + 60_000).toISOString() : undefined;
  };

  return (
    <form
      class="rb-new"
      onSubmit={(e) => {
        e.preventDefault();
        search();
      }}
    >
      <h3>{i.t('newTrip')}</h3>
      <StopField label={i.t('from')} value={from} onChange={setFrom} />
      <div class="rb-row">
        <span class="rb-spacer" />
        <button
          type="button"
          class="rb-btn rb-btn-small"
          aria-label={i.t('swap')}
          title={i.t('swap')}
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
        >
          ⇅
        </button>
      </div>
      <StopField label={i.t('to')} value={to} onChange={setTo} />
      <div class="rb-row rb-wrap">
        <select value={arriveBy ? '1' : '0'} onChange={(e) => setArriveBy((e.target as HTMLSelectElement).value === '1')}>
          <option value="0">{i.t('depart')}</option>
          <option value="1">{i.t('arrive')}</option>
        </select>
        <input type="datetime-local" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} />
      </div>
      <label>
        {i.t('ticket')}
        <select value={ticket} onChange={(e) => setTicket((e.target as HTMLSelectElement).value as Ticket)}>
          {(Object.keys(TICKET_KEYS) as Ticket[]).map((k) => (
            <option value={k} key={k}>
              {i.t(TICKET_KEYS[k])}
            </option>
          ))}
        </select>
      </label>
      <label class="rb-check">
        <input type="checkbox" checked={hasD} disabled={ticket === 'dticket'} onChange={(e) => setDticket((e.target as HTMLInputElement).checked)} />
        {i.t('hasDTicket')}
      </label>
      {ticket === 'dticket' && <p class="rb-muted rb-small">{i.t('dticketOnlyHint')}</p>}
      <div class="rb-row">
        <button type="submit" class="rb-btn rb-primary" disabled={busy}>
          {busy ? i.t('searching') : i.t('search')}
        </button>
        <button type="button" class="rb-btn" onClick={() => onDone(false)}>
          {i.t('cancel')}
        </button>
      </div>
      {error && (
        <div class="rb-row rb-wrap">
          <p class="rb-error rb-small">{i.t(error)}</p>
          {error === 'unavailable' && (
            <button type="button" class="rb-btn rb-btn-small" disabled={busy} onClick={() => search()}>
              {i.t('retry')}
            </button>
          )}
        </div>
      )}
      {result && result.journeys.length === 0 && <p class="rb-muted">{i.t('noResults')}</p>}
      {result && result.journeys.length > 0 && (
        <>
          <ul class="rb-results">
            {result.journeys.map((j, k) => (
              <ResultItem j={j} key={k} busy={busy} onTake={() => take(k)} />
            ))}
          </ul>
          <button type="button" class="rb-btn rb-btn-small" disabled={busy} onClick={() => search(laterFrom(), true)}>
            {i.t('later')}
          </button>
        </>
      )}
      <Disclaimer />
    </form>
  );
}

// ---------- Empfängerseite eines Teilen-Links ----------

export interface SharedViewProps {
  /** JSON-Adresse des Links (handleSharedRequest), z. B. /r/<token>/data */
  dataUrl: string;
  /** Adresse des Fotos (handleSharedAvatar); Standard: dataUrl mit /avatar statt /data */
  avatarUrl?: string;
  lang?: Lang;
  /** Adresse der einfachen Ansicht ohne JavaScript (optional) */
  liteUrl?: string;
  refreshMs?: number;
}

const noApi = new Proxy({}, { get: () => () => Promise.reject(new Error('read-only')) }) as JourneyApi;

/** Nur ansehen: Reise mit Live-Stand, ohne Anmeldung und ohne Ticketangaben; „abgelaufen“ nach Ablauf */
export function SharedView({ dataUrl, avatarUrl, lang = 'de', liteUrl, refreshMs = 60_000 }: SharedViewProps) {
  const i = useMemo(() => i18n(lang), [lang]);
  const [data, setData] = useState<{ trip: SharedTripView; expiresAt: string; sharedBy: string | null; avatar?: string | null } | null>(null);
  const version = data?.avatar ?? null;
  const ctx = useMemo(
    () => ({ api: noApi, i, shareUrl: defaultShareUrl, avatar: version ? `${avatarUrl ?? dataUrl.replace(/\/data$/, '/avatar')}?v=${encodeURIComponent(version)}` : undefined }),
    [i, version, avatarUrl, dataUrl],
  );
  const [state, setState] = useState<'loading' | 'ok' | 'expired' | 'not-found' | 'error'>('loading');
  useTick(30_000);

  const load = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    fetch(dataUrl, { credentials: 'omit' })
      .then(async (res) => {
        if (res.status === 410) return setState('expired');
        if (res.status === 404) return setState('not-found');
        if (!res.ok) return setState((s) => (s === 'ok' ? 'ok' : 'error'));
        setData(await res.json());
        setState('ok');
      })
      .catch(() => setState((s) => (s === 'ok' ? 'ok' : 'error')));
  }, [dataUrl]);

  useEffect(() => {
    load();
    const id = setInterval(load, refreshMs);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, [load, refreshMs]);

  useDemoReload(data ? [data.trip] : undefined, load);

  useEffect(() => {
    if (data) document.title = `${journeyEnds(data.trip.journey).from} → ${journeyEnds(data.trip.journey).to}`;
  }, [data]);

  return (
    <Ctx.Provider value={ctx}>
      <div class="rb-root rb-shared">
        {state === 'loading' && <p class="rb-muted">{i.t('loading')}</p>}
        {state === 'expired' && <p class="rb-shared-msg">{i.t('sharedExpired')}</p>}
        {state === 'not-found' && <p class="rb-shared-msg">{i.t('sharedNotFound')}</p>}
        {state === 'error' && <p class="rb-shared-msg">{i.t('unavailable')}</p>}
        {state === 'ok' && data && (
          <>
            <TripCard trip={data.trip} canEdit={false} onChanged={load} onReplan={() => {}} />
            <p class="rb-muted rb-small">
              {[data.sharedBy ? i.t('sharedBy', { name: data.sharedBy }) : '', i.t('linkValidUntil', { time: `${i.day(data.expiresAt)} ${i.time(data.expiresAt)}` })]
                .filter(Boolean)
                .join(' · ')}
              {liteUrl && (
                <>
                  {' · '}
                  <a href={liteUrl}>{i.t('liteLink')}</a>
                </>
              )}
            </p>
          </>
        )}
        <div class="rb-row">
          <span class="rb-spacer" />
          <a class="rb-muted rb-small" href={TRANSITOUS_SOURCES} target="_blank" rel="noopener noreferrer">
            {i.t('sources')}
          </a>
        </div>
        <Disclaimer />
      </div>
    </Ctx.Provider>
  );
}
