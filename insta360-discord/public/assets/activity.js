// Actividad de Discord: se identifica con el cliente de Discord, pide al puente
// un pase temporal (solo para miembros de un servidor autorizado) y muestra el
// directo dentro del canal de voz.

/* global DiscordSDK */

import { mountStage } from './stage.js';

const root = document.getElementById('stage');

// Dentro de Discord todo pasa por su proxy; las peticiones de datos usan el
// prefijo /.proxy/, que es el que su política de seguridad permite siempre.
const proxied = /(^|\.)discordsays\.com$/.test(window.location.hostname);
const base = proxied ? '/.proxy/' : './';

function boot({ title, text = '', busy = false, button = null }) {
  document.getElementById('boot-indicator').className = busy ? 'spinner' : 'dot-wait';
  document.getElementById('boot-title').textContent = title;
  const detail = document.getElementById('boot-text');
  detail.textContent = text;
  detail.hidden = !text;
  const extra = document.getElementById('boot-extra');
  extra.replaceChildren();
  if (button) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn primary';
    el.textContent = button.label;
    el.addEventListener('click', button.onClick);
    extra.append(el);
  }
}

const timeout = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

let sdk = null;
let clientId = null;

/** Pide permiso al usuario en Discord y canjea el código por un pase del puente. */
async function requestPass() {
  let code;
  try {
    ({ code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify', 'guilds.members.read'],
    }));
  } catch {
    const error = new Error('Para ver el directo hay que aceptar el permiso de Discord: sirve para comprobar que perteneces al servidor.');
    error.retry = true;
    throw error;
  }
  const res = await fetch(`${base}api/activity/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, guildId: sdk.guildId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let message = data.error || `El servidor respondió ${res.status}.`;
    if (data.reason === 'guild' && sdk.guildId) message += ` (ID de este servidor: ${sdk.guildId})`;
    const error = new Error(message);
    error.retry = res.status !== 403;
    throw error;
  }
  return data.token;
}

async function showStream() {
  boot({ title: 'Comprobando acceso…', busy: true });
  let token;
  try {
    token = await requestPass();
  } catch (error) {
    boot({
      title: 'No se puede mostrar el directo',
      text: error.message,
      button: error.retry ? { label: 'Reintentar', onClick: showStream } : null,
    });
    return;
  }
  mountStage({
    root,
    base: `${base}m/${encodeURIComponent(token)}/`,
    fullscreen: false,
    // El pase caduca a las horas: se pide otro sin que el usuario haga nada.
    onDenied: (player) => {
      player.stop();
      window.location.reload();
    },
  });
}

async function main() {
  const config = await (await fetch(`${base}api/activity/config`, { cache: 'no-store' })).json();
  if (!config.enabled) {
    boot({ title: 'Actividad sin configurar', text: 'Falta completar los datos de Discord en el panel del puente (paso 5).' });
    return;
  }
  clientId = config.clientId;
  try {
    sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
  } catch {
    boot({ title: 'Abre esto desde Discord', text: 'Esta página es la Actividad del directo y solo funciona dentro de un canal de voz de Discord.' });
    return;
  }
  await Promise.race([sdk.ready(), timeout(20_000, 'Discord no ha respondido.')]);
  await showStream();
}

main().catch((error) => {
  boot({
    title: 'No se pudo iniciar',
    text: error.message || 'Error inesperado.',
    button: { label: 'Reintentar', onClick: () => window.location.reload() },
  });
});
