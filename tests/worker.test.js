import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerPool } from '../src/worker-host.js';

const task = (name, params, value) => ({
  field: 'f',
  rule: { key: name, name, params, skipEmpty: true },
  values: { f: value },
  globals: {},
});

test('真实 Worker 线程：内置规则在 worker_threads 中执行', async () => {
  const pool = new WorkerPool({ size: 2 });
  await pool.start([]);
  const results = await pool.runBatch([
    task('min', 18, 20),
    task('min', 18, 10),
    task('email', {}, 'bad-email'),
  ]);
  assert.equal(results[0].valid, true);
  assert.equal(results[1].valid, false);
  assert.equal(results[2].valid, false);
  const metrics = pool.getMetrics();
  assert.ok(metrics.workers.every((w) => w.kind === 'node'));
  assert.equal(metrics.completed, 3);
  await pool.terminate();
});

test('批处理：大量任务被分发到多个 Worker 并行完成', async () => {
  const pool = new WorkerPool({ size: 4 });
  await pool.start([]);
  const tasks = Array.from({ length: 200 }, (_, i) => task('minLength', 1, `v${i}`));
  const results = await pool.runBatch(tasks);
  assert.equal(results.length, 200);
  assert.ok(results.every((r) => r.valid));
  const used = pool.getMetrics().workers.filter((w) => w.tasks > 0);
  assert.ok(used.length >= 2, '任务应分布到多个 Worker');
  await pool.terminate();
});

test('forceLocal 降级：线程禁用时在主线程异步执行', async () => {
  const pool = new WorkerPool({ size: 2, forceLocal: true });
  await pool.start([]);
  const results = await pool.runBatch([task('required', {}, 'x')]);
  assert.equal(results[0].valid, true);
  assert.equal(pool.getMetrics().localFallback, 1);
  await pool.terminate();
});

test('bootstrap：自定义纯函数可在 Worker 中注册并调用', async () => {
  const pool = new WorkerPool({ size: 1 });
  await pool.start([{ name: 'isEven', source: '(value) => Number(value) % 2 === 0' }]);
  const results = await pool.runBatch([{
    field: 'n',
    rule: { key: 'custom:isEven', name: 'custom', customName: 'isEven', params: {}, skipEmpty: true },
    values: { n: 4 },
    globals: {},
  }]);
  assert.equal(results[0].valid, true);
  await pool.terminate();
});

test('worker:true 自定义异步规则在 Worker 中执行（大计算不阻塞主线程）', async () => {
  const pool = new WorkerPool({ size: 2 });
  await pool.start([]);
  // 纯函数源码，可被 Worker 端 new Function 编译
  const source = 'async (value) => { '
    + 'let sum = 0; for (let i = 0; i < 200000; i++) sum += i; '
    + 'return sum === 19999900000 && String(value).length >= 2; }';
  const results = await pool.runBatch([{
    field: 'x',
    rule: {
      key: 'custom:heavy', name: 'custom', customName: 'heavy_async',
      source, params: {}, skipEmpty: true,
    },
    values: { x: 'hello' },
    globals: {},
  }]);
  assert.equal(results[0].valid, true);
  await pool.terminate();
});
