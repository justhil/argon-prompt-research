export class DedupStore {
  constructor() {
    this.seen = new Set();
  }

  isDuplicate(eventId) {
    return this.seen.has(eventId);
  }

  commitEvent(eventId) {
    if (!eventId) throw new Error('commitEvent requires eventId');
    this.seen.add(eventId);
  }
}
