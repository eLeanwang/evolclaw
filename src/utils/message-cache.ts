/**
 * 消息缓存
 * 用于缓存后台任务的关键事件（完成、错误）
 */

export interface CachedEvent {
  type: 'completed' | 'error';
  message: string;
  timestamp: number;
  metadata?: {
    duration?: number;
    cost?: number;
    errorType?: string;
  };
}

export class MessageCache {
  private cache = new Map<string, CachedEvent[]>();

  /**
   * 添加事件到缓存
   */
  addEvent(sessionId: string, event: CachedEvent): void {
    if (!this.cache.has(sessionId)) {
      this.cache.set(sessionId, []);
    }
    this.cache.get(sessionId)!.push(event);
  }

  /**
   * 获取指定会话的所有缓存事件
   */
  getEvents(sessionId: string): CachedEvent[] {
    return this.cache.get(sessionId) || [];
  }

  /**
   * 获取指定会话的缓存事件数量
   */
  getCount(sessionId: string): number {
    return this.cache.get(sessionId)?.length || 0;
  }

  /**
   * 检查指定会话是否有缓存事件
   */
  hasMessages(sessionId: string): boolean {
    return this.getCount(sessionId) > 0;
  }

  /**
   * 清空指定会话的缓存事件
   */
  clearEvents(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * 清理过期的缓存事件
   * @param maxAge 最大保留时间（毫秒），默认 72 小时
   */
  cleanupExpired(maxAge: number = 72 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [sessionId, events] of this.cache.entries()) {
      const filtered = events.filter(e => now - e.timestamp < maxAge);
      if (filtered.length === 0) {
        this.cache.delete(sessionId);
      } else {
        this.cache.set(sessionId, filtered);
      }
    }
  }
}
