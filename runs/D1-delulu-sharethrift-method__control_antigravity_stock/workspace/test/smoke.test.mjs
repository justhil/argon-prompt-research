import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFileLimitChange } from '../src/hooks/use_file_limit.mjs';

test('smoke: within limit accepts all files', () => {
  const input = { value: 'a.png', files: ['a.png', 'b.png'] };
  const res = handleFileLimitChange(input, 1, 5);
  assert.equal(res.accepted, 2);
});

test('when remaining <= 0, clears input.value and accepts 0', () => {
  const input = { value: 'a.png', files: ['a.png'] };
  const res = handleFileLimitChange(input, 5, 5);
  assert.equal(res.accepted, 0);
  assert.equal(input.value, '');
});

test('when files.length > remaining, slices files and notifies info', () => {
  const input = { value: 'a.png', files: ['a.png', 'b.png', 'c.png'] };
  const res = handleFileLimitChange(input, 3, 5);
  assert.equal(res.accepted, 2);
  assert.deepEqual(input.files, ['a.png', 'b.png']);
});
