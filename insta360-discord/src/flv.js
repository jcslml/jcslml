// Utilidades FLV: los mensajes de audio/vídeo de RTMP son cuerpos de etiqueta FLV,
// así que para servir el directo basta con añadirles la cabecera de etiqueta.

export const TAG_AUDIO = 8;
export const TAG_VIDEO = 9;
export const TAG_SCRIPT = 18;

/** Cabecera de fichero FLV (9 bytes) + PreviousTagSize0 (4 bytes). */
export function flvHeader(hasAudio, hasVideo) {
  const flags = (hasAudio ? 0x04 : 0) | (hasVideo ? 0x01 : 0);
  return Buffer.from([0x46, 0x4c, 0x56, 0x01, flags, 0, 0, 0, 9, 0, 0, 0, 0]);
}

/** Construye una etiqueta FLV completa (cabecera + datos + tamaño previo). */
export function flvTag(type, timestamp, payload) {
  const size = payload.length;
  const tag = Buffer.allocUnsafe(11 + size + 4);
  tag[0] = type;
  tag.writeUIntBE(size, 1, 3);
  tag.writeUIntBE(timestamp & 0xffffff, 4, 3);
  tag[7] = (timestamp >>> 24) & 0xff;
  tag.writeUIntBE(0, 8, 3);
  payload.copy(tag, 11);
  tag.writeUInt32BE(11 + size, 11 + size);
  return tag;
}

const LEGACY_VIDEO_CODECS = { 2: 'H.263', 4: 'VP6', 7: 'H.264', 12: 'HEVC', 13: 'AV1' };
const FOURCC_VIDEO = { avc1: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', av01: 'AV1', vp09: 'VP9', vp08: 'VP8' };
const LEGACY_AUDIO_CODECS = { 0: 'PCM', 1: 'ADPCM', 2: 'MP3', 3: 'PCM', 7: 'G.711', 8: 'G.711', 10: 'AAC', 11: 'Speex', 14: 'MP3' };
const FOURCC_AUDIO = { mp4a: 'AAC', Opus: 'Opus', fLaC: 'FLAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', '.mp3': 'MP3' };

/**
 * Clasifica un mensaje de vídeo.
 * kind: 'header' (configuración del decodificador), 'key', 'inter' u 'other'.
 */
export function classifyVideo(payload) {
  const first = payload[0];
  if (first & 0x80) {
    // RTMP "enhanced": tipo de paquete en el nibble bajo y FourCC a continuación.
    const frameType = (first >> 4) & 0x07;
    const packetType = first & 0x0f;
    const fourcc = payload.length >= 5 ? payload.toString('latin1', 1, 5) : '';
    const codec = FOURCC_VIDEO[fourcc] ?? fourcc;
    if (packetType === 0 || packetType === 5) return { kind: 'header', codec };
    if (packetType === 1 || packetType === 3) return { kind: frameType === 1 ? 'key' : 'inter', codec };
    return { kind: 'other', codec };
  }
  const frameType = first >> 4;
  const codecId = first & 0x0f;
  const codec = LEGACY_VIDEO_CODECS[codecId] ?? `códec ${codecId}`;
  if (frameType === 5) return { kind: 'other', codec };
  if (codecId === 7 || codecId === 12 || codecId === 13) {
    const packetType = payload[1];
    if (packetType === 0) return { kind: 'header', codec };
    if (packetType === 1) return { kind: frameType === 1 ? 'key' : 'inter', codec };
    return { kind: 'other', codec };
  }
  return { kind: frameType === 1 ? 'key' : 'inter', codec };
}

/** Clasifica un mensaje de audio: 'header' o 'frame'. */
export function classifyAudio(payload) {
  const format = payload[0] >> 4;
  if (format === 9) {
    const packetType = payload[0] & 0x0f;
    const fourcc = payload.length >= 5 ? payload.toString('latin1', 1, 5) : '';
    const codec = FOURCC_AUDIO[fourcc] ?? fourcc;
    return { kind: packetType === 0 ? 'header' : 'frame', codec };
  }
  const codec = LEGACY_AUDIO_CODECS[format] ?? `códec ${format}`;
  if (format === 10) return { kind: payload[1] === 0 ? 'header' : 'frame', codec };
  return { kind: 'frame', codec };
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  bit() {
    const index = this.pos >> 3;
    if (index >= this.bytes.length) throw new RangeError('SPS truncado');
    const value = (this.bytes[index] >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return value;
  }

  bits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 2 + this.bit();
    return value;
  }

  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new RangeError('SPS inválido');
    }
    return 2 ** zeros - 1 + (zeros ? this.bits(zeros) : 0);
  }

  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

function skipScalingList(reader, size) {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + reader.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/**
 * Extrae la resolución de un mensaje de vídeo con la configuración H.264
 * (AVCDecoderConfigurationRecord). Devuelve null si no se puede determinar.
 */
export function parseAvcResolution(payload) {
  try {
    // payload: [frame/códec][tipo de paquete][3 bytes de composición][registro...]
    if ((payload[0] & 0x8f) !== 0x07 || payload[1] !== 0 || payload.length < 16) return null;
    const record = payload.subarray(5);
    if ((record[5] & 0x1f) < 1) return null;
    const spsLength = record.readUInt16BE(6);
    const nal = record.subarray(8, 8 + spsLength);
    if (nal.length < 4) return null;

    // Quitar los bytes de prevención de emulación (00 00 03 -> 00 00).
    const rbsp = [];
    for (let i = 1; i < nal.length; i++) {
      if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
        rbsp.push(0, 0);
        i += 2;
      } else {
        rbsp.push(nal[i]);
      }
    }

    const r = new BitReader(rbsp);
    const profile = r.bits(8);
    r.bits(16); // restricciones + nivel
    r.ue(); // seq_parameter_set_id
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = r.ue();
      if (chroma === 3) r.bit();
      r.ue();
      r.ue();
      r.bit();
      if (r.bit()) {
        const lists = chroma !== 3 ? 8 : 12;
        for (let i = 0; i < lists; i++) {
          if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.bit();
      r.se();
      r.se();
      const cycle = r.ue();
      if (cycle > 255) return null;
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.bit();
    const widthMbs = r.ue() + 1;
    const heightUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (r.bit()) {
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }
    const unitX = chroma === 0 || chroma === 3 ? 1 : 2;
    const unitY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = widthMbs * 16 - unitX * (cropLeft + cropRight);
    const height = (2 - frameMbsOnly) * heightUnits * 16 - unitY * (cropTop + cropBottom);
    if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) return null;
    return { width, height };
  } catch {
    return null;
  }
}
