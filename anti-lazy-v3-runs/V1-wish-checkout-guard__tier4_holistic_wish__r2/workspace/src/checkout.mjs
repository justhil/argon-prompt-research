export class CheckoutController {
  constructor(walletService, options = {}) {
    this.walletService = walletService;
    this.options = {
      rateLimit: 5,
      rateWindowMs: 60_000,
      idempotencyTtlMs: 300_000,
      now: () => Date.now(),
      ...options,
    };

    // Map<idempotencyKey, { fingerprint: string, status: 'pending' | 'completed', promise?: Promise<any>, response?: any, expiresAt: number }>
    this.idempotencyStore = new Map();
    // Map<userId, number[]> - timestamps of requests within sliding window
    this.rateLimitStore = new Map();
  }

  _now() {
    return typeof this.options.now === 'function' ? this.options.now() : Date.now();
  }

  _getMaxRequests() {
    return (
      this.options.maxRequests ??
      this.options.limit ??
      this.options.rateLimit ??
      5
    );
  }

  _getWindowMs() {
    return (
      this.options.windowMs ??
      this.options.rateLimitWindowMs ??
      this.options.rateWindowMs ??
      60_000
    );
  }

  _getIdempotencyTtlMs() {
    return (
      this.options.idempotencyTtlMs ??
      this.options.ttlMs ??
      this.options.cacheTtlMs ??
      300_000
    );
  }

  _computeFingerprint(req) {
    return JSON.stringify({
      userId: req.userId ?? null,
      amount: req.amount ?? null,
      itemId: req.itemId ?? null,
    });
  }

  _cleanupExpiredIdempotency(now) {
    for (const [key, entry] of this.idempotencyStore.entries()) {
      if (entry.status === 'completed' && entry.expiresAt <= now) {
        this.idempotencyStore.delete(key);
      }
    }
  }

  _checkRateLimit(userId, now) {
    const key = String(userId ?? 'anonymous');
    const windowMs = this._getWindowMs();
    const maxRequests = this._getMaxRequests();

    const timestamps = this.rateLimitStore.get(key) || [];
    const windowStart = now - windowMs;
    const activeTimestamps = timestamps.filter((ts) => ts > windowStart);

    if (activeTimestamps.length >= maxRequests) {
      this.rateLimitStore.set(key, activeTimestamps);
      const oldestInWindow = activeTimestamps[0];
      const retryAfterMs = Math.max(0, oldestInWindow + windowMs - now);
      return {
        allowed: false,
        retryAfterMs,
        retryAfter: Math.ceil(retryAfterMs / 1000),
      };
    }

    activeTimestamps.push(now);
    this.rateLimitStore.set(key, activeTimestamps);
    return { allowed: true, remaining: maxRequests - activeTimestamps.length };
  }

  _cloneResponse(res) {
    if (res && typeof structuredClone === 'function') {
      try {
        return structuredClone(res);
      } catch {
        // Fallback to shallow copy if non-cloneable properties exist
      }
    }
    return res ? { ...res } : res;
  }

  async handleCheckout(req) {
    if (!req || typeof req !== 'object') {
      return { status: 400, error: 'Invalid request payload' };
    }

    const { idempotencyKey, userId, amount, itemId } = req;
    if (
      userId === undefined ||
      userId === null ||
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !itemId
    ) {
      return { status: 400, error: 'Missing or invalid required checkout fields' };
    }

    const now = this._now();
    this._cleanupExpiredIdempotency(now);

    const hasIdempotencyKey =
      idempotencyKey !== undefined &&
      idempotencyKey !== null &&
      String(idempotencyKey).trim() !== '';
    const normalizedKey = hasIdempotencyKey ? String(idempotencyKey) : null;
    const fingerprint = this._computeFingerprint(req);

    // 1. Check idempotency state first (handling both completed and in-flight requests)
    if (normalizedKey !== null) {
      const existing = this.idempotencyStore.get(normalizedKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            status: 409,
            error: 'Idempotency key conflict: payload mismatch for existing idempotencyKey',
          };
        }

        if (existing.status === 'completed') {
          return {
            ...this._cloneResponse(existing.response),
            replayed: true,
          };
        }

        if (existing.status === 'pending' && existing.promise) {
          const result = await existing.promise;
          return {
            ...this._cloneResponse(result),
            replayed: true,
          };
        }
      }
    }

    // 2. Check sliding-window rate limit per user
    const rateCheck = this._checkRateLimit(userId, now);
    if (!rateCheck.allowed) {
      return {
        status: 429,
        error: 'Too Many Requests: rate limit exceeded',
        retryAfterMs: rateCheck.retryAfterMs,
        retryAfter: rateCheck.retryAfter,
      };
    }

    // 3. Execute debit with in-flight coalescing & failure rollback
    const executeDebit = async () => {
      const receipt = await this.walletService.debit(userId, amount, itemId);
      const response = { status: 200, receipt };
      if (normalizedKey !== null) {
        const completedAt = this._now();
        this.idempotencyStore.set(normalizedKey, {
          fingerprint,
          status: 'completed',
          response: this._cloneResponse(response),
          expiresAt: completedAt + this._getIdempotencyTtlMs(),
        });
      }
      return response;
    };

    if (normalizedKey !== null) {
      const pendingPromise = executeDebit();
      this.idempotencyStore.set(normalizedKey, {
        fingerprint,
        status: 'pending',
        promise: pendingPromise,
        expiresAt: Infinity,
      });

      try {
        const response = await pendingPromise;
        return this._cloneResponse(response);
      } catch (err) {
        // Clean up pending key on failure so subsequent retries can succeed
        this.idempotencyStore.delete(normalizedKey);
        throw err;
      }
    }

    return await executeDebit();
  }
}
