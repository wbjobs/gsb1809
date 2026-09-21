/** 默认中文消息模板，支持 {field} {args} 占位。 */
export const defaultMessages = {
  required: '{field}不能为空',
  type: '{field}类型必须是{type}',
  min: '{field}不能小于{min}',
  max: '{field}不能大于{max}',
  minLength: '{field}长度不能少于{min}个字符',
  maxLength: '{field}长度不能超过{max}个字符',
  between: '{field}必须在{min}~{max}之间',
  pattern: '{field}格式不正确',
  email: '{field}必须是有效的邮箱地址',
  url: '{field}必须是有效的URL',
  numeric: '{field}必须是数字',
  integer: '{field}必须是整数',
  boolean: '{field}必须是布尔值',
  alpha: '{field}只能包含字母',
  alnum: '{field}只能包含字母和数字',
  oneOf: '{field}必须是{options}之一',
  notOneOf: '{field}不能是{options}之一',
  requiredIf: '{field}为必填项',
  requiredUnless: '{field}为必填项',
  same: '{field}必须与{otherLabel}一致',
  different: '{field}不能与{otherLabel}相同',
  expression: '{field}不满足条件',
  custom: '{field}校验未通过',
  remote: '{field}服务器校验未通过',
  RULE_THREW: '{field}校验规则执行异常',
  RULE_TIMEOUT: '{field}校验超时',
  RULE_REJECTED: '{field}异步校验失败',
  WORKER_ERROR: '{field}校验线程异常',
  CONFIG_ERROR: '规则配置错误',
  CYCLE: '字段依赖存在循环：{cycle}',
};

export function formatMessage(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    if (v === undefined || v === null) return `{${key}}`;
    return Array.isArray(v) ? v.join('、') : String(v);
  });
}
