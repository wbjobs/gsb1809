import { getPath, isPlainObject } from './engine-utils.js';

function asNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function compare(left, right) {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;

  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber) && typeof left !== 'boolean' && typeof right !== 'boolean') {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }

  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function includesText(left, right) {
  return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  if (value === undefined || value === null) return [];
  return [value];
}

const operators = {
  '==': ({ args }) => args.length === 0 || args.every((arg) => compare(arg, args[0]) === 0),
  '!=': ({ args }) => args.some((arg) => compare(arg, args[0]) !== 0),
  '>': ({ args }) => args.length === 2 && compare(args[0], args[1]) > 0,
  '>=': ({ args }) => args.length === 2 && compare(args[0], args[1]) >= 0,
  '<': ({ args }) => args.length === 2 && compare(args[0], args[1]) < 0,
  '<=': ({ args }) => args.length === 2 && compare(args[0], args[1]) <= 0,
  and: ({ args }) => args.every(Boolean),
  or: ({ args }) => args.some(Boolean),
  not: ({ args }) => !args[0],
  in: ({ args }) => toArray(args[1]).some((item) => compare(item, args[0]) === 0),
  'not-in': ({ args }) => !toArray(args[1]).some((item) => compare(item, args[0]) === 0),
  contains: ({ args }) => includesText(args[0], args[1]),
  'starts-with': ({ args }) => String(args[0] ?? '').startsWith(String(args[1] ?? '')),
  'ends-with': ({ args }) => String(args[0] ?? '').endsWith(String(args[1] ?? '')),
  regex: ({ args }) => new RegExp(String(args[1] ?? ''), String(args[2] ?? '')).test(String(args[0] ?? '')),
  length: ({ args }) => String(args[0] ?? '').length,
  min: ({ args }) => Math.min(...args.map(asNumber)),
  max: ({ args }) => Math.max(...args.map(asNumber)),
  sum: ({ args }) => args.reduce((total, item) => total + (asNumber(item) || 0), 0),
  '+': ({ args }) => args.reduce((total, item) => total + (asNumber(item) || 0), 0),
  '-': ({ args }) => args.length === 1 ? -asNumber(args[0]) : asNumber(args[0]) - asNumber(args[1]),
  '*': ({ args }) => args.reduce((total, item) => total * asNumber(item), 1),
  '/': ({ args }) => asNumber(args[0]) / asNumber(args[1]),
  '%': ({ args }) => asNumber(args[0]) % asNumber(args[1]),
  abs: ({ args }) => Math.abs(asNumber(args[0])),
  round: ({ args }) => Math.round(asNumber(args[0])),
  ceil: ({ args }) => Math.ceil(asNumber(args[0])),
  floor: ({ args }) => Math.floor(asNumber(args[0])),
  'is-blank': ({ args }) => args[0] === undefined || args[0] === null || args[0] === '',
  'is-number': ({ args }) => !Number.isNaN(asNumber(args[0])) && args[0] !== ''
};

export function evaluateExpression(node, values) {
  if (Array.isArray(node)) return node.map((item) => evaluateExpression(item, values));
  if (node === null || typeof node !== 'object') return node;

  if (node.ref) {
    if (!/^(\$values|\$root)(\.[A-Za-z_$][\w$]*)*$/.test(node.ref)) {
      throw new Error(`Unsafe field reference: ${node.ref}`);
    }
    return getPath(values, node.ref);
  }

  if (node.value !== undefined || Object.prototype.hasOwnProperty.call(node, 'value')) return node.value;

  const operatorNames = Object.keys(node);
  if (operatorNames.length !== 1) {
    throw new Error('An expression node must contain exactly one operator.');
  }

  const operator = operatorNames[0];
  const operation = operators[operator];
  if (!operation) throw new Error(`Unsupported expression operator: ${operator}`);

  const rawArgs = node[operator];
  const args = Array.isArray(rawArgs)
    ? rawArgs.map((arg) => evaluateExpression(arg, values))
    : [evaluateExpression(rawArgs, values)];

  return operation({ args, values });
}

export function collectReferences(node, references = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, references);
    return references;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return references;
  if (typeof node.ref === 'string') {
    const field = node.ref.split('.').find((part) => part !== '$values' && part !== '$root');
    if (field) references.add(field);
    return references;
  }
  if (isPlainObject(node) && !('value' in node)) {
    for (const value of Object.values(node)) collectReferences(value, references);
  }
  return references;
}
