import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../../../src/utils/error-handler.js';

describe('Error Handler', () => {
  it('should identify API 429 error', () => {
    const error = new Error('API Error: 429 rate limit');
    expect(getErrorMessage(error)).toBe('⚠️ 请求过于频繁，请稍后再试');
  });

  it('should identify API 500 error', () => {
    const error = new Error('API Error: 500 internal');
    expect(getErrorMessage(error)).toBe('⚠️ API 服务暂时不可用，请稍后重试');
  });

  it('should identify API 400 error', () => {
    const error = new Error('API Error: 400 bad request');
    expect(getErrorMessage(error)).toBe('⚠️ 请求格式错误，请检查输入内容');
  });

  it('should identify timeout error', () => {
    const error = new Error('Request timeout');
    expect(getErrorMessage(error)).toBe('⚠️ 请求超时，请重试');
  });

  it('should identify permission error', () => {
    const error = new Error('permission denied');
    expect(getErrorMessage(error)).toBe('⚠️ 权限不足，请联系管理员配置应用权限');
  });

  it('should return default error message', () => {
    const error = new Error('Unknown error');
    expect(getErrorMessage(error)).toBe('⚠️ 处理消息时出错，请稍后重试');
  });
});
