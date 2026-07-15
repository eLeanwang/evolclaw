/**
 * FIFO Queue - First In First Out
 *
 * 最简单的队列实现，按入队顺序出队
 */

import type { MessageQueueInterface, InboundMessage } from '../types.js';

export class FIFOQueue implements MessageQueueInterface {
  private queue: InboundMessage[] = [];

  async enqueue(message: InboundMessage, priority?: number): Promise<void> {
    this.queue.push(message);
  }

  async dequeue(): Promise<InboundMessage | undefined> {
    return this.queue.shift();
  }

  dequeueSync(): InboundMessage | undefined {
    return this.queue.shift();
  }

  async peek(): Promise<InboundMessage | undefined> {
    return this.queue[0];
  }

  peekSync(): InboundMessage | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  async clear(): Promise<void> {
    this.queue = [];
  }

  async reorder(strategy: 'fifo' | 'lifo' | 'priority'): Promise<void> {
    if (strategy === 'fifo') {
      // Already FIFO, no-op
      return;
    } else if (strategy === 'lifo') {
      // Reverse the queue
      this.queue.reverse();
    } else if (strategy === 'priority') {
      // Sort by messageId (simple priority: earlier messageId = higher priority)
      // TODO: 实际应该根据 priority 字段排序，但当前 InboundMessage 没有该字段
      // 这里先按入队顺序保持不变（等价于 FIFO）
    }
  }
}
