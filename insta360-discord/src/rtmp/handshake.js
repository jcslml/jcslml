// Handshake RTMP del lado servidor.
//
// Hay dos variantes en circulación:
//  - simple: el servidor devuelve datos aleatorios en S1 y el eco de C1 en S2;
//  - con firma ("complex"): C1 lleva un resumen HMAC-SHA256 y el cliente espera
//    que S1 y S2 vayan firmados.
// Se detecta cuál usa el cliente y se le contesta en la misma variante, que es
// lo que hacen los servidores RTMP habituales.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HANDSHAKE_SIZE = 1536;
const DIGEST_SIZE = 32;

const CLIENT_KEY = Buffer.from('Genuine Adobe Flash Player 001', 'ascii');
const SERVER_KEY = Buffer.from('Genuine Adobe Flash Media Server 001', 'ascii');
const KEY_SUFFIX = Buffer.from(
  'f0eec24a8068bee82e00d0d1029e7e576eec5d2d29806fab93b8e636cfeb31ae',
  'hex',
);
const SERVER_KEY_FULL = Buffer.concat([SERVER_KEY, KEY_SUFFIX]);

const hmac = (key, ...parts) => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Posición del resumen dentro del bloque de 1536 bytes, según el esquema. */
function digestOffset(block, scheme) {
  const base = scheme === 0 ? 8 : 772;
  const sum = block[base] + block[base + 1] + block[base + 2] + block[base + 3];
  return (sum % 728) + base + 4;
}

function digestOf(block, offset, key) {
  return hmac(key, block.subarray(0, offset), block.subarray(offset + DIGEST_SIZE));
}

/** Devuelve el esquema y el resumen de C1 si el cliente usa handshake firmado. */
function detectClientDigest(c1) {
  for (const scheme of [1, 0]) {
    const offset = digestOffset(c1, scheme);
    const expected = digestOf(c1, offset, CLIENT_KEY);
    const actual = c1.subarray(offset, offset + DIGEST_SIZE);
    if (timingSafeEqual(expected, actual)) return { scheme, digest: Buffer.from(actual) };
  }
  return null;
}

/**
 * Construye S0+S1+S2 a partir de C1 (los 1536 bytes que siguen a C0).
 * @param {Buffer} c1
 * @returns {{ response: Buffer, signed: boolean }}
 */
export function buildServerHandshake(c1) {
  const s0 = Buffer.from([0x03]);
  const uptime = Math.floor(process.uptime() * 1000) >>> 0;
  const client = detectClientDigest(c1);

  if (!client) {
    const s1 = randomBytes(HANDSHAKE_SIZE);
    s1.writeUInt32BE(uptime, 0);
    s1.writeUInt32BE(0, 4); // versión 0 => handshake simple
    return { response: Buffer.concat([s0, s1, c1]), signed: false };
  }

  const s1 = randomBytes(HANDSHAKE_SIZE);
  s1.writeUInt32BE(uptime, 0);
  s1.set([0x0d, 0x0e, 0x0a, 0x0d], 4); // versión de servidor distinta de cero
  const offset = digestOffset(s1, client.scheme);
  digestOf(s1, offset, SERVER_KEY).copy(s1, offset);

  const s2 = randomBytes(HANDSHAKE_SIZE);
  const key = hmac(SERVER_KEY_FULL, client.digest);
  hmac(key, s2.subarray(0, HANDSHAKE_SIZE - DIGEST_SIZE)).copy(s2, HANDSHAKE_SIZE - DIGEST_SIZE);

  return { response: Buffer.concat([s0, s1, s2]), signed: true };
}
