import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderHandler, CircuitState, ErrorCode } from '../src/order_handler.mjs';

function createMockGateway(impl) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async charge(userId, amount, req) {
      calls += 1;
      if (impl) {
        return impl(userId, amount, req, calls);
      }
      return { chargeId: `chg_${calls}` };
    },
  };
}

test('1. Basic order creation & backward compatibility', async () => {
  const gateway = createMockGateway();
  const handler = new OrderHandler(gateway);

  const req = {
    idempotencyKey: 'idem_1',
    userId: 'user_1',
    amount: 99.5,
    items: [{ sku: 'item_a', qty: 2 }],
  };

  const res = await handler.createOrder(req);
  assert.equal(res.status, 200);
  assert.equal(res.data.orderId, 'ord_1');
  assert.equal(res.data.userId, 'user_1');
  assert.equal(res.data.amount, 99.5);
  assert.equal(res.data.chargeId, 'chg_1');
  assert.equal(res.data.status, 'PAID');
  assert.equal(gateway.calls, 1);
  assert.equal(handler.orders.size, 1);
  assert.deepEqual(handler.getOrder('ord_1').items, [{ sku: 'item_a', qty: 2 }]);
});

test('2. Input validation rejects malformed requests without calling downstream', async () => {
  const gateway = createMockGateway();
  const handler = new OrderHandler(gateway);

  const r1 = await handler.createOrder(null);
  assert.equal(r1.status, 400);
  assert.equal(r1.code, ErrorCode.INVALID_REQUEST);

  const r2 = await handler.createOrder({ userId: '', amount: 50 });
  assert.equal(r2.status, 400);

  const r3 = await handler.createOrder({ userId: 'u1', amount: -10 });
  assert.equal(r3.status, 400);

  const r4 = await handler.createOrder({ userId: 'u1', amount: NaN });
  assert.equal(r4.status, 400);

  const r5 = await handler.createOrder({ userId: 'u1', amount: 10, items: 'not-an-array' });
  assert.equal(r5.status, 400);

  assert.equal(gateway.calls, 0);
});

test('3. Idempotency: sequential replay returns cached order without double-charging', async () => {
  const gateway = createMockGateway();
  const handler = new OrderHandler(gateway);

  const req = {
    idempotencyKey: 'idem_seq_1',
    userId: 'u_100',
    amount: 120,
    items: [{ id: 'book', count: 1 }],
  };

  const first = await handler.createOrder(req);
  const second = await handler.createOrder({ ...req });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.replayed, true);
  assert.equal(second.headers['X-Idempotent-Replayed'], 'true');
  assert.equal(first.data.orderId, second.data.orderId);
  assert.equal(first.data.chargeId, second.data.chargeId);
  assert.equal(gateway.calls, 1);
  assert.equal(handler.getMetrics().idempotentHits, 1);
});

test('4. Idempotency: payload mismatch with same key returns 409 conflict', async () => {
  const gateway = createMockGateway();
  const handler = new OrderHandler(gateway);

  await handler.createOrder({
    idempotencyKey: 'idem_conflict',
    userId: 'u_1',
    amount: 100,
    items: ['a'],
  });

  // Same key, different amount
  const diffAmount = await handler.createOrder({
    idempotencyKey: 'idem_conflict',
    userId: 'u_1',
    amount: 200,
    items: ['a'],
  });
  assert.equal(diffAmount.status, 409);
  assert.equal(diffAmount.code, ErrorCode.IDEMPOTENCY_CONFLICT);

  // Same key, different userId
  const diffUser = await handler.createOrder({
    idempotencyKey: 'idem_conflict',
    userId: 'u_2',
    amount: 100,
    items: ['a'],
  });
  assert.equal(diffUser.status, 409);
  assert.equal(diffUser.code, ErrorCode.IDEMPOTENCY_CONFLICT);

  assert.equal(gateway.calls, 1);
  assert.equal(handler.getMetrics().idempotentConflicts, 2);
});

test('5. Idempotency: concurrent in-flight deduplication (wait & reject modes)', async () => {
  const gateway = createMockGateway(async (_u, _a, _r, callNum) => {
    await new Promise((r) => setTimeout(r, 40));
    return { chargeId: `chg_concurrent_${callNum}` };
  });

  const handler = new OrderHandler(gateway, { inFlightStrategy: 'wait' });
  const req = { idempotencyKey: 'idem_inflight', userId: 'u1', amount: 55 };

  const [res1, res2, res3] = await Promise.all([
    handler.createOrder(req),
    handler.createOrder(req),
    handler.createOrder(req),
  ]);

  assert.equal(gateway.calls, 1);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res3.status, 200);
  assert.equal(res1.data.orderId, res2.data.orderId);
  assert.equal(res2.data.orderId, res3.data.orderId);

  // Test 'reject' in-flight strategy
  const handlerReject = new OrderHandler(gateway, { inFlightStrategy: 'reject' });
  const reqReject = { idempotencyKey: 'idem_reject_inflight', userId: 'u1', amount: 55 };
  const [rA, rB] = await Promise.all([
    handlerReject.createOrder(reqReject),
    handlerReject.createOrder(reqReject),
  ]);

  assert.equal(rA.status, 200);
  assert.equal(rB.status, 409);
  assert.equal(rB.code, ErrorCode.IDEMPOTENCY_IN_FLIGHT);
});

test('6. Idempotency: failed payment releases lock so retry with same key succeeds', async () => {
  let shouldFail = true;
  const gateway = createMockGateway(async () => {
    if (shouldFail) {
      const err = new Error('Gateway down');
      err.retryable = false;
      throw err;
    }
    return { chargeId: 'chg_recovered' };
  });

  const handler = new OrderHandler(gateway, { maxRetries: 0 });
  const req = { idempotencyKey: 'idem_retry_after_fail', userId: 'u1', amount: 80 };

  const failedRes = await handler.createOrder(req);
  assert.equal(failedRes.status, 502);

  shouldFail = false;
  const successRes = await handler.createOrder(req);
  assert.equal(successRes.status, 200);
  assert.equal(successRes.data.chargeId, 'chg_recovered');
});

test('7. Idempotency: TTL expiration & cleanup allows new order after expiry', async () => {
  let now = 1_000_000;
  const gateway = createMockGateway();
  const handler = new OrderHandler(gateway, {
    idempotencyTtlMs: 5000,
    nowFn: () => now,
  });

  const req = { idempotencyKey: 'idem_ttl', userId: 'u1', amount: 30 };
  const first = await handler.createOrder(req);
  assert.equal(first.data.orderId, 'ord_1');

  // Within TTL -> cached
  now += 4000;
  const cached = await handler.createOrder(req);
  assert.equal(cached.data.orderId, 'ord_1');
  assert.equal(cached.replayed, true);
  assert.equal(gateway.calls, 1);

  // Past TTL -> executes fresh order
  now += 2000;
  const fresh = await handler.createOrder(req);
  assert.equal(fresh.data.orderId, 'ord_2');
  assert.equal(fresh.replayed, undefined);
  assert.equal(gateway.calls, 2);
});

test('8. Rate limiting: per-user and global sliding window enforcement + Retry-After', async () => {
  let now = 10_000;
  const gateway = createMockGateway();
  const handler = new OrderHandler(gateway, {
    nowFn: () => now,
    rateLimit: {
      windowMs: 1000,
      maxRequestsPerUser: 2,
      globalMaxRequests: 3,
    },
  });

  // User A: 2 requests succeed
  assert.equal((await handler.createOrder({ userId: 'uA', amount: 10 })).status, 200);
  assert.equal((await handler.createOrder({ userId: 'uA', amount: 10 })).status, 200);

  // User A: 3rd request hits per-user rate limit
  const uABlocked = await handler.createOrder({ userId: 'uA', amount: 10 });
  assert.equal(uABlocked.status, 429);
  assert.equal(uABlocked.code, ErrorCode.RATE_LIMITED);
  assert.equal(uABlocked.scope, 'user');
  assert.equal(uABlocked.retryAfterMs, 1000);
  assert.ok(uABlocked.headers['Retry-After']);

  // User B: 1st request succeeds (3rd global request)
  assert.equal((await handler.createOrder({ userId: 'uB', amount: 10 })).status, 200);

  // User B: 2nd request hits global rate limit (3 global max reached)
  const uBBlocked = await handler.createOrder({ userId: 'uB', amount: 10 });
  assert.equal(uBBlocked.status, 429);
  assert.equal(uBBlocked.scope, 'global');

  // Advance clock past window -> requests allowed again
  now += 1001;
  assert.equal((await handler.createOrder({ userId: 'uA', amount: 10 })).status, 200);
});

test('9. Downstream resilience: transient failure retry with exponential backoff', async () => {
  let attempt = 0;
  const gateway = createMockGateway(async () => {
    attempt += 1;
    if (attempt < 3) {
      throw new Error(`Transient network error #${attempt}`);
    }
    return { chargeId: 'chg_after_retry' };
  });

  const handler = new OrderHandler(gateway, {
    maxRetries: 3,
    baseDelayMs: 5,
  });

  const res = await handler.createOrder({ idempotencyKey: 'k_retry', userId: 'u1', amount: 45 });
  assert.equal(res.status, 200);
  assert.equal(res.data.chargeId, 'chg_after_retry');
  assert.equal(gateway.calls, 3);
  assert.equal(handler.getMetrics().paymentRetries, 2);
});

test('10. Downstream resilience: timeout protection aborts slow calls', async () => {
  const gateway = createMockGateway(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { chargeId: 'chg_too_late' };
  });

  const handler = new OrderHandler(gateway, {
    timeoutMs: 30,
    maxRetries: 1,
    baseDelayMs: 5,
  });

  const res = await handler.createOrder({ userId: 'u1', amount: 25 });
  assert.equal(res.status, 504);
  assert.equal(res.code, ErrorCode.PAYMENT_TIMEOUT);
  assert.equal(gateway.calls, 2);
  assert.equal(handler.getMetrics().paymentTimeouts, 2);
});

test('11. Downstream resilience: non-retryable business error fails fast without tripping circuit', async () => {
  const gateway = createMockGateway(async () => {
    const err = new Error('Insufficient funds');
    err.code = 'INSUFFICIENT_FUNDS';
    err.statusCode = 402;
    throw err;
  });

  const handler = new OrderHandler(gateway, {
    maxRetries: 3,
    failureThreshold: 1,
  });

  const res = await handler.createOrder({ userId: 'u1', amount: 500 });
  assert.equal(res.status, 402);
  assert.equal(res.code, 'INSUFFICIENT_FUNDS');
  assert.equal(gateway.calls, 1); // No retries for business rejection
  assert.equal(handler.getCircuitState(), CircuitState.CLOSED); // Circuit remains closed
});

test('12. Circuit Breaker: CLOSED -> OPEN -> HALF_OPEN -> CLOSED full lifecycle', async () => {
  let now = 50_000;
  let healthy = false;
  const gateway = createMockGateway(async () => {
    if (!healthy) {
      throw new Error('Gateway 503 Unavailable');
    }
    return { chargeId: 'chg_healthy' };
  });

  const handler = new OrderHandler(gateway, {
    nowFn: () => now,
    maxRetries: 0,
    circuitBreaker: {
      failureThreshold: 3,
      resetTimeoutMs: 5000,
      halfOpenMaxCalls: 1,
      successThreshold: 1,
    },
  });

  // 3 consecutive failures trip the circuit to OPEN
  for (let i = 0; i < 3; i++) {
    const r = await handler.createOrder({ userId: 'u1', amount: 10 });
    assert.equal(r.status, 502);
  }
  assert.equal(handler.getCircuitState(), CircuitState.OPEN);
  assert.equal(gateway.calls, 3);

  // Subsequent call while OPEN short-circuits with 503 without calling gateway
  const shortCircuited = await handler.createOrder({ userId: 'u1', amount: 10 });
  assert.equal(shortCircuited.status, 503);
  assert.equal(shortCircuited.code, ErrorCode.CIRCUIT_OPEN);
  assert.equal(gateway.calls, 3);
  assert.equal(handler.getMetrics().circuitShortCircuits, 1);

  // Advance clock past resetTimeoutMs -> transitions to HALF_OPEN
  now += 5001;
  assert.equal(handler.getCircuitState(), CircuitState.HALF_OPEN);

  // Probe fails in HALF_OPEN -> immediately re-opens circuit
  const failedProbe = await handler.createOrder({ userId: 'u1', amount: 10 });
  assert.equal(failedProbe.status, 502);
  assert.equal(handler.getCircuitState(), CircuitState.OPEN);
  assert.equal(gateway.calls, 4);

  // Advance clock again and restore downstream health -> HALF_OPEN probe succeeds -> CLOSED
  now += 5001;
  healthy = true;
  const recovered = await handler.createOrder({ userId: 'u1', amount: 10 });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.chargeId, 'chg_healthy');
  assert.equal(handler.getCircuitState(), CircuitState.CLOSED);
});
