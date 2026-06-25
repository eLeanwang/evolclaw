# 统一文件缓存（FileCache）设计

> 版本：v0.1
> 最后更新：2026-06-05

---

## 1. 背景

daemon 在每条消息处理时读大量文件，缓存现状"各人自扫门前雪"：

| 位置 | 现有缓存 | 失效方式 | 问题 |
|------|---------|---------|------|
| `manifest-engine` | `_manifestCache`（按文件名） | `invalidateManifestCache()` | 手动失效 |
| `kit-renderer` | `_sessionPathCache`（按 sessionId） | `invalidateKitCache/Session` | 按 session 重复存内容 |
| `message-renderer` | render-local `new Map()` | 无 | 跨消息完全不缓存 |
| `evolagent` | `_personaCache` | `clearPersonaCache` | 独立一份 |
| `model-scope` | 3 个 mtime 门控（agent/defaults/relation） | 自动 mtime | 自建一套 |
| `working.md` | 无 | — | 每条消息读盘 |

失效语义不一、有的根本没缓存。目标：抽象一个统一的 mtime/策略门控文件缓存，所有"直接读盘的文件"走它。

## 2. 边界（已确认）

1. **不接管 EvolAgent 的 merged config**：agent `config.json` / `defaults.json` 是内存合并产物（defaults + per-agent），EvolAgent 持有权威副本、reload 时 `swapConfig` 更新。daemon 内继续从 EvolAgent 读，**不进 FileCache**，避免出现第二份配置缓存。
2. **daemon-only**：FileCache 只在长驻的 daemon 进程有意义。CLI 是短命子进程（跑一次即退），仍直读最新盘值，不走缓存。
3. **只缓存"文件 → 解析后内容"**，不缓存"按 vars 渲染后的结果"（后者随每条消息变，本就不该缓存）。

## 3. 三种检查策略

**前提：reload 与重启永远全量失效所有缓存**（最高级，无视任何策略）。
reload 的语义就是"把一切刷新到盘上最新状态"，没有任何缓存能凌驾其上。
三种策略的区别只在于——**除 reload/重启外，平时每次读怎么检查变化**：

| 策略 | reload/重启 | 平时（每次读） | 适用 | 读路径成本 |
|------|------------|--------------|------|-----------|
| `on-reload` | 全量重载 | 不检查，直接用缓存 | 只靠 reload/重启感知变化就够：`kits/` 下 manifest/fragment/md | 零 |
| `manual` | 全量重载 | 不检查；额外支持显式 `invalidate(file)` 单刷 | reload 之外想在特定时机精确刷新的文件 | 零 |
| `mtime` | 全量重载 | statSync 门控 mtime，变了自动重读 | 带外修改且**不**触发 reload、需尽快生效：`persona.md`、`working.md`、关系级 `preferences.json` | 每读一次 stat |

要点：
- 占大头的 `kits/` 文件是 `on-reload`（零成本，改后 reload 或重启即生效）。
- 真正需要每次 stat 的只有少数"带外改、不 reload"的文件：`persona.md`、`working.md`、`preferences.json`。
  persona 与 working 同样由 agent 自己带外改写、无写入命令，故都用 `mtime`（改了即生效）。
- `manual` 是 `on-reload` 的细分：同样靠 reload 全量刷，额外多一个单刷入口。

## 4. 接口

```ts
type CachePolicy = 'on-reload' | 'manual' | 'mtime';

type FileReader = (file: string) => string | null;  // 自定义读取器，默认 readFileOrNull

class FileCache {
  /**
   * 读取并缓存文件。loader 负责"原始内容 → 解析后值"（如 JSON.parse、trim）。
   * 同一 file 的 policy/loader 在首次注册后固定。
   * opts.read 可注入自定义读取器（如 atomicRead 保留崩溃恢复）；缺省 readFileOrNull。
   */
  get<T>(file: string, loader: (raw: string | null) => T,
         opts: { policy: CachePolicy; group?: string; read?: FileReader }): T;

  /** 读纯文本的便捷封装（loader = identity）。 */
  getText(file: string, opts: { policy: CachePolicy; group?: string; read?: FileReader }): string | null;

  invalidate(file: string): void;        // 单文件失效
  invalidateGroup(group: string): void;  // 按组失效（reload 时失效一组 on-reload 文件）
  invalidateAll(): void;                 // 升级/兜底
  stats(): FileCacheStats;               // 运行统计（命中率/读盘/驱逐/失效，总计+按 group+按 policy）
}

// daemon 单例
export const fileCache = new FileCache();
```

- 文件不存在：缓存"不存在"状态（值为 null），`mtime` 策略下记 mtime=null，避免每次 stat 抛异常。
- `group`：让 reload 钩子一次失效一组（如所有 `on-reload`）。
- 值类型泛型：缓存类只管门控与存值，解析交给 loader。
- `read` 钩子：config/defaults 传 `atomicRead`（保留崩溃恢复）或 `noopRead`（读盘在
  loader 内、避免双读）；其余调用方不传，走默认 `readFileOrNull`。
- `stats()`：内置命中/读盘/驱逐/失效计数（整数自增，热路径无感），经 IPC `cache-stats`
  暴露给 watch web 的 Cache 页。详见 §9。

## 5. 容量（已实现：按组 LRU 硬上限）

项数可无界增长的组才设限，由 `GROUP_CAPS` 声明（当前仅 `relation-prefs: 512`——每 peer
一个 `preferences.json`，daemon 长跑接触的 peer 越来越多）。命中/写入都把 key 移到 `Map`
末尾（`Map` 保留插入序 → 头部即最久未用），写入后若同组超限则从头部驱逐同组最旧项。

为何用 LRU 硬上限而非「滑动 TTL + 载入时检查」：会膨胀的恰是**不再被访问的死 peer**，
而「仅在载入某 key 时检查过期」只能续期活项、永远扫不到死项——回收不了真正泄漏的来源。
LRU 上限是确定性 bound、无需常驻 timer（与"不引入 file-watcher"同一取舍）。
项数固定的组（`kits`、per-agent 身份层 `agent-files:<aid>`）不在 `GROUP_CAPS` 即不设限。

## 6. 接入计划（按文件，分批）

实现分批进行，每批独立提交、可验证可回退：

**批次 1 — 建类 + 试点**
| 接入点 | 文件 | 策略 | 备注 |
|--------|------|------|------|
| 新建 `src/core/cache/file-cache.ts` | — | — | FileCache 类 + daemon 单例 + 单元自测 |
| `model-scope`（relation） | `relations/<peerKey>/preferences.json` | `mtime` | 迁移现有 mtime cache 作试点 |

**批次 2 — kits 大头**
| 接入点 | 文件 | 策略 | 备注 |
|--------|------|------|------|
| `manifest-engine._manifestCache` | `eck_manifest.json` / `eck_message_manifest.json` | `on-reload` | 经 `invalidateKitCache` 失效 |
| `manifest-engine.loadSectionFiles` | `kits/` 下 fragment/md | `on-reload` | 替换 `sessionCache`——内容跨 session 共享，不再按 session 存 |
| `manifest-engine.readDirectoryFiles` | 同上目录文件 | `on-reload` | readdir 结果也缓存 |
| `message-renderer` render-local Map | message fragment | `on-reload` | 跨消息复用 |

**批次 3 — 身份层**
| 接入点 | 文件 | 策略 | 备注 |
|--------|------|------|------|
| `evolagent.getPersona` | `personal/persona.md` | `mtime` | persona 由 agent 自己带外改写、无写入命令，与 working 同样改了即生效 |
| `evolagent.getWorkingMemory` | `personal/memory/working.md` | `mtime` | 当前每条消息读盘——改 mtime 门控 |

> group 名带 aid（`agent-files:<aid>`）：reload 单个 agent 只失效自己的身份层，
> 不波及其他 agent 的 persona/working 缓存。

**批次 4 — model-scope 统一进 FileCache**
| 接入点 | 文件 | 策略 | 备注 |
|--------|------|------|------|
| `model-scope.loadAgentCached` | `agents/<aid>/config.json` | `mtime` | group `config:<aid>`；删原 `makeMtimeCache` |
| `model-scope.loadDefaultsCached` | `agents/defaults.json` | `mtime` | group `config` |

读盘+解析仍委托 `loadAgent`/`loadDefaults`（保留 `atomicRead` 崩溃恢复 +
expandEnvRefs/校验）：FileCache 传 `read: noopRead`，只做 mtime 门控、不重复读盘
（loader 忽略 raw）。CLI 也用 model-scope——CLI 的 fileCache 是独立空实例、随进程
退出，等同直读，安全（与 relation-prefs 同款）。原先与 FileCache 同形的第二套
`makeMtimeCache` 至此消除。

## 7. 失效接线

- **启动**：无需特殊处理（缓存空，首次读填充）。
- **热重载 agent**（`evolagent-registry.reload`）：`swapConfig` 后调 `oldAgent.invalidatePersonaCache()`，内部 `fileCache.invalidateGroup('agent-files:<aid>')`——只失效该 agent 身份层。
- **升级 / `invalidateKitCache`**：调 `fileCache.invalidateAll()` 或 `invalidateGroup('kits')`。
- **`mtime` 项**：无需接线，自动。

## 8. 非目标

- 不缓存渲染后结果（vars 每条消息变）。
- 不接管 EvolAgent merged config（边界 1）。
- 不在 CLI 进程启用（边界 2）。
- 不提供 reset/清缓存接口（监控只读；缓存仅经 reload/失效接线变化）。

## 9. 监控（watch web "Cache" 页）

`stats()` 导出运行快照，经 daemon IPC `cache-stats`（只读）给到 watch web
（`ecweb/`）的 Cache tab，1s 轮询 + diff 推送（复用 `aidSource` 范式）。

指标（累计计数按 **总计 + group + policy** 三维）：
- **gets / hits / misses**：读取总数与命中/未命中 → 前端算命中率。
- **statChecks**：mtime 策略每读一次 statSync，量化 stat 开销。
- **reReads**：mtime 变化触发的重读（带外改频率，misses 子集）。
- **evictions**：LRU 驱逐数（容量是否吃紧）。
- **invalidations**：reload/单刷清除的条目数。
- **occupancy**（即时遍历）：各 group 的 size / 近似内存 / 容量水位（设限组 size/cap）。

前端 Cache 页：总览卡片 + 按 group 表（per-agent 视图解析 `agent-files:<aid>` /
`config:<aid>`）+ 按 policy 表。daemon 离线或旧版不支持 `cache-stats` 时优雅降级提示。
协议向后兼容：旧 daemon 收到未知 type 回 `{error}`，ecweb 按此降级，无需 bump 版本。
