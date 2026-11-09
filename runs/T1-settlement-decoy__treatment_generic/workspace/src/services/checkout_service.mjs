import { computeTotalWithFee, hasSufficientFunds } from '../domain/fee_calculator.mjs';

export class CheckoutService {
  constructor({ ledger, promo, audit }) {
    this.ledger = ledger;
    this.promo = promo;
    this.audit = audit;
  }

  async settleOrder(order) {
    const balance = await this.ledger.getBalanceUnits(order.buyerId);
    const { totalUnits, feeUnits } = computeTotalWithFee(order.subtotalUnits, order.feeBps);
    if (!hasSufficientFunds(balance, order.subtotalUnits, order.feeBps)) {
      return { settled: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    const debit = await this.ledger.postDebit({
      accountId: order.buyerId,
      amountUnits: totalUnits,
      orderId: order.orderId
    });
    return { settled: true, txRef: debit.txRef, totalUnits, feeUnits, remainingUnits: debit.balanceUnits };
  }

  async cancelOrder(order) {
    const units = order.totalUnits ?? computeTotalWithFee(order.subtotalUnits, order.feeBps).totalUnits;
    const rev = typeof this.ledger.reverseEntry === 'function'
      ? await this.ledger.reverseEntry({ txRef: order.txRef, units })
      : await this.ledger.refundDebit(order.txRef, units);
    if (order.voucherCode) {
      if (typeof this.promo.revokeVoucher === 'function') {
        await this.promo.revokeVoucher({ voucherCode: order.voucherCode, buyerId: order.buyerId });
      } else {
        await this.promo.releaseCoupon(order.voucherCode, order.buyerId);
      }
    }
    if (typeof this.audit.writeEnvelope === 'function') {
      await this.audit.writeEnvelope({
        category: 'ORDER_CANCELLED',
        subjectId: order.orderId,
        metadata: { buyerId: order.buyerId }
      });
    } else {
      await this.audit.recordEvent('ORDER_CANCELLED', order.orderId, { buyerId: order.buyerId });
    }
    return {
      cancelled: true,
      reversalRef: rev.reversalRef,
      newBalanceUnits: rev.newBalanceUnits
    };
  }
}
