/**
 * 通用工具函数。
 */

/** 生成唯一 id（主线程/Worker 均可用，不依赖 crypto 随机性强度）。 */
let _seq = 0;
export function uid(prefix = 'id') {
  _seq = (_seq + 1) % 1e9;
  return `${prefix}_${Date.now().toString(36)}_${_seq}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 深拷贝（仅支持结构化克隆可序列化的数据；自定义规则函数单独处理）。 */
export function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 防抖（leading=false），返回带 .cancel() 的函数。 */
export function debounce(fn, wait = 120) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

/** Promise 超时包装：超时后抛出 TimeoutError，但不取消底层任务。 */
export class TimeoutError extends Error {
  constructor(message = 'Validation timeout') {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'RULE_TIMEOUT';
  }
}

export function withTimeout(promise, ms, label = 'rule') {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`规则 ${label} 超过 ${ms}ms 未返回`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 拓扑排序（Kahn）。返回 { order, cycles }。 */
export function topoSort(nodes, edges) {
  const indegree = new Map(nodes.map((n) => [n, 0]));
  const adjacency = new Map(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) {
    if (!adjacency.has(from) || !adjacency.has(to)) continue;
    adjacency.get(from).push(to);
    indegree.set(to, (indegree.get(to) || 0) + 1);
  }
  const queue = nodes.filter((n) => indegree.get(n) === 0);
  const order = [];
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    for (const next of adjacency.get(node)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const cycles = nodes.filter((n) => !order.includes(n));
  return { order, cycles };
}

/** 按路径取值：getByPath(obj, 'a.b[0].c')。 */
export function getByPath(obj, path) {
  if (obj == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = splitPath(path);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 按路径设值（自动创建中间对象/数组）。 */
export function setByPath(obj, path, value) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = parts[i + 1];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(next) ? [] : {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function splitPath(path) {
  const parts = [];
  const re = /[^.[\]]+|\[(?:(-?\d+)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]/g;
  let m;
  while ((m = re.exec(path))) {
    if (m[3] !== undefined) parts.push(m[3].replace(/\\(.)/g, '$1'));
    else parts.push(m[1] !== undefined ? m[1] : m[0]);
  }
  return parts;
}

/** 空值判定：null/undefined/''（空白串可选）视为空。 */
export function isEmptyValue(value, { trim = true } = {}) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return trim ? value.trim() === '' : value === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 简单 JSON 稳定序列化（用于缓存 key）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function defineNonEnumerable(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
}
