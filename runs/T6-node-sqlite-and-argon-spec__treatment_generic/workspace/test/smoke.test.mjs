import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeTag } from '../src/types/ledger_record.mjs';

test('smoke: serializeTag formats v2 tag', () => {
  assert.equal(serializeTag({ tenantId: 't1', category: 'pay' }), 'v2:t1:PAY');
});
