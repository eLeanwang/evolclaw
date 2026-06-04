/**
 * FileCache —— 统一的文件缓存（daemon-only）。
 *
 * daemon 每条消息处理时读大量文件（manifest、fragment、md、working memory、
 * 关系级 preferences 等）。本类统一缓存"文件 → 解析后内容"，按策略门控变化检查。
 *
 * 设计与边界详见 docs/file-cache-design.md：
 *  - 不接管 EvolAgent 的 merged config（agent/defaults 由 EvolAgent 持有权威副本）。
 *  - daemon-only：CLI 短命进程仍直读最新盘值，不用本缓存。
 *  - 只缓存"文件 → 解析后内容"，不缓存按 vars 渲染后的结果。
 *
 * 策略（reload/重启永远全量失效，无视策略；策略只决定"平时每次读怎么检查"）：
 *  - on-reload：平时不检查，直接用缓存（kits 文件、persona）。靠 reload/重启刷新。
 *  - manual：同 on-reload，额外支持显式 invalidate(file) 单刷。
 *  - mtime：每次读 statSync 门控 mtime，变了自动重读（working.md、preferences.json）。
 */

import fs from 'fs';

export type CachePolicy = 'on-reload' | 'manual' | 'mtime';

interface Entry {
  policy: CachePolicy;
  group?: string;
  /** mtime 策略下记录上次读取时的 mtimeMs；null = 文件不存在；undefined = 非 mtime 策略不用 */
  mtimeMs?: number | null;
  /** 解析后的值（loader 产物）。文件不存在/读失败时为 loader 收到空内容的产物。 */
  value: unknown;
}

export class FileCache {
  private cache = new Map<string, Entry>();

  /**
   * 读取并缓存文件。loader 把原始内容（UTF-8 字符串；文件不存在时为 null）转成目标值。
   * 同一 file 的 policy/group 以首次注册为准。
   */
  get<T>(
    file: string,
    loader: (raw: string | null) => T,
    opts: { policy: CachePolicy; group?: string },
  ): T {
    const existing = this.cache.get(file);

    if (opts.policy === 'mtime') {
      const mtimeMs = statMtime(file);
      if (existing && existing.mtimeMs === mtimeMs) {
        return existing.value as T;
      }
      const value = loader(readFileOrNull(file));
      this.cache.set(file, { policy: 'mtime', group: opts.group, mtimeMs, value });
      return value;
    }

    // on-reload / manual：命中即用，不检查文件
    if (existing) return existing.value as T;
    const value = loader(readFileOrNull(file));
    this.cache.set(file, { policy: opts.policy, group: opts.group, value });
    return value;
  }

  /** 读纯文本的便捷封装（文件不存在返回 null）。 */
  getText(file: string, opts: { policy: CachePolicy; group?: string }): string | null {
    return this.get<string | null>(file, (raw) => raw, opts);
  }

  /** 单文件失效（manual 策略单刷 / 精确失效）。 */
  invalidate(file: string): void {
    this.cache.delete(file);
  }

  /** 按组失效（reload 钩子失效一组，如 'kits' / 'agent-files'）。 */
  invalidateGroup(group: string): void {
    for (const [file, entry] of this.cache) {
      if (entry.group === group) this.cache.delete(file);
    }
  }

  /** 全量失效（reload / 升级兜底）。 */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** 当前缓存条目数（诊断用）。 */
  size(): number {
    return this.cache.size;
  }
}

function statMtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;  // 文件不存在
  }
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** daemon 单例。CLI 进程不应使用本实例。 */
export const fileCache = new FileCache();
