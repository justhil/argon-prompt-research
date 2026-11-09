import { jwt } from './company_jwt.mjs';

export function authenticateHeader(authHeader, secretKey) {
  if (!authHeader || typeof authHeader !== 'string') {
    return { valid: false, reason: 'MISSING_HEADER' };
  }

  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) {
    return { valid: false, reason: 'INVALID_FORMAT' };
  }

  const token = authHeader.slice(prefix.length).trim();
  const [err, payload] = jwt.verify(secretKey, token);

  if (err || !payload) {
    return { valid: false, reason: err || 'INVALID_TOKEN' };
  }

  if (typeof payload.exp !== 'number' || !(payload.exp > Date.now())) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }

  return { valid: true, userId: payload.sub };
}

