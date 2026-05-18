/**
 * LogWriter — 统一的日志文件管理。
 *
 * 一个实例 = 一份"活跃日志 + 历史归档"。所有 EvolClaw 内部需要写日志的地方
 * 都应通过它，避免每个模块各自实现切片/清理。
 *
 * 切片规则：
 *   - 'hourly' / 'daily'：进入新时段时把当前活跃文件 rename 成
 *     `<base>-YYYYMMDD-HH.log` / `<base>-YYYYMMDD.log`，活跃文件名固定为
 *     `<base>.log`。这样 `tail -F <base>.log` 能跨切片续接（必须 -F，跟 path）。
 *   - 'size'：活跃文件超过 maxSize 时 rename 成 `<base>.log.<ISO-15>`。
 *   - 'none'：不切。
 *
 * 清理：进入新时段或启动时按 retention 删除过旧的归档文件。
 *
 * 设计取舍：LogWriter 不持有 stream，每次 write 时按需 open-append-close。
 *   优点：跨切片简单（rename 后下次 write 自动开新文件）；
 *   代价：每行一次 open/close 在高频日志下不便宜——但 EvolClaw 的日志量
 *   远低于 OS 缓存带宽，实测无瓶颈。
 *   后续若有热点（如 messages.log）可改成持流模式 + 切片时 close。
 */
import fs from 'fs';
import path from 'path';

export type RotationStrategy = 'hourly' | 'daily' | 'size' | 'none';

export interface LogWriterOptions {
  /** 文件名前缀（活跃文件名为 `<baseName>.log`） */
  baseName: string;
  /** 日志目录绝对路径 */
  logDir: string;
  /** 切片策略 */
  rotation: RotationStrategy;
  /** rotation === 'size' 时的阈值（字节）；默认 10MB */
  maxSize?: number;
  /** 归档保留时长 */
  retention: { hours?: number; days?: number };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class LogWriter {
  private readonly baseName: string;
  private readonly logDir: string;
  private readonly rotation: RotationStrategy;
  private readonly maxSize: number;
  private readonly retentionMs: number;

  /** 当前活跃时段 tag（hourly: YYYYMMDD-HH，daily: YYYYMMDD），用于检测切片 */
  private currentTag: string;

  /** 周期清理 timer（unref 不阻塞退出） */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(opts: LogWriterOptions) {
    this.baseName = opts.baseName;
    this.logDir = opts.logDir;
    this.rotation = opts.rotation;
    this.maxSize = opts.maxSize ?? 10 * 1024 * 1024;
    this.retentionMs =
      (opts.retention.hours ?? 0) * HOUR_MS +
      (opts.retention.days ?? 0) * DAY_MS;

    fs.mkdirSync(this.logDir, { recursive: true });
    this.currentTag = this.tagOfNow();

    // 启动时如果 active 文件已存在但归属上一时段，先归档掉
    this.rotateIfNeeded(/* sync */ true);
    this.cleanupOldArchives();

    // 周期触发切片+清理。两段式定时器：先用 setTimeout 对齐到下一个整点
    //（hourly: 下个整点；daily: 明日 00:00），然后切到每小时一次的 setInterval。
    // 这样空闲期也能按时切片——而不是等到下一次有人 write 才补切。
    if (this.rotation === 'hourly' || this.rotation === 'daily') {
      const tick = () => {
        this.rotateIfNeeded(false);
        this.cleanupOldArchives();
      };
      const initialDelay = this.msUntilNextBoundary();
      const initialTimer = setTimeout(() => {
        tick();
        this.cleanupTimer = setInterval(tick, HOUR_MS);
        this.cleanupTimer.unref?.();
      }, initialDelay);
      initialTimer.unref?.();
    }
  }

  /** 写一行（自动加 \n） */
  write(line: string): void {
    this.rotateIfNeeded(false);
    try {
      fs.appendFileSync(this.activePath(), line + '\n');
    } catch {
      // 写入失败不抛——日志不能影响业务
    }
  }

  /** 关闭（停掉清理 timer）。一般不需要调用，进程退出 timer 自动失效 */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 当前活跃文件绝对路径 */
  activePath(): string {
    return path.join(this.logDir, `${this.baseName}.log`);
  }

  // ── Internal ──

  /** 距离下一个整时段边界的毫秒数（hourly: 下个整点；daily: 明日 00:00） */
  private msUntilNextBoundary(): number {
    const now = new Date();
    const next = new Date(now);
    if (this.rotation === 'daily') {
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
    } else {
      next.setHours(next.getHours() + 1, 0, 0, 0);
    }
    // 给 1 秒余量，确保 Date 时钟跨越整点后再触发，避免边界误差
    return Math.max(1000, next.getTime() - now.getTime() + 1000);
  }

  private tagOfNow(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    if (this.rotation === 'daily') return day;
    return `${day}-${pad(d.getHours())}`;
  }

  private archivePath(tag: string): string {
    return path.join(this.logDir, `${this.baseName}-${tag}.log`);
  }

  private rotateIfNeeded(initial: boolean): void {
    const active = this.activePath();
    if (this.rotation === 'none') return;

    if (this.rotation === 'size') {
      let stat: fs.Stats;
      try { stat = fs.statSync(active); } catch { return; }
      if (stat.size <= this.maxSize) return;
      const tag = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      try { fs.renameSync(active, `${active}.${tag}`); } catch {}
      this.cleanupOldArchives();
      return;
    }

    // hourly / daily
    const nowTag = this.tagOfNow();

    // 文件不存在 → 直接更新 currentTag，下次 write 会创建
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(active); } catch { /* not exist */ }

    if (!stat) {
      this.currentTag = nowTag;
      return;
    }

    // 启动时：用 mtime 判断 active 文件归属哪个 tag
    const ownerTag = initial ? this.tagOfTime(stat.mtimeMs) : this.currentTag;

    if (ownerTag === nowTag) {
      this.currentTag = nowTag;
      return;
    }

    // 切片：把 active 重命名为 archive
    const archive = this.archivePath(ownerTag);
    try {
      // 如果 archive 已存在（重名），先合并：append 老 active 内容到 archive 末尾
      if (fs.existsSync(archive)) {
        try {
          const content = fs.readFileSync(active);
          fs.appendFileSync(archive, content);
          fs.unlinkSync(active);
        } catch {}
      } else {
        fs.renameSync(active, archive);
      }
    } catch {}
    this.currentTag = nowTag;
  }

  private tagOfTime(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    if (this.rotation === 'daily') return day;
    return `${day}-${pad(d.getHours())}`;
  }

  private cleanupOldArchives(): void {
    LogWriter.cleanupArchivesIn(this.logDir, this.retentionMs);
  }

  /**
   * 全局清理：扫整个 logDir，按 retention 删除所有匹配 LogWriter 归档命名约定的文件。
   *
   * 命名约定：`<baseName>-YYYYMMDD-HH.log`（hourly）或 `<baseName>-YYYYMMDD.log`（daily），
   * 其中 baseName 由字母/数字/连字符组成。
   *
   * 这条规则跨 baseName 统一——只要文件按这个 pattern 命名就认为受 LogWriter 体系管辖。
   * 这样 conditional 启用的 LogWriter（如 aun trace 关闭时）不会留下永久无人清的归档：
   * 任意 LogWriter 实例化都会顺便清掉它们。
   */
  static cleanupArchivesIn(logDir: string, retentionMs: number): void {
    if (retentionMs <= 0) return;
    const cutoff = Date.now() - retentionMs;
    let entries: string[];
    try { entries = fs.readdirSync(logDir); } catch { return; }
    const generalPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*-\d{8}(?:-\d{2})?\.log$/;
    for (const name of entries) {
      if (!generalPattern.test(name)) continue;
      const full = path.join(logDir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  }
}
