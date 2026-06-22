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
 *  - mtime：每次读 statSync 门控 mtime，变了自动重读（working.md、config.json）。
 *
 * 容量：项数可无界增长的组（如 relation-prefs，每 peer 一文件）设 LRU 硬上限
 * （见 GROUP_CAPS），命中/写入移到末尾、超限驱逐同组最旧项；无 timer。
 * 项数固定的组（kits、per-agent 身份层）不设限。
 *
 * 监控：内置命中/读盘/驱逐/失效计数（总计 + 按 group + 按 policy），stats() 导出
 * 快照供 watch web 的 Cache 页展示（经 IPC 'cache-stats'）。计数是整数自增，热路径无感。
 */

import fs from 'fs';

export type CachePolicy = 'on-reload' | 'manual' | 'mtime';

/** 自定义读取器：file → 原始内容（不存在返回 null）。默认 readFileOrNull。 */
export type FileReader = (file: string) => string | null;

interface Entry {
  policy: CachePolicy;
  group?: string;
  /** mtime 策略下记录上次读取时的 mtimeMs；null = 文件不存在；undefined = 非 mtime 策略不用 */
  mtimeMs?: number | null;
  /** 解析后的值（loader 产物）。文件不存在/读失败时为 loader 收到空内容的产物。 */
  value: unknown;
  /** 缓存值的近似字节数（string 值取 UTF-16 长度近似；非 string 记 0），供内存占用统计。 */
  bytes: number;
}

// ── 监控埋点 ──
// 命中率/读盘/驱逐/失效等运行计数，按 总计 + group + policy 三维累计（整数自增，
// 热路径零感知）。stats() 额外即时遍历当前 entries 算 size/内存/容量水位。

/** 一组累计计数（总计与各 group / policy 共用此形状）。 */
export interface CacheCounters {
  /** get() 调用总数 = hit + miss。 */
  gets: number;
  /** 命中缓存直接返回（未读盘）。 */
  hits: number;
  /** 未命中、调 loader 读盘（首次写入，或 mtime 变化重读）。 */
  misses: number;
  /** mtime 策略每次读都做的 statSync 次数（量化 stat 开销）。 */
  statChecks: number;
  /** mtime 变化触发的重读（misses 的子集，区分"首次"与"带外改后重读"）。 */
  reReads: number;
  /** LRU 驱逐的条目数。 */
  evictions: number;
  /** invalidate/invalidateGroup/invalidateAll 清掉的条目数。 */
  invalidations: number;
}

/** stats() 即时计算的占用快照（按 group）。 */
export interface GroupOccupancy {
  /** 当前条目数。 */
  size: number;
  /** 近似内存字节数（各 entry.bytes 之和）。 */
  bytes: number;
  /** 该组 LRU 上限；未设限为 null。 */
  cap: number | null;
}

export interface FileCacheStats {
  /** 埋点起始（进程/模块加载时刻）。 */
  since: number;
  /** 当前总条目数。 */
  size: number;
  /** 全局累计计数。 */
  totals: CacheCounters;
  /** 按 group 的累计计数。 */
  byGroup: Record<string, CacheCounters>;
  /** 按 policy 的累计计数。 */
  byPolicy: Record<CachePolicy, CacheCounters>;
  /** 按 group 的当前占用（size/内存/容量）。 */
  occupancy: Record<string, GroupOccupancy>;
}

const GROUP_NONE = '(none)';  // group 未指定时的归类键

function newCounters(): CacheCounters {
  return { gets: 0, hits: 0, misses: 0, statChecks: 0, reReads: 0, evictions: 0, invalidations: 0 };
}

/**
 * 按组的容量上限（LRU）。只有"项数可无界增长"的组才设限——典型是关系级
 * preferences，每个 peer 一个文件，daemon 长跑接触的 peer 越来越多。
 * kits（项数随包固定）、per-agent 身份层（agent 数量有限）不设限，不在此表即无限。
 * 命中/写入都把 key 移到 Map 末尾（Map 保留插入序 → 头部即最久未用），
 * 超限时从头部驱逐同组最旧项。无 timer，确定性 bound。
 */
const GROUP_CAPS: Record<string, number> = {
  'relation-prefs': 512,
};

export class FileCache {
  private cache = new Map<string, Entry>();

  // 监控计数器（总计 + 按 group + 按 policy）。group 未指定归入 GROUP_NONE。
  private since = Date.now();
  private totals = newCounters();
  private byGroup = new Map<string, CacheCounters>();
  private byPolicy: Record<CachePolicy, CacheCounters> = {
    'on-reload': newCounters(), 'manual': newCounters(), 'mtime': newCounters(),
  };

  /** 取（或建）某 group 的计数器。 */
  private groupCounters(group?: string): CacheCounters {
    const key = group ?? GROUP_NONE;
    let c = this.byGroup.get(key);
    if (!c) { c = newCounters(); this.byGroup.set(key, c); }
    return c;
  }

  /** 同一事件按 总计/group/policy 三维各加一次。delta 缺省 1。 */
  private bump(group: string | undefined, policy: CachePolicy, field: keyof CacheCounters, delta = 1): void {
    this.totals[field] += delta;
    this.groupCounters(group)[field] += delta;
    this.byPolicy[policy][field] += delta;
  }

  /**
   * 读取并缓存文件。loader 把原始内容（UTF-8 字符串；文件不存在时为 null）转成目标值。
   * 同一 file 的 policy/group 以首次注册为准。
   * opts.read 可注入自定义读取器（如 atomicRead 保留崩溃恢复）；缺省 readFileOrNull。
   */
  get<T>(
    file: string,
    loader: (raw: string | null) => T,
    opts: { policy: CachePolicy; group?: string; read?: FileReader },
  ): T {
    const existing = this.cache.get(file);
    const read = opts.read ?? readFileOrNull;
    this.bump(opts.group, opts.policy, 'gets');

    if (opts.policy === 'mtime') {
      const mtimeMs = statMtime(file);
      this.bump(opts.group, opts.policy, 'statChecks');
      if (existing && existing.mtimeMs === mtimeMs) {
        this.bump(opts.group, opts.policy, 'hits');
        this.touch(file, existing);
        return existing.value as T;
      }
      // 已有条目但 mtime 变了 → 带外改后重读（区别于首次 miss）
      if (existing) this.bump(opts.group, opts.policy, 'reReads');
      this.bump(opts.group, opts.policy, 'misses');
      const raw = read(file);
      const value = loader(raw);
      this.store(file, { policy: 'mtime', group: opts.group, mtimeMs, value, bytes: approxBytes(raw) });
      return value;
    }

    // on-reload / manual：命中即用，不检查文件
    if (existing) {
      this.bump(opts.group, opts.policy, 'hits');
      this.touch(file, existing);
      return existing.value as T;
    }
    this.bump(opts.group, opts.policy, 'misses');
    const raw = read(file);
    const value = loader(raw);
    this.store(file, { policy: opts.policy, group: opts.group, value, bytes: approxBytes(raw) });
    return value;
  }

  /** 命中时把 key 移到 Map 末尾，维持 LRU 顺序（仅对设了容量上限的组有意义）。 */
  private touch(file: string, entry: Entry): void {
    if (entry.group === undefined || GROUP_CAPS[entry.group] === undefined) return;
    this.cache.delete(file);
    this.cache.set(file, entry);
  }

  /** 写入并对设限组做 LRU 驱逐（踢同组最久未用项）。 */
  private store(file: string, entry: Entry): void {
    this.cache.delete(file);  // 确保重写时移到末尾
    this.cache.set(file, entry);
    const cap = entry.group !== undefined ? GROUP_CAPS[entry.group] : undefined;
    if (cap === undefined) return;
    // Map 按插入序遍历，头部即最久未用；驱逐同组超出容量的最旧项。
    let count = 0;
    for (const e of this.cache.values()) if (e.group === entry.group) count++;
    if (count <= cap) return;
    for (const [k, e] of this.cache) {
      if (count <= cap) break;
      if (e.group === entry.group) {
        this.cache.delete(k);
        count--;
        this.bump(e.group, e.policy, 'evictions');
      }
    }
  }

  /** 读纯文本的便捷封装（文件不存在返回 null）。 */
  getText(file: string, opts: { policy: CachePolicy; group?: string; read?: FileReader }): string | null {
    return this.get<string | null>(file, (raw) => raw, opts);
  }

  /** 单文件失效（manual 策略单刷 / 精确失效）。 */
  invalidate(file: string): void {
    const entry = this.cache.get(file);
    if (this.cache.delete(file) && entry) this.bump(entry.group, entry.policy, 'invalidations');
  }

  /** 按组失效（reload 钩子失效一组，如 'kits' / 'agent-files:<aid>'）。 */
  invalidateGroup(group: string): void {
    for (const [file, entry] of this.cache) {
      if (entry.group === group) {
        this.cache.delete(file);
        this.bump(entry.group, entry.policy, 'invalidations');
      }
    }
  }

  /** 全量失效（reload / 升级兜底）。 */
  invalidateAll(): void {
    for (const entry of this.cache.values()) this.bump(entry.group, entry.policy, 'invalidations');
    this.cache.clear();
  }

  /** 当前缓存条目数（诊断用）。 */
  size(): number {
    return this.cache.size;
  }

  /**
   * 运行时统计快照（监控用）。累计计数 O(1) 取出；占用（size/内存/容量）即时遍历
   * 当前 entries 算出——条目数有限（kits 固定、relation-prefs 有 LRU 上限），便宜。
   */
  stats(): FileCacheStats {
    const occupancy: Record<string, GroupOccupancy> = {};
    for (const entry of this.cache.values()) {
      const key = entry.group ?? GROUP_NONE;
      let occ = occupancy[key];
      if (!occ) { occ = { size: 0, bytes: 0, cap: GROUP_CAPS[key] ?? null }; occupancy[key] = occ; }
      occ.size++;
      occ.bytes += entry.bytes;
    }
    const byGroup: Record<string, CacheCounters> = {};
    for (const [k, c] of this.byGroup) byGroup[k] = { ...c };
    return {
      since: this.since,
      size: this.cache.size,
      totals: { ...this.totals },
      byGroup,
      byPolicy: {
        'on-reload': { ...this.byPolicy['on-reload'] },
        'manual': { ...this.byPolicy['manual'] },
        'mtime': { ...this.byPolicy['mtime'] },
      },
      occupancy,
    };
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

/** 缓存值内存占用近似：用读入的原始字符串长度（字节级近似），null 记 0。 */
function approxBytes(raw: string | null): number {
  return raw === null ? 0 : raw.length;
}

/** daemon 单例。CLI 进程不应使用本实例。 */
export const fileCache = new FileCache();
