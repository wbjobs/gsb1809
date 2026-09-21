import { CONFIG_FIELD, cloneJson, isPlainObject, makeError, pushUnique } from './engine-utils.js';
import { collectReferences } from './expressions.js';

const ALLOWED_SEVERITIES = new Set(['error', 'warning']);

function normalizeStringList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

function normalizeRule(rawRule, index, seenIds, configErrors) {
  if (!isPlainObject(rawRule)) {
    configErrors.push(makeError('RULE_NOT_OBJECT', `Rule at index ${index} must be an object.`, CONFIG_FIELD, { ruleIndex: index }));
    return null;
  }

  const declaredId = typeof rawRule.id === 'string' && rawRule.id.trim() ? rawRule.id : `$rule.${index}`;
  if (declaredId !== rawRule.id && rawRule.id !== undefined) {
    configErrors.push(makeError('INVALID_RULE_ID', `Rule at index ${index} has an invalid id; using ${declaredId}.`, CONFIG_FIELD, { ruleIndex: index, fallbackId: declaredId }));
  }

  const id = seenIds.has(declaredId) ? `${declaredId}.$${seenIds.get(declaredId)}` : declaredId;
  seenIds.set(declaredId, (seenIds.get(declaredId) ?? 0) + 1);
  if (id !== declaredId) {
    configErrors.push(makeError('DUPLICATE_RULE_ID', `Duplicate rule id ${declaredId}; using ${id}.`, CONFIG_FIELD, { ruleIndex: index, originalId: declaredId, ruleId: id }));
  }

  const field = typeof rawRule.field === 'string' && rawRule.field.trim() ? rawRule.field : null;
  if (!field) {
    configErrors.push(makeError('MISSING_FIELD', `Rule ${id} must declare a field.`, CONFIG_FIELD, { ruleIndex: index, ruleId: id }));
    return null;
  }

  const type = typeof rawRule.type === 'string' ? rawRule.type : null;
  if (!type) {
    configErrors.push(makeError('MISSING_TYPE', `Rule ${id} must declare a type.`, field, { ruleIndex: index, ruleId: id }));
    return null;
  }

  const severity = ALLOWED_SEVERITIES.has(rawRule.severity) ? rawRule.severity : 'error';
  const dependencies = new Set(normalizeStringList(rawRule.dependsOn));
  const prerequisiteRules = new Set(normalizeStringList(rawRule.requiresRules));

  const when = rawRule.when === undefined ? undefined : rawRule.when;
  if (when !== undefined && (!isPlainObject(when) || Object.keys(when).length !== 1)) {
    configErrors.push(makeError('INVALID_CONDITION', `Rule ${id} has an invalid when expression.`, field, { ruleId: id }));
  }
  collectReferences(when, dependencies);
  if (['custom', 'expression'].includes(type)) collectReferences(rawRule.params, dependencies);
  if (type === 'async' && isPlainObject(rawRule.params)) collectReferences(rawRule.params.payload, dependencies);
  dependencies.delete(field);

  return {
    ...cloneJson(rawRule),
    id,
    field,
    type,
    message: typeof rawRule.message === 'string' && rawRule.message ? rawRule.message : `${field} failed ${type} validation.`,
    severity,
    params: rawRule.params === undefined ? {} : rawRule.params,
    when,
    dependsOn: [...dependencies],
    requiresRules: [...prerequisiteRules],
    order: index,
    async: type === 'async' || rawRule.async === true
  };
}

export function normalizeRules(rawRules) {
  const configErrors = [];
  if (!Array.isArray(rawRules)) {
    return { rules: [], errors: [makeError('RULES_NOT_ARRAY', 'The rules configuration must be an array.', CONFIG_FIELD)] };
  }

  const seenIds = new Map();
  const rules = rawRules
    .map((rule, index) => normalizeRule(rule, index, seenIds, configErrors))
    .filter(Boolean);

  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  for (const rule of rules) {
    const missing = rule.requiresRules.filter((id) => !byId.has(id));
    if (missing.length) {
      configErrors.push(makeError('MISSING_RULE_DEPENDENCY', `Rule ${rule.id} depends on missing rules: ${missing.join(', ')}.`, rule.field, { ruleId: rule.id, missing }));
    }
    for (const field of rule.dependsOn) {
      if (!/^[A-Za-z_$][\w$]*$/.test(field)) {
        configErrors.push(makeError('INVALID_FIELD_DEPENDENCY', `Rule ${rule.id} has an invalid field dependency: ${field}.`, rule.field, { ruleId: rule.id, field }));
      }
    }
  }

  return { rules, errors: configErrors };
}

export function orderRulesByDependencies(rules) {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const remaining = new Set(rules.map((rule) => rule.id));
  const ordered = [];
  const cycleEdges = [];

  while (remaining.size) {
    const ready = rules
      .filter((rule) => remaining.has(rule.id))
      .filter((rule) => rule.requiresRules.every((dependency) => !remaining.has(dependency) || !byId.has(dependency)))
      .sort((a, b) => a.order - b.order);

    if (!ready.length) {
      for (const rule of rules) {
        if (!remaining.has(rule.id)) continue;
        for (const dependency of rule.requiresRules) {
          if (remaining.has(dependency)) cycleEdges.push({ ruleId: rule.id, dependency });
        }
      }
      break;
    }

    for (const rule of ready) {
      ordered.push(rule);
      remaining.delete(rule.id);
    }
  }

  return { ordered, cycles: cycleEdges, skippedIds: [...remaining] };
}

export function ruleDependencyMap(rules) {
  const map = {};
  for (const rule of rules) {
    map[rule.id] = { fields: [...rule.dependsOn], rules: [...rule.requiresRules] };
    for (const field of rule.dependsOn) pushUnique(map[field]?.fields ?? [], field);
  }
  return map;
}
