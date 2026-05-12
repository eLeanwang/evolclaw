import type { AgentEvent } from '../../agents/claude-runner.js';
import type { ChannelAdapter } from '../../types.js';
import { logger } from '../../utils/logger.js';

interface ThoughtPayload {
  type: 'thought';
  text: string;
  stage: string;
  format?: string;
  metadata?: Record<string, any>;
  task_id?: string;
  chatmode?: string;
}

/**
 * ThoughtEmitter — 将 Proactive 模式下的流式 AgentEvent 实时发送为 thought
 *
 * 设计特点：
 * - 不做聚合/batching，逐事件调用 adapter.putThought()
 * - 不感知 group vs P2P，通道差异由 adapter 内部处理
 * - taskId 映射为 context: { type: 'task', id: taskId }（协议 selector）
 *   同时写入 payload.task_id / payload.chatmode，与 message.send/group.send 保持一致
 * - fire-and-forget：调用方不 await emit()，错误被内部捕获
 */
export class ThoughtEmitter {
  private adapter: ChannelAdapter;
  private channelId: string;
  private taskId: string;
  private chatmode: string;
  private hasEmittedText = false;

  constructor(adapter: ChannelAdapter, channelId: string, taskId: string, chatmode: string = 'proactive') {
    if (!taskId) {
      throw new Error('[ThoughtEmitter] taskId is required at construction');
    }
    this.adapter = adapter;
    this.channelId = channelId;
    this.taskId = taskId;
    this.chatmode = chatmode;
  }

  async emit(event: AgentEvent): Promise<void> {
    // 对齐 interactive 的 dedup：流式 text 已推过时，complete.result 不再重复发 summary
    if (
      event.type === 'complete' &&
      !event.isError &&
      event.result &&
      this.hasEmittedText
    ) {
      return;
    }

    const payload = this.mapEventToPayload(event);
    if (!payload) return;
    if (!this.adapter.putThought) return;

    if (payload.stage === 'thinking') {
      this.hasEmittedText = true;
    }

    // payload 也带上 task_id / chatmode（与 message.send/group.send 对齐）
    payload.task_id = this.taskId;
    payload.chatmode = this.chatmode;

    try {
      await this.adapter.putThought(this.channelId, this.taskId, payload);
    } catch (err) {
      logger.debug(`[ThoughtEmitter] putThought failed: ${(err as Error).message}`);
    }
  }

  private mapEventToPayload(event: AgentEvent): ThoughtPayload | null {
    switch (event.type) {
      case 'text':
        if (!event.text) return null;
        return { type: 'thought', text: event.text, stage: 'thinking' };

      case 'tool_use': {
        const desc = this.summarizeInput(event.input, event.name);
        return {
          type: 'thought',
          text: desc ? `🔧 ${event.name}: ${desc}` : `🔧 ${event.name}`,
          stage: 'tool',
          metadata: { tool: event.name, input: desc },
        };
      }

      case 'tool_result':
        if (event.isError) {
          return {
            type: 'thought',
            text: `⚠️ ${event.name}: ${event.error || '执行失败'}`,
            stage: 'tool',
            metadata: { tool: event.name, ok: false },
          };
        }
        {
          const resultText = this.truncate(this.stringifyResult(event.result), 200);
          return {
            type: 'thought',
            text: resultText ? `✅ ${event.name}: ${resultText}` : `✅ ${event.name}`,
            stage: 'tool',
            metadata: { tool: event.name, ok: true },
          };
        }

      case 'compact':
        return {
          type: 'thought',
          text: `💡 会话压缩完成 (压缩前 tokens: ${event.preTokens})`,
          stage: 'system',
        };

      case 'task_progress': {
        const stats = this.formatTaskStats(event);
        const text = event.summary
          ? `⏳ 子任务: ${event.summary}${stats ? ` (${stats})` : ''}`
          : `⏳ 子任务进行中${stats ? `: ${stats}` : ''}`;
        return { type: 'thought', text, stage: 'planning' };
      }

      case 'error':
        return { type: 'thought', text: `❌ ${event.error}`, stage: 'error' };

      case 'complete':
        if (event.isError) {
          const errText = event.errors?.join('; ') || event.result || '任务失败';
          return { type: 'thought', text: `❌ ${errText}`, stage: 'error' };
        }
        if (event.result) {
          return { type: 'thought', text: event.result, stage: 'summary' };
        }
        return null;

      case 'session_id':
      case 'state_changed':
      case 'status':
        return null;

      default:
        return null;
    }
  }

  private summarizeInput(input: any, toolName?: string): string {
    if (!input || typeof input !== 'object') return '';
    // Bash + ctl send/file: 显示完整命令内容（含发送的消息正文）
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command;
      if (cmd.includes('evolclaw ctl send') || cmd.includes('evolclaw ctl file')) {
        return cmd;
      }
    }
    return (
      input.description ||
      input.file_path ||
      input.pattern ||
      (typeof input.command === 'string' ? input.command.substring(0, 80) : '') ||
      (typeof input.prompt === 'string' ? input.prompt.substring(0, 80) : '') ||
      (typeof input.query === 'string' ? input.query.substring(0, 80) : '') ||
      ''
    );
  }

  private stringifyResult(result: any): string {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  private formatTaskStats(event: { toolUses?: number; durationMs?: number }): string {
    const parts: string[] = [];
    if (event.toolUses) parts.push(`${event.toolUses} tools`);
    if (event.durationMs) parts.push(`${Math.round(event.durationMs / 1000)}s`);
    return parts.join(', ');
  }
}
