import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerIdentifierExpr } from '../src/compiler/ir_lowering.mjs';
import { SymbolTable } from '../src/compiler/symbol_table.mjs';

test('smoke: lowerIdentifierExpr finds bound symbol', () => {
  const st = new SymbolTable();
  st.bindSymbol('x', { kind: 'const' });
  const r = lowerIdentifierExpr('x', st);
  assert.equal(r.isOk, true);
});
