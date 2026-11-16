// Utilidades de las pruebas: arrancar el puente en puertos libres, simular la
// cámara con ffmpeg y simular Discord con un servidor local.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { findFfmpeg } from '../src/ffmpeg.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, timeoutMs = 10_000, label = 'condición') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Tiempo agotado esperando: ${label}`);
    await sleep(100);
  }
}

export async function startApp(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puente-test-'));
  const logs = [];
  const app = await createApp({
    dataDir,
    log: (level, message) => logs.push(`${level}: ${message}`),
    env: { HTTP_PORT: '0', RTMP_PORT: '0', BIND_HOST: '127.0.0.1', GRACE_SECONDS: '1', PATH: process.env.PATH, ...env },
  });
  await app.start();
  return {
    app,
    logs,
    base: `http://127.0.0.1:${app.ports.http}`,
    rtmpUrl: (key = app.config.get('streamKey')) => `rtmp://127.0.0.1:${app.ports.rtmp}/live/${key}`,
    async stop() {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Emite una señal de prueba H.264 + AAC durante `seconds` segundos. */
export async function publish(url, seconds, { audio = true } = {}) {
  const ffmpeg = await findFfmpeg(process.env.FFMPEG_PATH);
  const args = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'];
  if (audio) args.push('-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '30', '-b:v', '800k');
  if (audio) args.push('-c:a', 'aac', '-b:a', '96k');
  args.push('-f', 'flv', url);
  const child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
  return { child, done };
}

/** Discord simulado: webhooks y OAuth2. Guarda todas las peticiones recibidas. */
export async function startFakeDiscord({ memberOf = [] } = {}) {
  const requests = [];
  let nextId = 1000;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
    const type = req.headers['content-type'] ?? '';
    if (type.startsWith('application/json')) entry.json = JSON.parse(body.toString() || '{}');
    if (type.startsWith('multipart/form-data')) {
      const text = body.toString('latin1');
      const match = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
      entry.json = match ? JSON.parse(Buffer.from(match[1], 'latin1').toString('utf8')) : null;
      entry.hasFile = /name="files\[0\]"; filename="directo\.jpg"/.test(text) && text.includes('\xff\xd8\xff');
    }
    if (type.startsWith('application/x-www-form-urlencoded')) entry.form = Object.fromEntries(new URLSearchParams(body.toString()));
    requests.push(entry);
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith('/api/webhooks/')) return json(200, { id: String(nextId++) });
    if (url.pathname === '/api/v10/oauth2/token') {
      if (entry.form.code === 'codigo-malo') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: `token-${entry.form.code}` });
    }
    if (url.pathname === '/api/v10/users/@me') return json(200, { id: '4242', username: 'ana', global_name: 'Ana' });
    const member = /^\/api\/v10\/users\/@me\/guilds\/(\d+)\/member$/.exec(url.pathname);
    if (member) return memberOf.includes(member[1]) ? json(200, { roles: [] }) : json(404, { message: 'Unknown Guild' });
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    webhookUrl: `${origin}/api/webhooks/123456789012345678/token-secreto`,
    apiBase: `${origin}/api/v10`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
