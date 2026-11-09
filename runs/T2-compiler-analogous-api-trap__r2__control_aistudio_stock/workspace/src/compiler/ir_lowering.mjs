import { Result } from '../lib/result_monad.mjs';

export function lowerIdentifierExpr(identName, symTab) {
  const found = symTab.lookupSymbol(identName);
  if (!found) {
    return null;
  }
  return Result.ok(found);
}

export function lowerBlockScope(blockAst, symTab, diag, buf) {
  symTab.enterScope();
  try {
    for (const decl of blockAst.declarations) {
      if (symTab.hasInCurrentScope(decl.name)) {
        diag.reportError('E_DUPLICATE_BINDING', `Duplicate: ${decl.name}`, decl.initOffset);
        return Result.err('E_DUPLICATE_BINDING', decl.name);
      }
      symTab.defineSymbol(decl.name, { kind: decl.kind });
      buf.writeUInt32BE(decl.initOffset);
    }
    return Result.ok({ count: blockAst.declarations.length, bytesHex: buf.toHex() });
  } finally {
    symTab.exitScope();
  }
}
