import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';

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

export class StreamFlusher {
  private buffer = '';
  private activities: string[] = [];
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

  constructor(
    private send: (text: string, isFinal?: boolean) => Promise<void>,
    private interval = 4000,
    fileMarkerPattern?: RegExp,
    diagEnabled = false
  ) {
    this.fileMarkerPattern = fileMarkerPattern;
    this.diagEnabled = diagEnabled;
    this.instanceId = `F${++instanceCounter}`;
    if (this.diagEnabled) diag(this.instanceId, 'created', { interval });
  }

  addText(text: string) {
    this.buffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addText', { len: text.length, preview: text.substring(0, 60), bufLen: this.buffer.length, actCount: this.activities.length });
    this.scheduleFlush();
  }

  addTextBlock(text: string) {
    if (this.buffer && !this.buffer.endsWith('\n')) {
      this.buffer += '\n\n';
      this.allText += '\n\n';
    }
    this.buffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addTextBlock', { len: text.length, preview: text.substring(0, 60), bufLen: this.buffer.length });
    this.scheduleFlush();
  }

  addActivity(desc: string) {
    this.activities.push(desc);
    this.messageTimestamps.push(Date.now());
    if (this.diagEnabled) diag(this.instanceId, 'addActivity', { desc: desc.substring(0, 80), actCount: this.activities.length });
    this.scheduleFlush();
  }

  hasContent(): boolean {
    return this.buffer.length > 0 || this.activities.length > 0;
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
    if (this.timer) {
      if (this.diagEnabled) diag(this.instanceId, 'scheduleFlush:skip', { reason: 'timer_exists' });
      return;
    }

    let targetDelay: number;

    if (this.flushCount === 0) {
      targetDelay = 0;
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

  async flush(isFinal?: boolean) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    let output = '';
    if (this.activities.length > 0) {
      output += this.activities.join('\n') + '\n\n';
      this.activities = [];
    }
    if (this.buffer) {
      output += this.buffer;
      this.buffer = '';
    }

    if (output && this.fileMarkerPattern) {
      output = output.replace(this.fileMarkerPattern, '').trim();
    }

    if (this.diagEnabled) diag(this.instanceId, 'flush', { isFinal, outputLen: output.length, flushCount: this.flushCount, sinceLastFlush: Date.now() - this.lastFlush, preview: output.substring(0, 80) });

    if (output) {
      await this.send(output, isFinal);
      this.sentContent = true;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }
}