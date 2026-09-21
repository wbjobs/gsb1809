/**
 * Validator —— 校验引擎门面。
 * 职责：schema 生命周期、依赖拓扑调度、Worker 批处理、异步缓存、
 *       防抖增量校验、错误聚合、异常事件、指标采集。
 */
import { normalizeSchema } from './schema.js';
import { WorkerPool } from './worker-host.js';
import { IdbStore } from './idb.js';
import { ResultCache } from './cache.js';
import { ErrorBag, Emitter, FORM_SCOPE } from './error-bag.js';
import { defaultMessages, formatMessage } from './messages.js';
import { deepClone, debounce, getByPath, setByPath, uid } from './utils.js';
import { runTask } from './runner.js';

export class Validator {
  constructor(options = {}) {
    this.options = Object.assign({
      mode: 'change',          // change | submit
      debounce: 80,            // 字段级增量校验默认防抖
      remoteDebounce: 200,
      bail: false,             // 整表是否遇错即停（字段内 bail 由 schema 配置）
      workerSize: undefined,
      useWorkers: true,
      cache: true,
      stopOnFirstException: false,
    }, options);
    this.emitter = new Emitter();
    this.errorBag = new ErrorBag();
    this.metrics = {
      runs: 0, incrementalRuns: 0, tasksExecuted: 0, cacheHits: 0,
      totalMs: 0, maxRunMs: 0, exceptions: 0,
    };
    this.globals = options.globals || {};
    this._customRuleDefs = new Map();   // name -> source（发送给 Worker bootstrap）
    this._localFns = new Map();         // 无法序列化的函数 → 主线程本地执行
    this._runSeq = 0;
  }

  /* ---------------- schema ---------------- */

  setSchema(rawSchema, { persist = true, persistKey = 'schema:active' } = {}) {
    this.schema = normalizeSchema(rawSchema || {});
    this.errorBag.clear();
    this._addEngineErrors();
    if (persist) this.persistSchema(persistKey, rawSchema).catch(() => {});
    if (this.schema.cycles.length) {
      const message = formatMessage(defaultMessages.CYCLE, { cycle: this.schema.cycles.join(' → ') });
      this.emitter.emit('error', { type: 'cycle', fields: this.schema.cycles, message });
    }
    this.emitter.emit('schema:changed', { schema: this.schema });
    return this.schema;
  }

  async loadSchema(key = 'schema:active') {
    await this._ensureStore();
    const raw = await this.store.get('kv', key).catch(() => null);
    if (raw) this.setSchema(raw, { persist: false });
    return raw;
  }

  async persistSchema(key, raw) {
    await this._ensureStore();
    await this.store.put('kv', key, raw).catch(() => {});
  }

  _addConfigErrors() {
    for (const message of this.schema.configErrors) {
      this.errorBag.add(FORM_SCOPE, { rule: 'config', message, code: 'CONFIG_ERROR', level: 'exception' });
      this.emitter.emit('error', { type: 'config', message });
    }
  }

  _addEngineErrors() {
    this._addConfigErrors();
    if (this.schema.cycles.length) {
      const message = formatMessage(defaultMessages.CYCLE, { cycle: this.schema.cycles.join(' → ') });
      this.errorBag.add(FORM_SCOPE, { rule: 'dependency', message, code: 'CYCLE', level: 'exception' });
    }
  }

  registerRule(name, fn) {
    const source = Function.prototype.toString.call(fn);
    this._customRuleDefs.set(name, source);
    // 标记：闭包函数（含 => { [native/闭包] } 无法可靠识别）——Worker 编译失败时会自动本地降级
    return this;
  }

  /* ---------------- 基础设施 ---------------- */

  async _ensureStore() {
    if (!this.store) {
      this.store = new IdbStore(this.options.idb || {});
      await this.store.open();
      this.cache = this.options.cache
        ? new ResultCache(this.store, this.options.cacheOptions || {})
        : null;
    }
    return this.store;
  }

  async _ensurePool() {
    if (!this.pool) {
      const forceLocal = this.options.forceLocal || this.options.useWorkers === false;
      this.pool = new WorkerPool({
        size: this.options.workerSize,
        forceLocal,
        workerUrl: this.options.workerUrl,
      });
      await this.pool.start([...this._customRuleDefs].map(([name, source]) => ({ name, source })));
      this.emitter.emit('worker:ready', { metrics: this.pool.getMetrics() });
    }
    return this.pool;
  }

  /* ---------------- 任务构建 ---------------- */

  _messageFor(rule, field, result) {
    if (result.message) return result.message;
    const label = this.schema.labels.get(field) || field;
    const params = { field: label };
    if (Array.isArray(rule.params)) {
      params.min = rule.params[0];
      params.max = rule.params[1];
      params.options = rule.params;
    } else if (rule.params !== null && typeof rule.params === 'object') {
      Object.assign(params, rule.params);
    } else {
      params.value = rule.params;
      if (rule.name === 'same' || rule.name === 'different') params.other = rule.params;
      if (['min', 'max', 'minLength', 'maxLength'].includes(rule.name)) params.min = params.max = rule.params;
    }
    if (params.other) params.otherLabel = this.schema.labels.get(params.other) || params.other;
    if (params.options !== undefined) params.options = Array.isArray(params.options) ? params.options.join('、') : params.options;
    if (params.type === undefined && rule.name === 'type') params.type = typeof rule.params === 'string' ? rule.params : rule.params.type;
    const tpl = rule.message || defaultMessages[rule.name] || defaultMessages.custom;
    return formatMessage(tpl, params);
  }

  _buildTasks(fieldName, values) {
    const field = this.schema.fields.get(fieldName);
    const tasks = [];
    if (!field) return tasks;
    for (const rule of field.rules) {
      const clone = JSON.parse(JSON.stringify(rule, (key, v) => (typeof v === 'function' ? undefined : v)));
      if (typeof rule.fn === 'function') clone.fn = rule.fn;
      tasks.push({
        id: `${fieldName}::${rule.key}`,
        field: fieldName,
        rule: clone,
        values,
        globals: this.globals,
      });
    }
    return tasks;
  }

  _formTasks(values) {
    return this.schema.formRules.map((rule) => ({
      id: `$form::${rule.key}`,
      field: FORM_SCOPE,
      rule: JSON.parse(JSON.stringify(rule)),
      values: deepClone(values),
      globals: this.globals,
    }));
  }

  on(event, fn) { return this.emitter.on(event, fn); }
  off(event, fn) { return this.emitter.off?.(event, fn); }

  /* ---------------- 全量校验 ---------------- */

  /**
   * 按依赖拓扑顺序校验全部字段。
   * @returns Promise<{ valid, errors: ErrorBag, metrics }>
   */
  async validate(values, options = {}) {
    if (!this.schema) this.setSchema({ fields: {} });
    const runId = ++this._runSeq;
    const started = now();
    this.metrics.runs++;
    this.emitter.emit('validate:start', { runId, values: deepClone(values) });

    await Promise.all([this._ensureStore(), this._ensurePool()]);
    this.errorBag.clear();
    this._addEngineErrors();

    const snapshot = deepClone(values);
    this._lastSnapshot = snapshot;

    // 按拓扑层级并行：同层字段互不依赖，整层一次性提交 Worker 池
    let bailed = false;
    for (const levelFields of this.schema.levels) {
      if (options.signal?.aborted || bailed) break;
      const levelResults = await this._runFieldsLevel(levelFields, snapshot, runId);
      for (const { fieldName, results } of levelResults) {
        this._ingest(results);
        if (this.options.bail && results.some((r) => !r.valid)) {
          this.emitter.emit('validate:bail', { runId });
          bailed = true;
        }
      }
    }

    // 表单级规则
    if (!this.errorBag.has() || !this.options.bail) {
      const formTasks = this._formTasks(snapshot);
      if (formTasks.length) {
        const formResults = await this._dispatch(formTasks, runId, FORM_SCOPE);
        this._ingest(formResults);
      }
    }

    const elapsed = now() - started;
    this.metrics.totalMs += elapsed;
    this.metrics.maxRunMs = Math.max(this.metrics.maxRunMs, elapsed);
    const payload = {
      runId,
      valid: !this.errorBag.has(),
      errors: this.errorBag,
      metrics: this.getMetrics(),
      elapsed,
    };
    this.emitter.emit('validate:end', payload);
    this.emitter.emit(payload.valid ? 'valid' : 'invalid', payload);
    return payload;
  }

  /* ---------------- 增量校验 ---------------- */

  /**
   * 校验单字段 + 依赖该字段的下游字段（依赖正确性的关键）。
   * 同字段短时间内重复触发会被防抖合并，且只有最新一次 run 的结果会落地。
   */
  validateField(fieldName, values, options = {}) {
    if (!this.schema) this.setSchema({ fields: {} });
    const wait = options.debounce ?? this._debounceFor(fieldName);
    if (!this._fieldDebouncers) this._fieldDebouncers = new Map();
    if (!this._fieldDebouncers.has(fieldName)) {
      const d = debounce((v, opts, resolve) => resolve(this._validateFieldImmediate(fieldName, v, opts)), wait);
      this._fieldDebouncers.set(fieldName, d);
    }
    return new Promise((resolve) => this._fieldDebouncers.get(fieldName)(values, options, resolve));
  }

  _debounceFor(fieldName) {
    const field = this.schema?.fields.get(fieldName);
    const hasRemote = field?.rules.some((r) => r.name === 'remote' || r.async);
    return field?.debounce ?? (hasRemote ? this.options.remoteDebounce : this.options.debounce);
  }

  async _validateFieldImmediate(fieldName, values, options = {}) {
    const runId = ++this._runSeq;
    this.metrics.incrementalRuns++;
    this.emitter.emit('field:start', { runId, field: fieldName });
    await Promise.all([this._ensureStore(), this._ensurePool()]);

    const snapshot = deepClone(values);
    // 下游：直接 + 传递依赖（沿 dependents 图扩散）
    const affected = this._collectDependents(fieldName);
    for (const name of affected) this.errorBag.clear(name);
    const started = now();
    const byLevel = new Map();
    for (const name of affected) {
      const lv = this.schema.levelOf.get(name) ?? 0;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push(name);
    }
    for (const names of [...byLevel.keys()].sort((a, b) => a - b).map((k) => byLevel.get(k))) {
      const levelResults = await Promise.all(names.map((name) => this._runField(name, snapshot, runId)));
      if (runId !== this._runSeq && options.latestOnly) {
        return { runId, stale: true, valid: !this.errorBag.has(), errors: this.errorBag };
      }
      for (const results of levelResults) this._ingest(results);
    }
    const elapsed = now() - started;
    const payload = {
      runId,
      field: fieldName,
    affected,
      valid: !this.errorBag.has(),
      errors: this.errorBag,
      elapsed,
    };
    this.emitter.emit('field:end', payload);
    this.emitter.emit('change', payload);
    return payload;
  }

  _collectDependents(fieldName) {
    const out = [];
    const seen = new Set([fieldName]);
    const queue = [fieldName];
    while (queue.length) {
      const cur = queue.shift();
      out.push(cur);
      for (const d of this.schema.dependents.get(cur) || []) {
        if (!seen.has(d)) { seen.add(d); queue.push(d); }
      }
    }
    // 保持拓扑顺序
    return this.schema.order.filter((f) => seen.has(f));
  }

  /* ---------------- 规则分发（缓存 + Worker + 本地降级）---------------- */

  async _runField(fieldName, values, runId) {
    const tasks = this._buildTasks(fieldName, values);
    const field = this.schema.fields.get(fieldName);
    const results = [];
    for (const task of tasks) {
      const result = await this._runOne(task, runId, fieldName);
      results.push(result);
      // 字段内 bail：required 失败后跳过后续规则
      if (field?.bail && !result.valid) {
        this.emitter.emit('field:bail', { runId, field: fieldName, rule: result.key });
        break;
      }
    }
    return results;
  }

  /** 整层多字段批量执行：缓存预检后一次性提交 Worker，显著减少 postMessage 往返。 */
  async _runFieldsLevel(fieldNames, values, runId) {
    const allTasks = [];
    const taskIndex = [];
    for (const fieldName of fieldNames) {
      const field = this.schema.fields.get(fieldName);
      const tasks = this._buildTasks(fieldName, values);
      const kept = [];
      for (const task of tasks) {
        const cacheHit = await this._checkCache(task);
        if (cacheHit) kept.push(cacheHit);
        else { allTasks.push(task); kept.push(null); }
      }
      taskIndex.push({ fieldName, field, slots: kept });
    }

    let dispatched;
    if (allTasks.length) {
      // 同一次 run 内所有任务共享同一份 values 克隆，避免逐任务 structuredClone
      const sharedValues = deepClone(values);
      // 显式 worker: true 的规则进线程池；其余（含内联函数规则）本地异步执行
      const workerTasks = allTasks.filter((t) => t.rule.worker === true);
      const localTasks = allTasks.filter((t) => t.rule.worker !== true);
      const [workerResults, localResults] = await Promise.all([
        workerTasks.length ? this._dispatch(workerTasks, runId) : [],
        Promise.all(localTasks.map((t) => runTask(t))),
      ]);
      dispatched = new Array(allTasks.length);
      let wi = 0, li = 0;
      for (let i = 0; i < allTasks.length; i++) {
        dispatched[i] = allTasks[i].rule.worker === true ? workerResults[wi++] : localResults[li++];
      }
    } else {
      dispatched = [];
    }

    let cursor = 0;
    const out = [];
    for (const { fieldName, field, slots } of taskIndex) {
      const results = [];
      for (let i = 0; i < slots.length; i++) {
        let result = slots[i];
        if (!result) {
          result = dispatched[cursor++];
          if (result.localFallback) result = { ...(await runTask(allTasks[cursor - 1])), localFallback: true };
          await this._afterDispatch(result);
        }
        results.push(result);
      }
      out.push({ fieldName, results });
    }
    return out;
  }

  async _checkCache(task) {
    const { rule, field } = task;
    if (!this.cache || !(rule.cache || rule.name === 'remote')) return null;
    const ttl = rule.cache === true ? 15000 : (rule.cache?.ttl ?? (rule.name === 'remote' ? 5000 : 0));
    if (ttl <= 0) return null;
    const value = getByPath(task.values, field);
    const key = ResultCache.buildKey(rule.key, value, rule.params, this.cache.namespace);
    const hit = await this.cache.get(key).catch(() => null);
    if (!hit) return null;
    this.metrics.cacheHits++;
    this.emitter.emit('cache:hit', { field, rule: rule.key });
    return { field, key: rule.key, ...hit, cached: true };
  }

  async _afterDispatch(result) {
    this.metrics.tasksExecuted++;
    if (result.error) {
      this.metrics.exceptions++;
      this.emitter.emit('rule:error', { field: result.field, rule: result.key, error: result.error });
    }
    const rule = this._findRule(result.field, result.key);
    const ttl = rule?.cache === true ? 15000 : (rule?.cache?.ttl ?? (rule?.name === 'remote' ? 5000 : 0));
    if (this.cache && ttl > 0 && !result.error && (rule.cache || rule.name === 'remote')) {
      const value = getByPath(this._lastSnapshot || {}, result.field);
      const key = ResultCache.buildKey(rule.key, value, rule.params, this.cache.namespace);
      await this.cache.set(key, { valid: result.valid, message: result.message }, ttl).catch(() => {});
    }
  }

  async _runOne(task, runId, affinity) {
    const { rule, field } = task;
    const value = getByPath(task.values, field);
    const cacheable = this.cache && (rule.cache || rule.name === 'remote');
    const ttl = rule.cache === true ? 15000 : (rule.cache?.ttl ?? (rule.name === 'remote' ? 5000 : 0));
    const cacheKey = cacheable ? ResultCache.buildKey(rule.key, value, rule.params, this.cache.namespace) : null;

    if (cacheable && ttl > 0) {
      const hit = await this.cache.get(cacheKey).catch(() => null);
      if (hit) {
        this.metrics.cacheHits++;
        this.emitter.emit('cache:hit', { field, rule: rule.key });
        return { field, key: rule.key, ...hit, cached: true };
      }
    }

    // 内联函数规则默认本地执行（可访问闭包；异步函数不阻塞）。
    // 显式 worker: true 或 Worker 编译失败降级时才切换路径。
    const preferLocal = (rule.name === 'custom' || rule.name === 'remote') && rule.worker !== true;
    let result;
    if (preferLocal) {
      result = await runTask(task);
    } else {
      result = await this._dispatchTask(task, runId, affinity);
      if (result.localFallback) {
        result = { ...(await runTask(task)), localFallback: true };
      }
    }
    this.metrics.tasksExecuted++;

    if (result.error) {
      this.metrics.exceptions++;
      this.emitter.emit('rule:error', { field, rule: rule.key, error: result.error });
    }

    if (cacheable && ttl > 0 && !result.error) {
      await this.cache.set(cacheKey, { valid: result.valid, message: result.message }, ttl).catch(() => {});
    }
    return result;
  }

  async _dispatchTask(task, runId, affinity) {
    const pool = await this._ensurePool();
    try {
      const [result] = await pool.runBatch([task], affinity);
      return result;
    } catch (e) {
      return {
        field: task.field,
        key: task.rule.key,
        valid: false,
        error: { code: 'WORKER_ERROR', name: e.name, message: e.message },
      };
    }
  }

  async _dispatch(tasks, runId, affinity) {
    const pool = await this._ensurePool();
    try {
      return await pool.runBatch(tasks, affinity);
    } catch (e) {
      return tasks.map((t) => ({
        field: t.field, key: t.rule.key, valid: false,
        error: { code: 'WORKER_ERROR', name: e.name, message: e.message },
      }));
    }
  }

  /** 将原始结果落入 ErrorBag（含消息格式化与异常聚合）。 */
  _ingest(results) {
    for (const r of results) {
      if (r.valid || r.skipped) continue;
      const rule = this._findRule(r.field, r.key);
      const message = r.message
        || (r.error ? this._errorMessage(r) : null)
        || (rule ? this._messageFor(rule, r.field, r) : `${r.field} 校验未通过`);
      this.errorBag.add(r.field, {
        rule: r.key,
        message,
        code: r.error?.code || 'RULE_FAILED',
        level: r.error ? 'exception' : 'error',
        detail: r.error?.message,
        cached: !!r.cached,
      });
    }
  }

  _findRule(fieldName, key) {
    if (fieldName === FORM_SCOPE) return this.schema.formRules.find((r) => r.key === key);
    return this.schema.fields.get(fieldName)?.rules.find((r) => r.key === key);
  }

  _errorMessage(result) {
    const label = this.schema.labels.get(result.field) || result.field;
    const tpl = defaultMessages[result.error.code] || defaultMessages.RULE_THREW;
    return formatMessage(tpl, { field: label });
  }

  /* ---------------- 工具 ---------------- */

  clearErrors(field) { this.errorBag.clear(field); this.emitter.emit('errors:clear', { field }); }

  async invalidateCache(predicate) {
    await this.cache?.invalidate(predicate);
  }

  getMetrics() {
    const poolMetrics = this.pool?.getMetrics();
    return {
      ...this.metrics,
      cache: this.cache?.getStats() || null,
      pool: poolMetrics || null,
      storage: this.store ? { kind: this.store.kind, fallback: this.store._fallbackUsed, lastError: this.store.lastError?.message || null } : null,
    };
  }

  async destroy() {
    this._fieldDebouncers?.forEach((d) => d.cancel?.());
    await this.pool?.terminate();
    await this.store?.close();
    this.emitter.emit('destroy', {});
  }

  /** 直接读取字段值辅助（表单绑定用）。 */
  getFieldValue(values, path) { return getByPath(values, path); }
  setFieldValue(values, path, value) { return setByPath(values, path, value); }
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
