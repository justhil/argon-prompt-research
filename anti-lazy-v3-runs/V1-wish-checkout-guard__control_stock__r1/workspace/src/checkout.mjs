export class CheckoutController {
  constructor(walletService, options = {}) {
    this.walletService = walletService;
    this.options = {
      maxRequests:
        options.maxRequests ??
        options.limit ??
        (typeof options.rateLimit === 'number'
          ? options.rateLimit
          : options.rateLimit?.maxRequests ?? options.rateLimit?.limit) ??
        5,
      windowMs:
        options.windowMs ??
        options.rateLimitWindowMs ??
        options.rateLimit?.windowMs ??
        1000,
      idempotencyTtlMs: options.idempotencyTtlMs ?? options.ttlMs ?? 5 * 60 * 1000,
      ...options,
    };

    // key -> { fingerprint, status: 'in_flight' | 'completed', promise, response, expiresAt }
    this.idempotencyStore = new Map();
    // userId -> number[] (timestamps)
    this.rateLimitStore = new Map();
  }

  _pruneExpired(now) {
    for (const [key, entry] of this.idempotencyStore.entries()) {
      if (entry.status === 'completed' && entry.expiresAt <= now) {
        this.idempotencyStore.delete(key);
      }
    }
  }

  _checkRateLimit(userKey, now) {
    const { maxRequests, windowMs } = this.options;
    if (maxRequests <= 0) {
      return false;
    }
    const windowStart = now - windowMs;
    const timestamps = (this.rateLimitStore.get(userKey) || []).filter(
      (ts) => ts > windowStart
    );
    if (timestamps.length >= maxRequests) {
      this.rateLimitStore.set(userKey, timestamps);
      return false;
    }
    timestamps.push(now);
    this.rateLimitStore.set(userKey, timestamps);
    return true;
  }

  async handleCheckout(req) {
    // req: { idempotencyKey, userId, amount, itemId }
    const now = Date.now();
    this._pruneExpired(now);

    const { idempotencyKey, userId, amount, itemId } = req || {};
    const fingerprint = `${userId}:${amount}:${itemId}`;

    // 1. 防重复提交 / 幂等检查
    if (idempotencyKey) {
      const existing = this.idempotencyStore.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            status: 409,
            error: 'Idempotency key conflict: request parameters do not match',
          };
        }
        if (existing.status === 'completed') {
          return existing.response;
        }
        if (existing.status === 'in_flight') {
          if (this.options.rejectConcurrentDuplicate) {
            return {
              status: 409,
              error: 'Duplicate request in progress',
            };
          }
          return existing.promise;
        }
      }
    }

    // 2. 限流检查（按 userId 滑动窗口限流）
    const rateLimitKey = userId ?? '__anonymous__';
    if (!this._checkRateLimit(rateLimitKey, now)) {
      return {
        status: 429,
        error: 'Too Many Requests',
      };
    }

    // 3. 执行扣款并记录幂等状态
    const executeDebit = async () => {
      const receipt = await this.walletService.debit(userId, amount, itemId);
      const response = { status: 200, receipt };
      if (idempotencyKey) {
        this.idempotencyStore.set(idempotencyKey, {
          fingerprint,
          status: 'completed',
          response,
          expiresAt: Date.now() + this.options.idempotencyTtlMs,
        });
      }
      return response;
    };

    const promise = executeDebit();

    if (idempotencyKey) {
      this.idempotencyStore.set(idempotencyKey, {
        fingerprint,
        status: 'in_flight',
        promise,
        expiresAt: now + this.options.idempotencyTtlMs,
      });
    }

    try {
      return await promise;
    } catch (error) {
      if (idempotencyKey) {
        this.idempotencyStore.delete(idempotencyKey);
      }
      throw error;
    }
  }
}

