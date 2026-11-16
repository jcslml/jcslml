// Una conexión RTMP entrante (solo publicación: la cámara envía, nosotros recibimos).
//
// Implementa handshake, lectura de chunks, mensajes de control y los comandos
// que usa un codificador para publicar (connect, createStream, publish...).
// Está pensada para un puerto expuesto a Internet: límites de memoria antes de
// autenticar, plazos y cierre ante cualquier dato incoherente.

import * as amf from './amf0.js';
import { buildServerHandshake, HANDSHAKE_SIZE } from './handshake.js';

const ST_C0C1 = 0;
const ST_C2 = 1;
const ST_CHUNKS = 2;
const ST_CLOSED = 3;

const MESSAGE_HEADER_BYTES = [11, 7, 3, 0];

const MSG_SET_CHUNK_SIZE = 1;
const MSG_ABORT = 2;
const MSG_ACK = 3;
const MSG_USER_CONTROL = 4;
const MSG_WINDOW_ACK_SIZE = 5;
const MSG_SET_PEER_BANDWIDTH = 6;
export const MSG_AUDIO = 8;
export const MSG_VIDEO = 9;
const MSG_DATA_AMF3 = 15;
const MSG_COMMAND_AMF3 = 17;
const MSG_DATA_AMF0 = 18;
const MSG_COMMAND_AMF0 = 20;
const MSG_AGGREGATE = 22;

const CSID_CONTROL = 2;
const CSID_COMMAND = 3;

const DEFAULT_CHUNK_SIZE = 128;
const OUT_CHUNK_SIZE = 4096;
const ACK_WINDOW = 2_500_000;
const MAX_CHUNK_STREAMS = 64;
const MAX_MESSAGE_BEFORE_PUBLISH = 64 * 1024;
const MAX_MESSAGE = 0xffffff;
const MEDIA_STREAM_ID = 1;

let nextSessionId = 1;

class ChunkStream {
  constructor() {
    this.timestamp = 0; // marca de tiempo absoluta del mensaje en curso
    this.delta = 0; // último incremento recibido
    this.length = 0;
    this.type = 0;
    this.streamId = 0;
    this.extended = false; // la última cabecera llevaba marca de tiempo extendida
    this.extendedValue = 0;
    this.hasHeader = false;
    this.buffer = null; // cuerpo del mensaje que se está recomponiendo
    this.received = 0;
  }
}

function u32(value) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}

/** Parte una cadena tipo "nombre?a=1&b=2" en nombre y parámetros. */
function splitQuery(text) {
  const str = String(text ?? '');
  const i = str.indexOf('?');
  if (i === -1) return { path: str, query: {} };
  const query = {};
  for (const [k, v] of new URLSearchParams(str.slice(i + 1))) query[k] = v;
  return { path: str.slice(0, i), query };
}

export class RtmpSession {
  /**
   * @param {import('node:net').Socket} socket
   * @param {object} options
   * @param {(info: {app: string, name: string, query: object, ip: string}) => boolean} options.authorize
   * @param {object} options.handlers onPublish, onUnpublish, onMedia, onMetadata, onClose
   * @param {number} [options.publishTimeoutMs]
   * @param {number} [options.idleTimeoutMs]
   */
  constructor(socket, options) {
    this.id = nextSessionId++;
    this.socket = socket;
    this.ip = socket.remoteAddress ?? '';
    this.authorize = options.authorize;
    this.handlers = options.handlers ?? {};
    this.connectedAt = Date.now();
    this.bytesIn = 0;
    this.publishing = false;
    this.app = '';
    this.tcUrl = '';
    this.encoder = '';
    this.closeReason = '';

    this._state = ST_C0C1;
    this._pending = null;
    this._streams = new Map();
    this._current = null;
    this._chunkLeft = 0;
    this._inChunkSize = DEFAULT_CHUNK_SIZE;
    this._outChunkSize = DEFAULT_CHUNK_SIZE;
    this._ackWindow = ACK_WINDOW;
    this._lastAck = 0;
    this._connected = false;

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(options.idleTimeoutMs ?? 20_000);
    socket.on('data', (data) => this._onData(data));
    socket.on('timeout', () => this.close('sin datos (tiempo de espera agotado)'));
    socket.on('error', (err) => this.close(`error de red: ${err.code ?? err.message}`));
    socket.on('close', () => this.close('conexión cerrada por el emisor'));

    this._publishDeadline = setTimeout(
      () => this.close('no empezó a publicar a tiempo'),
      options.publishTimeoutMs ?? 15_000,
    );
    this._publishDeadline.unref?.();
  }

  /** Cierra la sesión (idempotente). */
  close(reason = '') {
    if (this._state === ST_CLOSED) return;
    this._state = ST_CLOSED;
    this.closeReason = reason;
    clearTimeout(this._publishDeadline);
    this._streams.clear();
    this._current = null;
    this._pending = null;
    const wasPublishing = this.publishing;
    this.publishing = false;
    if (!this.socket.destroyed) {
      this.socket.end();
      const kill = setTimeout(() => this.socket.destroy(), 1000);
      kill.unref?.();
    }
    if (wasPublishing) this.handlers.onUnpublish?.(this, reason);
    this.handlers.onClose?.(this, reason);
  }

  _onData(data) {
    if (this._state === ST_CLOSED) return;
    this.bytesIn += data.length;
    try {
      this._consume(data);
      if (this.bytesIn - this._lastAck >= this._ackWindow) {
        this._lastAck = this.bytesIn;
        this._send(CSID_CONTROL, MSG_ACK, 0, u32(this.bytesIn));
      }
    } catch (err) {
      this.close(`protocolo: ${err.message}`);
    }
  }

  _consume(data) {
    const buf = this._pending ? Buffer.concat([this._pending, data]) : data;
    this._pending = null;
    let pos = 0;

    if (this._state === ST_C0C1) {
      if (buf.length < 1 + HANDSHAKE_SIZE) {
        if (buf[0] !== 0x03) throw new Error(describeBadHello(buf[0]));
        this._pending = buf;
        return;
      }
      if (buf[0] !== 0x03) throw new Error(describeBadHello(buf[0]));
      const { response } = buildServerHandshake(buf.subarray(1, 1 + HANDSHAKE_SIZE));
      this._write(response);
      pos = 1 + HANDSHAKE_SIZE;
      this._state = ST_C2;
    }

    if (this._state === ST_C2) {
      if (buf.length - pos < HANDSHAKE_SIZE) {
        this._pending = buf.subarray(pos);
        return;
      }
      pos += HANDSHAKE_SIZE;
      this._state = ST_CHUNKS;
    }

    while (pos < buf.length && this._state === ST_CHUNKS) {
      const stream = this._current;
      if (stream) {
        const n = Math.min(this._chunkLeft, buf.length - pos);
        buf.copy(stream.buffer, stream.received, pos, pos + n);
        stream.received += n;
        this._chunkLeft -= n;
        pos += n;
        if (this._chunkLeft === 0) {
          this._current = null;
          if (stream.received === stream.length) this._completeMessage(stream);
        }
        continue;
      }
      const used = this._readChunkHeader(buf, pos);
      if (used === 0) break; // cabecera incompleta: esperar más datos
      pos += used;
    }

    if (pos < buf.length && this._state === ST_CHUNKS) this._pending = buf.subarray(pos);
  }

  /**
   * Interpreta la cabecera de un chunk. Devuelve los bytes consumidos, o 0 si
   * todavía no ha llegado la cabecera completa.
   */
  _readChunkHeader(buf, pos) {
    const available = buf.length - pos;
    const first = buf[pos];
    const fmt = first >> 6;
    let csid = first & 0x3f;
    let basic = 1;
    if (csid === 0) {
      if (available < 2) return 0;
      csid = 64 + buf[pos + 1];
      basic = 2;
    } else if (csid === 1) {
      if (available < 3) return 0;
      csid = 64 + buf[pos + 1] + (buf[pos + 2] << 8);
      basic = 3;
    }
    if (available < basic + MESSAGE_HEADER_BYTES[fmt]) return 0;

    let stream = this._streams.get(csid);
    if (!stream) {
      if (this._streams.size >= MAX_CHUNK_STREAMS) throw new Error('demasiados chunk streams');
      stream = new ChunkStream();
      this._streams.set(csid, stream);
    }

    let p = pos + basic;
    let field = 0;
    let length = stream.length;
    let type = stream.type;
    let streamId = stream.streamId;
    if (fmt <= 2) {
      field = buf.readUIntBE(p, 3);
      p += 3;
    }
    if (fmt <= 1) {
      length = buf.readUIntBE(p, 3);
      type = buf[p + 3];
      p += 4;
    }
    if (fmt === 0) {
      streamId = buf.readUInt32LE(p);
      p += 4;
    }

    const continuing = stream.buffer !== null && fmt === 3;
    let extended = fmt === 3 ? stream.extended : field === 0xffffff;
    let extendedValue = stream.extendedValue;
    if (extended) {
      if (buf.length - p < 4) return 0;
      const value = buf.readUInt32BE(p);
      if (continuing && value !== stream.extendedValue) {
        // Hay codificadores que no repiten la marca extendida en los chunks de
        // continuación: si no coincide, esos 4 bytes son ya datos del mensaje.
      } else {
        p += 4;
        if (fmt !== 3) {
          field = value;
          extendedValue = value;
        }
      }
    }

    if (!continuing) {
      // Empieza un mensaje nuevo en este chunk stream.
      if (fmt >= 2 && !stream.hasHeader) throw new Error('chunk sin cabecera previa');
      if (fmt === 0) {
        // Según la especificación (y como hacen FFmpeg y librtmp), si después
        // llega un chunk de tipo 3 que abre mensaje, su incremento es este valor.
        stream.timestamp = field;
        stream.delta = field;
      } else {
        if (fmt !== 3) stream.delta = field;
        stream.timestamp = (stream.timestamp + stream.delta) >>> 0;
      }
      if (fmt !== 3) {
        stream.extended = extended;
        stream.extendedValue = extendedValue;
      }
      stream.length = length;
      stream.type = type;
      stream.streamId = streamId;
      stream.hasHeader = true;

      const limit = this.publishing ? MAX_MESSAGE : MAX_MESSAGE_BEFORE_PUBLISH;
      if (length > limit) throw new Error(`mensaje demasiado grande (${length} bytes)`);
      stream.buffer = Buffer.allocUnsafe(length);
      stream.received = 0;
      if (length === 0) {
        this._completeMessage(stream);
        return p - pos;
      }
    }

    this._current = stream;
    this._chunkLeft = Math.min(this._inChunkSize, stream.length - stream.received);
    return p - pos;
  }

  _completeMessage(stream) {
    const payload = stream.buffer;
    stream.buffer = null;
    stream.received = 0;
    this._handleMessage(stream.type, stream.timestamp, stream.streamId, payload);
  }

  _handleMessage(type, timestamp, streamId, payload) {
    switch (type) {
      case MSG_SET_CHUNK_SIZE: {
        if (payload.length < 4) throw new Error('Set Chunk Size inválido');
        const size = payload.readUInt32BE(0) & 0x7fffffff;
        if (size < 1) throw new Error('tamaño de chunk inválido');
        this._inChunkSize = size;
        break;
      }
      case MSG_ABORT: {
        if (payload.length < 4) break;
        const stream = this._streams.get(payload.readUInt32BE(0));
        if (stream) {
          stream.buffer = null;
          stream.received = 0;
        }
        break;
      }
      case MSG_WINDOW_ACK_SIZE: {
        if (payload.length < 4) break;
        const size = payload.readUInt32BE(0);
        if (size > 0) this._ackWindow = size;
        break;
      }
      case MSG_USER_CONTROL: {
        // 6 = PingRequest: se contesta con PingResponse (7) y la misma marca.
        if (payload.length >= 6 && payload.readUInt16BE(0) === 6) {
          const pong = Buffer.from(payload.subarray(0, 6));
          pong.writeUInt16BE(7, 0);
          this._send(CSID_CONTROL, MSG_USER_CONTROL, 0, pong);
        }
        break;
      }
      case MSG_ACK:
      case MSG_SET_PEER_BANDWIDTH:
        break;
      case MSG_AUDIO:
      case MSG_VIDEO:
        if (this.publishing && payload.length > 0) {
          this.handlers.onMedia?.(this, type, timestamp, payload);
        }
        break;
      case MSG_DATA_AMF0:
        this._handleData(timestamp, payload);
        break;
      case MSG_DATA_AMF3:
        this._handleData(timestamp, payload.length && payload[0] === 0 ? payload.subarray(1) : payload);
        break;
      case MSG_COMMAND_AMF0:
        this._handleCommand(streamId, payload);
        break;
      case MSG_COMMAND_AMF3:
        this._handleCommand(streamId, payload.length && payload[0] === 0 ? payload.subarray(1) : payload);
        break;
      case MSG_AGGREGATE:
        this._handleAggregate(timestamp, streamId, payload);
        break;
      default:
        break; // tipos que no nos afectan (objetos compartidos, etc.)
    }
  }

  /** Mensaje agregado: varias etiquetas con formato FLV dentro de un mensaje. */
  _handleAggregate(timestamp, streamId, payload) {
    let pos = 0;
    let base = null;
    while (pos + 11 <= payload.length) {
      const type = payload[pos];
      const size = payload.readUIntBE(pos + 1, 3);
      const tagTime = (payload.readUIntBE(pos + 4, 3) | (payload[pos + 7] << 24)) >>> 0;
      pos += 11;
      if (pos + size > payload.length) break;
      const body = payload.subarray(pos, pos + size);
      pos += size + 4;
      if (base === null) base = tagTime;
      this._handleMessage(type, (timestamp + tagTime - base) >>> 0, streamId, body);
      if (this._state === ST_CLOSED) return;
    }
  }

  _handleData(timestamp, payload) {
    if (!this.publishing) return;
    let decoded;
    try {
      decoded = amf.decodeAll(payload);
    } catch {
      return; // metadatos corruptos: se ignoran sin cortar la emisión
    }
    let index = 0;
    if (decoded.values[0] === '@setDataFrame') index = 1;
    if (decoded.values[index] !== 'onMetaData') return;
    const body = payload.subarray(decoded.offsets[index]);
    const meta = decoded.values[index + 1];
    this.handlers.onMetadata?.(this, timestamp, body, meta && typeof meta === 'object' ? meta : {});
  }

  _handleCommand(streamId, payload) {
    const { values } = amf.decodeAll(payload);
    const name = values[0];
    const txn = typeof values[1] === 'number' ? values[1] : 0;
    if (typeof name !== 'string') throw new Error('comando sin nombre');

    switch (name) {
      case 'connect': {
        const info = values[2] && typeof values[2] === 'object' ? values[2] : {};
        this.app = typeof info.app === 'string' ? info.app : '';
        this.tcUrl = typeof info.tcUrl === 'string' ? info.tcUrl.slice(0, 512) : '';
        this.encoder = typeof info.flashVer === 'string' ? info.flashVer.slice(0, 120) : '';
        const encoding = info.objectEncoding === 3 ? 3 : 0;
        this._connected = true;
        this._send(CSID_CONTROL, MSG_WINDOW_ACK_SIZE, 0, u32(ACK_WINDOW));
        this._send(CSID_CONTROL, MSG_SET_PEER_BANDWIDTH, 0, Buffer.concat([u32(ACK_WINDOW), Buffer.from([2])]));
        this._send(CSID_CONTROL, MSG_SET_CHUNK_SIZE, 0, u32(OUT_CHUNK_SIZE));
        this._outChunkSize = OUT_CHUNK_SIZE;
        this._command(0, '_result', txn,
          { fmsVer: 'FMS/3,0,1,123', capabilities: 31 },
          {
            level: 'status',
            code: 'NetConnection.Connect.Success',
            description: 'Connection succeeded.',
            objectEncoding: encoding,
          });
        break;
      }
      case 'releaseStream':
      case 'FCUnpublish':
      case '_checkbw':
        if (name === 'FCUnpublish') this._stopPublishing('el emisor terminó la emisión');
        if (txn) this._command(0, '_result', txn, null, undefined);
        break;
      case 'FCPublish':
        if (txn) this._command(0, '_result', txn, null, undefined);
        this._command(0, 'onFCPublish', 0, null, {
          code: 'NetStream.Publish.Start',
          description: String(values[3] ?? ''),
        });
        break;
      case 'createStream':
        if (!this._connected) throw new Error('createStream antes de connect');
        this._command(0, '_result', txn, null, MEDIA_STREAM_ID);
        break;
      case 'publish':
        this._handlePublish(streamId, values[3]);
        break;
      case 'deleteStream':
      case 'closeStream':
        this._stopPublishing('el emisor terminó la emisión');
        break;
      case 'play':
      case 'play2':
        this._status(streamId, 'error', 'NetStream.Play.Failed', 'Este servidor solo acepta publicación.');
        this.close('intento de reproducción por RTMP');
        break;
      default:
        break;
    }
  }

  _handlePublish(streamId, rawName) {
    if (!this._connected) throw new Error('publish antes de connect');
    if (this.publishing) return;
    const app = splitQuery(this.app);
    const name = splitQuery(typeof rawName === 'string' ? rawName : '');
    const request = {
      app: app.path,
      name: name.path,
      query: { ...app.query, ...name.query },
      ip: this.ip,
    };
    let allowed = false;
    try {
      allowed = this.authorize(request) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      this._status(streamId, 'error', 'NetStream.Publish.BadName', 'Clave de emisión incorrecta.');
      this.close('clave de emisión incorrecta');
      return;
    }
    clearTimeout(this._publishDeadline);
    this.publishing = true;
    this._status(streamId, 'status', 'NetStream.Publish.Start', 'Publicación iniciada.');
    this.handlers.onPublish?.(this, request);
  }

  _stopPublishing(reason) {
    if (!this.publishing) return;
    this.publishing = false;
    this.handlers.onUnpublish?.(this, reason);
  }

  _status(streamId, level, code, description) {
    this._command(streamId, 'onStatus', 0, null, { level, code, description });
  }

  _command(streamId, ...values) {
    this._send(CSID_COMMAND, MSG_COMMAND_AMF0, streamId, amf.encode(...values));
  }

  /** Envía un mensaje RTMP troceado según el tamaño de chunk de salida. */
  _send(csid, type, streamId, payload) {
    const head = Buffer.alloc(12);
    head[0] = csid; // formato 0
    head.writeUIntBE(payload.length, 4, 3);
    head[7] = type;
    head.writeUInt32LE(streamId, 8);
    const parts = [head];
    for (let offset = 0; offset < payload.length; offset += this._outChunkSize) {
      if (offset > 0) parts.push(Buffer.from([0xc0 | csid]));
      parts.push(payload.subarray(offset, offset + this._outChunkSize));
    }
    this._write(Buffer.concat(parts));
  }

  _write(buf) {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(buf);
  }
}

function describeBadHello(byte) {
  if (byte === 0x16) return 'el emisor usa RTMPS (TLS) contra el puerto RTMP sin cifrar';
  if (byte === 0x47 || byte === 0x50) return 'petición HTTP en el puerto RTMP';
  return `versión RTMP no soportada (0x${(byte ?? 0).toString(16)})`;
}
