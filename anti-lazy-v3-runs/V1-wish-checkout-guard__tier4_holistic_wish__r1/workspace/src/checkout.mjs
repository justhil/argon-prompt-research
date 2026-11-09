import crypto from 'node:crypto';

export class CheckoutController {
  constructor(walletService, options = {}) {
    if (!walletService || typeof walletService.debit !== 'function') {
      throw new TypeError('A valid walletService with a debit() method is required');
    }

    this.walletService = walletService;
    this.options = {
      rateLimitMax: options.rateLimitMax ?? options.maxRequests ?? options.limit ?? 5,
      rateLimitWindowMs: options.rateLimitWindowMs ?? options.windowMs ?? 60_000,
      idempotencyTtlMs: options.idempotencyTtlMs ?? options.ttlMs ?? 24 * 60 * 60 * 1000,
      now: typeof options.now === 'function' ? options.now : () => Date.now(),
      ...options,
    };

    // Map<idempotencyKey, { fingerprint, status: 'in_flight' | 'completed', promise?, response?, createdAt, expiresAt }>
    this.idempotencyStore = new Map();

    // Map<userId, number[]> - sliding window timestamps per user
    this.rateLimitStore = new Map();
  }

  _now() {
    return this.options.now();
  }

  _computeFingerprint(req) {
    const payload = JSON.stringify({
      userId: req.userId ?? null,
      amount: req.amount ?? null,
      itemId: req.itemId ?? null,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  _cleanupExpired(now) {
    for (const [key, record] of this.idempotencyStore.entries()) {
      if (record.status === 'completed' && record.expiresAt <= now) {
        this.idempotencyStore.delete(key);
      }
    }
  }

  _checkAndRecordRateLimit(userId, now) {
    const windowMs = this.options.rateLimitWindowMs;
    const maxRequests = this.options.rateLimitMax;
    const windowStart = now - windowMs;

    let timestamps = this.rateLimitStore.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.rateLimitStore.set(userId, timestamps);
    }

    // Evict expired timestamps outside the sliding window
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = Math.max(1, oldestInWindow + windowMs - now);
      return {
        allowed: false,
        retryAfterMs,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    timestamps.push(now);
    return { allowed: true, retryAfterMs: 0, retryAfterSeconds: 0 };
  }

  _cloneResponse(response) {
    return structuredClone ? structuredClone(response) : JSON.parse(JSON.stringify(response));
  }

  async handleCheckout(req) {
    if (!req || typeof req !== 'object') {
      return { status: 400, error: 'Invalid request payload' };
    }

    const { idempotencyKey, userId, amount, itemId } = req;

    if (!userId || typeof userId !== 'string') {
      return { status: 400, error: 'Missing or invalid userId' };
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return { status: 400, error: 'Amount must be a positive finite number' };
    }
    if (!itemId) {
      return { status: 400, error: 'Missing itemId' };
    }

    const now = this._now();
    this._cleanupExpired(now);

    const hasIdempotencyKey =
      typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0;
    const normalizedKey = hasIdempotencyKey ? idempotencyKey.trim() : null;
    const fingerprint = this._computeFingerprint(req);

    // 1. Check idempotency store first (covers both completed and in-flight requests)
    if (normalizedKey) {
      const existing = this.idempotencyStore.get(normalizedKey);
      if (existing) {
        if (existing.status === 'completed' && existing.expiresAt <= now) {
          this.idempotencyStore.delete(normalizedKey);
        } else {
          // Conflict detection: same idempotencyKey used with different parameters
          if (existing.fingerprint !== fingerprint) {
            return {
              status: 409,
              error: 'Idempotency key conflict: payload mismatch for existing key',
            };
          }

          // Completed request: return cached result without consuming rate limit
          if (existing.status === 'completed') {
            return {
              ...this._cloneResponse(existing.response),
              idempotentReplay: true,
            };
          }

          // In-flight concurrent request: coalesce and await the same promise
          if (existing.status === 'in_flight') {
            const response = await existing.promise;
            return {
              ...this._cloneResponse(response),
              idempotentReplay: true,
            };
          }
        }
      }
    }

    // 2. Sliding-window rate limit check per userId
    const rateLimitResult = this._checkAndRecordRateLimit(userId, now);
    if (!rateLimitResult.allowed) {
      return {
        status: 429,
        error: 'Too Many Requests: rate limit exceeded',
        retryAfterMs: rateLimitResult.retryAfterMs,
        retryAfter: rateLimitResult.retryAfterSeconds,
      };
    }

    // 3. Execute debit with in-flight locking and failure rollback
    const executeDebit = async () => {
      const receipt = await this.walletService.debit(userId, amount, itemId);
      return { status: 200, receipt };
    };

    if (!normalizedKey) {
      return executeDebit();
    }

    const promise = executeDebit();
    this.idempotencyStore.set(normalizedKey, {
      fingerprint,
      status: 'in_flight',
      promise,
      createdAt: now,
      expiresAt: now + this.options.idempotencyTtlMs,
    });

    try {
      const response = await promise;
      const completedAt = this._now();
      this.idempotencyStore.set(normalizedKey, {
        fingerprint,
        status: 'completed',
        response: this._cloneResponse(response),
        createdAt: now,
        expiresAt: completedAt + this.options.idempotencyTtlMs,
      });
      return this._cloneResponse(response);
    } catch (error) {
      // Clean up in-flight idempotency lock on downstream failure so retries can succeed
      this.idempotencyStore.delete(normalizedKey);
      throw error;
    }
  }
}
