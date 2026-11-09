import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFileLimitChange } from '../src/hooks/use_file_limit.mjs';

test('smoke: within limit accepts all files', () => {
  const input = { value: 'a.png', files: ['a.png', 'b.png'] };
  const res = handleFileLimitChange(input, 1, 5);
  assert.equal(res.accepted, 2);
});
