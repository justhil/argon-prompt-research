import test from 'node:test';
import assert from 'node:assert/strict';
import { MuxSession } from '../src/net/mux_session.mjs';

test('smoke: active ascii data frame works', () => {
  const s = new MuxSession();
  const r = s.onDataFrame({ channelId: 1, payload: 'hello', fin: false });
  assert.equal(r.handled, true);
  assert.equal(r.payload, 'hello');
});

test('draining state only allows fin === true data frames and utf8 byte length works', () => {
  const s = new MuxSession();
  s.state = 'DRAINING';

  assert.deepEqual(s.onOpenChannel({ channelId: 2 }), { handled: false, reason: 'SESSION_INACTIVE' });
  assert.deepEqual(s.onWindowUpdate({ delta: 100 }), { handled: false, reason: 'SESSION_INACTIVE' });
  assert.deepEqual(s.onPingFrame({ nonce: 42 }), { handled: false, reason: 'SESSION_INACTIVE' });
  assert.deepEqual(s.onDataFrame({ channelId: 1, payload: 'test', fin: false }), { handled: false, reason: 'SESSION_INACTIVE' });
  assert.deepEqual(s.onDataFrame({ channelId: 1, payload: 'test', fin: 1 }), { handled: false, reason: 'SESSION_INACTIVE' });
  assert.equal(s.metrics.droppedFrames, 5);

  const finRes = s.onDataFrame({ channelId: 1, payload: '尾帧完整载荷测试', fin: true });
  assert.deepEqual(finRes, { handled: true, payload: '尾帧完整载荷测试', fin: true });
  assert.equal(s.metrics.dataBytes, Buffer.byteLength('尾帧完整载荷测试', 'utf8'));

  s.state = 'CLOSED';
  assert.deepEqual(s.onDataFrame({ channelId: 1, payload: '尾帧完整载荷测试', fin: true }), { handled: false, reason: 'SESSION_INACTIVE' });
  assert.equal(s.metrics.droppedFrames, 6);
});
