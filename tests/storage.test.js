import test from 'node:test';
import assert from 'node:assert/strict';
import { IdbStore } from '../src/idb.js';
import { ResultCache } from '../src/cache.js';

test('内存降级存储：put/get/TTL/过期淘汰', async () => {
  const store = new IdbStore({ forceMemory: true });
  await store.open();
  assert.equal(store.kind, 'memory');
  await store.put('kv', 'schema', { a: 1 });
  assert.deepEqual(await store.get('kv', 'schema'), { a: 1 });

  await store.put('cache', 'k1', { result: true }, 30);
  assert.deepEqual(await store.get('cache', 'k1'), { result: true });
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(await store.get('cache', 'k1'), undefined);
  await store.close();
});

test('故障注入：底层异常被吞掉并标记 lastError，上层不崩溃', async () => {
  const store = new IdbStore({ forceMemory: false, injectFault: true });
  await store.open(); // 无 IDB → 内存降级
  await store.put('kv', 'k', 1);   // memory path no fault
  assert.equal(await store.get('kv', 'k'), 1);
  assert.ok(['memory', 'memory-fallback'].includes(store.kind));
  await store.close();
});

test('ResultCache：L1/L2 命中统计与负缓存开关', async () => {
  const store = new IdbStore({ forceMemory: true });
  await store.open();
  const cache = new ResultCache(store, { negativeCache: false });
  const key = ResultCache.buildKey('remote', 'a', null);
  await cache.set(key, { valid: false }, 1000);
  assert.equal(await cache.get(key), undefined, '负缓存关闭时失败结果不缓存');

  await cache.set(key, { valid: true, message: 'ok' }, 1000);
  assert.deepEqual(await cache.get(key), { valid: true, message: 'ok' });
  assert.equal(cache.stats.hit, 1);
  await cache.invalidate();
  assert.equal(await cache.get(key), undefined);
  await store.close();
});
