import { query } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from '../config.js';
import { ConcurrencyManager } from './concurrency-manager.js';
import path from 'path';

export class AgentRunner {
  private apiKey: string;
  private activeSessions: Map<string, string> = new Map();
  private concurrency: ConcurrencyManager;

  constructor(apiKey: string, maxConcurrent: number = 10) {
    this.apiKey = apiKey;
    this.concurrency = new ConcurrencyManager(maxConcurrent);

    // 监听执行事件
    this.concurrency.on('execute', async ({ sessionId, message, resolve, reject }) => {
      try {
        const result = await this.executeQuery(sessionId, message.prompt, message.projectPath);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 提交查询到并发队列
   * - 同一会话串行
   * - 不同会话并发
   */
  async runQuery(sessionId: string, prompt: string, projectPath: string): Promise<AsyncIterator<any>> {
    return this.concurrency.enqueue(sessionId, prompt, projectPath);
  }

  /**
   * 实际执行查询
   */
  private async executeQuery(sessionId: string, prompt: string, projectPath: string): Promise<AsyncIterator<any>> {
    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    const claudeSessionId = this.activeSessions.get(sessionId);

    const queryResult = query({
      prompt,
      options: {
        cwd: projectPath,
        resume: claudeSessionId,
        env: {
          ANTHROPIC_API_KEY: this.apiKey
        }
      }
    });

    // Query 本身就是 AsyncGenerator，直接返回
    // Session ID 会在结果消息中返回，需要在迭代时提取
    return queryResult;
  }

  /**
   * 更新 Claude session ID
   */
  updateSessionId(sessionId: string, claudeSessionId: string): void {
    this.activeSessions.set(sessionId, claudeSessionId);
  }

  /**
   * 获取并发状态
   */
  getStatus() {
    return {
      ...this.concurrency.getStatus(),
      activeSessions: this.activeSessions.size
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
  }
}
