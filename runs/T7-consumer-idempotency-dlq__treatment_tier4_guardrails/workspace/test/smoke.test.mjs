import test from 'node:test';
import assert from 'node:assert/strict';
import { DedupStore } from '../src/infra/dedup_store.mjs';

test('smoke: DedupStore tracks eventId', () => {
  const ds = new DedupStore();
  assert.equal(ds.isDuplicate('e1'), false);
  ds.commitEvent('e1');
  assert.equal(ds.isDuplicate('e1'), true);
});
