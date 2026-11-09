import test from 'node:test';
import assert from 'node:assert/strict';
import { DagEngine } from '../src/scheduler/dag_engine.mjs';
import { LeasePool } from '../src/scheduler/lease_pool.mjs';
import { NodeStateStore } from '../src/scheduler/node_state_store.mjs';

test('happy path DAG succeeds', async () => {
  const store = new NodeStateStore();
  const pool = new LeasePool(store);
  const engine = new DagEngine({ leasePool: pool, stateStore: store });
  const res = await engine.executeDag(
    [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }],
    async (n) => n.id
  );
  assert.equal(res.states.b.status, 'SUCCEEDED');
});

test('failed upstream node after retries marks downstream as SKIPPED_UPSTREAM_FAILED with exponential backoff', async () => {
  const store = new NodeStateStore();
  const pool = new LeasePool(store);
  const engine = new DagEngine({ leasePool: pool, stateStore: store, maxAttempts: 3 });
  const res = await engine.executeDag(
    [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }],
    async (n) => {
      if (n.id === 'a') throw new Error('boom');
      return n.id;
    }
  );
  assert.equal(res.states.a.status, 'FAILED_TERMINAL');
  assert.equal(res.states.a.errorMsg, 'boom');
  assert.equal(res.states.b.status, 'SKIPPED_UPSTREAM_FAILED');
  assert.equal(res.states.c.status, 'SKIPPED_UPSTREAM_FAILED');
  assert.deepEqual(res.delaysRecorded, [100, 200]);
});
