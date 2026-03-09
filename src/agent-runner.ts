import { query } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from './config.js';
import path from 'path';
import { MessageStream, ImageData } from './message-stream.js';
import { logger } from './utils/logger.js';
import { simpleRetry } from './utils/retry.js';

export class AgentRunner {
  private apiKey: string;
  private activeSessions: Map<string, string> = new Map();
  private onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void;

  constructor(apiKey: string, onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void) {
    this.apiKey = apiKey;
    this.onSessionIdUpdate = onSessionIdUpdate;
  }

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string): Promise<AsyncIterable<any>> {
    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    // 优先使用传入的 claudeSessionId（从数据库恢复），否则使用内存中的
    const claudeSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

    // 使用重试机制包装 query 调用
    return simpleRetry(async () => {
      // 只有当有图片时才使用 MessageStream，否则使用简单字符串
      if (images && images.length > 0) {
        logger.debug('[AgentRunner] Creating query with images, images:', images.length);
        logger.debug('[AgentRunner] Skipping resume for image message to avoid history conflict');

        const stream = new MessageStream();
        stream.push(prompt, images);
        stream.end();

        // 图片消息不使用 resume，避免会话历史冲突
        return query({
          prompt: stream,
          options: {
            cwd: projectPath,
            ...(systemPromptAppend ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: systemPromptAppend
              }
            } : {}),
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: this.apiKey,
              PATH: process.env.PATH,
              ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {})
            }
          }
        });
      } else {
        logger.debug('[AgentRunner] Creating query with text only, claudeSessionId:', claudeSessionId);

        // 文本消息使用 resume 保持上下文
        return query({
          prompt: prompt,
          options: {
            cwd: projectPath,
            ...(claudeSessionId ? { resume: claudeSessionId } : {}),
            ...(systemPromptAppend ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: systemPromptAppend
              }
            } : {}),
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: this.apiKey,
              PATH: process.env.PATH,
              ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {})
            }
          }
        });
      }
    }, 3);
  }

  updateSessionId(sessionId: string, claudeSessionId: string): void {
    this.activeSessions.set(sessionId, claudeSessionId);
    // 触发回调，通知外部持久化
    if (this.onSessionIdUpdate) {
      this.onSessionIdUpdate(sessionId, claudeSessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
  }
}
