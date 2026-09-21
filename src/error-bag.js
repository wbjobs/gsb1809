/**
 * 错误聚合容器：字段级错误 + 表单级错误 + 引擎异常（timeout/threw/rejected/config）。
 */
export const FORM_SCOPE = '$form';

export class ErrorBag {
  constructor() {
    /** field -> [{ rule, message, code, level }] */
    this.errors = new Map();
  }

 add(field, entry) {
    const list = this.errors.get(field) || [];
    list.push(entry);
    this.errors.set(field, list);
  }

  /** 合并一批规则结果（会先按字段清空再写入由本次校验产生的键）。 */
  applyResults(results, { fieldFilter, ruleMessages, getLabel } = {}) {
    const touchedFields = new Set(results.map((r) => r.field));
    if (fieldFilter) for (const f of touchedFields) if (!fieldFilter.has(f)) touchedFields.delete(f);
    for (const f of touchedFields) this.errors.delete(f);
    for (const r of results) {
      if (fieldFilter && !fieldFilter.has(r.field)) continue;
      if (r.valid || r.skipped) continue;
      this.add(r.field, {
        rule: r.key,
        message: r.message || ruleMessages?.(r) || `${getLabel?.(r.field) || r.field}校验未通过`,
        code: r.error?.code || 'RULE_FAILED',
        level: r.error ? (r.error.code === 'RULE_THREW' || r.error.code === 'WORKER_ERROR' ? 'exception' : 'error') : 'error',
        detail: r.error?.message,
      });
    }
  }

  get(field) { return this.errors.get(field) || []; }
  first(field) { return this.get(field)[0] || null; }
  firstMessage(field) { return this.first(field)?.message || null; }
  has(field) {
    if (field === undefined) return this.errors.size > 0;
    return this.errors.has(field);
  }
  fields() { return [...this.errors.keys()]; }
  all() {
    const out = [];
    for (const [field, list] of this.errors) {
      for (const e of list) out.push({ field, ...e });
    }
    return out;
  }
  clear(field) {
    if (field === undefined) this.errors.clear();
    else this.errors.delete(field);
  }
  /** 异常类问题（规则抛错/线程异常/配置错误），用于醒目提示与上报。 */
  exceptions() { return this.all().filter((e) => e.level === 'exception' || e.code === 'CONFIG_ERROR'); }
  toJSON() {
    const obj = {};
    for (const [field, list] of this.errors) obj[field] = list;
    if (!obj[FORM_SCOPE]) obj[FORM_SCOPE] = [];
    return obj;
  }
}

/** 极简同步事件总线（无外部依赖）。 */
export class Emitter {
  constructor() { this.listeners = new Map(); }
  on(event, fn) {
    const set = this.listeners.get(event) || new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }
  once(event, fn) {
    const off = this.on(event, (...args) => { off(); fn(...args); });
    return off;
  }
  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(payload); } catch (e) { /* 监听器异常不影响引擎 */ }
    }
    for (const fn of this.listeners.get('*') || []) {
      try { fn(event, payload); } catch { /* ignore */ }
    }
  }
}
