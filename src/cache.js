/**
 * 异步规则结果缓存：
 * L1 = 进程内 Map（LRU，零 IO 开销）
 * L2 = IndexedDB cache store（跨会话持久，带 TTL）
 */
import { stableStringify } from './utils.js';

class LruMap {
  constructor(max = 500) { this.max = max; this.map = new Map(); }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  has(key) { return this.map.has(key); }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

export class ResultCache {
  /**
   * @param {object} store IdbStore 实例
   * @param {object} options { lruSize, negativeCache, namespace }
   */
  constructor(store, options = {}) {
    this.store = store;
    this.l1 = new LruMap(options.lruSize || 500);
    this.negativeCache = options.negativeCache ?? true;
    this.namespace = options.namespace || 'rule';
    this.stats = { hit: 0, miss: 0, l2Hit: 0 };
  }

  static buildKey(ruleKey, value, params, namespace) {
    return `${namespace || 'rule'}::${ruleKey}::${stableStringify({ v: value, p: params || null })}`;
  }

  async get(key) {
    if (this.l1.has(key)) {
      const entry = this.l1.get(key);
      if (entry.expireAt && entry.expireAt < Date.now()) { this.l1.delete(key); }
      else { this.stats.hit++; return entry.result; }
    }
    const result = await this.store.get('cache', key).catch(() => undefined);
    if (result !== undefined) {
      this.stats.l2Hit++;
      this.l1.set(key, result.entry || { result });
      return (result.entry || result).result;
    }
    this.stats.miss++;
    return undefined;
  }

  /**
   * @param result 规则结果（含 valid/message）
   * @param ttl 毫秒；false/0 不缓存
   */
  async set(key, result, ttl) {
    if (!ttl || ttl <= 0) return;
    if (!result.valid && !this.negativeCache) return;
    const expireAt = Date.now() + ttl;
    const entry = { result, expireAt };
    this.l1.set(key, entry);
    await this.store.put('cache', key, entry, ttl).catch(() => {});
  }

  async invalidate(predicate) {
    const keys = [...this.l1.map.keys()];
    for (const k of keys) {
      if (!predicate || predicate(k)) this.l1.delete(k);
    }
    if (!predicate) {
      await this.store.clearStore('cache').catch(() => {});
      return;
    }
    const l2keys = await this.store.keys('cache').catch(() => []);
    for (const k of l2keys) if (predicate(k)) await this.store.delete('cache', k).catch(() => {});
  }

  getStats() { return { ...this.stats, l1Size: this.l1.map.size }; }
}
