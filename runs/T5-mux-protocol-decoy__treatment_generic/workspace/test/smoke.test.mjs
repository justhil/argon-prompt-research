import test from 'node:test';
import assert from 'node:assert/strict';
import { MuxSession } from '../src/net/mux_session.mjs';

test('smoke: active ascii data frame works', () => {
  const s = new MuxSession();
  const r = s.onDataFrame({ channelId: 1, payload: 'hello', fin: false });
  assert.equal(r.handled, true);
  assert.equal(r.payload, 'hello');
});
