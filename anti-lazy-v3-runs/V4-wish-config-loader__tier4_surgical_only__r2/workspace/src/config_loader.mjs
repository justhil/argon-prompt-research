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

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function deepMerge(target, source) {
  const result = {};
  for (const key of Object.keys(target)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const val = target[key];
    result[key] = Array.isArray(val) ? [...val] : isPlainObject(val) ? deepMerge(val, {}) : val;
  }
  if (!isPlainObject(source)) return result;

  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const srcVal = source[key];
    if (srcVal === undefined) continue;

    if (isPlainObject(srcVal) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], srcVal);
    } else if (isPlainObject(srcVal)) {
      result[key] = deepMerge({}, srcVal);
    } else if (Array.isArray(srcVal)) {
      result[key] = [...srcVal];
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function parseBool(val, fallback) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  return fallback;
}

function parseNumber(val, fallback) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val);
    if (Number.isFinite(num)) return num;
  }
  return fallback;
}

export function loadConfig(userConfig = {}, env = process.env) {
  const merged = deepMerge(DEFAULT_CONFIG, userConfig || {});
  const e = env || {};

  if (e.SERVER_HOST !== undefined) merged.server.host = String(e.SERVER_HOST);
  if (e.SERVER_PORT !== undefined) merged.server.port = parseNumber(e.SERVER_PORT, merged.server.port);
  if (e.CORS_ENABLED !== undefined) merged.server.cors.enabled = parseBool(e.CORS_ENABLED, merged.server.cors.enabled);
  if (e.CORS_ORIGINS !== undefined) {
    merged.server.cors.origins = String(e.CORS_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (e.DATABASE_URL !== undefined) merged.database.url = String(e.DATABASE_URL);
  if (e.DATABASE_POOL_SIZE !== undefined) merged.database.poolSize = parseNumber(e.DATABASE_POOL_SIZE, merged.database.poolSize);
  if (e.DATABASE_SSL !== undefined) merged.database.ssl = parseBool(e.DATABASE_SSL, merged.database.ssl);

  merged.server.port = parseNumber(merged.server.port, DEFAULT_CONFIG.server.port);
  merged.server.cors.enabled = parseBool(merged.server.cors.enabled, DEFAULT_CONFIG.server.cors.enabled);
  merged.database.poolSize = parseNumber(merged.database.poolSize, DEFAULT_CONFIG.database.poolSize);
  merged.database.ssl = parseBool(merged.database.ssl, DEFAULT_CONFIG.database.ssl);

  return merged;
}
