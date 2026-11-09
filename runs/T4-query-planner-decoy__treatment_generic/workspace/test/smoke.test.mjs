import test from 'node:test';
import assert from 'node:assert/strict';
import { prunePartitions } from '../src/execution/partition_pruner.mjs';

test('smoke: first partition matches', () => {
  const parts = [
    { id: 'p0', minVal: 0, maxVal: 50 },
    { id: 'p1', minVal: 51, maxVal: 100 }
  ];
  assert.deepEqual(prunePartitions(parts, { op: 'EQ', value: 20 }), ['p0']);
});
