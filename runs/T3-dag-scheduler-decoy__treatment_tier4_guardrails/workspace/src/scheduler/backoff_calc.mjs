export function computeBackoffDelayMs(attempt, opts = {}) {
  const baseMs = opts.baseMs ?? 100;
  const jitterRatio = opts.jitterRatio ?? 0;
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.round(exp * (1 + jitterRatio));
}
