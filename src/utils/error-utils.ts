export enum ErrorType {
  SDK_TIMEOUT = 'sdk_timeout',
  API_ERROR = 'api_error',
  AUTH_ERROR = 'auth_error',
  FILE_CORRUPT = 'file_corrupt',
  STREAM_ERROR = 'stream_error',
  CONTEXT_TOO_LONG = 'context_too_long',
  UNKNOWN = 'unknown'
}

/**
 * 错误来源前缀 — 区分基础设施异常 vs Agent 任务失败
 *
 * infra:  基础设施级（SDK 崩溃、API 不可用、文件损坏）— 应累计安全模式
 * agent:  Agent 任务级（权限拒绝、max turns、工具失败）— 仅统计，不累计安全模式
 */
export const ERROR_PREFIX = {
  INFRA: 'infra',
  AGENT: 'agent',
} as const;

/**
 * 判断 Agent complete.subtype 是否属于系统级故障（应累计安全模式）
 *
 * 非系统级（用户操作或任务边界）：
 * - end_turn / max_turns: Agent 正常结束或达到轮次上限
 * - permission_denied: 用户主动拒绝权限
 * - stop: 用户主动停止
 *
 * 系统级（SDK/模型/平台故障）：
 * - error_model / error_tool_use / error_api 等：基础设施异常
 * - 未知 subtype：保守地视为系统级
 *
 * terminalReason 提供更精确的判断（SDK 0.2.100+）：
 * - rapid_refill_breaker: API 限流，不是代码问题
 * - tool_deferred: 工具延迟，不是错误
 * - stop_hook_prevented: Stop hook 阻止，不是错误
 * - aborted_streaming / aborted_tools: 中断，已有中断处理逻辑
 */
const NON_INFRA_SUBTYPES = new Set([
  'end_turn',
  'max_turns',
  'permission_denied',
  'stop',
]);

const NON_INFRA_TERMINAL_REASONS = new Set([
  'rapid_refill_breaker',
  'tool_deferred',
  'stop_hook_prevented',
  'aborted_streaming',
  'aborted_tools',
]);

export function isInfraError(subtype?: string, terminalReason?: string): boolean {
  // terminalReason 优先级更高（更精确）
  if (terminalReason && NON_INFRA_TERMINAL_REASONS.has(terminalReason)) {
    return false;
  }

  if (!subtype) return true;  // 未知 subtype，保守视为系统级
  return !NON_INFRA_SUBTYPES.has(subtype);
}

/** 为 errorType 添加来源前缀 */
export function prefixErrorType(prefix: string, errorType: string): string {
  return `${prefix}:${errorType}`;
}

export function classifyError(error: any): ErrorType {
  const msg = (error?.message || '').toLowerCase();

  if (msg.includes('上下文过长') || msg.includes('context too long')
    || msg.includes('context_length_exceeded') || msg.includes('context_compact_failed')
    || msg.includes('prompt is too long') || msg.includes('context limit')) {
    return ErrorType.CONTEXT_TOO_LONG;
  }

  // 认证错误（401 / Invalid API Key / key_not_found）— 不可恢复，不应触发安全模式
  if (msg.includes('401') || msg.includes('invalid api key') || msg.includes('key_not_found')
    || msg.includes('authentication_error') || msg.includes('failed to authenticate')) {
    return ErrorType.AUTH_ERROR;
  }

  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return ErrorType.SDK_TIMEOUT;
  }

  if (msg.includes('5') && (msg.includes('00') || msg.includes('02') || msg.includes('03') || msg.includes('04'))) {
    return ErrorType.API_ERROR;
  }

  if (msg.includes('enoent') || msg.includes('corrupt') || msg.includes('invalid json')) {
    return ErrorType.FILE_CORRUPT;
  }

  if (msg.includes('stream') || msg.includes('aborted') || msg.includes('interrupted')) {
    return ErrorType.STREAM_ERROR;
  }

  return ErrorType.UNKNOWN;
}

/**
 * 判断错误是否可重试（暂时性 API 错误）
 * 403 算力池切换、429 限流、5xx 服务端错误
 * 注意：401 认证错误不可重试（API Key 无效不会因重试恢复）
 */
export function isRetryableError(error: any): boolean {
  const msg = error?.message || String(error);
  const lower = msg.toLowerCase();

  // 认证错误不可重试：重试不会恢复无效/缺失凭据
  if (lower.includes('401')
    || lower.includes('invalid api key')
    || lower.includes('key_not_found')
    || lower.includes('authentication_error')
    || lower.includes('failed to authenticate')
    || (lower.includes('api error: 403') && (lower.includes('auth') || lower.includes('key') || lower.includes('token')))) {
    return false;
  }

  if (msg.includes('API Error: 403')) return true;
  if (msg.includes('API Error: 429')) return true;
  if (msg.includes('API Error: 500')) return true;
  if (msg.includes('API Error: 502')) return true;
  if (msg.includes('API Error: 503')) return true;
  if (msg.includes('API Error: 504')) return true;
  return false;
}

export function getErrorMessage(error: any, terminalReason?: string): string {
  // terminalReason 提供更精确的错误提示（SDK 0.2.100+）
  if (terminalReason) {
    switch (terminalReason) {
      case 'max_turns':
        return '❌ 任务达到最大轮次限制，请简化需求或分步执行';
      case 'prompt_too_long':
        return '⚠️ 输入过长，请精简提问或使用 /compact 压缩上下文';
      case 'rapid_refill_breaker':
        return '⚠️ API 限流中，请稍后重试';
      case 'context_compact_failed':
        return '⚠️ 上下文过长，自动压缩失败，请手动输入 /compact 重试';
      case 'model_error':
        return '❌ 模型服务异常，请稍后重试';
      case 'tool_error':
        return '❌ 工具执行失败，请检查操作或重试';
      case 'permission_denied':
        return '❌ 权限被拒绝，操作已取消';
      case 'aborted_streaming':
      case 'aborted_tools':
        return '❌ 任务已中断';
    }
  }

  // 回退到原有的错误消息匹配逻辑
  const msg = error?.message || String(error);

  if (msg.includes('CONTEXT_COMPACT_FAILED')) {
    return '⚠️ 上下文过长，自动压缩失败，请手动输入 /compact 重试';
  }
  if (msg.includes('上下文过长') || msg.includes('context too long') || msg.includes('context_length_exceeded')
    || msg.includes('Prompt is too long') || msg.includes('Context limit')) {
    return '⚠️ 上下文过长，自动压缩重试失败，请手动输入 /compact 重试';
  }
  if (msg.includes('API Error: 400')) {
    return '❌ 请求格式错误，请检查输入内容';
  }
  if (msg.includes('401') || msg.includes('Invalid API key') || msg.includes('key_not_found')
    || msg.includes('authentication_error')) {
    return '❌ API Key 无效，请检查密钥配置。使用 /status 查看当前配置';
  }
  if (msg.includes('API Error: 500')) {
    return '❌ API 服务暂时不可用，请稍后重试';
  }
  if (msg.includes('API Error: 403')) {
    return '❌ API 认证失败，请检查密钥配置或稍后重试';
  }
  if (msg.includes('API Error: 429')) {
    return '⚠️ 请求过于频繁，请稍后再试';
  }
  if (msg.includes('timeout')) {
    return '⚠️ 请求超时，请重试';
  }
  if (msg.includes('permission') || msg.includes('im:resource')) {
    return '❌ 权限不足，请联系管理员配置应用权限';
  }

  return '❌ 处理消息时出错，请稍后重试';
}
