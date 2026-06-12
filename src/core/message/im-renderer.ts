import type { AgentEvent } from '../../agents/runner-types.js';
import type { ChannelAdapter, OutboundEnvelope, OutboundPayload, ReplyContext, ThoughtItem } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { summarizeToolInput } from '../permission.js';
import { CONTEXT_TOO_LONG_PATTERN, isContextTooLongText } from '../../utils/error-utils.js';
import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';

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

/**
 * IMRenderer — 统一出站投影器
 *
 * 替代 StreamFlusher（interactive 聚合）+ ThoughtEmitter（proactive 投影）两条路径。
 * Per-task 生命周期，由 MessageProcessor 在 processMessage 入口创建、出口销毁。
 *
 * 职责：
 * 1. 接收 AgentEvent 流，按 chatmode 投影为结构化 ThoughtItem
 * 2. interactive：聚合窗口内 items 打包为 activity.batch payload，flush 时统一 adapter.send
 * 3. proactive：逐事件转单条 activity.batch（items 长度 1）走 adapter.send
 * 4. 旁路 logger.event() 落盘 events.log
 *
 * 降级：channel 在 send() 内部处理（thought=true → 双发；thought=false → formatItemsAsText 走 sendMessage）
 */
export interface IMRendererOptions {
  adapter: ChannelAdapter;
  envelope: OutboundEnvelope;
  /** interactive 模式聚合窗口（毫秒） */
  flushDelay?: number;
  /** 是否抑制中间过程（activity）。true=抑制 */
  suppressActivities?: boolean;
  /** 文件标记 pattern，flush 时从文本中过滤 */
  fileMarkerPattern?: RegExp;
  /** 诊断日志开关 */
  diagEnabled?: boolean;
  /**
   * 出站发送回调 — 由 MessageProcessor 注入。
   * 封装了 background 检查 / firstReply 状态 / replyContext title 注入等业务逻辑。
   * IMRenderer 只构造 payload，发送时机/上下文由调用方决定。
   */
  send: (payload: OutboundPayload) => Promise<void>;
}

export class IMRenderer {
  private itemsQueue: ThoughtItem[] = [];
  private textBuffer = '';
  private timer?: NodeJS.Timeout;
  private lastFlush = Date.now();
  private allText = '';
  private sentContent = false;
  private flushCount = 0;
  private messageTimestamps: number[] = [];
  private instanceId: string;
  private diagEnabled: boolean;
  /** 串行发送队列：保证消息按序到达 */
  private sendChain: Promise<void> = Promise.resolve();
  /** proactive：是否已发过 text 文本（用于去重 complete.result） */
  private hasEmittedText = false;
  /** 自增 callId 兜底（runner 没提供时用） */
  private syntheticCallSeq = 0;

  constructor(private opts: IMRendererOptions) {
    this.diagEnabled = opts.diagEnabled ?? false;
    this.instanceId = `R${++instanceCounter}`;
    if (this.diagEnabled) {
      diag(this.instanceId, 'created', {
        chatmode: opts.envelope.chatmode,
        flushDelay: opts.flushDelay,
        suppress: opts.suppressActivities,
      });
    }
  }

  // ── 公开接口 ──

  /** 推入 AgentEvent，按 chatmode 投影 */
  emit(event: AgentEvent): void {
    try {
      logger.event({ source: 'runner', taskId: this.opts.envelope.taskId, channelId: this.opts.envelope.channelId, event });
    } catch {
      // logger.event 失败不影响业务
    }

    if (this.opts.envelope.chatmode === 'proactive') {
      this.emitProactive(event);
    }
    // interactive 模式由 MessageProcessor 显式调 addText/addToolCall/... 推入 items
  }

  /** 强制刷新所有 pending 事件 */
  async flush(isFinal?: boolean): Promise<void> {
    if (this.opts.envelope.chatmode === 'proactive') {
      // proactive 是 fire-and-forget，无 pending buffer
      return;
    }
    return this.flushInternal(isFinal);
  }

  /** 仅 flush activities，保留 textBuffer（用于中间 complete 事件） */
  async flushActivitiesOnly(): Promise<void> {
    if (this.opts.envelope.chatmode === 'proactive') return;
    return this.flushActivitiesInternal();
  }

  /** 是否有 pending 内容 */
  hasContent(): boolean {
    return this.textBuffer.length > 0 || this.itemsQueue.some(it => it.kind !== 'text');
  }

  /** 是否有待发送的文本 */
  hasTextPending(): boolean {
    return this.textBuffer.length > 0;
  }

  /** flush 当前 textBuffer 作为独立的 result.text（非 final），然后清空 buffer */
  async flushText(): Promise<void> {
    if (this.opts.envelope.chatmode === 'proactive') return;
    if (this.textBuffer.length === 0) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const text = this.textBuffer;
    this.textBuffer = '';
    // 清掉 itemsQueue 中的 text items（已发出）
    this.itemsQueue = this.itemsQueue.filter(it => it.kind !== 'text');

    const payload: OutboundPayload = { kind: 'result.text', text, isFinal: false };
    this.sentContent = true;
    this.sendChain = this.sendChain
      .then(() => this.opts.send(payload))
      .catch(e => logger.warn('[IMRenderer] flushText send failed:', e));
    await this.sendChain;
    this.lastFlush = Date.now();
    this.flushCount++;
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
    return this.textBuffer;
  }

  // ── 文本/活动注入（替代 StreamFlusher.addText/addActivity）──

  /** 添加文本片段（流式 text） */
  addText(text: string, outputTokens?: number, turn?: number): void {
    if (this.opts.envelope.chatmode === 'proactive') return;
    this.emitProgress('text', outputTokens, turn);
    if (!text) return;

    // 同一窗口内连续 text delta 合并到最后一个 text item
    const last = this.itemsQueue[this.itemsQueue.length - 1];
    if (last && last.kind === 'text') {
      last.text += text;
    } else {
      this.itemsQueue.push({ kind: 'text', text });
    }

    this.textBuffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) {
      diag(this.instanceId, 'addText', {
        len: text.length,
        preview: text.substring(0, 60),
        bufLen: this.textBuffer.length,
      });
    }
    this.scheduleFlush();
  }

  /** 添加工具调用 */
  addToolCall(name: string, input: Record<string, unknown> | undefined, callId?: string, descText?: string, turn?: number, outputTokens?: number): void {
    if (this.opts.envelope.chatmode === 'proactive') return;
    this.emitProgress('tool_call', outputTokens, turn, { toolName: name, callId });
    if (this.opts.suppressActivities) return;
    this.itemsQueue.push({
      kind: 'tool_call',
      call_id: callId || this.synthCallId(),
      name,
      arguments: input,
      text: descText,
    });
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addToolCall', { name, callId });
    this.scheduleFlush();
  }

  /** 添加工具结果 */
  addToolResult(name: string, ok: boolean, result?: unknown, error?: string, callId?: string, durationMs?: number, descText?: string): void {
    if (this.opts.envelope.chatmode === 'proactive') return;
    this.emitProgress('tool_result', undefined, undefined, { toolName: name, callId, ok, durationMs });
    if (this.opts.suppressActivities) return;
    this.itemsQueue.push({
      kind: 'tool_result',
      call_id: callId || this.synthCallId(),
      name,
      ok,
      ...(result !== undefined && { result }),
      ...(error !== undefined && { error }),
      ...(durationMs !== undefined && { duration_ms: durationMs }),
      ...(descText !== undefined && { text: descText }),
    });
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addToolResult', { name, ok, callId });
    this.scheduleFlush();
  }

  /** 添加进度提示 */
  addProgress(text: string, opts: { state?: 'processing' | 'waiting'; toolUses?: number; durationMs?: number } = {}): void {
    if (this.opts.envelope.chatmode === 'proactive') return;
    if (this.opts.suppressActivities) return;
    this.emitProgress('progress', undefined, undefined, {
      text,
      state: opts.state,
      toolUses: opts.toolUses,
      durationMs: opts.durationMs,
    });
  }

  /**
   * proactive 下放行为 thought 的 notice subtype 白名单——仅"真·终态错误"：
   * - context-too-long：上下文超限且无法 auto-compact，任务到此终止
   * - process-exit：Agent 子进程异常崩溃（无 complete 事件，emit 完全覆盖不到）
   * 二者都是用户必须知道、否则会困惑"任务为什么停了"的终态信号。
   *
   * 其余 subtype 一律不发：
   * - compact / runtime-error / task-error：emit() 路径（mapEventToItem）已投影，重复
   * - compact-start / compact-trigger / compact-retry / retry：内部机务噪音（压缩中/
   *   重试中/压缩完成），proactive 下用户要的是工作产出而非流水账，压缩后 thought 会
   *   继续输出，过程本身无需播报。
   */
  private static readonly PROACTIVE_NOTICE_ALLOW = new Set(['context-too-long', 'process-exit']);

  /** 添加系统提示 / 通知。force=true 时绕过 suppressActivities（用于 compact/retry/error 等操作反馈） */
  addNotice(text: string, severity: 'info' | 'warn', subtype?: string, force = false): void {
    // proactive 模式：只放行真·终态错误，机务噪音（压缩/重试）和 emit 已覆盖的 subtype 均不发。
    if (this.opts.envelope.chatmode === 'proactive') {
      if (subtype == null || !IMRenderer.PROACTIVE_NOTICE_ALLOW.has(subtype)) return;
      this.emitProactiveItem({ kind: 'notice', text, severity, subtype });
      return;
    }
    if (this.opts.suppressActivities && !force) return;
    this.itemsQueue.push({ kind: 'notice', text, severity, subtype });
    this.messageTimestamps.push(Date.now());
    this.scheduleFlush();
  }

  // ── 内部：interactive 模式聚合窗口 ──

  private synthCallId(): string {
    return `synth-${this.opts.envelope.taskId}-${++this.syntheticCallSeq}`;
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
    const dynamicDelay = avgInterval * 3;
    const minDelay = interval;
    const maxDelay = interval * 2.5;
    return Math.max(minDelay, Math.min(maxDelay, dynamicDelay));
  }

  /** 仅 flush 非 text items（text items 和 textBuffer 保留，等待下次完整 flush） */
  private async flushActivitiesInternal(): Promise<void> {
    const nonThinking = this.itemsQueue.filter(it => it.kind !== 'text');
    if (nonThinking.length === 0) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // 移除已 flush 的 non-text items，保留 text items
    this.itemsQueue = this.itemsQueue.filter(it => it.kind === 'text');

    const payload: OutboundPayload = { kind: 'activity.batch', items: nonThinking };
    if (this.diagEnabled) diag(this.instanceId, 'flushActivitiesOnly', { itemCount: nonThinking.length });

    this.sentContent = true;
    this.sendChain = this.sendChain
      .then(() => this.opts.send(payload))
      .catch(e => logger.warn('[IMRenderer] activity.batch send failed:', e));
    await this.sendChain;
    this.lastFlush = Date.now();
    this.flushCount++;
  }

  /**
   * 完整 flush：把 itemsQueue 里所有 items 打包成 activity.batch 发送。
   * 如果 isFinal=true，还会在 batch 之后单独发一条 result.text 作为最终回复。
   */
  private async flushInternal(isFinal?: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (isFinal) {
      // 上下文错误短语过滤：剔除错误关键词本身，保留前后内容。
      // 只在最终 flush 清理，避免中间定时 flush trim 掉 Markdown 块级换行。
      const ctxErrPattern = new RegExp(CONTEXT_TOO_LONG_PATTERN.source, 'gi');
      const stripCtxErr = (s: string) => s.replace(ctxErrPattern, '').trim();
      this.textBuffer = stripCtxErr(this.textBuffer);
      this.allText = stripCtxErr(this.allText);
      for (const item of this.itemsQueue) {
        if (item.kind === 'text') item.text = stripCtxErr(item.text);
      }

      // 文件标记过滤
      if (this.opts.fileMarkerPattern) {
        this.textBuffer = this.textBuffer.replace(this.opts.fileMarkerPattern, '').trim();
        for (const item of this.itemsQueue) {
          if (item.kind === 'text') item.text = item.text.replace(this.opts.fileMarkerPattern, '');
        }
      }
    }

    // 清掉空 text items
    const items = this.itemsQueue.filter(it => {
      if (it.kind === 'text') return it.text.length > 0;
      return true;
    });

    this.itemsQueue = [];

    const finalText = isFinal ? this.textBuffer : '';
    if (isFinal) this.textBuffer = '';

    if (this.diagEnabled) {
      diag(this.instanceId, 'flush', {
        isFinal,
        itemCount: items.length,
        finalTextLen: finalText.length,
        flushCount: this.flushCount,
        sinceLastFlush: Date.now() - this.lastFlush,
      });
    }

    // 1. interactive 模式下：不发 text items（由 result.text 统一发送最终文本）
    let itemsForBatch = items.filter(it => it.kind !== 'text');

    if (itemsForBatch.length > 0) {
      const payload: OutboundPayload = { kind: 'activity.batch', items: itemsForBatch };
      this.sentContent = true;
      this.sendChain = this.sendChain
        .then(() => this.opts.send(payload))
        .catch(e => logger.warn('[IMRenderer] activity.batch send failed:', e));
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }

    // 1.5 非最终定时 flush：把已累积的文本块作为独立 result.text 发出。
    //   每个 text 事件本身是完整语义块（runner 已合并流式 delta），工具调用前的
    //   文本一向作为独立气泡发送（见 message-processor 的 flushText 调用）。
    //   这里补上「文本块后面没有紧跟 tool_use」的情况——例如 readonly 拒绝写文件时
    //   SDK 直接拒绝、不产生 tool_use 事件，文本会一直滞留 buffer，直到下一个
    //   tool_use 才被 flushText 带出，并与其后的文本合并成一条（用户侧表现为：
    //   第一条文本等待一分多钟后才和第二条凑成一条发出）。定时器到期即发，根除滞留。
    if (!isFinal && this.textBuffer.length > 0) {
      const text = this.textBuffer;
      this.textBuffer = '';
      const payload: OutboundPayload = { kind: 'result.text', text, isFinal: false };
      this.sentContent = true;
      this.sendChain = this.sendChain
        .then(() => this.opts.send(payload))
        .catch(e => logger.warn('[IMRenderer] timed result.text send failed:', e));
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }

    // 2. isFinal=true 时单独发最终回复文本
    if (isFinal && finalText.length > 0) {
      const payload: OutboundPayload = { kind: 'result.text', text: finalText, isFinal: true };
      this.sentContent = true;
      this.sendChain = this.sendChain
        .then(() => this.opts.send(payload))
        .catch(e => logger.warn('[IMRenderer] result.text send failed:', e));
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }

  // ── 内部：status.progress 发送 ──

  private emitProgress(
    activityType: 'text' | 'tool_call' | 'tool_result' | 'progress',
    outputTokens?: number,
    turn?: number,
    extra?: { toolName?: string; callId?: string; ok?: boolean; durationMs?: number; text?: string; state?: 'processing' | 'waiting'; toolUses?: number },
  ): void {
    const payload: OutboundPayload = {
      kind: 'status.progress',
      metadata: {
        activityType,
        ...(turn != null && { turn }),
        ...(outputTokens != null && { outputTokens }),
        ...(extra?.toolName != null && { toolName: extra.toolName }),
        ...(extra?.callId != null && { callId: extra.callId }),
        ...(extra?.ok != null && { ok: extra.ok }),
        ...(extra?.durationMs != null && { durationMs: extra.durationMs }),
        ...(extra?.text != null && { text: extra.text }),
        ...(extra?.state != null && { state: extra.state }),
        ...(extra?.toolUses != null && { toolUses: extra.toolUses }),
      },
    };
    this.opts.send(payload).catch(() => {});
  }

  // ── 内部：proactive 模式（逐事件 activity.batch[1 item]） ──

  private emitProactive(event: AgentEvent): void {
    // 对齐 interactive 的 dedup：流式 text 已推过时，complete.result 不再重复发 summary
    if (
      event.type === 'complete' &&
      !event.isError &&
      event.result &&
      this.hasEmittedText
    ) {
      return;
    }

    const item = this.mapEventToItem(event);
    if (!item) return;

    if (item.kind === 'text') {
      this.hasEmittedText = true;
      this.allText += item.text;
    }

    // proactive 模式：status.progress 是 interactive 的处理状态指示器，proactive 下
    // 过程由 thought（activity.batch）表达，不再发 status.progress（与 addProgress 在
    // proactive 下的拦截保持一致）。progress-kind item 若进 activity.batch 会被 aun 侧
    // 回转成 status.progress（见 aun.ts 'activity.batch' 分支），故直接丢弃。
    // 终态 status（started/completed/interrupted/error）由 message-processor 发送，不受影响。
    if (item.kind === 'progress') {
      return;
    }

    this.emitProactiveItem(item);
  }

  /** proactive 模式逐条投影：单个 ThoughtItem 包成 activity.batch[1] 发出（fire-and-forget）。 */
  private emitProactiveItem(item: ThoughtItem): void {
    const payload: OutboundPayload = { kind: 'activity.batch', items: [item] };
    this.opts.send(payload).catch(err => {
      logger.debug(`[IMRenderer] proactive send failed: ${(err as Error).message}`);
    });
  }

  private mapEventToItem(event: AgentEvent): ThoughtItem | null {
    switch (event.type) {
      case 'text':
        if (!event.text) return null;
        return { kind: 'text', text: event.text };

      case 'tool_use': {
        const desc = summarizeToolInput(event.name, event.input || {});
        return {
          kind: 'tool_call',
          call_id: event.callId || this.synthCallId(),
          name: event.name,
          arguments: event.input,
          text: desc,
        };
      }

      case 'tool_result':
        if (event.isError) {
          return {
            kind: 'tool_result',
            call_id: event.callId || this.synthCallId(),
            name: event.name,
            ok: false,
            error: event.error || (typeof event.result === 'string' ? event.result : '执行失败'),
          };
        } else {
          const resultText = this.truncate(this.stringifyResult(event.result), 200);
          return {
            kind: 'tool_result',
            call_id: event.callId || this.synthCallId(),
            name: event.name,
            ok: true,
            result: event.result,
            text: resultText,
          };
        }

      case 'compact':
        return {
          kind: 'notice',
          text: `💡 会话压缩完成 (压缩前 tokens: ${event.preTokens})`,
          severity: 'info',
          subtype: 'compact',
        };

      case 'task_progress': {
        const stats = this.formatTaskStats(event);
        const text = event.summary
          ? `子任务: ${event.summary}${stats ? ` (${stats})` : ''}`
          : `子任务进行中${stats ? `: ${stats}` : ''}`;
        return {
          kind: 'progress',
          text,
          state: 'processing',
          tool_uses: event.toolUses,
          duration_ms: event.durationMs,
        };
      }

      case 'error': {
        // 上下文过长错误不输出（留给外层 auto-compact 处理）
        if (isContextTooLongText(event.error || '')) return null;
        return { kind: 'notice', text: event.error, severity: 'warn' };
      }

      case 'complete': {
        // 上下文过长错误不输出（留给外层 auto-compact 处理）
        const hasContextError = event.terminalReason === 'prompt_too_long'
          || isContextTooLongText(event.errors?.join(' ') || '')
          || isContextTooLongText(event.result || '');
        if (event.isError && hasContextError) {
          return null;
        }
        if (event.isError) {
          const errText = event.errors?.join('; ') || event.result || '任务失败';
          return {
            kind: 'summary',
            text: errText,
            is_error: true,
            subtype: event.subtype,
            duration_ms: event.durationMs,
          };
        }
        if (event.result) {
          return {
            kind: 'summary',
            text: event.result,
            subtype: event.subtype,
            duration_ms: event.durationMs,
          };
        }
        return null;
      }

      case 'session_id':
      case 'state_changed':
      case 'status':
        return null;

      default:
        return null;
    }
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
