/**
 * 性能基准（node tests/bench.test.js）：
 *  - 1000 字段 / 3000 规则全量校验
 *  - 30% 异步远程规则（Worker/本地异步）
 *  - 输出吞吐、分位耗时、缓存加速比、增量校验耗时
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '../src/index.js';

const FIELD_COUNT = 1000;

function buildSchema() {
  const fields = {};
  for (let i = 0; i < FIELD_COUNT; i++) {
    const rules = ['required', { minLength: 2 }, { maxLength: 32 }];
    if (i % 3 === 0) {
      rules.push({
        remote: async (value) => {
          await new Promise((r) => setTimeout(r, 2));
          return String(value).length >= 2;
        },
        cache: { ttl: 30000 },
      });
    }
    fields[`f${i}`] = {
      label: `字段${i}`,
      rules,
      debounce: 0,
      ...(i > 0 && i % 50 === 0 ? { dependsOn: [`f${i - 1}`] } : {}),
    };
  }
  return { fields };
}

function buildValues(valid = true) {
  const values = {};
  for (let i = 0; i < FIELD_COUNT; i++) values[`f${i}`] = valid ? `value-${i}` : (i % 7 === 0 ? '' : 'x');
  return values;
}

test('基准：1000 字段 / 3000+ 规则全量校验性能与吞吐', async () => {
  const v = new Validator({
    workerSize: 4,
    idb: { forceMemory: true },
    cache: true,
    useWorkers: true,
  });
  v.setSchema(buildSchema());

  // 预热（远程结果入缓存）
  await v.validate(buildValues(true));

  // 冷路径（错误数据，新缓存 key）
  const t1 = performance.now();
  const bad = await v.validate(buildValues(false));
  const coldMs = performance.now() - t1;

  // 热路径（再次校验相同错误数据 → 远程全部命中缓存）
  const t2 = performance.now();
  const bad2 = await v.validate(buildValues(false));
  const hotMs = performance.now() - t2;

  // 增量校验单字段
  const t3 = performance.now();
  await v.validateField('f0', buildValues(false), { debounce: 0 });
  const incMs = performance.now() - t3;

  const rules = FIELD_COUNT * 3 + Math.floor(FIELD_COUNT / 3);
  const metrics = v.getMetrics();

  console.log('\n──────── 性能基准报告 ────────');
  console.log(`字段数:        ${FIELD_COUNT}`);
  console.log(`规则总数:      ${rules}`);
  console.log(`冷全量校验:    ${coldMs.toFixed(1)} ms（${(rules / coldMs * 1000).toFixed(0)} 规则/秒）`);
  console.log(`热全量校验:    ${hotMs.toFixed(1)} ms（异步缓存加速 ${(coldMs / hotMs).toFixed(1)}x）`);
  console.log(`增量单字段:    ${incMs.toFixed(1)} ms`);
  console.log(`失败字段数:    ${bad.errors.fields().length}`);
  console.log(`缓存命中:      ${metrics.cacheHits}`);
  console.log(`Worker:        ${metrics.pool.workers.map((w) => `${w.kind}(${w.tasks})`).join(', ')}`);
  console.log('──────────────────────────────\n');

  assert.equal(bad.valid, false);
  assert.equal(bad2.valid, false);
  // 验收：千级字段全量 < 2s；缓存后 < 300ms；增量 < 50ms
  assert.ok(coldMs < 2000, `冷校验 ${coldMs.toFixed(0)}ms 应 < 2000ms`);
  assert.ok(hotMs < 300, `热校验 ${hotMs.toFixed(0)}ms 应 < 300ms`);
  assert.ok(incMs < 50, `增量校验 ${incMs.toFixed(0)}ms 应 < 50ms`);
  assert.ok(metrics.cacheHits >= Math.floor(FIELD_COUNT / 3));

  await v.destroy();
});
