export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 8080,
    cors: { enabled: true, origins: ['http://localhost:3000'] }
  },
  database: {
    url: 'sqlite://:memory:',
    poolSize: 10,
    ssl: false
  }
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  if (isPlainObject(value)) {
    const cloned = {};
    for (const key of Object.keys(value)) {
      if (!DANGEROUS_KEYS.has(key)) {
        cloned[key] = deepClone(value[key]);
      }
    }
    return cloned;
  }
  return value;
}

function deepMerge(target, source) {
  const result = deepClone(target);
  if (!isPlainObject(source)) {
    return result;
  }
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const sourceVal = source[key];
    if (sourceVal === undefined) continue;

    if (isPlainObject(sourceVal) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], sourceVal);
    } else {
      result[key] = deepClone(sourceVal);
    }
  }
  return result;
}

function pickEnv(env, keys) {
  if (!env || typeof env !== 'object') return undefined;
  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== '') {
      return env[key];
    }
  }
  return undefined;
}

function parseBoolean(value, name) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  throw new TypeError(`Invalid boolean value for "${name}": ${String(value)}`);
}

function parseInteger(value, name, { min = -Infinity, max = Infinity } = {}) {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value.trim())
        : NaN;

  if (!Number.isInteger(num) || num < min || num > max) {
    throw new RangeError(
      `Invalid integer value for "${name}": ${String(value)} (expected integer in [${min}, ${max}])`
    );
  }
  return num;
}

function parseStringArray(value, name) {
  if (Array.isArray(value)) {
    return value.map((item, idx) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new TypeError(`Invalid string item at "${name}[${idx}]"`);
      }
      return item.trim();
    });
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      return parseStringArray(parsed, name);
    }
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  throw new TypeError(`Invalid array value for "${name}"`);
}

function extractEnvConfig(env = {}) {
  const envConfig = { server: { cors: {} }, database: {} };

  const host = pickEnv(env, ['SERVER_HOST', 'HOST']);
  if (host !== undefined) envConfig.server.host = String(host).trim();

  const port = pickEnv(env, ['SERVER_PORT', 'PORT']);
  if (port !== undefined) envConfig.server.port = port;

  const corsEnabled = pickEnv(env, ['SERVER_CORS_ENABLED', 'CORS_ENABLED']);
  if (corsEnabled !== undefined) envConfig.server.cors.enabled = corsEnabled;

  const corsOrigins = pickEnv(env, ['SERVER_CORS_ORIGINS', 'CORS_ORIGINS']);
  if (corsOrigins !== undefined) envConfig.server.cors.origins = corsOrigins;

  const dbUrl = pickEnv(env, ['DATABASE_URL', 'DB_URL']);
  if (dbUrl !== undefined) envConfig.database.url = String(dbUrl).trim();

  const poolSize = pickEnv(env, ['DATABASE_POOL_SIZE', 'DB_POOL_SIZE']);
  if (poolSize !== undefined) envConfig.database.poolSize = poolSize;

  const dbSsl = pickEnv(env, ['DATABASE_SSL', 'DB_SSL']);
  if (dbSsl !== undefined) envConfig.database.ssl = dbSsl;

  return envConfig;
}

function normalizeAndValidate(config) {
  if (!isPlainObject(config.server)) {
    throw new TypeError('"server" configuration must be an object');
  }
  if (!isPlainObject(config.server.cors)) {
    throw new TypeError('"server.cors" configuration must be an object');
  }
  if (!isPlainObject(config.database)) {
    throw new TypeError('"database" configuration must be an object');
  }

  if (typeof config.server.host !== 'string' || config.server.host.trim() === '') {
    throw new TypeError('"server.host" must be a non-empty string');
  }
  config.server.host = config.server.host.trim();
  config.server.port = parseInteger(config.server.port, 'server.port', { min: 1, max: 65535 });
  config.server.cors.enabled = parseBoolean(config.server.cors.enabled, 'server.cors.enabled');
  config.server.cors.origins = parseStringArray(config.server.cors.origins, 'server.cors.origins');

  if (typeof config.database.url !== 'string' || config.database.url.trim() === '') {
    throw new TypeError('"database.url" must be a non-empty string');
  }
  config.database.url = config.database.url.trim();
  config.database.poolSize = parseInteger(config.database.poolSize, 'database.poolSize', {
    min: 1,
    max: 10000
  });
  config.database.ssl = parseBoolean(config.database.ssl, 'database.ssl');

  return config;
}

export function loadConfig(userConfig = {}, env = process.env) {
  if (userConfig !== null && userConfig !== undefined && !isPlainObject(userConfig)) {
    throw new TypeError('"userConfig" must be a plain object');
  }
  const mergedUser = deepMerge(DEFAULT_CONFIG, userConfig || {});
  const envOverrides = extractEnvConfig(env);
  const mergedAll = deepMerge(mergedUser, envOverrides);
  return normalizeAndValidate(mergedAll);
}
