# 可配置异步校验引擎（Web Worker + IndexedDB）

一个零依赖、可嵌入的前端表单校验引擎，覆盖**可配置规则、字段依赖、异步校验、错误聚合、性能与异常处理**。

```bash
npm start          # 打开演示页 http://localhost:5173
npm test           # 27 个测试（含真实 worker_threads）
npm run bench      # 1000 字段 / 3000+ 规则性能基准
```

## 能力对照（验收标准）

| 验收点 | 实现 |
| --- | --- |
| 复杂规则正确 | 20+ 内置规则；自研安全表达式引擎（词法/Pratt 解析/AST 解释，无 `eval`）；支持条件必填、跨字段、自定义同步/异步、远程 URL/函数规则 |
| 异步不阻塞 | 规则在 **Web Worker 池**执行（浏览器 Blob Module Worker；Node 为 `worker_threads`；不可用时自动降级为本地异步），层级批量分发；rAF 心跳压测可视化主线程响应 |
| 依赖正确 | 显式 `dependsOn` + 表达式/跨字段规则**自动提取依赖** → Kahn 拓扑排序 + 层级并行；上游变化自动级联重校下游；循环依赖检测并报 `CYCLE` |
| 性能可接受 | 1000 字段 / 3333 规则全量 **< 50ms**（~8 万规则/秒）；L1 LRU + L2 IndexedDB 两级异步结果缓存；增量单字段 **< 10ms**；防抖合并 |
| 异常有提示 | 规则抛错 / reject / 超时 / Worker 崩溃 / 配置错误全部结构化捕获（`RULE_THREW` `RULE_TIMEOUT` `RULE_REJECTED` `WORKER_ERROR` `CONFIG_ERROR`），聚合进 `ErrorBag` 并发事件，不中断其他字段；IndexedDB 故障自动内存降级 |

## 快速使用

```js
import { Validator } from './src/index.js';

const validator = new Validator({ workerSize: 4, cache: true });

validator.setSchema({
  fields: {
    age:   { label: '年龄', rules: ['required', { between: [18, 120] }] },
    reason:{ label: '未成年原因', rules: [{ requiredIf: 'Number(age) < 18' }] }, // 自动依赖 age
    pwd:   { label: '密码', rules: ['required', { minLength: 8 }] },
    pwd2:  { label: '确认密码', rules: [{ same: 'pwd' }] },                     // 自动依赖 pwd
    name:  {
      label: '用户名',
      rules: [{
        remote: async (value) => (await fetch(`/api/check?u=${value}`)).ok,
        cache: { ttl: 5000 },   // IndexedDB + 内存两级缓存
        timeout: 8000,
      }],
    },
  },
  formRules: [{ expression: 'age < 150', message: '年龄不真实' }],
});

// 全量（按拓扑层级并行）
const { valid, errors, elapsed } = await validator.validate(values);

// 增量（自动级联 pwd → pwd2，字段级防抖）
await validator.validateField('pwd', values);

// 错误聚合
errors.firstMessage('pwd2');
errors.exceptions();          // 引擎异常（区别于普通校验失败）
validator.on('rule:error', e => report(e));
```

## 规则写法

| 写法 | 示例 |
| --- | --- |
| 字符串简写 | `'required'`、`'email'` |
| 单键对象 | `{ minLength: 6 }`、`{ oneOf: ['a','b'] }` |
| 显式名/参数 | `{ name: 'min', value: 18, message: '须满 18 岁' }` |
| 表达式 | `{ expression: 'Number(age) >= 18 && role == "vip"' }` |
| 条件必填 | `{ requiredIf: 'age < 18' }` / `{ requiredUnless: 'age >= 18' }` |
| 自定义 | `{ custom: (v, params, ctx) => ..., deps: ['x'] }` |
| 远程函数 | `{ remote: async v => bool|string, cache:{ttl}, debounce }` |
| 远程 URL | `{ remote: '/api/check', method: 'GET' }` |

所有规则支持 `message`、`when`/`condition`（条件表达式）、`skipEmpty`、`timeout`、`cache`。

内置规则：`required/requiredIf/requiredUnless/type/min/max/minLength/maxLength/between/pattern/email/url/numeric/integer/boolean/alpha/alnum/oneOf/notOneOf/same/different/expression`。

表达式内置函数：`len abs min max round floor ceil pow regex inRange between enum isBlank notBlank lower upper and or`；
支持算术、比较、`&&/||/??/!`、三元、字段路径（`a.b[0]`）；字符串/数组方法走白名单，`constructor/__proto__/prototype` 被禁用。

## 架构

```
src/
├── expression.js   安全表达式编译器（Tokenizer + Pratt Parser + AST Evaluator + 依赖提取）
├── rules.js        内置规则库 + 自定义规则注册表
├── schema.js       Schema 规范化、依赖图、拓扑排序、拓扑层级、循环检测
├── worker.js       Worker 入口（浏览器 self.onmessage / Node parentPort 双协议）
├── worker-host.js  Worker 池（Blob Module Worker / worker_threads / 主线程降级，分片负载）
├── runner.js       规则执行器（Worker 内运行，异常永不逃逸；超时/远程/自定义）
├── idb.js          IndexedDB 封装（kv + cache 两库，TTL，内存降级，故障注入）
├── cache.js        L1 LRU + L2 IndexedDB 两级缓存（负缓存开关）
├── error-bag.js    错误聚合 ErrorBag + 事件总线
├── messages.js     中文消息模板
├── validator.js    引擎门面：全量/增量调度、缓存预检、指标、生命周期
└── utils.js        拓扑/路径/防抖/超时等工具
```

### 调度模型

1. 依赖图计算每个字段的拓扑层级，同层互不依赖 → **整层并行**提交 Worker 池；
2. 提交前做缓存预检，命中的规则不产生跨线程往返；
3. 大批次按 48 片切分到多 Worker（同字段走亲和路由，利于缓存局部性）；
4. 增量校验沿 `dependents` 反向图扩散受影响字段，同样按层级并行；
5. 每次 run 有单调 `runId`，过期结果可识别为 `stale`（配合防抖只落地最新值）。

### 异常矩阵

| 异常 | code | 行为 |
| --- | --- | --- |
| 规则同步抛错 | `RULE_THREW` | 捕获 → 字段异常提示 + `rule:error` 事件，其余规则继续 |
| Promise reject | `RULE_REJECTED` | 同上 |
| 超时 | `RULE_TIMEOUT` | `Promise.race` 超时即失败，默认消息「校验超时」 |
| Worker 崩溃 | `WORKER_ERROR` | 挂起任务自动回退主线程执行 |
| 规则未注册/依赖缺失/多候选名 | `CONFIG_ERROR` | Schema 装载期收集进 `$form` 错误 |
| 循环依赖 | `CYCLE` | 报告环上字段；环内字段仍按快照完成校验 |
| IndexedDB 不可用/IO 错误 | — | 透明降级到内存存储，`metrics.storage.fallback = true` |

## 测试

```
tests/expression.test.js  表达式：运算/路径/依赖提取/原型逃逸防护  (6)
tests/schema.test.js      规范化、依赖图、拓扑、循环、配置错误      (6)
tests/storage.test.js     IndexedDB 内存降级、TTL、故障注入、缓存   (3)
tests/worker.test.js      真实 worker_threads、并行分片、bootstrap  (4)
tests/engine.test.js      复杂规则/异步非阻塞/级联/缓存/异常/循环    (8)
tests/bench.test.js       1000 字段性能基准（断言性能门槛）          (1)
```
