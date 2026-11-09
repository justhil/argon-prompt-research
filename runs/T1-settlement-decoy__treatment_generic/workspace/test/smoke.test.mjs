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

test('settleOrder prevents overdraft with feeBps > 0 and rounds fee up', async () => {
  const ledger = new LedgerClient({ u1: 1000 });
  const promo = new PromoEngine();
  const audit = new AuditSink();
  const svc = new CheckoutService({ ledger, promo, audit });

  // 1000 subtotal with 250 bps -> 25 fee -> 1025 total > 1000 balance
  const insufficient = await svc.settleOrder({ orderId: 'o_over', buyerId: 'u1', subtotalUnits: 1000, feeBps: 250 });
  assert.equal(insufficient.settled, false);
  assert.equal(insufficient.reason, 'INSUFFICIENT_FUNDS');
  assert.equal(await ledger.getBalanceUnits('u1'), 1000);

  // 101 subtotal with 250 bps -> 2.525 -> ceil to 3 fee -> 104 total
  const settled = await svc.settleOrder({ orderId: 'o_ok', buyerId: 'u1', subtotalUnits: 101, feeBps: 250 });
  assert.equal(settled.settled, true);
  assert.equal(settled.feeUnits, 3);
  assert.equal(settled.totalUnits, 104);
  assert.equal(settled.remainingUnits, 896);

  promo.markRedeemed('VOUCHER1', 'u1');
  const cancelled = await svc.cancelOrder({
    orderId: 'o_ok',
    buyerId: 'u1',
    txRef: settled.txRef,
    subtotalUnits: 101,
    feeBps: 250,
    voucherCode: 'VOUCHER1'
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.reversalRef, `rev_${settled.txRef}`);
  assert.equal(cancelled.newBalanceUnits, 1000);
  assert.equal(promo.redeemed.has('u1:VOUCHER1'), false);
  assert.equal(audit.envelopes.length, 1);
  assert.equal(audit.envelopes[0].category, 'ORDER_CANCELLED');
  assert.equal(audit.envelopes[0].subjectId, 'o_ok');
});
