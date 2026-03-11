import { EventEmitter } from 'events';

interface QueuedMessage {
  sessionId: string;
  prompt: string;
  projectPath: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export class ConcurrencyManager extends EventEmitter {
  private sessionQueues: Map<string, QueuedMessage[]> = new Map();
  private activeExecutions: Set<string> = new Set();
  private maxConcurrent: number;
  private currentConcurrent: number = 0;

  constructor(maxConcurrent: number = 10) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * 提交任务到队列
   * - 同一会话的任务串行执行
   * - 不同会话的任务并发执行（受全局并发限制）
   */
  async enqueue(sessionId: string, prompt: string, projectPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const message: QueuedMessage = { sessionId, prompt, projectPath, resolve, reject };

      if (!this.sessionQueues.has(sessionId)) {
        this.sessionQueues.set(sessionId, []);
      }

      this.sessionQueues.get(sessionId)!.push(message);
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    // 全局并发限制
    if (this.currentConcurrent >= this.maxConcurrent) {
      return;
    }

    // 找到一个空闲的会话队列
    for (const [sessionId, queue] of this.sessionQueues.entries()) {
      if (queue.length === 0) continue;
      if (this.activeExecutions.has(sessionId)) continue; // 该会话正在执行

      const message = queue.shift()!;
      this.executeMessage(sessionId, message);
      return;
    }
  }

  private async executeMessage(sessionId: string, message: QueuedMessage): Promise<void> {
    this.activeExecutions.add(sessionId);
    this.currentConcurrent++;

    try {
      // 触发执行事件，由 AgentRunner 处理
      const result = await new Promise((resolve, reject) => {
        this.emit('execute', { sessionId, message, resolve, reject });
      });

      message.resolve(result);
    } catch (error) {
      message.reject(error as Error);
    } finally {
      this.activeExecutions.delete(sessionId);
      this.currentConcurrent--;
      this.processNext(); // 处理下一个任务
    }
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      currentConcurrent: this.currentConcurrent,
      maxConcurrent: this.maxConcurrent,
      queuedSessions: this.sessionQueues.size,
      totalQueued: Array.from(this.sessionQueues.values()).reduce((sum, q) => sum + q.length, 0)
    };
  }
}
