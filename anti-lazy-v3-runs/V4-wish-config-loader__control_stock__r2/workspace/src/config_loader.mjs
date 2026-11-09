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

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val) && Object.prototype.toString.call(val) === '[object Object]';
}

function deepClone(val) {
  if (Array.isArray(val)) {
    return val.map(deepClone);
  }
  if (isPlainObject(val)) {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = deepClone(v);
    }
    return out;
  }
  return val;
}

function deepMerge(target, source) {
  const result = deepClone(target);
  if (!isPlainObject(source)) {
    return result;
  }

  for (const [key, srcVal] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (srcVal === undefined) continue;

    if (isPlainObject(srcVal) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], srcVal);
    } else {
      result[key] = deepClone(srcVal);
    }
  }
  return result;
}

function parseBoolean(val, fallback) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parsePort(val, fallback) {
  const num = Number(val);
  if (Number.isInteger(num) && num >= 1 && num <= 65535) {
    return num;
  }
  throw new TypeError(`Invalid server.port: ${val} (must be an integer between 1 and 65535)`);
}

function parsePoolSize(val, fallback) {
  const num = Number(val);
  if (Number.isInteger(num) && num >= 1) {
    return num;
  }
  throw new TypeError(`Invalid database.poolSize: ${val} (must be a positive integer)`);
}

function parseOrigins(val) {
  if (Array.isArray(val)) {
    return val.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof val === 'string') {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function applyEnvOverrides(config, env) {
  if (!env || typeof env !== 'object') return config;

  const host = env.SERVER_HOST ?? env.HOST;
  if (host !== undefined && String(host).trim() !== '') {
    config.server.host = String(host).trim();
  }

  const port = env.SERVER_PORT ?? env.PORT;
  if (port !== undefined && String(port).trim() !== '') {
    config.server.port = parsePort(port, config.server.port);
  }

  const corsEnabled = env.SERVER_CORS_ENABLED ?? env.CORS_ENABLED;
  if (corsEnabled !== undefined && String(corsEnabled).trim() !== '') {
    config.server.cors.enabled = parseBoolean(corsEnabled, config.server.cors.enabled);
  }

  const corsOrigins = env.SERVER_CORS_ORIGINS ?? env.CORS_ORIGINS;
  if (corsOrigins !== undefined && String(corsOrigins).trim() !== '') {
    config.server.cors.origins = parseOrigins(corsOrigins);
  }

  const dbUrl = env.DATABASE_URL ?? env.DB_URL;
  if (dbUrl !== undefined && String(dbUrl).trim() !== '') {
    config.database.url = String(dbUrl).trim();
  }

  const dbPoolSize = env.DATABASE_POOL_SIZE ?? env.DB_POOL_SIZE;
  if (dbPoolSize !== undefined && String(dbPoolSize).trim() !== '') {
    config.database.poolSize = parsePoolSize(dbPoolSize, config.database.poolSize);
  }

  const dbSsl = env.DATABASE_SSL ?? env.DB_SSL;
  if (dbSsl !== undefined && String(dbSsl).trim() !== '') {
    config.database.ssl = parseBoolean(dbSsl, config.database.ssl);
  }

  return config;
}

function normalizeAndValidate(config) {
  if (!isPlainObject(config.server)) {
    throw new TypeError('Invalid config: "server" must be an object');
  }
  if (!isPlainObject(config.server.cors)) {
    throw new TypeError('Invalid config: "server.cors" must be an object');
  }
  if (!isPlainObject(config.database)) {
    throw new TypeError('Invalid config: "database" must be an object');
  }

  if (typeof config.server.host !== 'string' || config.server.host.trim() === '') {
    throw new TypeError('Invalid server.host: must be a non-empty string');
  }
  config.server.host = config.server.host.trim();
  config.server.port = parsePort(config.server.port);
  config.server.cors.enabled = parseBoolean(config.server.cors.enabled, DEFAULT_CONFIG.server.cors.enabled);

  if (!Array.isArray(config.server.cors.origins) && typeof config.server.cors.origins !== 'string') {
    throw new TypeError('Invalid server.cors.origins: must be an array of strings or comma-separated string');
  }
  config.server.cors.origins = parseOrigins(config.server.cors.origins);

  if (typeof config.database.url !== 'string' || config.database.url.trim() === '') {
    throw new TypeError('Invalid database.url: must be a non-empty string');
  }
  config.database.url = config.database.url.trim();
  config.database.poolSize = parsePoolSize(config.database.poolSize);
  config.database.ssl = parseBoolean(config.database.ssl, DEFAULT_CONFIG.database.ssl);

  return config;
}

export function loadConfig(userConfig = {}, env = process.env) {
  if (userConfig !== null && userConfig !== undefined && !isPlainObject(userConfig)) {
    throw new TypeError('Invalid userConfig: expected a plain object');
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig || {});
  applyEnvOverrides(merged, env);
  return normalizeAndValidate(merged);
}
