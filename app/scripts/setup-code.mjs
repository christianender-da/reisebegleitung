#!/usr/bin/env node
/**
 * Einmaligen Einrichtungscode für den ersten Passkey erzeugen (30 min gültig, nur einmal verwendbar).
 * In D1 landet nur der SHA-256; der Code erscheint nur hier im Terminal.
 *
 *   npm run app:setup-code             → Datenbank bei Cloudflare
 *   npm run app:setup-code -- --local  → lokale Datenbank (wrangler dev)
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const local = process.argv.includes('--local');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const raw = [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('');
const code = raw.match(/.{4}/g).join('-');
const hash = createHash('sha256').update(raw).digest('base64url');
const expires = new Date(Date.now() + 30 * 60_000).toISOString();

const sql =
  `INSERT INTO meta (key, value) VALUES ('setup_code_hash', '${hash}') ON CONFLICT(key) DO UPDATE SET value = excluded.value; ` +
  `INSERT INTO meta (key, value) VALUES ('setup_code_expires', '${expires}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'reisebegleitung', local ? '--local' : '--remote', '--config', 'app/wrangler.jsonc', '--command', sql], {
  stdio: ['ignore', 'ignore', 'inherit'],
});

console.log(`\nEinrichtungscode (gültig bis ${new Date(expires).toLocaleTimeString('de-DE')}): ${code}\n`);
