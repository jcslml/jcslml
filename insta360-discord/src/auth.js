// Comparaciones en tiempo constante, tokens firmados (HMAC) y limitador de intentos.

import crypto from 'node:crypto';

/** Compara dos cadenas sin filtrar por tiempo cuántos caracteres coinciden. */
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const encode = (data) => Buffer.from(data).toString('base64url');

function mac(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Crea un token firmado con caducidad. Solo usa caracteres válidos en una ruta URL.
 * @param {string} secret
 * @param {object} payload
 * @param {number} ttlSeconds
 */
export function signToken(secret, payload, ttlSeconds) {
  const body = encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${mac(secret, body)}`;
}

/** Devuelve el contenido del token si la firma es válida y no ha caducado; si no, null. */
export function verifyToken(secret, token, type) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(secret, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    if (type && payload.t !== type) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Limitador sencillo por clave (p. ej. IP): `max` intentos por ventana. */
export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref?.();
  return {
    /** Registra un intento; devuelve false si se ha superado el límite. */
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= max;
    },
    clear(key) {
      hits.delete(key);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
