#!/usr/bin/env node
/**
 * VAPID-Schlüssel für Web Push erzeugen (P-256). Ausgabe: privater Schlüssel als JWK (JSON, eine Zeile).
 * Als Secret hinterlegen, z. B.:
 *   npm run vapid-keys | npx wrangler secret put VAPID_PRIVATE_JWK --config app/wrangler.jsonc
 * Den öffentlichen Schlüssel leitet der Server daraus ab. Neuer Schlüssel = alle Geräte müssen Benachrichtigungen neu aktivieren.
 */
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }));
if (process.stdout.isTTY) process.stdout.write('\n');
