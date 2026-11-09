export const DEFAULT_TTL_MS = 4500;

export class IdempotencyGuard {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.locks = new Map();
    this.ttlMs = ttlMs;
  }

  tryAcquire(key, now = Date.now()) {
    const exp = this.locks.get(key);
    if (exp && exp > now) return false;
    this.locks.set(key, now + this.ttlMs);
    return true;
  }
}
