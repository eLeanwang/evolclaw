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

  it('应该能够添加事件', () => {
    cache.addEvent('session-1', { type: 'completed', message: '测试消息', timestamp: Date.now() });
    expect(cache.getCount('session-1')).toBe(1);
    expect(cache.hasMessages('session-1')).toBe(true);
  });

  it('应该能够获取所有事件', () => {
    cache.addEvent('session-1', { type: 'completed', message: '消息1', timestamp: Date.now() });
    cache.addEvent('session-1', { type: 'completed', message: '消息2', timestamp: Date.now() });
    cache.addEvent('session-1', { type: 'completed', message: '消息3', timestamp: Date.now() });

    const events = cache.getEvents('session-1');
    expect(events.length).toBe(3);
    expect(events[0].message).toBe('消息1');
    expect(events[1].message).toBe('消息2');
    expect(events[2].message).toBe('消息3');
  });

  it('应该能够清空缓存', () => {
    cache.addEvent('session-1', { type: 'completed', message: '消息1', timestamp: Date.now() });
    cache.addEvent('session-1', { type: 'completed', message: '消息2', timestamp: Date.now() });
    expect(cache.getCount('session-1')).toBe(2);

    cache.clearEvents('session-1');
    expect(cache.getCount('session-1')).toBe(0);
    expect(cache.hasMessages('session-1')).toBe(false);
  });

  it('应该为不同session独立存储', () => {
    cache.addEvent('session-1', { type: 'completed', message: 'Session 1 消息', timestamp: Date.now() });
    cache.addEvent('session-2', { type: 'completed', message: 'Session 2 消息', timestamp: Date.now() });

    expect(cache.getCount('session-1')).toBe(1);
    expect(cache.getCount('session-2')).toBe(1);

    const events1 = cache.getEvents('session-1');
    const events2 = cache.getEvents('session-2');

    expect(events1[0].message).toBe('Session 1 消息');
    expect(events2[0].message).toBe('Session 2 消息');
  });

  it('应该返回空数组对于不存在的session', () => {
    const events = cache.getEvents('nonexistent');
    expect(events).toEqual([]);
    expect(cache.getCount('nonexistent')).toBe(0);
    expect(cache.hasMessages('nonexistent')).toBe(false);
  });

  it('应该清理过期消息（超过72小时）', () => {
    // 添加消息
    cache.addEvent('session-1', { type: 'completed', message: '新消息', timestamp: Date.now() });

    // 手动添加过期消息（修改时间戳）
    const events = cache.getEvents('session-1');
    events[0].timestamp = Date.now() - 73 * 60 * 60 * 1000; // 73小时前

    // 添加新消息
    cache.addEvent('session-1', { type: 'completed', message: '最新消息', timestamp: Date.now() });

    // 执行清理
    cache.cleanupExpired();

    // 验证只保留了新消息
    const remaining = cache.getEvents('session-1');
    expect(remaining.length).toBe(1);
    expect(remaining[0].message).toBe('最新消息');
  });

  it('应该在所有消息过期时删除session', () => {
    cache.addEvent('session-1', { type: 'completed', message: '过期消息', timestamp: Date.now() });

    // 修改时间戳为过期
    const events = cache.getEvents('session-1');
    events[0].timestamp = Date.now() - 73 * 60 * 60 * 1000;

    // 执行清理
    cache.cleanupExpired();

    // 验证session已被删除
    expect(cache.hasMessages('session-1')).toBe(false);
    expect(cache.getCount('session-1')).toBe(0);
  });

  it('应该记录事件的时间戳', () => {
    const before = Date.now();
    cache.addEvent('session-1', { type: 'completed', message: '测试消息', timestamp: Date.now() });
    const after = Date.now();

    const events = cache.getEvents('session-1');
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('应该处理空字符串消息', () => {
    cache.addEvent('session-1', { type: 'completed', message: '', timestamp: Date.now() });
    expect(cache.getCount('session-1')).toBe(1);
    const events = cache.getEvents('session-1');
    expect(events[0].message).toBe('');
  });

  it('应该处理包含特殊字符的消息', () => {
    const specialText = '特殊字符: \n\t\r\0 [SEND_FILE:test.txt] <script>alert("xss")</script>';
    cache.addEvent('session-1', { type: 'completed', message: specialText, timestamp: Date.now() });

    const events = cache.getEvents('session-1');
    expect(events[0].message).toBe(specialText);
  });

  it('应该处理非常长的消息', () => {
    const longText = 'A'.repeat(10000);
    cache.addEvent('session-1', { type: 'completed', message: longText, timestamp: Date.now() });

    const events = cache.getEvents('session-1');
    expect(events[0].message).toBe(longText);
    expect(events[0].message.length).toBe(10000);
  });

  it('应该支持快速连续添加消息', () => {
    for (let i = 0; i < 50; i++) {
      cache.addEvent('session-1', { type: 'completed', message: `消息 ${i}`, timestamp: Date.now() });
    }

    expect(cache.getCount('session-1')).toBe(50);
    const events = cache.getEvents('session-1');
    expect(events[0].message).toBe('消息 0');
    expect(events[49].message).toBe('消息 49');
  });

  it('应该在清空后可以重新添加消息', () => {
    cache.addEvent('session-1', { type: 'completed', message: '消息1', timestamp: Date.now() });
    cache.addEvent('session-1', { type: 'completed', message: '消息2', timestamp: Date.now() });
    cache.clearEvents('session-1');

    cache.addEvent('session-1', { type: 'completed', message: '新消息', timestamp: Date.now() });
    expect(cache.getCount('session-1')).toBe(1);
    const events = cache.getEvents('session-1');
    expect(events[0].message).toBe('新消息');
  });

  it('应该处理部分过期的消息', () => {
    // 添加3条消息
    cache.addEvent('session-1', { type: 'completed', message: '消息1', timestamp: Date.now() });
    cache.addEvent('session-1', { type: 'completed', message: '消息2', timestamp: Date.now() });
    cache.addEvent('session-1', { type: 'completed', message: '消息3', timestamp: Date.now() });

    // 修改前两条为过期
    const events = cache.getEvents('session-1');
    events[0].timestamp = Date.now() - 73 * 60 * 60 * 1000;
    events[1].timestamp = Date.now() - 73 * 60 * 60 * 1000;

    // 执行清理
    cache.cleanupExpired();

    // 验证只保留了最后一条
    const remaining = cache.getEvents('session-1');
    expect(remaining.length).toBe(1);
    expect(remaining[0].message).toBe('消息3');
  });

  it('应该处理多个session的混合清理', () => {
    // Session 1: 全部过期
    cache.addEvent('session-1', { type: 'completed', message: '过期消息', timestamp: Date.now() });
    const msg1 = cache.getEvents('session-1');
    msg1[0].timestamp = Date.now() - 73 * 60 * 60 * 1000;

    // Session 2: 部分过期
    cache.addEvent('session-2', { type: 'completed', message: '过期消息', timestamp: Date.now() });
    cache.addEvent('session-2', { type: 'completed', message: '新消息', timestamp: Date.now() });
    const msg2 = cache.getEvents('session-2');
    msg2[0].timestamp = Date.now() - 73 * 60 * 60 * 1000;

    // Session 3: 全部有效
    cache.addEvent('session-3', { type: 'completed', message: '有效消息', timestamp: Date.now() });

    // 执行清理
    cache.cleanupExpired();

    // 验证结果
    expect(cache.hasMessages('session-1')).toBe(false); // 全部过期，session删除
    expect(cache.getCount('session-2')).toBe(1); // 保留1条
    expect(cache.getCount('session-3')).toBe(1); // 保留1条
  });

  it('应该处理清空不存在的session', () => {
    // 不应该抛出错误
    expect(() => cache.clearEvents('nonexistent')).not.toThrow();
    expect(cache.getCount('nonexistent')).toBe(0);
  });

  it('应该支持Unicode和Emoji', () => {
    const unicodeText = '你好世界 🌍 こんにちは 안녕하세요 مرحبا';
    cache.addEvent('session-1', { type: 'completed', message: unicodeText, timestamp: Date.now() });

    const events = cache.getEvents('session-1');
    expect(events[0].message).toBe(unicodeText);
  });

  it('应该支持error类型事件', () => {
    cache.addEvent('session-1', { type: 'error', message: '错误信息', timestamp: Date.now(), metadata: { errorType: 'timeout' } });
    const events = cache.getEvents('session-1');
    expect(events[0].type).toBe('error');
    expect(events[0].metadata?.errorType).toBe('timeout');
  });
});