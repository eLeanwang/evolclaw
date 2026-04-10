export enum ErrorType {
  SDK_TIMEOUT = 'sdk_timeout',
  API_ERROR = 'api_error',
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
 */
const NON_INFRA_SUBTYPES = new Set([
  'end_turn',
  'max_turns',
  'permission_denied',
  'stop',
]);

export function isInfraError(subtype?: string): boolean {
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

export function getErrorMessage(error: any): string {
  const msg = error?.message || String(error);

  if (msg.includes('CONTEXT_COMPACT_FAILED')) {
    return '⚠️ 上下文过长，自动压缩失败，请手动输入 /compact 重试';
  }
  if (msg.includes('上下文过长') || msg.includes('context too long') || msg.includes('context_length_exceeded')
    || msg.includes('Prompt is too long') || msg.includes('Context limit')) {
    return '⚠️ 上下文过长，自动压缩重试失败，请手动输入 /compact 重试';
  }
  if (msg.includes('API Error: 400')) {
    return '⚠️ 请求格式错误，请检查输入内容';
  }
  if (msg.includes('API Error: 500')) {
    return '⚠️ API 服务暂时不可用，请稍后重试';
  }
  if (msg.includes('API Error: 429')) {
    return '⚠️ 请求过于频繁，请稍后再试';
  }
  if (msg.includes('timeout')) {
    return '⚠️ 请求超时，请重试';
  }
  if (msg.includes('permission') || msg.includes('im:resource')) {
    return '⚠️ 权限不足，请联系管理员配置应用权限';
  }

  return '⚠️ 处理消息时出错，请稍后重试';
}
