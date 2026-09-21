import { Validator } from '../src/index.js';

/* ---------------- 模拟远程服务（带随机延迟/偶发故障） ---------------- */

const REMOTE_LATENCY = [120, 480];
const lat = () => REMOTE_LATENCY[0] + Math.random() * (REMOTE_LATENCY[1] - REMOTE_LATENCY[0]);

// 用户名占用库
const TAKEN_USERNAMES = new Set(['admin', 'root', 'test', 'hello', 'alice']);
async function checkUsername(value) {
  await new Promise((r) => setTimeout(r, lat()));
  if (!value) return true;
  if (value === 'force-error') {
    // 演示：远程服务异常（reject），引擎会聚合为异常提示而不是崩溃
    throw new Error('503 查重服务暂不可用');
  }
  return !TAKEN_USERNAMES.has(value);
}

// 邮箱 MX 模拟：example.com 域名一律判无效
async function checkEmailMx(value) {
  await new Promise((r) => setTimeout(r, lat()));
  if (!value) return true;
  const domain = String(value).split('@')[1] || '';
  if (domain === 'example.com') return '该域名没有可用的邮件服务器（MX）';
  return true;
}

/* ---------------- 密码强度自定义规则 ---------------- */

function passwordStrength(value) {
  if (!value) return true;
  let score = 0;
  if (value.length >= 8) score++;
  if (/[A-Za-z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  updateStrengthBar(score);
  if (value.length < 8 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    return '密码至少 8 位，且必须同时包含字母和数字';
  }
  return true;
}

function updateStrengthBar(score) {
  const bar = document.getElementById('strengthBar');
  const width = [0, 22, 45, 72, 100][score] || 0;
  const colors = ['#ef5b6e', '#f0a93b', '#f0d03b', '#2fbf71', '#2fb0ff'];
  bar.style.width = `${width}%`;
  bar.style.background = colors[score - 1] || '#ef5b6e';
}

/* ---------------- Schema（纯数据可持久化到 IndexedDB） ---------------- */

const schema = {
  fields: {
    username: {
      label: '用户名',
      rules: [
        'required',
        { between: [3, 20] },
        { pattern: '^[A-Za-z0-9_]+$', message: '只能包含字母、数字和下划线' },
        { remote: checkUsername, cache: { ttl: 8000 }, debounce: 400, message: '该用户名已被占用' },
      ],
    },
    email: {
      label: '邮箱',
      rules: [
        'required',
        'email',
        { remote: checkEmailMx, cache: { ttl: 8000 }, debounce: 300 },
      ],
    },
    age: { label: '年龄', rules: ['required', 'integer', { between: [0, 120] }, { min: 18 }] },
    minorReason: {
      label: '未成年原因',
      rules: [{ requiredIf: 'age !== "" && Number(age) < 18', message: '未成年用户必须填写原因' }],
    },
    pwd: { label: '密码', rules: ['required', { custom: passwordStrength }] },
    pwd2: { label: '确认密码', rules: ['required', { same: 'pwd' }] },
    inviteCode: {
      label: '邀请码',
      rules: [{ requiredIf: 'role == "vip"', message: 'VIP 用户必须填写邀请码' }],
    },
    role: { label: '角色', rules: [{ oneOf: ['user', 'vip', 'admin'] }] },
  },
  formRules: [
    { expression: 'agree === true', message: '提交前必须勾选同意条款' },
    { expression: 'role != "admin" || len(pwd) >= 10', message: '管理员密码长度必须不少于 10 位' },
  ],
};

/* ---------------- 引擎初始化 ---------------- */

const validator = new Validator({
  workerSize: Math.min(4, (navigator.hardwareConcurrency || 4) - 1),
  debounce: 60,
  remoteDebounce: 400,
  bail: false,
  cache: true,
});
validator.setSchema(schema, { persist: false });

const form = document.getElementById('regForm');
const fields = [...form.querySelectorAll('[name]')];

function readValues() {
  const values = {};
  for (const el of fields) {
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}

/* ---------------- 事件日志 ---------------- */

const eventLog = document.getElementById('eventLog');
const WATCHED = ['validate:start', 'validate:end', 'field:start', 'field:end',
  'cache:hit', 'rule:error', 'valid', 'invalid', 'error', 'worker:ready'];
for (const name of WATCHED) {
  validator.on(name, (payload) => logEvent(name, payload));
}
function logEvent(name, payload) {
  const div = document.createElement('div');
  div.className = `e ${name.includes('error') ? 'err' : /valid$|cache/.test(name) ? 'ok' : name.includes('start') ? 'warn' : ''}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' + String(Date.now() % 1000).padStart(3, '0');
  let detail = '';
  if (name === 'field:end') detail = `${payload.field} → ${payload.affected.join(',')} ${payload.valid ? '✓' : '✗'} ${payload.elapsed.toFixed(1)}ms`;
  else if (name === 'rule:error') detail = `${payload.field}.${payload.rule} [${payload.error.code}] ${payload.error.message}`;
  else if (name === 'cache:hit') detail = `${payload.field}.${payload.rule}`;
  else if (name === 'validate:end') detail = `${payload.valid ? 'valid' : 'INVALID'} ${payload.elapsed.toFixed(1)}ms`;
  else if (name === 'error') detail = payload.message || payload.type;
  div.innerHTML = `${time} <b>${name}</b> ${detail}`;
  eventLog.prepend(div);
  while (eventLog.children.length > 60) eventLog.lastChild.remove();
}

/* ---------------- 错误渲染（错误聚合） ---------------- */

function renderErrors(errorBag) {
  for (const fieldName of Object.keys(schema.fields)) {
    const wrap = form.querySelector(`.field[data-field="${fieldName}"]`);
    if (!wrap) continue;
    const msg = errorBag.firstMessage(fieldName);
    const msgEl = wrap.querySelector('.msg');
    wrap.classList.toggle('invalid', !!msg);
    wrap.classList.toggle('valid', !msg && wrap.dataset.touched === '1');
    msgEl.textContent = msg || '';
  }
  // 表单级（含 agree / 表达式 / 配置 / 循环依赖）
  const formBox = document.getElementById('formErrors');
  const formErrs = errorBag.get('$form');
  const agreeWrap = form.querySelector('.field[data-field="agree"]');
  const agreeMsg = formErrs.find((e) => e.rule === 'expression') || null;
  agreeWrap.classList.toggle('invalid', !!agreeMsg);
  agreeWrap.querySelector('.msg').textContent = agreeMsg?.message || '';

  const exceptions = errorBag.exceptions();
  formBox.innerHTML = exceptions.length
    ? `<div class="summary">⚠ 引擎异常 ${exceptions.length} 项（已隔离，不影响其他字段）：${exceptions.map((e) => e.message).join('；')}</div>`
    : '';
}

/* ---------------- 实时校验（防抖 + 依赖联动） ---------------- */

let pendingTimer = null;
for (const el of fields) {
  const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(evt, () => {
    const wrap = el.closest('.field');
    if (wrap) { wrap.dataset.touched = '1'; wrap.classList.add('pending'); }
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(async () => {
      const result = await validator.validateField(el.name, readValues(), { debounce: 0 });
      if (!result.stale) renderErrors(result.errors);
      form.querySelectorAll('.field.pending').forEach((n) => n.classList.remove('pending'));
      refreshMetrics();
    }, el.name === 'username' || el.name === 'email' ? 350 : 0);
  });
  el.addEventListener('blur', async () => {
    const wrap = el.closest('.field');
    if (wrap) wrap.dataset.touched = '1';
    const result = await validator.validateField(el.name, readValues(), { debounce: 0 });
    if (!result.stale) renderErrors(result.errors);
    refreshMetrics();
  });
}

/* ---------------- 提交（全量校验） ---------------- */

const statusEl = document.getElementById('formStatus');
document.getElementById('submitBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  statusEl.textContent = '校验中…';
  const t0 = performance.now();
  const result = await validator.validate(readValues());
  renderErrors(result.errors);
  btn.disabled = false;
  if (result.valid) {
    statusEl.textContent = `✓ 校验通过（${(performance.now() - t0).toFixed(1)} ms）`;
    toast('提交成功：所有规则通过', 'ok');
  } else {
    const n = result.errors.all().filter((x) => x.level !== 'exception').length;
    statusEl.textContent = `✗ ${n} 个字段存在错误`;
    toast(`提交被拦截：${n} 个错误已聚合展示`, 'err');
  }
  refreshMetrics();
});

document.getElementById('resetBtn').addEventListener('click', () => {
  form.reset();
  validator.clearErrors();
  renderErrors(validator.errorBag);
  updateStrengthBar(0);
  statusEl.textContent = '';
  form.querySelectorAll('.field').forEach((n) => { n.classList.remove('invalid', 'valid', 'pending'); delete n.dataset.touched; });
});

/* ---------------- Toast ---------------- */

let toastTimer;
function toast(message, type = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast', 2600);
}

/* ---------------- 指标 ---------------- */

function refreshMetrics() {
  const m = validator.getMetrics();
  document.getElementById('metricsOut').textContent = JSON.stringify({
    全量校验次数: m.runs,
    增量校验次数: m.incrementalRuns,
    实际执行规则: m.tasksExecuted,
    缓存命中: m.cacheHits,
    异常数: m.exceptions,
    缓存层: m.cache,
    Worker: m.pool && {
      提交: m.pool.submitted, 完成: m.pool.completed, 本地降级: m.pool.localFallback,
      线程: m.pool.workers.map((w) => `${w.kind}#${w.index}:${w.tasks}`),
    },
    存储: m.storage,
  }, null, 2);
}

/* ---------------- 压测 ---------------- */

document.getElementById('benchBtn').addEventListener('click', async () => {
  const count = Math.max(50, Math.min(5000, Number(document.getElementById('fieldCount').value) || 500));
  const out = document.getElementById('benchOut');
  const btn = document.getElementById('benchBtn');
  btn.disabled = true;
  out.textContent = `构建 ${count} 字段 Schema…`;

  const fieldsDef = {};
  for (let i = 0; i < count; i++) {
    const rules = ['required', { minLength: 2 }, { maxLength: 32 }, { expression: `true` }];
    if (i % 4 === 0) {
      rules.push({
        remote: async (v) => { await new Promise((r) => setTimeout(r, 1 + Math.random() * 3)); return v !== 'bad'; },
        cache: { ttl: 10000 },
      });
    }
    fieldsDef[`f${i}`] = { label: `字段${i}`, rules, debounce: 0 };
  }
  const benchValidator = new Validator({
    workerSize: navigator.hardwareConcurrency ? Math.min(6, navigator.hardwareConcurrency - 1) : 4,
    idb: { forceMemory: true },
  });
  benchValidator.setSchema({ fields: fieldsDef }, { persist: false });

  const validValues = {};
  const badValues = {};
  for (let i = 0; i < count; i++) {
    validValues[`f${i}`] = `value-${i}`;
    badValues[`f${i}`] = i % 9 === 0 ? '' : 'x';
  }

  // 心跳：rAF 持续触发，若主线程被阻塞计数会停滞
  let hearts = 0;
  let raf;
  const heartStart = performance.now();
  const beat = () => {
    hearts++;
    const pct = Math.min(100, (performance.now() - heartStart) / 12);
    document.getElementById('heartBar').style.width = `${pct}%`;
    document.getElementById('heartCount').textContent = hearts;
    raf = requestAnimationFrame(beat);
  };
  raf = requestAnimationFrame(beat);

  await benchValidator.validate(validValues); // 预热
  const t1 = performance.now();
  const bad = await benchValidator.validate(badValues);
  const cold = performance.now() - t1;
  const t2 = performance.now();
  await benchValidator.validate(badValues);
  const hot = performance.now() - t2;
  cancelAnimationFrame(raf);

  const rules = count * 5;
  const m = benchValidator.getMetrics();
  out.textContent =
`字段数        ${count}
规则总数      ${rules}
冷全量校验    ${cold.toFixed(1)} ms
吞吐          ${Math.round(rules / cold * 1000).toLocaleString()} 规则/秒
热全量(缓存)  ${hot.toFixed(1)} ms（${(cold / hot).toFixed(1)}x）
失败字段      ${bad.errors.fields().length}
缓存命中      ${m.cacheHits}
Worker 分布   ${m.pool.workers.map((w) => `${w.kind}#${w.index}=${w.tasks}`).join('  ')}
rAF 心跳      ${hearts} 次（主线程全程可响应）`;

  document.getElementById('perfBadge').textContent = `规则/秒：${Math.round(rules / cold * 1000).toLocaleString()}`;
  btn.disabled = false;
  await benchValidator.destroy();
});

/* ---------------- 环境状态徽章 ---------------- */

(async () => {
  const store = validator.store || await (await validator._ensureStore());
  const idbBadge = document.getElementById('storageBadge');
  idbBadge.textContent = `存储：${store.kind === 'idb' ? 'IndexedDB ✓' : 'IndexedDB 不可用 → 内存降级'}`;
  idbBadge.className = `badge ${store.kind === 'idb' ? 'badge-ok' : 'badge-err'}`;

  await validator._ensurePool();
  const kinds = new Set(validator.pool.workers.map((w) => w.kind));
  const wBadge = document.getElementById('workerBadge');
  wBadge.textContent = `Worker：${[...kinds].join('/')} × ${validator.pool.size}`;
  wBadge.className = `badge ${kinds.has('web') ? 'badge-ok' : 'badge-muted'}`;
  refreshMetrics();
})();
