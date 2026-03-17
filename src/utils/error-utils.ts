export enum ErrorType {
  SDK_TIMEOUT = 'sdk_timeout',
  API_ERROR = 'api_error',
  FILE_CORRUPT = 'file_corrupt',
  STREAM_ERROR = 'stream_error',
  CONTEXT_TOO_LONG = 'context_too_long',
  UNKNOWN = 'unknown'
}

export function classifyError(error: any): ErrorType {
  const msg = (error?.message || '').toLowerCase();

  if (msg.includes('上下文过长') || msg.includes('context too long')
    || msg.includes('context_length_exceeded') || msg.includes('context_compact_failed')) {
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
  if (msg.includes('上下文过长') || msg.includes('context too long') || msg.includes('context_length_exceeded')) {
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
