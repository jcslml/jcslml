// Reproductor del directo. Consulta el estado al servidor y, cuando hay señal,
// reproduce con el transporte más adecuado:
//   - baja latencia: FLV por WebSocket con mpegts.js (retardo de ~1 s);
//   - compatible: HLS (hls.js o el HLS nativo del navegador), más retardo pero
//     funciona en cualquier sitio.
// Si el modo de baja latencia falla, cambia solo al compatible.

/* global mpegts, Hls */

const POLL_MS = 2000;

export class LivePlayer extends EventTarget {
  /**
   * @param {object} options
   * @param {HTMLVideoElement} options.video
   * @param {string} options.base Ruta base de la señal, p. ej. "../m/<token>/".
   * @param {'auto' | 'hls'} [options.mode]
   */
  constructor({ video, base, mode = 'auto' }) {
    super();
    this.video = video;
    this.base = new URL(base.endsWith('/') ? base : `${base}/`, window.location.href);
    this.mode = mode;
    /** loading | offline | starting | playing | reconnecting | denied | unreachable | unsupported */
    this.phase = 'loading';
    this.status = null;
    this.transport = null;
    this.generation = -1;
    this.clockOffset = 0;

    this._stopped = true;
    this._timer = null;
    this._networkErrors = 0;
    this._flvFailures = 0;
    this._forcedHls = false;
    this._failed = null;
    this._gotFrame = false;
    this._startedAt = 0;
    this._lastTime = -1;
    this._stalls = 0;

    const onFrame = () => this._onFrame();
    video.addEventListener('playing', onFrame);
    video.addEventListener('timeupdate', onFrame);
    video.addEventListener('ended', () => this._transportEnded());
    video.addEventListener('error', () => {
      if (this.transport?.kind === 'native') this._transportFailed('native');
    });
  }

  static support() {
    let flv = false;
    try {
      flv = Boolean(window.mpegts && mpegts.getFeatureList().mseLivePlayback);
    } catch {
      flv = false;
    }
    const hlsJs = Boolean(window.Hls && Hls.isSupported());
    const nativeHls = document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
    return { flv, hlsJs, nativeHls, hls: hlsJs || nativeHls };
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._poll();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._teardown();
  }

  /** Cambia entre baja latencia ('auto') y compatible ('hls'). */
  setMode(mode) {
    this.mode = mode;
    this._forcedHls = false;
    this._flvFailures = 0;
    this._restart(0);
  }

  /** Transporte en uso: 'flv', 'hls', 'native' o null. */
  get kind() {
    return this.transport?.kind ?? null;
  }

  /** Milisegundos transcurridos desde el inicio del directo (según el reloj del servidor). */
  elapsedMs() {
    if (!this.status?.startedAt) return 0;
    return Math.max(0, Date.now() + this.clockOffset - this.status.startedAt);
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.dispatchEvent(new CustomEvent('phase', { detail: { phase } }));
  }

  _restart(delay) {
    this._teardown();
    this.generation = -1;
    clearTimeout(this._timer);
    if (!this._stopped) this._timer = setTimeout(() => this._poll(), delay);
  }

  async _poll() {
    clearTimeout(this._timer);
    if (this._stopped) return;
    try {
      const res = await fetch(new URL('status', this.base), { cache: 'no-store' });
      if (res.status === 403) {
        this._teardown();
        this._setPhase('denied');
        return; // quien usa el reproductor decide (p. ej. volver a autorizar)
      }
      if (!res.ok) throw new Error(`estado ${res.status}`);
      const status = await res.json();
      this.clockOffset = status.now - Date.now();
      this.status = status;
      this._networkErrors = 0;
      this.dispatchEvent(new CustomEvent('status', { detail: status }));
      this._reconcile();
    } catch {
      this._networkErrors += 1;
      if (this._networkErrors >= 3 && !this.transport) this._setPhase('unreachable');
    }
    if (!this._stopped) this._timer = setTimeout(() => this._poll(), POLL_MS);
  }

  _pick() {
    const support = LivePlayer.support();
    const wantsHls = this.mode === 'hls' || this._forcedHls;
    if (!wantsHls && support.flv) return 'flv';
    if (support.hls) return 'hls';
    return support.flv ? 'flv' : null;
  }

  _reconcile() {
    const status = this.status;
    if (!status.live) {
      this._failed = null;
      this._teardown();
      this._setPhase(status.state === 'reconnecting' ? 'reconnecting' : 'offline');
      return;
    }

    if (this._failed) {
      // Solo cuenta como fallo del modo de baja latencia si el directo seguía
      // ahí; si la cámara se cortó, no es culpa del transporte.
      if (this._failed.kind === 'flv' && this._failed.generation === status.generation) {
        this._flvFailures += 1;
        if (this._flvFailures >= 2 && this.mode === 'auto' && LivePlayer.support().hls) this._forcedHls = true;
      }
      this._failed = null;
    }

    if (this.transport && this.generation === status.generation) {
      this._watchdog();
      return;
    }

    const kind = this._pick();
    if (!kind) {
      this._setPhase('unsupported');
      return;
    }
    if (kind === 'hls' && !status.hls) {
      this._setPhase('starting'); // el servidor aún está preparando el modo compatible
      return;
    }
    this._teardown();
    this.generation = status.generation;
    this._gotFrame = false;
    this._startedAt = performance.now();
    this._lastTime = -1;
    this._stalls = 0;
    this._setPhase('starting');
    if (kind === 'flv') this._startFlv(status);
    else this._startHls();
  }

  /** Reinicia el transporte si la imagen lleva varios segundos sin avanzar. */
  _watchdog() {
    if (!this._gotFrame) {
      if (performance.now() - this._startedAt > 12_000) this._transportFailed(this.transport.kind);
      return;
    }
    const time = this.video.currentTime;
    if (time === this._lastTime && !this.video.paused) {
      this._stalls += 1;
      if (this._stalls >= 3) this._transportFailed(this.transport.kind);
    } else {
      this._stalls = 0;
    }
    this._lastTime = time;
  }

  _onFrame() {
    if (!this.transport || this.video.readyState < 2) return;
    if (!this._gotFrame) {
      this._gotFrame = true;
      if (this.transport.kind === 'flv') this._flvFailures = 0;
    }
    this._setPhase('playing');
  }

  _play() {
    const result = this.video.play();
    if (result?.catch) {
      result.catch((err) => {
        if (err?.name === 'NotAllowedError') this.dispatchEvent(new CustomEvent('blocked'));
      });
    }
  }

  _startFlv(status) {
    const url = new URL('live.flv', this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: url.href, hasAudio: status.hasAudio, hasVideo: status.hasVideo },
      {
        enableWorker: false,
        enableStashBuffer: false,
        lazyLoad: false,
        // Mantenerse cerca del directo: primero acelerando un poco la
        // reproducción y, si el retraso se dispara, saltando al presente.
        liveSync: true,
        liveSyncTargetLatency: 0.6,
        liveSyncMaxLatency: 1.4,
        liveSyncPlaybackRate: 1.15,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 4,
        liveBufferLatencyMinRemain: 0.6,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
      },
    );
    const transport = {
      kind: 'flv',
      destroy: () => {
        player.pause();
        player.unload();
        player.detachMediaElement();
        player.destroy();
      },
    };
    this.transport = transport;
    player.on(mpegts.Events.ERROR, () => {
      if (this.transport === transport) this._transportFailed('flv');
    });
    player.on(mpegts.Events.LOADING_COMPLETE, () => {
      if (this.transport === transport) this._transportEnded();
    });
    player.attachMediaElement(this.video);
    player.load();
    this._play();
  }

  _startHls() {
    const src = new URL('hls/index.m3u8', this.base).href;
    const support = LivePlayer.support();
    if (support.hlsJs) {
      const hls = new Hls({
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxLiveSyncPlaybackRate: 1.3,
        backBufferLength: 20,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 4,
      });
      const transport = { kind: 'hls', destroy: () => hls.destroy() };
      this.transport = transport;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && this.transport === transport) this._transportFailed('hls');
      });
      hls.loadSource(src);
      hls.attachMedia(this.video);
    } else {
      this.transport = { kind: 'native', destroy: () => {} };
      this.video.src = src;
    }
    this._play();
  }

  _teardown() {
    const transport = this.transport;
    this.transport = null;
    if (!transport) return;
    try {
      transport.destroy();
    } catch {
      // el reproductor ya estaba destruido
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  _transportFailed(kind) {
    if (!this.transport) return;
    this._failed = { kind, generation: this.generation };
    this._setPhase('starting');
    this._restart(700);
  }

  /** El servidor cerró la emisión (fin del directo o corte de la cámara). */
  _transportEnded() {
    if (!this.transport) return;
    this._restart(300);
  }
}

export function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Mensaje para cada fase, compartido por el visor y la Actividad. */
export function describePhase(phase) {
  switch (phase) {
    case 'loading':
      return { busy: true, title: 'Conectando…', text: '' };
    case 'offline':
      return { busy: false, title: 'La cámara no está emitiendo', text: 'Esta página se actualizará sola en cuanto empiece el directo.' };
    case 'starting':
      return { busy: true, title: 'Cargando el directo…', text: '' };
    case 'reconnecting':
      return { busy: true, title: 'Se ha perdido la señal', text: 'La cámara se ha desconectado. Esperando a que vuelva…' };
    case 'unreachable':
      return { busy: true, title: 'Sin conexión con el servidor', text: 'Reintentando…' };
    case 'unsupported':
      return { busy: false, title: 'Navegador no compatible', text: 'Este navegador no puede reproducir el directo. Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.' };
    case 'denied':
      return { busy: false, title: 'Enlace no válido', text: 'El enlace ha caducado o ha sido sustituido por otro. Pide uno nuevo.' };
    default:
      return null;
  }
}
