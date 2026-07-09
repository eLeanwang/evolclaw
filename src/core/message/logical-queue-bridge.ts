/**
 * Logical Queue Bridge
 *
 * 桥接物理队列（MessageQueue 的 QueuedMessage[]）与逻辑队列（响应模式的出队策略）。
 *
 * 职责分离：
 *   - 物理队列：消息存储、持久化、去重、中断（MessageQueue 现有职责，不变）
 *   - 逻辑队列：仅决定出队顺序（FIFO/LIFO/Priority/Custom，由响应模式提供）
 *
 * 桥接原理：
 *   - enqueue 时：物理数组 push + 逻辑队列记录 messageId 顺序
 *   - 出队时：逻辑队列给出下一个 messageId，桥接器据此在物理数组中定位并前移到队首
 *   - 这样 dequeueGreedy 的 queue.shift() 取到的就是逻辑队列选定的消息
 *
 * 默认行为：无逻辑队列时退化为纯 FIFO（与重构前一致）。
 */

import type { MessageQueueInterface, InboundMessage } from '../../response-system/types.js';
import type { Message } from '../../types.js';
import { FIFOQueue } from '../../response-system/queues/fifo-queue.js';

/** 从物理队列项中提取 messageId 的最小形状 */
interface HasMessage {
  message: Message;
}

export class LogicalQueueBridge {
  /** queueKey → 逻辑队列实例 */
  private queues = new Map<string, MessageQueueInterface>();

  /** 工厂：按 queueKey 创建逻辑队列（默认 FIFO，未来由响应模式 resolver 注入） */
  private factory: (queueKey: string) => MessageQueueInterface;

  constructor(factory?: (queueKey: string) => MessageQueueInterface) {
    this.factory = factory ?? (() => new FIFOQueue());
  }

  /** 设置队列工厂（响应模式系统接入时调用） */
  setFactory(factory: (queueKey: string) => MessageQueueInterface): void {
    this.factory = factory;
  }

  /** 为指定会话替换逻辑队列（切换响应模式时调用） */
  setQueue(queueKey: string, queue: MessageQueueInterface): void {
    this.queues.set(queueKey, queue);
  }

  /** 获取指定会话的逻辑队列（用于同步） */
  getQueue(queueKey: string): MessageQueueInterface | undefined {
    return this.queues.get(queueKey);
  }

  /** 入队：记录 messageId 到逻辑队列的顺序索引 */
  enqueue(queueKey: string, message: Message): void {
    const queue = this.getOrCreate(queueKey);
    queue.enqueue(this.toInbound(message));
  }

  /**
   * 按逻辑队列顺序重排物理数组（原地修改）。
   * dequeueGreedy 在 shift 前调用此方法，确保队首是逻辑队列选定的消息。
   *
   * @returns true 表示完成重排，false 表示无逻辑队列（保持 FIFO）
   */
  reorderPhysical<T extends HasMessage>(queueKey: string, physical: T[]): boolean {
    const queue = this.queues.get(queueKey);
    if (!queue || physical.length <= 1) return false;

    // 逻辑队列给出下一个 messageId（使用 peek 避免提前移除）
    let next: InboundMessage | undefined;
    if (queue.size() > 0) {
      next = queue.peekSync?.();
      // 兼容旧的内置 FIFO 实现形状；自定义队列应实现 peekSync，避免这里出队。
      if (!next) next = (queue as any).queue?.[0];
      if (!next) {
        // 兜底：如果没有内部 queue 数组，使用 dequeueSync（旧行为）
        next = queue.dequeueSync();
      }
    }
    if (!next?.messageId) return false;

    // 在物理数组中定位该消息，前移到队首
    const idx = physical.findIndex(item => this.messageIdOf(item.message) === next.messageId);
    if (idx <= 0) return idx === 0; // 已在队首或未找到（未找到时保持原序）

    const [picked] = physical.splice(idx, 1);
    physical.unshift(picked);
    return true;
  }

  /** 移除逻辑队列中已处理的消息（供 dequeueGreedy 合并后调用） */
  removeProcessed(queueKey: string, messageIds: string[]): void {
    const queue = this.queues.get(queueKey);
    if (!queue) return;

    for (const msgId of messageIds) {
      // 从队首依次匹配并移除
      if (queue.size() > 0) {
        const head = queue.peekSync?.() ?? (queue as any).queue?.[0];
        if (head?.messageId === msgId) {
          queue.dequeueSync();
        }
      }
    }
  }

  /** 清空指定会话的逻辑队列 */
  clear(queueKey: string): void {
    this.queues.get(queueKey)?.clear();
  }

  /** 移除指定会话的逻辑队列（会话结束时） */
  remove(queueKey: string): void {
    this.queues.delete(queueKey);
  }

  // ─── 内部辅助 ───

  private getOrCreate(queueKey: string): MessageQueueInterface {
    let queue = this.queues.get(queueKey);
    if (!queue) {
      queue = this.factory(queueKey);
      this.queues.set(queueKey, queue);
    }
    return queue;
  }

  private toInbound(message: Message): InboundMessage {
    return {
      messageId: this.messageIdOf(message),
      peerId: message.peerId,
      content: message.content,
      chatType: message.chatType ?? 'private',
      isMentioned: message.isMentioned,
      mentionAids: message.mentionAids,
    };
  }

  /** 稳定的 messageId：优先用消息自带 ID，否则用 peerId+timestamp 合成 */
  private messageIdOf(message: Message): string {
    if (message.messageId) return message.messageId;
    return `${message.peerId}_${message.timestamp ?? 0}`;
  }
}
