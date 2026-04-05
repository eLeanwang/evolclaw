import { logger } from './logger.js';
import type { Message } from '../types.js';

/** 窗口内的单条消息快照 */
interface DebouncedEntry {
  messageId?: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  replyContext?: Message['replyContext'];
  rest: Omit<Message, 'content' | 'images' | 'mentions' | 'messageId' | 'replyContext'>;
  resolve: () => void;
  reject: (e: Error) => void;
}

interface PendingWindow {
  entries: DebouncedEntry[];
  timer: ReturnType<typeof setTimeout>;
  maxWaitTimer: ReturnType<typeof setTimeout>;
}

export type EnqueueFn = (message: Message) => Promise<void>;

/**
 * 入站消息去抖器
 *
 * 在 debounceMs 窗口内收到的同一 session 的多条消息合并为一次 enqueue：
 * - content 用 \n 连接
 * - images / mentions 合并
 * - replyContext / 其余字段取最后一条
 *
 * cancel(messageId) 可精确移除窗口中的某条消息，不影响其余消息。
 */
export class StreamDebouncer {
  private pending = new Map<string, PendingWindow>();
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
   */
  submit(key: string, message: Message, enqueue: EnqueueFn): Promise<void> {
    const { content, images, mentions, messageId, replyContext, ...rest } = message;
    return new Promise<void>((resolve, reject) => {
      const entry: DebouncedEntry = { messageId, content, images, mentions, replyContext, rest, resolve, reject };
      const win = this.pending.get(key);

      if (win) {
        clearTimeout(win.timer);
        win.entries.push(entry);

        if (win.entries.length >= this.maxMessages) {
          logger.debug(`[Debounce] Max messages (${this.maxMessages}) reached for ${key}, flushing immediately`);
          clearTimeout(win.maxWaitTimer);
          this.flush(key, enqueue);
          return;
        }

        win.timer = setTimeout(() => this.flush(key, enqueue), this.delayMs);
        logger.debug(`[Debounce] Appended message for ${key}, ${win.entries.length} pending`);
      } else {
        const timer = setTimeout(() => this.flush(key, enqueue), this.delayMs);
        const maxWaitTimer = setTimeout(() => this.flush(key, enqueue), this.maxWaitMs);
        this.pending.set(key, { entries: [entry], timer, maxWaitTimer });
        logger.debug(`[Debounce] New window for ${key}, debounce=${this.delayMs}ms, maxWait=${this.maxWaitMs}ms`);
      }
    });
  }

  /**
   * 从 debounce 窗口中撤回指定 messageId 的消息。
   * 如果窗口只剩这一条，整个窗口取消。
   * @returns true 如果找到并移除
   */
  cancel(messageId: string): boolean {
    for (const [key, win] of this.pending) {
      const idx = win.entries.findIndex(e => e.messageId === messageId);
      if (idx === -1) continue;

      // resolve 被撤回的那条（静默完成，不报错）
      win.entries.splice(idx, 1)[0].resolve();
      logger.info(`[Debounce] Cancelled message ${messageId} from window ${key}`);

      // 窗口空了 → 整个取消
      if (win.entries.length === 0) {
        clearTimeout(win.timer);
        clearTimeout(win.maxWaitTimer);
        this.pending.delete(key);
        logger.info(`[Debounce] Window ${key} empty after cancel, removed`);
      }
      return true;
    }
    return false;
  }

  private flush(key: string, enqueue: EnqueueFn): void {
    const win = this.pending.get(key);
    if (!win) return;
    this.pending.delete(key);

    clearTimeout(win.timer);
    clearTimeout(win.maxWaitTimer);

    const { entries } = win;

    // 合并：content 用 \n 连接，images/mentions 扁平合并，其余取最后一条
    const allImages: Array<{ data: string; mimeType: string }> = [];
    const allMentions: Array<{ userId: string; name?: string; key?: string }> = [];
    const contents: string[] = [];

    for (const e of entries) {
      contents.push(e.content);
      if (e.images) allImages.push(...e.images);
      if (e.mentions) allMentions.push(...e.mentions);
    }

    const last = entries[entries.length - 1];
    const merged: Message = {
      ...last.rest,
      content: contents.join('\n'),
      images: allImages.length > 0 ? allImages : undefined,
      mentions: allMentions.length > 0 ? allMentions : undefined,
      replyContext: last.replyContext,
      messageId: entries.length > 1 ? undefined : last.messageId,
    };

    const resolves = entries.map(e => e.resolve);
    const rejects = entries.map(e => e.reject);

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
    for (const win of this.pending.values()) {
      clearTimeout(win.timer);
      clearTimeout(win.maxWaitTimer);
    }
    this.pending.clear();
  }
}
