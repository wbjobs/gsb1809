export const CONFIG_FIELD = '$config';
export const SYSTEM_FIELD = '$system';

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isBlank(value) {
  return value === undefined || value === null || value === '';
}

export function cloneJson(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function makeError(code, message, field = SYSTEM_FIELD, extra = {}) {
  return { code, message, field, severity: 'error', ...extra };
}

export function makeWarning(code, message, field = SYSTEM_FIELD, extra = {}) {
  return { code, message, field, severity: 'warning', ...extra };
}

export function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

export function getPath(source, path) {
  if (path === '$values') return source;
  if (path === '$root') return source;
  const parts = String(path).split('.').filter((part) => part !== '$values' && part !== '$root');
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function aggregateResults(results) {
  const errors = [];
  const warnings = [];
  const fields = {};
  const statusByRule = {};

  for (const result of results) {
    if (!result || !result.ruleId) continue;
    statusByRule[result.ruleId] = result.status;
    if (result.status === 'valid' || result.status === 'skipped') continue;

    const issue = {
      code: result.code || result.status,
      message: result.message || `Rule ${result.ruleId} did not pass.`,
      field: result.field || SYSTEM_FIELD,
      severity: result.status === 'warning' ? 'warning' : 'error',
      ruleId: result.ruleId,
      dependencies: result.dependencies ? [...result.dependencies] : []
    };
    (issue.severity === 'warning' ? warnings : errors).push(issue);
    if (!fields[issue.field]) fields[issue.field] = [];
    fields[issue.field].push(issue);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fields,
    statusByRule
  };
}
