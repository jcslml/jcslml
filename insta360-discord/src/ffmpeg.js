// Localiza un binario de ffmpeg utilizable: el indicado por configuración, el que
// instala el paquete opcional `ffmpeg-static` o el que haya en el PATH.

import { execFile } from 'node:child_process';

function probe(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['-hide_banner', '-version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const match = /ffmpeg version (\S+)/.exec(String(stdout));
      resolve(match ? match[1] : 'desconocida');
    });
  });
}

/**
 * @param {string} [explicit] Ruta indicada por el usuario (FFMPEG_PATH).
 * @returns {Promise<{ path: string, version: string } | null>}
 */
export async function findFfmpeg(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  try {
    const mod = await import('ffmpeg-static');
    if (typeof mod.default === 'string') candidates.push(mod.default);
  } catch {
    // paquete opcional no instalado
  }
  candidates.push('ffmpeg');
  for (const candidate of candidates) {
    const version = await probe(candidate);
    if (version) return { path: candidate, version };
  }
  return null;
}
