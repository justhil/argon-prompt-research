import test from 'node:test';
import assert from 'node:assert/strict';
import { StateBackend } from '../src/analytics/state_backend.mjs';

test('smoke: StateBackend stores window state', () => {
  const sb = new StateBackend();
  sb.writeWindowState('w1', { sum: 10, count: 2 });
  assert.deepEqual(sb.readWindowState('w1'), { sum: 10, count: 2 });
});
