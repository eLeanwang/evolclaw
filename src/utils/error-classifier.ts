/**
 * 错误类型枚举
 */
export enum ErrorType {
  SDK_TIMEOUT = 'sdk_timeout',
  API_ERROR = 'api_error',
  FILE_CORRUPT = 'file_corrupt',
  STREAM_ERROR = 'stream_error',
  CONTEXT_TOO_LONG = 'context_too_long',
  UNKNOWN = 'unknown'
}

/**
 * 分类错误类型
 */
export function classifyError(error: any): ErrorType {
  const msg = (error?.message || '').toLowerCase();

  // 上下文过长（可恢复，不应累计触发安全模式）
  if (msg.includes('上下文过长') || msg.includes('context too long')
    || msg.includes('context_length_exceeded') || msg.includes('context_compact_failed')) {
    return ErrorType.CONTEXT_TOO_LONG;
  }

  // SDK 超时
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return ErrorType.SDK_TIMEOUT;
  }

  // API 5xx 错误
  if (msg.includes('5') && (msg.includes('00') || msg.includes('02') || msg.includes('03') || msg.includes('04'))) {
    return ErrorType.API_ERROR;
  }

  // 文件损坏或不存在
  if (msg.includes('enoent') || msg.includes('corrupt') || msg.includes('invalid json')) {
    return ErrorType.FILE_CORRUPT;
  }

  // 流处理错误
  if (msg.includes('stream') || msg.includes('aborted') || msg.includes('interrupted')) {
    return ErrorType.STREAM_ERROR;
  }

  return ErrorType.UNKNOWN;
}
