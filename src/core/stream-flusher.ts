/**
 * 流式输出缓冲器
 * 按时间窗口批量推送文本和活动事件
 */
export class StreamFlusher {
  private buffer = '';
  private activities: string[] = [];
  private timer?: NodeJS.Timeout;
  private lastFlush = Date.now();
  private allText = '';
  private sentContent = false;
  private fileMarkerPattern?: RegExp;
  private flushCount = 0;

  constructor(
    private send: (text: string) => Promise<void>,
    private interval = 3000,
    fileMarkerPattern?: RegExp
  ) {
    this.fileMarkerPattern = fileMarkerPattern;
  }

  addText(text: string) {
    this.buffer += text;
    this.allText += text;
    this.scheduleFlush();
  }

  addActivity(desc: string) {
    // 如果 interval 为 -1，不添加活动消息
    if (this.interval === -1) return;
    this.activities.push(desc);
    this.scheduleFlush();
  }

  /** 当前 buffer 中是否有待发送内容 */
  hasContent(): boolean {
    return this.buffer.length > 0 || this.activities.length > 0;
  }

  /** 是否曾经发送过任何内容 */
  hasSentContent(): boolean {
    return this.sentContent;
  }

  /** 获取完整累积文本（用于文件标记提取） */
  getFinalText(): string {
    return this.allText;
  }

  /** 获取当前未发送的剩余文本 */
  getRemainingText(): string {
    return this.buffer;
  }

  /** 从当前 buffer 中移除匹配的模式 */
  stripFromBuffer(pattern: RegExp) {
    this.buffer = this.buffer.replace(pattern, '').trim();
  }

  private scheduleFlush() {
    if (this.timer) return;

    // 渐进式延迟：首条0ms，第2-4条 interval/2，后续 interval
    let targetDelay: number;
    if (this.flushCount === 0) {
      targetDelay = 0;
    } else if (this.flushCount <= 3) {
      targetDelay = Math.ceil(this.interval / 2);
    } else {
      targetDelay = this.interval;
    }

    const elapsed = Date.now() - this.lastFlush;
    const delay = Math.max(0, targetDelay - elapsed);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
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

    // 移除文件标记（如果配置了）
    if (output && this.fileMarkerPattern) {
      output = output.replace(this.fileMarkerPattern, '').trim();
    }

    if (output) {
      await this.send(output);
      this.sentContent = true;
      this.lastFlush = Date.now();
      this.flushCount++;
    }
  }
}
