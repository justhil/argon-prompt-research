import test from 'node:test';
import assert from 'node:assert/strict';
import { isTokenIdent } from '../src/tokenizer/ident_check.mjs';
import { parseLayerNameParts } from '../src/nodes/layer_name.mjs';

test('smoke: isTokenIdent checks single token', () => {
  assert.equal(isTokenIdent({ type: 'ident', value: 'theme' }), true);
});

test('parseLayerNameParts joins ident tokens with dot', () => {
  const result = parseLayerNameParts([
    { type: 'ident', value: 'framework' },
    { type: 'delim', value: '.' },
    { type: 'ident', value: 'utilities' }
  ]);
  assert.deepEqual(result, {
    parts: ['framework', 'utilities'],
    fullName: 'framework.utilities'
  });
});

