#!/usr/bin/env node
// Punto de entrada: arranca el puente y muestra por consola cómo usarlo.

import { VERSION, createApp } from './app.js';
import { ConfigError } from './config.js';
import { createLogger } from './log.js';

const log = createLogger();

let app;
try {
  app = await createApp({ log });
  await app.start();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\nConfiguración no válida: ${err.message}\n`);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`\nEl puerto ${err.port} ya está en uso. Cierra el programa que lo ocupa o cambia el puerto (HTTP_PORT / RTMP_PORT).\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\nSin permiso para abrir el puerto ${err.port}. Usa un puerto por encima de 1024.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}

const { config, ports } = app;
const lines = [
  '',
  `  Puente de directo → Discord · v${VERSION}`,
  '',
  `  Panel de control:  http://localhost:${ports.http}/admin`,
];
if (config.created) {
  lines.push(`  Contraseña:        ${config.get('adminPassword')}   (apúntala; se guarda en ${config.file})`);
} else if (config.locked.has('adminPassword')) {
  lines.push('  Contraseña:        la definida en ADMIN_PASSWORD');
} else {
  lines.push(`  Contraseña:        la guardada en ${config.file} (campo "adminPassword")`);
}
lines.push(
  `  Entrada RTMP:      puerto ${ports.rtmp} (la dirección completa para la cámara está en el panel)`,
  app.ffmpeg
    ? `  ffmpeg:            ${app.ffmpeg.version}`
    : '  ffmpeg:            NO ENCONTRADO — sin miniaturas ni modo compatible (instala ffmpeg o define FFMPEG_PATH)',
  '',
);
console.log(lines.join('\n'));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', `Cerrando (${signal})…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.stop();
  } catch (err) {
    log('error', `Error al cerrar: ${err.message}`);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Un fallo inesperado no debe tirar el directo; si se repite mucho, se sale
// para que quien supervise el proceso (Docker, systemd…) lo reinicie limpio.
let recentFailures = 0;
function unexpected(kind, err) {
  log('error', `${kind}: ${err?.stack ?? err}`);
  recentFailures += 1;
  setTimeout(() => {
    recentFailures -= 1;
  }, 60_000).unref();
  if (recentFailures > 5) process.exit(1);
}
process.on('uncaughtException', (err) => unexpected('Error no controlado', err));
process.on('unhandledRejection', (err) => unexpected('Promesa rechazada sin controlar', err));
