// Códec AMF0 mínimo: solo lo que necesita un servidor RTMP que recibe una emisión.
// Todas las lecturas comprueban límites, porque el puerto RTMP queda expuesto a Internet.

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

export class AmfError extends Error {}

function need(pos, n, end) {
  if (pos + n > end) throw new AmfError('AMF0 truncado');
}

function readString(buf, pos, len, end) {
  need(pos, len, end);
  return buf.toString('utf8', pos, pos + len);
}

/** Lee pares clave/valor hasta el marcador de fin de objeto (00 00 09). */
function decodeProperties(buf, pos, end, depth) {
  const obj = Object.create(null);
  let count = 0;
  for (;;) {
    // Algunos codificadores omiten el marcador final en los arrays ECMA.
    if (pos >= end) break;
    need(pos, 2, end);
    const len = buf.readUInt16BE(pos);
    pos += 2;
    if (len === 0) {
      need(pos, 1, end);
      if (buf[pos] !== 0x09) throw new AmfError('fin de objeto AMF0 inválido');
      pos += 1;
      break;
    }
    const key = readString(buf, pos, len, end);
    pos += len;
    const r = decodeValue(buf, pos, end, depth + 1);
    pos = r.pos;
    if (++count > MAX_ITEMS) throw new AmfError('objeto AMF0 demasiado grande');
    obj[key] = r.value;
  }
  return { value: obj, pos };
}

function decodeValue(buf, pos, end, depth) {
  if (depth > MAX_DEPTH) throw new AmfError('AMF0 demasiado anidado');
  need(pos, 1, end);
  const type = buf[pos++];
  switch (type) {
    case 0x00: // número
      need(pos, 8, end);
      return { value: buf.readDoubleBE(pos), pos: pos + 8 };
    case 0x01: // booleano
      need(pos, 1, end);
      return { value: buf[pos] !== 0, pos: pos + 1 };
    case 0x02: { // cadena
      need(pos, 2, end);
      const len = buf.readUInt16BE(pos);
      return { value: readString(buf, pos + 2, len, end), pos: pos + 2 + len };
    }
    case 0x03: // objeto
      return decodeProperties(buf, pos, end, depth);
    case 0x05: // null
      return { value: null, pos };
    case 0x06: // undefined
      return { value: undefined, pos };
    case 0x07: // referencia (no se resuelve)
      need(pos, 2, end);
      return { value: null, pos: pos + 2 };
    case 0x08: // array ECMA: contador (orientativo) + propiedades
      need(pos, 4, end);
      return decodeProperties(buf, pos + 4, end, depth);
    case 0x0a: { // array estricto
      need(pos, 4, end);
      const count = buf.readUInt32BE(pos);
      pos += 4;
      if (count > MAX_ITEMS) throw new AmfError('array AMF0 demasiado grande');
      const arr = [];
      for (let i = 0; i < count; i++) {
        const r = decodeValue(buf, pos, end, depth + 1);
        arr.push(r.value);
        pos = r.pos;
      }
      return { value: arr, pos };
    }
    case 0x0b: // fecha: double + zona horaria (2 bytes)
      need(pos, 10, end);
      return { value: buf.readDoubleBE(pos), pos: pos + 10 };
    case 0x0c: // cadena larga
    case 0x0f: { // documento XML
      need(pos, 4, end);
      const len = buf.readUInt32BE(pos);
      return { value: readString(buf, pos + 4, len, end), pos: pos + 4 + len };
    }
    case 0x0d: // no soportado
      return { value: undefined, pos };
    case 0x10: { // objeto con nombre de clase
      need(pos, 2, end);
      const len = buf.readUInt16BE(pos);
      need(pos + 2, len, end);
      return decodeProperties(buf, pos + 2 + len, end, depth);
    }
    default:
      throw new AmfError(`tipo AMF0 desconocido 0x${type.toString(16)}`);
  }
}

/**
 * Decodifica todos los valores AMF0 consecutivos de un búfer.
 * `offsets[i]` es la posición donde empieza `values[i]`.
 */
export function decodeAll(buf, start = 0, end = buf.length) {
  const values = [];
  const offsets = [];
  let pos = start;
  while (pos < end) {
    if (buf[pos] === 0x11) break; // cambio a AMF3: no se interpreta
    offsets.push(pos);
    const r = decodeValue(buf, pos, end, 0);
    values.push(r.value);
    pos = r.pos;
    if (values.length > MAX_ITEMS) throw new AmfError('demasiados valores AMF0');
  }
  return { values, offsets, end: pos };
}

function encodeString(str) {
  const data = Buffer.from(String(str), 'utf8');
  if (data.length > 0xffff) {
    const out = Buffer.allocUnsafe(5 + data.length);
    out[0] = 0x0c;
    out.writeUInt32BE(data.length, 1);
    data.copy(out, 5);
    return out;
  }
  const out = Buffer.allocUnsafe(3 + data.length);
  out[0] = 0x02;
  out.writeUInt16BE(data.length, 1);
  data.copy(out, 3);
  return out;
}

function encodeKey(key) {
  const data = Buffer.from(String(key), 'utf8').subarray(0, 0xffff);
  const out = Buffer.allocUnsafe(2 + data.length);
  out.writeUInt16BE(data.length, 0);
  data.copy(out, 2);
  return out;
}

function encodeValue(value) {
  if (value === null) return Buffer.from([0x05]);
  if (value === undefined) return Buffer.from([0x06]);
  switch (typeof value) {
    case 'number': {
      const out = Buffer.allocUnsafe(9);
      out[0] = 0x00;
      out.writeDoubleBE(value, 1);
      return out;
    }
    case 'boolean':
      return Buffer.from([0x01, value ? 1 : 0]);
    case 'string':
      return encodeString(value);
    case 'object': {
      if (Array.isArray(value)) {
        const head = Buffer.allocUnsafe(5);
        head[0] = 0x0a;
        head.writeUInt32BE(value.length, 1);
        return Buffer.concat([head, ...value.map(encodeValue)]);
      }
      const parts = [Buffer.from([0x03])];
      for (const [k, v] of Object.entries(value)) {
        parts.push(encodeKey(k), encodeValue(v));
      }
      parts.push(Buffer.from([0x00, 0x00, 0x09]));
      return Buffer.concat(parts);
    }
    default:
      throw new AmfError(`no se puede codificar ${typeof value} en AMF0`);
  }
}

/** Codifica una secuencia de valores AMF0. */
export function encode(...values) {
  return Buffer.concat(values.map(encodeValue));
}
