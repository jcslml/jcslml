// Sigue el estado del directo de cara al público: cuándo empieza, cuándo se
// corta y cuándo se da por terminado. Si la cámara pierde la conexión y vuelve
// dentro del margen configurado, se considera el mismo directo.

import { EventEmitter } from 'node:events';

export class LiveTracker extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./hub.js').StreamHub} options.hub
   * @param {() => number} options.graceSeconds
   */
  constructor({ hub, graceSeconds }) {
    super();
    this.hub = hub;
    this.graceSeconds = graceSeconds;
    /** @type {'offline' | 'live' | 'reconnecting'} */
    this.state = 'offline';
    this.session = null;
    this._counter = 0;
    this._timer = null;

    hub.on('live', () => this._onLive());
    hub.on('offline', ({ wasLive }) => {
      if (wasLive) this._onDrop();
    });
  }

  _onLive() {
    if (this.state === 'reconnecting') {
      clearTimeout(this._timer);
      this.state = 'live';
      this.session.drops += 1;
      this.emit('resume', this.session);
      return;
    }
    this.session = { id: ++this._counter, startedAt: Date.now(), endedAt: null, drops: 0 };
    this.state = 'live';
    this.emit('start', this.session);
  }

  _onDrop() {
    if (this.state !== 'live') return;
    this.state = 'reconnecting';
    this.session.droppedAt = Date.now();
    this.emit('drop', this.session);
    const grace = Math.max(0, this.graceSeconds()) * 1000;
    this._timer = setTimeout(() => this._finish(), grace);
    this._timer.unref?.();
  }

  _finish() {
    if (this.state !== 'reconnecting') return;
    const session = this.session;
    // El directo terminó de verdad cuando se cortó la señal, no al agotar el margen.
    session.endedAt = session.droppedAt ?? Date.now();
    this.state = 'offline';
    this.emit('end', session);
  }

  /** Da por terminado el directo sin esperar al margen (al apagar el servidor). */
  finishNow() {
    clearTimeout(this._timer);
    if (this.state === 'live') {
      this.session.droppedAt = Date.now();
      this.state = 'reconnecting';
    }
    this._finish();
  }
}
