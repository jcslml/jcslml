// De extremo a extremo: cámara simulada (ffmpeg por RTMP) → puente → visores y
// Discord simulado. Comprueba la señal servida, los accesos y los avisos.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { publish, sleep, startApp, startFakeDiscord, waitFor } from './helpers.js';

const run = promisify(execFile);
const GUILD = '111111111111111111';
let discord;
let ctx;
let token;

const getJson = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
};
const post = (url, body, headers = {}) => getJson(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

before(async () => {
  discord = await startFakeDiscord({ memberOf: [GUILD] });
  process.env.DISCORD_WEBHOOK_TEST_ORIGIN = discord.origin;
  ctx = await startApp({
    DISCORD_WEBHOOK_URL: discord.webhookUrl,
    DISCORD_UPDATE_SECONDS: '15',
    DISCORD_API_BASE: discord.apiBase,
    DISCORD_CLIENT_ID: '222222222222222222',
    DISCORD_CLIENT_SECRET: 'secreto',
    DISCORD_GUILD_IDS: GUILD,
    PUBLIC_URL: 'https://directo.ejemplo.com',
    STREAM_TITLE: 'Prueba',
  });
  token = ctx.app.config.get('viewToken');
});

after(async () => {
  await ctx?.stop();
  await discord?.stop();
});

test('sin señal: estado, accesos y panel protegido', async () => {
  const status = await getJson(`${ctx.base}/m/${token}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.data.state, 'offline');
  assert.equal((await getJson(`${ctx.base}/m/token-falso/status`)).status, 403);
  assert.equal((await fetch(`${ctx.base}/m/${token}/live.flv`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/v/token-falso`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/v/${token}`)).status, 200);
  assert.equal((await getJson(`${ctx.base}/api/admin/state`)).status, 401);
  assert.equal((await post(`${ctx.base}/api/admin/login`, { password: 'mala' })).status, 401);

  const login = await post(`${ctx.base}/api/admin/login`, { password: ctx.app.config.get('adminPassword') });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const state = await getJson(`${ctx.base}/api/admin/state`, { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(state.data.urls.viewer, `https://directo.ejemplo.com/v/${token}`);
  assert.ok(state.data.locked.includes('webhookUrl'));
  const bad = await post(`${ctx.base}/api/admin/config`, { mention: 'no vale' }, { cookie });
  assert.equal(bad.status, 400);
});

test('una clave de emisión incorrecta se rechaza', async () => {
  const { done } = await publish(ctx.rtmpUrl('clave-equivocada'), 2);
  const { code } = await done;
  assert.notEqual(code, 0);
  assert.equal(ctx.app.hub.live, false);
  assert.ok(ctx.app.http.lastRejected);
});

test('directo completo: señal, HLS, miniatura y avisos de Discord', async () => {
  const { done } = await publish(ctx.rtmpUrl(), 9);
  await waitFor(() => ctx.app.hub.live, 8000, 'directo en marcha');
  const status = (await getJson(`${ctx.base}/m/${token}/status`)).data;
  assert.equal(status.state, 'live');
  assert.equal(status.width, 640);
  assert.equal(status.hasAudio, true);

  // Baja latencia por WebSocket: debe llegar un FLV válido con vídeo y audio.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puente-flv-'));
  const flvFile = path.join(tmp, 'ws.flv');
  const out = fs.createWriteStream(flvFile);
  const ws = new WebSocket(`${ctx.base.replace('http', 'ws')}/m/${token}/live.flv`);
  ws.on('message', (data) => out.write(data));
  await assert.rejects(new Promise((resolve, reject) => {
    const bad = new WebSocket(`${ctx.base.replace('http', 'ws')}/m/falso/live.flv`);
    bad.on('open', resolve);
    bad.on('error', reject);
  }));

  // Lo mismo por HTTP, y a través del prefijo que añade el proxy de Discord.
  const controller = new AbortController();
  const httpFlv = await fetch(`${ctx.base}/.proxy/m/${token}/live.flv`, { signal: controller.signal });
  assert.equal(httpFlv.status, 200);
  const first = (await httpFlv.body.getReader().read()).value;
  assert.equal(Buffer.from(first.subarray(0, 3)).toString(), 'FLV');
  controller.abort();

  await waitFor(() => ctx.app.pipeline.hasPlaylist(), 8000, 'lista HLS');
  const playlist = await (await fetch(`${ctx.base}/m/${token}/hls/index.m3u8`)).text();
  assert.match(playlist, /#EXTM3U/);
  const segment = playlist.split('\n').find((line) => line.endsWith('.ts'));
  const seg = await fetch(`${ctx.base}/m/${token}/hls/${segment}`);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get('content-type'), 'video/mp2t');
  assert.equal((await fetch(`${ctx.base}/m/${token}/hls/..%2f..%2fconfig.json`)).status, 404);

  const snapshot = await waitFor(async () => {
    const res = await fetch(`${ctx.base}/m/${token}/snapshot.jpg`);
    return res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null;
  }, 8000, 'miniatura');
  assert.deepEqual([...snapshot.subarray(0, 3)], [0xff, 0xd8, 0xff]);

  // Aviso de inicio con imagen y enlace al visor.
  const hooks = () => discord.requests.filter((r) => r.path.startsWith('/api/webhooks/'));
  await waitFor(() => hooks().length >= 1, 10_000, 'aviso de inicio');
  const start = hooks()[0];
  assert.equal(start.method, 'POST');
  assert.equal(start.query.wait, 'true');
  assert.equal(start.hasFile, true);
  assert.match(start.json.content, /Prueba.*en directo/);
  assert.equal(start.json.embeds[0].url, `https://directo.ejemplo.com/v/${token}`);
  assert.equal(start.json.embeds[0].image.url, 'attachment://directo.jpg');
  assert.deepEqual(start.json.allowed_mentions, { parse: [] });

  const { code, stderr } = await done;
  assert.equal(code, 0, stderr);
  await waitFor(() => ctx.app.tracker.state === 'offline', 6000, 'fin del directo');
  ws.close();
  await new Promise((resolve) => out.end(resolve));

  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', flvFile]).catch(() => null);
  if (probe) assert.deepEqual(probe.stdout.trim().split('\n').sort(), ['aac', 'h264']);
  else assert.equal(fs.readFileSync(flvFile).subarray(0, 3).toString(), 'FLV');
  assert.ok(fs.statSync(flvFile).size > 100_000);

  // Aviso de cierre: edita el mismo mensaje y quita la imagen.
  await waitFor(() => hooks().some((r) => r.method === 'PATCH'), 8000, 'aviso de cierre');
  const end = hooks().filter((r) => r.method === 'PATCH').pop();
  assert.match(end.path, /\/messages\/1000$/);
  assert.match(end.json.embeds[0].title, /finalizado/);
  assert.match(end.json.embeds[0].description, /Duró \d+ s/);
  assert.deepEqual(end.json.attachments, []);
  assert.equal((await getJson(`${ctx.base}/m/${token}/status`)).data.state, 'offline');
});

test('Actividad: solo entra quien pertenece al servidor autorizado', async () => {
  const config = await getJson(`${ctx.base}/api/activity/config`);
  assert.deepEqual(config.data, { enabled: true, clientId: '222222222222222222', title: 'Prueba' });

  const ok = await post(`${ctx.base}/.proxy/api/activity/session`, { code: 'codigo-bueno', guildId: GUILD });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.name, 'Ana');
  const exchange = discord.requests.find((r) => r.path === '/api/v10/oauth2/token');
  assert.deepEqual(exchange.form, {
    client_id: '222222222222222222', client_secret: 'secreto', grant_type: 'authorization_code', code: 'codigo-bueno',
  });
  assert.equal((await getJson(`${ctx.base}/m/${ok.data.token}/status`)).status, 200);
  assert.equal((await getJson(`${ctx.base}/m/${ok.data.token}x/status`)).status, 403);

  assert.equal((await post(`${ctx.base}/api/activity/session`, { code: 'codigo-malo' })).status, 502);

  ctx.app.config.values.discordGuildIds = '333333333333333333';
  const denied = await post(`${ctx.base}/api/activity/session`, { code: 'codigo-bueno', guildId: GUILD });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.reason, 'guild');
  ctx.app.config.values.discordGuildIds = GUILD;
});
