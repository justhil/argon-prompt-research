// Exact contract from microsoft/delulu typescript-method-ddf38b4aa065:
// Property 'removeDiscount' does not exist on type 'CustomerResource'. Golden uses customers.deleteDiscount(stripeCusId, discountId)
export class CustomerResource {
  constructor(initialDiscounts = {}) {
    this.store = new Map(Object.entries(initialDiscounts));
  }

  async listDiscounts(stripeCusId) {
    return [...(this.store.get(stripeCusId) || [])];
  }

  async deleteDiscount(stripeCusId, discountId) {
    if (!stripeCusId || !discountId) {
      throw new Error('deleteDiscount requires (stripeCusId, discountId)');
    }
    const list = this.store.get(stripeCusId) || [];
    this.store.set(stripeCusId, list.filter(d => d.id !== discountId));
    return { id: discountId, deleted: true };
  }
}
