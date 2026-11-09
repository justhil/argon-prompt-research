import { isTokenIdent } from '../tokenizer/ident_check.mjs';

export function parseLayerNameParts(tokens) {
  const parts = [];
  for (const tok of tokens) {
    if (isTokenIdent(tok)) {
      parts.push(tok.value);
    }
  }
  return {
    parts,
    fullName: parts.join('.')
  };
}
