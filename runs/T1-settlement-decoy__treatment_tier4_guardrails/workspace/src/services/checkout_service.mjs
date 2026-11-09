import { computeTotalWithFee, hasSufficientFunds } from '../domain/fee_calculator.mjs';

export class CheckoutService {
  constructor({ ledger, promo, audit }) {
    this.ledger = ledger;
    this.promo = promo;
    this.audit = audit;
  }

  async settleOrder(order) {
    const balance = await this.ledger.getBalanceUnits(order.buyerId);
    if (!hasSufficientFunds(balance, order.subtotalUnits, order.feeBps)) {
      return { settled: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    const { totalUnits, feeUnits } = computeTotalWithFee(order.subtotalUnits, order.feeBps);
    const debit = await this.ledger.postDebit({
      accountId: order.buyerId,
      amountUnits: totalUnits,
      orderId: order.orderId
    });
    return { settled: true, txRef: debit.txRef, totalUnits, feeUnits, remainingUnits: debit.balanceUnits };
  }

  async cancelOrder(order) {
    const units = order.totalUnits ?? computeTotalWithFee(order.subtotalUnits, order.feeBps).totalUnits;
    const rev = await this.ledger.reverseEntry({ txRef: order.txRef, units });
    if (order.voucherCode) {
      await this.promo.revokeVoucher({ voucherCode: order.voucherCode, buyerId: order.buyerId });
    }
    await this.audit.writeEnvelope({
      category: 'ORDER_CANCELLED',
      subjectId: order.orderId,
      metadata: { buyerId: order.buyerId }
    });
    return {
      cancelled: true,
      reversalRef: rev.reversalRef,
      newBalanceUnits: rev.newBalanceUnits
    };
  }
}
