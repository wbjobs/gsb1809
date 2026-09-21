import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchema } from '../src/schema.js';

test('显式 dependsOn 与规则表达式依赖都会进入依赖图', () => {
  const s = normalizeSchema({
    fields: {
      country: { rules: ['required'] },
      age: { rules: ['required'] },
      idCard: {
        rules: [{ requiredIf: 'country == "CN" && age >= 16' }],
      },
      remark: { rules: [], dependsOn: ['country'] },
    },
  });
  assert.deepEqual(s.dependencies.get('idCard').sort(), ['age', 'country']);
  assert.deepEqual(s.dependencies.get('remark'), ['country']);
  assert.deepEqual(s.order.slice(0, 2).sort(), ['age', 'country']);
  assert.deepEqual(s.order.slice(2).sort(), ['idCard', 'remark']);
  assert.deepEqual(s.cycles, []);
  assert.deepEqual([...s.dependents.get('country')].sort(), ['idCard', 'remark']);
});

test('same/different 规则自动建立字段依赖', () => {
  const s = normalizeSchema({
    fields: {
      pwd: { rules: ['required'] },
      pwd2: { rules: [{ same: 'pwd' }] },
    },
  });
  assert.deepEqual(s.dependencies.get('pwd2'), ['pwd']);
});

test('循环依赖被检测并报告 CYCLE 字段集合', () => {
  const s = normalizeSchema({
    fields: {
      a: { rules: [], dependsOn: ['b'] },
      b: { rules: [], dependsOn: ['c'] },
      c: { rules: [], dependsOn: ['a'] },
    },
  });
  assert.deepEqual(s.cycles.sort(), ['a', 'b', 'c']);
});

test('依赖未定义字段产生配置错误', () => {
  const s = normalizeSchema({ fields: { a: { dependsOn: ['ghost'] } } });
  assert.ok(s.configErrors.some((m) => m.includes('ghost')));
});

test('未注册规则产生配置错误而不是运行时崩溃', () => {
  const s = normalizeSchema({ fields: { a: { rules: ['totallyNotARule'] } } });
  assert.ok(s.configErrors[0].includes('totallyNotARule'));
});

test('简写规则规范化：字符串、单键对象、params 展开', () => {
  const s = normalizeSchema({
    fields: {
      name: { rules: ['required', { minLength: 3 }, { name: 'max', value: 10 }] },
    },
  });
  const rules = s.fields.get('name').rules;
  assert.equal(rules[0].name, 'required');
  assert.equal(rules[0].skipEmpty, false);
  assert.equal(rules[1].name, 'minLength');
  assert.equal(rules[1].params, 3);
  assert.equal(rules[1].skipEmpty, true);
  assert.equal(rules[2].name, 'max');
  assert.equal(rules[2].params, 10);
});
