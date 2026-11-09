export class OrderConsumer {
  constructor({ lockManager, dedupStore, dlq, maxRetries = 3 }) {
    this.lockManager = lockManager;
    this.dedupStore = dedupStore;
    this.dlq = dlq;
    this.maxRetries = maxRetries;
  }

  async consumeOrderEvent(evt) {
    if (this.dedupStore.isDuplicate(evt.eventId)) {
      return { processed: false, status: 'DUPLICATE_IGNORED' };
    }
    const acquired = await this.lockManager.tryLease({ resourceKey: evt.orderId, ttlMs: 5000 });
    if (!acquired) {
      return { processed: false, status: 'LOCK_BUSY' };
    }
    try {
      if (evt.retryCount >= this.maxRetries) {
        await this.dlq.enqueuePoisonMessage({ event: evt, reasonCode: 'MAX_RETRIES_EXCEEDED' });
        return { processed: false, status: 'DEAD_LETTER' };
      }
      this.dedupStore.commitEvent(evt.eventId);
      return { processed: true, status: 'COMMITTED', orderId: evt.orderId };
    } finally {
      await this.lockManager.releaseLease({ resourceKey: evt.orderId });
    }
  }
}
