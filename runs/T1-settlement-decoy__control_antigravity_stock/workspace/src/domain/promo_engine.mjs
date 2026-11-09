export class PromoEngine {
  constructor() {
    this.redeemed = new Set();
  }

  markRedeemed(voucherCode, buyerId) {
    this.redeemed.add(`${buyerId}:${voucherCode}`);
  }

  async revokeVoucher({ voucherCode, buyerId }) {
    if (!voucherCode || !buyerId) {
      throw new Error('revokeVoucher requires both voucherCode and buyerId');
    }
    const key = `${buyerId}:${voucherCode}`;
    const existed = this.redeemed.delete(key);
    return { revoked: existed };
  }
}
