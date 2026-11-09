import test from 'node:test';
import assert from 'node:assert/strict';
import { prunePartitions } from '../src/execution/partition_pruner.mjs';
import { buildPartitionFilterPlan } from '../src/planner/filter_pushdown.mjs';
import { TableRegistry } from '../src/catalog/table_registry.mjs';
import { PredicateArena } from '../src/ir/predicate_arena.mjs';

test('smoke: first partition matches', () => {
  const parts = [
    { id: 'p0', minVal: 0, maxVal: 50 },
    { id: 'p1', minVal: 51, maxVal: 100 }
  ];
  assert.deepEqual(prunePartitions(parts, { op: 'EQ', value: 20 }), ['p0']);
});

test('buildPartitionFilterPlan: uppercase op and last partition match', () => {
  const registry = new TableRegistry();
  registry.registerRelation({
    relationId: 42,
    name: 'orders',
    columns: [{ name: 'amount', slotId: 1 }],
    partitions: [
      { id: 'p0', minVal: 0, maxVal: 50 },
      { id: 'p1', minVal: 51, maxVal: 100 }
    ]
  });
  const arena = new PredicateArena();
  const plan = buildPartitionFilterPlan(
    'orders',
    { columnName: 'amount', op: 'eq', value: 75 },
    registry,
    arena
  );
  assert.deepEqual(plan, {
    relationId: 42,
    exprHandle: 1,
    selectedPartitions: ['p1']
  });
  assert.deepEqual(arena.getExpr(plan.exprHandle), {
    colSlotId: 1,
    opCode: 'EQ',
    literalValue: 75
  });
});

