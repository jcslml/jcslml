// Ensambla todas las piezas: ingesta RTMP, distribuidor, ffmpeg, Discord y web.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from './auth.js';
import { Config } from './config.js';
import { Announcer, formatDuration } from './discord/announcer.js';
import { DiscordOAuth } from './discord/oauth.js';
import { findFfmpeg } from './ffmpeg.js';
import { StreamHub } from './hub.js';
import { HttpServer } from './http.js';
import { LiveTracker } from './live.js';
import { MediaPipeline } from './pipeline.js';
import { RtmpServer } from './rtmp/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * La cámara publica en rtmp://servidor/live/<clave>. Según el emisor, la clave
 * llega como nombre de emisión o como último tramo de la ruta, así que se
 * compara el último tramo de «aplicación/nombre».
 */
export function streamKeyFrom({ app, name }) {
  const segments = `${app ?? ''}/${name ?? ''}`.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

/**
 * @param {object} options
 * @param {(level: string, message: string) => void} options.log
 * @param {string} [options.dataDir]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function createApp({ log, dataDir, env = process.env }) {
  const config = new Config({ dataDir, env });
  const ffmpeg = await findFfmpeg(env.FFMPEG_PATH);
  const hub = new StreamHub();
  const pipeline = new MediaPipeline({
    hub,
    ffmpegPath: ffmpeg?.path ?? null,
    dir: path.join(config.dataDir, 'hls'),
    log,
  });
  const tracker = new LiveTracker({ hub, graceSeconds: () => config.get('graceSeconds') });
  const oauth = new DiscordOAuth({ apiBase: env.DISCORD_API_BASE });
  const http = new HttpServer({ config, hub, tracker, pipeline, oauth, ffmpeg, log, version: VERSION });
  const announcer = new Announcer({ config, tracker, pipeline, links: () => http.publicLinks(), log });
  http.announcer = announcer;

  const rtmp = new RtmpServer({
    port: config.get('rtmpPort'),
    host: config.get('bindHost'),
    authorize: (request) => safeEqual(streamKeyFrom(request), config.get('streamKey')),
    handlers: {
      onPublish: (session) => {
        session.publishedOnce = true;
        hub.startPublish(session);
      },
      onUnpublish: (session, reason) => hub.stopPublish(session, reason),
      onMedia: (session, type, timestamp, payload) => hub.pushMedia(session, type, timestamp, payload),
      onMetadata: (session, timestamp, body, meta) => hub.pushMetadata(session, timestamp, body, meta),
      onClose: (session, reason) => {
        if (reason === 'clave de emisión incorrecta') {
          http.lastRejected = { at: Date.now(), ip: session.ip, reason };
          log('warn', `Emisión rechazada desde ${session.ip}: la clave no coincide. Revisa la dirección RTMP en la app de la cámara.`);
        } else if (!session.publishedOnce) {
          log('debug', `Conexión RTMP descartada desde ${session.ip}: ${reason}`);
        }
      },
    },
  });

  hub.on('publish', ({ ip, encoder }) => {
    log('info', `Cámara conectada desde ${ip}${encoder ? ` (${encoder})` : ''}. Esperando la imagen…`);
  });
  hub.on('offline', ({ reason, wasLive }) => {
    if (!wasLive) log('info', `La cámara se desconectó antes de enviar imagen (${reason || 'sin motivo'}).`);
  });
  const describeSignal = () => {
    const info = hub.info();
    const size = info.width ? `${info.width}×${info.height}` : 'resolución desconocida';
    const tracks = [info.videoCodec, info.hasAudio ? info.audioCodec : 'sin audio'].filter(Boolean).join(' + ');
    return `${size}, ${tracks}`;
  };
  tracker.on('start', () => log('info', `🔴 Directo en marcha (${describeSignal()}).`));
  tracker.on('resume', () => log('info', 'La cámara ha vuelto: el directo continúa.'));
  tracker.on('drop', () => {
    log('warn', `Se ha perdido la señal de la cámara. Se espera ${config.get('graceSeconds')} s por si vuelve.`);
  });
  tracker.on('end', (session) => {
    log('info', `⚫ Directo finalizado. Duración: ${formatDuration(session.endedAt - session.startedAt)}.`);
  });

  return {
    config,
    hub,
    tracker,
    pipeline,
    announcer,
    http,
    rtmp,
    ffmpeg,
    ports: { http: 0, rtmp: 0 },

    async start() {
      this.ports.rtmp = await rtmp.listen();
      this.ports.http = await http.listen();
      return this.ports;
    },

    async stop() {
      // Cerrar el aviso de Discord antes de apagar, para que no quede "en directo".
      tracker.finishNow();
      await Promise.race([announcer.flush(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      await rtmp.close();
      hub.close();
      await pipeline.close();
      await http.close();
    },
  };
}
