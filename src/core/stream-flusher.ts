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

  constructor(
    private send: (text: string) => Promise<void>,
    private interval = 3000
  ) {}

  addText(text: string) {
    this.buffer += text;
    this.allText += text;
    this.scheduleFlush();
  }

  addActivity(desc: string) {
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
    const elapsed = Date.now() - this.lastFlush;
    const delay = Math.max(0, this.interval - elapsed);
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

    if (output) {
      await this.send(output);
      this.sentContent = true;
      this.lastFlush = Date.now();
    }
  }
}
