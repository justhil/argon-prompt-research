import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainableCommander } from '../src/infra/redis_commander.mjs';
import { ScheduleManager } from '../src/util/schedule_manager.mjs';

test('smoke: ChainableCommander queues setex', async () => {
  const c = new ChainableCommander();
  c.setex('k1', 10, 'true');
  const r = await c.exec();
  assert.equal(r.committed, 1);
});

test('ScheduleManager schedules batch expirations in seconds via setex', async () => {
  const c = new ChainableCommander();
  const mgr = new ScheduleManager();
  const r = await mgr.scheduleBatchExpirations(c, [
    { key: 'task1', expireMs: 5000 },
    { key: 'task2', expireMs: 12400 },
  ]);
  assert.equal(r.committed, 2);
  assert.deepEqual(r.ops, [
    { cmd: 'SETEX', key: 'ayako:sched:task1', seconds: 5, value: 'true' },
    { cmd: 'SETEX', key: 'ayako:sched:task2', seconds: 12, value: 'true' },
  ]);
});
