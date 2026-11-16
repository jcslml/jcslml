// Tubería de ffmpeg: recibe el directo en FLV por la entrada estándar y genera
//  - HLS (sin recodificar), para los navegadores que no pueden usar el modo de
//    baja latencia (iPhone antiguos) y como respaldo;
//  - una miniatura JPEG que se renueva cada pocos segundos, para Discord.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_STDIN_BACKLOG = 24 * 1024 * 1024;
const SNAPSHOT_MAX_AGE_MS = 20_000;

export class MediaPipeline extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./hub.js').StreamHub} options.hub
   * @param {string | null} options.ffmpegPath
   * @param {string} options.dir Carpeta de trabajo (se vacía en cada arranque).
   * @param {(level: string, message: string) => void} options.log
   */
  constructor({ hub, ffmpegPath, dir, log }) {
    super();
    this.hub = hub;
    this.ffmpegPath = ffmpegPath;
    this.dir = dir;
    this.log = log;
    this.child = null;
    this.unsubscribe = null;
    this.running = false;
    this.runDir = null; // cada arranque de ffmpeg escribe en su propia subcarpeta
    this.restarts = 0;
    this.lastError = '';
    this._restartTimer = null;
    this._cleanupTimer = null;

    hub.on('live', () => this.start());
    hub.on('offline', () => this.stop());
  }

  get available() {
    return Boolean(this.ffmpegPath);
  }

  get playlistPath() {
    return this.runDir ? path.join(this.runDir, 'index.m3u8') : null;
  }

  get snapshotPath() {
    return this.runDir ? path.join(this.runDir, 'miniatura.jpg') : null;
  }

  /** Ruta de un fichero HLS (lista o segmento) del arranque en curso, o null. */
  hlsFile(name) {
    if (!this.runDir || !/^[\w.-]+\.(m3u8|ts)$/.test(name)) return null;
    return path.join(this.runDir, name);
  }

  start() {
    if (!this.available || this.running) return;
    this.running = true;
    this.restarts = 0;
    clearTimeout(this._cleanupTimer);
    this._spawn();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._restartTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    const child = this.child;
    this.child = null;
    if (child) {
      // Cerrar la entrada deja que ffmpeg termine el último segmento y la lista.
      child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      kill.unref?.();
      child.once('exit', () => clearTimeout(kill));
    }
    // Los visores aún pueden pedir los últimos segmentos durante un rato.
    this._cleanupTimer = setTimeout(() => {
      this.runDir = null;
      fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
    }, 60_000);
    this._cleanupTimer.unref?.();
  }

  async _spawn() {
    const prefix = `g${this.hub.generation}_${Date.now().toString(36)}`;
    const runDir = path.join(this.dir, prefix);
    try {
      // Se borra lo de arranques anteriores; el nuevo usa una carpeta propia para
      // que un ffmpeg que aún esté terminando no pise la lista del nuevo.
      await fsp.rm(this.dir, { recursive: true, force: true });
      await fsp.mkdir(runDir, { recursive: true });
    } catch (err) {
      this.log('warn', `No se pudo preparar la carpeta de HLS: ${err.message}`);
    }
    if (!this.running || !this.hub.live) return;
    this.runDir = runDir;
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts+discardcorrupt',
      '-analyzeduration', '2000000', '-probesize', '4000000',
      '-skip_frame', 'nokey', // solo afecta a la miniatura: el HLS no se decodifica
      '-f', 'flv', '-i', 'pipe:0',
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+independent_segments+temp_file+program_date_time',
      '-hls_segment_filename', path.join(runDir, `${prefix}_%05d.ts`),
      this.playlistPath,
    ];
    if (this.hub.hasVideo) {
      args.push(
        '-map', '0:v:0', '-an',
        // Primer fotograma clave en cuanto llega y después uno cada 2 s.
        '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,2)',scale='min(1280,iw)':-2",
        '-q:v', '4',
        '-f', 'image2', '-update', '1', '-atomic_writing', '1',
        this.snapshotPath,
      );
    }

    const child = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    const startedAt = Date.now();
    let stderrTail = '';

    child.stdin.on('error', () => {}); // EPIPE si ffmpeg muere: lo gestiona 'exit'
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      stderrTail = (stderrTail + text).slice(-2000);
    });
    child.on('error', (err) => {
      this.lastError = err.message;
      this.log('error', `No se pudo ejecutar ffmpeg: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // parada ordenada
      this.child = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.lastError = stderrTail.trim().split('\n').slice(-3).join(' | ');
      if (!this.running) return;
      if (Date.now() - startedAt > 30_000) this.restarts = 0;
      this.restarts += 1;
      const delay = Math.min(1000 * this.restarts, 10_000);
      this.log('warn', `ffmpeg terminó (código ${code ?? signal}); reinicio en ${delay / 1000} s. ${this.lastError}`);
      this._restartTimer = setTimeout(() => this._spawn(), delay);
      this._restartTimer.unref?.();
    });

    this.unsubscribe = this.hub.subscribe({
      write: (chunk) => {
        if (child.stdin.destroyed || !child.stdin.writable) return;
        child.stdin.write(chunk);
        if (child.stdin.writableLength > MAX_STDIN_BACKLOG) {
          this.log('warn', 'ffmpeg no consume la señal a tiempo; se reinicia.');
          child.kill('SIGKILL');
        }
      },
    });
  }

  /** Última miniatura si es reciente; null en caso contrario. */
  async snapshot() {
    if (!this.snapshotPath) return null;
    try {
      const stat = await fsp.stat(this.snapshotPath);
      if (Date.now() - stat.mtimeMs > SNAPSHOT_MAX_AGE_MS) return null;
      return await fsp.readFile(this.snapshotPath);
    } catch {
      return null;
    }
  }

  /** Espera hasta `timeoutMs` a que exista una miniatura reciente. */
  async waitForSnapshot(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const image = await this.snapshot();
      if (image || Date.now() >= deadline || !this.running) return image;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  hasPlaylist() {
    return this.playlistPath !== null && fs.existsSync(this.playlistPath);
  }

  async close() {
    this.stop();
    clearTimeout(this._cleanupTimer);
  }
}
