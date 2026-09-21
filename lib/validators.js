import { isBlank } from './engine-utils.js';
import { evaluateExpression } from './expressions.js';

function asNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

const validators = {
  custom({ value, values, params, field, services }) {
    const validator = services?.syncValidators?.[params.name];
    if (typeof validator !== 'function') throw new Error(`Custom validator is not registered: ${params.name}`);
    return validator({ value, values, params, field });
  },

  required({ value, params, field }) {
    if (!isBlank(value)) return true;
    return params.message || `${field} is required.`;
  },

  type({ value, params }) {
    if (isBlank(value)) return true;
    const expected = params.value;
    if (expected === 'number') return !Number.isNaN(asNumber(value)) || 'Must be a number.';
    if (expected === 'integer') return Number.isInteger(asNumber(value)) || 'Must be an integer.';
    if (expected === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)) || 'Must be a valid email.';
    if (expected === 'url') {
      try {
        new URL(String(value));
        return true;
      } catch {
        return 'Must be a valid URL.';
      }
    }
    if (expected === 'boolean') return typeof value === 'boolean' || 'Must be a boolean.';
    return `Unsupported type ${expected}.`;
  },

  min({ value, params }) {
    if (isBlank(value)) return true;
    const minimum = asNumber(params.value);
    return asNumber(value) >= minimum || `Must be at least ${minimum}.`;
  },

  max({ value, params }) {
    if (isBlank(value)) return true;
    const maximum = asNumber(params.value);
    return asNumber(value) <= maximum || `Must be no greater than ${maximum}.`;
  },

  between({ value, params }) {
    if (isBlank(value)) return true;
    const number = asNumber(value);
    return number >= asNumber(params.min) && number <= asNumber(params.max)
      || `Must be between ${params.min} and ${params.max}.`;
  },

  minLength({ value, params }) {
    if (isBlank(value)) return true;
    return String(value).length >= Number(params.value) || `Must be at least ${params.value} characters.`;
  },

  maxLength({ value, params }) {
    if (isBlank(value)) return true;
    return String(value).length <= Number(params.value) || `Must be no longer than ${params.value} characters.`;
  },

  oneOf({ value, params }) {
    if (isBlank(value)) return true;
    const choices = Array.isArray(params.values) ? params.values : [];
    return choices.some((choice) => String(choice) === String(value)) || `Must be one of: ${choices.join(', ')}.`;
  },

  pattern({ value, params }) {
    if (isBlank(value)) return true;
    try {
      return new RegExp(params.value, params.flags ?? '').test(String(value)) || (params.message || 'Invalid format.');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error.message}`);
    }
  },

  equalsField({ value, values, params }) {
    if (isBlank(value)) return true;
    const other = values?.[params.field];
    return value === other || (params.message || `Must match ${params.field}.`);
  },

  expression({ value, values, params }) {
    const result = evaluateExpression(params.expression, values);
    return Boolean(result) || (params.message || 'Expression must be true.');
  }
};

export function validateWithBuiltin(rule, values, services) {
  const validator = validators[rule.type];
  if (!validator) throw new Error(`Unknown rule type: ${rule.type}`);
  const value = values?.[rule.field];
  const result = validator({ value, values, params: rule.params ?? {}, field: rule.field, rule, services });
  return result === true || result === undefined ? true : typeof result === 'string' ? result : rule.message;
}

export function hasBuiltinValidator(type) {
  return Object.prototype.hasOwnProperty.call(validators, type);
}
