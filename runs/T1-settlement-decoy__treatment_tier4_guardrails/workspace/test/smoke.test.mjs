import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/services/checkout_service.mjs';
import { LedgerClient } from '../src/infra/ledger_client.mjs';
import { PromoEngine } from '../src/domain/promo_engine.mjs';
import { AuditSink } from '../src/infra/audit_sink.mjs';

test('unit smoke test with legacy stub', async () => {
  const mockLedger = {
    getBalanceUnits: async () => 5000,
    postDebit: async () => ({ txRef: 'tx_1', balanceUnits: 2000 }),
    refundDebit: async () => ({ reversalRef: 'rev_tx_1', newBalanceUnits: 5000 })
  };
  const mockPromo = { releaseCoupon: async () => true };
  const mockAudit = { recordEvent: async () => true };

  const svc = new CheckoutService({ ledger: mockLedger, promo: mockPromo, audit: mockAudit });
  const res = await svc.settleOrder({ orderId: 'o1', buyerId: 'u1', subtotalUnits: 3000, feeBps: 0 });
  assert.equal(res.settled, true);
});

test('integration test with real domain and infra modules', async () => {
  const ledger = new LedgerClient({ u1: 1000 });
  const promo = new PromoEngine();
  const audit = new AuditSink();
  const svc = new CheckoutService({ ledger, promo, audit });

  const insufficient = await svc.settleOrder({ orderId: 'o1', buyerId: 'u1', subtotalUnits: 1000, feeBps: 50 });
  assert.equal(insufficient.settled, false);
  assert.equal(insufficient.reason, 'INSUFFICIENT_FUNDS');

  const settled = await svc.settleOrder({ orderId: 'o2', buyerId: 'u1', subtotalUnits: 995, feeBps: 50 });
  assert.equal(settled.settled, true);
  assert.equal(settled.feeUnits, 5);
  assert.equal(settled.totalUnits, 1000);
  assert.equal(settled.remainingUnits, 0);

  promo.markRedeemed('V10', 'u1');
  const cancelled = await svc.cancelOrder({
    orderId: 'o2',
    buyerId: 'u1',
    txRef: settled.txRef,
    subtotalUnits: 995,
    feeBps: 50,
    voucherCode: 'V10'
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.newBalanceUnits, 1000);
  assert.equal(promo.redeemed.size, 0);
  assert.equal(audit.envelopes.length, 1);
  assert.equal(audit.envelopes[0].category, 'ORDER_CANCELLED');
  assert.equal(audit.envelopes[0].subjectId, 'o2');
});
