import test from 'node:test';
import assert from 'node:assert/strict';
import { findUserByEmail } from '../src/services/user_lookup.mjs';

test('smoke: returns null on empty email', async () => {
  assert.equal(await findUserByEmail(''), null);
});
