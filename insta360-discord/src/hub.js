// Distribuidor de la señal: recibe audio/vídeo del emisor RTMP, lo convierte en
// etiquetas FLV y lo reparte a los suscriptores (visores y la tubería de ffmpeg).
//
// Guarda las cabeceras de los decodificadores y el último grupo de imágenes
// (GOP), de modo que quien se conecta a mitad de directo empieza a ver al instante.

import { EventEmitter } from 'node:events';
import { MSG_VIDEO } from './rtmp/session.js';
import {
  TAG_AUDIO, TAG_SCRIPT, TAG_VIDEO,
  classifyAudio, classifyVideo, flvHeader, flvTag, parseAvcResolution,
} from './flv.js';

const MAX_GOP_BYTES = 48 * 1024 * 1024;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class StreamHub extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.audioWaitMs] Cuánto esperar al audio antes de dar el directo por listo.
   */
  constructor(options = {}) {
    super();
    this.audioWaitMs = options.audioWaitMs ?? 1500;
    this.generation = 0;
    this.subscribers = new Set();
    this._reset();
    this._sampler = setInterval(() => this._sample(), 1000);
    this._sampler.unref?.();
  }

  _reset() {
    this.publisher = null;
    this.live = false;
    this.publishedAt = 0;
    this.liveAt = 0;
    this.hasAudio = false;
    this.hasVideo = false;
    this.videoCodec = '';
    this.audioCodec = '';
    this.width = 0;
    this.height = 0;
    this.meta = {};
    this.metaTag = null;
    this.videoHeader = null;
    this.audioHeader = null;
    this.gop = [];
    this.gopBytes = 0;
    this.timeBase = null;
    this.bytes = 0;
    this.videoFrames = 0;
    this.audioFrames = 0;
    this.bitrateKbps = 0;
    this.fps = 0;
    this._lastBytes = 0;
    this._lastFrames = 0;
    this._lastSampleAt = 0;
    clearInterval(this._readyTimer);
    this._readyTimer = null;
  }

  // ---------------------------------------------------------------- emisor

  /** Un emisor autenticado empieza a publicar. Sustituye al anterior si lo había. */
  startPublish(session) {
    const previous = this.publisher;
    if (previous && previous !== session) {
      this._end('sustituido por una conexión nueva');
      previous.close('sustituido por una conexión nueva');
    }
    this._reset();
    this.publisher = session;
    this.publishedAt = Date.now();
    this.generation += 1;
    this._readyTimer = setInterval(() => this._checkReady(), 250);
    this._readyTimer.unref?.();
    this.emit('publish', { ip: session.ip, encoder: session.encoder });
  }

  stopPublish(session, reason = '') {
    if (session !== this.publisher) return;
    this._end(reason);
  }

  _end(reason) {
    const wasLive = this.live;
    const generation = this.generation;
    for (const sub of this.subscribers) sub.sink.close?.('fin de la emisión');
    this.subscribers.clear();
    this._reset();
    this.emit('offline', { reason, wasLive, generation });
  }

  pushMetadata(session, _timestamp, body, meta) {
    if (session !== this.publisher) return;
    const clean = {};
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
      else if (typeof value === 'string') clean[key] = value.slice(0, 200);
    }
    this.meta = clean;
    const width = finite(clean.width);
    const height = finite(clean.height);
    if (width > 0 && height > 0 && !this.width) {
      this.width = Math.round(width);
      this.height = Math.round(height);
    }
    this.metaTag = flvTag(TAG_SCRIPT, 0, body);
    this._broadcast(this.metaTag, false, true);
  }

  pushMedia(session, type, timestamp, payload) {
    if (session !== this.publisher) return;
    if (this.timeBase === null) this.timeBase = timestamp;
    let time = (timestamp - this.timeBase) >>> 0;
    if (time > 0x7fffffff) time = 0; // marca anterior a la primera recibida
    this.bytes += payload.length;

    if (type === MSG_VIDEO) {
      const info = classifyVideo(payload);
      const tag = flvTag(TAG_VIDEO, time, payload);
      if (info.kind === 'header') {
        this.videoHeader = tag;
        this.videoCodec = info.codec;
        const size = parseAvcResolution(payload);
        if (size) {
          this.width = size.width;
          this.height = size.height;
        }
        this._broadcast(tag, false, true);
      } else if (info.kind === 'key') {
        this.videoFrames += 1;
        if (!this.videoCodec) this.videoCodec = info.codec;
        this.gop = [tag];
        this.gopBytes = tag.length;
        this._broadcast(tag, true, false);
      } else {
        if (info.kind === 'inter') this.videoFrames += 1;
        this._cache(tag);
        this._broadcast(tag, false, false);
      }
    } else {
      const info = classifyAudio(payload);
      const tag = flvTag(TAG_AUDIO, time, payload);
      if (!this.audioCodec) this.audioCodec = info.codec;
      if (info.kind === 'header') {
        this.audioHeader = tag;
        this._broadcast(tag, false, true);
      } else {
        this.audioFrames += 1;
        this._cache(tag);
        this._broadcast(tag, false, false);
      }
    }
    if (!this.live) this._checkReady();
  }

  _cache(tag) {
    if (this.gop.length === 0) return;
    this.gop.push(tag);
    this.gopBytes += tag.length;
    if (this.gopBytes > MAX_GOP_BYTES) {
      this.gop = [];
      this.gopBytes = 0;
    }
  }

  _broadcast(tag, isKeyframe, isHeader) {
    for (const sub of this.subscribers) {
      if (sub.waitingKeyframe) {
        if (isKeyframe) sub.waitingKeyframe = false;
        else if (!isHeader) continue;
      }
      sub.sink.write(tag);
    }
  }

  /**
   * El directo se da por listo cuando hay un fotograma clave y se sabe si trae
   * audio (así la cabecera FLV anuncia las pistas correctas a los reproductores).
   */
  _checkReady() {
    if (this.live || !this.publisher) return;
    const elapsed = Date.now() - this.publishedAt;
    const audioSeen = this.audioHeader !== null || this.audioFrames > 0;
    const videoReady = this.gop.length > 0;
    const videoSeen = videoReady || this.videoHeader !== null;
    let ready = false;
    if (videoReady && (audioSeen || elapsed >= this.audioWaitMs)) ready = true;
    else if (!videoSeen && audioSeen && elapsed >= this.audioWaitMs * 2) ready = true;
    if (!ready) return;

    clearInterval(this._readyTimer);
    this._readyTimer = null;
    this.hasVideo = videoReady;
    this.hasAudio = audioSeen;
    this.live = true;
    this.liveAt = Date.now();
    this.emit('live', { generation: this.generation });
  }

  _sample() {
    if (!this.publisher) return;
    const now = Date.now();
    const seconds = Math.max(0.25, (now - (this._lastSampleAt || now - 1000)) / 1000);
    this._lastSampleAt = now;
    const kbps = ((this.bytes - this._lastBytes) * 8) / 1000 / seconds;
    const frames = (this.videoFrames - this._lastFrames) / seconds;
    this._lastBytes = this.bytes;
    this._lastFrames = this.videoFrames;
    this.bitrateKbps = this.bitrateKbps ? this.bitrateKbps * 0.6 + kbps * 0.4 : kbps;
    this.fps = this.fps ? this.fps * 0.6 + frames * 0.4 : frames;
  }

  // ----------------------------------------------------------- suscriptores

  /**
   * Suscribe un destino al directo. Recibe de inmediato la cabecera FLV, los
   * metadatos, las cabeceras de códec y el GOP en curso.
   * @param {{ write: (chunk: Buffer) => void, close?: (reason: string) => void }} sink
   * @returns {(() => void) | null} Función para darse de baja, o null si no hay directo.
   */
  subscribe(sink) {
    if (!this.live) return null;
    const parts = [flvHeader(this.hasAudio, this.hasVideo)];
    if (this.metaTag) parts.push(this.metaTag);
    if (this.videoHeader) parts.push(this.videoHeader);
    if (this.audioHeader) parts.push(this.audioHeader);
    const sub = { sink, waitingKeyframe: false };
    if (this.gop.length > 0) parts.push(...this.gop);
    else if (this.hasVideo) sub.waitingKeyframe = true;
    sink.write(Buffer.concat(parts));
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Estado resumido para las API y el panel. */
  info() {
    const fps = finite(this.meta.framerate) ?? finite(this.meta.videoframerate);
    return {
      live: this.live,
      receiving: this.publisher !== null,
      generation: this.generation,
      startedAt: this.liveAt || null,
      hasAudio: this.hasAudio,
      hasVideo: this.hasVideo,
      videoCodec: this.videoCodec,
      audioCodec: this.audioCodec,
      width: this.width,
      height: this.height,
      fps: Math.round((this.fps || fps || 0) * 10) / 10,
      bitrateKbps: Math.round(this.bitrateKbps),
      encoder: typeof this.meta.encoder === 'string' ? this.meta.encoder : this.publisher?.encoder ?? '',
      sourceIp: this.publisher?.ip ?? '',
    };
  }

  close() {
    clearInterval(this._sampler);
    clearInterval(this._readyTimer);
    if (this.publisher) this._end('servidor detenido');
  }
}
