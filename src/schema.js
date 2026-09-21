/**
 * Schema 规范化 + 字段依赖图。
 *
 * 支持的规则写法（均会被规范化为统一结构）：
 *   'required'
 *   { name: 'min', value: 3 } / { min: 3 }
 *   { expression: 'a >= 18' }
 *   { custom: fn, deps: ['otherField'] }
 *   { remote: fn | '/api/check', ttl: 5000 }
 */
import { extractExpressionDeps, ExpressionError } from './expression.js';
import { builtinExtraDeps, getRule } from './rules.js';
import { topoSort } from './utils.js';

const REQUIRED_FAMILY = new Set(['required', 'requiredIf', 'requiredUnless']);

function detectAsync(fn) {
  return fn.constructor?.name === 'AsyncFunction' || /^\s*(?:async\b)/.test(Function.prototype.toString.call(fn));
}

function normalizeRule(item, fieldName, fieldConfig) {
  if (typeof item === 'string') {
    return finishRule({ key: item, name: item, params: {}, skipEmpty: !REQUIRED_FAMILY.has(item) });
  }
  if (typeof item === 'function') {
    return makeCustom(item, {});
  }
  if (typeof item !== 'object' || item === null) {
    throw configError(`字段 ${fieldName} 的规则必须是字符串或对象`);
  }

  // { custom: fn }
  if (typeof item.custom === 'function') return makeCustom(item.custom, item);
  // { remote: fn|url }
  if (item.remote !== undefined) return makeRemote(item);
  // { expression: '...' }
  if (item.expression !== undefined) {
    return finishRule({
      key: 'expression',
      name: 'expression',
      params: typeof item.expression === 'string' ? item.expression : item.expression.expr,
      message: item.message,
      condition: item.when || item.condition,
      timeout: item.timeout,
      cache: item.cache,
    });
  }

  let name = item.name;
  let params = item.params ?? item.value ?? item.args ?? {};
  if (!name && !item.custom && item.remote === undefined && item.expression === undefined) {
    // 单键简写：{ required: true, message: '...' } 或 { min: 3 }
    const reserved = new Set(['message', 'when', 'condition', 'skipEmpty', 'timeout', 'cache', 'debounce', 'label']);
    const keys = Object.keys(item).filter((k) => !reserved.has(k));
    if (keys.length === 1) {
      name = keys[0];
      params = item[name];
    } else if (keys.length === 0) {
      throw configError(`字段 ${fieldName} 存在没有规则名的配置项`);
    } else {
      throw configError(`字段 ${fieldName} 的规则存在多个候选名：${keys.join('、')}，请使用 name 显式指定`);
    }
  }
  const normalizeScalar = (val) => {
    if (typeof val === 'boolean' || val === undefined) return {};
    return val;
  };
  params = normalizeScalar(params);
  return finishRule({
    key: name,
    name,
    params: params === undefined ? {} : params,
    message: item.message,
    condition: item.when || item.condition,
    skipEmpty: item.skipEmpty,
    timeout: item.timeout,
    cache: item.cache,
  });

  function makeCustom(fn, opts) {
    const ruleName = opts.name || fn.name || `custom_${Math.random().toString(36).slice(2, 8)}`;
    return finishRule({
      key: `custom:${ruleName}`,
      name: 'custom',
      customName: ruleName,
      fn,
      source: Function.prototype.toString.call(fn),
      async: detectAsync(fn),
      deps: opts.deps || (fn.deps) || null,
      params: opts.params ?? {},
      message: opts.message,
      condition: opts.when || opts.condition,
      skipEmpty: opts.skipEmpty,
      timeout: opts.timeout,
      cache: opts.cache,
    });
  }

  function makeRemote(opts) {
    const target = opts.remote;
    const isFn = typeof target === 'function';
    const customName = isFn ? (opts.name || target.name || `remote_${Math.random().toString(36).slice(2, 8)}`) : null;
    return finishRule({
      key: 'remote',
      name: 'remote',
      customName,
      fn: isFn ? target : null,
      source: isFn ? Function.prototype.toString.call(target) : null,
      url: isFn ? null : String(target),
      async: true,
      params: opts.params ?? {},
      requestOptions: isFn ? null : { method: opts.method || 'GET', body: opts.body, headers: opts.headers },
      message: opts.message,
      condition: opts.when || opts.condition,
      skipEmpty: opts.skipEmpty ?? true,
      timeout: opts.timeout ?? 8000,
      cache: opts.cache ?? { ttl: 5000 },
      debounce: opts.debounce ?? 200,
    });
  }

  function finishRule(r) {
    const requiredLike = REQUIRED_FAMILY.has(r.name);
    r.skipEmpty = r.skipEmpty ?? !requiredLike;
    r._configError = null;
    if (r.name !== 'custom' && r.name !== 'remote' && !getRule(r.name)) {
      r._configError = `未注册的规则 "${r.name}"（字段 ${fieldName}）`;
    }
    return r;
  }
}

function configError(message) {
  const err = new Error(message);
  err.code = 'CONFIG_ERROR';
  return err;
}

function ruleDeps(rule, fieldName) {
  const deps = new Set();
  const addFromExpr = (expr) => {
    if (!expr || typeof expr !== 'string') return;
    try {
      extractExpressionDeps(expr).forEach((d) => deps.add(d));
    } catch (e) {
      // 表达式错误延迟到执行期聚合，这里仅忽略依赖
    }
  };
  addFromExpr(rule.condition);
  if (rule.name === 'expression') addFromExpr(typeof rule.params === 'string' ? rule.params : rule.params);
  if (rule.name === 'custom' && Array.isArray(rule.deps)) rule.deps.forEach((d) => deps.add(d));
  builtinExtraDeps(rule.name, rule.params).forEach((d) => deps.add(d));
  deps.delete(fieldName);
  return [...deps];
}

/**
 * 规范化 schema，构建依赖图。
 * 返回 { fields, labels, order, cycles, dependents, dependencies, formRules, configErrors }
 */
export function normalizeSchema(raw = {}) {
  const fieldNames = Object.keys(raw.fields || {});
  const fields = new Map();
  const labels = new Map();
  const dependencies = new Map();
  const configErrors = [];

  for (const name of fieldNames) {
    const cfg = raw.fields[name] || {};
    for (const d of (cfg.dependsOn || cfg.deps || [])) {
      if (!fieldNames.includes(d)) configErrors.push(`字段 ${name} 依赖了不存在的字段 "${d}"`);
    }
    labels.set(name, cfg.label || name);
    let rules;
    try {
      rules = (cfg.rules || []).map((item) => normalizeRule(item, name, cfg));
    } catch (e) {
      if (e.code === 'CONFIG_ERROR') {
        configErrors.push(e.message);
        rules = [];
      } else throw e;
    }
    for (const rule of rules) {
      if (rule._configError) {
        configErrors.push(rule._configError);
        rule._configError = null;
      }
    }
    fields.set(name, {
      name,
      label: cfg.label || name,
      rules,
      dependsOn: cfg.dependsOn || cfg.deps || [],
      debounce: cfg.debounce,
      bail: cfg.bail ?? false,
      optional: !!cfg.optional,
    });
    const deps = new Set(cfg.dependsOn || cfg.deps || []);
    for (const rule of rules) ruleDeps(rule, name).forEach((d) => deps.add(d));
    dependencies.set(name, [...deps].filter((d) => fieldNames.includes(d)));
  }

  // 依赖中引用了不存在字段 → 配置错误
  for (const [name, deps] of dependencies) {
    for (const d of deps) {
      if (!fields.has(d)) configErrors.push(`字段 ${name} 依赖了不存在的字段 "${d}"`);
    }
  }

  // 拓扑排序：边 dep -> field
  const edges = [];
  for (const [name, deps] of dependencies) for (const d of deps) edges.push([d, name]);
  const { order, cycles } = topoSort(fieldNames, edges);

  const dependents = new Map(fieldNames.map((n) => [n, new Set()]));
  for (const [name, deps] of dependencies) {
    for (const d of deps) {
      if (dependents.has(d)) dependents.get(d).add(name);
    }
  }

  const formRules = (raw.formRules || []).map((r, i) => {
    if (typeof r === 'string') return { key: `form_${i}`, name: 'expression', params: r, message: undefined };
    if (r.expression) return { key: `form_${i}`, name: 'expression', params: r.expression, message: r.message };
    return { key: `form_${i}`, ...r };
  });

  // 拓扑层级：同一层内字段互不依赖，可整层并行执行
  const levelOf = new Map();
  for (const name of order) {
    let level = 0;
    for (const d of dependencies.get(name)) level = Math.max(level, (levelOf.get(d) ?? -1) + 1);
    levelOf.set(name, level);
  }
  const levels = [];
  for (const name of order) {
    const lv = levelOf.get(name);
    (levels[lv] || (levels[lv] = [])).push(name);
  }
  // 压缩稀疏层级；循环依赖字段无法拓扑排序，统一放到最后一层执行（使用快照值）
  const compactLevels = levels.filter(Boolean);
  const cycleFields = cycles.filter((c) => !order.includes(c));
  if (cycleFields.length) {
    compactLevels.push(cycleFields);
    cycleFields.forEach((c, i) => levelOf.set(c, compactLevels.length - 1 + i * 0.001));
  }

  return { fields, labels, order, cycles, levels: compactLevels, levelOf, dependents, dependencies, formRules, configErrors, raw };
}

export { ExpressionError };
