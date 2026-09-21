import { defaultRules } from './default-rules.js';
import { ValidationClient } from '../lib/validation-client.js';
import { createRuleRepository, createStorage } from '../lib/storage.js';

const form = document.querySelector('#demoForm');
const editor = document.querySelector('#rulesEditor');
const errorList = document.querySelector('#errorList');
const summary = document.querySelector('#validationSummary');
const latencyLabel = document.querySelector('#latencyLabel');
const engineMode = document.querySelector('#engineMode');
const storageMode = document.querySelector('#storageMode');
const toastElement = document.querySelector('#toast');
const benchmarkOutput = document.querySelector('#benchmarkOutput');
const validateButton = document.querySelector('#validateButton');
const saveRulesButton = document.querySelector('#saveRulesButton');
const benchmarkButton = document.querySelector('#benchmarkButton');

const storage = createStorage();
const repository = createRuleRepository(storage);
const client = new ValidationClient({ storage, timeoutMs: 1200 });
let activeRules = defaultRules;
let latestRequest = 0;
let debounceTimer;
let toastTimer;

editor.value = JSON.stringify(defaultRules, null, 2);

function showToast(message, tone = 'info') {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.className = `toast show ${tone}`;
  toastTimer = setTimeout(() => {
    toastElement.className = 'toast';
  }, 3600);
}

function readFormValues() {
  const data = new FormData(form);
  return Object.fromEntries(data.entries());
}

function fieldElements() {
  return new Map([...form.elements].filter((element) => element.name).map((element) => [element.name, element]));
}

function resetFieldStatuses() {
  for (const element of fieldElements().values()) {
    element.classList.remove('invalid');
    delete element.dataset.status;
  }
}

function markChecking(rules) {
  resetFieldStatuses();
  for (const rule of rules) {
    const element = fieldElements().get(rule.field);
    if (element && rule.type === 'async') element.dataset.status = 'checking';
  }
}

function renderIssues(result) {
  resetFieldStatuses();
  errorList.innerHTML = '';

  for (const issue of result.errors) {
    const element = fieldElements().get(issue.field);
    if (element) element.classList.add('invalid');
  }

  const issues = [...result.errors, ...result.warnings.filter((warning) => !result.errors.some((error) => error.ruleId === warning.ruleId))];
  if (!issues.length) {
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = '所有规则通过。';
    errorList.append(item);
  }

  for (const issue of issues) {
    const item = document.createElement('li');
    item.className = issue.severity;
    const text = document.createElement('strong');
    text.textContent = issue.message;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${issue.field} · ${issue.ruleId}${issue.dependencies?.length ? ` · depends: ${issue.dependencies.join(', ')}` : ''}`;
    item.append(text, meta);
    errorList.append(item);
  }

  const exceptionCount = result.results.filter((item) => item.status === 'exception').length;
  if (exceptionCount > 0) showToast(`有 ${exceptionCount} 个规则或异步服务异常，请查看错误聚合。`, 'error');
  if (result.fallback) showToast(`Worker 不可用，已切换主线程兜底：${result.fallbackReason?.message ?? '未知原因'}`, 'error');
}

async function validate(source = 'input') {
  const requestId = ++latestRequest;
  const rules = activeRules;
  const values = readFormValues();
  markChecking(rules);
  validateButton.disabled = true;
  summary.textContent = source === 'benchmark' ? '性能测试中' : '校验中…';

  try {
    const result = await client.validate(rules, values, { concurrency: 8 });
    if (requestId !== latestRequest) return;
    renderIssues(result);
    summary.textContent = result.valid ? `通过 · ${result.errors.length} 错误 / ${result.warnings.length} 警告` : `${result.errors.length} 个错误 · ${result.warnings.length} 个警告`;
    latencyLabel.textContent = `${result.durationMs} ms`;
    engineMode.textContent = result.fallback ? '主线程兜底' : 'Worker 运行';
    storageMode.textContent = result.storageFallback ? '内存降级' : 'IndexedDB';
  } catch (error) {
    if (requestId !== latestRequest) return;
    summary.textContent = '校验失败';
    showToast(error.message || '校验失败', 'error');
  } finally {
    if (requestId === latestRequest) validateButton.disabled = false;
  }
}

function scheduleValidation() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => validate('input'), 220);
}

function readEditorRules() {
  const parsed = JSON.parse(editor.value);
  if (!Array.isArray(parsed)) throw new Error('规则配置必须是 JSON 数组。');
  return parsed;
}

async function loadSavedRules() {
  try {
    const saved = await repository.get('default');
    if (Array.isArray(saved)) {
      activeRules = saved;
      editor.value = JSON.stringify(saved, null, 2);
      storageMode.textContent = 'IndexedDB 已载入';
      showToast('已从 IndexedDB 载入规则。', 'success');
      validate('load');
    } else {
      storageMode.textContent = 'IndexedDB 待保存';
    }
  } catch (error) {
    storageMode.textContent = '内存降级';
    showToast(`IndexedDB 不可用，使用内存存储：${error.message}`, 'error');
  }
}

function oneOffRule(validator, timeoutMs) {
  return {
    id: `demo-${validator}`,
    field: 'username',
    type: 'async',
    params: { name: validator, timeoutMs, payload: { ms: 1000 }, cache: false },
    message: '演示远程服务失败。'
  };
}

async function validateWithOneOff(validator, timeoutMs) {
  activeRules = [...readEditorRules(), oneOffRule(validator, timeoutMs)];
  await validate('one-off');
  setTimeout(() => {
    activeRules = defaultRules;
    validate('reset');
  }, 4200);
}

async function saveRules() {
  try {
    const rules = readEditorRules();
    await repository.save('default', rules);
    activeRules = rules;
    showToast('规则已保存到 IndexedDB，刷新后会自动载入。', 'success');
    validate('save');
  } catch (error) {
    showToast(`规则保存失败：${error.message}`, 'error');
  }
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame((time) => resolve(time)));
}

async function measureFrameWhile(task) {
  let frames = 0;
  let maximumGap = 0;
  let previous = await nextAnimationFrame();
  const tick = (time) => {
    if (task.settled) return;
    maximumGap = Math.max(maximumGap, time - previous);
    previous = time;
    frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const result = await task.promise;
  task.settled = true;
  return { result, frames, maximumGap: Number(maximumGap.toFixed(1)) };
}

async function runBenchmark() {
  benchmarkButton.disabled = true;
  benchmarkOutput.textContent = 'Worker 正在执行 1000 条复杂规则，同时采样主线程帧率…';
  try {
    const task = { settled: false, promise: client.benchmark(1000) };
    const { result, frames, maximumGap } = await measureFrameWhile(task);
    benchmarkOutput.textContent = JSON.stringify({
      rules: result.count,
      engineDurationMs: result.durationMs,
      workerRoundTripMs: result.roundTripMs,
      errors: result.errorCount,
      exceptions: result.exceptionCount,
      observedMainThreadFrames: frames,
      maximumFrameGapMs: maximumGap,
      verdict: result.durationMs < 500 && maximumGapMsIsAcceptable(maximumGap) ? 'PASS' : 'CHECK'
    }, null, 2);
  } catch (error) {
    benchmarkOutput.textContent = `Benchmark failed: ${error.message}`;
    showToast(`性能测试失败：${error.message}`, 'error');
  } finally {
 benchmarkButton.disabled = false;
  }
}

function maximumFrameGapMsIsAcceptable(gap) {
  return gap < 100;
}

form.addEventListener('input', scheduleValidation);
form.addEventListener('change', scheduleValidation);
validateButton.addEventListener('click', () => validate('manual'));
saveRulesButton.addEventListener('click', saveRules);
benchmarkButton.addEventListener('click', runBenchmark);
document.querySelector('#resetRulesButton').addEventListener('click', () => {
  activeRules = defaultRules;
  editor.value = JSON.stringify(defaultRules, null, 2);
  validate('reset');
  showToast('已恢复默认规则（未删除 IndexedDB 中已保存配置）。');
});
document.querySelector('#exceptionButton').addEventListener('click', () => {
  validateWithOneOff('failingRemote', 5000).catch((error) => showToast(error.message, 'error'));
});
document.querySelector('#timeoutButton').addEventListener('click', () => {
  validateWithOneOff('slowRemote', 100).catch((error) => showToast(error.message, 'error'));
});

loadSavedRules().then(() => validate('initial'));
