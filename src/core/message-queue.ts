import { Message } from '../types.js';

type MessageHandler = (message: Message) => Promise<void>;

interface QueuedMessage {
  message: Message;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private handler: MessageHandler;
  private currentSessionKey?: string;
  private interruptCallback?: (sessionKey: string) => Promise<void>;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  setInterruptCallback(callback: (sessionKey: string) => Promise<void>): void {
    this.interruptCallback = callback;
  }

  async enqueue(sessionKey: string, message: Message): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.queues.has(sessionKey)) {
        this.queues.set(sessionKey, []);
      }

      this.queues.get(sessionKey)!.push({ message, resolve, reject });

      // 如果正在处理，触发中断
      if (this.processing.has(sessionKey)) {
        if (this.interruptCallback) {
          this.interruptCallback(sessionKey).catch(() => {});
        }
      } else {
        this.processNext(sessionKey);
      }
    });
  }

  private async processNext(sessionKey: string): Promise<void> {
    this.processing.add(sessionKey);

    while (true) {
      const queue = this.queues.get(sessionKey);
      if (!queue || queue.length === 0) {
        this.processing.delete(sessionKey);
        this.currentSessionKey = undefined;
        return;
      }

      const { message, resolve, reject } = queue.shift()!;
      this.currentSessionKey = sessionKey;

      try {
        await this.handler(message);
        resolve();
      } catch (error) {
        reject(error as Error);
      }
    }
  }

  getQueueLength(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  isProcessing(sessionKey: string): boolean {
    return this.processing.has(sessionKey);
  }
}
