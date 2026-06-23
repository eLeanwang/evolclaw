# owners 搬迁 evolclaw.json + 启动期控制 AID 检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把进程级鉴权名单 `owners` 从 `agents/defaults.json` 搬到 `evolclaw.json`（语义归位：进程级控制面配置），并在 `evolclaw start` 缺控制 AID 时（交互式终端下）自动进 init 向导补全 aid + owners。

**Architecture:** 硬切——`DefaultsConfig.owners` 字段移除，`isProcessLevelOwner` 改成纯函数 `(peerId, owners[])`，5 个鉴权调用点改读 `loadEvolclawConfig().owners`。启动门禁加第三道：`cmdStart`（CLI 侧，有 TTY）缺 `aid` 且 `process.stdin.isTTY` 为真 → 进 `cmdInit`；非 TTY（restart-monitor/systemd/管道）只 warn 不阻断（daemon 侧 `main()` 永不进 init）。`evolclaw init` 在生成控制 AID 后追加一步：询问管理者 AID 写入 `evolclaw.owners`，允许回车跳过。

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest。涉及 `src/types.ts`、`src/evolclaw-config.ts`、`src/core/command-handler.ts`、`src/index.ts`、`src/cli/index.ts`、`src/cli/init.ts`。

**前置设计文档**：本计划是 Part 1（`2026-06-04-part1-daemon-aid-plan.md`，已合并）的后续。`evolclaw.json`（`EvolclawConfig`）已存在并承载 `aid`/`debug`/`tunnel`/`aun`。

---

## 关键现状约束（实现前必读）

1. **`DefaultsConfig.owners`**（`types.ts:753`）当前是进程级鉴权唯一来源，**无任何写入路径**（全仓库没有代码写它，只能手编辑）。`init-channel.ts`/`agent.ts` 写的 owners 都是 per-agent 的 `config.owners`，与本计划无关。
2. **`isProcessLevelOwner`**（`command-handler.ts:4257`）签名 `(peerId: string | undefined, defaults: DefaultsConfig | null) => boolean`，逻辑 `(defaults?.owners ?? []).includes(peerId)`。
3. **5 个鉴权调用点**（`command-handler.ts:676 / 844 / 956 / 1156 / 1279`）形如 `if (!isProcessLevelOwner(userId, loadDefaults())) { ... }`。**第 6 处 `loadDefaults()`（`:1161`）是 `resolveProjectPath`，与 owners 无关，不动。**
4. **`defaults.admins`**（`types.ts:755`）无任何进程级消费者，**本计划不动 admins**（仅搬 owners）。
5. **启动 warn**（`index.ts:243`）读 `defaults.owners` 判空提示。`defaults` 在 `:239` 加载；`evolclawCfg` 在 Part 1 代码里于控制 AID 块（约 `:771`）才 `loadEvolclawConfig()`。本计划把 `evolclawCfg` 的加载上移、复用。
6. **`cmdStart`**（`cli/index.ts:281`）是 `evolclaw` / `evolclaw start` 入口（`cmd = args[0] || 'start'`，`:4806`），**有 TTY**；它 `spawn` 出 detached daemon（`dist/index.js`，`:362`）。`cmdRestart` 经 `setTimeout(cmdStart)`（`:577`）也走这里。**restart-monitor（`cmdRestartMonitor` → `spawnAndWaitReady`，`:2381`）直接 spawn daemon，绕过 `cmdStart`**——所以 daemon `main()` 必须独立容忍缺 aid（只 warn）。
7. **baseagents 门禁**（`cmdStart:294`）模式：缺 → `console.log(...)` + `await cmdInit()` + `return`（不继续 spawn daemon）。新 aid 门禁照此对称，紧随其后。
8. **`process.stdin.isTTY`** 是本仓库既有的交互检测惯用法（`cli/index.ts:1447/1658/2063` 等）。
9. **init tail**（Part 1 重构后，`init.ts` 的 `initTail()`）当前做两件事：提示创建 agent、生成/确认控制 AID。`runInteractive()` 内部自管 `rl` 生命周期且在 `initTail()` 前已关闭。
10. **`isValidAid`** 由 `src/aun/aid/index.js` 导出（`(name:string)=>boolean`，多级域名校验）。
11. **测试约定**：`tests/` 被 `/tests/` gitignore，但既有测试用 `git add -f` 强制跟踪。mock 顶层变量须用 `vi.hoisted`。`_resetRoot()` 清 paths 缓存。

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/types.ts` | `DefaultsConfig` 移除 `owners` 字段 | Modify |
| `src/evolclaw-config.ts` | `EvolclawConfig` 加 `owners?: string[]` | Modify |
| `src/core/command-handler.ts` | `isProcessLevelOwner` 改纯函数 `(peerId, owners[])`；5 调用点改读 `loadEvolclawConfig().owners` | Modify |
| `src/index.ts` | 启动 warn 改读 `evolclawCfg.owners`；`evolclawCfg` 加载上移复用 | Modify |
| `src/cli/init.ts` | 加 `needsControlAidInit`（纯）+ `parseOwnerAids`（纯）；`initTail` 追加 owners 询问 | Modify |
| `src/cli/index.ts` | `cmdStart` 加控制 AID 门禁（TTY 守卫） | Modify |
| `tests/unit/menu-process-auth.test.ts` | 改 `isProcessLevelOwner` 新签名 | Modify |
| `tests/unit/evolclaw-config.test.ts` | owners 往返单测 | Modify |
| `tests/unit/control-aid-gate.test.ts` | `needsControlAidInit` + `parseOwnerAids` 单测 | Create |

---

## Task 1: owners 搬迁（类型 + 鉴权读取源硬切）

**Files:**
- Modify: `src/evolclaw-config.ts`
- Modify: `src/types.ts:740-759`（`DefaultsConfig`）
- Modify: `src/core/command-handler.ts`（`isProcessLevelOwner` `:4257` + 5 调用点）
- Test: `tests/unit/menu-process-auth.test.ts`、`tests/unit/evolclaw-config.test.ts`

- [ ] **Step 1: 改鉴权单测到新签名（写失败测试）**

把 `tests/unit/menu-process-auth.test.ts` 整体替换为（`isProcessLevelOwner` 改收 `owners: string[] | undefined`，不再收 `DefaultsConfig`）：

```typescript
import { describe, it, expect } from 'vitest';
import { isProcessLevelOwner } from '../../src/core/command-handler.js';

describe('isProcessLevelOwner (owners from evolclaw.json)', () => {
  it('allows AID in owners list', () => {
    expect(isProcessLevelOwner('a.agentid.pub', ['a.agentid.pub'])).toBe(true);
  });
  it('rejects AID not in owners', () => {
    expect(isProcessLevelOwner('b.agentid.pub', ['a.agentid.pub'])).toBe(false);
  });
  it('rejects when owners undefined', () => {
    expect(isProcessLevelOwner('a.agentid.pub', undefined)).toBe(false);
  });
  it('rejects when owners empty', () => {
    expect(isProcessLevelOwner('a.agentid.pub', [])).toBe(false);
  });
  it('rejects empty peerId', () => {
    expect(isProcessLevelOwner('', ['a.agentid.pub'])).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/menu-process-auth.test.ts`
Expected: FAIL — 旧 `isProcessLevelOwner` 第二参是 `DefaultsConfig`，传 `string[]` 类型不符 / 逻辑读 `.owners` 报错。

- [ ] **Step 3: `EvolclawConfig` 加 `owners`**

`src/evolclaw-config.ts` 的 `EvolclawConfig` 接口加字段（放在 `aid` 后）：

```typescript
export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  owners?: string[];          // 进程级控制面鉴权名单（AID）：谁能远程管理本 daemon（/agent /system）
  debug?: DebugBlock;
  tunnel?: TunnelConfig;
  aun?: EvolclawAunConfig;
}
```

- [ ] **Step 4: `DefaultsConfig` 移除 `owners`**

`src/types.ts`：删除 `DefaultsConfig` 里的 `owners?: string[]`（含其上方 `:751-752` 那段注释）。**保留 `admins`**（本计划不动）。改后 `:736-738` 的类注释同步修正：

```typescript
/**
 * agents/defaults.json —— per-agent 配置缺失字段的 fallback。
 * 不持有 channels / owners / aid（owners 已移至 evolclaw.json 顶层，进程级鉴权专用）。
 */
export interface DefaultsConfig {
  $schema_version: number;
  aun?: AunRuntimeBlock;
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  models?: ModelsBlock;
  projects?: ProjectsBlock;
  chatmode?: ChatmodeBlock;
  show_activities?: ShowActivitiesMode;
  flush_delay?: number;
  debounce?: number;
  /** defaults.admins 提供全局基础（如运维 AID），与 per-agent admins 数组合并去重 */
  admins?: string[];
  debug?: DebugBlock;
  enable_rich_content?: boolean;
}
```

- [ ] **Step 5: `isProcessLevelOwner` 改纯函数**

`src/core/command-handler.ts:4255-4261` 替换为：

```typescript
/** 进程级 menu 操作（/agent、/system）鉴权：发送方 AID 必须在 owners 名单中。
 *  owners 来自 evolclaw.json 顶层（进程级控制面配置）。纯静态名单比对。 */
export function isProcessLevelOwner(peerId: string | undefined, owners: string[] | undefined): boolean {
  if (!peerId) return false;
  return (owners ?? []).includes(peerId);
}
```

- [ ] **Step 6: 5 个调用点改读 evolclaw.owners**

`src/core/command-handler.ts` 顶部 import 区（`:27` `loadDefaults` 那行附近）加：

```typescript
import { loadEvolclawConfig } from '../evolclaw-config.js';
```

把 `:676 / :844 / :956 / :1156 / :1279` 五处的
```typescript
      if (!isProcessLevelOwner(userId, loadDefaults())) {
```
逐一改为：
```typescript
      if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
```

> **注意**：`:1161` 的 `resolveProjectPath(a.project, a.aid ?? '', loadDefaults())` 是项目路径解析，**不动**——`loadDefaults` import 保留。

- [ ] **Step 7: 全仓搜残留 `defaults.owners` 引用**

Run: `grep -rn "\.owners" src/ | grep -i "default" | grep -v "config.owners\|agent.config\|rawAgent\|merged.owners\|inst.owners"`
Expected: 无输出（所有 `defaults.owners` 消费已切走）。若有残留，逐一改到 `loadEvolclawConfig().owners`。

- [ ] **Step 8: owners 往返单测（evolclaw-config.test.ts 追加）**

在 `tests/unit/evolclaw-config.test.ts` 的 `describe('evolclaw-config', ...)` 内追加：

```typescript
  it('round-trips owners array', () => {
    saveEvolclawConfig({ $schema_version: 1, owners: ['op.agentid.pub', 'op2.agentid.pub'] });
    expect(loadEvolclawConfig().owners).toEqual(['op.agentid.pub', 'op2.agentid.pub']);
  });
```

- [ ] **Step 9: 编译 + 相关测试 + 全量回归**

Run: `npm run build && npx vitest run tests/unit/menu-process-auth.test.ts tests/unit/evolclaw-config.test.ts && npm test`
Expected: 无 TS 错误（特别确认无残留 `DefaultsConfig.owners` 访问导致编译错）；全 PASS。

- [ ] **Step 10: Commit**

```bash
git add src/evolclaw-config.ts src/types.ts src/core/command-handler.ts
git add -f tests/unit/menu-process-auth.test.ts tests/unit/evolclaw-config.test.ts
git commit -m "refactor(auth): move process-level owners from defaults.json to evolclaw.json"
```

---

## Task 2: 启动 warn 改读 evolclaw.owners（daemon 侧）

**Files:**
- Modify: `src/index.ts`（`:239-246` 的 owners warn + `evolclawCfg` 加载位置）

**背景**：daemon `main()` 启动时若 owners 空要 warn。现状读 `defaults.owners`（已废）。改读 `evolclawCfg.owners`。同时 Part 1 在控制 AID 块（约 `:771`）才 `loadEvolclawConfig()`——把它上移到 `defaults` 加载附近，warn 与控制 AID 块复用同一个 `evolclawCfg`，避免重复读盘。

- [ ] **Step 1: 上移 evolclawCfg 加载 + 改 warn 源**

`src/index.ts:239-246`，把：

```typescript
  const defaults: DefaultsConfig = loadDefaults() ?? { $schema_version: CONFIG_SCHEMA_VERSION };

  // D1 迁移引导：进程级 menu 操作（/system /agent）改为查 defaults.owners 鉴权。
  // owners 为空时这些操作一律 FORBIDDEN，启动时提示如何配置。
  if (!defaults.owners || defaults.owners.length === 0) {
    logger.warn('[startup] defaults.owners 未配置：进程级 menu 操作（/system /agent）将一律拒绝。' +
      '如需远程管理，请在 agents/defaults.json 配置 owners: [<你的 AID>]');
  }
```

替换为：

```typescript
  const defaults: DefaultsConfig = loadDefaults() ?? { $schema_version: CONFIG_SCHEMA_VERSION };
  const evolclawCfg = loadEvolclawConfig();

  // 进程级 menu 操作（/system /agent）查 evolclaw.json 顶层 owners 鉴权。
  // owners 为空时这些操作一律 FORBIDDEN，启动时提示如何配置。
  if (!evolclawCfg.owners || evolclawCfg.owners.length === 0) {
    logger.warn('[startup] evolclaw.json owners 未配置：进程级 menu 操作（/system /agent）将一律拒绝。' +
      '如需远程管理，请运行 evolclaw init 配置，或在 evolclaw.json 顶层加 owners: [<你的 AID>]');
  }
```

- [ ] **Step 2: 删除控制 AID 块里重复的 evolclawCfg 加载**

`src/index.ts` 控制 AID 块（Part 1 加的，搜 `const evolclawCfg = loadEvolclawConfig();`，约 `:771`）——现在它在 `:240` 已声明，删除控制 AID 块里这一行重复声明（保留 `let controlChannel...` 及其后逻辑，它们复用上移后的 `evolclawCfg`）。

> 确认 `loadEvolclawConfig` 已在 `src/index.ts` import（Part 1 已加 `import { loadEvolclawConfig } from './evolclaw-config.js';`）。若 `defaults` 变量在 `:240` 后到控制 AID 块之间无人再读 owners，无其它副作用。

- [ ] **Step 3: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 无 TS 错误（特别确认控制 AID 块未因删除重复声明而引用未定义的 `evolclawCfg`）；全 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(startup): owners warn reads evolclaw.json; hoist evolclawCfg load"
```

---

## Task 3: cmdStart 控制 AID 门禁（TTY 守卫）

**Files:**
- Modify: `src/cli/init.ts`（加导出纯函数 `needsControlAidInit`）
- Modify: `src/cli/index.ts`（`cmdStart` `:298` 后插入门禁）
- Test: `tests/unit/control-aid-gate.test.ts`

**设计**：缺 `aid` 且交互式终端（`process.stdin.isTTY`）→ 进 `cmdInit` 补全（与 baseagent 门禁对称，`await cmdInit(); return;`）。非 TTY（restart-monitor/systemd/管道）即使缺 aid 也**不进 init**（无法交互会挂起），只 `console.log` 一行提示后继续 spawn daemon——daemon 侧 Task 2 的 warn 兜底。owners 缺失**永不**触发门禁（用户决策：仅 aid 缺失进 init）。

- [ ] **Step 1: 写 `needsControlAidInit` 失败测试**

创建 `tests/unit/control-aid-gate.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { needsControlAidInit } from '../../src/cli/init.js';

describe('needsControlAidInit', () => {
  it('aid missing + TTY → enter init', () => {
    expect(needsControlAidInit(undefined, true)).toBe(true);
  });
  it('aid missing + no TTY → do not enter init (headless)', () => {
    expect(needsControlAidInit(undefined, false)).toBe(false);
  });
  it('aid present + TTY → no init', () => {
    expect(needsControlAidInit('ec12345.agentid.pub', true)).toBe(false);
  });
  it('aid present + no TTY → no init', () => {
    expect(needsControlAidInit('ec12345.agentid.pub', false)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/control-aid-gate.test.ts`
Expected: FAIL — `needsControlAidInit` 未导出。

- [ ] **Step 3: 实现 `needsControlAidInit`**

`src/cli/init.ts` 顶部（`cmdInit` 之前的 helper 区，`// ==================== Main ====================` 上方）加导出：

```typescript
/** 启动门禁判定：缺控制 AID 且处于交互式终端时，应进 init 向导补全。
 *  非 TTY（restart-monitor/systemd/管道）即使缺 aid 也不进 init（无法交互），由 daemon 侧 warn 兜底。 */
export function needsControlAidInit(aid: string | undefined, isTty: boolean): boolean {
  return !aid && isTty;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/control-aid-gate.test.ts`
Expected: PASS（4 条）。

- [ ] **Step 5: 接入 cmdStart**

`src/cli/index.ts` 顶部 import 区（`:12` `import { cmdInit } from './init.js';` 那行）改为：

```typescript
import { cmdInit, needsControlAidInit } from './init.js';
```

并确认顶部已 import `loadEvolclawConfig`；若无，加：

```typescript
import { loadEvolclawConfig } from '../evolclaw-config.js';
```

在 `cmdStart` 的 baseagents 门禁之后（`:298` 的 `}` 之后、`// 检查至少有一个 self-agent` 之前）插入：

```typescript
  // 控制 AID 门禁（与 baseagent 门禁对称）：缺 aid 且交互式 → 进 init 补全 aid + owners。
  // 非 TTY（restart-monitor/systemd/管道）不进 init（无法交互），只提示后继续启动，daemon 侧 warn 兜底。
  const evolclawCfg = loadEvolclawConfig();
  if (needsControlAidInit(evolclawCfg.aid, !!process.stdin.isTTY)) {
    console.log('⚡ 控制 AID 未配置，自动启动初始化向导...\n');
    await cmdInit();
    return;
  }
  if (!evolclawCfg.aid) {
    console.log('⚠ 控制 AID 未配置（非交互式启动，跳过向导）。如需进程身份/远程管理，请运行 evolclaw init');
  }
```

- [ ] **Step 6: 编译**

Run: `npm run build`
Expected: 无 TS 错误。

- [ ] **Step 7: 手测矩阵（需谨慎——不要中断生产 daemon）**

在隔离 HOME 验证，避免动 `/home/evolclaw` 线上：

| 场景 | 命令 | 预期 |
|---|---|---|
| 缺 aid + 交互式 | `EVOLCLAW_HOME=$(mktemp -d) node dist/cli/index.js start`（先在该 HOME 放好 defaults.json + 一个 agent） | 打印"控制 AID 未配置，自动启动初始化向导" → 进 init |
| 缺 aid + 非 TTY | 同上但 `< /dev/null`（stdin 非 TTY） | 打印"⚠ 控制 AID 未配置（非交互式...跳过向导）" → 继续 spawn daemon |
| 有 aid | 该 HOME 的 evolclaw.json 有 aid | 不进 init，正常启动 |

- [ ] **Step 8: Commit**

```bash
git add src/cli/init.ts src/cli/index.ts
git add -f tests/unit/control-aid-gate.test.ts
git commit -m "feat(start): enter init when control AID missing (TTY-guarded); headless warns only"
```

---

## Task 4: init 询问 owners（生成 aid 后，允许跳过）

**Files:**
- Modify: `src/cli/init.ts`（加导出纯函数 `parseOwnerAids`；`initTail` 追加 owners 询问）
- Test: `tests/unit/control-aid-gate.test.ts`（追加 `parseOwnerAids` 用例）

**设计**：`initTail` 在生成/确认控制 AID 后，若**交互式**（`process.stdin.isTTY`）且 `evolclaw.owners` 为空，开一个短生命周期 `rl` 询问管理者 AID（多个用空格/逗号分隔），解析+校验+去重后写入 `evolclaw.owners`；回车空输入=显式跳过（不写、打印提示）。非交互式（`--non-interactive`）跳过此步。owners 配置纯本地，**不依赖网络**——即便 aid 生成失败（离线）仍可配 owners。

- [ ] **Step 1: 写 `parseOwnerAids` 失败测试（追加到 control-aid-gate.test.ts）**

在 `tests/unit/control-aid-gate.test.ts` 追加：

```typescript
import { parseOwnerAids } from '../../src/cli/init.js';

describe('parseOwnerAids', () => {
  const isValid = (aid: string) => aid.split('.').length >= 3; // 简化校验，仅供测试

  it('splits on whitespace and commas, dedups', () => {
    const r = parseOwnerAids('a.agentid.pub, b.agentid.pub a.agentid.pub', isValid);
    expect(r.valid).toEqual(['a.agentid.pub', 'b.agentid.pub']);
    expect(r.invalid).toEqual([]);
  });
  it('separates invalid AIDs', () => {
    const r = parseOwnerAids('good.agentid.pub bad', isValid);
    expect(r.valid).toEqual(['good.agentid.pub']);
    expect(r.invalid).toEqual(['bad']);
  });
  it('empty input → empty valid (treated as skip)', () => {
    const r = parseOwnerAids('   ', isValid);
    expect(r.valid).toEqual([]);
    expect(r.invalid).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/control-aid-gate.test.ts`
Expected: FAIL — `parseOwnerAids` 未导出。

- [ ] **Step 3: 实现 `parseOwnerAids`**

`src/cli/init.ts`（紧挨 `needsControlAidInit` 下方）加导出：

```typescript
/** 解析用户输入的 owner AID 列表：按空白/逗号分隔，去空、去重、按 isValid 分流。
 *  空输入 → valid:[]（视为跳过）。 */
export function parseOwnerAids(raw: string, isValid: (aid: string) => boolean): { valid: string[]; invalid: string[] } {
  const tokens = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of tokens) {
    if (isValid(t)) {
      if (!valid.includes(t)) valid.push(t);
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/control-aid-gate.test.ts`
Expected: PASS（`needsControlAidInit` 4 条 + `parseOwnerAids` 3 条）。

- [ ] **Step 5: initTail 追加 owners 询问**

`src/cli/init.ts` 的 `initTail()`（Part 1 加的，搜 `async function initTail`）末尾——控制 AID 生成/确认逻辑之后、函数 `}` 之前——追加：

```typescript
    // ── 配置进程级管理者（owners）：控制谁能远程管理本 daemon（/agent /system）──
    // 仅交互式 + owners 未配置时询问；空输入=显式跳过。纯本地，不依赖网络。
    const evcForOwners = loadEvolclawConfig();
    if (process.stdin.isTTY && (!evcForOwners.owners || evcForOwners.owners.length === 0)) {
      const { isValidAid } = await import('../aun/aid/index.js');
      const rlOwners = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const raw = (await ask(rlOwners,
          '\n管理者 AID（谁能远程管理本进程的 /agent /system，多个用空格分隔，直接回车跳过）: ')).trim();
        if (raw) {
          const { valid, invalid } = parseOwnerAids(raw, isValidAid);
          if (invalid.length > 0) console.log(`  ⚠ 跳过非法 AID: ${invalid.join(', ')}`);
          if (valid.length > 0) {
            saveEvolclawConfig({ ...loadEvolclawConfig(), owners: valid });
            console.log(`  ✓ 已配置管理者: ${valid.join(', ')}`);
          } else {
            console.log('  未输入合法 AID，已跳过 owners 配置');
          }
        } else {
          console.log('  已跳过 owners 配置（可日后编辑 evolclaw.json 或重跑 evolclaw init）');
        }
      } finally {
        try { rlOwners.close(); } catch { /* ignore */ }
      }
    }
```

> 确认 `init.ts` 顶部已 import `readline`、`ask`、`loadEvolclawConfig`、`saveEvolclawConfig`（Part 1 已 import 后两者）。`ask(rl, q)` helper 在 `init.ts:12` 已存在。

- [ ] **Step 6: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 无 TS 错误；全 PASS。

- [ ] **Step 7: 手测（隔离 HOME，交互式）**

```bash
H=$(mktemp -d); EVOLCLAW_HOME=$H node dist/cli/index.js init
# 走到末尾：生成控制 AID 后，提示输入管理者 AID
# 输入一个合法 AID → 确认 evolclaw.json owners 已写入
cat $H/evolclaw.json
# 重跑 init：owners 已非空 → 不再询问 owners
EVOLCLAW_HOME=$H node dist/cli/index.js init
```
Expected: 首次写入 owners；重跑因 owners 非空跳过询问。

- [ ] **Step 8: Commit**

```bash
git add src/cli/init.ts
git add -f tests/unit/control-aid-gate.test.ts
git commit -m "feat(init): prompt for process-level owners after control AID (skippable)"
```

---

## Self-Review 结果

**Spec 覆盖（对照三条决策 + TTY 守卫）**：
- ✅ owners 硬切搬到 evolclaw.json（移除 `DefaultsConfig.owners`，鉴权读 `evolclaw.owners`）→ Task 1
- ✅ daemon 启动 warn 改读 evolclaw.owners → Task 2
- ✅ 启动门禁"仅 aid 缺失进 init" + TTY 守卫（非交互式只 warn 不阻断）→ Task 3
- ✅ init 生成 aid 后询问 owners，允许显式跳过 → Task 4
- ✅ admins 不动（无消费者，超范围）→ 计划约束 4 明确
- ✅ 无 defaults.owners 迁移（硬切，用户决策）→ 存量手配者经 Task 3 门禁重配

**类型一致性**：
- `isProcessLevelOwner(peerId, owners: string[] | undefined)` 在 Task 1 定义，5 调用点（Task 1 Step 6）与测试（Task 1 Step 1）均用 `string[]`/`undefined`，一致。
- `EvolclawConfig.owners?: string[]`（Task 1 Step 3）与 Task 2/4 读写一致。
- `needsControlAidInit(aid?: string, isTty: boolean)`、`parseOwnerAids(raw, isValid) => {valid, invalid}` 在 Task 3/4 定义，测试与接入点签名一致。

**Placeholder 扫描**：无 TBD/TODO；每个改码步骤均给出完整代码与确切 file:line。

**关键陷阱（已显式标注）**：
1. Task 1：`:1161` 的 `loadDefaults()`（resolveProjectPath）不动，`loadDefaults` import 保留；Step 7 grep 兜底搜残留。
2. Task 2：`evolclawCfg` 加载上移后，删除控制 AID 块的重复声明，避免 redeclare / 未定义引用。
3. Task 3：门禁在 `cmdStart`（CLI/TTY 侧），**不在 daemon `main()`**；restart-monitor 绕过 cmdStart 直接 spawn daemon，故 daemon 侧只靠 Task 2 warn。TTY 守卫用 `process.stdin.isTTY`。
4. Task 4：owners 询问开独立短 `rl`（runInteractive 的 rl 已关闭），非交互式跳过；owners 配置不依赖网络，aid 生成失败也能配。
5. 测试用 `git add -f`（`/tests/` 被 gitignore）。

**与已合并 Part 1 的关系**：本计划复用 Part 1 的 `evolclaw.json` / `loadEvolclawConfig` / `cmdInit` 单一出口 / `initTail`。不回改 Part 1 已交付逻辑，仅在 `initTail` 末尾追加、在 `index.ts` 上移 `evolclawCfg`。
