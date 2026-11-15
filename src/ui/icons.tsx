/**
 * Animierte Icons für die Reiseschritte – eigene Zeichnungen (SVG), animiert per CSS (styles.css, „rb-ico“).
 * Bewegung nur im aktuellen Schritt; bei „Bewegung reduzieren“ (prefers-reduced-motion) bleibt alles still.
 *
 * Bewusst keine Marken: kein DB-Logo, kein ICE-Schriftzug, keine ICE-typische Kopfform, kein DB-Rot.
 */
import type { Mode } from '../core/types.ts';

type Kind = 'train' | 'tram' | 'bus' | 'ship';

export function vehicleKind(m: Mode): Kind {
  if (m === 'tram') return 'tram';
  if (m === 'bus' || m === 'coach') return 'bus';
  if (m === 'ferry') return 'ship';
  return 'train';
}

/** Rad mit Speiche (dreht sich beim Fahren) */
const Wheel = ({ x, y, r }: { x: number; y: number; r: number }) => (
  <g class="rb-wheel">
    <circle cx={x} cy={y} r={r} class="rb-ico-wheel" />
    <path d={`M${x - r * 0.65} ${y}H${x + r * 0.65}M${x} ${y - r * 0.65}V${y + r * 0.65}`} class="rb-ico-spoke" />
  </g>
);

/** Fahrtwind hinter dem Fahrzeug */
const Wind = () => (
  <g class="rb-wind" aria-hidden="true">
    <path d="M1 10h6" />
    <path d="M0 15h8" />
    <path d="M2 20h5" />
  </g>
);

function Train() {
  return (
    <>
      <g class="rb-body">
        <path d="M9 7h26c6 0 10 4 12 11v3H9z" class="rb-ico-shell" />
        <path d="M37 9.5c3 .6 5.3 3 6.5 7.5H37z" class="rb-ico-glass" />
        <rect x="12" y="10" width="5" height="4.5" rx="1" class="rb-ico-glass" />
        <rect x="19.5" y="10" width="5" height="4.5" rx="1" class="rb-ico-glass" />
        <rect x="27" y="10" width="5" height="4.5" rx="1" class="rb-ico-glass" />
        <path d="M9 17.2h37" class="rb-ico-stripe" />
      </g>
      <Wheel x={14} y={23} r={2.4} />
      <Wheel x={20} y={23} r={2.4} />
      <Wheel x={33} y={23} r={2.4} />
      <Wheel x={39} y={23} r={2.4} />
      <path d="M6 26.2h42" class="rb-ico-ground" />
    </>
  );
}

function Tram() {
  return (
    <>
      <g class="rb-body">
        <path d="M21 7l4-4.5M29 7l-4-4.5M20 2.5h10" class="rb-ico-line" />
        <rect x="9" y="7" width="37" height="14" rx="3.5" class="rb-ico-shell" />
        <rect x="12" y="10" width="6" height="5" rx="1" class="rb-ico-glass" />
        <rect x="20.5" y="10" width="4" height="9" rx="1" class="rb-ico-glass" />
        <rect x="27" y="10" width="6" height="5" rx="1" class="rb-ico-glass" />
        <rect x="35.5" y="10" width="7.5" height="5" rx="1.5" class="rb-ico-glass" />
      </g>
      <Wheel x={15} y={23} r={2.2} />
      <Wheel x={20.5} y={23} r={2.2} />
      <Wheel x={34.5} y={23} r={2.2} />
      <Wheel x={40} y={23} r={2.2} />
      <path d="M6 26.2h42" class="rb-ico-ground" />
    </>
  );
}

function Bus() {
  return (
    <>
      <g class="rb-body">
        <rect x="9" y="6" width="37" height="16" rx="4" class="rb-ico-shell" />
        <rect x="12" y="9" width="6" height="5" rx="1" class="rb-ico-glass" />
        <rect x="20" y="9" width="6" height="5" rx="1" class="rb-ico-glass" />
        <rect x="28" y="9" width="6" height="5" rx="1" class="rb-ico-glass" />
        <path d="M37 9h6.5a1 1 0 0 1 1 1v6H37z" class="rb-ico-glass" />
        <path d="M9 17.5h37" class="rb-ico-stripe" />
      </g>
      <Wheel x={16} y={22.5} r={3} />
      <Wheel x={38} y={22.5} r={3} />
      <path d="M6 26.2h42" class="rb-ico-ground rb-road" />
    </>
  );
}

function Ship() {
  return (
    <>
      <g class="rb-body">
        <path d="M22 6h12v6H22z" class="rb-ico-shell" />
        <rect x="24" y="8" width="3" height="2.5" rx=".6" class="rb-ico-glass" />
        <rect x="29" y="8" width="3" height="2.5" rx=".6" class="rb-ico-glass" />
        <path d="M10 13h35l-4 8H14z" class="rb-ico-shell" />
      </g>
      <path d="M6 24c3-2 6 2 9 0s6 2 9 0 6 2 9 0 6 2 9 0 4 1.5 6 .5" class="rb-ico-line rb-waves" />
    </>
  );
}

/** Zug/Tram/Bus/Schiff; „moving“: Räder drehen, Fahrzeug wippt, Fahrtwind */
export function VehicleIcon({ mode, moving }: { mode: Mode; moving: boolean }) {
  const kind = vehicleKind(mode);
  return (
    <svg class={`rb-ico rb-ico-${kind} ${moving ? 'moving' : ''}`} viewBox="0 0 50 28" width="40" height="22" aria-hidden="true" focusable="false">
      {moving && kind !== 'ship' && <Wind />}
      {kind === 'train' ? <Train /> : kind === 'tram' ? <Tram /> : kind === 'bus' ? <Bus /> : <Ship />}
    </svg>
  );
}

export type WalkPace = 'slow' | 'normal' | 'fast';

/** Tempo nach Puffer (Umstiegszeit minus nötige Zeit): ab 10 min gemütlich, 4–10 zügig, darunter rennen */
export function walkPace(spareMin: number): WalkPace {
  return spareMin >= 10 ? 'slow' : spareMin >= 4 ? 'normal' : 'fast';
}

/** Person mit Rollkoffer; „moving“ = läuft gerade (aktueller Umstieg) */
export function WalkerIcon({ pace, moving }: { pace: WalkPace; moving: boolean }) {
  return (
    <svg class={`rb-ico rb-walker pace-${pace} ${moving ? 'moving' : ''}`} viewBox="0 0 34 30" width="30" height="26" aria-hidden="true" focusable="false">
      {moving && pace === 'fast' && (
        <g class="rb-wind" aria-hidden="true">
          <path d="M28 9h5" />
          <path d="M29 14h4" />
        </g>
      )}
      <g class="rb-person">
        <circle cx="20" cy="5" r="3" class="rb-ico-skin" />
        <path d="M20 8.5l-1 9" class="rb-ico-line rb-ico-thick" />
        <path d="M19.6 11l3.5 4" class="rb-ico-line" />
        <path d="M19.6 11l-5 3.5" class="rb-ico-line" />
        <path d="M19 17.5l-2.5 8.5" class="rb-ico-line rb-ico-thick rb-leg-a" />
        <path d="M19 17.5l2.5 8.5" class="rb-ico-line rb-ico-thick rb-leg-b" />
      </g>
      <g class="rb-case">
        <path d="M14.6 14.5L11 16.5" class="rb-ico-line" />
        <rect x="3" y="15.5" width="9" height="9.5" rx="1.6" class="rb-ico-case" />
        <path d="M5.5 18v4.5M9.5 18v4.5" class="rb-ico-caseline" />
        <circle cx="5" cy="26.5" r="1.3" class="rb-ico-wheel" />
        <circle cx="10" cy="26.5" r="1.3" class="rb-ico-wheel" />
      </g>
      <path d="M1 28.6h32" class="rb-ico-ground" />
    </svg>
  );
}

/**
 * Anschluss verpasst: freundlicher Zugkopf dreht sich auf den Kopf – Scheinwerfer werden zu Augen, die Frontscheibe zum
 * traurigen Mund, dazu eine Träne. Eigene Zeichnung (angelehnt an den bekannten Bahn-Witz, ohne Logo/Marke).
 */
export function MissedIcon({ title }: { title?: string }) {
  return (
    <svg class="rb-ico rb-gag" viewBox="0 0 64 64" width="34" height="34" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} focusable="false">
      {title && <title>{title}</title>}
      <g class="rb-gag-head">
        <rect x="10" y="6" width="44" height="52" rx="16" class="rb-gag-shell" />
        <path d="M17 20Q32 13 47 20L45 30Q32 37 19 30Z" class="rb-gag-glass" />
        <circle cx="22" cy="45" r="4.6" class="rb-gag-eye" />
        <circle cx="42" cy="45" r="4.6" class="rb-gag-eye" />
        <circle cx="22" cy="45" r="2.2" class="rb-gag-pupil" />
        <circle cx="42" cy="45" r="2.2" class="rb-gag-pupil" />
        <rect x="26" y="52" width="12" height="3" rx="1.5" class="rb-gag-bumper" />
      </g>
      <path d="M42 25q-2.6 4.2 0 6.2q2.6-2 0-6.2z" class="rb-gag-tear" />
    </svg>
  );
}
