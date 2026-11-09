export class LockManager {
  constructor() {
    this.held = new Set();
  }

  async tryLease({ resourceKey, ttlMs = 5000 }) {
    if (!resourceKey || typeof ttlMs !== 'number') {
      throw new Error('tryLease requires { resourceKey, ttlMs }');
    }
    if (this.held.has(resourceKey)) return false;
    this.held.add(resourceKey);
    return true;
  }

  async releaseLease({ resourceKey }) {
    if (!resourceKey) throw new Error('releaseLease requires { resourceKey }');
    this.held.delete(resourceKey);
  }
}
