import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerResource } from '../src/external/stripe/customer_resource.mjs';

test('smoke: CustomerResource lists discounts', async () => {
  const cr = new CustomerResource({ cus_1: [{ id: 'di_1', couponId: 'cp_1' }] });
  const list = await cr.listDiscounts('cus_1');
  assert.equal(list.length, 1);
});
