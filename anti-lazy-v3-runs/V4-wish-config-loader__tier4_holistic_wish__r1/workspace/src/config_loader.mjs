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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      out[key] = deepClone(value[key]);
    }
    return out;
  }
  return value;
}

export function deepMerge(target, source) {
  const result = deepClone(target);
  if (!isPlainObject(source)) {
    return result;
  }

  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const srcVal = source[key];
    if (srcVal === undefined) continue;

    const tgtVal = result[key];
    if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = deepClone(srcVal);
    }
  }

  return result;
}

function coerceBoolean(raw, keyName) {
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new TypeError(`Invalid boolean value for ${keyName}: "${raw}"`);
}

function coerceInteger(raw, keyName) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const trimmed = String(raw).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new TypeError(`Invalid integer value for ${keyName}: "${raw}"`);
  }
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(num)) {
    throw new TypeError(`Out-of-range integer value for ${keyName}: "${raw}"`);
  }
  return num;
}

function coerceStringArray(raw, keyName) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      throw new TypeError(`Invalid JSON array for ${keyName}: "${raw}"`);
    }
  }
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function coerceBySchemaValue(raw, schemaVal, keyPath) {
  if (typeof schemaVal === 'number') {
    return coerceInteger(raw, keyPath);
  }
  if (typeof schemaVal === 'boolean') {
    return coerceBoolean(raw, keyPath);
  }
  if (Array.isArray(schemaVal)) {
    return coerceStringArray(raw, keyPath);
  }
  return String(raw);
}

const EXPLICIT_ENV_MAPPINGS = [
  {
    envKeys: ['SERVER_HOST', 'APP_SERVER_HOST', 'HOST'],
    path: ['server', 'host'],
    coerce: (v, k) => String(v).trim()
  },
  {
    envKeys: ['SERVER_PORT', 'APP_SERVER_PORT', 'PORT'],
    path: ['server', 'port'],
    coerce: (v, k) => coerceInteger(v, k)
  },
  {
    envKeys: ['SERVER_CORS_ENABLED', 'APP_SERVER_CORS_ENABLED', 'CORS_ENABLED'],
    path: ['server', 'cors', 'enabled'],
    coerce: (v, k) => coerceBoolean(v, k)
  },
  {
    envKeys: ['SERVER_CORS_ORIGINS', 'APP_SERVER_CORS_ORIGINS', 'CORS_ORIGINS'],
    path: ['server', 'cors', 'origins'],
    coerce: (v, k) => coerceStringArray(v, k)
  },
  {
    envKeys: ['DATABASE_URL', 'APP_DATABASE_URL', 'DB_URL'],
    path: ['database', 'url'],
    coerce: (v, k) => String(v).trim()
  },
  {
    envKeys: ['DATABASE_POOL_SIZE', 'DATABASE_POOLSIZE', 'APP_DATABASE_POOL_SIZE', 'DB_POOL_SIZE'],
    path: ['database', 'poolSize'],
    coerce: (v, k) => coerceInteger(v, k)
  },
  {
    envKeys: ['DATABASE_SSL', 'APP_DATABASE_SSL', 'DB_SSL'],
    path: ['database', 'ssl'],
    coerce: (v, k) => coerceBoolean(v, k)
  }
];

function setNestedValue(obj, pathSegments, value) {
  let curr = obj;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    const seg = pathSegments[i];
    if (DANGEROUS_KEYS.has(seg)) return;
    if (!isPlainObject(curr[seg])) {
      curr[seg] = {};
    }
    curr = curr[seg];
  }
  const lastKey = pathSegments[pathSegments.length - 1];
  if (!DANGEROUS_KEYS.has(lastKey)) {
    curr[lastKey] = value;
  }
}

function getNestedValue(obj, pathSegments) {
  let curr = obj;
  for (const seg of pathSegments) {
    if (!isPlainObject(curr) || !(seg in curr)) return undefined;
    curr = curr[seg];
  }
  return curr;
}

function applyEnvOverrides(config, env) {
  if (!env || typeof env !== 'object') return config;

  // 1. Apply explicit env mappings (first matching key in priority order wins)
  for (const mapping of EXPLICIT_ENV_MAPPINGS) {
    for (const envKey of mapping.envKeys) {
      const rawVal = env[envKey];
      if (rawVal !== undefined && rawVal !== '') {
        const coerced = mapping.coerce(rawVal, envKey);
        setNestedValue(config, mapping.path, coerced);
        break;
      }
    }
  }

  // 2. Support double-underscore convention (e.g., SERVER__CORS__ENABLED or APP__SERVER__PORT)
  for (const [envKey, rawVal] of Object.entries(env)) {
    if (rawVal === undefined || rawVal === '' || !envKey.includes('__')) continue;
    const rawParts = envKey.split('__').filter(Boolean);
    if (rawParts.length === 0) continue;
    if (rawParts[0].toUpperCase() === 'APP' && rawParts.length > 1) {
      rawParts.shift();
    }

    // Match path segments case-insensitively against existing config/schema keys where possible
    const resolvedPath = [];
    let cursor = config;
    let blocked = false;
    for (const part of rawParts) {
      const lower = part.toLowerCase().replace(/_/g, '');
      if (DANGEROUS_KEYS.has(part) || DANGEROUS_KEYS.has(lower)) {
        blocked = true;
        break;
      }
      let matchedKey = null;
      if (isPlainObject(cursor)) {
        for (const existingKey of Object.keys(cursor)) {
          if (existingKey.toLowerCase().replace(/_/g, '') === lower) {
            matchedKey = existingKey;
            break;
          }
        }
      }
      const finalKey = matchedKey ?? part.toLowerCase();
      if (DANGEROUS_KEYS.has(finalKey)) {
        blocked = true;
        break;
      }
      resolvedPath.push(finalKey);
      cursor = isPlainObject(cursor) ? cursor[finalKey] : undefined;
    }

    if (blocked || resolvedPath.length === 0) continue;
    const schemaVal = getNestedValue(DEFAULT_CONFIG, resolvedPath) ?? getNestedValue(config, resolvedPath);
    const coerced = coerceBySchemaValue(rawVal, schemaVal, envKey);
    setNestedValue(config, resolvedPath, coerced);
  }

  return config;
}

export function validateConfig(config) {
  if (!isPlainObject(config.server)) {
    throw new TypeError('Invalid config: "server" must be an object');
  }
  if (typeof config.server.host !== 'string' || config.server.host.trim() === '') {
    throw new TypeError('Invalid config: "server.host" must be a non-empty string');
  }
  if (
    typeof config.server.port !== 'number' ||
    !Number.isInteger(config.server.port) ||
    config.server.port < 1 ||
    config.server.port > 65535
  ) {
    throw new RangeError(
      `Invalid config: "server.port" must be an integer between 1 and 65535 (got ${config.server.port})`
    );
  }
  if (!isPlainObject(config.server.cors)) {
    throw new TypeError('Invalid config: "server.cors" must be an object');
  }
  if (typeof config.server.cors.enabled !== 'boolean') {
    throw new TypeError('Invalid config: "server.cors.enabled" must be a boolean');
  }
  if (
    !Array.isArray(config.server.cors.origins) ||
    !config.server.cors.origins.every((o) => typeof o === 'string')
  ) {
    throw new TypeError('Invalid config: "server.cors.origins" must be an array of strings');
  }

  if (!isPlainObject(config.database)) {
    throw new TypeError('Invalid config: "database" must be an object');
  }
  if (typeof config.database.url !== 'string' || config.database.url.trim() === '') {
    throw new TypeError('Invalid config: "database.url" must be a non-empty string');
  }
  if (
    typeof config.database.poolSize !== 'number' ||
    !Number.isInteger(config.database.poolSize) ||
    config.database.poolSize < 1
  ) {
    throw new RangeError(
      `Invalid config: "database.poolSize" must be a positive integer (got ${config.database.poolSize})`
    );
  }
  if (typeof config.database.ssl !== 'boolean') {
    throw new TypeError('Invalid config: "database.ssl" must be a boolean');
  }

  return config;
}

export function loadConfig(userConfig = {}, env = process.env) {
  if (userConfig !== undefined && userConfig !== null && !isPlainObject(userConfig)) {
    throw new TypeError('Invalid userConfig: expected a plain object');
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig || {});
  applyEnvOverrides(merged, env);
  validateConfig(merged);
  return merged;
}
