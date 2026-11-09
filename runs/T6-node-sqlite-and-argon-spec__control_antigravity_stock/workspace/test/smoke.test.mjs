import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeTag } from '../src/types/ledger_record.mjs';
import { EventLedgerStore } from '../src/storage/event_ledger_store.mjs';
import { ERR_MINIMAL_NOT_SUPPORTED } from '../src/contracts/argon_contract.mjs';

test('smoke: serializeTag formats v2 tag', () => {
  assert.equal(serializeTag({ tenantId: 't1', category: 'pay' }), 'v2:t1:PAY');
});

test('EventLedgerStore: insertBatchAtomic inserts records with default thinkingLevel and returns insertedCount', () => {
  const store = new EventLedgerStore();
  const res = store.insertBatchAtomic([
    { eventId: 'e2', tenantId: 't1', seqNo: 2, amountUnits: 200, category: 'refund' },
    { eventId: 'e1', tenantId: 't1', seqNo: 1, amountUnits: 100, category: 'pay' }
  ]);
  assert.deepEqual(res, { insertedCount: 2 });

  const rows = store.queryByTenant('t1');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    event_id: 'e1',
    tenant_id: 't1',
    seq_no: 1,
    amount_units: 100,
    tag: 'v2:t1:PAY'
  });
  assert.deepEqual(rows[1], {
    event_id: 'e2',
    tenant_id: 't1',
    seq_no: 2,
    amount_units: 200,
    tag: 'v2:t1:REFUND'
  });
});

test('EventLedgerStore: insertBatchAtomic rolls back atomically on error', () => {
  const store = new EventLedgerStore();
  assert.throws(() => {
    store.insertBatchAtomic([
      { eventId: 'e1', tenantId: 't1', seqNo: 1, amountUnits: 100, category: 'pay' },
      { eventId: 'e1', tenantId: 't1', seqNo: 2, amountUnits: 200, category: 'pay' }
    ]);
  });
  assert.deepEqual(store.queryByTenant('t1'), []);
});

test('EventLedgerStore: insertBatchAtomic rejects MINIMAL thinkingLevel', () => {
  const store = new EventLedgerStore();
  assert.throws(
    () => store.insertBatchAtomic([], 'MINIMAL'),
    { message: ERR_MINIMAL_NOT_SUPPORTED }
  );
});
