#!/usr/bin/env node
/**
 * iOS-Startbilder (apple-touch-startup-image) erzeugen.
 * iOS zeigt ein Startbild nur, wenn es pixelgenau zur Fenstergröße passt – daher eine Datei je Gerät und Ausrichtung.
 * Android baut den Splash selbst aus dem Manifest (Icon + background_color #0f4f63), dafür ist hier nichts nötig.
 *
 * Braucht Playwright mit Chromium (nicht Teil der Abhängigkeiten); sharp (falls vorhanden) verkleinert die PNGs:
 *   npx -y playwright@1 install chromium && node scripts/render-splash.mjs
 *   (anderes Chrome: CHROME_PATH=/pfad/zu/chrome node scripts/render-splash.mjs)
 * Erzeugt: app/web/public/splash/<gerät>-<portrait|landscape>.png
 * Neues Gerät: in DEVICES ergänzen, Skript laufen lassen und die <link>-Zeilen in app/web/index.html ergänzen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* ohne sharp: unkomprimierte PNGs */
}

const dir = new URL('../app/web/public/splash/', import.meta.url).pathname;

// Geräte in CSS-Pixeln (Hochformat) + Pixeldichte
const DEVICES = [
  { name: 'iphone-402x874', w: 402, h: 874, dpr: 3 }, // iPhone 17 (auch 16 Pro / 17 Pro)
  { name: 'ipad-834x1194', w: 834, h: 1194, dpr: 2 }, // iPad Pro 11″ (M1/M2), iPad Air 11″
];

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, system-ui, sans-serif";

// Motiv aus icon.svg ohne Hintergrund: Zug, Strecke mit Halten, Ziel-Pin
const TRAIN =
  '<path d="M84 412H404" stroke="#fff" stroke-opacity=".35" stroke-width="12" stroke-linecap="round" stroke-dasharray="2 30"/>' +
  '<path d="M84 412H250" stroke="#fff" stroke-width="12" stroke-linecap="round"/><circle cx="84" cy="412" r="16" fill="#fff"/><circle cx="190" cy="412" r="16" fill="#fff"/>' +
  '<circle cx="300" cy="412" r="14" fill="none" stroke="#fff" stroke-width="8" stroke-opacity=".6"/>' +
  '<path d="M430 352c-26 0-44 19-44 42 0 31 44 66 44 66s44-35 44-66c0-23-18-42-44-42z" fill="#ffd45a"/><circle cx="430" cy="392" r="15" fill="#0f4f63"/>' +
  '<path d="M60 140H330C392 140 438 184 452 244L456 270H60Z" fill="#f6f8fb"/><path d="M60 250H456V282H60Z" fill="#d8dfec"/>' +
  '<path d="M340 156C384 160 418 192 432 232H340Z" fill="#14324a"/>' +
  '<rect x="84" y="170" width="56" height="50" rx="12" fill="#14324a"/><rect x="160" y="170" width="56" height="50" rx="12" fill="#14324a"/><rect x="236" y="170" width="56" height="50" rx="12" fill="#14324a"/>' +
  '<rect x="60" y="232" width="372" height="10" fill="#3ccf7a"/><rect x="44" y="318" width="424" height="8" rx="4" fill="#fff" opacity=".55"/>' +
  '<g fill="#1f2d3a"><rect x="92" y="280" width="92" height="20" rx="8"/><rect x="320" y="280" width="92" height="20" rx="8"/>' +
  '<circle cx="114" cy="302" r="16"/><circle cx="162" cy="302" r="16"/><circle cx="342" cy="302" r="16"/><circle cx="390" cy="302" r="16"/></g>' +
  '<g fill="#9fb3c8"><circle cx="114" cy="302" r="6"/><circle cx="162" cy="302" r="6"/><circle cx="342" cy="302" r="6"/><circle cx="390" cy="302" r="6"/></g>';

// Variante B „Markenverlauf“: Verlauf aus den Icon-Farben, Zug, Name, Beta
const BOX = [390, 440];
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}
body{background:linear-gradient(160deg,#1f8f6a 0%,#0f4f63 70%);font-family:${FONT};display:flex;align-items:center;justify-content:center;overflow:hidden}
#c{display:flex;flex-direction:column;align-items:center}
</style></head><body><div id="c">
<svg viewBox="30 120 460 360" width="330" height="258">${TRAIN}</svg>
<div style="margin-top:30px;font-size:28px;font-weight:600;color:#fff">Reisebegleitung</div>
<div style="margin-top:10px;font-size:12px;font-weight:600;letter-spacing:.6px;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.16);color:#fff">BETA</div>
</div><script>
const s = Math.min(1, innerWidth / ${BOX[0]}, (innerHeight * 0.82) / ${BOX[1]});
document.getElementById('c').style.transform = 'scale(' + s + ')';
</script></body></html>`;

mkdirSync(dir, { recursive: true });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
for (const d of DEVICES) {
  for (const o of ['portrait', 'landscape']) {
    const [w, h] = o === 'portrait' ? [d.w, d.h] : [d.h, d.w];
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: d.dpr });
    await p.setContent(html);
    await p.evaluate(() => document.fonts.ready);
    const png = await p.screenshot();
    await p.close();
    const file = `${dir}${d.name}-${o}.png`;
    if (sharp) await sharp(png).png({ palette: true, quality: 95, dither: 1, effort: 10, compressionLevel: 9 }).toFile(file);
    else writeFileSync(file, png);
    console.log(`splash/${d.name}-${o}.png  ${w * d.dpr}×${h * d.dpr}`);
  }
}
await browser.close();
