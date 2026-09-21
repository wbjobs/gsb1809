/**
 * Worker 池：
 *  - 浏览器：new Worker(blob URL, {type:'module'})，blob 内 import 真实模块
 *  - Node：worker_threads + workerData 入口，桥接 postMessage 协议
 *  - 降级：线程不可用时在主线程执行（不阻塞返回，仍异步）
 */
import { runBatch } from './runner.js';
import { uid } from './utils.js';

function browserWorkerUrl(moduleUrl) {
  const src = `import ${JSON.stringify(moduleUrl)};\n`;
  const blob = new Blob([src], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}

function resolveModuleUrl() {
  try {
    return new URL('./worker.js', import.meta.url).href;
  } catch {
    return null;
  }
}

class LocalWorker {
  constructor() { this.ready = Promise.resolve(); this.stats = { tasks: 0, errors: 0, busyTime: 0 }; }
  postMessage(msg) {
    const reply = (out) => Promise.resolve().then(() => this.onmessage && this.onmessage({ data: out }));
    if (msg.type === 'run') {
      runBatch(msg.tasks || []).then((results) => reply({ type: 'results', batchId: msg.batchId, results }));
    } else if (msg.type === 'ping') {
      reply({ type: 'pong' });
    } else if (msg.type === 'bootstrap') {
      reply({ type: 'ready' });
    }
  }
  terminate() { this.onmessage = null; }
}

let nodeThreads = null;
try {
  const t = await import('node:worker_threads');
  if (t.Worker && t.isMainThread) nodeThreads = t;
} catch { /* browser */ }

const NODE_BOOTSTRAP = `
import { parentPort, workerData } from 'node:worker_threads';
const mod = await import(workerData.entry);
const handler = mod.handle || mod.default;
parentPort.on('message', (msg) => handler(msg, (out) => parentPort.postMessage(out)));
`;

function createWorker(index, options) {
  // 1) 显式禁用线程
  if (options.forceLocal) return new LocalWorker();

  // 2) Node worker_threads
  if (nodeThreads && nodeThreads.isMainThread && options.useNodeThreads !== false) {
    try {
      const entry = new URL('./worker.js', import.meta.url);
      const worker = new nodeThreads.Worker(NODE_BOOTSTRAP, {
        eval: true,
        workerData: { entry: entry.href },
      });
      return wrapLikeWebWorker(worker, 'node');
    } catch { /* fall through */ }
  }

  // 3) 浏览器 Web Worker
  if (typeof Worker !== 'undefined' && typeof window !== 'undefined' && options.forceLocal !== true) {
    const url = options.workerUrl || resolveModuleUrl();
    if (url) {
      try {
        const worker = new Worker(browserWorkerUrl(url), { type: 'module' });
        return wrapLikeWebWorker(worker, 'web');
      } catch { /* fall through */ }
    }
  }

  // 4) 降级
  return new LocalWorker();
}

function wrapLikeWebWorker(worker, kind) {
  const wrapper = {
    kind,
    raw: worker,
    onmessage: null,
    onerror: null,
    ready: null,
    stats: { tasks: 0, errors: 0, busyTime: 0 },
    postMessage(msg) {
      if (kind === 'node') worker.postMessage(msg);
      else worker.postMessage(msg);
    },
    terminate() { worker.terminate(); },
  };
  worker.on('message', (data) => wrapper.onmessage && wrapper.onmessage({ data }));
  worker.on('error', (err) => wrapper.onerror && wrapper.onerror(err));
  return wrapper;
}

export class WorkerPool {
  /**
   * @param {object} options
   * @param {number} options.size 池大小，默认 navigator.hardwareConcurrency-1（最小1，最大8）
   */
  constructor(options = {}) {
    this.options = options;
    const defaultSize = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? Math.max(1, Math.min(8, navigator.hardwareConcurrency - 1))
      : 2;
    this.size = options.size || defaultSize;
    this.workers = [];
    this.queue = [];
    this.next = 0;
    this.metrics = { submitted: 0, completed: 0, failed: 0, totalBusyMs: 0, localFallback: 0 };
  }

  async start(customRules = []) {
    if (this._started) return this._startPromise;
    this._started = true;
    this._startPromise = this._init(customRules);
    return this._startPromise;
  }

  async _init(customRules) {
    for (let i = 0; i < this.size; i++) {
      const worker = createWorker(i, this.options);
      worker.busy = 0;
      this.workers.push(worker);
      worker.onmessage = (e) => this._onMessage(worker, e.data);
      worker.onerror = (err) => this._onError(worker, err);
    }
    this._pending = new Map();
    await Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      const bootId = uid('boot');
      this._pending.set(bootId, { resolve, reject, worker: w, bootstrap: true });
      w.postMessage({ type: 'bootstrap', customRules });
    })));
  }

  /** 提交一批任务（同字段尽量落同一 worker 以利缓存局部性）。 */
  runBatch(tasks, affinityKey) {
    this.metrics.submitted += tasks.length;
    return new Promise((resolve, reject) => {
      const chunkSize = affinityKey !== undefined ? 32 : 48;
      const chunks = [];
      for (let i = 0; i < tasks.length; i += chunkSize) chunks.push(tasks.slice(i, i + chunkSize));
      if (chunks.length === 0) { resolve([]); return; }
      const agg = { parts: new Array(chunks.length).fill(null), count: chunks.length, resolve, reject: (e) => { agg.failed = e; } };
      for (let i = 0; i < chunks.length; i++) {
        this.queue.push({ tasks: chunks[i], affinityKey, partIndex: i, agg });
      }
      this._pump();
    });
  }

  _pickWorker(affinityKey) {
    if (affinityKey !== undefined) {
      const idx = Math.abs(hashCode(String(affinityKey))) % this.workers.length;
      const preferred = this.workers[idx];
      if (preferred.busy <= 2) return preferred;
    }
    let best = this.workers[0];
    for (const w of this.workers) if (w.busy < best.busy) best = w;
    return best;
  }

  _pump() {
    while (this.queue.length) {
      const item = this.queue[0];
      const worker = this._pickWorker(item.affinityKey);
      if (worker.busy >= 64) return; // 全部繁忙，等结果回来后再泵
      this.queue.shift();
      const batchId = uid('batch');
      this._pending.set(batchId, {
        resolve: (results) => {
          item.agg.parts[item.partIndex] = results;
          item.agg.count--;
          if (item.agg.count === 0) item.agg.resolve(item.agg.parts.flat());
        },
        reject: (e) => item.agg.reject(e),
        worker,
        tasks: item.tasks,
        started: nowMs(),
        count: item.tasks.length,
      });
      worker.busy += item.tasks.length;
      worker.stats.tasks += item.tasks.length;
      worker.postMessage({ type: 'run', batchId, tasks: item.tasks });
    }
  }

  _onMessage(worker, data) {
    const pending = this._pending;
    if (!pending) return;
    if (data.type === 'ready' || data.type === 'pong') {
      for (const [id, p] of pending) {
        if (p.worker === worker && p.bootstrap) {
          pending.delete(id);
          p.resolve(data);
          return;
        }
      }
      return;
    }
    if (data.type === 'results') {
      const p = pending.get(data.batchId);
      if (!p) return;
      pending.delete(data.batchId);
      const elapsed = nowMs() - p.started;
      worker.busy -= p.count;
      worker.stats.busyTime += elapsed;
      this.metrics.completed += p.count;
      this.metrics.totalBusyMs += elapsed;
      if (!worker.kind || worker.kind === 'local') this.metrics.localFallback += p.count;
      p.resolve(data.results);
      this._pump();
    }
  }

  _onError(worker, err) {
    worker.stats.errors++;
    this.metrics.failed++;
    // worker 崩溃：该 worker 上等待中的任务回退到主线程执行，保证校验可用
    for (const [id, p] of this._pending) {
      if (p.worker === worker && p.count !== undefined) {
        this._pending.delete(id);
        this.metrics.localFallback += p.count;
        runBatch(p.tasks).then(p.resolve, p.reject);
      }
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      workers: this.workers.map((w, i) => ({
        index: i,
        kind: w.kind || (w.postMessage === LocalWorker.prototype.postMessage ? 'local' : 'unknown'),
        busy: w.busy,
        ...w.stats,
      })),
      queueDepth: this.queue.length,
    };
  }

  async terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this._started = false;
  }
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return h;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
