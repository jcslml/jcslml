// Cliente mínimo de webhooks de Discord: enviar, editar y borrar mensajes,
// con adjunto opcional y respeto de los límites de frecuencia (HTTP 429).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscordError extends Error {
  constructor(status, detail) {
    super(`Discord respondió ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
  }
}

/** Texto corto y legible a partir del cuerpo de error que devuelve Discord. */
function describe(body) {
  try {
    const data = JSON.parse(body);
    if (typeof data.message === 'string') return data.message;
  } catch {
    // cuerpo no JSON
  }
  return String(body).slice(0, 200);
}

export class WebhookClient {
  /** @param {string} url URL completa del webhook (puede llevar ?thread_id=...). */
  constructor(url) {
    const parsed = new URL(url);
    this.threadId = parsed.searchParams.get('thread_id');
    this.base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }

  _url(suffix = '', wait = false) {
    const url = new URL(this.base + suffix);
    if (wait) url.searchParams.set('wait', 'true');
    if (this.threadId) url.searchParams.set('thread_id', this.threadId);
    return url;
  }

  /**
   * @param {object} payload
   * @param {{ name: string, type: string, data: Buffer } | null} [file]
   * @returns {Promise<object>} El mensaje creado.
   */
  send(payload, file = null) {
    return this._request('POST', this._url('', true), payload, file);
  }

  edit(messageId, payload, file = null) {
    return this._request('PATCH', this._url(`/messages/${messageId}`), payload, file);
  }

  delete(messageId) {
    return this._request('DELETE', this._url(`/messages/${messageId}`), null, null);
  }

  async _request(method, url, payload, file) {
    for (let attempt = 0; ; attempt++) {
      const init = { method, signal: AbortSignal.timeout(20_000) };
      if (payload && file) {
        const form = new FormData();
        form.set('payload_json', JSON.stringify(payload));
        form.set('files[0]', new Blob([file.data], { type: file.type }), file.name);
        init.body = form;
      } else if (payload) {
        init.body = JSON.stringify(payload);
        init.headers = { 'content-type': 'application/json' };
      }
      const res = await fetch(url, init);
      if (res.status === 429 && attempt < 3) {
        const data = await res.json().catch(() => ({}));
        const seconds = Number(data.retry_after) || Number(res.headers.get('retry-after')) || 1;
        await sleep(Math.min(seconds * 1000 + 100, 15_000));
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      if (!res.ok) throw new DiscordError(res.status, describe(text));
      return text ? JSON.parse(text) : null;
    }
  }
}
