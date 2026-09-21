/**
 * Web Worker 入口。浏览器：self.onmessage；Node：parentPort。
 * 协议：
 *   { type: 'bootstrap', customRules: [{ name, source }] } → { type:'ready' }
 *   { type: 'run', batchId, tasks }                          → { type:'results', batchId, results }
 */
import { runBatch, compileCustom } from './runner.js';

let ready = Promise.resolve();

async function handle(msg, reply) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'bootstrap') {
    ready = (async () => {
      for (const { name, source } of msg.customRules || []) {
        compileCustom(source, name);
      }
    })();
    await ready;
    reply({ type: 'ready' });
    return;
  }
  if (msg.type === 'ping') { reply({ type: 'pong' }); return; }
  if (msg.type === 'run') {
    try {
      await ready;
      const results = await runBatch(msg.tasks || []);
      reply({ type: 'results', batchId: msg.batchId, results });
    } catch (e) {
      reply({
        type: 'results',
        batchId: msg.batchId,
        results: (msg.tasks || []).map((t) => ({
          field: t.field,
          key: t.rule?.key,
          valid: false,
          error: { code: 'WORKER_ERROR', name: e.name, message: e.message },
        })),
      });
    }
  }
}

/* ---------- 浏览器 Web Worker ---------- */
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    handle(e.data, (out) => self.postMessage(out));
  };
}

/* ---------- Node worker_threads 降级/测试环境 ---------- */
try {
  const threads = await import('node:worker_threads');
  if (threads.parentPort) {
    threads.parentPort.on('message', (msg) => {
      handle(msg, (out) => threads.parentPort.postMessage(out));
    });
  }
} catch {
  /* 非 Node 环境忽略 */
}

export { handle };
