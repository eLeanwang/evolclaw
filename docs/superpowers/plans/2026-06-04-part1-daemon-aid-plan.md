# Part 1 — daemon AID 身份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 evolclaw daemon 增加一个进程级控制 AID（`ec`+5位数字），在 `evolclaw init` 时生成、`evolclaw.json` 持久化、daemon 启动时连接 AUN、`evolclaw status` 展示其连接状态。顺带把旧 `config.json`（`ProcessConfig`）吞并进 `evolclaw.json` 并废弃。

**Architecture:** 新建进程级配置文件 `evolclaw.json`（`EvolclawConfig`），与 agent 合并链解耦，并吸收旧 `config.json` 的 `aun.encryptionSeed`。init 流程生成 AID（`store.exists` 权威 PKI 查重 + fail-fast + agent.md 不上传），写回配置。daemon 启动时若配置有 `aid` 则以 **pureIdentity 模式的 AUNChannel** 接入 AUN（纯身份在线，跳过 evolagent onboarding）。

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest。依赖 `src/aun/aid/store.ts`（`AIDStore.exists` 权威查重、`getAidStore`）、`src/aun/aid/identity.ts`（`aidCreate`；`aidLookup` 在 Task 2.5 被重写为 PKI 判据）、`src/channels/aun.ts`（`AUNChannel` + 新增 pureIdentity 模式）。

**设计文档**：`docs/superpowers/specs/2026-06-03-control-tunnel-design.md`（见顶部状态更新：Part 1 = AID 身份；转发归 fastaun SDK，不在本计划）

---

## 关键现状约束（实现前必读）

1. **`evolclaw.json` 当前不存在**：`paths.ts` 只有 `defaultsConfig`（`agents/defaults.json`，`:43`）和 `processConfig`（`config.json`，`:44`）。本计划新增 `evolclawJson` 路径 = `{root}/evolclaw.json`。
2. **`config.json`（`ProcessConfig`，`config-store.ts:149`）将被吞并进 `evolclaw.json` 并废弃**（Task 1.5）。其唯一有效字段是 `aun.encryptionSeed`（`store.ts:59` 读，派生 AID 私钥种子）；`log` 块与 `aun.gateway/keystorePath` 均无消费者（死字段）。**注意：设计文档 §三原写"config.json 保持现状"，本计划已推翻该决定。**
3. **`aidCreate(aid, opts?)`**（`aun/aid/identity.ts:177`）签名：`(aid: string, opts?: { aunPath?: string; force?: boolean }) => Promise<AidCreateResult>`。`AidCreateResult` = `{ aid, alreadyExisted, gateway, client, store }`。**调用方须 close client/store**。
4. **`aidLookup(aid)`**（`:457`）：`Promise<AidLookupResult>`，`AidLookupResult` = `{ exists, aid, gateway, content?, error? }`。**结构在 Task 2.5 后保持不变，但 `exists` 判据从"agent.md 200"改为 `store.exists` 的 PKI 证书查询。控制 AID 查重不走它，直接用 `AIDStore.exists`（见 Task 2）。**
5. **`isValidAid`** 由 `aun/aid/index.js` 导出。`AIDStore.exists(aid)`（fastaun 0.4.8，`aid-store.d.ts:90`）返回 `Promise<Result<{ exists: boolean }>>`，HEAD PKI 证书 URL（200=已注册/404=未注册），是权威注册判据。
6. **`cmdInit`**（`cli/init.ts:49`）是 init 入口。
7. **`AUNChannel`**（`channels/aun.ts:105`）是 class；`AUNConfig` 接口含 `{ aid, gateway?, owner?, agentName?, ... }`。daemon 装配在 `index.ts`（AUNChannelPlugin.createChannels）。
8. **不可在测试代码用 `Math.random()` 的限制只针对 workflow 脚本**；本项目正常运行时代码可用 `crypto`/`Math.random`。AID 生成用 `crypto.randomInt`。

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/paths.ts` | 新增 `evolclawJson` 路径 | Modify |
| `src/evolclaw-config.ts` | `EvolclawConfig` 类型（含 `aun` 块）+ `loadEvolclawConfig`/`saveEvolclawConfig` | Create |
| `src/config-store.ts` | `migrateProcessConfigIfNeeded` + 废弃 `ProcessConfig` | Modify |
| `src/aun/aid/store.ts` | `getAidStore` 读 seed 源切到 `evolclaw.json` | Modify |
| `src/aun/aid/control-aid.ts` | `generateControlAid`（ec+5位 + `store.exists` 查重 + fail-fast） | Create |
| `src/aun/aid/identity.ts` | `aidLookup` 底层改用权威 PKI 查询（`store.exists`），与 agent.md 解耦 | Modify |
| `src/cli/init.ts` | 重构 `cmdInit` 为单一出口，共享 tail 生成 AID 并写回 evolclaw.json | Modify |
| `src/channels/aun.ts` | `AUNChannel` 加 `pureIdentity` 模式（纯身份连接，跳过 evolagent onboarding） | Modify |
| `src/index.ts` | 启动时读 evolclaw.json，有 aid 则以 pureIdentity AUNChannel 连接控制 AID | Modify |
| `src/cli/index.ts` | `cmdStatus` 展示控制 AID 状态 | Modify |
| `tests/unit/evolclaw-config.test.ts` | 配置读写单测 | Create |
| `tests/unit/migrate-process-config.test.ts` | config.json → evolclaw.json 迁移单测 | Create |
| `tests/unit/control-aid.test.ts` | AID 生成单测 | Create |
| `tests/unit/aid-lookup.test.ts` | `aidLookup` PKI 判据单测 | Create |
| `tests/unit/aun-pure-identity.test.ts` | `AUNChannel` pureIdentity 分流单测 | Create |

---

## Task 1: `evolclaw.json` 路径 + 配置层

**Files:**
- Modify: `src/paths.ts`（`resolvePaths()` 返回对象，`:43-44` 附近）
- Create: `src/evolclaw-config.ts`
- Test: `tests/unit/evolclaw-config.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/evolclaw-config.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEvolclawConfig, saveEvolclawConfig } from '../../src/evolclaw-config.js';
import { _resetRoot } from '../../src/paths.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evc-'));
  process.env.EVOLCLAW_HOME = tmp;
  _resetRoot();
});
afterEach(() => {
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('evolclaw-config', () => {
  it('returns empty object when file missing', () => {
    expect(loadEvolclawConfig()).toEqual({});
  });
  it('round-trips aid and tunnel', () => {
    saveEvolclawConfig({ $schema_version: 1, aid: 'ec12345.agentid.pub', tunnel: { targets: [] } });
    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec12345.agentid.pub');
    expect(cfg.tunnel?.targets).toEqual([]);
  });
  it('merge-saves without losing existing fields', () => {
    saveEvolclawConfig({ $schema_version: 1, aid: 'ec12345.agentid.pub' });
    saveEvolclawConfig({ ...loadEvolclawConfig(), debug: { logLevel: 'DEBUG' } });
    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec12345.agentid.pub');
    expect(cfg.debug?.logLevel).toBe('DEBUG');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/evolclaw-config.test.ts`
Expected: FAIL — `src/evolclaw-config.js` 不存在

- [ ] **Step 3: 加路径**

`src/paths.ts` 的 `resolvePaths()` 返回对象中，`processConfig` 行后加：

```typescript
    evolclawJson: path.join(root, 'evolclaw.json'),
```

并在 `resolvePaths` 的返回类型（若有显式 interface）加 `evolclawJson: string;`。

- [ ] **Step 4: 实现配置模块**

创建 `src/evolclaw-config.ts`：

```typescript
import { resolvePaths } from './paths.js';
import { atomicReadJson, atomicWriteJson } from './utils/atomic-write.js';
import type { DebugBlock } from './types.js';

export interface TunnelTarget {
  name: string;
  port: number;
  pathPrefix?: string;
}

export interface TunnelConfig {
  targets: TunnelTarget[];
}

export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  debug?: DebugBlock;
  tunnel?: TunnelConfig;
  // 注：`aun?: EvolclawAunConfig` 块由 Task 1.5 加入（吞并 config.json）
}

/** 读 {root}/evolclaw.json。文件不存在返回 {}，不报错。 */
export function loadEvolclawConfig(): EvolclawConfig {
  const raw = atomicReadJson<EvolclawConfig>(resolvePaths().evolclawJson);
  return raw ?? {};
}

/** 原子写入 {root}/evolclaw.json。调用方负责传完整对象（含要保留的字段）。 */
export function saveEvolclawConfig(value: EvolclawConfig): void {
  atomicWriteJson(resolvePaths().evolclawJson, value);
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `npx vitest run tests/unit/evolclaw-config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts src/evolclaw-config.ts tests/unit/evolclaw-config.test.ts
git commit -m "feat(config): add evolclaw.json process-level config layer"
```

---

## Task 1.5: 吞并 config.json → evolclaw.json（废弃 ProcessConfig）

**Files:**
- Modify: `src/evolclaw-config.ts`（`EvolclawConfig` 加 `aun` 块）
- Modify: `src/aun/aid/store.ts`（`getAidStore` 读取源切换）
- Modify: `src/config-store.ts`（迁移函数 + 废弃 `ProcessConfig`）
- Modify: `src/paths.ts`（`processConfig` 路径标记废弃/移除）
- Modify: `src/index.ts`（启动时调用迁移）
- Test: `tests/unit/migrate-process-config.test.ts`

**背景**：`{root}/config.json`（`ProcessConfig`，`config-store.ts:149`）当前结构为 `{ $schema_version, log?, aun? }`。调研结论（实现者勿轻信、须复核）：
- `ProcessConfig.log.*`（level/retention/message_log/event_log）**零消费者**——logger 实际从 `process.env`（`LOG_LEVEL`/`MESSAGE_LOG`/`EVENT_LOG`）+ `config.debug.logLevel` 读。**死字段，迁移直接丢弃。**
- `aun.gateway` / `aun.keystorePath`：**零消费者**（仅出现在旧迁移代码 `:213`）。**丢弃。**
- `aun.encryptionSeed`：**唯一真实被读**字段（`store.ts:59`，派生 AID 私钥加密种子）。**必须原样搬运。**

**⚠️ 唯一风险点**：`encryptionSeed` 是 AID 私钥的加密种子。迁移前后 `getAidStore` 拿到的 seed 必须**逐字节一致**，否则所有已注册 AID 私钥解不开、连接全挂。**原样保留**（含 `null`：当前盘上值为 `null`，搬运后仍须是 `null`，让 `?? env ?? 'evol'` 链结果不变）。**只搬运不改值。**

**命名澄清**：本任务的目标 `{root}/evolclaw.json`（Task 1 新建）与 `config-store.ts:184` `autoMigrateIfNeeded` 处理的旧 `{root}/data/evolclaw.json`（已废弃的单体配置）**同名但不同路径、不同语义**，互不相干，勿混淆。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/migrate-process-config.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEvolclawConfig } from '../../src/evolclaw-config.js';
import { migrateProcessConfigIfNeeded } from '../../src/config-store.js';
import { resolvePaths, _resetRoot } from '../../src/paths.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evc-'));
  process.env.EVOLCLAW_HOME = tmp;
  _resetRoot();
});
afterEach(() => {
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migrateProcessConfigIfNeeded', () => {
  it('moves aun.encryptionSeed into evolclaw.json verbatim (null stays null)', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'),
      JSON.stringify({ $schema_version: 1, aun: { encryptionSeed: null } }));
    migrateProcessConfigIfNeeded();
    const cfg = loadEvolclawConfig();
    // null 原样保留（hasOwnProperty 为真且值为 null）
    expect(cfg.aun).toBeDefined();
    expect(cfg.aun!.encryptionSeed).toBeNull();
    // 旧文件已归档（不再存在于原路径）
    expect(fs.existsSync(path.join(tmp, 'config.json'))).toBe(false);
  });

  it('moves a real seed string verbatim', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'),
      JSON.stringify({ $schema_version: 1, aun: { encryptionSeed: 'secret-seed' }, log: { level: 'DEBUG' } }));
    migrateProcessConfigIfNeeded();
    const cfg = loadEvolclawConfig();
    expect(cfg.aun!.encryptionSeed).toBe('secret-seed');
    // log 块（死字段）不迁移
    expect((cfg as any).log).toBeUndefined();
  });

  it('no-op when config.json absent', () => {
    migrateProcessConfigIfNeeded();
    expect(loadEvolclawConfig()).toEqual({});
  });

  it('does not clobber existing evolclaw.json fields', () => {
    fs.writeFileSync(path.join(tmp, 'evolclaw.json'),
      JSON.stringify({ $schema_version: 1, aid: 'ec12345.agentid.pub' }));
    fs.writeFileSync(path.join(tmp, 'config.json'),
      JSON.stringify({ aun: { encryptionSeed: 's' } }));
    migrateProcessConfigIfNeeded();
    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec12345.agentid.pub'); // 保留
    expect(cfg.aun!.encryptionSeed).toBe('s');   // 合并
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/migrate-process-config.test.ts`
Expected: FAIL — `migrateProcessConfigIfNeeded` 不存在；`EvolclawConfig.aun` 字段不存在

- [ ] **Step 3: `EvolclawConfig` 加 `aun` 块**

`src/evolclaw-config.ts` 的 `EvolclawConfig` 接口加（注意 `encryptionSeed` 用 `string | null` 以保 null 语义）：

```typescript
export interface EvolclawAunConfig {
  encryptionSeed?: string | null;
}

export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  debug?: DebugBlock;
  tunnel?: TunnelConfig;
  aun?: EvolclawAunConfig;   // 从旧 config.json 迁入
}
```

- [ ] **Step 4: 实现迁移函数**

`src/config-store.ts` 加（与现有 `autoMigrateIfNeeded` 并列）：

```typescript
import { loadEvolclawConfig, saveEvolclawConfig } from './evolclaw-config.js';

/**
 * 一次性迁移：{root}/config.json（ProcessConfig）→ {root}/evolclaw.json。
 * - 仅搬运 aun.encryptionSeed（逐字节原样，含 null）；log / aun.gateway / aun.keystorePath 是死字段，丢弃。
 * - 合并写入（不覆盖 evolclaw.json 已有字段如 aid）。
 * - 完成后归档 config.json → config.json.migrated（保留备份，不直接删）。
 */
export function migrateProcessConfigIfNeeded(): void {
  const p = resolvePaths();
  const oldPath = p.processConfig; // {root}/config.json
  const raw = atomicReadJson<{ aun?: { encryptionSeed?: string | null } }>(oldPath);
  if (raw === null) return; // 不存在 → no-op

  const evc = loadEvolclawConfig();
  // 仅当旧文件确实带 aun.encryptionSeed 字段时才搬（hasOwnProperty，保 null 语义）
  if (raw.aun && Object.prototype.hasOwnProperty.call(raw.aun, 'encryptionSeed')) {
    evc.aun = { ...(evc.aun ?? {}), encryptionSeed: raw.aun.encryptionSeed };
  }
  evc.$schema_version = evc.$schema_version ?? 1;
  saveEvolclawConfig(evc);

  // 归档旧文件（不删，留备份）
  try {
    fs.renameSync(oldPath, oldPath + '.migrated');
  } catch { /* ignore */ }
  logger.info('[migrate] config.json → evolclaw.json (aun.encryptionSeed 已搬运，config.json 已归档为 .migrated)');
}
```

> 注：`atomicReadJson` 对 `loadEvolclawConfig`/`loadProcessConfig` 已用，无需 `expandEnvRefs`（seed 不该做 env 展开——原样）。实现者确认 `resolvePaths`/`atomicReadJson`/`logger`/`fs` 在 config-store.ts 已 import。

- [ ] **Step 5: `getAidStore` 切换读取源**

`src/aun/aid/store.ts:55-59`：把 `loadProcessConfig().aun?.encryptionSeed` 换成 `loadEvolclawConfig().aun?.encryptionSeed`：

```typescript
  const { loadEvolclawConfig } = await import('../../evolclaw-config.js');
  // ...
  const encryptionSeed = loadEvolclawConfig().aun?.encryptionSeed
    ?? process.env.AUN_ENCRYPTION_SEED
    ?? 'evol';
```

**关键**：`?? ` 链不变 → `null`/`undefined` 都落到 `env ?? 'evol'`，行为与迁移前逐字节一致。

- [ ] **Step 6: 启动时调用迁移（在 store 被读之前）**

`src/index.ts:188` `ensureDataDirs()` 之后、`:224` 身份相关迁移附近，加：

```typescript
  migrateProcessConfigIfNeeded();
```

**顺序要求**：必须在任何 `getAidStore`（即任何 AUN 连接）之前执行，否则首次读 seed 时迁移还没发生。放在 `autoMigrateIfNeeded()` 同区即可。**同时在 `src/cli/init.ts:55` `ensureDataDirs()` 后也调一次**（init 路径也可能先于 daemon 触发 AID 生成 → 走 getAidStore）。

- [ ] **Step 7: 废弃 `ProcessConfig`**

- `src/config-store.ts`：`ProcessConfig` / `loadProcessConfig` / `saveProcessConfig` 标记 `@deprecated` 并删除（确认全仓无其它消费者——调研显示仅 `store.ts` 一处，已在 Step 5 切换）。
- `src/paths.ts:44`：`processConfig` 路径**保留**（迁移函数仍需用它定位旧文件），但加注释 `// legacy ProcessConfig path — only for migration source`。

- [ ] **Step 8: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 无 TS 错误；全 PASS（特别确认无残留 `loadProcessConfig` 引用导致编译错）

- [ ] **Step 9: 手测（seed 一致性，最关键）**

```bash
# 用现有已注册 AID 的真实环境（EVOLCLAW_HOME=/home/evolclaw）
# 1. 迁移前记录：当前 config.json 内容
cat /home/evolclaw/config.json
# 2. 启动 daemon，确认 AID 正常连接（seed 未变 → 私钥可解）
EVOLCLAW_HOME=/home/evolclaw evolclaw start && evolclaw status
# 3. 确认 config.json 已归档、evolclaw.json 含 aun.encryptionSeed（值与原一致）
ls /home/evolclaw/config.json* ; cat /home/evolclaw/evolclaw.json
```
Expected: 所有原 AID 仍 connected（私钥解密成功，证明 seed 逐字节未变）；`config.json` → `config.json.migrated`；`evolclaw.json` 含 `aun.encryptionSeed`（与原值一致，本例为 `null`）。

- [ ] **Step 10: Commit**

```bash
git add src/evolclaw-config.ts src/aun/aid/store.ts src/config-store.ts src/paths.ts src/index.ts src/cli/init.ts tests/unit/migrate-process-config.test.ts
git commit -m "refactor(config): merge config.json into evolclaw.json, deprecate ProcessConfig"
```

---

## Task 2: 控制 AID 生成（ec+5位 + 冲突检测）

**Files:**
- Create: `src/aun/aid/control-aid.ts`
- Test: `tests/unit/control-aid.test.ts`

生成 `ec` + 5位随机数字的 AID，向 Gateway 查重，冲突重试，最多 5 次。

**查重判据（关键）**：用 **`AIDStore.exists(aid)`**（fastaun 0.4.8，`aid-store.d.ts:90`）——它 HEAD 探测 **PKI 证书 URL**（200=已注册、404=未注册），是基于**证书注册**的权威判据，与 agent.md 无关。**不可用 `aidLookup`**：`aidLookup` 旧判据靠 fetch `agent.md` 是否 200，而控制 AID 按设计不上传 agent.md → 会被误判为"未注册"，查重失效。查重只需布尔，不需 content，故直接用 `store.exists`（纯 HEAD，最省，不拉 agent.md）。

**fail-fast**：`store.exists` 返回 `!ok`（网关不可达/网络错）时**立即抛错**（`Gateway 不可达`），不吞错重试——否则 Gateway 宕机会被 5 次重试掩盖成误导性的"均冲突"。仅 `ok && exists===true` 才算冲突继续下一候选。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/control-aid.test.ts`。mock `getAidStore` 返回带 `exists` 的假 store（fastaun Result 形态 `{ ok, data }` / `{ ok:false, error }`）：

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockStore = { exists: vi.fn(), close: vi.fn() };
vi.mock('../../src/aun/aid/store.js', async (orig) => ({
  ...(await orig() as any),
  getAidStore: vi.fn().mockResolvedValue(mockStore),
}));
vi.mock('../../src/aun/aid/index.js', async (orig) => ({
  ...(await orig() as any),
  aidCreate: vi.fn(),
}));

import { getAidStore } from '../../src/aun/aid/store.js';
import * as aid from '../../src/aun/aid/index.js';
import { candidateAid, generateControlAid } from '../../src/aun/aid/control-aid.js';

describe('candidateAid', () => {
  it('matches ec + 5 digits + .agentid.pub', () => {
    expect(candidateAid()).toMatch(/^ec\d{5}\.agentid\.pub$/);
  });
});

describe('generateControlAid', () => {
  it('retries on collision then succeeds', async () => {
    mockStore.exists
      .mockResolvedValueOnce({ ok: true, data: { exists: true } })   // 第1个候选已注册
      .mockResolvedValueOnce({ ok: true, data: { exists: false } }); // 第2个候选可用
    (aid.aidCreate as any).mockResolvedValue({ aid: 'ec00002.agentid.pub', alreadyExisted: false, gateway: 'g', client: { close: vi.fn() }, store: { close: vi.fn() } });

    const result = await generateControlAid();
    expect(result.aid).toMatch(/^ec\d{5}\.agentid\.pub$/);
    expect(mockStore.exists.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockStore.close).toHaveBeenCalled(); // store 复用后 finally close
  });

  it('throws after max attempts all colliding', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: true } });
    await expect(generateControlAid()).rejects.toThrow(/无法生成/);
  });

  it('fail-fast when gateway unreachable (exists !ok)', async () => {
    mockStore.exists.mockResolvedValue({ ok: false, error: { message: 'network error' } });
    await expect(generateControlAid()).rejects.toThrow(/Gateway 不可达|network error/);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/control-aid.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

创建 `src/aun/aid/control-aid.ts`：

```typescript
import crypto from 'crypto';
import { aidCreate } from './index.js';
import { getAidStore, SLOT } from './store.js';
import { logger } from '../../utils/logger.js';

const MAX_ATTEMPTS = 5;

/** 生成候选控制 AID：ec + 5位随机数字 + .agentid.pub */
export function candidateAid(): string {
  const n = crypto.randomInt(10000, 100000); // 5 位：10000-99999
  return `ec${n}.agentid.pub`;
}

export interface ControlAidResult {
  aid: string;
  gateway: string;
}

/**
 * 生成控制 AID：循环候选 → store.exists 查重（权威 PKI 判据）→ 不冲突则 aidCreate。
 * - 查重用 store.exists（HEAD 证书；不拉 agent.md，控制 AID 本就不传 agent.md）
 * - fail-fast：exists 探测失败（网关不可达）立即抛错，不掩盖成"均冲突"
 * - agent.md 不上传：aidCreate 仅注册身份 + 写私钥，不调 agentmdPut
 */
export async function generateControlAid(): Promise<ControlAidResult> {
  const store = await getAidStore({ slotId: SLOT.cli });
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const candidate = candidateAid();
      const r = await store.exists(candidate);
      if (!r.ok) {
        throw new Error(`Gateway 不可达，无法查重控制 AID：${r.error?.message ?? 'unknown'}`);
      }
      if (r.data.exists) {
        logger.info(`[control-aid] ${candidate} 已注册，重试 (${i + 1}/${MAX_ATTEMPTS})`);
        continue;
      }
      const created = await aidCreate(candidate);
      try {
        await created.client?.close?.();
      } finally {
        await created.store?.close?.();
      }
      return { aid: created.aid, gateway: created.gateway };
    }
    throw new Error(`无法生成控制 AID：连续 ${MAX_ATTEMPTS} 次候选均冲突`);
  } finally {
    store.close();
  }
}
```

注意：
1. `aidCreate` 默认**不上传 agent.md**（`identity.ts:177` 签名 `opts?: { aunPath?; force? }` 无 agent.md 选项；实现时核对其内部不调 `agentmdPut`/`agentmdSync`）。
2. 查重 store（`SLOT.cli`）与 `aidCreate` 内部另开的 store（也 `SLOT.cli`，`identity.ts:188/223`）是两个实例，slot 一致，可接受。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/control-aid.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/aun/aid/control-aid.ts tests/unit/control-aid.test.ts
git commit -m "feat(aid): add control AID generation (ec+5digit, store.exists collision check, fail-fast)"
```

---

## Task 2.5: `aidLookup` 底层改用权威 PKI 查询

**Files:**
- Modify: `src/aun/aid/identity.ts`（`aidLookup` `:457`）
- Test: `tests/unit/aid-lookup.test.ts`

**背景**：`aidLookup`（`identity.ts:457`）当前用 fetch `https://<aid>/agent.md` 是否 200 判定 `exists`——对**不传 agent.md** 的 AID（如控制 AID）会误判为"未注册"。Task 2 已为查重引入权威判据 `store.exists`；本任务顺带把 `aidLookup` 的 `exists` 判据也升级为 PKI 证书查询，**统一判据，消除新旧两套**。

**职责区分**（为何不让 Task 2 直接复用 `aidLookup`）：

| | Task 2 查重 | `aidLookup` |
|---|---|---|
| 要什么 | 仅布尔 exists | exists **+ agent.md content**（watch 名字刷新、`aid lookup` 命令要看名片） |
| 路径 | `store.exists`（纯 HEAD，最省） | `store.exists` 定 exists + `agentmdGet` 拉 content |

**改动要点**：`exists` 由 `store.exists()`（PKI HEAD）决定，与 content 解耦——`exists=true` 但**无 agent.md** 成为合法状态（旧实现做不到）。`AidLookupResult` 结构（`exists/aid/gateway/content?/error?`）**不变**，故两个调用点（`cli/index.ts:1727` watch 名字刷新、`:3751` `aid lookup` 命令）**零代码改动**，仅 `exists` 语义更准。`gateway` 字段保留 well-known 探测填充（维持 `aid lookup` 命令输出完整）。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aid-lookup.test.ts`。核心是验证旧实现做不到的回归：**已注册但无 agent.md → `exists:true, content:undefined`**。

```typescript
import { describe, it, expect, vi } from 'vitest';

const mockStore = { exists: vi.fn(), downloadAgentMd: vi.fn(), close: vi.fn() };
vi.mock('../../src/aun/aid/store.js', async (orig) => ({
  ...(await orig() as any),
  getAidStore: vi.fn().mockResolvedValue(mockStore),
}));
// agentmdGet 走 store.downloadAgentMd；直接 mock agentmd 模块更稳
vi.mock('../../src/aun/aid/agentmd.js', async (orig) => ({
  ...(await orig() as any),
  agentmdGet: vi.fn(),
}));

import { aidLookup } from '../../src/aun/aid/identity.js';
import { agentmdGet } from '../../src/aun/aid/agentmd.js';

describe('aidLookup (PKI-based)', () => {
  it('registered but no agent.md → exists:true, content undefined', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: true } });
    (agentmdGet as any).mockRejectedValue(new Error('agent.md not found'));
    const r = await aidLookup('ec12345.agentid.pub');
    expect(r.exists).toBe(true);
    expect(r.content).toBeUndefined();
  });

  it('registered with agent.md → exists:true, content present', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: true } });
    (agentmdGet as any).mockResolvedValue('---\nname: "Foo"\n---\n');
    const r = await aidLookup('biz.agentid.pub');
    expect(r.exists).toBe(true);
    expect(r.content).toContain('name: "Foo"');
  });

  it('not registered → exists:false', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: false } });
    const r = await aidLookup('nope.agentid.pub');
    expect(r.exists).toBe(false);
  });

  it('gateway unreachable → exists:false with error', async () => {
    mockStore.exists.mockResolvedValue({ ok: false, error: { message: 'network error' } });
    const r = await aidLookup('x.agentid.pub');
    expect(r.exists).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
```

> 实现者按本仓库 mock 风格调整导入路径。核心断言：**已注册+无 agent.md → exists:true / content undefined**（关键回归）；网关错 → exists:false + error。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/aid-lookup.test.ts`
Expected: FAIL — 旧 `aidLookup`（agent.md 判据）对"无 agent.md 已注册"返回 `exists:false`

- [ ] **Step 3: 重写 `aidLookup`**

`src/aun/aid/identity.ts:457` 重写（gateway 保留 well-known 探测；exists 用 `store.exists`；content 尽力 `agentmdGet`）：

```typescript
export async function aidLookup(aid: string): Promise<AidLookupResult> {
  // gateway：well-known 探测（保留，供 aid lookup 命令展示）
  let gateway = '';
  try {
    const gwResp = await fetch(`https://${aid}/.well-known/aun-gateway`, { redirect: 'follow' });
    if (gwResp.ok) {
      const text = await gwResp.text();
      try {
        const parsed = JSON.parse(text.trim());
        gateway = parsed.gateways?.[0]?.url ?? text.trim();
      } catch { gateway = text.trim(); }
    }
  } catch { /* ignore */ }

  const store = await getAidStore({ slotId: SLOT.cli });
  try {
    // 权威注册判据：PKI 证书 HEAD（与 agent.md 无关）
    const existsResult = await store.exists(aid);
    if (!existsResult.ok) {
      return { exists: false, aid, gateway, error: existsResult.error?.message ?? 'exists check failed' };
    }
    const exists = existsResult.data.exists;
    if (!exists) {
      return { exists: false, aid, gateway };
    }
    // 已注册：尽力拉 agent.md content（无 agent.md 不影响 exists）
    let content: string | undefined;
    try {
      content = await agentmdGet(aid, { store });
    } catch { /* registered but no agent.md — content stays undefined */ }
    return { exists, aid, gateway, content };
  } finally {
    store.close();
  }
}
```

实现者须在 `identity.ts` 顶部确认已 import `getAidStore`/`SLOT`（来自 `./store.js`）与 `agentmdGet`（来自 `./agentmd.js`）；若有循环依赖风险则用动态 `await import`。

- [ ] **Step 4: 确认通过 + 全量回归**

Run: `npx vitest run tests/unit/aid-lookup.test.ts && npm test`
Expected: 全 PASS（特别防 `cli/index.ts` watch 名字刷新 / `aid lookup` 命令回归）

- [ ] **Step 5: Commit**

```bash
git add src/aun/aid/identity.ts tests/unit/aid-lookup.test.ts
git commit -m "refactor(aid): aidLookup uses authoritative PKI exists check, decoupled from agent.md"
```

---

## Task 3: init 集成 — 重构单一出口 + 生成并写回

**Files:**
- Modify: `src/cli/init.ts`（`cmdInit` `:49-191`）

**背景**：`cmdInit` 当前有 **5 个 return 点**，分两类：
- **硬错误早返回**（不该生成 AID）：`:60` 实例运行中、`:70` 无 baseagent、`:94`/`:98` 非交互式 baseagent 非法/不可用
- **正常完成返回**（应落到 AID 生成）：`:87` 非交互式"配置已存在无 --force"、`:114` 非交互式写入完成、交互式分支末尾（`:188` finally 前）

若直接"在函数末尾加 AID 生成"，**非交互式两个出口（`:87`/`:114`）在中途就 return 了，永远到不了末尾 → 漏生成**。决策：**重构为单一出口**——消除"正常完成"类中途 return，让它们全部落到共享 tail；硬错误早返回保留。tail 统一做：(a) 提示创建 agent（收敛现有重复两份 `:109`/`:183`），(b) 生成控制 AID。

- [ ] **Step 1: 重构 cmdInit 控制流为单一出口**

在 `src/cli/init.ts` 顶部 import 区加：

```typescript
import { loadEvolclawConfig, saveEvolclawConfig } from '../evolclaw-config.js';
import { generateControlAid } from '../aun/aid/control-aid.js';
```

改造 `cmdInit`：

1. **硬错误早返回保留不动**（`:60`/`:70`/`:94`/`:98`）。
2. **非交互式分支**：
   - `:87`"配置已存在无 --force"：保留打印，但**去掉 return**（改为 `if/else` 不写 defaults，继续往下走到 tail）。
   - `:114` 的 `return` 删除，让其落到共享 tail；其中原 `:109-113` 的"提示创建 agent"移到 tail。
3. **交互式分支**：`:182-187` 的"提示创建 agent"移到 tail；`finally{rl.close()}` 保留（仅交互式分支需要，注意 readline 只在交互式分支创建，重构时 tail 不能依赖 rl）。
4. **新增共享 tail**（两分支汇合后、函数结束前执行一次）：

```typescript
  // ── 共享 tail（单一出口）：提示创建 agent + 生成控制 AID ──
  const { agents } = loadAllAgents();
  if (agents.length === 0) {
    console.log('\n提示：尚无 agent，运行以下命令创建：');
    console.log('  evolclaw agent new <aid>.agentid.pub');
  }

  // 控制 AID：daemon 进程身份。缺失则生成并写回 evolclaw.json（幂等：已存在则跳过）。
  const evc = loadEvolclawConfig();
  if (evc.aid) {
    console.log(`✓ 控制 AID 已存在: ${evc.aid}`);
  } else {
    try {
      const { aid } = await generateControlAid();
      saveEvolclawConfig({ ...evc, $schema_version: evc.$schema_version ?? 1, aid });
      console.log(`✓ 已生成控制 AID: ${aid}`);
    } catch (e: any) {
      // 无网/Gateway 不可达时降级：不中断 init，联网后重跑 evolclaw init 补全
      console.error(`⚠️ 控制 AID 生成失败（Gateway 不可达？联网后重跑 evolclaw init 补全）: ${e?.message || e}`);
    }
  }
```

> 实现要点：
> - readline (`rl`) 仅在交互式分支创建，**tail 不得引用 rl**；交互式分支的 `try/finally{rl.close()}` 要在进入 tail 前已结束（即把"提示 agent"从 finally 前的 try 内移出到 tail）。建议交互式分支用独立的 `await runInteractive()` 内部函数管理 rl 生命周期，返回后再进 tail。
> - tail 对两分支都执行一次，无重复（现有 `:109`/`:183` 两份提示合并为一份）。
> - **幂等性**：tail 只读/写 `evolclaw.json` 的 `aid` 字段（`if (!evc.aid)` 守卫），不碰 `defaults.json`；重跑 init 选"不覆盖"仍能补生成 AID（`:87` 出口已去 return）。

- [ ] **Step 2: 编译**

Run: `npm run build`
Expected: 无 TS 错误

- [ ] **Step 3: 手测矩阵（覆盖所有出口）**

需 Gateway 可达。逐一验证 AID 在每条正常路径都生成：

| 场景 | 命令 | 预期 |
|---|---|---|
| 交互式全新 | `EVOLCLAW_HOME=/tmp/evc-a npx tsx src/cli/index.ts init` | 末尾 `✓ 已生成控制 AID`，`evolclaw.json` 含 aid |
| 非交互式全新 | `EVOLCLAW_HOME=/tmp/evc-b npx tsx src/cli/index.ts init --non-interactive` | 同上（验证 `:114` 出口已落 tail） |
| 非交互式已存在 | 对 /tmp/evc-b 再跑一次 `--non-interactive` | 打印"配置已存在" + `✓ 控制 AID 已存在`（验证 `:87` 出口已落 tail、幂等） |
| 无网降级 | 断网或改 hosts 封 Gateway，跑全新 init | init 不中断，打印 `⚠️ 控制 AID 生成失败`，`evolclaw.json` 无 aid；恢复网络重跑补全 |

- [ ] **Step 4: Commit**

```bash
git add src/cli/init.ts
git commit -m "refactor(init): single-exit cmdInit; generate control AID at shared tail"
```

---

## Task 3.5: `AUNChannel` pureIdentity 模式（纯身份连接改造）

**Files:**
- Modify: `src/channels/aun.ts`
- Test: `tests/unit/aun-pure-identity.test.ts`

**背景**：控制 AID 要"纯身份在线"——连上 AUN 但**不做 evolagent onboarding**（不发 welcome、不上传 agent.md、不拉自身 agent.md）。`AUNChannel.connect()`（`aun.ts:559` → `_initClientInner` `:583`）当前无条件执行这些 evolagent 专属副作用。直接 `new AUNChannel` 接控制 AID 会：(a) 每次重连打 `agent config not found` warn（控制 AID 无 `agents/<aid>/config.json`）；(b) 一旦未来配了 owner 就触发 `agentmdPut` 上传 agent.md，违反"agent.md 不上传"硬约束。

**方案**：给 `AUNChannel` 加 `pureIdentity` 开关，在 **3 个真实分流点**短路 evolagent 行为，复用全部连接/认证/重连/flap/lifecycle 基础设施。**不抽平行连接方法**（`_initClientInner` 被 `reconnect`/`takeoverReconnect` 复用，复制会导致重连逻辑漂移）。

**slot 决策（重要）**：控制 AID **不** 单开隔离键，仍用现有写死的 `SLOT.daemon`（隔离键 `'evolclaw'`），与所有业务 evolagent 一致。理由：fastaun 的隔离键争用按 **AID** 维度发生（同 AID 多处连接才互踢），不同 AID 在同一隔离键下各自维护 token/seq，互不干扰（现状 daemon 已同槽跑多个不同 AID 的 evolagent 长连接为证）。控制 AID 只是又一个新 AID。**不新增 `slotId` 配置字段、不新增 `SLOT.control` 常量**（YAGNI）。

分流点（共 3 处）：

| 分流点 | 位置 | pureIdentity 行为 |
|---|---|---|
| welcome + agent.md 上传 | `aun.ts:759` `sendWelcomeMessage()` | 跳过（根除 warn 噪声 + 永不 `agentmdPut`） |
| 自身 agent.md 网络拉取 | `aun.ts:736` `loadSelfName()` → `fetchAndCacheSelfName` | 跳过（控制 AID 无 agent.md，省一次 404） |
| group 消息事件监听 | `aun.ts:649` `group.message_created` + `:684` `group.message_undecryptable` | 不注册（协议层不接群消息） |

**保留**（纯身份也需要）：`message.received`（私聊；Part 1 无 handler 时 `:1398` 安全 early-return，Part 2 直接复用收控制指令）、`connection.state`、`gateway.disconnect`、`message.recalled`、outbox 定时器、lifecycle 日志、flap/重连。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/aun-pure-identity.test.ts`。mock `getAidStore`/`loadClient`（不真连 Gateway），断言 pureIdentity 分流：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock store/client 层，避免真连 Gateway
const mockClient = {
  aid: 'ec12345.agentid.pub',
  on: vi.fn(),
  authenticate: vi.fn().mockResolvedValue({ gateway: 'https://gw', access_token: 't' }),
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../../src/aun/aid/store.js', async (orig) => ({
  ...(await orig() as any),
  getAidStore: vi.fn().mockResolvedValue({ close: vi.fn() }),
  loadClient: vi.fn().mockResolvedValue(mockClient),
}));
// GatewayDiscovery 走 gatewayUrl 直供，避免 well-known 网络
vi.mock('@agentunion/fastaun', async (orig) => ({
  ...(await orig() as any),
  GatewayDiscovery: class { async discover() { return 'https://gw'; } },
}));

import { AUNChannel } from '../../src/channels/aun.js';
import * as configStore from '../../src/config-store.js';

describe('AUNChannel pureIdentity', () => {
  beforeEach(() => { vi.clearAllMocks(); mockClient.on.mockClear(); });

  it('pureIdentity 模式不调用 loadAgent（不触发 welcome）', async () => {
    const loadAgentSpy = vi.spyOn(configStore, 'loadAgent');
    const ch = new AUNChannel({ aid: 'ec12345.agentid.pub', gatewayUrl: 'https://gw', pureIdentity: true });
    await ch.connect();
    expect(loadAgentSpy).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('pureIdentity 模式不注册 group 事件监听', async () => {
    const ch = new AUNChannel({ aid: 'ec12345.agentid.pub', gatewayUrl: 'https://gw', pureIdentity: true });
    await ch.connect();
    const events = mockClient.on.mock.calls.map(c => c[0]);
    expect(events).not.toContain('group.message_created');
    expect(events).not.toContain('group.message_undecryptable');
    expect(events).toContain('message.received'); // 私聊仍监听
    await ch.disconnect();
  });

  it('普通模式（pureIdentity 未设）仍注册 group 事件', async () => {
    vi.spyOn(configStore, 'loadAgent').mockReturnValue(null); // welcome 会被 null 短路
    const ch = new AUNChannel({ aid: 'biz.agentid.pub', gatewayUrl: 'https://gw' });
    await ch.connect();
    const events = mockClient.on.mock.calls.map(c => c[0]);
    expect(events).toContain('group.message_created');
    await ch.disconnect();
  });
});
```

> 注：实现者须按本仓库实际 mock 风格调整（`loadClient`/`getAidStore` 的导入路径、`fetchAndCacheSelfName` 是否需额外 mock `agentmdGet`）。核心断言是 3 条：pureIdentity 时 `loadAgent` 零调用、group 事件未注册、`message.received` 仍注册。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/aun-pure-identity.test.ts`
Expected: FAIL — `pureIdentity` 字段不存在 / 分流未实现

- [ ] **Step 3: 实现 `AUNConfig` 字段**

`src/channels/aun.ts` 的 `AUNConfig` 接口（`:64` 附近）加：

```typescript
  pureIdentity?: boolean;  // 纯身份模式：跳过 evolagent onboarding（welcome / agent.md 上传 / 自身 agent.md 拉取 / group 监听）
```

- [ ] **Step 4: 分流点 A — 跳过 welcome**

`aun.ts:759`：

```typescript
      // Send welcome message to owner after first connection
      if (!this.config.pureIdentity) {
        await this.sendWelcomeMessage();
      }
```

- [ ] **Step 5: 分流点 B — 跳过 selfName 网络拉取**

`aun.ts:736`：

```typescript
      this._selfName = this.config.pureIdentity ? undefined : this.loadSelfName(aidName);
```

- [ ] **Step 6: 分流点 C — 不注册 group 事件监听**

`aun.ts:649` 和 `:684` 的两个 group 监听用条件包裹：

```typescript
    if (!this.config.pureIdentity) {
      client.on('group.message_created', (data: unknown) => { /* 现有实现 */ });
      client.on('group.message_undecryptable', (data: unknown) => { /* 现有实现 */ });
    }
```

- [ ] **Step 7: 运行，确认通过**

Run: `npx vitest run tests/unit/aun-pure-identity.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/channels/aun.ts tests/unit/aun-pure-identity.test.ts
git commit -m "feat(aun): add pureIdentity mode to AUNChannel (skip evolagent onboarding)"
```

---

## Task 4: daemon 启动连接控制 AID

**Files:**
- Modify: `src/index.ts`（channel 注册段，`registerChannelInstance` 循环之后、IPC server `:923` 之前）

daemon 启动时若 `evolclaw.json` 有 `aid`，以 **pureIdentity** AUNChannel 接入 AUN（纯身份在线，不绑 evolagent）。

- [ ] **Step 1: 读取配置 + 装配**

在 `src/index.ts` 顶部 import 区加（`AUNChannel` 若未导入也补上，从 `./channels/aun.js`）：

```typescript
import { loadEvolclawConfig } from './evolclaw-config.js';
```

在 channel 实例注册完成后、IPC server 启动之前，加控制 AID 连接。**注意 `controlChannel` 声明在外层 scope**（IPC status provider `:923` 与 shutdown 钩子都要访问）：

```typescript
  // 控制 AID（daemon 进程身份）：pureIdentity 接入 AUN，独立于 evolagent
  const evolclawCfg = loadEvolclawConfig();
  let controlChannel: AUNChannel | undefined;
  if (evolclawCfg.aid) {
    controlChannel = new AUNChannel({
      aid: evolclawCfg.aid,
      agentName: evolclawCfg.aid,
      channelName: 'control',
      pureIdentity: true,
      aunTrace: config.debug?.aunTrace,
      aunSdkLog: config.debug?.aunSdkLog,
    });
    // connect() 失败不置空实例：AUNChannel 内部有无限重连（SDK auto_reconnect +
    // scheduleReconnect），首连失败后台会自愈；保留实例供 status 显示 disconnected。
    try {
      await controlChannel.connect();
      logger.info(`✓ 控制 AID 已连接: ${evolclawCfg.aid}`);
    } catch (e: any) {
      logger.warn(`控制 AID 首连失败（后台自动重连，不影响 daemon 主流程）: ${e?.message || e}`);
    }
  }
```

注意：`AUNConfig` 无 `gateway`/`keystorePath` 必填项（`gatewayUrl` 缺失时 `_initClientInner` `:608` 走 well-known 自动发现；`keystorePath` 缺失时 `:601` 默认 `resolveRoot()`）。slot 用 `AUNChannel` 内置 `SLOT.daemon`，**不传 slotId**（见 Task 3.5 slot 决策）。

- [ ] **Step 2: shutdown 钩子断开**

在 daemon 的 shutdown/cleanup 区（现有 `platform.onShutdown` 或 `ipcServer.stop()` 附近）加：

```typescript
  if (controlChannel) {
    try { await controlChannel.disconnect(); } catch { /* ignore */ }
  }
```

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: 无 TS 错误

- [ ] **Step 4: 手测（需 Gateway + 已 init 出 aid）**

Run: `EVOLCLAW_HOME=/tmp/evc-test evolclaw start`，查 `logs/evolclaw.log`
Expected: 出现 `✓ 控制 AID 已连接: ec#####.agentid.pub`，且**无** `agent config not found` warn（pureIdentity 已跳过 welcome）。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): connect control AID at startup as pureIdentity channel"
```

---

## Task 5: status 展示控制 AID

**Files:**
- Modify: `src/index.ts`（IPC status provider）
- Modify: `src/cli/index.ts`（`cmdStatus` 输出）

- [ ] **Step 1: IPC 暴露控制 AID 状态**

在 `src/index.ts` 构造 IPC status response 的地方（`IpcStatusResponse` 提供者），把控制 AID 状态加入。先在 `src/ipc.ts` 的 `IpcStatusResponse`（`:18`）加可选字段：

```typescript
  controlAid?: { aid: string; connected: boolean };
```

在 `index.ts` status provider 填充：

```typescript
    controlAid: evolclawCfg.aid
      ? { aid: evolclawCfg.aid, connected: !!controlChannel }
      : undefined,
```

- [ ] **Step 2: cmdStatus 输出**

在 `src/cli/index.ts` 的 `cmdStatus` 渲染区，于渠道列表后加：

```typescript
  if (status.controlAid) {
    const state = status.controlAid.connected ? 'connected' : 'disconnected';
    console.log(`control: ${status.controlAid.aid}  [${state}]`);
  } else {
    console.log(`control: not configured`);
  }
```

- [ ] **Step 3: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 无 TS 错误，全部测试 PASS

- [ ] **Step 4: 手测**

Run: `EVOLCLAW_HOME=/tmp/evc-test evolclaw status`
Expected: 输出含 `control: ec#####.agentid.pub  [connected]`

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/ipc.ts src/cli/index.ts
git commit -m "feat(status): show control AID connection state"
```

---

## Self-Review 结果

**Spec 覆盖（对照设计文档顶部「Part 1 = AID 身份」范围）**：
- ✅ `evolclaw.json` 配置层 → Task 1
- ✅ 吞并 config.json → evolclaw.json（搬 `aun.encryptionSeed`，废弃 `ProcessConfig`）→ Task 1.5
- ✅ AID 生成（ec+5位 + `store.exists` 权威查重 + fail-fast + agent.md 不上传）→ Task 2
- ✅ `aidLookup` 升级为 PKI 判据（与 agent.md 解耦，修复"无 agent.md 已注册"误判）→ Task 2.5
- ✅ init 重构单一出口 + 生成并写回（覆盖交互/非交互/已存在全部出口，幂等，无网降级）→ Task 3
- ✅ AUNChannel pureIdentity 改造（纯身份连接，不做 evolagent onboarding）→ Task 3.5
- ✅ daemon 启动连接 → Task 4
- ✅ status 展示 → Task 5
- ✅ 转发/forwarder → 明确不在本计划（归 fastaun SDK，设计文档顶部已注明）

**实现者须注意的 gap（计划已显式标注）**：
1. Task 1.5：`encryptionSeed` 是 AID 私钥种子，迁移**逐字节原样**（含 `null`），`getAidStore` 的 `?? env ?? 'evol'` 链不变；迁移须在任何 `getAidStore` 之前（`index.ts` + `cli/init.ts` 两处 `ensureDataDirs` 后调）；config.json 归档为 `.migrated` 不直接删；手测以"现有 AID 仍能连接"验证 seed 未变。**推翻设计文档 §三"config.json 保持现状"。**
2. Task 2：查重用 `AIDStore.exists`（fastaun 0.4.8，`aid-store.d.ts:90`，HEAD PKI 证书），**不用 `aidLookup`**（其旧判据靠 agent.md，对控制 AID 失效）；`exists` 探测失败 fail-fast。须核对 `aidCreate` 默认不上传 agent.md。
3. Task 2.5：`aidLookup` 保持 `AidLookupResult` 结构不变 → 两个调用点（`cli/index.ts:1727`/`:3751`）零代码改动；`exists` 改 `store.exists` 判据、content 用 `agentmdGet` 尽力拉、gateway 保留 well-known 探测。`npm test` 全量回归防 watch/aid lookup 命令退化。
4. Task 3：`cmdInit` 重构为单一出口——硬错误早返回（`:60`/`:70`/`:94`/`:98`）保留，正常完成出口（`:87`/`:114`/交互末尾）全部落共享 tail；**readline 仅交互式分支创建，tail 不得引用 rl**（建议交互式逻辑封 `runInteractive()` 内部函数管理 rl 生命周期）；幂等只动 `evolclaw.json` 的 aid 字段。手测须覆盖 4 出口矩阵。
5. Task 3.5：pureIdentity 的 3 个分流点行号（`aun.ts:736`/`:759`/`:649`+`:684`）以当前代码为准核对；slot **不改**（仍 `SLOT.daemon`，隔离键争用按 AID 维度发生，不同 AID 同槽不互踢——现状已有多 evolagent 同槽为证）。
6. Task 4：`AUNConfig` 无 gateway/keystorePath 必填项（well-known 自动发现 + `resolveRoot()` 默认）；`controlChannel` 声明在外层 scope，覆盖 shutdown 钩子与 IPC status provider；**connect() 失败不置空实例**（保留后台无限重连 + 让 status 能显示 disconnected）。

**与 Part 2 的关系**：Part 1 产出 daemon 控制 AID。Part 2（menu agent/trigger）的进程级操作通过该 AID 接收。两份计划可独立实现，Part 2 的鉴权用 `defaults.owners`（不依赖 Part 1 的 AID 连接成功）。