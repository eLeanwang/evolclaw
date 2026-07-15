/**
 * LIFO Queue - Last In First Out (Stack)
 *
 * 后入先出，最新的消息优先处理
 */

import type { MessageQueueInterface, InboundMessage } from '../types.js';

export class LIFOQueue implements MessageQueueInterface {
  private queue: InboundMessage[] = [];

  async enqueue(message: InboundMessage, priority?: number): Promise<void> {
    this.queue.push(message);
  }

  async dequeue(): Promise<InboundMessage | undefined> {
    return this.queue.pop();  // ← 从队尾取，实现后进先出
  }

  dequeueSync(): InboundMessage | undefined {
    return this.queue.pop();
  }

  async peek(): Promise<InboundMessage | undefined> {
    return this.queue[this.queue.length - 1];
  }

  peekSync(): InboundMessage | undefined {
    return this.queue[this.queue.length - 1];
  }

  size(): number {
    return this.queue.length;
  }

  async clear(): Promise<void> {
    this.queue = [];
  }

  async reorder(strategy: 'fifo' | 'lifo' | 'priority'): Promise<void> {
    if (strategy === 'lifo') {
      // Already LIFO, no-op
      return;
    } else if (strategy === 'fifo') {
      // Reverse to FIFO order
      this.queue.reverse();
    } else if (strategy === 'priority') {
      // Keep current order (no priority info)
    }
  }
}
