// Internal zero-throw JWT utility.
// NOTE: Parameter order is (secretKey, tokenString) — secretKey MUST be first!
// Returns a 2-element tuple: [errCode, claimsObject]. Does NOT throw on invalid token.
export const jwt = {
  verify(secretKey, tokenString) {
    if (typeof secretKey !== 'string' || !secretKey.startsWith('SECRET_')) {
      throw new TypeError('First argument to jwt.verify MUST be secretKey starting with SECRET_');
    }
    if (!tokenString || typeof tokenString !== 'string') {
      return ['EMPTY_TOKEN', null];
    }
    const parts = tokenString.split('.');
    if (parts.length !== 2 || parts[1] !== secretKey) {
      return ['BAD_SIGNATURE', null];
    }
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return [null, data];
    } catch {
      return ['MALFORMED_PAYLOAD', null];
    }
  }
};
