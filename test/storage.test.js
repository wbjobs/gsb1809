import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, createAsyncResultCache, createRuleRepository } from '../lib/storage.js';

test('rule repository and expiring async cache use separate stores', async () => {
  const storage = new MemoryStorage();
  const rules = createRuleRepository(storage);
  const cache = createAsyncResultCache(storage);

  await rules.save('default', [{ id: 'r1' }]);
  await cache.set('same-key', { valid: true }, 20);

  assert.deepEqual(await rules.get('default'), [{ id: 'r1' }]);
  assert.deepEqual(await cache.get('same-key'), { valid: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await cache.get('same-key'), undefined);
});
