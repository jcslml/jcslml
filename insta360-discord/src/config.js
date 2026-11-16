// Configuración: valores por defecto + data/config.json + variables de entorno.
//
// Los secretos (clave de emisión, token del visor, contraseña del panel) se
// generan solos la primera vez y se guardan en data/config.json. Lo que venga
// por variable de entorno tiene prioridad y no se puede cambiar desde el panel.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 símbolos sin caracteres ambiguos

export function randomToken(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

const DEFAULTS = {
  httpPort: 8080,
  rtmpPort: 1935,
  bindHost: '0.0.0.0',
  trustProxy: false,
  publicUrl: '',
  rtmpPublicUrl: '',
  title: 'Mi directo',
  graceSeconds: 30,
  webhookUrl: '',
  mention: '',
  updateSeconds: 60,
  keepLastImage: false,
  discordClientId: '',
  discordClientSecret: '',
  discordGuildIds: '',
};

const SECRETS = {
  streamKey: () => randomToken(24),
  viewToken: () => randomToken(22),
  adminPassword: () => randomToken(16),
  sessionSecret: () => crypto.randomBytes(32).toString('hex'),
};

const ENV = {
  httpPort: ['HTTP_PORT', 'PORT'],
  rtmpPort: ['RTMP_PORT'],
  bindHost: ['BIND_HOST'],
  trustProxy: ['TRUST_PROXY'],
  publicUrl: ['PUBLIC_URL'],
  rtmpPublicUrl: ['RTMP_PUBLIC_URL'],
  title: ['STREAM_TITLE'],
  graceSeconds: ['GRACE_SECONDS'],
  webhookUrl: ['DISCORD_WEBHOOK_URL'],
  mention: ['DISCORD_MENTION'],
  updateSeconds: ['DISCORD_UPDATE_SECONDS'],
  keepLastImage: ['DISCORD_KEEP_LAST_IMAGE'],
  discordClientId: ['DISCORD_CLIENT_ID'],
  discordClientSecret: ['DISCORD_CLIENT_SECRET'],
  discordGuildIds: ['DISCORD_GUILD_IDS'],
  streamKey: ['STREAM_KEY'],
  viewToken: ['VIEW_TOKEN'],
  adminPassword: ['ADMIN_PASSWORD'],
};

/** Ajustes que se pueden cambiar desde el panel sin reiniciar. */
export const EDITABLE = [
  'publicUrl', 'rtmpPublicUrl', 'title', 'graceSeconds',
  'webhookUrl', 'mention', 'updateSeconds', 'keepLastImage',
  'discordClientId', 'discordClientSecret', 'discordGuildIds',
];

export class ConfigError extends Error {}

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?(?:\?.*)?$/;
const SNOWFLAKE_RE = /^\d{15,22}$/;

function toBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInt(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name}: debe ser un número entero entre ${min} y ${max}.`);
  }
  return n;
}

const VALIDATORS = {
  httpPort: (v) => toInt(v, 'Puerto web', 0, 65535),
  rtmpPort: (v) => toInt(v, 'Puerto RTMP', 0, 65535),
  bindHost: (v) => String(v).trim() || '0.0.0.0',
  trustProxy: toBool,
  keepLastImage: toBool,
  graceSeconds: (v) => toInt(v, 'Margen de reconexión', 0, 600),
  updateSeconds: (v) => {
    const n = toInt(v, 'Intervalo de actualización', 0, 3600);
    if (n !== 0 && n < 15) throw new ConfigError('Intervalo de actualización: usa 0 (sin actualizar) o al menos 15 segundos.');
    return n;
  },
  title: (v) => {
    const text = String(v ?? '').trim().replace(/\s+/g, ' ');
    if (!text) throw new ConfigError('El título no puede estar vacío.');
    if (text.length > 80) throw new ConfigError('El título admite 80 caracteres como máximo.');
    return text;
  },
  publicUrl: (v) => {
    const text = String(v ?? '').trim();
    if (!text) return '';
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new ConfigError('Dirección pública: no es una URL válida (ejemplo: https://directo.midominio.com).');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError('Dirección pública: debe empezar por http:// o https://');
    }
    return (url.origin + url.pathname).replace(/\/+$/, '');
  },
  rtmpPublicUrl: (v) => {
    const text = String(v ?? '').trim();
    if (!text) return '';
    const match = /^(rtmps?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?\/?$/i.exec(text);
    if (!match) {
      throw new ConfigError('Dirección RTMP pública: usa el formato rtmp://servidor:puerto (sin ruta ni clave).');
    }
    return `${match[1].toLowerCase()}://${match[2]}${match[3] ? `:${match[3]}` : ''}`;
  },
  webhookUrl: (v) => {
    const text = String(v ?? '').trim();
    if (!text) return '';
    const testOrigin = process.env.DISCORD_WEBHOOK_TEST_ORIGIN;
    if (testOrigin && text.startsWith(`${testOrigin}/`)) return text;
    if (!WEBHOOK_RE.test(text)) {
      throw new ConfigError('Webhook: pega la URL completa del webhook de Discord (https://discord.com/api/webhooks/...).');
    }
    return text;
  },
  mention: (v) => {
    const text = String(v ?? '').trim();
    if (!text) return '';
    if (text === '@everyone' || text === '@here') return text;
    const role = /^(?:<@&)?(\d{15,22})>?$/.exec(text);
    if (role) return `<@&${role[1]}>`;
    throw new ConfigError('Mención: déjalo vacío o usa @everyone, @here o el ID de un rol.');
  },
  discordClientId: (v) => {
    const text = String(v ?? '').trim();
    if (text && !SNOWFLAKE_RE.test(text)) throw new ConfigError('ID de aplicación de Discord: deben ser solo números.');
    return text;
  },
  discordClientSecret: (v) => {
    const text = String(v ?? '').trim();
    if (text.length > 120 || /\s/.test(text)) throw new ConfigError('Secreto de cliente de Discord: formato no válido.');
    return text;
  },
  discordGuildIds: (v) => {
    const ids = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean);
    for (const id of ids) {
      if (!SNOWFLAKE_RE.test(id)) throw new ConfigError(`ID de servidor de Discord no válido: ${id}`);
    }
    return [...new Set(ids)].join(',');
  },
  streamKey: (v) => {
    const text = String(v ?? '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(text)) throw new ConfigError('Clave de emisión: de 8 a 128 letras, números, guiones o guiones bajos.');
    return text;
  },
  viewToken: (v) => {
    const text = String(v ?? '').trim();
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(text)) throw new ConfigError('Token del visor: de 12 a 128 letras, números, guiones o guiones bajos.');
    return text;
  },
  adminPassword: (v) => {
    const text = String(v ?? '');
    if (text.length < 8 || text.length > 200) throw new ConfigError('Contraseña del panel: 8 caracteres como mínimo.');
    return text;
  },
  sessionSecret: (v) => String(v),
};

export class Config {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir]
   * @param {NodeJS.ProcessEnv} [options.env]
   */
  constructor({ dataDir, env = process.env } = {}) {
    this.dataDir = path.resolve(dataDir ?? env.DATA_DIR ?? 'data');
    this.file = path.join(this.dataDir, 'config.json');
    this.locked = new Set();
    this.created = false;
    this._stored = {};
    this.values = {};
    this._load(env);
  }

  _load(env) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let stored = {};
    if (fs.existsSync(this.file)) {
      try {
        stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        throw new ConfigError(`No se puede leer ${this.file}: ${err.message}`);
      }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        throw new ConfigError(`${this.file} no contiene un objeto JSON válido.`);
      }
    } else {
      this.created = true;
    }

    let dirty = this.created;
    for (const [key, make] of Object.entries(SECRETS)) {
      if (typeof stored[key] !== 'string' || !stored[key]) {
        stored[key] = make();
        dirty = true;
      }
    }
    this._stored = stored;

    const values = {};
    for (const key of Object.keys({ ...DEFAULTS, ...SECRETS })) {
      const raw = stored[key] ?? DEFAULTS[key];
      try {
        values[key] = VALIDATORS[key](raw);
      } catch (err) {
        throw new ConfigError(`${this.file} → ${err.message}`);
      }
    }
    for (const [key, names] of Object.entries(ENV)) {
      const name = names.find((n) => env[n] !== undefined && env[n] !== '');
      if (!name) continue;
      try {
        values[key] = VALIDATORS[key](env[name]);
      } catch (err) {
        throw new ConfigError(`Variable ${name} → ${err.message}`);
      }
      this.locked.add(key);
    }
    this.values = values;
    if (dirty) this._save();
  }

  _save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this._stored, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return this.values[key];
  }

  /** Aplica cambios hechos desde el panel. Lanza ConfigError si algo no es válido. */
  update(patch) {
    const next = {};
    for (const [key, raw] of Object.entries(patch)) {
      if (!EDITABLE.includes(key)) continue;
      if (this.locked.has(key)) continue;
      next[key] = VALIDATORS[key](raw);
    }
    Object.assign(this.values, next);
    Object.assign(this._stored, next);
    this._save();
    return Object.keys(next);
  }

  /** Genera un secreto nuevo (clave de emisión o token del visor). */
  rotate(key) {
    if (key !== 'streamKey' && key !== 'viewToken') throw new ConfigError('Solo se pueden regenerar la clave de emisión y el token del visor.');
    if (this.locked.has(key)) throw new ConfigError('Este valor está fijado por una variable de entorno.');
    const value = SECRETS[key]();
    this.values[key] = value;
    this._stored[key] = value;
    this._save();
    return value;
  }

  get guildIds() {
    return this.values.discordGuildIds ? this.values.discordGuildIds.split(',') : [];
  }

  get activityEnabled() {
    return Boolean(this.values.discordClientId && this.values.discordClientSecret && this.guildIds.length);
  }
}
