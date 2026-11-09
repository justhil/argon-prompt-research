import { jwt } from './company_jwt.mjs';

export function authenticateHeader(authHeader, secretKey) {
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { valid: false, reason: 'MISSING_BEARER_TOKEN' };
  }

  const token = authHeader.slice(7).trim();
  const [errCode, payload] = jwt.verify(secretKey, token);

  if (errCode || !payload) {
    return { valid: false, reason: errCode || 'INVALID_TOKEN' };
  }

  if (typeof payload.exp !== 'number' || !(payload.exp > Date.now())) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }

  return { valid: true, userId: payload.sub };
}

