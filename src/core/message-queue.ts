import { Message } from '../types.js';
import path from 'path';
import { logger } from '../utils/logger.js';

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
  private interruptCallback?: (sessionKey: string) => Promise<void>;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  setInterruptCallback(callback: (sessionKey: string) => Promise<void>): void {
    this.interruptCallback = callback;
  }

  /**
   * 生成项目级别的队列 key
   */
  private getQueueKey(sessionKey: string, projectPath: string): string {
    const projectName = path.basename(projectPath);
    return `${sessionKey}-${projectName}`;
  }

  async enqueue(sessionKey: string, message: Message, projectPath: string): Promise<void> {
    const queueKey = this.getQueueKey(sessionKey, projectPath);
    logger.debug(`[Queue] Enqueuing message for ${queueKey}`);

    return new Promise((resolve, reject) => {
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, []);
      }

      this.queues.get(queueKey)!.push({ message, projectPath, resolve, reject });

      // 如果正在处理，触发中断
      if (this.processing.has(queueKey)) {
        logger.debug(`[Queue] ${queueKey} is processing, triggering interrupt`);
        if (this.interruptCallback) {
          this.interruptCallback(sessionKey).catch(() => {});
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
      if (key.startsWith(sessionKey + '-')) {
        total += queue.length;
      }
    }
    return total;
  }

  isProcessing(sessionKey: string): boolean {
    // 检查该 sessionKey 下是否有任何项目队列在处理
    for (const key of this.processing.keys()) {
      if (key.startsWith(sessionKey + '-')) {
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
      if (key.startsWith(sessionKey + '-')) {
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
