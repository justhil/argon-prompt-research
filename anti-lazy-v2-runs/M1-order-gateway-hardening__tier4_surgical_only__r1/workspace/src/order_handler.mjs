import crypto from 'node:crypto';

const DEFAULT_OPTIONS = {
  now: () => Date.now(),
  // 1. 幂等防重配置 (Idempotency)
  idempotency: {
    ttlMs: 24 * 60 * 60 * 1000, // 幂等记录有效期 24h
    lockTtlMs: 30 * 1000,       // 处理中并发锁超时 30s
    maxEntries: 10000,          // 内存缓存最大条目数（防OOM）
    awaitInFlight: false,       // true: 等待同key并发请求结果; false: 返回 409 PROCESSING
  },
  // 2. 限流保护配置 (Rate Limiting & Concurrency)
  rateLimit: {
    globalCapacity: 100,        // 全局限流桶容量
    globalRefillPerSec: 50,     // 全局每秒补充令牌数
    userCapacity: 10,           // 单用户限流桶容量
    userRefillPerSec: 2,        // 单用户每秒补充令牌数
    maxConcurrent: 50,          // 最大并发下单数（舱壁隔离）
    userBucketTtlMs: 10 * 60 * 1000,
    maxUserBuckets: 10000,
  },
  // 3. 下游支付容错配置 (Resilience: Timeout, Retry, Circuit Breaker)
  resilience: {
    timeoutMs: 3000,            // 单次支付调用超时时间
    maxRetries: 2,              // 瞬态故障最大重试次数
    baseDelayMs: 100,           // 指数退避基础延迟
    maxDelayMs: 1000,           // 最大退避延迟
    jitter: true,               // 是否开启随机抖动
    failureThreshold: 5,        // 触发熔断的连续失败阈值
    resetTimeoutMs: 10000,      // 熔断器 OPEN -> HALF_OPEN 冷却时间
    halfOpenMaxCalls: 2,        // HALF_OPEN 状态允许的探测并发/成功阈值
  },
};

export const CircuitState = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

/**
 * 令牌桶实现
 */
class TokenBucket {
  constructor(capacity, refillPerSec, nowFn = () => Date.now()) {
    this.capacity = Math.max(1, capacity);
    this.refillPerMs = refillPerSec / 1000;
    this.tokens = this.capacity;
    this.nowFn = nowFn;
    this.lastRefillTime = this.nowFn();
    this.lastAccessTime = this.lastRefillTime;
  }

  tryConsume(count = 1) {
    const now = this.nowFn();
    this.lastAccessTime = now;
    const elapsed = Math.max(0, now - this.lastRefillTime);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefillTime = now;
    }

    if (this.tokens >= count) {
      this.tokens -= count;
      return { allowed: true, remaining: Math.floor(this.tokens), retryAfterMs: 0 };
    }

    const deficit = count - this.tokens;
    const retryAfterMs = this.refillPerMs > 0 ? Math.ceil(deficit / this.refillPerMs) : 1000;
    return { allowed: false, remaining: 0, retryAfterMs };
  }
}

export class OrderHandler {
  constructor(paymentGateway, options = {}) {
    if (!paymentGateway || typeof paymentGateway.charge !== 'function') {
      throw new TypeError('Valid paymentGateway with a charge() method is required');
    }

    this.paymentGateway = paymentGateway;
    this.options = this._mergeOptions(options);
    this.now = this.options.now;

    // 订单存储与序列号
    this.orders = new Map();
    this.orderSeq = 0;

    // 幂等存储: key -> { status: 'IN_FLIGHT'|'COMPLETED', fingerprint, createdAt, expiresAt, response, promise, orderId }
    this.idempotencyStore = new Map();

    // 限流与并发控制状态
    this.activeRequests = 0;
    this.globalBucket = new TokenBucket(
      this.options.rateLimit.globalCapacity,
      this.options.rateLimit.globalRefillPerSec,
      this.now
    );
    this.userBuckets = new Map();

    // 熔断器状态
    this.circuit = {
      state: CircuitState.CLOSED,
      failures: 0,
      openedAt: 0,
      halfOpenInFlight: 0,
      halfOpenSuccesses: 0,
    };

    // 可观测指标
    this.metrics = {
      totalRequests: 0,
      successOrders: 0,
      idempotentHits: 0,
      idempotentConflicts: 0,
      rateLimited: 0,
      circuitRejected: 0,
      paymentRetries: 0,
      paymentFailures: 0,
    };
  }

  _mergeOptions(options) {
    return {
      now: options.now || DEFAULT_OPTIONS.now,
      idempotency: {
        ...DEFAULT_OPTIONS.idempotency,
        ...(options.idempotency || {}),
        ...(options.idempotencyTtlMs !== undefined ? { ttlMs: options.idempotencyTtlMs } : {}),
        ...(options.awaitInFlight !== undefined ? { awaitInFlight: options.awaitInFlight } : {}),
      },
      rateLimit: {
        ...DEFAULT_OPTIONS.rateLimit,
        ...(options.rateLimit || {}),
        ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
      },
      resilience: {
        ...DEFAULT_OPTIONS.resilience,
        ...(options.resilience || {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        ...(options.failureThreshold !== undefined ? { failureThreshold: options.failureThreshold } : {}),
        ...(options.resetTimeoutMs !== undefined ? { resetTimeoutMs: options.resetTimeoutMs } : {}),
      },
    };
  }

  /**
   * 创建订单主流程：参数校验 -> 幂等检查 -> 限流与并发保护 -> 下游容错支付 -> 订单落库与结果缓存
   */
  async createOrder(req) {
    this.metrics.totalRequests += 1;

    // 1. 基础请求校验
    const validationError = this._validateRequest(req);
    if (validationError) {
      return {
        status: 400,
        error: { code: 'INVALID_REQUEST', message: validationError },
      };
    }

    const { idempotencyKey, userId, amount, items } = req;
    const fingerprint = this._computeFingerprint({ userId, amount, items });

    // 2. 幂等防重检查 (在扣减限流配额前优先检查已完成或冲突的幂等请求)
    this._cleanupIdempotencyStore();
    const existingRecord = this.idempotencyStore.get(idempotencyKey);
    const now = this.now();

    if (existingRecord) {
      // 校验相同幂等键的请求体指纹是否一致，防止幂等键混用篡改参数
      if (existingRecord.fingerprint !== fingerprint) {
        this.metrics.idempotentConflicts += 1;
        return {
          status: 422,
          error: {
            code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
            message: 'Idempotency key is already used with different request parameters',
          },
        };
      }

      if (existingRecord.status === 'COMPLETED') {
        this.metrics.idempotentHits += 1;
        return {
          ...existingRecord.response,
          idempotentReplayed: true,
        };
      }

      if (existingRecord.status === 'IN_FLIGHT' && now < existingRecord.expiresAt) {
        if (this.options.idempotency.awaitInFlight && existingRecord.promise) {
          this.metrics.idempotentHits += 1;
          const res = await existingRecord.promise;
          return { ...res, idempotentReplayed: true };
        }
        this.metrics.idempotentConflicts += 1;
        return {
          status: 409,
          error: {
            code: 'ORDER_IN_PROGRESS',
            message: 'An order with the same idempotencyKey is currently being processed',
          },
        };
      }
    }

    // 3. 限流保护与并发舱壁检查
    const rateLimitResult = this._checkRateLimitAndConcurrency(userId);
    if (!rateLimitResult.allowed) {
      this.metrics.rateLimited += 1;
      return {
        status: 429,
        retryAfterMs: rateLimitResult.retryAfterMs,
        error: {
          code: rateLimitResult.code,
          message: rateLimitResult.message,
        },
      };
    }

    // 4. 预先分配订单号并写入 IN_FLIGHT 幂等锁
    const orderId = existingRecord?.orderId || `ord_${++this.orderSeq}`;
    let resolveInFlight;
    const inFlightPromise = new Promise((resolve) => {
      resolveInFlight = resolve;
    });

    const lockRecord = {
      status: 'IN_FLIGHT',
      fingerprint,
      orderId,
      createdAt: now,
      expiresAt: now + this.options.idempotency.lockTtlMs,
      promise: inFlightPromise,
      response: null,
    };
    this._setIdempotencyRecord(idempotencyKey, lockRecord);

    this.activeRequests += 1;
    try {
      // 5. 调用下游支付网关（带熔断、超时、退避重试）
      const paymentRes = await this._executePaymentWithResilience({
        userId,
        amount,
        idempotencyKey,
        orderId,
      });

      if (!paymentRes || !paymentRes.chargeId) {
        const invalidResError = new Error('Invalid payment gateway response: missing chargeId');
        invalidResError.retryable = false;
        throw invalidResError;
      }

      // 6. 构建并持久化订单
      const order = {
        orderId,
        ...req,
        chargeId: paymentRes.chargeId,
        status: 'PAID',
        createdAt: this.now(),
      };
      this.orders.set(order.orderId, order);
      this.metrics.successOrders += 1;

      const response = { status: 200, data: order };

      // 7. 锁定最终成功状态到幂等表
      const completedAt = this.now();
      this._setIdempotencyRecord(idempotencyKey, {
        status: 'COMPLETED',
        fingerprint,
        orderId,
        createdAt: lockRecord.createdAt,
        expiresAt: completedAt + this.options.idempotency.ttlMs,
        promise: null,
        response,
      });

      resolveInFlight(response);
      return response;
    } catch (err) {
      const errorResponse = this._mapPaymentErrorToResponse(err, orderId);

      // 针对确定性业务失败（如余额不足、卡被拒 402），缓存结果避免无效重放；
      // 针对瞬态错误（如超时、网络故障、熔断 502/503/504），释放幂等锁允许客户端使用原 idempotencyKey 安全重试
      if (err && err.cacheableFailure) {
        const completedAt = this.now();
        this._setIdempotencyRecord(idempotencyKey, {
          status: 'COMPLETED',
          fingerprint,
          orderId,
          createdAt: lockRecord.createdAt,
          expiresAt: completedAt + this.options.idempotency.ttlMs,
          promise: null,
          response: errorResponse,
        });
      } else {
        this.idempotencyStore.delete(idempotencyKey);
      }

      resolveInFlight(errorResponse);
      return errorResponse;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  /**
   * 校验入参合法性
   */
  _validateRequest(req) {
    if (!req || typeof req !== 'object') {
      return 'Request body must be an object';
    }
    if (typeof req.idempotencyKey !== 'string' || req.idempotencyKey.trim() === '') {
      return 'idempotencyKey is required and must be a non-empty string';
    }
    if (typeof req.userId !== 'string' || req.userId.trim() === '') {
      return 'userId is required and must be a non-empty string';
    }
    if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) {
      return 'amount must be a positive finite number';
    }
    if (req.items !== undefined && !Array.isArray(req.items)) {
      return 'items must be an array when provided';
    }
    return null;
  }

  /**
   * 计算请求内容指纹，确保相同 idempotencyKey 不会被篡改参数复用
   */
  _computeFingerprint({ userId, amount, items }) {
    const normalized = JSON.stringify({
      userId,
      amount,
      items: items ?? null,
    });
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * 清理过期及超量的幂等记录
   */
  _cleanupIdempotencyStore() {
    const now = this.now();
    for (const [key, record] of this.idempotencyStore.entries()) {
      if (now >= record.expiresAt) {
        this.idempotencyStore.delete(key);
      }
    }
  }

  _setIdempotencyRecord(key, record) {
    if (this.idempotencyStore.has(key)) {
      this.idempotencyStore.delete(key);
    } else if (this.idempotencyStore.size >= this.options.idempotency.maxEntries) {
      const oldestKey = this.idempotencyStore.keys().next().value;
      if (oldestKey !== undefined) {
        this.idempotencyStore.delete(oldestKey);
      }
    }
    this.idempotencyStore.set(key, record);
  }

  /**
   * 并发舱壁 + 全局令牌桶 + 用户级令牌桶限流检查
   */
  _checkRateLimitAndConcurrency(userId) {
    const { maxConcurrent, userCapacity, userRefillPerSec, userBucketTtlMs, maxUserBuckets } =
      this.options.rateLimit;

    // 1. 并发数限制 (Bulkhead)
    if (this.activeRequests >= maxConcurrent) {
      return {
        allowed: false,
        code: 'MAX_CONCURRENCY_EXCEEDED',
        message: 'Server busy: maximum concurrent orders exceeded',
        retryAfterMs: 100,
      };
    }

    // 2. 单用户速率限制
    this._cleanupUserBuckets(userBucketTtlMs, maxUserBuckets);
    let userBucket = this.userBuckets.get(userId);
    if (!userBucket) {
      userBucket = new TokenBucket(userCapacity, userRefillPerSec, this.now);
      this.userBuckets.set(userId, userBucket);
    }
    const userCheck = userBucket.tryConsume(1);
    if (!userCheck.allowed) {
      return {
        allowed: false,
        code: 'USER_RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded for user ${userId}`,
        retryAfterMs: userCheck.retryAfterMs,
      };
    }

    // 3. 全局速率限制
    const globalCheck = this.globalBucket.tryConsume(1);
    if (!globalCheck.allowed) {
      // 退还用户已扣减的令牌
      userBucket.tokens = Math.min(userBucket.capacity, userBucket.tokens + 1);
      return {
        allowed: false,
        code: 'GLOBAL_RATE_LIMIT_EXCEEDED',
        message: 'Global rate limit exceeded',
        retryAfterMs: globalCheck.retryAfterMs,
      };
    }

    return { allowed: true };
  }

  _cleanupUserBuckets(ttlMs, maxBuckets) {
    if (this.userBuckets.size < maxBuckets) return;
    const now = this.now();
    for (const [uid, bucket] of this.userBuckets.entries()) {
      if (now - bucket.lastAccessTime > ttlMs) {
        this.userBuckets.delete(uid);
      }
    }
    if (this.userBuckets.size >= maxBuckets) {
      const oldestUser = this.userBuckets.keys().next().value;
      if (oldestUser !== undefined) {
        this.userBuckets.delete(oldestUser);
      }
    }
  }

  /**
   * 具备熔断、单次调用超时、指数退避重试的下游支付执行器
   */
  async _executePaymentWithResilience({ userId, amount, idempotencyKey, orderId }) {
    const { maxRetries, baseDelayMs, maxDelayMs, jitter, timeoutMs } = this.options.resilience;

    let attempt = 0;
    while (true) {
      // 检查熔断器状态
      this._acquireCircuitPermission();

      try {
        // 向下游透传幂等上下文（兼容只接收 (userId, amount) 的旧实现）
        const result = await this._callWithTimeout(
          () => this.paymentGateway.charge(userId, amount, { idempotencyKey, orderId, attempt }),
          timeoutMs
        );

        this._onCircuitSuccess();
        return result;
      } catch (err) {
        const isTransient = this._isRetryableError(err);
        this._onCircuitFailure(isTransient);

        if (!isTransient || attempt >= maxRetries) {
          this.metrics.paymentFailures += 1;
          throw err;
        }

        attempt += 1;
        this.metrics.paymentRetries += 1;

        const delayMs = this._calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitter);
        if (delayMs > 0) {
          await this._sleep(delayMs);
        }
      }
    }
  }

  /**
   * 熔断器前置准入控制
   */
  _acquireCircuitPermission() {
    const now = this.now();
    const { resetTimeoutMs, halfOpenMaxCalls } = this.options.resilience;

    if (this.circuit.state === CircuitState.OPEN) {
      if (now - this.circuit.openedAt >= resetTimeoutMs) {
        this.circuit.state = CircuitState.HALF_OPEN;
        this.circuit.halfOpenInFlight = 0;
        this.circuit.halfOpenSuccesses = 0;
      } else {
        this.metrics.circuitRejected += 1;
        const err = new Error('Payment gateway circuit breaker is OPEN');
        err.code = 'CIRCUIT_OPEN';
        err.retryable = false;
        throw err;
      }
    }

    if (this.circuit.state === CircuitState.HALF_OPEN) {
      if (this.circuit.halfOpenInFlight >= halfOpenMaxCalls) {
        this.metrics.circuitRejected += 1;
        const err = new Error('Payment gateway circuit breaker is HALF_OPEN and at probe capacity');
        err.code = 'CIRCUIT_OPEN';
        err.retryable = false;
        throw err;
      }
      this.circuit.halfOpenInFlight += 1;
    }
  }

  _onCircuitSuccess() {
    if (this.circuit.state === CircuitState.HALF_OPEN) {
      this.circuit.halfOpenInFlight = Math.max(0, this.circuit.halfOpenInFlight - 1);
      this.circuit.halfOpenSuccesses += 1;
      if (this.circuit.halfOpenSuccesses >= this.options.resilience.halfOpenMaxCalls) {
        this.circuit.state = CircuitState.CLOSED;
        this.circuit.failures = 0;
        this.circuit.halfOpenSuccesses = 0;
      }
    } else {
      this.circuit.failures = 0;
    }
  }

  _onCircuitFailure(countTowardsCircuit = true) {
    if (this.circuit.state === CircuitState.HALF_OPEN) {
      this.circuit.halfOpenInFlight = Math.max(0, this.circuit.halfOpenInFlight - 1);
      if (countTowardsCircuit) {
        this.circuit.state = CircuitState.OPEN;
        this.circuit.openedAt = this.now();
        this.circuit.halfOpenSuccesses = 0;
      }
      return;
    }

    if (!countTowardsCircuit) {
      return;
    }

    this.circuit.failures += 1;
    if (this.circuit.failures >= this.options.resilience.failureThreshold) {
      this.circuit.state = CircuitState.OPEN;
      this.circuit.openedAt = this.now();
    }
  }

  /**
   * 区分可重试的瞬态故障与不可重试的业务异常
   */
  _isRetryableError(err) {
    if (!err) return false;
    if (err.code === 'CIRCUIT_OPEN') return false;
    if (typeof err.retryable === 'boolean') {
      if (!err.retryable) err.cacheableFailure = true;
      return err.retryable;
    }

    const nonRetryableCodes = new Set([
      'INSUFFICIENT_FUNDS',
      'CARD_DECLINED',
      'INVALID_CARD',
      'FRAUD_DETECTED',
      'ACCOUNT_FROZEN',
      'INVALID_AMOUNT',
    ]);
    if (err.code && nonRetryableCodes.has(err.code)) {
      err.cacheableFailure = true;
      return false;
    }

    if (typeof err.status === 'number' || typeof err.statusCode === 'number') {
      const status = err.status || err.statusCode;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        err.cacheableFailure = true;
        return false;
      }
    }

    return true;
  }

  _callWithTimeout(fn, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            const timeoutErr = new Error(`Payment gateway timed out after ${timeoutMs}ms`);
            timeoutErr.code = 'PAYMENT_TIMEOUT';
            timeoutErr.retryable = true;
            reject(timeoutErr);
          }
        }, timeoutMs);
      }

      Promise.resolve()
        .then(fn)
        .then((res) => {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(res);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  _calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitter) {
    const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
    if (!jitter) return expDelay;
    // Full jitter in [expDelay / 2, expDelay]
    return Math.floor(expDelay * (0.5 + Math.random() * 0.5));
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 将下游异常标准化映射为统一响应结构
   */
  _mapPaymentErrorToResponse(err, orderId) {
    const code = err?.code || 'PAYMENT_FAILED';
    const message = err?.message || 'Payment processing failed';

    if (code === 'CIRCUIT_OPEN') {
      return {
        status: 503,
        error: { code: 'SERVICE_UNAVAILABLE', reason: code, message, orderId },
      };
    }

    if (code === 'PAYMENT_TIMEOUT' || code === 'ETIMEDOUT') {
      return {
        status: 504,
        error: { code: 'GATEWAY_TIMEOUT', reason: code, message, orderId },
      };
    }

    if (err?.cacheableFailure) {
      return {
        status: err.status || err.statusCode || 402,
        error: { code, message, orderId },
      };
    }

    return {
      status: 502,
      error: { code: 'BAD_GATEWAY', reason: code, message, orderId },
    };
  }

  /**
   * 辅助查询接口：按订单ID获取订单
   */
  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  /**
   * 辅助查询接口：获取当前熔断器状态与监控指标快照
   */
  getStats() {
    return {
      circuitState: this.circuit.state,
      circuitFailures: this.circuit.failures,
      activeRequests: this.activeRequests,
      ordersCount: this.orders.size,
      idempotencyEntries: this.idempotencyStore.size,
      metrics: { ...this.metrics },
    };
  }
}
