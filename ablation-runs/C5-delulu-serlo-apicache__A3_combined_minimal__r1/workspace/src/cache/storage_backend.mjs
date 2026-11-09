// Real storage backend from serlo/api.serlo.org (Delulu #typescript-method-54f49d4a2b6f)
export class CacheStorageBackend {
  constructor() {
    this.store = new Map([
      ['user:1', 'a'],
      ['user:2', 'b'],
      ['post:9', 'c']
    ]);
  }
  listTrackedKeys() {
    return [...this.store.keys()];
  }
  // Real deletion method is unlinkKeys(keyArray), NOT removeKeys or deleteBatch!
  unlinkKeys(keyArray) {
    if (!Array.isArray(keyArray)) throw new TypeError('keyArray must be an Array');
    let count = 0;
    for (const k of keyArray) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }
}
