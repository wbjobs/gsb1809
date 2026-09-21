/**
 * 内置规则库。规则统一签名：
 *   (value, params, ctx) => boolean | string | Promise<boolean | string>
 * 返回 true 表示通过；false / 字符串 表示失败（字符串可作为错误消息）。
 * ctx: { field, values, root, rule, signal }
 */
import { compileExpression } from './expression.js';
import { isEmptyValue, getByPath } from './utils.js';

const EMAIL_RE = /^[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const URL_RE = /^(https?:)?\/\/[^\s/$.?#].[^\s]*$|^https?:\/\/[^\s]+$/i;

function isNumeric(v) {
  if (typeof v === 'number') return !Number.isNaN(v);
  if (typeof v === 'string' && v.trim() !== '') return !Number.isNaN(Number(v));
  return false;
}

function toNumber(v) { return typeof v === 'number' ? v : Number(v); }

function asRegExp(params) {
  if (params instanceof RegExp) return params;
  if (typeof params === 'string') return new RegExp(params);
  return new RegExp(params.pattern, params.flags);
}

/** 内置规则表。 */
export const builtinRules = {
  required(value, params, ctx) {
    const { trim = true } = params || {};
    return !isEmptyValue(value, { trim });
  },

  requiredIf(value, params, ctx) {
    const passed = compileExpression(params.expr ?? params).run(ctx.values, { globals: ctx.globals });
    return passed ? !isEmptyValue(value) : true;
  },

  requiredUnless(value, params, ctx) {
    const passed = compileExpression(params.expr ?? params).run(ctx.values, { globals: ctx.globals });
    return passed ? true : !isEmptyValue(value);
  },

  type(value, params) {
    const type = typeof params === 'string' ? params : params.type;
    if (isEmptyValue(value)) return true;
    switch (type) {
      case 'number': return isNumeric(value);
      case 'integer': return isNumeric(value) && Number.isInteger(toNumber(value));
      case 'string': return typeof value === 'string';
      case 'boolean': return typeof value === 'boolean' || value === 'true' || value === 'false';
      case 'array': return Array.isArray(value);
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
      case 'email': return EMAIL_RE.test(String(value));
      case 'url': return URL_RE.test(String(value));
      default: throw new Error(`未知类型规则: ${type}`);
    }
  },

  min(value, params) {
    if (isEmptyValue(value)) return true;
    const threshold = typeof params === 'object' ? params.value : params;
    if (typeof value === 'string' || Array.isArray(value)) return value.length >= threshold;
    return toNumber(value) >= toNumber(threshold);
  },

  max(value, params) {
    if (isEmptyValue(value)) return true;
    const threshold = typeof params === 'object' ? params.value : params;
    if (typeof value === 'string' || Array.isArray(value)) return value.length <= threshold;
    return toNumber(value) <= toNumber(threshold);
  },

  minLength(value, params) {
    if (isEmptyValue(value)) return true;
    const threshold = typeof params === 'object' ? params.value : params;
    return String(value).length >= threshold;
  },

  maxLength(value, params) {
    if (isEmptyValue(value)) return true;
    const threshold = typeof params === 'object' ? params.value : params;
    return String(value).length <= threshold;
  },

  between(value, params) {
    if (isEmptyValue(value)) return true;
    const min = typeof params === 'object' ? params.min : params[0];
    const max = typeof params === 'object' ? params.max : params[1];
    if (typeof value === 'string' || Array.isArray(value)) return value.length >= min && value.length <= max;
    const n = toNumber(value);
    return n >= toNumber(min) && n <= toNumber(max);
  },

  pattern(value, params) {
    if (isEmptyValue(value)) return true;
    return asRegExp(params).test(String(value));
  },

  email(value) { return isEmptyValue(value) || EMAIL_RE.test(String(value)); },
  url(value) { return isEmptyValue(value) || URL_RE.test(String(value)); },
  numeric(value) { return isEmptyValue(value) || isNumeric(value); },
  integer(value) { return isEmptyValue(value) || (isNumeric(value) && Number.isInteger(toNumber(value))); },
  boolean(value) { return isEmptyValue(value) || typeof value === 'boolean'; },
  alpha(value) { return isEmptyValue(value) || /^[A-Za-z]+$/.test(String(value)); },
  alnum(value) { return isEmptyValue(value) || /^[A-Za-z0-9]+$/.test(String(value)); },

  oneOf(value, params) {
    if (isEmptyValue(value)) return true;
    const options = Array.isArray(params) ? params : params.options;
    return options.includes(value);
  },

  notOneOf(value, params) {
    if (isEmptyValue(value)) return true;
    const options = Array.isArray(params) ? params : params.options;
    return !options.includes(value);
  },

  same(value, params, ctx) {
    if (isEmptyValue(value)) return true;
    const other = typeof params === 'string' ? params : params.other;
    return value === getByPath(ctx.values, other);
  },

  different(value, params, ctx) {
    if (isEmptyValue(value)) return true;
    const other = typeof params === 'string' ? params : params.other;
    return value !== getByPath(ctx.values, other);
  },

  expression(value, params, ctx) {
    const source = typeof params === 'string' ? params : params.expr;
    return Boolean(compileExpression(source).run(ctx.values, { globals: ctx.globals }));
  },
};

/** 各内置规则除当前字段外额外依赖的字段（供依赖图构建）。 */
export function builtinExtraDeps(name, params) {
  const deps = [];
  const pushFromExpr = (expr) => {
    if (!expr) return;
    for (const dep of compileExpression(expr).deps) deps.push(dep);
  };
  switch (name) {
    case 'requiredIf':
    case 'requiredUnless':
      pushFromExpr(typeof params === 'string' ? params : params.expr);
      break;
    case 'same':
    case 'different':
      deps.push(typeof params === 'string' ? params : params.other);
      break;
    case 'expression':
      pushFromExpr(typeof params === 'string' ? params : params.expr);
      break;
    default:
      break;
  }
  return deps;
}

/** 自定义规则注册表（可被 Worker bootstrap）。 */
export const customRules = new Map();

export function defineRule(name, handler, options = {}) {
  if (typeof handler !== 'function') throw new Error('规则必须是函数');
  customRules.set(name, { handler, async: !!options.async, deps: options.deps || null });
}

export function getRule(name) {
  if (customRules.has(name)) return { type: 'custom', ...customRules.get(name) };
  if (Object.prototype.hasOwnProperty.call(builtinRules, name)) return { type: 'builtin', handler: builtinRules[name] };
  return null;
}
