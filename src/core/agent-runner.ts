import { query } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from '../config.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MessageStream, ImageData } from './message-stream.js';
import { logger } from '../utils/logger.js';
import { simpleRetry } from '../utils/retry.js';
import { canUseTool } from '../utils/permission.js';

export class AgentRunner {
  private apiKey: string;
  private model: string;
  private activeSessions: Map<string, string> = new Map();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;

  constructor(
    apiKey: string,
    model?: string,
    onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void
  ) {
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-4-6';
    this.onSessionIdUpdate = onSessionIdUpdate;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  setCompactStartCallback(callback: (sessionId: string) => void): void {
    this.onCompactStart = callback;
  }

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string): Promise<AsyncIterable<any>> {
    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    // 优先使用传入的 claudeSessionId（从数据库恢复），否则使用内存中的
    let claudeSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

    // 验证会话文件是否存在，防止 SDK 因恢复不存在的会话而崩溃
    if (claudeSessionId) {
      // SDK 使用 os.homedir() 存储会话文件，不是 projectPath
      const homeDir = os.homedir();
      const encodedPath = projectPath.replace(/\//g, '-');
      const sessionFile = path.join(homeDir, '.claude', 'projects', encodedPath, `${claudeSessionId}.jsonl`);
      if (!fs.existsSync(sessionFile)) {
        logger.warn(`[AgentRunner] Session file not found: ${sessionFile}, starting new session`);
        claudeSessionId = undefined;
        // 清理内存中的无效会话
        this.activeSessions.delete(sessionId);
        // 通知上层清理数据库中的无效 claudeSessionId（传 null 使数据库字段置空）
        if (this.onSessionIdUpdate) {
          this.onSessionIdUpdate(sessionId, '');
        }
      }
    }

    // PreCompact Hook - 在压缩开始时触发
    const preCompactHook = async () => {
      if (this.onCompactStart) {
        this.onCompactStart(sessionId);
      }
      return {};
    };

    // PreToolUse Hook - 工具执行前安全检查
    const preToolUseHook = async (input: any) => {
      const result = await canUseTool(input.tool_name, input.tool_input || {});
      if (result.behavior === 'deny') {
        // 使用 decision: 'block' 来拒绝工具执行
        return {
          decision: 'block' as const,
          reason: result.message
        };
      }
      return {};
    };

    const createQuery = (promptInput: string | MessageStream, resumeSessionId?: string) => {
      return query({
        prompt: promptInput,
        options: {
          cwd: projectPath,
          model: this.model,
          canUseTool,
          permissionMode: 'default',
          persistSession: true,
          hooks: {
            PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }],
            PreToolUse: [{ matcher: '.*', hooks: [preToolUseHook] }]
          },
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
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
    };

    return simpleRetry(async () => {
      let queryStream;
      if (images && images.length > 0) {
        logger.debug('[AgentRunner] Creating query with images, images:', images.length);
        logger.debug('[AgentRunner] Skipping resume for image message to avoid history conflict');
        const stream = new MessageStream();
        stream.push(prompt, images);
        stream.end();
        queryStream = createQuery(stream);
      } else {
        logger.debug('[AgentRunner] Creating query with text only, claudeSessionId:', initialClaudeSessionId);
        queryStream = createQuery(prompt, claudeSessionId);
      }
      this.activeStreams.set(sessionId, queryStream);
      return queryStream;
    }, 3);
  }

  async interrupt(sessionId: string): Promise<void> {
    const stream = this.activeStreams.get(sessionId);
    if (stream && 'interrupt' in stream && typeof (stream as any).interrupt === 'function') {
      await (stream as any).interrupt();
      this.activeStreams.delete(sessionId);
      logger.info(`[AgentRunner] Interrupted session: ${sessionId}`);
    }
  }

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
  }

  updateSessionId(sessionId: string, claudeSessionId: string): void {
    logger.info(`[AgentRunner] updateSessionId called: sessionId=${sessionId}, claudeSessionId=${claudeSessionId}`);
    this.activeSessions.set(sessionId, claudeSessionId);
    if (this.onSessionIdUpdate) {
      this.onSessionIdUpdate(sessionId, claudeSessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
  }
}
