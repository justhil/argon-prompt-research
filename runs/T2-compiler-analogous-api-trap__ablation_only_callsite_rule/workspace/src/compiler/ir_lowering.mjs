import { Result } from '../lib/result_monad.mjs';

export function lowerIdentifierExpr(identName, symTab) {
  const found = symTab.lookupSymbol(identName);
  if (!found) {
    return null;
  }
  return Result.ok(found);
}

export function lowerBlockScope(blockAst, symTab, diag, buf) {
  symTab.pushLexicalFrame();
  try {
    let count = 0;
    for (const decl of blockAst.declarations) {
      if (symTab.hasInCurrentFrame(decl.name)) {
        diag.recordDiag({
          code: 'E_DUPLICATE_BINDING',
          message: `Duplicate: ${decl.name}`,
          offset: decl.initOffset,
        });
        return Result.fail('E_DUPLICATE_BINDING', decl.name);
      }
      symTab.bindSymbol(decl.name, { kind: decl.kind });
      buf.putU32(decl.initOffset);
      count++;
    }
    return Result.ok({ count, bytesHex: buf.toHex() });
  } finally {
    symTab.popLexicalFrame();
  }
}
