export async function deleteCouponFromCustomer({ stripeClient, stripeCusId, targetCouponId }) {
  const discounts = await stripeClient.customers.listDiscounts(stripeCusId);
  if (!discounts || discounts.length === 0) {
    return { removedCount: 0 };
  }
  let removedCount = 0;
  for (const d of discounts) {
    if (d.couponId === targetCouponId) {
      await stripeClient.customers.removeDiscount(stripeCusId, d.id);
      removedCount += 1;
    }
  }
  return { removedCount };
}
