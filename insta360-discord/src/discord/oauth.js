// Llamadas OAuth2 de Discord que necesita la Actividad: canjear el código que
// entrega el cliente de Discord y comprobar que la persona pertenece a un
// servidor autorizado.

import { DiscordError } from './webhook.js';

export class DiscordOAuth {
  /**
   * @param {object} options
   * @param {string} [options.apiBase] Solo se cambia en las pruebas.
   */
  constructor({ apiBase } = {}) {
    this.apiBase = (apiBase ?? process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
  }

  async _fetch(pathname, init) {
    const res = await fetch(this.apiBase + pathname, { ...init, signal: AbortSignal.timeout(15_000) });
    return res;
  }

  /** Canjea el código de autorización por un token de acceso del usuario. */
  async exchangeCode({ clientId, clientSecret, code }) {
    const res = await this._fetch('/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new DiscordError(res.status, data.error_description || data.error || 'no se pudo canjear el código');
    }
    return data.access_token;
  }

  /** Datos básicos del usuario dueño del token. */
  async getUser(accessToken) {
    const res = await this._fetch('/users/@me', { headers: { authorization: `Bearer ${accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.id !== 'string') throw new DiscordError(res.status, 'no se pudo identificar al usuario');
    return { id: data.id, name: data.global_name || data.username || 'usuario' };
  }

  /** ¿Pertenece el usuario al servidor indicado? (requiere el permiso guilds.members.read) */
  async isGuildMember(accessToken, guildId) {
    const res = await this._fetch(`/users/@me/guilds/${guildId}/member`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return true;
    if (res.status === 404 || res.status === 403) return false;
    throw new DiscordError(res.status, 'no se pudo comprobar la pertenencia al servidor');
  }
}
