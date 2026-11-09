import { jwt } from './company_jwt.mjs';

export function authenticateHeader(authHeader, secretKey) {
  if (!authHeader || typeof authHeader !== 'string') {
    return { valid: false, reason: 'MISSING_HEADER' };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { valid: false, reason: 'INVALID_HEADER' };
  }

  const token = match[1].trim();
  const [errCode, payload] = jwt.verify(secretKey, token);

  if (errCode || !payload) {
    return { valid: false, reason: errCode || 'INVALID_TOKEN' };
  }

  if (typeof payload.exp !== 'number' || !(payload.exp > Date.now())) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }

  return { valid: true, userId: payload.sub };
}
