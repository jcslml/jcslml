// Servidor web: visor, panel de administración, Actividad de Discord y los
// puntos de acceso a la señal (FLV de baja latencia, HLS, miniatura, estado).

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createLimiter, safeEqual, signToken, verifyToken } from './auth.js';
import { ConfigError } from './config.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const ADMIN_COOKIE = 'puente_admin';
const ADMIN_TTL = 7 * 24 * 3600;
const VIEW_TTL = 12 * 3600;
const MAX_CLIENT_BACKLOG = 12 * 1024 * 1024;
const MAX_BODY = 64 * 1024;

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function resolveVendor() {
  const files = { 'discord-sdk.js': path.join(PUBLIC_DIR, 'vendor', 'discord-sdk.js') };
  try {
    files['mpegts.js'] = require.resolve('mpegts.js');
  } catch {
    // dependencia no instalada: el visor usará solo HLS
  }
  try {
    files['hls.js'] = require.resolve('hls.js/dist/hls.light.min.js');
  } catch {
    // sin hls.js solo habrá HLS en navegadores que lo traen de serie
  }
  return files;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Se esperaba JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Petición demasiado grande.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('no es un objeto');
    return data;
  } catch {
    throw new HttpError(400, 'JSON no válido.');
  }
}

export class HttpServer {
  /**
   * @param {object} deps
   * @param {import('./config.js').Config} deps.config
   * @param {import('./hub.js').StreamHub} deps.hub
   * @param {import('./live.js').LiveTracker} deps.tracker
   * @param {import('./pipeline.js').MediaPipeline} deps.pipeline
   * @param {import('./discord/announcer.js').Announcer} deps.announcer
   * @param {import('./discord/oauth.js').DiscordOAuth} deps.oauth
   * @param {{ path: string, version: string } | null} deps.ffmpeg
   * @param {(level: string, message: string) => void} deps.log
   * @param {string} deps.version
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.vendor = resolveVendor();
    this.flvViewers = new Set();
    this.hlsViewers = new Map();
    this.loginLimiter = createLimiter({ windowMs: 10 * 60_000, max: 8 });
    this.activityLimiter = createLimiter({ windowMs: 60_000, max: 30 });

    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => this._fail(res, err));
    });
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4096 });
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.get('httpPort'), this.config.get('bindHost'), () => {
        this.server.off('error', reject);
        resolve(this.server.address().port);
      });
    });
  }

  async close() {
    this.loginLimiter.stop();
    this.activityLimiter.stop();
    for (const client of this.wss.clients) client.terminate();
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ------------------------------------------------------------ utilidades

  _fail(res, err) {
    const status = err instanceof HttpError ? err.status : err instanceof ConfigError ? 400 : 500;
    if (status === 500) this.log('error', `Error interno: ${err.stack ?? err.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const message = status === 500 ? 'Error interno del servidor.' : err.message;
    this._json(res, status, { error: message, ...(err.extra ?? {}) });
  }

  _headers(extra = {}) {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    };
  }

  _json(res, status, data, extra = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, this._headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...extra,
    }));
    res.end(body);
  }

  _text(res, status, text) {
    res.writeHead(status, this._headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(text);
  }

  async _page(res, name, { status = 200, embeddable = false } = {}) {
    const html = await fsp.readFile(path.join(PUBLIC_DIR, name));
    const headers = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' };
    // La página de la Actividad se carga dentro de Discord, que aplica su propia
    // política de contenido; las demás no deben poder incrustarse en otra web.
    if (!embeddable) headers['Content-Security-Policy'] = PAGE_CSP;
    res.writeHead(status, this._headers(headers));
    res.end(html);
  }

  async _static(req, res, file, cacheControl) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new HttpError(404, 'No encontrado.');
    }
    if (!stat.isFile()) throw new HttpError(404, 'No encontrado.');
    const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    const headers = this._headers({
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
    });
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  _ip(req) {
    if (this.config.get('trustProxy')) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? '';
  }

  _isHttps(req) {
    if (this.config.get('publicUrl').startsWith('https://')) return true;
    return this.config.get('trustProxy') && req.headers['x-forwarded-proto'] === 'https';
  }

  /** Dirección base con la que se llega a este servidor (para mostrar enlaces). */
  _baseUrl(req) {
    const configured = this.config.get('publicUrl');
    if (configured) return configured;
    const host = /^[\w.:[\]-]+$/.test(req.headers.host ?? '') ? req.headers.host : `localhost:${this.config.get('httpPort')}`;
    return `${this._isHttps(req) ? 'https' : 'http'}://${host}`;
  }

  _rtmpBase(req) {
    const configured = this.config.get('rtmpPublicUrl');
    if (configured) return configured;
    const hostname = new URL(this._baseUrl(req)).hostname;
    const port = this.config.get('rtmpPort');
    return `rtmp://${hostname}${port === 1935 ? '' : `:${port}`}`;
  }

  /** Enlaces públicos que no dependen de la petición (para los avisos de Discord). */
  publicLinks() {
    const base = this.config.get('publicUrl');
    return {
      viewerUrl: base ? `${base}/v/${this.config.get('viewToken')}` : null,
      activityEnabled: this.config.activityEnabled,
    };
  }

  _mediaAccess(token) {
    if (safeEqual(token, this.config.get('viewToken'))) return { kind: 'enlace' };
    const payload = verifyToken(this.config.get('sessionSecret'), token, 'view');
    return payload ? { kind: 'discord', uid: payload.uid } : null;
  }

  _passwordMark() {
    return crypto.createHash('sha256').update(this.config.get('adminPassword')).digest('hex').slice(0, 16);
  }

  _isAdmin(req) {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const payload = verifyToken(this.config.get('sessionSecret'), token, 'admin');
    return Boolean(payload && payload.p === this._passwordMark());
  }

  _requireAdmin(req) {
    if (!this._isAdmin(req)) throw new HttpError(401, 'Sesión no iniciada.');
  }

  viewerCount() {
    const now = Date.now();
    for (const [key, seen] of this.hlsViewers) if (now - seen > 15_000) this.hlsViewers.delete(key);
    return { lowLatency: this.flvViewers.size, hls: this.hlsViewers.size };
  }

  // -------------------------------------------------------------- rutas

  async _handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = url.pathname;
    // El proxy de Discord quita este prefijo; se tolera por si llega tal cual.
    if (pathname.startsWith('/.proxy/')) pathname = pathname.slice('/.proxy'.length);
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (pathname === '/healthz') return this._text(res, 200, 'ok');

    if (pathname === '/' && isRead) {
      if (url.searchParams.has('frame_id')) return this._page(res, 'activity.html', { embeddable: true });
      return this._page(res, 'landing.html');
    }

    let match;
    if ((match = /^\/assets\/([\w.-]+)$/.exec(pathname)) && isRead) {
      return this._static(req, res, path.join(PUBLIC_DIR, 'assets', match[1]), 'no-cache');
    }
    if ((match = /^\/vendor\/([\w.-]+)$/.exec(pathname)) && isRead) {
      const file = this.vendor[match[1]];
      if (!file) throw new HttpError(404, 'No encontrado.');
      return this._static(req, res, file, 'public, max-age=86400');
    }

    if ((match = /^\/v\/([\w.-]+)$/.exec(pathname)) && isRead) {
      if (!safeEqual(match[1], this.config.get('viewToken'))) return this._page(res, 'landing.html', { status: 404 });
      return this._page(res, 'viewer.html');
    }

    if ((match = /^\/m\/([\w.-]+)\/(.+)$/.exec(pathname))) {
      if (!this._mediaAccess(match[1])) throw new HttpError(403, 'Enlace no válido o caducado.');
      if (!isRead) throw new HttpError(405, 'Método no permitido.');
      return this._media(req, res, match[2]);
    }

    if (pathname === '/admin' && isRead) return this._page(res, 'admin.html');
    if (pathname.startsWith('/api/admin/')) return this._adminApi(req, res, pathname.slice('/api/admin/'.length), method);
    if (pathname.startsWith('/api/activity/')) return this._activityApi(req, res, pathname.slice('/api/activity/'.length), method);

    throw new HttpError(404, 'No encontrado.');
  }

  statusPayload() {
    const info = this.hub.info();
    const session = this.tracker.state === 'offline' ? null : this.tracker.session;
    return {
      state: this.tracker.state,
      live: info.live,
      generation: info.generation,
      startedAt: session?.startedAt ?? null,
      title: this.config.get('title'),
      hasAudio: info.hasAudio,
      hasVideo: info.hasVideo,
      width: info.width,
      height: info.height,
      hls: this.pipeline.hasPlaylist(),
      now: Date.now(),
    };
  }

  async _media(req, res, rest) {
    if (rest === 'status') return this._json(res, 200, this.statusPayload());

    if (rest === 'live.flv') {
      if (req.method !== 'GET') throw new HttpError(405, 'Método no permitido.');
      if (!this.hub.live) throw new HttpError(404, 'No hay directo en este momento.');
      res.writeHead(200, this._headers({
        'Content-Type': 'video/x-flv',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      }));
      const viewer = {};
      const unsubscribe = this.hub.subscribe({
        write: (chunk) => {
          res.write(chunk);
          if (res.writableLength > MAX_CLIENT_BACKLOG) res.destroy();
        },
        close: () => res.end(),
      });
      if (!unsubscribe) {
        res.end();
        return undefined;
      }
      this.flvViewers.add(viewer);
      res.on('close', () => {
        unsubscribe();
        this.flvViewers.delete(viewer);
      });
      return undefined;
    }

    if (rest === 'snapshot.jpg') {
      const image = await this.pipeline.snapshot();
      if (!image) throw new HttpError(404, 'Sin miniatura disponible.');
      res.writeHead(200, this._headers({
        'Content-Type': 'image/jpeg',
        'Content-Length': image.length,
        'Cache-Control': 'no-store',
      }));
      res.end(image);
      return undefined;
    }

    const hls = /^hls\/([\w.-]+)$/.exec(rest);
    if (hls) {
      const file = this.pipeline.hlsFile(hls[1]);
      if (!file) throw new HttpError(404, 'No encontrado.');
      if (file.endsWith('.m3u8')) {
        let playlist;
        try {
          playlist = await fsp.readFile(file);
        } catch {
          throw new HttpError(404, 'El directo aún no está disponible en modo compatible.');
        }
        this.hlsViewers.set(`${this._ip(req)}|${req.headers['user-agent'] ?? ''}`, Date.now());
        res.writeHead(200, this._headers({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': playlist.length,
          'Cache-Control': 'no-store',
        }));
        res.end(playlist);
        return undefined;
      }
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        throw new HttpError(404, 'Segmento no disponible.');
      }
      res.writeHead(200, this._headers({
        'Content-Type': 'video/mp2t',
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=60',
      }));
      if (req.method === 'HEAD') {
        res.end();
        return undefined;
      }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return undefined;
    }

    throw new HttpError(404, 'No encontrado.');
  }

  _upgrade(req, socket, head) {
    const reject = (line) => {
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return reject('400 Bad Request');
    }
    if (pathname.startsWith('/.proxy/')) pathname = pathname.slice('/.proxy'.length);
    const match = /^\/m\/([\w.-]+)\/live\.flv$/.exec(pathname);
    if (!match) return reject('404 Not Found');
    if (!this._mediaAccess(match[1])) return reject('403 Forbidden');
    if (!this.hub.live) return reject('404 Not Found');

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const viewer = {};
      const unsubscribe = this.hub.subscribe({
        write: (chunk) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(chunk, { binary: true });
          if (ws.bufferedAmount > MAX_CLIENT_BACKLOG) ws.terminate();
        },
        close: () => ws.close(1000, 'fin del directo'),
      });
      if (!unsubscribe) {
        ws.close(1013, 'sin directo');
        return;
      }
      this.flvViewers.add(viewer);
      ws.on('error', () => {});
      ws.on('close', () => {
        unsubscribe();
        this.flvViewers.delete(viewer);
      });
    });
    return undefined;
  }

  // ----------------------------------------------------------- API del panel

  adminState(req) {
    const config = this.config;
    const base = this._baseUrl(req);
    const rtmpBase = this._rtmpBase(req);
    const publicUrl = config.get('publicUrl');
    const warnings = [];
    if (!this.ffmpeg) {
      warnings.push('No se ha encontrado ffmpeg: no habrá miniaturas en Discord ni modo compatible (HLS). El directo de baja latencia sí funciona.');
    }
    if (!publicUrl) {
      warnings.push('Falta la dirección pública: sin ella los avisos de Discord no pueden incluir el enlace para ver el directo.');
    }
    if (config.activityEnabled && !publicUrl.startsWith('https://')) {
      warnings.push('La Actividad de Discord solo funciona si la dirección pública usa HTTPS.');
    }
    const hasId = Boolean(config.get('discordClientId'));
    const hasSecret = Boolean(config.get('discordClientSecret'));
    const hasGuild = config.guildIds.length > 0;
    if ((hasId || hasSecret || hasGuild) && !config.activityEnabled) {
      const missing = [!hasId && 'el ID de aplicación', !hasSecret && 'el secreto de cliente', !hasGuild && 'el ID del servidor'].filter(Boolean);
      warnings.push(`La Actividad de Discord está a medio configurar: falta ${missing.join(' y ')}.`);
    }

    return {
      version: this.version,
      stream: {
        ...this.hub.info(),
        state: this.tracker.state,
        sessionStartedAt: this.tracker.state === 'offline' ? null : this.tracker.session?.startedAt ?? null,
        viewers: this.viewerCount(),
      },
      urls: {
        base,
        rtmpServer: `${rtmpBase}/live`,
        streamKey: config.get('streamKey'),
        rtmp: `${rtmpBase}/live/${config.get('streamKey')}`,
        viewer: `${base}/v/${config.get('viewToken')}`,
        viewToken: config.get('viewToken'),
        activityHost: publicUrl ? new URL(publicUrl).host + new URL(publicUrl).pathname.replace(/\/$/, '') : '',
      },
      config: {
        publicUrl,
        rtmpPublicUrl: config.get('rtmpPublicUrl'),
        title: config.get('title'),
        graceSeconds: config.get('graceSeconds'),
        webhookUrl: config.get('webhookUrl'),
        mention: config.get('mention'),
        updateSeconds: config.get('updateSeconds'),
        keepLastImage: config.get('keepLastImage'),
        discordClientId: config.get('discordClientId'),
        discordClientSecretSet: hasSecret,
        discordGuildIds: config.get('discordGuildIds'),
        httpPort: config.get('httpPort'),
        rtmpPort: config.get('rtmpPort'),
      },
      locked: [...config.locked],
      ffmpeg: this.ffmpeg
        ? { available: true, version: this.ffmpeg.version, lastError: this.pipeline.lastError }
        : { available: false },
      discord: {
        webhookConfigured: Boolean(config.get('webhookUrl')),
        activityEnabled: config.activityEnabled,
        lastOkAt: this.announcer.lastOkAt,
        lastError: this.announcer.lastError,
      },
      lastRejected: this.lastRejected ?? null,
      warnings,
    };
  }

  async _adminApi(req, res, route, method) {
    if (route === 'login' && method === 'POST') {
      const ip = this._ip(req);
      if (!this.loginLimiter.hit(ip)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
      const body = await readJson(req);
      if (typeof body.password !== 'string' || !safeEqual(body.password, this.config.get('adminPassword'))) {
        throw new HttpError(401, 'Contraseña incorrecta.');
      }
      this.loginLimiter.clear(ip);
      const token = signToken(this.config.get('sessionSecret'), { t: 'admin', p: this._passwordMark() }, ADMIN_TTL);
      const cookie = `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_TTL}${this._isHttps(req) ? '; Secure' : ''}`;
      return this._json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }
    if (route === 'logout' && method === 'POST') {
      return this._json(res, 200, { ok: true }, {
        'Set-Cookie': `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }

    this._requireAdmin(req);

    if (route === 'state' && method === 'GET') return this._json(res, 200, this.adminState(req));

    if (route === 'config' && method === 'POST') {
      const body = await readJson(req);
      const changed = this.config.update(body);
      if (changed.length) this.log('info', `Configuración actualizada desde el panel: ${changed.join(', ')}.`);
      return this._json(res, 200, this.adminState(req));
    }

    if (route === 'rotate' && method === 'POST') {
      const body = await readJson(req);
      this.config.rotate(body.key);
      if (body.key === 'streamKey') this.hub.publisher?.close('clave de emisión regenerada');
      this.log('info', `Se ha regenerado ${body.key === 'streamKey' ? 'la clave de emisión' : 'el enlace del visor'}.`);
      return this._json(res, 200, this.adminState(req));
    }

    if (route === 'webhook-test' && method === 'POST') {
      await readJson(req);
      try {
        await this.announcer.sendTest();
      } catch (err) {
        throw new HttpError(502, `No se pudo enviar: ${err.message}`);
      }
      return this._json(res, 200, { ok: true });
    }

    if (route === 'kick' && method === 'POST') {
      await readJson(req);
      this.hub.publisher?.close('desconectado desde el panel');
      return this._json(res, 200, this.adminState(req));
    }

    throw new HttpError(404, 'No encontrado.');
  }

  // ------------------------------------------------- API de la Actividad

  async _activityApi(req, res, route, method) {
    const config = this.config;
    if (route === 'config' && method === 'GET') {
      return this._json(res, 200, {
        enabled: config.activityEnabled,
        clientId: config.activityEnabled ? config.get('discordClientId') : null,
        title: config.get('title'),
      });
    }

    if (route === 'session' && method === 'POST') {
      if (!config.activityEnabled) throw new HttpError(404, 'La Actividad no está configurada en este servidor.');
      if (!this.activityLimiter.hit(this._ip(req))) throw new HttpError(429, 'Demasiadas peticiones. Espera un momento.');
      const body = await readJson(req);
      if (typeof body.code !== 'string' || !body.code || body.code.length > 512) {
        throw new HttpError(400, 'Falta el código de autorización.');
      }
      const hint = typeof body.guildId === 'string' && /^\d{15,22}$/.test(body.guildId) ? body.guildId : null;

      let user;
      let member = false;
      try {
        const accessToken = await this.oauth.exchangeCode({
          clientId: config.get('discordClientId'),
          clientSecret: config.get('discordClientSecret'),
          code: body.code,
        });
        user = await this.oauth.getUser(accessToken);
        const allowed = config.guildIds;
        const order = hint && allowed.includes(hint) ? [hint, ...allowed.filter((id) => id !== hint)] : allowed;
        for (const guildId of order) {
          if (await this.oauth.isGuildMember(accessToken, guildId)) {
            member = true;
            break;
          }
        }
      } catch (err) {
        this.log('warn', `Actividad: fallo al validar con Discord (${err.message}).`);
        throw new HttpError(502, 'No se pudo validar tu cuenta con Discord. Revisa el ID y el secreto de la aplicación en el panel.');
      }
      if (!member) {
        throw new HttpError(403, 'Tu cuenta no pertenece a un servidor de Discord autorizado para ver este directo.', {
          reason: 'guild',
          guildId: hint,
        });
      }
      const token = signToken(config.get('sessionSecret'), { t: 'view', uid: user.id }, VIEW_TTL);
      return this._json(res, 200, { token, expiresIn: VIEW_TTL, user: { name: user.name } });
    }

    throw new HttpError(404, 'No encontrado.');
  }
}
