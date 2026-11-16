// Avisos en Discord mediante un webhook: publica un mensaje cuando empieza el
// directo, renueva la miniatura cada cierto tiempo y lo marca como finalizado.

import { WebhookClient } from './webhook.js';

const COLOR_LIVE = 0xed4245;
const COLOR_ENDED = 0x4f545c;
const IMAGE_NAME = 'directo.jpg';

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

function allowedMentions(mention) {
  if (mention === '@everyone' || mention === '@here') return { parse: ['everyone'] };
  const role = /^<@&(\d+)>$/.exec(mention);
  if (role) return { parse: [], roles: [role[1]] };
  return { parse: [] };
}

const fileOf = (image) => (image ? { name: IMAGE_NAME, type: 'image/jpeg', data: image } : null);

export class Announcer {
  /**
   * @param {object} options
   * @param {import('../config.js').Config} options.config
   * @param {import('../live.js').LiveTracker} options.tracker
   * @param {import('../pipeline.js').MediaPipeline} options.pipeline
   * @param {() => { viewerUrl: string | null, activityEnabled: boolean }} options.links
   * @param {(level: string, message: string) => void} options.log
   */
  constructor({ config, tracker, pipeline, links, log }) {
    this.config = config;
    this.tracker = tracker;
    this.pipeline = pipeline;
    this.links = links;
    this.log = log;
    this.current = null;
    this.lastError = null;
    this.lastOkAt = null;
    this._queue = Promise.resolve();
    this._timer = null;

    tracker.on('start', (session) => this._enqueue(() => this._announce(session)));
    tracker.on('resume', (session) => {
      if (!this.current) this._enqueue(() => this._announce(session));
    });
    tracker.on('end', (session) => this._enqueue(() => this._finish(session)));
  }

  /** Las operaciones van en cola para que no se pisen (p. ej. aviso y cierre). */
  _enqueue(task) {
    this._queue = this._queue.then(task).then(
      () => {},
      (err) => {
        this.lastError = { at: Date.now(), message: err.message };
        this.log('warn', `Aviso de Discord: ${err.message}`);
      },
    );
    return this._queue;
  }

  _livePayload(session, { newImage, hasImage }) {
    const title = this.config.get('title');
    const mention = this.config.get('mention');
    const { viewerUrl, activityEnabled } = this.links();
    const lines = [];
    if (viewerUrl) lines.push(`**[▶ Ver el directo](${viewerUrl})**`);
    if (activityEnabled) lines.push('También dentro de Discord: entra al canal de voz y abre la actividad del directo.');
    const embed = {
      title: `🔴 EN DIRECTO · ${title}`,
      description: lines.join('\n') || 'La cámara está emitiendo.',
      color: COLOR_LIVE,
      fields: [{ name: 'Empezó', value: `<t:${Math.floor(session.startedAt / 1000)}:R>`, inline: true }],
      footer: { text: hasImage ? 'Imagen actualizada' : 'Directo en curso' },
      timestamp: new Date().toISOString(),
    };
    if (viewerUrl) embed.url = viewerUrl;
    if (hasImage) embed.image = { url: `attachment://${IMAGE_NAME}` };
    const payload = {
      content: `${mention ? `${mention} ` : ''}🔴 **${title}** está en directo`,
      allowed_mentions: allowedMentions(mention),
      embeds: [embed],
    };
    // Sin imagen nueva no se toca la lista de adjuntos: se conserva la anterior.
    if (newImage) payload.attachments = [{ id: 0, filename: IMAGE_NAME }];
    return payload;
  }

  _endedPayload(session, keepImage) {
    const title = this.config.get('title');
    const embed = {
      title: `⚫ Directo finalizado · ${title}`,
      description: `Duró ${formatDuration(session.endedAt - session.startedAt)}.`,
      color: COLOR_ENDED,
      timestamp: new Date(session.endedAt).toISOString(),
    };
    const payload = {
      content: `⚫ **${title}**: el directo ha terminado`,
      allowed_mentions: { parse: [] },
      embeds: [embed],
    };
    if (keepImage) embed.image = { url: `attachment://${IMAGE_NAME}` };
    else payload.attachments = [];
    return payload;
  }

  async _announce(session) {
    const url = this.config.get('webhookUrl');
    if (!url || this.current) return;
    const image = await this.pipeline.waitForSnapshot(6000);
    // Si mientras tanto se cortó, se anunciará cuando vuelva (o nunca, si era un amago).
    if (this.tracker.session !== session || this.tracker.state !== 'live') return;
    const client = new WebhookClient(url);
    const message = await client.send(
      this._livePayload(session, { newImage: Boolean(image), hasImage: Boolean(image) }),
      fileOf(image),
    );
    this.current = { session, client, messageId: message.id, lastImage: image };
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.log('info', 'Aviso de directo publicado en Discord.');
    this._scheduleUpdate();
  }

  _scheduleUpdate() {
    clearTimeout(this._timer);
    const seconds = this.config.get('updateSeconds');
    if (!seconds || !this.current) return;
    this._timer = setTimeout(() => this._enqueue(() => this._update()), seconds * 1000);
    this._timer.unref?.();
  }

  async _update() {
    const current = this.current;
    if (!current) return;
    try {
      if (this.tracker.state === 'live') {
        const image = await this.pipeline.snapshot();
        if (image) current.lastImage = image;
        await current.client.edit(
          current.messageId,
          this._livePayload(current.session, { newImage: Boolean(image), hasImage: Boolean(current.lastImage) }),
          fileOf(image),
        );
        this.lastOkAt = Date.now();
        this.lastError = null;
      }
    } catch (err) {
      if (err.status === 404) {
        // Alguien borró el aviso: se respeta y no se vuelve a publicar.
        this.current = null;
        this.log('info', 'El aviso de Discord fue borrado; no se actualizará más.');
        return;
      }
      throw err;
    } finally {
      this._scheduleUpdate();
    }
  }

  async _finish(session) {
    clearTimeout(this._timer);
    const current = this.current;
    if (!current || current.session !== session) return;
    this.current = null;
    const keepImage = Boolean(this.config.get('keepLastImage') && current.lastImage);
    try {
      await current.client.edit(current.messageId, this._endedPayload(session, keepImage));
      this.lastOkAt = Date.now();
      this.log('info', 'Aviso de Discord actualizado: directo finalizado.');
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  /** Envía un mensaje de prueba al webhook configurado (botón del panel). */
  async sendTest() {
    const url = this.config.get('webhookUrl');
    if (!url) throw new Error('No hay ningún webhook configurado.');
    const client = new WebhookClient(url);
    await client.send({
      content: '✅ Prueba del puente de directo: los avisos llegarán a este canal.',
      allowed_mentions: { parse: [] },
    });
    this.lastOkAt = Date.now();
    this.lastError = null;
  }

  /** Espera a que termine lo que haya en cola (para un apagado ordenado). */
  async flush() {
    clearTimeout(this._timer);
    await this._queue;
  }
}
