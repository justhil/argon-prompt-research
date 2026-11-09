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
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function deepMerge(target, source) {
  const result = {};
  for (const [key, val] of Object.entries(target)) {
    if (Array.isArray(val)) {
      result[key] = [...val];
    } else if (isPlainObject(val)) {
      result[key] = deepMerge(val, {});
    } else {
      result[key] = val;
    }
  }
  if (!isPlainObject(source)) return result;
  for (const [key, val] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      result[key] = [...val];
    } else if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else if (isPlainObject(val)) {
      result[key] = deepMerge(val, {});
    } else {
      result[key] = val;
    }
  }
  return result;
}

function parseBool(val, fallback) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return fallback;
}

function parsePort(val, fallback) {
  const num = Number(val);
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : fallback;
}

function parsePositiveInt(val, fallback) {
  const num = Number(val);
  return Number.isInteger(num) && num >= 1 ? num : fallback;
}

export function loadConfig(userConfig = {}, env = process.env) {
  const merged = deepMerge(DEFAULT_CONFIG, userConfig || {});
  const e = env || {};

  if (e.SERVER_HOST || e.HOST) {
    merged.server.host = String(e.SERVER_HOST || e.HOST).trim();
  }
  if (e.SERVER_PORT !== undefined || e.PORT !== undefined) {
    merged.server.port = parsePort(e.SERVER_PORT ?? e.PORT, merged.server.port);
  }
  if (e.CORS_ENABLED !== undefined) {
    merged.server.cors.enabled = parseBool(e.CORS_ENABLED, merged.server.cors.enabled);
  }
  if (e.CORS_ORIGINS !== undefined) {
    merged.server.cors.origins = String(e.CORS_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (e.DATABASE_URL || e.DB_URL) {
    merged.database.url = String(e.DATABASE_URL || e.DB_URL).trim();
  }
  if (e.DATABASE_POOL_SIZE !== undefined || e.DB_POOL_SIZE !== undefined) {
    merged.database.poolSize = parsePositiveInt(
      e.DATABASE_POOL_SIZE ?? e.DB_POOL_SIZE,
      merged.database.poolSize
    );
  }
  if (e.DATABASE_SSL !== undefined || e.DB_SSL !== undefined) {
    merged.database.ssl = parseBool(e.DATABASE_SSL ?? e.DB_SSL, merged.database.ssl);
  }

  return merged;
}
