const DB_NAME = 'rule-validation-db';
const DB_VERSION = 1;

export class MemoryStorage {
  constructor() {
    this.data = new Map();
    this.fallback = true;
  }

  async get(key, storeName) {
    const item = this.data.get(`${storeName}:${key}`);
    if (!item) return undefined;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.data.delete(`${storeName}:${key}`);
      return undefined;
    }
    return item.value;
  }

  async set(key, value, _ttlMs, storeName) {
    const ttlMs = Number(_ttlMs);
    this.data.set(`${storeName}:${key}`, {
      value,
      expiresAt: Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + ttlMs : undefined
    });
  }
}

export class IndexedDbStorage {
  constructor(dbFactory = globalThis.indexedDB) {
    this.dbFactory = dbFactory;
    this.fallback = false;
  }

  open() {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = this.dbFactory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('rules')) db.createObjectStore('rules', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB.'));
    });
    return this.database;
  }

  async transaction(storeName, mode, operation) {
    const db = await this.open();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB operation failed.'));
    });
  }

  async get(key, storeName) {
    const row = await this.transaction(storeName, 'readonly', (store) => store.get(key));
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt < Date.now()) {
      await this.delete(key, storeName);
      return undefined;
    }
    return row.value;
  }

  async set(key, value, ttlMs, storeName) {
    const ttl = Number(ttlMs);
    await this.transaction(storeName, 'readwrite', (store) => store.put({
      id: key,
      key,
      value,
      updatedAt: Date.now(),
      expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl : undefined
    }));
  }

  async delete(key, storeName) {
    await this.transaction(storeName, 'readwrite', (store) => store.delete(key));
  }

  async close() {
    const db = await this.database;
    db?.close?.();
    this.database = undefined;
  }
}

export function createStorage(dbFactory = globalThis.indexedDB) {
  if (typeof dbFactory !== 'undefined' && dbFactory) return new IndexedDbStorage(dbFactory);
  return new MemoryStorage();
}

export async function withMemoryFallback(operation) {
  try {
    return await operation();
  } catch (error) {
    return { fallback: true, storage: new MemoryStorage(), error };
  }
}

export function createRuleRepository(storage) {
  return {
    get: (id = 'default') => storage.get(id, 'rules'),
    save: (id, rules) => storage.set(id, rules, undefined, 'rules')
  };
}

export function createAsyncResultCache(storage) {
  return {
    get: (key) => storage.get(key, 'cache'),
    set: (key, value, ttlMs) => storage.set(key, value, ttlMs, 'cache')
  };
}
