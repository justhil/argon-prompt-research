export class SymbolTable {
  constructor() {
    this.frames = [new Map()];
  }

  pushLexicalFrame() {
    this.frames.push(new Map());
  }

  popLexicalFrame() {
    if (this.frames.length <= 1) throw new Error('Cannot pop root frame');
    this.frames.pop();
  }

  hasInCurrentFrame(name) {
    return this.frames[this.frames.length - 1].has(name);
  }

  bindSymbol(name, meta) {
    this.frames[this.frames.length - 1].set(name, meta);
  }

  lookupSymbol(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].has(name)) return this.frames[i].get(name);
    }
    return null;
  }
}
