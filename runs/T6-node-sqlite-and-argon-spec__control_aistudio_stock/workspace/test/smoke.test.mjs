import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeTag } from '../src/types/ledger_record.mjs';
import { EventLedgerStore } from '../src/storage/event_ledger_store.mjs';
import { ERR_MINIMAL_NOT_SUPPORTED } from '../src/contracts/argon_contract.mjs';

test('smoke: serializeTag formats v2 tag', () => {
  assert.equal(serializeTag({ tenantId: 't1', category: 'pay' }), 'v2:t1:PAY');
});

test('EventLedgerStore inserts batch atomically and queries by tenant', () => {
  const store = new EventLedgerStore(':memory:');
  const res = store.insertBatchAtomic([
    { eventId: 'e1', tenantId: 't1', seqNo: 1, amountUnits: 100, category: 'pay' },
    { eventId: 'e2', tenantId: 't1', seqNo: 2, amountUnits: 200, category: 'refund' },
  ]);
  assert.deepEqual(res, { insertedCount: 2 });

  const rows = store.queryByTenant('t1');
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, {
    event_id: 'e1',
    tenant_id: 't1',
    seq_no: 1,
    amount_units: 100,
    tag: 'v2:t1:PAY',
  });
  assert.deepEqual({ ...rows[1] }, {
    event_id: 'e2',
    tenant_id: 't1',
    seq_no: 2,
    amount_units: 200,
    tag: 'v2:t1:REFUND',
  });
});

test('EventLedgerStore rolls back on duplicate key error and rejects MINIMAL thinkingLevel', () => {
  const store = new EventLedgerStore(':memory:');
  assert.throws(
    () => store.insertBatchAtomic([], 'MINIMAL'),
    { message: ERR_MINIMAL_NOT_SUPPORTED }
  );

  assert.throws(() => {
    store.insertBatchAtomic([
      { eventId: 'e1', tenantId: 't1', seqNo: 1, amountUnits: 100, category: 'pay' },
      { eventId: 'e1', tenantId: 't1', seqNo: 2, amountUnits: 200, category: 'pay' },
    ]);
  });

  assert.equal(store.queryByTenant('t1').length, 0);
});

