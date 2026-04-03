import { Message } from '../types.js';
import path from 'path';
import { logger } from '../utils/logger.js';
import type { EventBus } from './event-bus.js';

type MessageHandler = (message: Message) => Promise<void>;

interface QueuedMessage {
  message: Message;
  projectPath: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private handler: MessageHandler;
  private currentSessionKey?: string;
  private currentProjectPath?: string;
  private currentAgentId?: string;
  private interruptCallback?: (sessionKey: string, agentId?: string) => Promise<void>;
  private eventBus?: EventBus;
  private recentMessageIds = new Set<string>();
  private readonly DEDUP_WINDOW = 60_000; // 1 分钟窗口

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  setInterruptCallback(callback: (sessionKey: string, agentId?: string) => Promise<void>): void {
    this.interruptCallback = callback;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * 检查消息是否应该处理（去重）
   */
  private shouldProcess(message: Message): boolean {
    if (!message.messageId) return true; // 无 ID 的消息不去重
    if (this.recentMessageIds.has(message.messageId)) {
      logger.debug(`[Queue] Duplicate message ${message.messageId}, skipping`);
      return false;
    }
    this.recentMessageIds.add(message.messageId);
    setTimeout(() => this.recentMessageIds.delete(message.messageId!), this.DEDUP_WINDOW);
    return true;
  }

  /**
   * 检查队列 key 是否属于指定 sessionKey
   */
  private matchesSession(key: string, sessionKey: string): boolean {
    return key.startsWith(sessionKey + '::');
  }

  /**
   * 生成项目级别的队列 key
   */
  private getQueueKey(sessionKey: string, projectPath: string): string {
    const projectName = path.basename(projectPath);
    return `${sessionKey}::${projectName}`;
  }

  async enqueue(sessionKey: string, message: Message, projectPath: string, options?: { interruptible?: boolean }): Promise<void> {
    // 消息去重检查
    if (!this.shouldProcess(message)) {
      return Promise.resolve();
    }

    const queueKey = this.getQueueKey(sessionKey, projectPath);
    logger.debug(`[Queue] Enqueuing message for ${queueKey}`);

    return new Promise((resolve, reject) => {
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, []);
      }

      this.queues.get(queueKey)!.push({ message, projectPath, resolve, reject });

      // 根据 interruptible 选项决定是否触发中断
      if (this.processing.has(queueKey)) {
        if (options?.interruptible !== false) {
          // 单聊：保留中断行为
          logger.debug(`[Queue] ${queueKey} is processing, triggering interrupt`);
          this.eventBus?.publish({ type: 'message:interrupted', sessionId: sessionKey, reason: 'new_message' });
          if (this.interruptCallback) {
            this.interruptCallback(sessionKey, this.currentAgentId).catch(() => {});
          }
        } else {
          // 群聊：FIFO，不打断
          logger.debug(`[Queue] ${queueKey} is processing, message queued (FIFO)`);
        }
      } else {
        logger.debug(`[Queue] Starting to process ${queueKey}`);
        this.processNext(queueKey);
      }
    });
  }

  private async processNext(queueKey: string): Promise<void> {
    this.processing.add(queueKey);
    logger.debug(`[Queue] Processing queue ${queueKey}`);

    while (true) {
      const queue = this.queues.get(queueKey);
      if (!queue || queue.length === 0) {
        logger.debug(`[Queue] Queue ${queueKey} is empty, stopping`);
        this.processing.delete(queueKey);
        this.currentSessionKey = undefined;
        this.currentProjectPath = undefined;
        return;
      }

      const { message, projectPath, resolve, reject } = queue.shift()!;
      this.currentSessionKey = queueKey;
      this.currentProjectPath = projectPath;
      this.currentAgentId = message.agentId;

      logger.debug(`[Queue] Processing message from ${message.channel}:${message.channelId}`);
      try {
        await this.handler(message);
        logger.debug(`[Queue] Message processed successfully`);
        resolve();
      } catch (error) {
        logger.error(`[Queue] Message processing failed:`, error);
        reject(error as Error);
      }
    }
  }

  getQueueLength(sessionKey: string): number {
    // 计算该 sessionKey 下所有项目队列的总长度
    let total = 0;
    for (const [key, queue] of this.queues.entries()) {
      if (this.matchesSession(key, sessionKey)) {
        total += queue.length;
      }
    }
    return total;
  }

  isProcessing(sessionKey: string): boolean {
    // 检查该 sessionKey 下是否有任何项目队列在处理
    for (const key of this.processing.keys()) {
      if (this.matchesSession(key, sessionKey)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取正在处理的项目路径
   */
  getProcessingProject(sessionKey: string): string | undefined {
    // 查找该 sessionKey 下正在处理的项目
    for (const key of this.processing.keys()) {
      if (this.matchesSession(key, sessionKey)) {
        // 从 processing 中找到对应的队列，获取 projectPath
        const queue = this.queues.get(key);
        if (queue && queue.length > 0) {
          return queue[0].projectPath;
        }
        // 如果队列为空但仍在处理，返回当前正在处理的项目路径
        if (this.currentSessionKey === key) {
          return this.currentProjectPath;
        }
      }
    }
    return undefined;
  }
}
