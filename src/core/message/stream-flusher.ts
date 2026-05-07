import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';

// 诊断日志（按需启用，通过 config.debug.flusherDiag 控制）
let diagStream: fs.WriteStream | null = null;
function getDiagStream(): fs.WriteStream {
  if (!diagStream) {
    const logDir = resolvePaths().logs;
    diagStream = fs.createWriteStream(path.join(logDir, 'flusher-diag.log'), { flags: 'a' });
  }
  return diagStream;
}

function diag(instanceId: string, action: string, meta: Record<string, any> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), id: instanceId, action, ...meta });
  getDiagStream().write(line + '\n');
}

/**
 * 流式输出缓冲器
 * 按时间窗口批量推送文本和活动事件
 *
 * 延迟策略：
 * - 第1次：立即发送（0ms）
 * - 第2-4次：半延迟（interval / 2）
 * - 第5次起：动态自适应延迟
 *   - 计算最近10条消息的平均间隔
 *   - 动态延迟 = 平均间隔 * 3
 *   - 下限：interval（额定值）
 *   - 上限：interval * 2.5
 */
let instanceCounter = 0;

type QueueEntry = { kind: 'activity'; text: string } | { kind: 'text' };

export class StreamFlusher {
  private buffer = '';
  private queue: QueueEntry[] = [];  // 按入队顺序记录 activity 和 text 段
  private timer?: NodeJS.Timeout;
  private lastFlush = Date.now();
  private allText = '';
  private sentContent = false;
  private fileMarkerPattern?: RegExp;
  private flushCount = 0;
  private messageTimestamps: number[] = [];
  private instanceId: string;
  private createTime = Date.now();
  private diagEnabled: boolean;
  private sendChain: Promise<void> = Promise.resolve();  // 串行发送队列，保证消息按序到达

  constructor(
    private send: (text: string, isFinal?: boolean, hasText?: boolean) => Promise<void>,
    private interval = 4000,
    fileMarkerPattern?: RegExp,
    diagEnabled = false,
    private silent = false
  ) {
    this.fileMarkerPattern = fileMarkerPattern;
    this.diagEnabled = diagEnabled;
    this.instanceId = `F${++instanceCounter}`;
    if (this.diagEnabled) diag(this.instanceId, 'created', { interval, silent });
  }

  addText(text: string) {
    if (this.buffer.length === 0 && text.length > 0) {
      this.queue.push({ kind: 'text' });
    }
    this.buffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addText', { len: text.length, preview: text.substring(0, 60), bufLen: this.buffer.length, queueLen: this.queue.length });
    this.scheduleFlush();
  }

  addTextBlock(text: string) {
    if (this.buffer && !this.buffer.endsWith('\n')) {
      this.buffer += '\n\n';
      this.allText += '\n\n';
    }
    this.buffer += text;
    this.allText += text;
    this.queue.push({ kind: 'text' });
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addTextBlock', { len: text.length, preview: text.substring(0, 60), bufLen: this.buffer.length });
    this.scheduleFlush();
  }

  addActivity(desc: string) {
    this.queue.push({ kind: 'activity', text: desc });
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addActivity', { desc: desc.substring(0, 80), queueLen: this.queue.length });
    this.scheduleFlush();
  }

  hasContent(): boolean {
    return this.buffer.length > 0 || this.queue.some(e => e.kind === 'activity');
  }

  hasSentContent(): boolean {
    return this.sentContent;
  }

  getFinalText(): string {
    return this.allText;
  }

  getRemainingText(): string {
    return this.buffer;
  }

  stripFromBuffer(pattern: RegExp) {
    this.buffer = this.buffer.replace(pattern, '').trim();
  }

  private scheduleFlush() {
    if (this.silent) return;  // proactive 模式：不调度发送
    if (this.timer) {
      if (this.diagEnabled) diag(this.instanceId, 'scheduleFlush:skip', { reason: 'timer_exists' });
      return;
    }

    let targetDelay: number;

    if (this.flushCount === 0) {
      targetDelay = 500;
    } else if (this.flushCount <= 3) {
      targetDelay = Math.ceil(this.interval / 2);
    } else if (this.messageTimestamps.length >= 5) {
      targetDelay = this.calculateDynamicDelay();
    } else {
      targetDelay = this.interval;
    }

    const elapsed = Date.now() - this.lastFlush;
    const delay = Math.max(0, targetDelay - elapsed);
    if (this.diagEnabled) diag(this.instanceId, 'scheduleFlush:set', { flushCount: this.flushCount, targetDelay, elapsed, actualDelay: delay });
    this.timer = setTimeout(() => this.flush(), delay);
  }

  private calculateDynamicDelay(): number {
    const recent = this.messageTimestamps.slice(-10);
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i] - recent[i - 1]);
    }
    if (intervals.length === 0) return this.interval;

    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
    let dynamicDelay = avgInterval * 3;
    const minDelay = this.interval;
    const maxDelay = this.interval * 2.5;
    return Math.max(minDelay, Math.min(maxDelay, dynamicDelay));
  }

  /**
   * 只 flush activities，保留 text buffer 不动
   * 用于 complete 事件前清空 pending activities，让最终文本留给 flush(true) 发送
   */
  async flushActivitiesOnly() {
    if (this.silent) return;
    const hasActivities = this.queue.some(e => e.kind === 'activity');
    if (!hasActivities) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // 只取 activity 条目，保留 text 条目在 queue 中
    const activities = this.queue.filter(e => e.kind === 'activity') as { kind: 'activity'; text: string }[];
    this.queue = this.queue.filter(e => e.kind === 'text');

    let output = activities.map(e => e.text).join('\n') + '\n\n';

    if (output && this.fileMarkerPattern) {
      output = output.replace(this.fileMarkerPattern, '').trim();
    }

    if (this.diagEnabled) diag(this.instanceId, 'flushActivitiesOnly', { outputLen: output.length });

    if (output) {
      this.sentContent = true;  // 同步标记，避免 timer flush 未 await 时的竞态
      const text = output;
      // chain 保持不断裂：单条失败不阻塞后续（catch → resolve）
      this.sendChain = this.sendChain
        .then(() => this.send(text, false, false))
        .catch(e => { logger.warn('[StreamFlusher] send failed:', e); });
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }

  async flush(isFinal?: boolean) {
    if (this.silent) {
      // 清理内部状态，避免后续误用
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      this.queue = [];
      this.buffer = '';
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    let output = '';
    const hasText = this.buffer.length > 0;

    // 按入队顺序合并：遇到 text 条目时插入 buffer 内容，遇到 activity 直接追加
    let textInserted = false;
    for (const entry of this.queue) {
      if (entry.kind === 'activity') {
        // 确保 activity 前有换行分隔（text 末尾可能没有换行）
        if (output && !output.endsWith('\n')) output += '\n';
        output += entry.text + '\n';
      } else if (!textInserted) {
        if (output) output += output.endsWith('\n') ? '\n' : '\n\n';
        output += this.buffer;
        textInserted = true;
      }
    }
    // 如果 queue 为空但有 buffer（纯文本情况）
    if (!textInserted && hasText) {
      output += this.buffer;
    }

    this.queue = [];
    this.buffer = '';

    if (output && this.fileMarkerPattern) {
      output = output.replace(this.fileMarkerPattern, '').trim();
    }

    if (this.diagEnabled) diag(this.instanceId, 'flush', { isFinal, outputLen: output.length, flushCount: this.flushCount, sinceLastFlush: Date.now() - this.lastFlush, preview: output.substring(0, 80) });

    if (output) {
      this.sentContent = true;  // 同步标记，避免 timer flush 未 await 时的竞态
      const text = output;
      const final = isFinal;
      const ht = hasText;
      this.sendChain = this.sendChain
        .then(() => this.send(text, final, ht))
        .catch(e => { logger.warn('[StreamFlusher] send failed:', e); });
      await this.sendChain;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }
}