import test from 'node:test';
import assert from 'node:assert/strict';
import { runValidationEngine } from '../lib/engine.js';

const asyncValidators = {
  async divides(request) {
    const { dividend, divisor } = request.payload;
    if (divisor === 0) return { valid: false, code: 'ZERO', message: 'Cannot divide by zero.' };
    return { valid: true };
  },
  async fails() {
    throw new Error('Remote failure');
  },
  async slow(_request, context) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
  }
};

test('evaluates complex cross-field expression rules', async () => {
  const rules = [
    {
      id: 'order-math',
      field: 'orderTotal',
      type: 'expression',
      params: {
        expression: {
          and: [
            { '>=': [{ ref: '$values.quantity' }, 1] },
            { '>=': [{ ref: '$values.orderTotal' }, { '*': [{ ref: '$values.quantity' }, { ref: '$values.unitPrice' }] }] }
          ]
        }
      }
    }
  ];
  const passed = await runValidationEngine(rules, { quantity: 2, unitPrice: 5, orderTotal: 10 }, { services: { asyncValidators } });
  assert.equal(passed.results[0].status, 'valid');

  const failed = await runValidationEngine(rules, { quantity: 2, unitPrice: 6, orderTotal: 10 }, { services: { asyncValidators } });
  assert.equal(failed.results[0].status, 'invalid');
});

test('reports unknown expression operators as exceptions', async () => {
  const result = await runValidationEngine([
    {
      id: 'complex-order',
      field: 'orderTotal',
      type: 'expression',
      params: {
        expression: {
          and: [
            { '>=': [{ ref: '$values.quantity' }, 1] },
            { '>=': [{ ref: '$values.orderTotal' }, { 'unknown-operator': [] }] }
          ]
        }
      }
    }
  ], { quantity: 2, orderTotal: 10 }, { services: { asyncValidators } });
  assert.equal(result.results[0].status, 'exception');
  assert.equal(result.results[0].code, 'RULE_EXCEPTION');
});

test('supports conditional numeric and string expressions', async () => {
  const rules = [
    { id: 'age', field: 'age', type: 'between', params: { min: 18, max: 65 } },
    {
      id: 'business-country',
      field: 'taxId',
      type: 'required',
      when: { and: [{ '==': [{ ref: '$values.accountType' }, 'business'] }, { 'in': [{ ref: '$values.country' }, ['CN', 'US']] }] }
    }
  ];

  const skipped = await runValidationEngine(rules, { age: '20', accountType: 'personal', country: 'CN' }, { services: { asyncValidators } });
  assert.equal(skipped.results[1].status, 'skipped');
  assert.equal(skipped.valid, true);

  const failed = await runValidationEngine(rules, { age: '17', accountType: 'business', country: 'CN' }, { services: { asyncValidators } });
  assert.equal(failed.valid, false);
  assert.deepEqual(failed.errors.map((error) => error.ruleId).sort(), ['age', 'business-country']);
});

test('skips async dependent rule when prerequisite fails', async () => {
  const called = [];
  const rules = [
    { id: 'username-required', field: 'username', type: 'required' },
    {
      id: 'username-async',
      field: 'username',
      type: 'async',
      params: { name: 'divides', payload: { dividend: 1, divisor: 1 } },
      requiresRules: ['username-required']
    }
  ];
  const services = {
    asyncValidators: {
      async divides(request) {
        called.push(request);
        return asyncValidators.divides(request);
      }
    }
  };

  const result = await runValidationEngine(rules, {}, { services });
  assert.equal(result.results[0].status, 'invalid');
  assert.equal(result.results[1].status, 'skipped');
  assert.equal(result.results[1].code, 'DEPENDENCY_FAILED');
  assert.equal(called.length, 0);
});

test('does not block dependents when a conditional prerequisite is inactive', async () => {
  let called = false;
  const result = await runValidationEngine([
    { id: 'conditional', field: 'taxId', type: 'required', when: { '==': [{ ref: '$values.accountType' }, 'business'] } },
    { id: 'still-runs', field: 'username', type: 'async', params: { name: 'probe' }, requiresRules: ['conditional'] }
  ], {
    accountType: 'personal',
    username: 'alice'
  }, {
    services: { asyncValidators: { async probe() { called = true; return { valid: true }; } } }
  });
  assert.equal(result.results[0].code, 'CONDITION_NOT_MATCHED');
  assert.equal(result.results[1].status, 'valid');
  assert.equal(called, true);
});

test('executes dependency-aware async rules and aggregates errors', async () => {
  const rules = [
    { id: 'country', field: 'country', type: 'oneOf', params: { values: ['CN', 'US'] } },
    {
      id: 'postal',
      field: 'postal',
      type: 'async',
      params: { name: 'divides', payload: { divisor: { ref: '$values.denominator' } } },
      dependsOn: ['denominator'],
      requiresRules: ['country']
    }
  ];

  const result = await runValidationEngine(rules, { country: 'CN', postal: 'x', denominator: 0 }, { services: { asyncValidators } });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'ZERO');
  assert.deepEqual(result.results[1].dependencies, ['denominator']);
});

test('detects circular rule dependencies', async () => {
  const rules = [
    { id: 'a', field: 'a', type: 'required', requiresRules: ['b'] },
    { id: 'b', field: 'b', type: 'required', requiresRules: ['a'] }
  ];
  const result = await runValidationEngine(rules, { a: '', b: '' }, { services: { asyncValidators } });
  assert.deepEqual(result.results.map((item) => item.status), ['skipped', 'skipped']);
  assert.ok(result.results.every((item) => item.code === 'CYCLE_DEPENDENCY'));
});

test('converts async exception and timeout into aggregated exceptions', async () => {
  const rules = [
    { id: 'boom', field: 'username', type: 'async', params: { name: 'fails', cache: false } },
    { id: 'slow', field: 'age', type: 'async', params: { name: 'slow', timeoutMs: 20, cache: false } }
  ];
  const result = await runValidationEngine(rules, { username: 'a', age: 1 }, { services: { asyncValidators } });
  assert.equal(result.valid, false);
  assert.deepEqual([...new Set(result.results.map((item) => item.code))].sort(), ['ASYNC_EXCEPTION', 'ASYNC_TIMEOUT']);
});

test('caches successful async validator results by payload', async () => {
  let calls = 0;
  const cache = new Map();
  const memoryCache = {
    get: async (key) => cache.has(key) ? cache.get(key).value : undefined,
    set: async (key, value) => cache.set(key, { value })
  };
  const rules = [{ id: 'cached', field: 'username', type: 'async', params: { name: 'count' } }];
  const services = { asyncValidators: { async count() { calls += 1; return { valid: true }; } } };

  await runValidationEngine(rules, { username: 'alice' }, { services, cache: memoryCache });
  await runValidationEngine(rules, { username: 'alice' }, { services, cache: memoryCache });
  assert.equal(calls, 1);
  assert.equal(cache.size, 1);
});

test('reports malformed rule configuration as config errors', async () => {
  const result = await runValidationEngine([{ type: 'required' }, null], { value: '' }, { services: { asyncValidators } });
  assert.equal(result.valid, false);
  assert.ok(result.configErrors.some((error) => error.code === 'MISSING_FIELD'));
  assert.ok(result.configErrors.some((error) => error.code === 'RULE_NOT_OBJECT'));
});
