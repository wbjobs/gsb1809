/**
 * 安全表达式编译器：词法分析 + Pratt 解析 + AST 解释执行。
 * 不使用 eval / new Function，可在 Worker 与严格 CSP 环境运行。
 *
 * 支持：字面量、字段路径（a.b[0]）、算术/比较/逻辑/三元/括号、
 *       管道式函数调用、成员方法白名单。
 * 用法：compile('age >= 18 && country == "CN"').run(values, ctx)
 */

const OPS = {
  '||': { prec: 1, assoc: 'L' },
  '&&': { prec: 2, assoc: 'L' },
  '==': { prec: 3, assoc: 'L' },
  '!=': { prec: 3, assoc: 'L' },
  '===': { prec: 3, assoc: 'L' },
  '!==': { prec: 3, assoc: 'L' },
  '>': { prec: 4, assoc: 'L' },
  '>=': { prec: 4, assoc: 'L' },
  '<': { prec: 4, assoc: 'L' },
  '<=': { prec: 4, assoc: 'L' },
  '+': { prec: 5, assoc: 'L' },
  '-': { prec: 5, assoc: 'L' },
  '*': { prec: 6, assoc: 'L' },
  '/': { prec: 6, assoc: 'L' },
  '%': { prec: 6, assoc: 'L' },
  '??': { prec: 1, assoc: 'L' },
};

const UNARY = new Set(['-', '!', '+']);

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const push = (type, value, pos) => tokens.push({ type, value, pos });
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '.') { push('dot', '.', i); i++; continue; }
    if (ch === ',') { push('comma', ',', i); i++; continue; }
    if (ch === '(') { push('lparen', '(', i); i++; continue; }
    if (ch === ')') { push('rparen', ')', i); i++; continue; }
    if (ch === '[') { push('lbracket', '[', i); i++; continue; }
    if (ch === ']') { push('rbracket', ']', i); i++; continue; }
    if (ch === ':') { push('colon', ':', i); i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let str = '';
      while (j < expr.length && expr[j] !== quote) {
        if (expr[j] === '\\' && j + 1 < expr.length) { str += expr[j + 1]; j += 2; }
        else { str += expr[j]; j++; }
      }
      if (expr[j] !== quote) throw new ExpressionError(`字符串缺少结束引号`, i);
      push('string', str, i);
      i = j + 1;
      continue;
    }
    if (expr.startsWith('===', i) || expr.startsWith('!==', i)) {
      push('op', expr.slice(i, i + 3), i); i += 3; continue;
    }
    if (expr.startsWith('??', i)) { push('op', '??', i); i += 2; continue; }
    if (ch === '?') { push('question', '?', i); i++; continue; }
    if ('<>!=&|*+-%/?'.includes(ch)) {
      const two = expr.slice(i, i + 2);
      if (OPS[two]) { push('op', two, i); i += 2; continue; }
      if (OPS[ch]) { push('op', ch, i); i++; continue; }
      throw new ExpressionError(`未知运算符 "${ch}"`, i);
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const raw = expr.slice(i, j);
      if ((raw.match(/\./g) || []).length > 1) throw new ExpressionError(`非法数字 ${raw}`, i);
      push('number', Number(raw), i);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_$]/.test(expr[j])) j++;
      const word = expr.slice(i, j);
      if (word === 'true') push('bool', true, i);
      else if (word === 'false') push('bool', false, i);
      else if (word === 'null') push('null', null, i);
      else if (word === 'undefined') push('undefined', undefined, i);
      else push('ident', word, i);
      i = j;
      continue;
    }
    throw new ExpressionError(`无法识别的字符 "${ch}"`, i);
  }
  push('eof', null, expr.length);
  return tokens;
}

export class ExpressionError extends Error {
  constructor(message, pos) {
    super(`${message}（位置 ${pos}）`);
    this.name = 'ExpressionError';
    this.code = 'EXPRESSION_ERROR';
    this.pos = pos;
  }
}

/** Pratt 解析器，产出 AST。 */
class Parser {
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  get peek() { return this.tokens[this.i]; }
  consume(type, value) {
    const t = this.peek;
    if (type && t.type !== type) throw new ExpressionError(`期望 ${type}，实际为 "${t.value}"`, t.pos);
    if (value !== undefined && t.value !== value) throw new ExpressionError(`期望 "${value}"，实际为 "${t.value}"`, t.pos);
    this.i++;
    return t;
  }
  parse() {
    const ast = this.parseExpression(0);
    if (this.peek.type !== 'eof') throw new ExpressionError(`多余的 token "${this.peek.value}"`, this.peek.pos);
    return ast;
  }
  parseExpression(minPrec) {
    let left = this.parsePrefix();
    while (this.peek.type === 'op' && OPS[this.peek.value].prec >= minPrec) {
      const op = this.consume('op').value;
      const { prec, assoc } = OPS[op];
      const right = this.parseExpression(assoc === 'L' ? prec + 1 : prec);
      left = { kind: 'binary', op, left, right };
    }
    if (minPrec <= 1 && this.peek.type === 'question') {
      this.consume('question');
      const consequent = this.parseExpression(0);
      this.consume('colon');
      const alternate = this.parseExpression(0);
      return { kind: 'ternary', test: left, consequent, alternate };
    }
    return left;
  }
  parsePrefix() {
    const t = this.peek;
    if (t.type === 'op' && UNARY.has(t.value)) {
      this.consume('op');
      return { kind: 'unary', op: t.value, arg: this.parsePrefix() };
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    let node = this.parsePrimary();
    while (true) {
      if (this.peek.type === 'dot') {
        this.consume('dot');
        const prop = this.consume('ident').value;
        node = { kind: 'member', object: node, property: prop, computed: false };
      } else if (this.peek.type === 'lbracket') {
        this.consume('lbracket');
        const index = this.parseExpression(0);
        this.consume('rbracket');
        node = { kind: 'member', object: node, property: index, computed: true };
      } else if (this.peek.type === 'lparen' && node.kind === 'ident') {
        node = { kind: 'call', callee: node.name, args: this.parseArgs() };
      } else if (this.peek.type === 'lparen' && node.kind === 'member') {
        node = { kind: 'method', target: node.object, name: node.property, args: this.parseArgs() };
      } else break;
    }
    return node;
  }
  parseArgs() {
    this.consume('lparen');
    const args = [];
    if (this.peek.type !== 'rparen') {
      args.push(this.parseExpression(0));
      while (this.peek.type === 'comma') { this.consume('comma'); args.push(this.parseExpression(0)); }
    }
    this.consume('rparen');
    return args;
  }
  parsePrimary() {
    const t = this.peek;
    switch (t.type) {
      case 'number': this.consume(); return { kind: 'literal', value: t.value };
      case 'string': this.consume(); return { kind: 'literal', value: t.value };
      case 'bool':
      case 'null':
      case 'undefined': this.consume(); return { kind: 'literal', value: t.value };
      case 'ident': this.consume(); return { kind: 'ident', name: t.value };
      case 'lparen': {
        this.consume('lparen');
        const ast = this.parseExpression(0);
        this.consume('rparen');
        return ast;
      }
      case 'lbracket': {
        this.consume('lbracket');
        const items = [];
        if (this.peek.type !== 'rbracket') {
          items.push(this.parseExpression(0));
          while (this.peek.type === 'comma') { this.consume('comma'); items.push(this.parseExpression(0)); }
        }
        this.consume('rbracket');
        return { kind: 'array', items };
      }
      default:
        throw new ExpressionError(`意外的 token "${t.value}"`, t.pos);
    }
  }
}

/** 允许的成员方法白名单（防原型链逃逸）。 */
const METHOD_WHITELIST = {
  string: ['includes', 'startsWith', 'endsWith', 'trim', 'toLowerCase', 'toUpperCase', 'slice', 'split', 'replace', 'match', 'length_of'],
  array: ['includes', 'indexOf', 'join', 'slice', 'map', 'filter', 'some', 'every', 'find', 'flat', 'length_of'],
  number: ['toFixed'],
};

const TYPE_OF = (v) => (Array.isArray(v) ? 'array' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : null);

/** 求值期可用的全局函数（纯函数）。 */
const GLOBAL_FNS = {
  len: (v) => (v == null ? 0 : v.length),
  abs: Math.abs,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  pow: Math.pow,
  regex: (v, pattern, flags) => new RegExp(pattern, flags).test(String(v ?? '')),
  test: (v, pattern, flags) => new RegExp(pattern, flags).test(String(v ?? '')),
  inRange: (v, min, max) => Number(v) >= Number(min) && Number(v) <= Number(max),
  between: (v, min, max) => Number(v) > Number(min) && Number(v) < Number(max),
  enum: (v, ...list) => list.some((x) => x === v),
  isBlank: (v) => v === null || v === undefined || String(v).trim() === '',
  notBlank: (v) => !(v === null || v === undefined || String(v).trim() === ''),
  lower: (v) => String(v ?? '').toLowerCase(),
  upper: (v) => String(v ?? '').toUpperCase(),
  and: (...a) => a.every(Boolean),
  or: (...a) => a.some(Boolean),
};

/** 全局根对象白名单（仅暴露其纯函数/常量）。 */
const ROOT_OBJECTS = { Math, Number, String, Boolean, Date, JSON };

const FORBIDDEN_PROPS = new Set(['constructor', '__proto__', 'prototype']);

class Evaluator {
  constructor(ast) { this.ast = ast; }

  run(values, ctx = {}) {
    const scope = Object.assign(Object.create(null), {
      $values: values,
      $root: values,
    }, ctx.extra || {});
    return this.eval(this.ast, values, scope, ctx);
  }

  eval(node, values, scope, ctx) {
    switch (node.kind) {
      case 'literal': return node.value;
      case 'array': return node.items.map((n) => this.eval(n, values, scope, ctx));
      case 'ident': {
        if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
        if (Object.prototype.hasOwnProperty.call(values || {}, node.name)) return values[node.name];
        if (Object.prototype.hasOwnProperty.call(GLOBAL_FNS, node.name)) return GLOBAL_FNS[node.name];
        if (Object.prototype.hasOwnProperty.call(ROOT_OBJECTS, node.name)) return ROOT_OBJECTS[node.name];
        if (Object.prototype.hasOwnProperty.call(ctx.globals || {}, node.name)) return ctx.globals[node.name];
        throw new ExpressionError(`未知标识符 "${node.name}"`, 0);
      }
      case 'member': {
        const obj = this.eval(node.object, values, scope, ctx);
        const prop = node.computed ? this.eval(node.property, values, scope, ctx) : node.property;
        if (FORBIDDEN_PROPS.has(prop)) throw new ExpressionError(`禁止访问属性 "${prop}"`, 0);
        if (obj == null) return undefined;
        if (typeof prop === 'string' && prop === 'length') return obj.length;
        return obj[prop];
      }
      case 'call': {
        const fn = this.eval({ kind: 'ident', name: node.callee }, values, scope, ctx);
        if (typeof fn !== 'function') throw new ExpressionError(`${node.callee} 不是函数`, 0);
        return fn(...node.args.map((a) => this.eval(a, values, scope, ctx)));
      }
      case 'method': {
        const target = this.eval(node.target, values, scope, ctx);
        if (target == null) return undefined;
        const type = TYPE_OF(target);
        const allowed = type && METHOD_WHITELIST[type];
        if (!allowed || (!allowed.includes(node.name) && node.name !== 'length')) {
          throw new ExpressionError(`方法 "${node.name}" 不在白名单内`, 0);
        }
        const args = node.args.map((a) => this.eval(a, values, scope, ctx));
        if (node.name === 'length_of') return target.length;
        if (node.name === 'map' || node.name === 'filter' || node.name === 'some' || node.name === 'every' || node.name === 'find') {
          throw new ExpressionError(`高阶方法 ${node.name} 不被支持，请使用全局函数`, 0);
        }
        return target[node.name](...args);
      }
      case 'unary': {
        const v = this.eval(node.arg, values, scope, ctx);
        if (node.op === '-') return -v;
        if (node.op === '+') return +v;
        return !v;
      }
      case 'binary': return this.binary(node, values, scope, ctx);
      case 'ternary':
        return this.eval(node.test, values, scope, ctx)
          ? this.eval(node.consequent, values, scope, ctx)
          : this.eval(node.alternate, values, scope, ctx);
      default:
        throw new ExpressionError(`未知 AST 节点 ${node.kind}`, 0);
    }
  }

  binary(node, values, scope, ctx) {
    const { op } = node;
    if (op === '&&') return this.eval(node.left, values, scope, ctx) && this.eval(node.right, values, scope, ctx);
    if (op === '||') return this.eval(node.left, values, scope, ctx) || this.eval(node.right, values, scope, ctx);
    if (op === '??') {
      const l = this.eval(node.left, values, scope, ctx);
      return l === null || l === undefined ? this.eval(node.right, values, scope, ctx) : l;
    }
    const l = this.eval(node.left, values, scope, ctx);
    const r = this.eval(node.right, values, scope, ctx);
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
      case '==': return l == r;
      case '!=': return l != r;
      case '===': return l === r;
      case '!==': return l !== r;
      case '>': return l > r;
      case '>=': return l >= r;
      case '<': return l < r;
      case '<=': return l <= r;
      default: throw new ExpressionError(`未知运算符 ${op}`, 0);
    }
  }
}

/** 收集 AST 中引用的字段路径（ident 及其后的静态成员链）。 */
function collectDeps(ast, deps) {
  if (!ast || typeof ast !== 'object') return;
  if (ast.kind === 'ident') { deps.add(ast.name); return; }
  if (ast.kind === 'member' && !ast.computed) {
    let path = '';
    let cur = ast;
    const chain = [];
    while (cur && cur.kind === 'member' && !cur.computed) { chain.unshift(cur.property); cur = cur.object; }
    if (cur && cur.kind === 'ident') {
      path = [cur.name, ...chain].join('.');
      deps.add(path);
      deps.add(cur.name);
    }
    return;
  }
  for (const key of Object.keys(ast)) {
    const child = ast[key];
    if (Array.isArray(child)) child.forEach((c) => collectDeps(c, deps));
    else collectDeps(child, deps);
  }
}

const cache = new Map();

/** 编译表达式，返回 { run, deps, source }。 */
export function compileExpression(source) {
  if (cache.has(source)) return cache.get(source);
  if (typeof source !== 'string' || !source.trim()) throw new ExpressionError('表达式必须是非空字符串', 0);
  const tokens = tokenize(source);
  const ast = new Parser(tokens).parse();
  const evaluator = new Evaluator(ast);
  const deps = new Set();
  collectDeps(ast, deps);
  const compiled = {
    source,
    deps: [...deps],
    run(values, ctx) { return evaluator.run(values, ctx); },
  };
  cache.set(source, compiled);
  return compiled;
}

export function extractExpressionDeps(source) {
  return compileExpression(source).deps;
}
