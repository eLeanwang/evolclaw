/**
 * Priority Queue - Priority-based ordering
 *
 * 按优先级排序，高优先级优先处理
 */

import type { MessageQueueInterface, InboundMessage } from '../types.js';

interface PriorityItem {
  message: InboundMessage;
  priority: number;  // 数字越大，优先级越高
  insertOrder: number;  // 入队顺序（同优先级时按 FIFO）
}

export class PriorityQueue implements MessageQueueInterface {
  private queue: PriorityItem[] = [];
  private insertCounter = 0;

  async enqueue(message: InboundMessage, priority: number = 0): Promise<void> {
    const item: PriorityItem = {
      message,
      priority,
      insertOrder: this.insertCounter++,
    };

    // 插入排序：按优先级降序，同优先级按插入顺序升序
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < priority ||
          (this.queue[i].priority === priority && this.queue[i].insertOrder > item.insertOrder)) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, item);
  }

  async dequeue(): Promise<InboundMessage | undefined> {
    const item = this.queue.shift();
    return item?.message;
  }

  dequeueSync(): InboundMessage | undefined {
    const item = this.queue.shift();
    return item?.message;
  }

  async peek(): Promise<InboundMessage | undefined> {
    return this.queue[0]?.message;
  }

  size(): number {
    return this.queue.length;
  }

  async clear(): Promise<void> {
    this.queue = [];
    this.insertCounter = 0;
  }

  async reorder(strategy: 'fifo' | 'lifo' | 'priority'): Promise<void> {
    if (strategy === 'priority') {
      // Already priority-sorted, no-op
      return;
    }

    // Extract messages
    const messages = this.queue.map(item => item.message);

    if (strategy === 'fifo') {
      // Sort by insert order (ascending)
      this.queue.sort((a, b) => a.insertOrder - b.insertOrder);
    } else if (strategy === 'lifo') {
      // Sort by insert order (descending)
      this.queue.sort((a, b) => b.insertOrder - a.insertOrder);
    }
  }
}
