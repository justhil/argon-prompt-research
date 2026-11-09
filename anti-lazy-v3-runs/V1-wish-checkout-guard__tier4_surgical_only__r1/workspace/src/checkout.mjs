export class CheckoutController {
  constructor(walletService, options = {}) {
    this.walletService = walletService;
    this.options = options;
  }

  async handleCheckout(req) {
    // req: { idempotencyKey, userId, amount, itemId }
    const receipt = await this.walletService.debit(req.userId, req.amount, req.itemId);
    return { status: 200, receipt };
  }
}
