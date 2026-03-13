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

  constructor(
    private send: (text: string) => Promise<void>,
    private interval = 4000,
    fileMarkerPattern?: RegExp
  ) {
    this.fileMarkerPattern = fileMarkerPattern;
  }

  addText(text: string) {
    this.buffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    this.scheduleFlush();
  }

  addTextBlock(text: string) {
    // 用于 assistant 事件的完整文本块，需要换行分隔
    if (this.buffer && !this.buffer.endsWith('\n')) {
      this.buffer += '\n\n';
      this.allText += '\n\n';
    }
    this.buffer += text;
    this.allText += text;
    this.messageTimestamps.push(Date.now());
    this.scheduleFlush();
  }

  addActivity(desc: string) {
    this.activities.push(desc);
    this.messageTimestamps.push(Date.now());
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

    // 计算目标延迟
    let targetDelay: number;

    if (this.flushCount === 0) {
      // 第1次：立即发送
      targetDelay = 0;
    } else if (this.flushCount <= 3) {
      // 第2-4次：半延迟
      targetDelay = Math.ceil(this.interval / 2);
    } else if (this.messageTimestamps.length >= 5) {
      // 第5次起：动态自适应
      targetDelay = this.calculateDynamicDelay();
    } else {
      // 样本不足，使用额定延迟
      targetDelay = this.interval;
    }

    const elapsed = Date.now() - this.lastFlush;
    const delay = Math.max(0, targetDelay - elapsed);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  /**
   * 计算动态延迟
   * 基于最近10条消息的平均间隔
   */
  private calculateDynamicDelay(): number {
    // 取最近10条（或实际条数）
    const recent = this.messageTimestamps.slice(-10);

    // 计算平均间隔
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i] - recent[i - 1]);
    }

    if (intervals.length === 0) {
      return this.interval;
    }

    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;

    // 动态延迟 = 平均间隔 * 3
    let dynamicDelay = avgInterval * 3;

    // 边界限制
    const minDelay = this.interval;           // 下限：额定值
    const maxDelay = this.interval * 2.5;     // 上限：额定值 * 2.5

    return Math.max(minDelay, Math.min(maxDelay, dynamicDelay));
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
