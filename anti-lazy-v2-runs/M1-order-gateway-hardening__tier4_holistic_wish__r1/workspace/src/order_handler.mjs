import crypto from 'node:crypto';

export const CircuitState = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

export const ErrorCode = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_FLIGHT: 'IDEMPOTENCY_IN_FLIGHT',
  RATE_LIMITED: 'RATE_LIMITED',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
});

/**
 * Deterministically serialize a value for payload fingerprinting.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const entries = [];
  for (const k of keys) {
    if (value[k] !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalize(value[k])}`);
    }
  }
  return '{' + entries.join(',') + '}';
}

function computePayloadHash(req) {
  const payload = {
    userId: req.userId,
    amount: req.amount,
    items: req.items ?? null,
    currency: req.currency ?? 'USD',
  };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return structuredClone(obj);
}

export class OrderHandler {
  constructor(paymentGateway, options = {}) {
    if (!paymentGateway || typeof paymentGateway.charge !== 'function') {
      throw new TypeError('paymentGateway with a charge(userId, amount, ...) method is required');
    }

    this.paymentGateway = paymentGateway;
    this.options = options;
    this.orders = new Map();
    this._orderSeq = 0;

    // Clock function for deterministic testing
    this._now = typeof options.nowFn === 'function'
      ? options.nowFn
      : typeof options.clock === 'function'
        ? options.clock
        : () => Date.now();

    // 1. Idempotency configuration & state
    const idemOpts = options.idempotency && typeof options.idempotency === 'object' ? options.idempotency : {};
    this.idempotencyConfig = {
      ttlMs: idemOpts.ttlMs ?? options.idempotencyTtlMs ?? options.ttlMs ?? 24 * 60 * 60 * 1000,
      maxEntries: idemOpts.maxEntries ?? options.maxIdempotencyEntries ?? 10_000,
      inFlightStrategy: idemOpts.inFlightStrategy ?? options.inFlightStrategy ?? 'wait', // 'wait' | 'reject'
      conflictStatus: idemOpts.conflictStatus ?? options.conflictStatus ?? 409,
      requireKey: idemOpts.requireKey ?? options.requireIdempotencyKey ?? false,
    };
    // Map<idempotencyKey, { status: 'IN_FLIGHT' | 'COMPLETED', payloadHash, promise?, response?, createdAt, expiresAt }>
    this.idempotencyStore = new Map();

    // 2. Rate limiter configuration & state (Sliding window + Token bucket hybrid)
    const rlOpts = options.rateLimit && typeof options.rateLimit === 'object' ? options.rateLimit : {};
    this.rateLimitConfig = {
      enabled: options.rateLimit !== false && rlOpts.enabled !== false,
      windowMs: rlOpts.windowMs ?? options.rateLimitWindowMs ?? options.windowMs ?? 60_000,
      maxRequestsPerUser:
        rlOpts.maxRequestsPerUser ??
        rlOpts.perUserMax ??
        rlOpts.maxRequests ??
        options.rateLimitMax ??
        options.maxRequestsPerUser ??
        options.maxRequests ??
        20,
      globalMaxRequests:
        rlOpts.globalMaxRequests ??
        rlOpts.globalMax ??
        options.globalRateLimitMax ??
        options.globalMaxRequests ??
        200,
    };
    // Map<userId, number[]> timestamps within window
    this._userRequestWindows = new Map();
    this._globalRequestWindow = [];

    // 3. Downstream fault tolerance configuration (Timeout + Retry + Circuit Breaker)
    const retryOpts = options.retry && typeof options.retry === 'object' ? options.retry : {};
    this.retryConfig = {
      maxRetries: retryOpts.maxRetries ?? retryOpts.retries ?? options.maxRetries ?? options.retries ?? 2,
      baseDelayMs: retryOpts.baseDelayMs ?? retryOpts.delayMs ?? options.retryDelayMs ?? options.baseDelayMs ?? 25,
      maxDelayMs: retryOpts.maxDelayMs ?? options.maxRetryDelayMs ?? 1000,
      backoffFactor: retryOpts.backoffFactor ?? retryOpts.factor ?? options.backoffFactor ?? 2,
      jitter: retryOpts.jitter ?? options.jitter ?? false,
    };

    this.timeoutMs =
      options.timeoutMs ??
      options.paymentTimeoutMs ??
      retryOpts.timeoutMs ??
      2000;

    const cbOpts = options.circuitBreaker && typeof options.circuitBreaker === 'object' ? options.circuitBreaker : {};
    this.circuitConfig = {
      enabled: options.circuitBreaker !== false && cbOpts.enabled !== false,
      failureThreshold: cbOpts.failureThreshold ?? options.failureThreshold ?? 5,
      resetTimeoutMs: cbOpts.resetTimeoutMs ?? cbOpts.cooldownMs ?? options.resetTimeoutMs ?? options.circuitResetTimeoutMs ?? 10_000,
      halfOpenMaxCalls: cbOpts.halfOpenMaxCalls ?? cbOpts.halfOpenMaxAttempts ?? options.halfOpenMaxCalls ?? 1,
      successThreshold: cbOpts.successThreshold ?? options.successThreshold ?? 1,
    };

    this._circuit = {
      state: CircuitState.CLOSED,
      consecutiveFailures: 0,
      halfOpenSuccesses: 0,
      halfOpenInFlight: 0,
      openedAt: 0,
      lastError: null,
    };

    // 4. Telemetry / Metrics
    this._metrics = {
      totalRequests: 0,
      ordersCreated: 0,
      idempotentHits: 0,
      idempotentConflicts: 0,
      rateLimited: 0,
      paymentAttempts: 0,
      paymentRetries: 0,
      paymentFailures: 0,
      paymentTimeouts: 0,
      circuitShortCircuits: 0,
      circuitTrips: 0,
    };
  }

  /**
   * Main entry point to create and pay for an order with idempotency, rate limiting,
   * timeout, retry with backoff, and circuit breaker protection.
   */
  async createOrder(req) {
    this._metrics.totalRequests += 1;

    // Step 1: Validate request parameters
    const validationError = this._validateRequest(req);
    if (validationError) {
      return validationError;
    }

    const now = this._now();
    this.cleanupExpired(now);

    const idempotencyKey = req.idempotencyKey != null ? String(req.idempotencyKey).trim() : '';

    // Step 2: Idempotency check (prior to rate limit consumption for already-completed orders, or in-flight deduplication)
    if (idempotencyKey) {
      const payloadHash = computePayloadHash(req);
      const existing = this.idempotencyStore.get(idempotencyKey);

      if (existing && existing.expiresAt > now) {
        // Verify payload consistency
        if (existing.payloadHash !== payloadHash) {
          this._metrics.idempotentConflicts += 1;
          return {
            status: this.idempotencyConfig.conflictStatus,
            code: ErrorCode.IDEMPOTENCY_CONFLICT,
            error: `Idempotency key "${idempotencyKey}" was already used with a different request payload`,
          };
        }

        if (existing.status === 'COMPLETED') {
          this._metrics.idempotentHits += 1;
          const cloned = deepClone(existing.response);
          return {
            ...cloned,
            replayed: true,
            headers: {
              ...(cloned.headers || {}),
              'X-Idempotent-Replayed': 'true',
            },
          };
        }

        if (existing.status === 'IN_FLIGHT') {
          if (this.idempotencyConfig.inFlightStrategy === 'reject') {
            this._metrics.idempotentConflicts += 1;
            return {
              status: this.idempotencyConfig.conflictStatus,
              code: ErrorCode.IDEMPOTENCY_IN_FLIGHT,
              error: `Request with idempotency key "${idempotencyKey}" is currently in flight`,
              retryAfterMs: 100,
              headers: { 'Retry-After': '1' },
            };
          }

          // Coalesce concurrent identical requests so downstream payment is only invoked once
          this._metrics.idempotentHits += 1;
          const result = await existing.promise;
          const cloned = deepClone(result);
          return {
            ...cloned,
            replayed: true,
            headers: {
              ...(cloned.headers || {}),
              'X-Idempotent-Replayed': 'true',
            },
          };
        }
      }

      // Register IN_FLIGHT lock before any async operation
      let resolveInFlight;
      const inFlightPromise = new Promise((resolve) => {
        resolveInFlight = resolve;
      });

      this._enforceIdempotencyCapacity(now);
      const record = {
        status: 'IN_FLIGHT',
        payloadHash,
        promise: inFlightPromise,
        response: null,
        createdAt: now,
        expiresAt: now + this.idempotencyConfig.ttlMs,
      };
      this.idempotencyStore.set(idempotencyKey, record);

      try {
        const response = await this._processOrderExecution(req);
        if (response.status >= 200 && response.status < 300) {
          record.status = 'COMPLETED';
          record.response = deepClone(response);
          record.expiresAt = this._now() + this.idempotencyConfig.ttlMs;
        } else {
          // Release idempotency lock on failed attempts (e.g. rate limit, transient 5xx, payment failure)
          // so the client can safely retry with the same idempotencyKey
          this.idempotencyStore.delete(idempotencyKey);
        }
        resolveInFlight(response);
        return response;
      } catch (unexpectedErr) {
        this.idempotencyStore.delete(idempotencyKey);
        const fallbackResp = {
          status: 500,
          code: ErrorCode.PAYMENT_FAILED,
          error: unexpectedErr?.message || 'Unexpected internal error',
        };
        resolveInFlight(fallbackResp);
        return fallbackResp;
      }
    }

    // No idempotencyKey provided
    return this._processOrderExecution(req);
  }

  async _processOrderExecution(req) {
    // Step 3: Rate limit check (per-user + global)
    const rateLimitResult = this._checkAndConsumeRateLimit(req.userId);
    if (!rateLimitResult.allowed) {
      this._metrics.rateLimited += 1;
      const retryAfterSec = Math.max(1, Math.ceil(rateLimitResult.retryAfterMs / 1000));
      return {
        status: 429,
        code: ErrorCode.RATE_LIMITED,
        error: `Rate limit exceeded (${rateLimitResult.scope}). Please retry after ${rateLimitResult.retryAfterMs}ms`,
        scope: rateLimitResult.scope,
        retryAfterMs: rateLimitResult.retryAfterMs,
        retryAfter: retryAfterSec,
        headers: {
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Reset-Ms': String(rateLimitResult.retryAfterMs),
        },
      };
    }

    // Step 4: Circuit Breaker check + Downstream payment execution with retry & timeout
    const paymentOutcome = await this._executePaymentWithResilience(req);
    if (!paymentOutcome.ok) {
      return paymentOutcome.response;
    }

    const res = paymentOutcome.data;
    this._orderSeq += 1;
    const orderId = `ord_${this._orderSeq}`;
    const createdAt = this._now();

    const order = {
      orderId,
      ...req,
      chargeId: res.chargeId,
      status: 'PAID',
      createdAt,
    };

    this.orders.set(orderId, order);
    this._metrics.ordersCreated += 1;

    return {
      status: 200,
      data: deepClone(order),
    };
  }

  _validateRequest(req) {
    if (!req || typeof req !== 'object') {
      return {
        status: 400,
        code: ErrorCode.INVALID_REQUEST,
        error: 'Request body must be a valid object',
      };
    }

    if (this.idempotencyConfig.requireKey && (!req.idempotencyKey || typeof req.idempotencyKey !== 'string' || !req.idempotencyKey.trim())) {
      return {
        status: 400,
        code: ErrorCode.INVALID_REQUEST,
        error: 'idempotencyKey is required',
      };
    }

    if (req.userId === undefined || req.userId === null || String(req.userId).trim() === '') {
      return {
        status: 400,
        code: ErrorCode.INVALID_REQUEST,
        error: 'Valid userId is required',
      };
    }

    if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) {
      return {
        status: 400,
        code: ErrorCode.INVALID_REQUEST,
        error: 'amount must be a finite positive number',
      };
    }

    if (req.items !== undefined && !Array.isArray(req.items)) {
      return {
        status: 400,
        code: ErrorCode.INVALID_REQUEST,
        error: 'items must be an array when provided',
      };
    }

    return null;
  }

  _checkAndConsumeRateLimit(userId) {
    if (!this.rateLimitConfig.enabled) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const now = this._now();
    const windowMs = this.rateLimitConfig.windowMs;
    const cutoff = now - windowMs;

    // Prune global window
    while (this._globalRequestWindow.length > 0 && this._globalRequestWindow[0] <= cutoff) {
      this._globalRequestWindow.shift();
    }

    // Prune user window
    const userKey = String(userId);
    let userTimestamps = this._userRequestWindows.get(userKey);
    if (!userTimestamps) {
      userTimestamps = [];
      this._userRequestWindows.set(userKey, userTimestamps);
    } else {
      while (userTimestamps.length > 0 && userTimestamps[0] <= cutoff) {
        userTimestamps.shift();
      }
    }

    // Check user limit first
    if (userTimestamps.length >= this.rateLimitConfig.maxRequestsPerUser) {
      const oldest = userTimestamps[0];
      const retryAfterMs = Math.max(1, oldest + windowMs - now);
      return {
        allowed: false,
        scope: 'user',
        retryAfterMs,
      };
    }

    // Check global limit
    if (this._globalRequestWindow.length >= this.rateLimitConfig.globalMaxRequests) {
      const oldest = this._globalRequestWindow[0];
      const retryAfterMs = Math.max(1, oldest + windowMs - now);
      return {
        allowed: false,
        scope: 'global',
        retryAfterMs,
      };
    }

    // Consume token for both user and global windows
    userTimestamps.push(now);
    this._globalRequestWindow.push(now);

    return { allowed: true, retryAfterMs: 0 };
  }

  async _executePaymentWithResilience(req) {
    // Check circuit breaker before attempting payment
    const cbAllowance = this._beforeCircuitCall();
    if (!cbAllowance.allowed) {
      this._metrics.circuitShortCircuits += 1;
      const retryAfterSec = Math.max(1, Math.ceil(cbAllowance.retryAfterMs / 1000));
      return {
        ok: false,
        response: {
          status: 503,
          code: ErrorCode.CIRCUIT_OPEN,
          error: 'Payment service temporarily unavailable (circuit breaker open)',
          retryAfterMs: cbAllowance.retryAfterMs,
          headers: {
            'Retry-After': String(retryAfterSec),
          },
        },
      };
    }

    const maxAttempts = Math.max(1, 1 + this.retryConfig.maxRetries);
    let lastError = null;
    let lastTimedOut = false;

    let halfOpenSlotHeld = Boolean(cbAllowance.halfOpenProbe);
    const releaseHalfOpenSlot = () => {
      if (halfOpenSlotHeld) {
        this._circuit.halfOpenInFlight = Math.max(0, this._circuit.halfOpenInFlight - 1);
        halfOpenSlotHeld = false;
      }
    };

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // If circuit tripped during retries, stop immediately
        if (attempt > 1 && this.circuitConfig.enabled && this._circuit.state === CircuitState.OPEN) {
          break;
        }

        if (attempt > 1) {
          this._metrics.paymentRetries += 1;
          const delayMs = this._computeBackoffDelay(attempt - 1);
          if (delayMs > 0) {
            await this._sleep(delayMs);
          }
        }

        this._metrics.paymentAttempts += 1;

        try {
          const chargeRes = await this._invokeChargeWithTimeout(req);
          if (!chargeRes || typeof chargeRes.chargeId !== 'string' || !chargeRes.chargeId) {
            const invalidResErr = new Error('Invalid response from payment gateway: missing chargeId');
            invalidResErr.code = 'INVALID_GATEWAY_RESPONSE';
            throw invalidResErr;
          }

          releaseHalfOpenSlot();
          this._onCircuitSuccess();
          return { ok: true, data: chargeRes };
        } catch (err) {
          lastError = err;
          lastTimedOut = Boolean(err && err.isTimeout);

          const isBusinessRejection = this._isNonRetryableBusinessError(err);
          if (isBusinessRejection) {
            // Non-retryable client/business error (e.g., card declined, insufficient funds)
            // Does not count as downstream infrastructure failure for circuit breaker
            releaseHalfOpenSlot();
            const status = err.statusCode || err.status || 402;
            return {
              ok: false,
              response: {
                status,
                code: err.code || ErrorCode.PAYMENT_REJECTED,
                error: err.message || 'Payment rejected by gateway',
              },
            };
          }

          this._metrics.paymentFailures += 1;
          if (lastTimedOut) {
            this._metrics.paymentTimeouts += 1;
          }

          // Record infrastructure failure against circuit breaker
          releaseHalfOpenSlot();
          this._onCircuitFailure(err);

          // In HALF_OPEN state, a single probe failure re-opens the circuit immediately
          if (this.circuitConfig.enabled && this._circuit.state === CircuitState.OPEN) {
            break;
          }

          if (!this._isRetryableError(err) || attempt === maxAttempts) {
            break;
          }
        }
      }
    } finally {
      releaseHalfOpenSlot();
    }

    const status = lastTimedOut ? 504 : 502;
    const code = lastTimedOut ? ErrorCode.PAYMENT_TIMEOUT : ErrorCode.PAYMENT_FAILED;

    return {
      ok: false,
      response: {
        status,
        code,
        error: lastError?.message || 'Downstream payment gateway failure',
      },
    };
  }

  async _invokeChargeWithTimeout(req) {
    const timeoutMs = this.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return this.paymentGateway.charge(req.userId, req.amount, req);
    }

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Payment gateway charge timed out after ${timeoutMs}ms`);
        err.code = ErrorCode.PAYMENT_TIMEOUT;
        err.isTimeout = true;
        reject(err);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        Promise.resolve().then(() => this.paymentGateway.charge(req.userId, req.amount, req)),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  _isNonRetryableBusinessError(err) {
    if (!err) return false;
    if (err.retryable === false && (err.businessError === true || (err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 408 && err.statusCode !== 429))) {
      return true;
    }
    const status = err.statusCode ?? err.status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return true;
    }
    const nonRetryableCodes = new Set([
      'INSUFFICIENT_FUNDS',
      'CARD_DECLINED',
      'INVALID_CARD',
      'EXPIRED_CARD',
      'FRAUD_SUSPECTED',
      'INVALID_AMOUNT',
    ]);
    if (err.code && nonRetryableCodes.has(String(err.code).toUpperCase())) {
      return true;
    }
    return false;
  }

  _isRetryableError(err) {
    if (!err) return true;
    if (err.retryable === false) return false;
    if (this._isNonRetryableBusinessError(err)) return false;
    return true;
  }

  _computeBackoffDelay(retryIndex) {
    const { baseDelayMs, maxDelayMs, backoffFactor, jitter } = this.retryConfig;
    if (baseDelayMs <= 0) return 0;
    const exponential = baseDelayMs * Math.pow(backoffFactor, Math.max(0, retryIndex - 1));
    const capped = Math.min(maxDelayMs, exponential);
    if (!jitter) {
      return Math.round(capped);
    }
    // Full jitter between 50% and 100% of capped delay
    const factor = 0.5 + Math.random() * 0.5;
    return Math.round(capped * factor);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _beforeCircuitCall() {
    if (!this.circuitConfig.enabled) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const now = this._now();

    if (this._circuit.state === CircuitState.OPEN) {
      const elapsed = now - this._circuit.openedAt;
      if (elapsed >= this.circuitConfig.resetTimeoutMs) {
        // Transition OPEN -> HALF_OPEN
        this._circuit.state = CircuitState.HALF_OPEN;
        this._circuit.halfOpenSuccesses = 0;
        this._circuit.halfOpenInFlight = 0;
      } else {
        return {
          allowed: false,
          retryAfterMs: Math.max(1, this.circuitConfig.resetTimeoutMs - elapsed),
        };
      }
    }

    if (this._circuit.state === CircuitState.HALF_OPEN) {
      if (this._circuit.halfOpenInFlight >= this.circuitConfig.halfOpenMaxCalls) {
        return {
          allowed: false,
          retryAfterMs: Math.max(1, Math.min(500, this.circuitConfig.resetTimeoutMs)),
        };
      }
      this._circuit.halfOpenInFlight += 1;
      return { allowed: true, retryAfterMs: 0, halfOpenProbe: true };
    }

    return { allowed: true, retryAfterMs: 0, halfOpenProbe: false };
  }

  _onCircuitSuccess() {
    if (!this.circuitConfig.enabled) return;

    if (this._circuit.state === CircuitState.HALF_OPEN) {
      this._circuit.halfOpenSuccesses += 1;
      if (this._circuit.halfOpenSuccesses >= this.circuitConfig.successThreshold) {
        this._circuit.state = CircuitState.CLOSED;
        this._circuit.consecutiveFailures = 0;
        this._circuit.halfOpenSuccesses = 0;
        this._circuit.halfOpenInFlight = 0;
        this._circuit.lastError = null;
      }
    } else {
      this._circuit.consecutiveFailures = 0;
    }
  }

  _onCircuitFailure(err) {
    if (!this.circuitConfig.enabled) return;

    const now = this._now();
    this._circuit.lastError = err?.message || String(err);

    if (this._circuit.state === CircuitState.HALF_OPEN) {
      // Probe failed: immediately re-open circuit
      this._circuit.state = CircuitState.OPEN;
      this._circuit.openedAt = now;
      this._circuit.halfOpenSuccesses = 0;
      this._circuit.halfOpenInFlight = 0;
      this._metrics.circuitTrips += 1;
      return;
    }

    this._circuit.consecutiveFailures += 1;
    if (this._circuit.consecutiveFailures >= this.circuitConfig.failureThreshold) {
      this._circuit.state = CircuitState.OPEN;
      this._circuit.openedAt = now;
      this._metrics.circuitTrips += 1;
    }
  }

  _enforceIdempotencyCapacity(now) {
    if (this.idempotencyStore.size < this.idempotencyConfig.maxEntries) {
      return;
    }
    this.cleanupExpired(now);
    if (this.idempotencyStore.size < this.idempotencyConfig.maxEntries) {
      return;
    }
    // Evict oldest completed entry
    for (const [key, entry] of this.idempotencyStore.entries()) {
      if (entry.status === 'COMPLETED') {
        this.idempotencyStore.delete(key);
        if (this.idempotencyStore.size < this.idempotencyConfig.maxEntries) {
          break;
        }
      }
    }
  }

  /**
   * Prune expired idempotency records and stale rate-limiting windows.
   */
  cleanupExpired(now = this._now()) {
    let removedIdempotency = 0;
    for (const [key, entry] of this.idempotencyStore.entries()) {
      if (entry.status !== 'IN_FLIGHT' && entry.expiresAt <= now) {
        this.idempotencyStore.delete(key);
        removedIdempotency += 1;
      }
    }

    const cutoff = now - this.rateLimitConfig.windowMs;
    for (const [userKey, timestamps] of this._userRequestWindows.entries()) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this._userRequestWindows.delete(userKey);
      }
    }
    while (this._globalRequestWindow.length > 0 && this._globalRequestWindow[0] <= cutoff) {
      this._globalRequestWindow.shift();
    }

    return removedIdempotency;
  }

  /**
   * Retrieve an order by orderId.
   */
  getOrder(orderId) {
    const order = this.orders.get(orderId);
    return order ? deepClone(order) : null;
  }

  /**
   * Inspect current circuit breaker state.
   */
  getCircuitState() {
    if (this.circuitConfig.enabled && this._circuit.state === CircuitState.OPEN) {
      const elapsed = this._now() - this._circuit.openedAt;
      if (elapsed >= this.circuitConfig.resetTimeoutMs) {
        return CircuitState.HALF_OPEN;
      }
    }
    return this._circuit.state;
  }

  /**
   * Manually reset the circuit breaker to CLOSED.
   */
  resetCircuit() {
    this._circuit.state = CircuitState.CLOSED;
    this._circuit.consecutiveFailures = 0;
    this._circuit.halfOpenSuccesses = 0;
    this._circuit.halfOpenInFlight = 0;
    this._circuit.openedAt = 0;
    this._circuit.lastError = null;
  }

  /**
   * Return operational telemetry & metrics snapshot.
   */
  getMetrics() {
    return {
      ...this._metrics,
      circuitState: this.getCircuitState(),
      consecutiveFailures: this._circuit.consecutiveFailures,
      activeOrders: this.orders.size,
      idempotencyCacheSize: this.idempotencyStore.size,
    };
  }
}
