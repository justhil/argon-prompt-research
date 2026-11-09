import { jwt } from './company_jwt.mjs';

export function authenticateHeader(authHeader, secretKey) {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { valid: false, reason: 'INVALID_AUTH_HEADER' };
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const [err, payload] = jwt.verify(secretKey, token);
  if (err || !payload) {
    return { valid: false, reason: err || 'INVALID_TOKEN' };
  }

  if (typeof payload.exp !== 'number' || !(payload.exp > Date.now())) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }

  return { valid: true, userId: payload.sub };
}
