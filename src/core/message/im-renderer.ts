import type { AgentEvent } from '../../agents/claude-runner.js';
import type { ChannelAdapter, ReplyContext } from '../../types.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';

// 诊断日志（沿用 stream-flusher.ts 的诊断模式，受 config.debug.flusherDiag 控制）
let diagStream: fs.WriteStream | null = null;
function getDiagStream(): fs.WriteStream {
  if (!diagStream) {
    const logDir = resolvePaths().logs;
    diagStream = fs.createWriteStream(path.join(logDir, 'im-renderer-diag.log'), { flags: 'a' });
  }
  return diagStream;
}

function diag(instanceId: string, action: string, meta: Record<string, any> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), id: instanceId, action, ...meta });
  getDiagStream().write(line + '\n');
}

let instanceCounter = 0;

type QueueEntry = { kind: 'activity'; text: string } | { kind: 'text' };

/**
 * IMRenderer — 统一出站投影器
 *
 * 替代 StreamFlusher（interactive 聚合）+ ThoughtEmitter（proactive 投影）两条路径。
 * Per-task 生命周期，由 MessageProcessor 在 processMessage 入口创建、出口销毁。
 *
 * 职责：
 * 1. 接收 AgentEvent 流（来自 runner）
 * 2. 按 chatmode + showActivities 决定投影/抑制/聚合
 *    - interactive：聚合窗口 → adapter.sendText（复用 flusher 的延迟自适应算法）
 *    - proactive：逐事件 → adapter.putThought（fire-and-forget）
 * 3. 旁路 logger.event() 落盘 events.log（Phase 2 接通）
 *
 * Phase 2 实现：内部仍调用旧 adapter 方法（sendText / putThought / addActivity）。
 * Phase 3 切换到 adapter.send(envelope, payload) 统一入口。
 */
export interface IMRendererOptions {
  adapter: ChannelAdapter;
  channelId: string;
  taskId: string;
  chatmode: 'interactive' | 'proactive';
  replyContext?: ReplyContext;
  /** interactive 模式聚合窗口（毫秒） */
  flushDelay?: number;
  /** 是否抑制中间过程（activity）。true=抑制 */
  suppressActivities?: boolean;
  /** 文件标记 pattern，flush 时从文本中过滤 */
  fileMarkerPattern?: RegExp;
  /** 诊断日志开关 */
  diagEnabled?: boolean;
  /** sendText 回调 — 由 MessageProcessor 注入（封装 replyContext / firstReply / background 检查） */
  sendText: (text: string, isFinal: boolean, hasText: boolean) => Promise<void>;
}

export class IMRenderer {
  private buffer = '';
  private queue: QueueEntry[] = [];
  private timer?: NodeJS.Timeout;
  private lastFlush = Date.now();
  private allText = '';
  private sentContent = false;
  private flushCount = 0;
  private messageTimestamps: number[] = [];
  private instanceId: string;
  private diagEnabled: boolean;
  /** 串行发送队列：保证消息按序到达（继承 StreamFlusher 的 sendChain 设计） */
  private sendChain: Promise<void> = Promise.resolve();
  /** proactive：是否已发过 thinking 文本（用于去重 complete.result） */
  private hasEmittedThinking = false;

  constructor(private opts: IMRendererOptions) {
    this.diagEnabled = opts.diagEnabled ?? false;
    this.instanceId = `R${++instanceCounter}`;
    if (this.diagEnabled) {
      diag(this.instanceId, 'created', {
        chatmode: opts.chatmode,
        flushDelay: opts.flushDelay,
        suppress: opts.suppressActivities,
      });
    }
  }

  // ── 公开接口 ──

  /** 推入 AgentEvent，按 chatmode 投影 */
  emit(event: AgentEvent): void {
    // events.log 旁路（Phase 2 接通）— 任何 chatmode 都落盘
    try {
      logger.event({ source: 'runner', taskId: this.opts.taskId, channelId: this.opts.channelId, event });
    } catch {
      // logger.event 失败不影响业务
    }

    if (this.opts.chatmode === 'proactive') {
      this.emitProactive(event);
    } else {
      this.emitInteractive(event);
    }
  }

  /** 强制刷新所有 pending 事件 */
  async flush(isFinal?: boolean): Promise<void> {
    if (this.opts.chatmode === 'proactive') {
      // proactive 是 fire-and-forget，无 pending buffer
      return;
    }
    return this.flushInternal(isFinal);
  }

  /** 仅 flush activities，保留 text buffer（用于中间 complete 事件） */
  async flushActivitiesOnly(): Promise<void> {
    if (this.opts.chatmode === 'proactive') return;
    return this.flushActivitiesInternal();
  }

  /** 是否有 pending 内容 */
  hasContent(): boolean {
    return this.buffer.length > 0 || this.queue.some(e => e.kind === 'activity');
  }

  /** 是否已发送过内容（用于决定最终 flush 是否带 isFinal 标题） */
  hasSentContent(): boolean {
    return this.sentContent;
  }

  /** 累积的全部文本（流式 + 最终） */
  getFinalText(): string {
    return this.allText;
  }

  /** 当前 buffer 中尚未 flush 的文本 */
  getRemainingText(): string {
    return this.buffer;
  }

  /** 从 buffer 中移除指定 pattern（用于文件标记预处理） */
  stripFromBuffer(pattern: RegExp): void {
    this.buffer = this.buffer.replace(pattern, '').trim();
  }

  // ── 文本/活动注入（替代 StreamFlusher.addText/addActivity）──

  /** 添加文本片段（流式 text） */
  addText(text: string): void {
    if (this.opts.chatmode === 'proactive') return; // proactive 走 emit() 路径
    if (this.buffer.length === 0 && text.length > 0) {
      this.queue.push({ kind: 'text' });
    }
    this.buffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) {
      diag(this.instanceId, 'addText', {
        len: text.length,
        preview: text.substring(0, 60),
        bufLen: this.buffer.length,
      });
    }
    this.scheduleFlush();
  }

  /** 添加活动事件（tool_use / tool_result / error / compact 等） */
  addActivity(desc: string): void {
    if (this.opts.chatmode === 'proactive') return;
    if (this.opts.suppressActivities) return;
    this.queue.push({ kind: 'activity', text: desc });
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) {
      diag(this.instanceId, 'addActivity', { desc: desc.substring(0, 80), queueLen: this.queue.length });
    }
    this.scheduleFlush();
  }

  // ── 内部：interactive 模式（聚合窗口） ──

  private emitInteractive(event: AgentEvent): void {
    // interactive 模式由调用方（message-processor）显式调 addText/addActivity，
    // emit() 在 interactive 下不做事件 → 文本/活动转换。
    // 这是为了与现有 message-processor 的复杂分支逻辑（hasErrorResult、suppress、complete handling）
    // 保持兼容——message-processor 仍是事件分发器，IMRenderer 是聚合/投影器。
    // Phase 3 重构时再把所有事件转换逻辑搬入 emitInteractive。
  }

  private scheduleFlush(): void {
    if (this.timer) {
      if (this.diagEnabled) diag(this.instanceId, 'scheduleFlush:skip', { reason: 'timer_exists' });
      return;
    }

    const interval = this.opts.flushDelay ?? 4000;
    let targetDelay: number;

    if (this.flushCount === 0) {
      targetDelay = 500;
    } else if (this.flushCount <= 3) {
      targetDelay = Math.ceil(interval / 2);
    } else if (this.messageTimestamps.length >= 5) {
      targetDelay = this.calculateDynamicDelay(interval);
    } else {
      targetDelay = interval;
    }

    const elapsed = Date.now() - this.lastFlush;
    const delay = Math.max(0, targetDelay - elapsed);
    if (this.diagEnabled) {
      diag(this.instanceId, 'scheduleFlush:set', {
        flushCount: this.flushCount,
        targetDelay,
        elapsed,
        actualDelay: delay,
      });
    }
    this.timer = setTimeout(() => this.flushInternal(), delay);
  }

  private calculateDynamicDelay(interval: number): number {
    const recent = this.messageTimestamps.slice(-10);
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i] - recent[i - 1]);
    }
    if (intervals.length === 0) return interval;

    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
    let dynamicDelay = avgInterval * 3;
    const minDelay = interval;
    const maxDelay = interval * 2.5;
    return Math.max(minDelay, Math.min(maxDelay, dynamicDelay));
  }

  private async flushActivitiesInternal(): Promise<void> {
    const hasActivities = this.queue.some(e => e.kind === 'activity');
    if (!hasActivities) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const activities = this.queue.filter(e => e.kind === 'activity') as { kind: 'activity'; text: string }[];
    this.queue = this.queue.filter(e => e.kind === 'text');

    let output = activities.map(e => e.text).join('\n') + '\n\n';

    if (output && this.opts.fileMarkerPattern) {
      output = output.replace(this.opts.fileMarkerPattern, '').trim();
    }

    if (this.diagEnabled) {
      diag(this.instanceId, 'flushActivitiesOnly', { outputLen: output.length });
    }

    if (output) {
      this.sentContent = true;
      const text = output;
      this.sendChain = this.sendChain
        .then(() => this.opts.sendText(text, false, false))
        .catch(e => {
          logger.warn('[IMRenderer] send failed:', e);
        });
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }

  private async flushInternal(isFinal?: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    let output = '';
    const hasText = this.buffer.length > 0;

    // 按入队顺序合并：activity 直接追加，text 条目处插入 buffer 内容
    let textInserted = false;
    for (const entry of this.queue) {
      if (entry.kind === 'activity') {
        if (output && !output.endsWith('\n')) output += '\n';
        output += entry.text + '\n';
      } else if (!textInserted) {
        if (output) output += output.endsWith('\n') ? '\n' : '\n\n';
        output += this.buffer;
        textInserted = true;
      }
    }
    if (!textInserted && hasText) {
      output += this.buffer;
    }

    this.queue = [];
    this.buffer = '';

    if (output && this.opts.fileMarkerPattern) {
      output = output.replace(this.opts.fileMarkerPattern, '').trim();
    }

    if (this.diagEnabled) {
      diag(this.instanceId, 'flush', {
        isFinal,
        outputLen: output.length,
        flushCount: this.flushCount,
        sinceLastFlush: Date.now() - this.lastFlush,
        preview: output.substring(0, 80),
      });
    }

    if (output) {
      this.sentContent = true;
      const text = output;
      const final = !!isFinal;
      const ht = hasText;
      this.sendChain = this.sendChain
        .then(() => this.opts.sendText(text, final, ht))
        .catch(e => {
          logger.warn('[IMRenderer] send failed:', e);
        });
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }

  // ── 内部：proactive 模式（逐事件 putThought） ──

  private emitProactive(event: AgentEvent): void {
    // 对齐 interactive 的 dedup：流式 text 已推过时，complete.result 不再重复发 summary
    if (
      event.type === 'complete' &&
      !event.isError &&
      event.result &&
      this.hasEmittedThinking
    ) {
      return;
    }

    const payload = this.mapEventToPayload(event);
    if (!payload) return;
    if (!this.opts.adapter.putThought) return;

    if (payload.stage === 'thinking') {
      this.hasEmittedThinking = true;
    }

    // payload 也带上 task_id / chatmode（与 message.send/group.send 对齐）
    (payload as any).task_id = this.opts.taskId;
    (payload as any).chatmode = this.opts.chatmode;

    // fire-and-forget
    this.opts.adapter
      .putThought(this.opts.channelId, this.opts.taskId, payload, this.opts.replyContext)
      .catch(err => {
        logger.debug(`[IMRenderer] putThought failed: ${(err as Error).message}`);
      });
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

interface ThoughtPayload {
  type: 'thought';
  text: string;
  stage: string;
  format?: string;
  metadata?: Record<string, any>;
  task_id?: string;
  chatmode?: string;
}
