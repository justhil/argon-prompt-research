export class NodeStateStore {
  constructor() {
    this.states = new Map();
  }

  markRunning(nodeId) {
    this.states.set(nodeId, { status: 'RUNNING' });
  }

  markSucceeded(nodeId, output) {
    this.states.set(nodeId, { status: 'SUCCEEDED', output });
  }

  markTerminalFailure(nodeId, errorMsg) {
    this.states.set(nodeId, { status: 'FAILED_TERMINAL', errorMsg });
  }

  markSkippedDueToUpstream(nodeId) {
    this.states.set(nodeId, { status: 'SKIPPED_UPSTREAM_FAILED' });
  }

  checkUpstreamReady(depIds = []) {
    for (const depId of depIds) {
      const st = this.states.get(depId);
      if (!st) return 'WAITING_UPSTREAM';
      if (st.status === 'FAILED_TERMINAL' || st.status === 'SKIPPED_UPSTREAM_FAILED') {
        return 'UPSTREAM_FAILED';
      }
      if (st.status !== 'SUCCEEDED') {
        return 'WAITING_UPSTREAM';
      }
    }
    return 'READY';
  }

  snapshot() {
    return Object.fromEntries(this.states.entries());
  }
}
