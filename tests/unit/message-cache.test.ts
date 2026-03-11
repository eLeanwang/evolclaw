/**
 * MessageCache 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageCache } from '../../src/core/message-cache.js';

describe('MessageCache 单元测试', () => {
  let cache: MessageCache;

  beforeEach(() => {
    cache = new MessageCache();
  });

  it('应该能够添加消息', () => {
    cache.add('session-1', '测试消息');
    expect(cache.getCount('session-1')).toBe(1);
    expect(cache.hasMessages('session-1')).toBe(true);
  });

  it('应该能够获取所有消息', () => {
    cache.add('session-1', '消息1');
    cache.add('session-1', '消息2');
    cache.add('session-1', '消息3');

    const messages = cache.getAll('session-1');
    expect(messages.length).toBe(3);
    expect(messages[0].text).toBe('消息1');
    expect(messages[1].text).toBe('消息2');
    expect(messages[2].text).toBe('消息3');
  });

  it('应该能够清空缓存', () => {
    cache.add('session-1', '消息1');
    cache.add('session-1', '消息2');
    expect(cache.getCount('session-1')).toBe(2);

    cache.clear('session-1');
    expect(cache.getCount('session-1')).toBe(0);
    expect(cache.hasMessages('session-1')).toBe(false);
  });

  it('应该限制缓存大小为100条', () => {
    for (let i = 0; i < 150; i++) {
      cache.add('session-1', `消息 ${i}`);
    }

    expect(cache.getCount('session-1')).toBe(100);

    const messages = cache.getAll('session-1');
    // 应该保留最后100条（50-149）
    expect(messages[0].text).toBe('消息 50');
    expect(messages[99].text).toBe('消息 149');
  });

  it('应该为不同session独立存储', () => {
    cache.add('session-1', 'Session 1 消息');
    cache.add('session-2', 'Session 2 消息');

    expect(cache.getCount('session-1')).toBe(1);
    expect(cache.getCount('session-2')).toBe(1);

    const messages1 = cache.getAll('session-1');
    const messages2 = cache.getAll('session-2');

    expect(messages1[0].text).toBe('Session 1 消息');
    expect(messages2[0].text).toBe('Session 2 消息');
  });

  it('应该返回空数组对于不存在的session', () => {
    const messages = cache.getAll('nonexistent');
    expect(messages).toEqual([]);
    expect(cache.getCount('nonexistent')).toBe(0);
    expect(cache.hasMessages('nonexistent')).toBe(false);
  });

  it('应该清理过期消息（超过1小时）', () => {
    // 添加消息
    cache.add('session-1', '新消息');

    // 手动添加过期消息（修改时间戳）
    const messages = cache.getAll('session-1');
    messages[0].timestamp = Date.now() - 2 * 60 * 60 * 1000; // 2小时前

    // 添加新消息
    cache.add('session-1', '最新消息');

    // 执行清理
    cache.cleanupExpired();

    // 验证只保留了新消息
    const remaining = cache.getAll('session-1');
    expect(remaining.length).toBe(1);
    expect(remaining[0].text).toBe('最新消息');
  });

  it('应该在所有消息过期时删除session', () => {
    cache.add('session-1', '过期消息');

    // 修改时间戳为过期
    const messages = cache.getAll('session-1');
    messages[0].timestamp = Date.now() - 2 * 60 * 60 * 1000;

    // 执行清理
    cache.cleanupExpired();

    // 验证session已被删除
    expect(cache.hasMessages('session-1')).toBe(false);
    expect(cache.getCount('session-1')).toBe(0);
  });

  it('应该记录消息的时间戳', () => {
    const before = Date.now();
    cache.add('session-1', '测试消息');
    const after = Date.now();

    const messages = cache.getAll('session-1');
    expect(messages[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(messages[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('应该处理空字符串消息', () => {
    cache.add('session-1', '');
    expect(cache.getCount('session-1')).toBe(1);
    const messages = cache.getAll('session-1');
    expect(messages[0].text).toBe('');
  });

  it('应该处理包含特殊字符的消息', () => {
    const specialText = '特殊字符: \n\t\r\0 [SEND_FILE:test.txt] <script>alert("xss")</script>';
    cache.add('session-1', specialText);

    const messages = cache.getAll('session-1');
    expect(messages[0].text).toBe(specialText);
  });

  it('应该处理非常长的消息', () => {
    const longText = 'A'.repeat(10000);
    cache.add('session-1', longText);

    const messages = cache.getAll('session-1');
    expect(messages[0].text).toBe(longText);
    expect(messages[0].text.length).toBe(10000);
  });

  it('应该支持快速连续添加消息', () => {
    for (let i = 0; i < 50; i++) {
      cache.add('session-1', `消息 ${i}`);
    }

    expect(cache.getCount('session-1')).toBe(50);
    const messages = cache.getAll('session-1');
    expect(messages[0].text).toBe('消息 0');
    expect(messages[49].text).toBe('消息 49');
  });

  it('应该在清空后可以重新添加消息', () => {
    cache.add('session-1', '消息1');
    cache.add('session-1', '消息2');
    cache.clear('session-1');

    cache.add('session-1', '新消息');
    expect(cache.getCount('session-1')).toBe(1);
    const messages = cache.getAll('session-1');
    expect(messages[0].text).toBe('新消息');
  });

  it('应该处理部分过期的消息', () => {
    // 添加3条消息
    cache.add('session-1', '消息1');
    cache.add('session-1', '消息2');
    cache.add('session-1', '消息3');

    // 修改前两条为过期
    const messages = cache.getAll('session-1');
    messages[0].timestamp = Date.now() - 2 * 60 * 60 * 1000;
    messages[1].timestamp = Date.now() - 2 * 60 * 60 * 1000;

    // 执行清理
    cache.cleanupExpired();

    // 验证只保留了最后一条
    const remaining = cache.getAll('session-1');
    expect(remaining.length).toBe(1);
    expect(remaining[0].text).toBe('消息3');
  });

  it('应该处理多个session的混合清理', () => {
    // Session 1: 全部过期
    cache.add('session-1', '过期消息');
    const msg1 = cache.getAll('session-1');
    msg1[0].timestamp = Date.now() - 2 * 60 * 60 * 1000;

    // Session 2: 部分过期
    cache.add('session-2', '过期消息');
    cache.add('session-2', '新消息');
    const msg2 = cache.getAll('session-2');
    msg2[0].timestamp = Date.now() - 2 * 60 * 60 * 1000;

    // Session 3: 全部有效
    cache.add('session-3', '有效消息');

    // 执行清理
    cache.cleanupExpired();

    // 验证结果
    expect(cache.hasMessages('session-1')).toBe(false); // 全部过期，session删除
    expect(cache.getCount('session-2')).toBe(1); // 保留1条
    expect(cache.getCount('session-3')).toBe(1); // 保留1条
  });

  it('应该在达到上限时保持FIFO顺序', () => {
    // 添加100条消息
    for (let i = 0; i < 100; i++) {
      cache.add('session-1', `消息 ${i}`);
    }

    // 再添加10条
    for (let i = 100; i < 110; i++) {
      cache.add('session-1', `消息 ${i}`);
    }

    // 验证保留了最后100条（10-109）
    const messages = cache.getAll('session-1');
    expect(messages.length).toBe(100);
    expect(messages[0].text).toBe('消息 10');
    expect(messages[99].text).toBe('消息 109');
  });

  it('应该处理清空不存在的session', () => {
    // 不应该抛出错误
    expect(() => cache.clear('nonexistent')).not.toThrow();
    expect(cache.getCount('nonexistent')).toBe(0);
  });

  it('应该支持Unicode和Emoji', () => {
    const unicodeText = '你好世界 🌍 こんにちは 안녕하세요 مرحبا';
    cache.add('session-1', unicodeText);

    const messages = cache.getAll('session-1');
    expect(messages[0].text).toBe(unicodeText);
  });
});
