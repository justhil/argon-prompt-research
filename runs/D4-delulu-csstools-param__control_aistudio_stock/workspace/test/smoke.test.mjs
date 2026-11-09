import test from 'node:test';
import assert from 'node:assert/strict';
import { isTokenIdent } from '../src/tokenizer/ident_check.mjs';

test('smoke: isTokenIdent checks single token', () => {
  assert.equal(isTokenIdent({ type: 'ident', value: 'theme' }), true);
});
