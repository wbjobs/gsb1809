/**
 * 规则执行器：在 Worker 线程内执行（也可直接在主线程内作为降级路径）。
 * 输入纯数据任务，输出纯数据结果，保证 structured-clone 可序列化。
 */
import { getRule, defineRule } from './rules.js';
import { isEmptyValue, getByPath, withTimeout } from './utils.js';

/** 将函数字符串编译为 (value, params, ctx) 规则。失败返回 null（交由主线程本地执行）。 */
export function compileCustom(source, name) {
  try {
    // 支持裸函数体（以 => 或 function 开头）与完整函数表达式
    const body = /^\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/.test(source)
      ? `(${source})`
      : `(async (value, params, ctx) => { ${source} })`;
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${body});`)();
    defineRule(name, fn, { async: true });
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeResult(result) {
  if (result === true || result === undefined || result === null) return { valid: true };
  if (result === false) return { valid: false };
  if (typeof result === 'string') return { valid: false, message: result };
  if (typeof result === 'object') return { valid: !!result.valid, message: result.message };
  return { valid: Boolean(result) };
}

/** 执行远程校验：fetch URL 或已注册的 remote 函数。 */
async function runRemote(rule, value, ctx, signal) {
  if (typeof rule.fn === 'function') {
    return normalizeResult(await rule.fn(value, rule.params, ctx));
  }
  if (rule.url) {
  const init = { method: rule.requestOptions?.method || 'GET', headers: rule.requestOptions?.headers, signal };
    if (init.method !== 'GET') {
      init.body = typeof rule.requestOptions?.body === 'function'
        ? JSON.stringify(rule.requestOptions.body(value, ctx))
        : JSON.stringify({ value, ...(rule.params || {}) });
      init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
    }
    const sep = rule.url.includes('?') ? '&' : '?';
    const url = init.method === 'GET'
      ? `${rule.url}${sep}value=${encodeURIComponent(value == null ? '' : String(value))}`
      : rule.url;
    const resp = await fetch(url, init);
    if (!resp.ok) return { valid: false, message: `远程校验返回 ${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    return normalizeResult(data.valid === undefined ? data.ok : data.valid);
  }
  if (!rule.customName || !rule.source) {
    return { error: { code: 'WORKER_ERROR', message: '远程规则缺少函数定义（URL 模式不可用或未提供）' }, localFallback: true };
  }
  const compiled = compileCustom(rule.source, rule.customName);
  if (!compiled) return { error: { code: 'WORKER_ERROR', message: '自定义异步规则无法在 Worker 中编译' }, localFallback: true };
  const reg = getRule(rule.customName);
  if (!reg) return { error: { code: 'WORKER_ERROR', message: `远程规则 ${rule.customName} 未注册` }, localFallback: true };
  return normalizeResult(await reg.handler(value, rule.params, ctx));
}

/** 执行单条规则任务。永不抛出，异常转为结构化 error。 */
export async function runTask(task) {
  const { field, rule, values, globals } = task;
  const value = getByPath(values, field);
  const ctx = { field, values, root: values, globals: globals || {} };

  // 本地执行路径：内联函数由 Validator 在构建任务时挂到 rule.fn
  if (typeof rule.fn === 'function' && rule.customName && !getRule(rule.customName)) {
    defineRule(rule.customName, rule.fn, { async: true });
  }

  try {
    // 条件不满足 → 跳过（视为通过）
    if (rule.condition) {
      const { compileExpression } = await import('./expression.js');
      if (!compileExpression(rule.condition).run(values, { globals: ctx.globals })) {
        return { field, key: rule.key, valid: true, skipped: true };
      }
    }

    // 空值短路（required 类除外）
    if (rule.skipEmpty && isEmptyValue(value)) {
      return { field, key: rule.key, valid: true, skipped: true };
    }

    let resultPromise;
    if (rule.name === 'remote') {
      resultPromise = runRemote(rule, value, ctx, task.signal).then((r) => {
        if (r.error) return { field, key: rule.key, valid: false, error: r.error };
        return { field, key: rule.key, ...r };
      });
    } else if (rule.name === 'custom') {
      const localFn = typeof rule.fn === 'function'
        ? rule.fn
        : (() => {
            let reg = getRule(rule.customName);
            if (!reg && rule.source && compileCustom(rule.source, rule.customName)) reg = getRule(rule.customName);
            return reg?.handler;
          })();
      if (!localFn) {
        return { field, key: rule.key, valid: false, error: { code: 'WORKER_ERROR', message: `自定义规则 ${rule.customName} 不可用（Worker 降级失败）` }, localFallback: true };
      }
      resultPromise = Promise.resolve().then(() => localFn(value, rule.params, ctx)).then(normalizeResult);
    } else {
      const reg = getRule(rule.name);
      if (!reg) return { field, key: rule.key, valid: false, error: { code: 'CONFIG_ERROR', message: `未注册的规则 ${rule.name}` } };
      resultPromise = Promise.resolve().then(() => reg.handler(value, rule.params, ctx)).then(normalizeResult);
    }

    const result = await withTimeout(resultPromise, rule.timeout || 0, rule.key);
    return { field, key: rule.key, ...result };
  } catch (e) {
    const code = e.code || (e.name === 'TimeoutError' ? 'RULE_TIMEOUT' : 'RULE_THREW');
    return {
      field,
      key: rule.key,
      valid: false,
      error: {
        code,
        name: e.name,
        message: e.message,
        stack: (e.stack || '').split('\n').slice(0, 3).join('\n'),
      },
    };
  }
}

/** 批量执行（Worker 入口调用）。 */
export async function runBatch(tasks) {
  return Promise.all(tasks.map(runTask));
}
