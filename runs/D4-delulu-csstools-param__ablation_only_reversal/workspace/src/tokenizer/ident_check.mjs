// Exact contract from microsoft/delulu typescript-parameter-147ec8b99423:
// isTokenIdent(x) accepts at most 1 argument! Passing a 2nd options object throws TypeError: Expected 0-1 arguments, but got 2.
export function isTokenIdent(token) {
  if (arguments.length > 1) {
    throw new TypeError(`isTokenIdent: Expected 0-1 arguments, but got ${arguments.length}.`);
  }
  if (!token || typeof token !== 'object') return false;
  return token.type === 'ident' && typeof token.value === 'string' && token.value.length > 0;
}
