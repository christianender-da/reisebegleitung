#!/usr/bin/env node
/**
 * App-Icons aus app/web/public/icon.svg als PNG erzeugen (iOS nimmt für den Home-Bildschirm nur PNG).
 * Braucht Playwright mit Chromium (nicht Teil der Abhängigkeiten):
 *   npx -y playwright@1 install chromium && node scripts/render-icons.mjs
 * Erzeugt: apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png (Inhalt auf 80 % = sichere Zone).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = new URL('../app/web/public/', import.meta.url).pathname;
const svg = readFileSync(dir + 'icon.svg', 'utf8');
// maskable: Hintergrund vollflächig, alles andere auf 80 % verkleinert und zentriert
const [, head, body] = svg.match(/^([\s\S]*?<rect width="512" height="512"[^>]*\/>)([\s\S]*)<\/svg>\s*$/);
const maskable = `${head}\n<g transform="translate(51.2 51.2) scale(.8)">${body}</g>\n</svg>`;

const browser = await chromium.launch();
for (const [src, file, size] of [
  [svg, 'apple-touch-icon.png', 180],
  [svg, 'icon-192.png', 192],
  [svg, 'icon-512.png', 512],
  [maskable, 'icon-maskable-512.png', 512],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: dir + file, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log(file, size);
}
await browser.close();
