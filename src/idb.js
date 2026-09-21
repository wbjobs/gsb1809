/**
 * IndexedDB 封装：
 *  - store 'kv'：schema/配置持久化（key, value, updatedAt）
 *  - store 'cache'：异步校验结果缓存（key, value, expireAt, createdAt）
 * 环境无 IndexedDB 或显式禁用时，自动降级为内存存储（保持同样的 Promise API）。
 * 支持故障注入（options.injectFault），用于验证异常提示。
 */

const DB_NAME = 'rule-validator-db';
const DB_VERSION = 1;

class MemoryStore {
  constructor() {
    this.kv = new Map();
    this.cache = new Map();
    this.kind = 'memory';
  }
  async put(store, key, value, ttl) {
    this[store].set(key, { value, expireAt: ttl ? Date.now() + ttl : null });
  }
  async get(store, key) {
    const entry = this[store].get(key);
    if (!entry) return undefined;
    if (entry.expireAt && entry.expireAt < Date.now()) {
      this[store].delete(key);
      return undefined;
    }
    return entry.value;
  }
  async has(store, key) {
    return (await this.get(store, key)) !== undefined;
  }
  async delete(store, key) { this[store].delete(key); }
  async clearStore(store) { this[store].clear(); }
  async keys(store) { return [...this[store].keys()]; }
  async close() { this.kv.clear(); this.cache.clear(); }
}

function idbPromise() {
  if (typeof indexedDB !== 'undefined') return Promise.resolve(indexedDB);
  return import('fake-indexeddb/auto.js').then((m) => m.indexedDB || m.default).catch(() => null);
}

export class IdbStore {
  constructor(options = {}) {
    this.options = options;
    this.name = options.dbName || DB_NAME;
    this.kind = 'idb';
    this._fallbackUsed = false;
    this.lastError = null;
  }

  async open() {
    if (this._db || this.memory) return;
    if (this.options.forceMemory) {
      this.memory = new MemoryStore();
      this.kind = 'memory';
      this._fallbackUsed = true;
      return this;
    }
    try {
      const indexedDb = await idbPromise();
      if (!indexedDb) throw new Error('IndexedDB 不可用');
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDb.open(this.name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('cache')) {
            const s = db.createObjectStore('cache', { keyPath: 'key' });
            s.createIndex('expireAt', 'expireAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('打开 IndexedDB 失败'));
      });
    } catch (e) {
      this.lastError = e;
      this.memory = new MemoryStore();
      this.kind = 'memory-fallback';
      this._fallbackUsed = true;
    }
    return this;
  }

  _maybeFault(op) {
    const fault = this.options.injectFault;
    if (fault === true) throw new Error(`[fault] ${op} 被故障注入中断`);
    if (typeof fault === 'function' && fault(op)) throw new Error(`[fault] ${op} 被故障注入中断`);
  }

  async _tx(store, mode, fn) {
    this._maybeFault(store);
    if (this.memory || !this._db) return fn(this.memory);
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(store, mode);
      tx.onabort = () => reject(tx.error || new Error('事务中止'));
      tx.onerror = () => reject(tx.error || new Error('事务错误'));
      try {
        Promise.resolve(fn(tx.objectStore(store))).then(resolve, (e) => {
          // 底层失败时降级到内存，保证功能可用
          if (!this.memory) {
            this.memory = new MemoryStore();
            this.kind = 'memory-fallback';
            this._fallbackUsed = true;
            this.lastError = e;
          }
          reject(e);
        });
      } catch (e) { reject(e); }
    });
  }

  _request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(store, key, value, ttl) {
    const record = {
      key,
      value,
      updatedAt: Date.now(),
      expireAt: ttl ? Date.now() + ttl : null,
    };
    if (this.memory || !this._db) return this.memory.put(store, key, value, ttl);
    try {
      await this._tx(store, 'readwrite', (os) => this._request(os.put(record)));
    } catch (e) {
      this.lastError = e;
      await this.memory.put(store, key, value, ttl);
    }
  }

  async get(store, key) {
    if (this.memory || !this._db) return this.memory.get(store, key);
    try {
      const record = await this._tx(store, 'readonly', (os) => this._request(os.get(key)));
      if (!record) return undefined;
      if (record.expireAt && record.expireAt < Date.now()) {
        this.delete(store, key).catch(() => {});
        return undefined;
      }
      return record.value;
    } catch (e) {
      this.lastError = e;
      return this.memory.get(store, key);
    }
  }

  async has(store, key) {
    return (await this.get(store, key)) !== undefined;
  }

  async delete(store, key) {
    if (this.memory || !this._db) return this.memory.delete(store, key);
    try {
      await this._tx(store, 'readwrite', (os) => this._request(os.delete(key)));
    } catch (e) {
      this.lastError = e;
      return this.memory.delete(store, key);
    }
  }

  async clearStore(store) {
    if (this.memory || !this._db) return this.memory.clearStore(store);
    await this._tx(store, 'readwrite', (os) => this._request(os.clear())).catch((e) => {
      this.lastError = e;
      return this.memory.clearStore(store);
    });
  }

  async keys(store) {
    if (this.memory || !this._db) return this.memory.keys(store);
    try {
      return await this._tx(store, 'readonly', async (os) => {
        if (os.getAllKeys) return this._request(os.getAllKeys());
        // 内存降级分支
        return this.memory.keys(store);
      });
    } catch (e) {
      this.lastError = e;
      return this.memory.keys(store);
    }
  }

  async close() {
    if (this._db) this._db.close();
    this._db = null;
    if (this.memory) await this.memory.close();
  }
}
