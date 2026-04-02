import { logger } from './logger.js';
import type { Message } from '../types.js';

interface PendingDebounce {
  contents: string[];
  images: Array<{ data: string; mimeType: string }>;
  mentions: Array<{ userId: string; name?: string; key?: string }>;
  lastMessage: Omit<Message, 'content' | 'images' | 'mentions'>;
  timer: ReturnType<typeof setTimeout>;
  maxWaitTimer: ReturnType<typeof setTimeout>;
  resolves: Array<() => void>;
  rejects: Array<(e: Error) => void>;
}

export type EnqueueFn = (message: Message) => Promise<void>;

/**
 * 入站消息去抖器
 *
 * 在 debounceMs 窗口内收到的同一 session 的多条消息合并为一次 enqueue：
 * - content 用 \n 连接
 * - images / mentions 合并
 * - 其余字段（channelId, peerId, replyContext 等）取最后一条
 */
export class StreamDebouncer {
  private pending = new Map<string, PendingDebounce>();
  private readonly delayMs: number;
  private readonly maxWaitMs: number;
  private readonly maxMessages: number;

  constructor(debounceSeconds: number, maxMessages = 5) {
    this.delayMs = debounceSeconds * 1000;
    this.maxWaitMs = this.delayMs * 3;
    this.maxMessages = maxMessages;
  }

  get enabled(): boolean {
    return this.delayMs > 0;
  }

  /**
   * 提交一条消息。如果窗口内已有消息则追加并重置 timer；
   * 否则新建窗口。timer 到期后自动 flush。
   *
   * @param key  去抖 key（通常是 session id）
   * @param message  完整消息
   * @param enqueue  timer 到期后的实际入队回调
   * @returns Promise，在消息被实际 enqueue 并处理完后 resolve
   */
  submit(key: string, message: Message, enqueue: EnqueueFn): Promise<void> {
    const { content, images, mentions, ...rest } = message;
    return new Promise<void>((resolve, reject) => {
      const existing = this.pending.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.contents.push(content);
        if (images) existing.images.push(...images);
        if (mentions) existing.mentions.push(...mentions);
        existing.lastMessage = rest;
        existing.resolves.push(resolve);
        existing.rejects.push(reject);

        // 检查是否达到最大消息数，立即触发
        if (existing.contents.length >= this.maxMessages) {
          logger.debug(`[Debounce] Max messages (${this.maxMessages}) reached for ${key}, flushing immediately`);
          clearTimeout(existing.maxWaitTimer);
          this.flush(key, enqueue);
          return;
        }

        existing.timer = setTimeout(() => this.flush(key, enqueue), this.delayMs);
        logger.debug(`[Debounce] Appended message for ${key}, ${existing.contents.length} pending`);
      } else {
        const timer = setTimeout(() => this.flush(key, enqueue), this.delayMs);
        const maxWaitTimer = setTimeout(() => this.flush(key, enqueue), this.maxWaitMs);
        this.pending.set(key, {
          contents: [content],
          images: images ? [...images] : [],
          mentions: mentions ? [...mentions] : [],
          lastMessage: rest,
          timer,
          maxWaitTimer,
          resolves: [resolve],
          rejects: [reject],
        });
        logger.debug(`[Debounce] New window for ${key}, debounce=${this.delayMs}ms, maxWait=${this.maxWaitMs}ms`);
      }
    });
  }

  private flush(key: string, enqueue: EnqueueFn): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);

    // 清理两个 timer
    clearTimeout(entry.timer);
    clearTimeout(entry.maxWaitTimer);

    const { contents, images, mentions, lastMessage, resolves, rejects } = entry;
    const merged: Message = {
      ...lastMessage,
      content: contents.join('\n'),
      images: images.length > 0 ? images : undefined,
      mentions: mentions.length > 0 ? mentions : undefined,
    };

    enqueue(merged).then(
      () => resolves.forEach(r => r()),
      (e) => rejects.forEach(r => r(e as Error)),
    );
  }

  /** 当前挂起的 key 数量（用于测试/调试） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 清理所有挂起的 timer（用于 shutdown） */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.maxWaitTimer);
    }
    this.pending.clear();
  }
}
