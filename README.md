# 可配置异步规则校验引擎

零运行时依赖的浏览器示例，使用声明式规则、Web Worker 和 IndexedDB 实现复杂表单校验。

## 运行

```bash
npm start
# http://localhost:5173
```

自动测试：

```bash
npm test
```

需要 Node.js 20+。浏览器端无构建步骤，必须通过 HTTP 服务访问，以便启用 Module Worker。

## 能力

- **可配置规则**：规则以 JSON 保存到 IndexedDB，页面右侧可直接编辑和恢复默认值。
- **规则引擎**：内置必填、类型、范围、长度、枚举、正则、跨字段相等和安全表达式；不使用 `eval`。
- **异步校验**：远程校验在 Web Worker 中运行，支持并发池、超时、`AbortSignal` 和按请求载荷缓存。
- **依赖处理**：支持 `dependsOn` 字段依赖和 `requiresRules` 规则前置；同一执行层并发，后续层等待前置结果。
- **错误聚合**：输出 `valid`、`errors`、`warnings`、字段索引、规则状态、阻断原因和耗时。
- **异常处理**：未知规则、表达式异常、Worker 故障、IndexedDB 故障、远程异常和超时都有明确提示。
- **性能验收**：页面内置 1000 条规则基准，统计 Worker 引擎耗时、往返耗时和主线程最大帧间隔。

## 规则结构

```json
{
  "id": "postal-country-pattern",
  "field": "postalCode",
  "type": "async",
  "severity": "error",
  "when": { "not": [{ "is-blank": [{ "ref": "$values.country" }] }] },
  "dependsOn": ["country"],
  "requiresRules": ["postal-required", "country-required"],
  "params": {
    "name": "postalCodeAvailability",
    "payload": { "country": { "ref": "$values.country" } },
    "timeoutMs": 8000,
    "ttlMs": 30000
  },
  "message": "Postal code does not match the selected country."
}
```

### 内置类型

- `required`
- `type`: `number`、`integer`、`email`、`url`、`boolean`
- `min`、`max`、`between`
- `minLength`、`maxLength`
- `oneOf`
- `pattern`
- `equalsField`
- `expression`
- `custom`
- `async`

### 表达式

表达式使用单操作数对象，字段通过 `{ "ref": "$values.fieldName" }` 引用。支持 `and`、`or`、`not`、比较、`in`、字符串包含、正则、长度、四则运算、取模、舍入、求和、最小值、最大值和空值判断。

复杂规则示例：

```json
{
  "and": [
    { ">=": [{ "length": [{ "ref": "$values.password" }] }, 8] },
    { "regex": [{ "ref": "$values.password" }, "[A-Z]"] },
    { "regex": [{ "ref": "$values.password" }, "[0-9]"] }
  ]
}
```

## 依赖语义

- `dependsOn` 声明字段引用，引擎自动等待其他规则中同名字段的校验结果。
- `requiresRules` 显式声明规则前置。
- 前置规则为 `invalid`、`exception` 或 `skipped` 时，依赖规则标记为 `DEPENDENCY_FAILED`。
- `warning` 不阻断后续规则。
- `when` 为 `false` 时规则标记为 `CONDITION_NOT_MATCHED`，不视为错误。
- 检测到规则环时，环上规则标记为 `CYCLE_DEPENDENCY`，不会死锁。

## 异步协议

Worker 收到异步规则后调用注册在 `lib/demo-validators.js` 中的函数：

```js
async function validator(request, context) {
  // context.signal 支持超时和外部取消
  return { valid: false, code: 'BUSINESS_CODE', message: 'Human readable message' };
}
```

缓存键由校验器名称、字段值、载荷和依赖字段稳定哈希得到。成功和业务失败可缓存；异常和超时不缓存，避免临时服务故障被误缓存。

## 异常与降级

- Worker 构造、消息或未捕获异常：自动切换到主线程执行，并在页面提示原因。
- IndexedDB 不可用：规则仓库和缓存降级到内存。
- 远程抛错：规则状态为 `exception`，错误码为 `ASYNC_EXCEPTION`。
- 超时：默认 8 秒，演示页面为 1.2 秒，错误码为 `ASYNC_TIMEOUT`。
- 非法规则：进入 `configErrors`，不阻断其他合法规则执行。

## 关键文件

- `lib/engine.js`：规则归一化后的分层调度、异步执行和结果聚合。
- `lib/rules.js`：规则归一化、引用依赖、显式依赖和拓扑循环检测。
- `lib/expressions.js`：白名单安全表达式。
- `lib/validators.js`：内置同步校验器。
- `worker/validation.worker.js`：Web Worker 协议与性能任务。
- `lib/storage.js`：IndexedDB 仓库、TTL 缓存和内存降级。
- `src/app.js`：实时表单、规则编辑、异常演示和性能基准 UI。
