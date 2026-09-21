import { runValidationEngine } from '../lib/engine.js';
import { asyncValidators } from '../lib/demo-validators.js';
import { createAsyncResultCache, createStorage } from '../lib/storage.js';

let storagePromise;

function getCache() {
  if (!storagePromise) {
    storagePromise = Promise.resolve()
      .then(() => createStorage())
      .catch((error) => ({ storage: { get: async () => undefined, set: async () => {} }, error }))
      .then((initialized) => ({ cache: createAsyncResultCache(initialized), initialized }));
  }
  return storagePromise;
}

function safeCache(cache) {
  return {
    async get(key) {
      try {
        return await cache.get(key);
      } catch {
        return undefined;
      }
    },
    async set(key, value, ttlMs) {
      try {
        await cache.set(key, value, ttlMs);
      } catch {
        return undefined;
      }
    }
  };
}

async function handleValidate(message) {
  const { cache, initialized } = await getCache();
  const startedAt = performance.now();
  const result = await runValidationEngine(message.rules, message.values, {
    concurrency: message.concurrency ?? 8,
    cache: safeCache(cache),
    services: {
      asyncValidators,
      timeoutMs: message.timeoutMs ?? 8000,
      ttlMs: message.ttlMs ?? 30000
    }
  });
  return { ...result, storageFallback: Boolean(initialized.fallback), roundTripMs: Number((performance.now() - startedAt).toFixed(2)) };
}

async function handleBenchmark(message) {
  const count = Number(message.count ?? 1000);
  const values = Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, index % 2 ? String(index) : '']));
  const rules = Array.from({ length: count }, (_, index) => ({
    id: `perf-field-${index}`,
    field: `field${index}`,
    type: index % 3 === 0 ? 'required' : index % 3 === 1 ? 'min' : 'max',
    params: index % 3 === 1 ? { value: 0 } : { value: count },
    message: `field${index} failed`
  }));
  const startedAt = performance.now();
  const result = await runValidationEngine(rules, values, { concurrency: message.concurrency ?? 16 });
  return {
    count,
    durationMs: result.durationMs,
    roundTripMs: Number((performance.now() - startedAt).toFixed(2)),
    valid: result.valid,
    errorCount: result.errors.length,
    exceptionCount: result.results.filter((item) => item.status === 'exception').length
  };
}

self.onmessage = async (event) => {
  const message = event.data ?? {};
  if (message.type === 'ping') {
    self.postMessage({ type: 'pong', requestId: message.requestId });
    return;
  }

  try {
    const payload = message.type === 'benchmark' ? await handleBenchmark(message) : await handleValidate(message);
    self.postMessage({ type: message.type === 'benchmark' ? 'benchmark:result' : 'validate:result', requestId: message.requestId, payload });
  } catch (error) {
    self.postMessage({
      type: message.type === 'benchmark' ? 'benchmark:error' : 'validate:error',
      requestId: message.requestId,
      payload: { code: 'WORKER_UNCAUGHT', message: error?.message || 'Worker validation failed.' }
    });
  }
};
