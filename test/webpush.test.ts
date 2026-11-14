/**
 * Web Push: Verschlüsselung wird wie ein Browser (User Agent) mit node:crypto entschlüsselt (RFC 8291),
 * die VAPID-Signatur mit dem öffentlichen Schlüssel geprüft (RFC 8292).
 */
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { test } from 'node:test';
import { b64urlDecode, b64urlEncode, encryptPayload, parseVapidJwk, sendPush, validSubscription, vapidAuthorization, vapidPublicKey } from '../src/server/webpush.ts';

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) } },
  };
}

function decrypt(body: Uint8Array, ecdh: ReturnType<typeof createECDH>, auth: Buffer): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  assert.equal(buf.readUInt32BE(16), 4096);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const cipher = buf.subarray(21 + idlen);
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'Trennzeichen des letzten Datensatzes');
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

async function vapidJwk() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return crypto.subtle.exportKey('jwk', kp.privateKey);
}

test('Nutzlast lässt sich wie im Browser entschlüsseln', async () => {
  const { ecdh, auth, sub } = browserKeys();
  const msg = JSON.stringify({ title: 'Anschluss nicht erreichbar', body: 'ä ö ü ß – 3 Alternativen' });
  const body = await encryptPayload(new TextEncoder().encode(msg), sub);
  assert.equal(decrypt(body, ecdh, auth), msg);
});

test('VAPID: gültiges ES256-JWT, richtige Zielgruppe, öffentlicher Schlüssel passt', async () => {
  const jwk = await vapidJwk();
  const header = await vapidAuthorization('https://web.push.apple.com/QGdk/xyz', { privateJwk: jwk, subject: 'mailto:test@example.org' }, Date.UTC(2026, 10, 14));
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  const [, h, c, s, k] = m;
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(h)).toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(b64urlDecode(c)).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:test@example.org');
  assert.equal(claims.exp, Date.UTC(2026, 10, 14) / 1000 + 12 * 3600);
  assert.equal(k, vapidPublicKey(jwk));
  assert.equal(b64urlDecode(k).length, 65);
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64urlDecode(s))));
});

test('Abos: nur bekannte Push-Dienste und gültige Schlüssel', () => {
  const { sub } = browserKeys();
  assert.equal(validSubscription(sub), true);
  assert.equal(validSubscription({ ...sub, endpoint: 'https://web.push.apple.com/abc' }), true);
  assert.equal(validSubscription({ ...sub, endpoint: 'https://evil.example.org/push' }), false);
  assert.equal(validSubscription({ ...sub, endpoint: 'http://fcm.googleapis.com/x' }), false);
  assert.equal(validSubscription({ ...sub, keys: { p256dh: 'abc', auth: sub.keys.auth } }), false);
  assert.equal(parseVapidJwk('{"kty":"EC"}'), null);
  assert.equal(parseVapidJwk('kein json'), null);
});

test('Senden: Header, „gone“ bei 410', async () => {
  const { ecdh, auth, sub } = browserKeys();
  const jwk = await vapidJwk();
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  assert.equal(await sendPush(sub, { title: 'x' }, { privateJwk: jwk, subject: 'mailto:a@b.de' }, { fetch: fake, topic: 'trip-abc.def' }), 'ok');
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(h.Topic, 'trip-abcdef');
  assert.equal(decrypt(seen!.init.body as Uint8Array, ecdh, auth), '{"title":"x"}');
  const gone = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
  assert.equal(await sendPush(sub, {}, { privateJwk: jwk, subject: 'mailto:a@b.de' }, { fetch: gone }), 'gone');
});
