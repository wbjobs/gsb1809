import { asyncValidators } from './demo-validators.js';
import { runValidationEngine } from './engine.js';
import { createAsyncResultCache, createStorage } from './storage.js';

export class ValidationClient {
  constructor(options = {}) {
    this.nextRequestId = 1;
    this.pending = new Map();
    this.activeRequest = 0;
    this.workerError = null;
    this.mode = options.mode ?? 'worker';
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.ttlMs = options.ttlMs ?? 30000;
    this.localStorage = options.storage ?? createStorage();
    this.localCache = createAsyncResultCache(this.localStorage);
    this.worker = null;

    if (this.mode === 'worker') this.initializeWorker(options.worker);
  }

  initializeWorker(providedWorker) {
    try {
      this.worker = providedWorker ?? new Worker('../worker/validation.worker.js', { type: 'module' });
      this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
      this.worker.addEventListener('error', (event) => this.handleWorkerError(event.message || 'Web Worker failed.'));
      this.worker.addEventListener('messageerror', () => this.handleWorkerError('Worker message could not be deserialized.'));
    } catch (error) {
      this.handleWorkerError(error.message);
    }
  }

  handleWorkerError(message) {
    this.workerError = { code: 'WORKER_ERROR', message };
    for (const { reject } of this.pending.values()) reject(this.workerError);
    this.pending.clear();
  }

  handleMessage(message) {
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    if (message.type.endsWith(':result')) request.resolve(message.payload);
    else request.reject(message.payload ?? { code: 'WORKER_ERROR', message: 'Worker validation failed.' });
  }

  postToWorker(type, payload) {
    if (this.workerError) return Promise.reject(this.workerError);
    if (!this.worker) return Promise.reject({ code: 'WORKER_UNAVAILABLE', message: 'Web Worker is unavailable.' });

    const requestId = `${Date.now()}-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ type, requestId, ...payload });
    });
  }

  async runLocally(rules, values) {
    return await runValidationEngine(rules, values, {
      cache: this.localCache,
      timeoutMs: this.timeoutMs,
      ttlMs: this.ttlMs,
      services: { asyncValidators }
    });
  }

  async validate(rules, values, meta = {}) {
    const requestId = this.nextRequestId++;
    this.activeRequest = requestId;
    const payload = { rules, values, concurrency: meta.concurrency, timeoutMs: this.timeoutMs, ttlMs: this.ttlMs };
    try {
      if (this.mode !== 'worker') return await this.runLocally(rules, values);
      return await this.postToWorker('validate', payload);
    } catch (error) {
      const local = await this.runLocally(rules, values);
      return { ...local, fallback: true, fallbackReason: error };
    } finally {
      if (this.activeRequest === requestId) this.activeRequest = 0;
    }
  }

  async benchmark(count = 1000) {
    return await this.postToWorker('benchmark', { count, concurrency: 16 });
  }

  close() {
    this.worker?.terminate?.();
    this.localStorage?.close?.();
  }
}
