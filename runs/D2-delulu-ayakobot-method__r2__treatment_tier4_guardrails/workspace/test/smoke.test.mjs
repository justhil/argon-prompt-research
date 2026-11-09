import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainableCommander } from '../src/infra/redis_commander.mjs';

test('smoke: ChainableCommander queues setex', async () => {
  const c = new ChainableCommander();
  c.setex('k1', 10, 'true');
  const r = await c.exec();
  assert.equal(r.committed, 1);
});
