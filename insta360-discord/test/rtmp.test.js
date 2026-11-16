// Protocolo RTMP: códec AMF0 y lectura de chunks con un cliente de pruebas que
// fuerza los casos difíciles (trozos pequeños, marcas extendidas, TCP fragmentado).

import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import * as amf from '../src/rtmp/amf0.js';
import { RtmpServer } from '../src/rtmp/server.js';
import { classifyVideo, flvTag, parseAvcResolution } from '../src/flv.js';
import { sleep, waitFor } from './helpers.js';

test('AMF0: codifica y decodifica', () => {
  const buf = amf.encode('connect', 1, { app: 'live', n: 2.5, ok: true, nada: null }, undefined, [1, 'x']);
  const { values } = amf.decodeAll(buf);
  assert.equal(values[0], 'connect');
  assert.equal(values[1], 1);
  assert.deepEqual({ ...values[2] }, { app: 'live', n: 2.5, ok: true, nada: null });
  assert.equal(values[3], undefined);
  assert.deepEqual(values[4], [1, 'x']);
});

test('AMF0: rechaza datos truncados o demasiado anidados', () => {
  const buf = amf.encode('hola', { a: { b: 1 } });
  assert.throws(() => amf.decodeAll(buf.subarray(0, buf.length - 8)), amf.AmfError);
  let deep = Buffer.from([0x05]);
  for (let i = 0; i < 40; i++) deep = Buffer.concat([Buffer.from([0x03, 0, 1, 0x61]), deep, Buffer.from([0, 0, 9])]);
  assert.throws(() => amf.decodeAll(deep), amf.AmfError);
});

test('FLV: clasifica vídeo y construye etiquetas', () => {
  assert.equal(classifyVideo(Buffer.from([0x17, 0x00, 0, 0, 0])).kind, 'header');
  assert.equal(classifyVideo(Buffer.from([0x17, 0x01, 0, 0, 0])).kind, 'key');
  assert.equal(classifyVideo(Buffer.from([0x27, 0x01, 0, 0, 0])).kind, 'inter');
  assert.equal(classifyVideo(Buffer.from([0x90, 0x68, 0x76, 0x63, 0x31])).kind, 'header'); // enhanced, hvc1
  const tag = flvTag(9, 0x01020304, Buffer.from([1, 2, 3]));
  assert.equal(tag.length, 11 + 3 + 4);
  assert.equal(tag.readUIntBE(4, 3), 0x020304);
  assert.equal(tag[7], 0x01);
  assert.equal(tag.readUInt32BE(14), 14);
  assert.equal(parseAvcResolution(Buffer.from([0x17, 0, 0, 0, 0, 1])), null);
});

/** Cliente RTMP mínimo que deja elegir tamaño de chunk y cómo se trocea el envío. */
function chunked(csid, type, streamId, timestamp, payload, chunkSize, { fmt = 0, delta = 0 } = {}) {
  const parts = [];
  const ext = (fmt === 0 ? timestamp : delta) >= 0xffffff;
  const field = ext ? 0xffffff : fmt === 0 ? timestamp : delta;
  const head = [Buffer.from([(fmt << 6) | csid])];
  if (fmt <= 2) { const b = Buffer.alloc(3); b.writeUIntBE(field, 0, 3); head.push(b); }
  if (fmt <= 1) { const b = Buffer.alloc(4); b.writeUIntBE(payload.length, 0, 3); b[3] = type; head.push(b); }
  if (fmt === 0) { const b = Buffer.alloc(4); b.writeUInt32LE(streamId); head.push(b); }
  const extBuf = Buffer.alloc(4);
  extBuf.writeUInt32BE(fmt === 0 ? timestamp : delta);
  if (ext) head.push(extBuf);
  parts.push(...head);
  for (let off = 0; off < payload.length; off += chunkSize) {
    if (off > 0) {
      parts.push(Buffer.from([0xc0 | csid]));
      if (ext) parts.push(extBuf);
    }
    parts.push(payload.subarray(off, off + chunkSize));
  }
  return Buffer.concat(parts);
}

async function runClient(port, { pieces, key = 'clave' }) {
  const received = [];
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.on('data', () => {});
  socket.on('error', () => {});
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const video = (first, n) => Buffer.concat([Buffer.from([first, 1, 0, 0, 0]), Buffer.alloc(n, n & 0xff)]);
  const stream = Buffer.concat([
    Buffer.from([3]), Buffer.alloc(1536, 7), Buffer.alloc(1536, 9), // C0 C1 C2 (handshake simple)
    chunked(2, 1, 0, 0, u32(64), 128), // Set Chunk Size 64
    chunked(3, 20, 0, 0, amf.encode('connect', 1, { app: 'live', tcUrl: 'rtmp://x/live' }), 64),
    chunked(3, 20, 0, 0, amf.encode('createStream', 2, null), 64),
    chunked(3, 17, 1, 0, Buffer.concat([Buffer.from([0]), amf.encode('publish', 3, null, key, 'live')]), 64), // AMF3
    chunked(4, 18, 1, 0, amf.encode('@setDataFrame', 'onMetaData', { width: 640, height: 360 }), 64),
    chunked(6, 9, 1, 1000, video(0x17, 300), 64), // fmt 0, varios chunks
    chunked(6, 9, 1, 0, video(0x27, 300), 64, { fmt: 1, delta: 40 }), // → 1040
    chunked(6, 9, 1, 0, video(0x27, 300), 64, { fmt: 3 }), // misma cabecera → 1080
    chunked(6, 9, 1, 0, video(0x27, 10), 64, { fmt: 1, delta: 0x1000000 }), // incremento extendido
    chunked(7, 8, 1, 0x01000000 + 5, Buffer.from([0xaf, 1, 1, 2, 3]), 3), // marca extendida + chunks de 3 bytes
  ]);
  for (const piece of pieces(stream)) {
    socket.write(piece);
    await sleep(1);
  }
  return { socket, received };
}

for (const [name, pieces] of [
  ['de una vez', (s) => [s]],
  ['byte a byte', (s) => Array.from(s, (_, i) => s.subarray(i, i + 1))],
  ['en trozos irregulares', (s) => {
    const out = [];
    for (let i = 0, n = 1; i < s.length; i += n, n = (n * 7 + 3) % 97 + 1) out.push(s.subarray(i, i + n));
    return out;
  }],
]) {
  test(`RTMP: recompone los mensajes enviando ${name}`, async () => {
    const media = [];
    let meta = null;
    const server = new RtmpServer({
      port: 0, host: '127.0.0.1',
      authorize: (r) => r.app === 'live' && r.name === 'clave',
      handlers: {
        onMedia: (_s, type, ts, payload) => media.push({ type, ts, size: payload.length, first: payload[0] }),
        onMetadata: (_s, _ts, _body, m) => { meta = { ...m }; },
      },
    });
    const port = await server.listen();
    const { socket } = await runClient(port, { pieces });
    await waitFor(() => media.length === 5, 8000, 'cinco mensajes');
    assert.deepEqual(meta, { width: 640, height: 360 });
    assert.deepEqual(media, [
      { type: 9, ts: 1000, size: 305, first: 0x17 },
      { type: 9, ts: 1040, size: 305, first: 0x27 },
      { type: 9, ts: 1080, size: 305, first: 0x27 },
      { type: 9, ts: 1080 + 0x1000000, size: 15, first: 0x27 },
      { type: 8, ts: 0x01000005, size: 5, first: 0xaf },
    ]);
    socket.destroy();
    await server.close();
  });
}

test('RTMP: rechaza claves incorrectas, basura y mensajes enormes sin autenticar', async () => {
  const closed = [];
  const server = new RtmpServer({
    port: 0, host: '127.0.0.1',
    authorize: () => false,
    handlers: { onClose: (_s, reason) => closed.push(reason) },
  });
  const port = await server.listen();
  await runClient(port, { pieces: (s) => [s], key: 'otra' });
  await waitFor(() => closed.includes('clave de emisión incorrecta'), 5000, 'rechazo por clave');

  const http = net.connect(port, '127.0.0.1');
  http.on('error', () => {});
  http.write('GET / HTTP/1.1\r\n\r\n');
  await waitFor(() => closed.some((r) => r.includes('HTTP')), 5000, 'rechazo de HTTP');

  const big = net.connect(port, '127.0.0.1');
  big.on('error', () => {});
  big.write(Buffer.concat([Buffer.from([3]), Buffer.alloc(3072), chunked(3, 20, 0, 0, Buffer.alloc(200_000), 128).subarray(0, 64)]));
  await waitFor(() => closed.some((r) => r.includes('demasiado grande')), 5000, 'rechazo por tamaño');
  await server.close();
});
