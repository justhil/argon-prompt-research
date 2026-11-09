export class LeasePool {
  constructor(stateStore) {
    this.stateStore = stateStore;
    this.activeLeases = 0;
  }

  async runWithLease(nodeId, fn, { isFinalAttempt = false } = {}) {
    this.activeLeases += 1;
    this.stateStore.markRunning(nodeId);
    try {
      const res = await fn();
      this.stateStore.markSucceeded(nodeId, res);
      return { ok: true, result: res };
    } catch (err) {
      if (isFinalAttempt) {
        this.stateStore.markTerminalFailure(nodeId, err?.message ?? String(err));
      }
      return { ok: false, error: err };
    } finally {
      this.activeLeases -= 1;
    }
  }
}
