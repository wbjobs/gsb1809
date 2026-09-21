import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExpression, extractExpressionDeps, ExpressionError } from '../src/expression.js';

const run = (expr, values) => compileExpression(expr).run(values);

test('算术与比较运算', () => {
  assert.equal(run('1 + 2 * 3', {}), 7);
  assert.equal(run('(1 + 2) * 3', {}), 9);
  assert.equal(run('age >= 18', { age: 20 }), true);
  assert.equal(run('age >= 18', { age: 10 }), false);
});

test('逻辑、空值合并与三元', () => {
  assert.equal(run('a && b', { a: true, b: false }), false);
  assert.equal(run('a ?? 7', { a: null }), 7);
  assert.equal(run('a ?? 7', { a: 1 }), 1);
  assert.equal(run('age >= 18 ? "adult" : "kid"', { age: 20 }), 'adult');
});

test('字段路径与字符串方法白名单', () => {
  assert.equal(run('user.name.startsWith("a")', { user: { name: 'alice' } }), true);
  assert.equal(run('len(tags)', { tags: [1, 2, 3] }), 3);
  assert.equal(run('inRange(age, 0, 120)', { age: 200 }), false);
  assert.equal(run('regex(email, "^[A-Za-z.]+@")', { email: 'a@b.com' }), true);
  assert.equal(run('regex(email, "^[0-9]+$")', { email: '123' }), true);
});

test('依赖提取：含点路径与条件表达式', () => {
  const deps = extractExpressionDeps('a > 1 && b.c == "x" || len(d) > 0');
  assert.deepEqual([...deps].sort(), ['a', 'b', 'b.c', 'd']);
});

test('安全：禁止原型链逃逸', () => {
  assert.throws(() => run('constructor', {}), ExpressionError);
  assert.throws(() => run('x.__proto__', { x: {} }), ExpressionError);
  assert.throws(() => run('x.constructor', { x: {} }), ExpressionError);
});

test('非法表达式给出位置错误', () => {
  assert.throws(() => compileExpression('a > '), ExpressionError);
  assert.throws(() => compileExpression('@'), ExpressionError);
});
