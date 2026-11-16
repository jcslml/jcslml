// Escenario del directo: vídeo a pantalla completa con rótulos y controles.
// Lo comparten el visor web y la Actividad de Discord.

import { icon } from './icons.js';
import { LivePlayer, describePhase, formatClock } from './player.js';

const TEMPLATE = `
  <video playsinline muted autoplay></video>
  <img class="still" data-ref="still" alt="" hidden>
  <div class="message" data-ref="message">
    <div class="inner">
      <div data-ref="indicator"></div>
      <h1 data-ref="heading"></h1>
      <p data-ref="detail"></p>
      <div data-ref="extra"></div>
    </div>
  </div>
  <div class="bar top">
    <span class="badge" data-ref="badge">Sin señal</span>
    <span class="title" data-ref="title"></span>
    <span class="spacer"></span>
    <span class="clock" data-ref="clock"></span>
  </div>
  <div class="bar bottom">
    <button class="btn primary" type="button" data-ref="sound" hidden></button>
    <span class="spacer"></span>
    <span class="stats" data-ref="stats"></span>
    <button class="btn small" type="button" data-ref="mode" hidden></button>
    <button class="btn icon-only" type="button" data-ref="pip" title="Imagen en ventana flotante" aria-label="Imagen en ventana flotante" hidden>${icon('pip')}</button>
    <button class="btn icon-only" type="button" data-ref="fullscreen" title="Pantalla completa (F)" aria-label="Pantalla completa" hidden>${icon('maximize')}</button>
  </div>
`;

const MODE_KEY = 'puente.modo';

function storedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'hls' ? 'hls' : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Monta el escenario dentro de `root` y arranca el reproductor.
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {string} options.base Ruta base de la señal (termina en "/").
 * @param {boolean} [options.fullscreen] Mostrar el botón de pantalla completa.
 * @param {(player: LivePlayer) => void} [options.onDenied] Se llama si el servidor rechaza el acceso.
 * @returns {LivePlayer}
 */
export function mountStage({ root, base, fullscreen = true, onDenied }) {
  root.classList.add('stage');
  root.innerHTML = TEMPLATE;
  const ref = {};
  for (const el of root.querySelectorAll('[data-ref]')) ref[el.dataset.ref] = el;
  const video = root.querySelector('video');
  const player = new LivePlayer({ video, base, image: ref.still, mode: storedMode() });
  const support = LivePlayer.support();

  // ---------------------------------------------------------------- mensajes
  function showMessage(info, extra = null) {
    ref.message.hidden = false;
    ref.indicator.className = info.busy ? 'spinner' : 'dot-wait';
    ref.heading.textContent = info.title;
    ref.detail.textContent = info.text;
    ref.detail.hidden = !info.text;
    ref.extra.replaceChildren(...(extra ? [extra] : []));
  }

  let blocked = false; // el navegador impidió la reproducción automática

  function render() {
    const phase = player.phase;
    const status = player.status;
    if (phase === 'playing') {
      blocked = false;
      ref.message.hidden = true;
    } else if (!(blocked && phase === 'starting')) {
      blocked = false;
      const info = describePhase(phase);
      if (info) showMessage(info);
    }
    const live = phase === 'playing' || phase === 'starting';
    ref.badge.className = `badge${live ? ' live' : phase === 'reconnecting' ? ' wait' : ''}`;
    ref.badge.textContent = live ? 'En directo' : phase === 'reconnecting' ? 'Reconectando' : 'Sin señal';
    if (status?.title) {
      ref.title.textContent = status.title;
      document.title = `${live ? '🔴 ' : ''}${status.title}`;
    }
    const stills = player.kind === 'images';
    ref.still.hidden = !(stills && phase === 'playing');
    ref.sound.hidden = !(phase === 'playing' && status?.hasAudio && !stills);
    renderMode();
    if (phase !== 'playing') setIdle(false);
  }

  // ------------------------------------------------------------------ sonido
  function renderSound() {
    if (video.muted) {
      ref.sound.className = 'btn primary';
      ref.sound.innerHTML = `${icon('mute')}<span>Activar sonido</span>`;
      ref.sound.setAttribute('aria-label', 'Activar sonido');
    } else {
      ref.sound.className = 'btn icon-only';
      ref.sound.innerHTML = icon('volume');
      ref.sound.setAttribute('aria-label', 'Silenciar');
    }
    ref.sound.title = video.muted ? 'Activar sonido (M)' : 'Silenciar (M)';
  }
  function toggleSound() {
    video.muted = !video.muted;
    if (!video.muted && video.paused) video.play().catch(() => {});
    renderSound();
  }
  ref.sound.addEventListener('click', toggleSound);
  video.addEventListener('volumechange', renderSound);
  renderSound();

  // -------------------------------------------------------------------- modo
  function renderMode() {
    const stills = player.kind === 'images';
    const both = support.flv && support.hls;
    ref.mode.hidden = !(both || stills) || !player.status?.live;
    if (stills) {
      ref.mode.innerHTML = `${icon('refresh')}<span>Solo imágenes</span>`;
      ref.mode.title = 'El navegador no ha podido reproducir el vídeo: se muestra una imagen cada 2 segundos. Pulsa para volver a intentarlo.';
      return;
    }
    const low = player.kind ? player.kind === 'flv' : player.mode !== 'hls';
    ref.mode.innerHTML = `${icon(low ? 'zap' : 'layers')}<span>${low ? 'Baja latencia' : 'Compatible'}</span>`;
    ref.mode.title = low
      ? 'Modo de baja latencia (≈1 s de retraso). Pulsa para cambiar al modo compatible si la imagen se corta.'
      : 'Modo compatible (varios segundos de retraso). Pulsa para volver a baja latencia.';
  }
  ref.mode.addEventListener('click', () => {
    const low = player.kind === 'flv' || (!player.kind && player.mode !== 'hls');
    const next = player.kind === 'images' ? 'auto' : low ? 'hls' : 'auto';
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // almacenamiento no disponible (modo privado o iframe restringido)
    }
    player.setMode(next);
    render();
  });

  // ------------------------------------------- pantalla completa y flotante
  const canFullscreen = fullscreen && Boolean(root.requestFullscreen || video.webkitEnterFullscreen);
  ref.fullscreen.hidden = !canFullscreen;
  function toggleFullscreen() {
    if (!canFullscreen) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else video.webkitEnterFullscreen();
  }
  ref.fullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    ref.fullscreen.innerHTML = icon(document.fullscreenElement ? 'minimize' : 'maximize');
  });
  video.addEventListener('dblclick', toggleFullscreen);

  const canPip = Boolean(document.pictureInPictureEnabled && video.requestPictureInPicture);
  ref.pip.hidden = !canPip;
  ref.pip.addEventListener('click', () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture().catch(() => {});
  });

  // ------------------------------------- ocultar controles tras inactividad
  let idleTimer = null;
  function setIdle(idle) {
    root.classList.toggle('idle', idle);
  }
  function wake() {
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (player.phase === 'playing' && !root.matches(':focus-within')) setIdle(true);
    }, 3500);
  }
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
    root.addEventListener(type, wake, { passive: true });
  }

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'f' || event.key === 'F') toggleFullscreen();
    if ((event.key === 'm' || event.key === 'M') && !ref.sound.hidden) toggleSound();
  });

  // ---------------------------------------------------- reloj y resolución
  setInterval(() => {
    const status = player.status;
    const running = status?.startedAt && player.phase !== 'offline';
    ref.clock.textContent = running ? formatClock(player.elapsedMs()) : '';
    if (player.phase !== 'playing') ref.stats.textContent = '';
    else if (player.kind === 'images') ref.stats.textContent = 'una imagen cada 2 s';
    else ref.stats.textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '';
  }, 500);

  // ------------------------------------------------------------------ eventos
  player.addEventListener('phase', () => {
    render();
    if (player.phase === 'playing') wake();
    if (player.phase === 'denied') onDenied?.(player);
  });
  player.addEventListener('status', render);
  player.addEventListener('blocked', () => {
    blocked = true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn primary';
    button.innerHTML = `${icon('play')}<span>Reproducir</span>`;
    button.addEventListener('click', () => video.play().catch(() => {}));
    showMessage({ busy: false, title: 'Pulsa para ver el directo', text: 'El navegador ha bloqueado la reproducción automática.' }, button);
  });

  render();
  player.start();
  return Object.assign(player, { showMessage });
}
