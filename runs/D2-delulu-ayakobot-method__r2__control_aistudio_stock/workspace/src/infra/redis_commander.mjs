// Exact contract from microsoft/delulu typescript-method-c78e023450b5:
// Property 'setWithExpiry' does not exist on type 'ChainableCommander'. Golden uses .setex(key, seconds, value)
export class ChainableCommander {
  constructor() {
    this.ops = [];
  }

  setex(key, seconds, value) {
    if (typeof key !== 'string' || typeof seconds !== 'number' || seconds <= 0) {
      throw new Error('setex requires (key: string, seconds: positive number, value: string)');
    }
    this.ops.push({ cmd: 'SETEX', key, seconds, value });
    return this;
  }

  async exec() {
    return { committed: this.ops.length, ops: [...this.ops] };
  }
}
