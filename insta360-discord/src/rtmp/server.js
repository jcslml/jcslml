// Servidor TCP que acepta conexiones RTMP y crea una sesión por cada una.

import net from 'node:net';
import { RtmpSession } from './session.js';

export class RtmpServer {
  /**
   * @param {object} options
   * @param {number} options.port
   * @param {string} [options.host]
   * @param {(info: object) => boolean} options.authorize
   * @param {object} options.handlers Se pasan tal cual a cada RtmpSession.
   * @param {number} [options.maxConnections]
   * @param {number} [options.publishTimeoutMs]
   * @param {number} [options.idleTimeoutMs]
   */
  constructor(options) {
    this.options = options;
    this.sessions = new Set();
    this.server = net.createServer((socket) => this._accept(socket));
    this.server.maxConnections = options.maxConnections ?? 16;
  }

  _accept(socket) {
    const { handlers } = this.options;
    const session = new RtmpSession(socket, {
      authorize: this.options.authorize,
      publishTimeoutMs: this.options.publishTimeoutMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
      handlers: {
        ...handlers,
        onClose: (s, reason) => {
          this.sessions.delete(s);
          handlers.onClose?.(s, reason);
        },
      },
    });
    this.sessions.add(session);
  }

  /** @returns {Promise<number>} El puerto en el que escucha. */
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host ?? '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve(this.server.address().port);
      });
    });
  }

  async close() {
    for (const session of [...this.sessions]) session.close('servidor detenido');
    await new Promise((resolve) => this.server.close(() => resolve()));
  }
}
