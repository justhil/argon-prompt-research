export class DiagnosticBag {
  constructor() {
    this.items = [];
  }

  recordDiag({ code, message, offset }) {
    if (!code || typeof offset !== 'number') {
      throw new Error('recordDiag requires { code, message, offset }');
    }
    this.items.push({ code, message, offset });
  }
}
