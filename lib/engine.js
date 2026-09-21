import { CONFIG_FIELD, aggregateResults, cloneJson, hashString, makeError, stableStringify } from './engine-utils.js';
import { evaluateExpression } from './expressions.js';
import { normalizeRules, orderRulesByDependencies } from './rules.js';
import { hasBuiltinValidator, validateWithBuiltin } from './validators.js';

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function addEdge(graph, from, to) {
  if (!graph.has(from)) graph.set(from, new Set());
  graph.get(from).add(to);
}

function buildExecutionLayers(rules) {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const incoming = new Map(rules.map((rule) => [rule.id, new Set()]));
  const outgoing = new Map();

  for (const rule of rules) {
    for (const prerequisiteId of rule.requiresRules) {
      if (!byId.has(prerequisiteId)) continue;
      addEdge(outgoing, prerequisiteId, rule.id);
      incoming.get(rule.id).add(prerequisiteId);
    }

    for (const dependencyField of rule.dependsOn) {
      for (const candidate of rules) {
        if (candidate.id === rule.id || candidate.field !== dependencyField) continue;
        addEdge(outgoing, candidate.id, rule.id);
        incoming.get(rule.id).add(candidate.id);
      }
    }
  }

  const remaining = new Map(rules.map((rule) => [rule.id, rule]));
  const layers = [];
  while (remaining.size) {
    const ready = rules
      .filter((rule) => remaining.has(rule.id) && incoming.get(rule.id).size === 0)
      .sort((a, b) => a.order - b.order);

    if (!ready.length) break;
    layers.push(ready);
    for (const rule of ready) {
      remaining.delete(rule.id);
      for (const next of outgoing.get(rule.id) ?? []) incoming.get(next).delete(rule.id);
    }
  }

  return {
    layers,
    cycles: [...remaining.values()].map((rule) => ({ ruleId: rule.id, field: rule.field }))
  };
}

function baseResult(rule, status, extra = {}) {
  return { ruleId: rule.id, field: rule.field, status, dependencies: [...rule.dependsOn], ...extra };
}

function failureStatus(rule, forceSeverity) {
  return forceSeverity === 'warning' || (!forceSeverity && rule.severity === 'warning') ? 'warning' : 'invalid';
}

function failureResult(rule, message, code = 'VALIDATION_FAILED', extra = {}) {
  return baseResult(rule, failureStatus(rule), { code, message, ...extra });
}

function resolvePayload(value, values) {
  if (Array.isArray(value)) return value.map((item) => resolvePayload(item, values));
  if (value && typeof value === 'object') {
    if (value.ref) return evaluateExpression(value, values);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePayload(item, values)]));
  }
  return value;
}

function buildAsyncPayload(rule, values) {
  const payload = resolvePayload(cloneJson(rule.params.payload ?? {}), values);
  return {
    validator: rule.params.name ?? rule.type,
    field: rule.field,
    value: values?.[rule.field],
    payload,
    dependencies: Object.fromEntries(rule.dependsOn.map((field) => [field, values?.[field]]))
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runAsyncRule(rule, values, services, cache, signal) {
  const startedAt = now();
  const validatorName = rule.params.name;
  const validator = services?.asyncValidators?.[validatorName];
  if (typeof validator !== 'function') {
    return baseResult(rule, 'exception', { code: 'ASYNC_VALIDATOR_MISSING', message: `Async validator is not registered: ${validatorName}`, durationMs: 0 });
  }

  const request = buildAsyncPayload(rule, values);
  const cacheKey = `async:${hashString(stableStringify(request))}`;
  const timeoutMs = Number(rule.params.timeoutMs ?? services.timeoutMs ?? 8000);
  if (cache && rule.params.cache !== false) {
    try {
      let cacheTimer;
      const cached = await Promise.race([
        cache.get(cacheKey),
        new Promise((resolve) => {
          cacheTimer = setTimeout(resolve, Math.min(timeoutMs, 500));
        })
      ]);
      clearTimeout(cacheTimer);
      if (cached?.valid === true) {
        return { ...baseResult(rule, 'valid'), cached: true, durationMs: Number((now() - startedAt).toFixed(2)) };
      }
      if (cached?.valid === false) {
        return { ...failureResult(rule, cached.message || rule.message, cached.code || 'ASYNC_VALIDATION_FAILED'), cached: true, durationMs: Number((now() - startedAt).toFixed(2)) };
      }
    } catch {
      return baseResult(rule, 'exception', { code: 'CACHE_EXCEPTION', message: 'Unable to read cached validation result.', durationMs: Number((now() - startedAt).toFixed(2)) });
    }
  }

  let timeoutId;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(new Error(`Validation timed out after ${timeoutMs}ms.`)), timeoutMs);
  }

  try {
    const returned = await validator(request, { signal: controller.signal, services });
    clearTimeout(timeoutId);
    const normalized = returned === true || returned === undefined || returned === null
      ? { valid: true }
      : typeof returned === 'string'
        ? { valid: false, message: returned }
        : returned;

    if (cache && rule.params.cache !== false) {
      await cache.set(cacheKey, { valid: Boolean(normalized.valid), message: normalized.message, code: normalized.code }, rule.params.ttlMs ?? services.ttlMs ?? 30000);
    }
    return normalized.valid
      ? { ...baseResult(rule, 'valid'), durationMs: Number((now() - startedAt).toFixed(2)) }
      : failureResult(rule, normalized.message || rule.message, normalized.code || 'ASYNC_VALIDATION_FAILED');
  } catch (error) {
    clearTimeout(timeoutId);
    return baseResult(rule, 'exception', {
      code: controller.signal.aborted ? 'ASYNC_TIMEOUT' : 'ASYNC_EXCEPTION',
      message: controller.signal.aborted ? `Validation timed out after ${timeoutMs}ms.` : error?.message || 'Async validator failed.',
      durationMs: Number((now() - startedAt).toFixed(2))
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function runSynchronousRule(rule, values, services) {
  const startedAt = now();
  try {
    const passed = validateWithBuiltin(rule, values, services);
    return passed === true
      ? baseResult(rule, 'valid', { durationMs: Number((now() - startedAt).toFixed(2)) })
      : failureResult(rule, typeof passed === 'string' ? passed : rule.message);
  } catch (error) {
    return baseResult(rule, 'exception', { code: 'RULE_EXCEPTION', message: error.message, durationMs: Number((now() - startedAt).toFixed(2)) });
  }
}

export async function runValidationEngine(rawRules, values = {}, options = {}) {
  const startedAt = now();
  const { rules, errors: configErrors } = normalizeRules(cloneJson(rawRules));
  const { ordered, cycles: cycleEdges } = orderRulesByDependencies(rules);
  const { layers, cycles } = buildExecutionLayers(ordered);
  const results = [];
  const completed = new Map();
  const services = options.services ?? {};
  const concurrency = options.concurrency ?? 8;
  let configIssueIndex = 0;

  const cycleRules = new Map([
    ...cycleEdges.map((edge) => [edge.ruleId, rules.find((rule) => rule.id === edge.ruleId)]),
    ...cycles.map((cycle) => [cycle.ruleId, rules.find((rule) => rule.id === cycle.ruleId)])
  ]);
  for (const [ruleId, rule] of cycleRules) {
    if (!rule || results.some((result) => result.ruleId === ruleId)) continue;
    results.push(baseResult(rule, 'skipped', { code: 'CYCLE_DEPENDENCY', message: 'Skipped because the rule belongs to a dependency cycle.' }));
    completed.set(ruleId, results[results.length - 1]);
  }

  for (const layer of layers) {
    const prepared = layer.map((rule) => {
      const failedPrerequisites = rule.requiresRules
        .filter((id) => completed.has(id))
        .filter((id) => {
          const prerequisite = completed.get(id);
          return prerequisite.status === 'invalid'
            || prerequisite.status === 'exception'
            || ['DEPENDENCY_FAILED', 'CYCLE_DEPENDENCY'].includes(prerequisite.code);
        });
      if (failedPrerequisites.length) {
        return () => Promise.resolve(baseResult(rule, 'skipped', {
          code: 'DEPENDENCY_FAILED',
          message: 'Skipped because a prerequisite rule failed.',
          blockedBy: failedPrerequisites
        }));
      }

      let condition;
      try {
        condition = rule.when === undefined ? true : Boolean(evaluateExpression(rule.when, values));
      } catch (error) {
        return () => Promise.resolve(baseResult(rule, 'exception', { code: 'CONDITION_EXCEPTION', message: error.message }));
      }
      if (!condition) {
        return () => Promise.resolve(baseResult(rule, 'skipped', { code: 'CONDITION_NOT_MATCHED', message: 'Rule condition did not match.' }));
      }

      if (rule.type === 'async') return () => runAsyncRule(rule, values, services, options.cache, options.signal);
      if (hasBuiltinValidator(rule.type)) return () => Promise.resolve(runSynchronousRule(rule, values, services));
      return () => Promise.resolve(baseResult(rule, 'exception', { code: 'UNKNOWN_RULE_TYPE', message: `Unknown rule type: ${rule.type}` }));
    });

    const layerResults = await mapWithConcurrency(prepared, concurrency, (task) => task());
    for (const [index, rule] of layer.entries()) {
      results.push(layerResults[index]);
      completed.set(rule.id, layerResults[index]);
    }
  }

  const summary = aggregateResults([
    ...results,
    ...configErrors.map((error) => ({ ruleId: `$config.${error.code}.${configIssueIndex++}`, field: error.field, status: 'exception', code: error.code, message: error.message, dependencies: [] }))
  ]);

  return {
    ...summary,
    configErrors,
    results: results.sort((a, b) => rules.findIndex((rule) => rule.id === a.ruleId) - rules.findIndex((rule) => rule.id === b.ruleId)),
    durationMs: Number((now() - startedAt).toFixed(2)),
    ruleCount: rules.length,
    executedAt: new Date().toISOString()
  };
}

export function validateRulesSync(rawRules, values = {}, options = {}) {
  if (rawRules.some((rule) => rule?.type === 'async')) {
    throw new Error('Async rules require runValidationEngine.');
  }
  return Promise.resolve(runValidationEngine(rawRules, values, options));
}

export { normalizeRules, orderRulesByDependencies };
