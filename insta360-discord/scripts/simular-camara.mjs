#!/usr/bin/env node
// Simula la cámara: envía una carta de ajuste con un reloj y un tono al puente
// usando ffmpeg. Sirve para probar todo (visor, Discord…) sin la cámara real.
//
//   npm run simular-camara                    → usa la clave de data/config.json
//   npm run simular-camara -- --segundos 30   → emite 30 s y termina
//   npm run simular-camara -- --url rtmp://servidor:1935/live/CLAVE

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findFfmpeg } from '../src/ffmpeg.js';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

let url = option('url', process.env.RTMP_URL);
if (!url) {
  const file = path.resolve(process.env.DATA_DIR ?? 'data', 'config.json');
  if (!fs.existsSync(file)) {
    console.error(`No encuentro ${file}. Arranca antes el puente (npm start) o indica --url.`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const port = process.env.RTMP_PORT ?? config.rtmpPort ?? 1935;
  url = `rtmp://127.0.0.1:${port}/live/${process.env.STREAM_KEY ?? config.streamKey}`;
}

const seconds = Number(option('segundos', '0'));
const size = option('tamano', '1280x720');
const fps = option('fps', '30');
const bitrate = option('bitrate', '2500k');

const ffmpeg = await findFfmpeg(process.env.FFMPEG_PATH);
if (!ffmpeg) {
  console.error('No se ha encontrado ffmpeg. Instálalo o define FFMPEG_PATH.');
  process.exit(1);
}

const args = [
  '-hide_banner', '-loglevel', 'error', '-stats',
  '-re', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`,
  '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  ...(seconds > 0 ? ['-t', String(seconds)] : []),
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
  '-pix_fmt', 'yuv420p', '-g', String(Number(fps) * 2), '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate,
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
  '-f', 'flv', url,
];

console.log(`Emitiendo señal de prueba (${size} a ${fps} fps) hacia ${url.replace(/[^/]+$/, '••••')}`);
console.log('Pulsa Ctrl+C para detenerla.\n');
const child = spawn(ffmpeg.path, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
