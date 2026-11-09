import { CacheStorageBackend } from './storage_backend.mjs';

export class ApiCacheService {
  constructor(storage = new CacheStorageBackend()) {
    this.storage = storage;
    this.activePrefix = '';
  }

  evictNamespace(prefix) {
    if (!prefix) return 0;
    const allKeys = this.storage.listTrackedKeys() || [];
    const matched = allKeys.filter(k => k.startsWith(prefix));
    if (matched.length === 0) return 0;
    return this.storage.unlinkKeys(matched);
  }
}
