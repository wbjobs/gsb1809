import test from 'node:test';
import assert from 'node:assert/strict';
import { Validator } from '../src/index.js';

function makeValidator(options = {}) {
  return new Validator({
    useWorkers: true,
    workerSize: 2,
    idb: { forceMemory: true, dbName: `test-${Math.random()}` },
    debounce: 10,
    remoteDebounce: 10,
    ...options,
  });
}

test('复杂规则：内置 + 条件必填 + 表达式 + 跨字段一致性全部正确', async () => {
  const v = makeValidator();
  v.setSchema({
    fields: {
      age: { label: '年龄', rules: ['required', { min: 18 }, { max: 120 }] },
      guardian: { label: '监护人', rules: [{ requiredIf: 'age < 18' }] },
      email: { label: '邮箱', rules: ['required', 'email'] },
      pwd: { label: '密码', rules: ['required', { minLength: 6 }] },
      pwd2: { label: '确认密码', rules: ['required', { same: 'pwd' }] },
      role: { label: '角色', rules: [{ oneOf: ['admin', 'user', 'guest'] }] },
    },
    formRules: [{ expression: 'age < 150', message: '年龄不真实' }],
  });

  const bad = await v.validate({
    age: 10, guardian: '', email: 'nope', pwd: '123', pwd2: '456', role: 'hacker',
  });
  assert.equal(bad.valid, false);
  const fields = bad.errors.fields();
  for (const f of ['age', 'guardian', 'email', 'pwd', 'pwd2', 'role']) {
    assert.ok(fields.includes(f), `字段 ${f} 应当有错误`);
  }
  assert.equal(bad.errors.firstMessage('guardian'), '监护人为必填项');
  assert.equal(bad.errors.firstMessage('pwd2'), '确认密码必须与密码一致');

  const good = await v.validate({
    age: 25, guardian: '', email: 'a@b.com', pwd: 'secret1', pwd2: 'secret1', role: 'user',
  });
  assert.equal(good.valid, true);
  await v.destroy();
});

test('异步非阻塞：500 个同步任务 + 远程规则时，事件循环保持响应', async () => {
  const v = makeValidator({ workerSize: 4 });
  const fields = {};
  for (let i = 0; i < 500; i++) fields[`f${i}`] = { rules: ['required', { minLength: 2 }] };
  fields.remote = {
    rules: ['required', {
      remote: async (value) => {
        await new Promise((r) => setTimeout(r, 100));
        return value === 'free';
      },
    }],
  };
  v.setSchema({ fields });
  const values = {};
  for (let i = 0; i < 500; i++) values[`f${i}`] = 'ok';
  values.remote = 'taken';

  const ticks = [];
  const heartbeat = setInterval(() => ticks.push(performance.now()), 10);
  const started = performance.now();
  const result = await v.validate(values);
  clearInterval(heartbeat);
  const wall = performance.now() - started;

  assert.equal(result.valid, false);
  assert.equal(result.errors.firstMessage('remote'), 'remote服务器校验未通过');
  // 非阻塞证据：校验期间心跳多次触发（Worker 真正并行，而非主线程忙等）
  assert.ok(ticks.length >= 3, `事件循环应持续响应，实际心跳 ${ticks.length} 次`);
  // 性能证据：501 字段 / 1002+ 规则在 1s 内完成
  assert.ok(wall < 1000, `全量校验耗时 ${wall.toFixed(0)}ms 应 < 1000ms`);
  await v.destroy();
});

test('依赖正确：上游变化触发下游重新校验，错误能被清除', async () => {
  const v = makeValidator();
  v.setSchema({
    fields: {
      pwd: { label: '密码', rules: ['required', { minLength: 6 }] },
      pwd2: { label: '确认密码', rules: [{ same: 'pwd' }] },
    },
  });
  let values = { pwd: 'secret1', pwd2: 'secret2' };
  let r = await v.validateField('pwd2', values, { debounce: 0 });
  assert.equal(r.valid, false);
  assert.ok(r.affected.includes('pwd2'));

  // 修正上游，重新校验任一字段都应联动清除下游错误
  values = { pwd: 'secret2', pwd2: 'secret2' };
  r = await v.validateField('pwd', values, { debounce: 0 });
  assert.deepEqual(r.affected.sort(), ['pwd', 'pwd2']);
  assert.equal(r.valid, true);
  assert.equal(v.errorBag.has('pwd2'), false);
  await v.destroy();
});

test('条件依赖：requiredIf 表达式随依赖字段实时变化', async () => {
  const v = makeValidator();
  v.setSchema({
    fields: {
      country: { label: '国家', rules: ['required'] },
      taxId: { label: '税号', rules: [{ requiredIf: 'country == "CN"' }] },
    },
  });
  let r = await v.validate({ country: 'CN', taxId: '' });
  assert.equal(r.valid, false);
  r = await v.validate({ country: 'US', taxId: '' });
  assert.equal(r.valid, true);
  await v.destroy();
});

test('异步缓存：相同输入第二次命中缓存（指标可见）', async () => {
  const v = makeValidator();
  let calls = 0;
  v.setSchema({
    fields: {
      username: {
        rules: [{
          remote: async (value) => {
            calls++;
            await new Promise((r) => setTimeout(r, 20));
            return value !== 'taken';
          },
          cache: { ttl: 60000 },
        }],
      },
    },
  });
  const first = await v.validate({ username: 'alice' });
  const second = await v.validate({ username: 'alice' });
  assert.equal(first.valid, true);
  assert.equal(second.valid, true);
  assert.equal(calls, 1, '远程函数只应被调用一次');
  assert.ok(v.getMetrics().cacheHits >= 1);
  await v.destroy();
});

test('异常聚合：规则抛错/超时/拒绝都被捕获并提示，不中断其他字段', async () => {
  const v = makeValidator();
  const ruleErrors = [];
  v.on('rule:error', (e) => ruleErrors.push(e));
  v.setSchema({
    fields: {
      boom: {
        rules: [{ custom: () => { throw new Error('boom!'); }, message: '不应使用此消息' }],
      },
      slow: {
        rules: [{ custom: async () => { await new Promise(() => {}); }, timeout: 50 }],
      },
      reject: {
        rules: [{ custom: async () => { throw new Error('network down'); } }],
      },
      ok: { rules: ['required'] },
    },
  });
  const r = await v.validate({ boom: 'x', slow: 'x', reject: 'x', ok: 'y' });
  assert.equal(r.valid, false);
  const codes = r.errors.all().map((e) => e.code).sort();
  assert.deepEqual(codes, ['RULE_THREW', 'RULE_THREW', 'RULE_TIMEOUT']);
  assert.ok(r.errors.firstMessage('boom').includes('校验规则执行异常'));
  assert.ok(r.errors.firstMessage('slow').includes('超时'));
  assert.ok(r.errors.exceptions().length === 3);
  assert.equal(ruleErrors.length, 3);
  assert.equal(r.errors.has('ok'), false);
  await v.destroy();
});

test('循环依赖：上报 CYCLE 表单级异常且仍按快照完成校验', async () => {
  const v = makeValidator();
  v.setSchema({
    fields: {
      a: { rules: ['required'], dependsOn: ['b'] },
      b: { rules: ['required'], dependsOn: ['a'] },
    },
  });
  const r = await v.validate({ a: 'x', b: '' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.firstMessage('$form').includes('循环'));
  assert.equal(r.errors.has('b'), true);
  await v.destroy();
});

test('事件序列：start/end 与 valid/invalid 被发出', async () => {
  const v = makeValidator();
  const events = [];
  v.on('validate:start', () => events.push('start'));
  v.on('validate:end', () => events.push('end'));
  v.on('valid', () => events.push('valid'));
  v.setSchema({ fields: { name: { rules: ['required'] } } });
  await v.validate({ name: 'alice' });
  assert.deepEqual(events, ['start', 'end', 'valid']);
  await v.destroy();
});
