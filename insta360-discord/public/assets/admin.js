// Panel de control: estado del directo, datos para la cámara y ajustes de Discord.

import { LivePlayer, formatClock } from './player.js';

const $ = (id) => document.getElementById(id);

async function api(route, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`api/admin/${route}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

let state = null;
let player = null;
let playerToken = null;
let formsFilled = false;

// ------------------------------------------------------------------ utilidades

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Sin HTTPS el portapapeles moderno no está disponible: método clásico.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copiado');
}

function ago(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.round(minutes / 60)} h`;
}

function formatBitrate(kbps) {
  if (!kbps) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1).replace('.', ',')} Mb/s` : `${kbps} kb/s`;
}

function setResult(form, text, ok) {
  const el = form.querySelector('[data-result]');
  if (!el) return;
  el.textContent = text;
  el.className = `note ${ok ? 'ok' : 'bad'}`;
  if (ok) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, 3000);
  }
}

// --------------------------------------------------------------- formularios

const FORMS = {
  'form-network': ['publicUrl', 'rtmpPublicUrl'],
  'form-webhook': ['webhookUrl', 'title', 'mention', 'updateSeconds', 'keepLastImage'],
  'form-activity': ['discordClientId', 'discordClientSecret', 'discordGuildIds'],
  'form-settings': ['graceSeconds'],
};

function fillForms() {
  const config = state.config;
  for (const fields of Object.values(FORMS)) {
    for (const name of fields) {
      const input = $(name);
      if (name === 'discordClientSecret') {
        input.value = '';
        input.placeholder = config.discordClientSecretSet ? '•••••••• (guardado)' : '';
      } else if (input.type === 'checkbox') {
        input.checked = Boolean(config[name]);
      } else if (name === 'updateSeconds') {
        const value = String(config[name]);
        if (![...input.options].some((option) => option.value === value)) {
          input.add(new Option(`Cada ${value} segundos`, value));
        }
        input.value = value;
      } else {
        input.value = config[name] ?? '';
      }
      const locked = state.locked.includes(name);
      input.disabled = locked;
      if (locked) input.title = 'Fijado por una variable de entorno; no se puede cambiar desde el panel.';
    }
  }
  $('secret-hint').textContent = config.discordClientSecretSet
    ? 'Ya hay un secreto guardado. Déjalo vacío para conservarlo o escribe otro para sustituirlo.'
    : 'Está en la pestaña OAuth2 de tu aplicación de Discord.';
  formsFilled = true;
}

for (const [id, fields] of Object.entries(FORMS)) {
  const form = $(id);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const patch = {};
    for (const name of fields) {
      const input = $(name);
      if (input.disabled) continue;
      if (name === 'discordClientSecret' && input.value === '') continue; // conservar el guardado
      patch[name] = input.type === 'checkbox' ? input.checked : input.value;
    }
    try {
      state = await api('config', patch);
      fillForms();
      render();
      setResult(form, 'Guardado', true);
    } catch (error) {
      setResult(form, error.message, false);
    }
  });
}

// -------------------------------------------------------------------- pintado

function renderStream() {
  const stream = state.stream;
  const pill = $('state-pill');
  const text = $('state-text');
  if (stream.state === 'live') {
    pill.className = 'pill live';
    pill.textContent = 'En directo';
    text.textContent = 'La cámara está emitiendo y el directo se puede ver.';
  } else if (stream.state === 'reconnecting') {
    pill.className = 'pill wait';
    pill.textContent = 'Reconectando';
    text.textContent = 'Se ha perdido la señal. Se espera a que la cámara vuelva antes de dar el directo por terminado.';
  } else if (stream.receiving) {
    pill.className = 'pill wait';
    pill.textContent = 'Conectando';
    text.textContent = 'La cámara se ha conectado; esperando la primera imagen.';
  } else {
    pill.className = 'pill';
    pill.textContent = 'Sin señal';
    text.textContent = 'Esperando a que la cámara empiece a emitir.';
  }

  const live = stream.live;
  $('fact-video').textContent = live && stream.width
    ? `${stream.width}×${stream.height} · ${Math.round(stream.fps)} fps · ${stream.videoCodec}`
    : '—';
  $('fact-bitrate').textContent = live ? formatBitrate(stream.bitrateKbps) : '—';
  $('fact-audio').textContent = live ? (stream.hasAudio ? stream.audioCodec || 'Sí' : 'Sin sonido') : '—';
  const viewers = stream.viewers.lowLatency + stream.viewers.hls;
  $('fact-viewers').textContent = live ? String(Math.max(0, viewers - (player?.kind ? 1 : 0))) : '—';
  $('fact-source').textContent = stream.sourceIp ? stream.sourceIp.replace(/^::ffff:/, '') : '—';
  $('kick').hidden = !stream.receiving;
}

function renderUptime() {
  const started = state?.stream.sessionStartedAt;
  $('fact-uptime').textContent = started ? formatClock(Math.max(0, Date.now() - started)) : '—';
}

function render() {
  $('version').textContent = `v${state.version}`;

  const alerts = $('alerts');
  alerts.replaceChildren(...state.warnings.map((warning) => {
    const item = document.createElement('div');
    item.className = 'alert';
    item.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/></svg>';
    const span = document.createElement('span');
    span.textContent = warning;
    item.append(span);
    return item;
  }));

  renderStream();
  renderUptime();

  $('rtmp-url').value = state.urls.rtmp;
  $('rtmp-hint').textContent = state.config.rtmpPublicUrl || state.config.publicUrl
    ? 'Pégala tal cual en la app de Insta360 (opción RTMP).'
    : 'Esta dirección solo sirve dentro de tu red. Para emitir desde la calle, configura antes el acceso desde Internet (paso 3).';
  $('viewer-url').value = state.urls.viewer;
  $('viewer-open').href = state.urls.viewer;

  const rejected = $('rejected');
  const last = state.lastRejected;
  if (last && Date.now() - last.at < 10 * 60_000) {
    rejected.hidden = false;
    rejected.textContent = `${ago(last.at)} se rechazó un intento de emisión desde ${last.ip.replace(/^::ffff:/, '')}: la clave no coincide. Vuelve a copiar la dirección en la app.`;
  } else {
    rejected.hidden = true;
  }

  const discord = state.discord;
  const status = $('webhook-status');
  if (discord.lastError) {
    status.className = 'note bad';
    status.textContent = `Último intento (${ago(discord.lastError.at)}): ${discord.lastError.message}`;
  } else if (discord.lastOkAt) {
    status.className = 'note ok';
    status.textContent = `Último envío correcto ${ago(discord.lastOkAt)}.`;
  } else {
    status.className = 'note';
    status.textContent = discord.webhookConfigured ? 'Webhook configurado. Aún no se ha enviado nada.' : 'Sin webhook: no se publicarán avisos.';
  }
  $('webhook-test').disabled = !discord.webhookConfigured;

  $('activity-state').textContent = discord.activityEnabled ? 'Configurada' : 'Sin configurar';
  $('activity-host').textContent = state.urls.activityHost || '(indica antes la dirección pública)';

  $('ffmpeg-note').textContent = state.ffmpeg.available
    ? `ffmpeg ${state.ffmpeg.version} · web en el puerto ${state.config.httpPort} · RTMP en el puerto ${state.config.rtmpPort}`
    : 'ffmpeg no disponible.';

  if (!formsFilled) fillForms();
  ensurePlayer();
}

function ensurePlayer() {
  const token = state.urls.viewToken;
  if (player && playerToken === token) return;
  player?.stop();
  playerToken = token;
  player = new LivePlayer({ video: $('preview'), base: `m/${encodeURIComponent(token)}/` });
  const empty = $('preview-empty');
  const update = () => {
    const playing = player.phase === 'playing';
    empty.hidden = playing;
    if (playing) return;
    empty.textContent = {
      starting: 'Cargando la vista previa…',
      reconnecting: 'Señal perdida; esperando a la cámara…',
      unsupported: 'Este navegador no puede mostrar la vista previa.',
      unreachable: 'Sin conexión con el servidor…',
    }[player.phase] ?? 'Sin señal de la cámara';
  };
  player.addEventListener('phase', update);
  update();
  player.start();
}

// ----------------------------------------------------------- sesión y sondeo

function showLogin() {
  player?.stop();
  player = null;
  playerToken = null;
  formsFilled = false;
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

async function refresh() {
  try {
    state = await api('state');
  } catch (error) {
    if (error.status === 401) showLogin();
    return;
  }
  $('login').hidden = true;
  $('app').hidden = false;
  render();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('login-error');
  error.hidden = true;
  try {
    await api('login', { password: $('password').value });
    $('password').value = '';
    await refresh();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('logout', {}).catch(() => {});
  showLogin();
});

// -------------------------------------------------------------------- botones

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.copy) copyText($(button.dataset.copy).value);
  if (button.dataset.copyText) copyText($(button.dataset.copyText).textContent);
  if (button.dataset.reveal) {
    const input = $(button.dataset.reveal);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    button.textContent = hidden ? 'Ocultar' : 'Mostrar';
  }
});

async function action(route, body, done) {
  try {
    const result = await api(route, body);
    if (result.version) {
      state = result;
      render();
    }
    if (done) toast(done);
  } catch (error) {
    toast(error.message);
  }
}

$('rotate-key').addEventListener('click', () => {
  if (window.confirm('Se generará una clave nueva y la cámara dejará de poder emitir hasta que pegues la nueva dirección en la app. ¿Continuar?')) {
    action('rotate', { key: 'streamKey' }, 'Clave nueva generada');
  }
});

$('rotate-link').addEventListener('click', () => {
  if (window.confirm('El enlace actual dejará de funcionar para todo el mundo. ¿Crear uno nuevo?')) {
    action('rotate', { key: 'viewToken' }, 'Enlace nuevo creado');
  }
});

$('kick').addEventListener('click', () => action('kick', {}, 'Cámara desconectada'));

$('webhook-test').addEventListener('click', async (event) => {
  event.target.disabled = true;
  await action('webhook-test', {}, 'Mensaje de prueba enviado a Discord');
  await refresh();
});

setInterval(() => {
  if (!document.hidden && !$('app').hidden) refresh();
}, 2500);
setInterval(() => {
  if (state && !$('app').hidden) renderUptime();
}, 1000);

refresh();
