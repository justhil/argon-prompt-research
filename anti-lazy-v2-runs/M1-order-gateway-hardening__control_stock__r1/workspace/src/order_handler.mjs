import crypto from 'node:crypto';

const DEFAULT_OPTIONS = {
  // Idempotency options
  idempotencyTtlMs: 24 * 60 * 60 * 1000, // 24h
  maxIdempotencyEntries: 10000,
  waitOnInFlightIdempotency: false, // false = return 409 Conflict for concurrent duplicate; true = await in-flight

  // Rate limiting options
  rateLimit: {
    enabled: true,
    windowMs: 60 * 1000,
    maxRequests: 100, // global max requests per window
    perUserMaxRequests: 20, // per-user max requests per window
    maxConcurrent: 50, // bulkhead max concurrent requests
  },

  // Downstream resilience options (Timeout + Retry + Circuit Breaker)
  resilience: {
    timeoutMs: 3000,
    maxRetries: 2,
    baseRetryDelayMs: 50,
    maxRetryDelayMs: 1000,
    jitter: true,
    failureThreshold: 5, // consecutive failures to open circuit
    resetTimeoutMs: 10000, // open -> half-open cooldown
    halfOpenMaxCalls: 1, // allowed probe requests in half-open state
  },
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

function computePayloadFingerprint(req) {
  const payload = {
    userId: req?.userId ?? null,
    amount: req?.amount ?? null,
    items: req?.items ?? null,
  };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export class OrderHandler {
  constructor(paymentGateway, options = {}) {
    if (!paymentGateway || typeof paymentGateway.charge !== 'function') {
      throw new TypeError('Valid paymentGateway with a charge(userId, amount) method is required');
    }

    this.paymentGateway = paymentGateway;
    this.options = this._mergeOptions(options);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();

    // Order storage
    this.orders = new Map();
    this._orderSeq = 0;

    // Idempotency storage: key -> { status: 'IN_FLIGHT' | 'COMPLETED', fingerprint, response, createdAt, updatedAt, expiresAt, promise }
    this.idempotencyStore = new Map();

    // Rate Limiter state (Sliding window / token bucket hybrid + concurrency bulkhead)
    this._globalTimestamps = [];
    this._userTimestamps = new Map();
    this._activeRequests = 0;

    // Circuit Breaker state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    this._circuitState = 'CLOSED';
    this._consecutiveFailures = 0;
    this._circuitOpenedAt = 0;
    this._halfOpenActiveCalls = 0;
    this._halfOpenSuccesses = 0;

    // Observability metrics
    this.metrics = {
      totalRequests: 0,
      successfulOrders: 0,
      idempotentHits: 0,
      idempotentConflicts: 0,
      rateLimited: 0,
      circuitRejected: 0,
      downstreamRetries: 0,
      downstreamTimeouts: 0,
      downstreamFailures: 0,
    };
  }

  _mergeOptions(options) {
    const rateLimit = {
      ...DEFAULT_OPTIONS.rateLimit,
      ...(options.rateLimit || {}),
    };
    if (options.maxRequests !== undefined) rateLimit.maxRequests = options.maxRequests;
    if (options.perUserMaxRequests !== undefined) rateLimit.perUserMaxRequests = options.perUserMaxRequests;
    if (options.windowMs !== undefined) rateLimit.windowMs = options.windowMs;
    if (options.maxConcurrent !== undefined) rateLimit.maxConcurrent = options.maxConcurrent;

    const resilience = {
      ...DEFAULT_OPTIONS.resilience,
      ...(options.resilience || {}),
    };
    if (options.timeoutMs !== undefined) resilience.timeoutMs = options.timeoutMs;
    if (options.maxRetries !== undefined) resilience.maxRetries = options.maxRetries;
    if (options.baseRetryDelayMs !== undefined) resilience.baseRetryDelayMs = options.baseRetryDelayMs;
    if (options.failureThreshold !== undefined) resilience.failureThreshold = options.failureThreshold;
    if (options.resetTimeoutMs !== undefined) resilience.resetTimeoutMs = options.resetTimeoutMs;

    return {
      ...DEFAULT_OPTIONS,
      ...options,
      rateLimit,
      resilience,
    };
  }

  async createOrder(req) {
    this.metrics.totalRequests += 1;

    // 1. Input Validation
    const validationError = this._validateRequest(req);
    if (validationError) {
      return {
        status: 400,
        error: {
          code: 'INVALID_REQUEST',
          message: validationError,
        },
      };
    }

    const { idempotencyKey, userId, amount, items } = req;
    const fingerprint = computePayloadFingerprint(req);

    // 2. Idempotency Pre-Check (Completed cache hit or In-Flight conflict before consuming downstream quota)
    this._evictExpiredIdempotencyEntries();
    if (idempotencyKey) {
      const existing = this.idempotencyStore.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          this.metrics.idempotentConflicts += 1;
          return {
            status: 422,
            error: {
              code: 'IDEMPOTENCY_PARAMETER_MISMATCH',
              message: 'Idempotency key is already used with different request parameters',
            },
          };
        }

        if (existing.status === 'COMPLETED') {
          this.metrics.idempotentHits += 1;
          return {
            ...existing.response,
            idempotentReplayed: true,
          };
        }

        if (existing.status === 'IN_FLIGHT') {
          if (this.options.waitOnInFlightIdempotency && existing.promise) {
            try {
              const sharedRes = await existing.promise;
              this.metrics.idempotentHits += 1;
              return { ...sharedRes, idempotentReplayed: true };
            } catch {
              // If the in-flight execution failed and released the lock, fall through or return conflict
            }
          }
          this.metrics.idempotentConflicts += 1;
          return {
            status: 409,
            error: {
              code: 'IDEMPOTENCY_IN_FLIGHT',
              message: 'A request with the same idempotencyKey is currently being processed',
            },
          };
        }
      }
    }

    // 3. Rate Limiting & Bulkhead Protection
    const rateLimitError = this._checkRateLimit(userId);
    if (rateLimitError) {
      this.metrics.rateLimited += 1;
      return rateLimitError;
    }

    // 4. Acquire Idempotency In-Flight Lock & Concurrency Slot
    this._activeRequests += 1;
    let resolveInFlight;
    let rejectInFlight;
    const inFlightPromise = new Promise((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    // Prevent unhandled rejection when no concurrent caller awaits inFlightPromise
    inFlightPromise.catch(() => {});

    if (idempotencyKey) {
      const now = this.now();
      this._ensureIdempotencyCapacity();
      this.idempotencyStore.set(idempotencyKey, {
        status: 'IN_FLIGHT',
        fingerprint,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.options.idempotencyTtlMs,
        promise: inFlightPromise,
      });
    }

    try {
      // 5. Execute Downstream Payment with Circuit Breaker, Timeout & Retry
      const chargeRes = await this._chargeWithResilience(req);

      // 6. Persist Order
      this._orderSeq += 1;
      const orderId = `ord_${this._orderSeq}`;
      const order = {
        orderId,
        ...req,
        chargeId: chargeRes.chargeId,
        status: 'PAID',
        createdAt: this.now(),
      };
      this.orders.set(orderId, order);
      this.metrics.successfulOrders += 1;

      const response = { status: 200, data: order };

      // 7. Commit Idempotency Record
      if (idempotencyKey) {
        const now = this.now();
        this.idempotencyStore.set(idempotencyKey, {
          status: 'COMPLETED',
          fingerprint,
          response,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + this.options.idempotencyTtlMs,
        });
      }

      resolveInFlight(response);
      return response;
    } catch (err) {
      // Release idempotency lock on failure if not a deterministic permanent failure,
      // allowing safe client retry with the same idempotencyKey.
      if (idempotencyKey) {
        this.idempotencyStore.delete(idempotencyKey);
      }
      rejectInFlight(err);

      return this._mapDownstreamErrorToResponse(err);
    } finally {
      this._activeRequests = Math.max(0, this._activeRequests - 1);
    }
  }

  _validateRequest(req) {
    if (!req || typeof req !== 'object') {
      return 'Request body must be a non-null object';
    }
    if (typeof req.userId !== 'string' || req.userId.trim() === '') {
      return 'userId must be a non-empty string';
    }
    if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) {
      return 'amount must be a positive finite number';
    }
    if (req.idempotencyKey !== undefined && req.idempotencyKey !== null) {
      if (typeof req.idempotencyKey !== 'string' || req.idempotencyKey.trim() === '') {
        return 'idempotencyKey must be a non-empty string when provided';
      }
      if (req.idempotencyKey.length > 256) {
        return 'idempotencyKey exceeds maximum length of 256 characters';
      }
    }
    if (req.items !== undefined && !Array.isArray(req.items)) {
      return 'items must be an array when provided';
    }
    return null;
  }

  _checkRateLimit(userId) {
    const rl = this.options.rateLimit;
    if (!rl || rl.enabled === false) {
      return null;
    }

    // Bulkhead concurrency check
    if (Number.isFinite(rl.maxConcurrent) && this._activeRequests >= rl.maxConcurrent) {
      return {
        status: 429,
        retryAfterMs: 100,
        error: {
          code: 'MAX_CONCURRENCY_EXCEEDED',
          message: 'Too many concurrent requests in flight',
        },
      };
    }

    const now = this.now();
    const windowStart = now - rl.windowMs;

    // Prune global sliding window
    while (this._globalTimestamps.length > 0 && this._globalTimestamps[0] <= windowStart) {
      this._globalTimestamps.shift();
    }

    if (Number.isFinite(rl.maxRequests) && this._globalTimestamps.length >= rl.maxRequests) {
      const retryAfterMs = Math.max(1, this._globalTimestamps[0] + rl.windowMs - now);
      return {
        status: 429,
        retryAfterMs,
        error: {
          code: 'GLOBAL_RATE_LIMIT_EXCEEDED',
          message: 'Global rate limit exceeded, please try again later',
        },
      };
    }

    // Per-user sliding window check
    let userWindow = this._userTimestamps.get(userId);
    if (!userWindow) {
      userWindow = [];
      this._userTimestamps.set(userId, userWindow);
    }
    while (userWindow.length > 0 && userWindow[0] <= windowStart) {
      userWindow.shift();
    }

    if (Number.isFinite(rl.perUserMaxRequests) && userWindow.length >= rl.perUserMaxRequests) {
      const retryAfterMs = Math.max(1, userWindow[0] + rl.windowMs - now);
      return {
        status: 429,
        retryAfterMs,
        error: {
          code: 'USER_RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded for user ${userId}`,
        },
      };
    }

    // Record admitted request timestamp
    this._globalTimestamps.push(now);
    userWindow.push(now);

    // Periodic cleanup of idle user windows to prevent memory leak
    if (this._userTimestamps.size > 5000) {
      for (const [u, ts] of this._userTimestamps.entries()) {
        if (ts.length === 0 || ts[ts.length - 1] <= windowStart) {
          this._userTimestamps.delete(u);
        }
      }
    }

    return null;
  }

  async _chargeWithResilience(req) {
    // Check Circuit Breaker state before attempting call
    this._AcquireCircuitPermission();

    const { maxRetries, baseRetryDelayMs, maxRetryDelayMs, jitter, timeoutMs } = this.options.resilience;
    let attempt = 0;
    let lastError;

    try {
      while (attempt <= maxRetries) {
        try {
          const result = await this._invokeWithTimeout(
            () => this.paymentGateway.charge(req.userId, req.amount, { idempotencyKey: req.idempotencyKey }),
            timeoutMs
          );

          if (!result || typeof result.chargeId !== 'string' || !result.chargeId) {
            const invalidResErr = new Error('Invalid response from payment gateway: missing chargeId');
            invalidResErr.code = 'BAD_GATEWAY_RESPONSE';
            invalidResErr.retryable = true;
            throw invalidResErr;
          }

          this._onDownstreamSuccess();
          return result;
        } catch (err) {
          lastError = err;
          if (err?.code === 'GATEWAY_TIMEOUT') {
            this.metrics.downstreamTimeouts += 1;
          }

          const retryable = this._isRetryableError(err);
          if (!retryable || attempt >= maxRetries) {
            break;
          }

          attempt += 1;
          this.metrics.downstreamRetries += 1;
          const delay = this._computeBackoffDelay(attempt, baseRetryDelayMs, maxRetryDelayMs, jitter);
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // All attempts exhausted or non-retryable error thrown
      if (this._shouldCountTowardCircuitBreaker(lastError)) {
        this._onDownstreamFailure();
      }
      this.metrics.downstreamFailures += 1;
      throw lastError;
    } finally {
      if (this._circuitState === 'HALF_OPEN' && this._halfOpenActiveCalls > 0) {
        this._halfOpenActiveCalls = Math.max(0, this._halfOpenActiveCalls - 1);
      }
    }
  }

  _AcquireCircuitPermission() {
    const { resetTimeoutMs, halfOpenMaxCalls } = this.options.resilience;
    const now = this.now();

    if (this._circuitState === 'OPEN') {
      if (now - this._circuitOpenedAt >= resetTimeoutMs) {
        this._circuitState = 'HALF_OPEN';
        this._halfOpenActiveCalls = 0;
        this._halfOpenSuccesses = 0;
      } else {
        this.metrics.circuitRejected += 1;
        const err = new Error('Payment service circuit breaker is OPEN');
        err.code = 'CIRCUIT_OPEN';
        err.retryable = false;
        throw err;
      }
    }

    if (this._circuitState === 'HALF_OPEN') {
      if (this._halfOpenActiveCalls >= halfOpenMaxCalls) {
        this.metrics.circuitRejected += 1;
        const err = new Error('Payment service circuit breaker is HALF_OPEN and at probe capacity');
        err.code = 'CIRCUIT_OPEN';
        err.retryable = false;
        throw err;
      }
      this._halfOpenActiveCalls += 1;
    }
  }

  _onDownstreamSuccess() {
    if (this._circuitState === 'HALF_OPEN') {
      this._halfOpenSuccesses += 1;
      this._circuitState = 'CLOSED';
      this._consecutiveFailures = 0;
      this._halfOpenActiveCalls = 0;
    } else {
      this._consecutiveFailures = 0;
    }
  }

  _onDownstreamFailure() {
    const { failureThreshold } = this.options.resilience;
    this._consecutiveFailures += 1;

    if (this._circuitState === 'HALF_OPEN' || this._consecutiveFailures >= failureThreshold) {
      this._circuitState = 'OPEN';
      this._circuitOpenedAt = this.now();
      this._halfOpenActiveCalls = 0;
    }
  }

  _invokeWithTimeout(fn, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve().then(fn);
    }

    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        timer = null;
        const timeoutErr = new Error(`Payment gateway request timed out after ${timeoutMs}ms`);
        timeoutErr.code = 'GATEWAY_TIMEOUT';
        timeoutErr.retryable = true;
        reject(timeoutErr);
      }, timeoutMs);

      Promise.resolve()
        .then(fn)
        .then(
          (val) => {
            if (timer) {
              clearTimeout(timer);
              resolve(val);
            }
          },
          (err) => {
            if (timer) {
              clearTimeout(timer);
              reject(err);
            }
          }
        );
    });
  }

  _isRetryableError(err) {
    if (!err) return false;
    if (err.retryable === false) return false;
    if (err.retryable === true) return true;

    // Non-retryable business / client errors (4xx except 408/429)
    const nonRetryableCodes = new Set([
      'INSUFFICIENT_FUNDS',
      'CARD_DECLINED',
      'INVALID_ACCOUNT',
      'FRAUD_DETECTED',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_ARGUMENT',
    ]);
    if (err.code && nonRetryableCodes.has(err.code)) {
      return false;
    }
    if (typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
      return false;
    }

    // Transient network / server / timeout errors default to retryable
    return true;
  }

  _shouldCountTowardCircuitBreaker(err) {
    if (!err) return true;
    if (err.code === 'CIRCUIT_OPEN') return false;
    // Business declines (e.g., card declined / insufficient funds) mean the gateway itself is healthy
    return this._isRetryableError(err);
  }

  _computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitter) {
    const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
    if (!jitter) return expDelay;
    // Full jitter between 50% and 100% of exponential delay
    return Math.floor(expDelay * (0.5 + Math.random() * 0.5));
  }

  _mapDownstreamErrorToResponse(err) {
    if (err?.code === 'CIRCUIT_OPEN') {
      return {
        status: 503,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: err.message,
        },
      };
    }

    if (err?.code === 'GATEWAY_TIMEOUT') {
      return {
        status: 504,
        error: {
          code: 'GATEWAY_TIMEOUT',
          message: err.message,
        },
      };
    }

    if (!this._isRetryableError(err)) {
      const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 402;
      return {
        status,
        error: {
          code: err?.code || 'PAYMENT_REJECTED',
          message: err?.message || 'Payment was rejected by the gateway',
        },
      };
    }

    return {
      status: 502,
      error: {
        code: err?.code || 'PAYMENT_GATEWAY_ERROR',
        message: err?.message || 'Downstream payment gateway failure',
      },
    };
  }

  _evictExpiredIdempotencyEntries() {
    if (this.idempotencyStore.size === 0) return;
    const now = this.now();
    for (const [key, entry] of this.idempotencyStore.entries()) {
      if (entry.status === 'COMPLETED' && entry.expiresAt <= now) {
        this.idempotencyStore.delete(key);
      }
    }
  }

  _ensureIdempotencyCapacity() {
    const maxEntries = this.options.maxIdempotencyEntries;
    if (!Number.isFinite(maxEntries) || this.idempotencyStore.size < maxEntries) {
      return;
    }
    // Evict oldest completed entry (Map preserves insertion order)
    for (const [key, entry] of this.idempotencyStore.entries()) {
      if (entry.status === 'COMPLETED') {
        this.idempotencyStore.delete(key);
        if (this.idempotencyStore.size < maxEntries) break;
      }
    }
  }

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  getCircuitState() {
    // Refresh OPEN -> HALF_OPEN transition if cooldown elapsed
    if (
      this._circuitState === 'OPEN' &&
      this.now() - this._circuitOpenedAt >= this.options.resilience.resetTimeoutMs
    ) {
      return 'HALF_OPEN';
    }
    return this._circuitState;
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeRequests: this._activeRequests,
      circuitState: this.getCircuitState(),
      ordersCount: this.orders.size,
      idempotencyEntriesCount: this.idempotencyStore.size,
    };
  }
}
