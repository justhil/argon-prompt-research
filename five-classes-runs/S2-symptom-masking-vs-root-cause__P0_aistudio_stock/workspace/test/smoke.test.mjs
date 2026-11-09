import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTenantCode } from '../src/gateway/tenant_extractor.mjs';

test('smoke: does not throw TypeError on valid header', () => {
  const res = extractTenantCode('x-tenant=acme_corp');
  assert.equal(typeof res, 'string');
});
