import { computeBackoffDelayMs } from './backoff_calc.mjs';

export class DagEngine {
  constructor({ leasePool, stateStore, maxAttempts = 3 }) {
    this.leasePool = leasePool;
    this.stateStore = stateStore;
    this.maxAttempts = maxAttempts;
  }

  topologicalOrder(nodes) {
    const inDegree = new Map();
    const adj = new Map();
    for (const n of nodes) {
      inDegree.set(n.id, (n.deps || []).length);
      adj.set(n.id, []);
    }
    for (const n of nodes) {
      for (const dep of n.deps || []) {
        adj.get(dep).push(n.id);
      }
    }
    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    const order = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      order.push(cur);
      for (const next of adj.get(cur) || []) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== nodes.length) {
      throw new Error('Cycle detected in DAG');
    }
    return order;
  }

  async executeDag(nodes, workerFn) {
    const order = this.topologicalOrder(nodes);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const delaysRecorded = [];

    for (const nodeId of order) {
      const node = nodeMap.get(nodeId);
      const upstreamStatus = this.stateStore.checkUpstreamReady(node.deps || []);
      if (upstreamStatus === 'UPSTREAM_FAILED') {
        this.stateStore.markSkippedDueToUpstream(nodeId);
        continue;
      }
      let attempt = 0;
      while (attempt < this.maxAttempts) {
        attempt += 1;
        const outcome = await this.leasePool.runWithLease(nodeId, () => workerFn(node, attempt), {
          isFinalAttempt: attempt >= this.maxAttempts
        });
        if (outcome.ok) break;
        if (attempt < this.maxAttempts) {
          const delayMs = computeBackoffDelayMs(attempt, node.backoffOpts);
          delaysRecorded.push(delayMs);
        }
      }
    }
    return { states: this.stateStore.snapshot(), delaysRecorded };
  }
}
