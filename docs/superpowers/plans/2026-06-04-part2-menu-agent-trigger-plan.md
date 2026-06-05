# AUN Agent 控制面 Implementation Plan（修订版 v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AUN 网络中 `defaults.owners` 名单内的客户端通过 menu protocol 远程管理 evolagent 生命周期（create/delete/enable/disable/list/show），并补全 trigger 的 menu protocol 入口。

**Architecture:** 扩展已有 menu protocol（`message-bridge.ts` 的 `handleCustomPayload` + `command-handler.ts` 的 `execMenu*`）。新增进程级 `name=agent`（鉴权查 `defaults.owners`，不碰 session/channel 绑定）、补全关系级 `name=trigger`（复用现有 trigger 底层 API + scoped 鉴权），并把进程级 `name=system` 的鉴权从 `resolveIdentity` 迁移到 `defaults.owners`。

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest, 复用 `src/cli/agent.ts` 已导出函数 + `trigger/manager.ts`/`trigger/scheduler.ts`。

**设计文档**：`docs/superpowers/specs/2026-06-04-aun-agent-control-design.md`

---

## 修订决策记录（2026-06-04 澳清问卷结论）

本版相对原计划的 6 项决策变更，实现时以本节为准：

| # | 议题 | 决策 | 影响的 Task |
|---|---|---|---|
| D1 | `/system` 鉴权迁移破坏性 | **纯迁移 + 迁移引导**：切到 `defaults.owners`；daemon 启动时若 owners 为空 → warn；release notes 标注需配置 `defaults.owners` | Task 6 + Task 9 |
| D2 | create 的 model/chatmode 被丢弃 | **真支持**：create 成功后对 model/chatmode 调 `agentSet` 落盘 | Task 3 + Task 4 |
| D3 | create 响应时延（最坏 30s+） | **受理即返回 + 构建进度可查**：写完校验即回 `menu.response`；后台跑完整 create 各环节，每环节写入 `agents/<aid>/create-status.json`；客户端用 `menu.query name=agent` 轮询 `createProgress` 直到 `ready`/`failed` | Task 3 + Task 4 |
| D4 | trigger set/update 拼文本注入风险 | **直调底层**：set/update/cancel 用结构化 args 直接调 `manager.*`/`scheduler.*`，绕过文本拼接；list 修成每个 trigger 一个 MenuItem | Task 7 |
| D5 | 控制面入口范围 | **目标态：仅 daemon 控制 AID 入口**；**本次：先 owners 鉴权落地**（任意 agent 入口），`isControlChannel` 收紧列为 part1 完成后的跟进项 | Task 8（跟进标注） |
| D6 | 交付物 | 本修订计划即交付物，含上述全部决策 | — |

**D3 关键约束**：原 `agentCreateNonInteractive` 是同步串行 monolith（校验 → aidCreate → saveAgent → agent.md 上传重试 → IPC 热加载 30s），跑完才返回单一结果。本次方案：

1. **给 `agentCreateNonInteractive` 加可选 `onPhase` 回调**（向后兼容：CLI 不传 → 零行为变化）。回调在每个环节边界触发，把进度透出。
2. **agent 控制模块的 `execAgentAction` create 分支「受理即返回」**：做完同步必填校验后，`void runCreateInBackground(...)` 异步触发，立即返回 `{ accepted: true, aid }`。
3. **后台任务把每个环节写入 `agents/<aid>/create-status.json`**（构建进度文件），并在 D2 的 model/chatmode `agentSet` 后写终态。
4. **`agentShow` 读 `create-status.json`**，在返回里附 `createProgress`，客户端轮询感知完成/失败/卡点。

**create 各环节序列（基于 `agent.ts:592-735` 实测）**：

| # | phase | 对应代码 | 性质 | 失败语义 |
|---|---|---|---|---|
| 0 | `validating` | `:596-637` AID/baseagent/project 校验 | 同步快 | **硬失败** → abort + `failed` |
| 1 | `registering_aid` | `:642` `aidCreate` 网络注册 | 网络可慢 | **硬失败** → abort + `failed` |
| 2 | `config_saved` | `:672-673` `saveAgent` + skeleton | 落盘 | **硬失败** → abort + `failed` |
| 3 | `uploading_agentmd` | `:691-700` 生成 + 上传（3 次重试×2s） | 网络最慢 | **软失败** → `warn` 继续 |
| 4 | `applying_config` | D2 新增：model/chatmode `agentSet` | 落盘 | **软失败** → `warn` 继续 |
| 5 | `hot_loading` | `:717` IPC `evolagent.load`（30s 超时，连 AUN） | 网络可慢 | **软失败**（daemon 未运行也算正常） |
| 6 | `ready` / `failed` | 终态 | — | — |

**硬失败（0/1/2）**：create 整体失败，`status='failed'`，agent 不可用。**软失败（3/4/5）**：agent 已可用（config 已落盘），但该环节记 `warn`，终态仍为 `ready`。环节 0-2 在 `agentCreateNonInteractive` 内部用 `onPhase` 透出；环节 4（applying_config）在 `runCreateInBackground` 里、`agentCreateNonInteractive` 返回后执行。

---

## 关键现状约束（实现前必读，已逐条核实）

实现前已核实的现有代码事实，计划基于这些事实：

1. **`execMenuAction(cmd, action, args, channel, channelId, userId?)`**（`command-handler.ts:1054`）—— `userId` 即发送方 peerId（AUN 下是发送方 AID）。
2. **`execMenuQuery(cmd, channel, channelId, userId?)`**（`:803`）—— 当前签名**无 args 形参**，方法体首行 `void userId;`。
3. **`execMenuUpdate(cmd, value, channel, channelId, userId?)`**（`:935`）—— `value` 是 string。
4. **`getSubMenuItems(cmd, channel, channelId, userId?)`**（`:668`）—— 当前**不接受 args**，返回 `MenuItem[] | null`，`MenuItem` 形如 `{ value, label, desc?, selected? }`（定义在 `command-handler.ts:33`）。
5. **`MENU_NAME_MAP`**（`message-bridge.ts:232`）—— name→slash 映射表，`agent`/`trigger` 当前不在表中。未命中时 `resolveCmd` 抛 `{ code:'UNKNOWN_NAME' }`。
6. **`agentCreateNonInteractive(opts)`**（`cli/agent.ts:592`）—— opts 字段：`{ aid, baseagent?, project, owner?, name?, description?, force? }`。**`project` 必填且必须绝对路径**（内部 mkdir）；**不支持 model/chatmode**。成功返回 `{ ok:true, aid, configPath, aidCreated, agentmdUploaded?, hotLoaded?, hotLoadError? }`；失败返回 `{ ok:false, error }`。**本次给它加可选 `onPhase` 回调参数**（Task 3 Step 0），向后兼容。
7. **`agentDelete(aid, purge=false)` / `agentEnable(aid)` / `agentDisable(aid)` / `agentList()` / `agentShow(aid)` / `agentSet(aid, key, rawValue)`** 均已导出，返回 `AgentResult<T> = T | { ok:false, error:string }`（`cli/agent.ts:124-129`）。成功体含 `ok:true`。
   - `agentDelete` 成功 → `{ ok:true, aid, purged, ... }`
   - `agentEnable/Disable` 成功 → `{ ok:true, aid, enabled, reloaded }`
   - `agentSet` 成功 → `{ ok:true, aid, key, value, reloaded }`
8. **`loadDefaults()`**（`config-store.ts:89`，**同步函数**）—— 返回 `DefaultsConfig | null`。**`command-handler.ts` 当前未 import 它**，Task 2/5 需补 import。
9. **`MenuQueryRequest`/`MenuOptionsRequest`/`MenuActionRequest`**（`types.ts:904+`）—— query/options 当前只有 `{ type, id, name, cmd? }`，**无 args 字段**；action 有 `{ ..., action, args }`。
10. **`DefaultsConfig`**（`types.ts:738`）—— 有 `admins?`，**无 `owners?`**。`ProjectsBlock`（`:642`）有 `rootPath?` + `defaultPath?`。
11. **peerId 来源**：`aun.ts:1050` `const fromAid = msg.from ?? ''`，私聊 `channelId = fromAid`、`userId = fromAid`（`:1099/:1122`）。**空发送方兜底为空串**，`isProcessLevelOwner('')` 返回 false，安全。（注：spec 引用的 `aun.ts:1029` 行号有误，实际在 `:1050`。）
12. **trigger set/update 非薄逻辑**：`handleTrigger`（`:3519`）的 set 分支内联了 `calcNextFireAt`、name 自动生成、`targetSessionStrategy`（current/thread）的 session 绑定（依赖 `messageId` + adapter 能力查询）、`targetChannelType` 解析等组装逻辑后才 `manager.register`+`scheduler.register`。**直调底层（D4）必须把这段组装抽成共享方法**，不能裸调 `manager.register`。
13. **menu bridge 错误约定**：`handleMenuQuery/Options/Action/Update` 里，exec 返回含 `error` 字段即 `throw { code, message }`，被 catch 转成 `menu.response.error`（`message-bridge.ts:303-385`）。即 exec 层返回 `{ error, code }` 形状即可，bridge 自动包装。

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/types.ts` | `DefaultsConfig` 加 `owners?`；`MenuQueryRequest`/`MenuOptionsRequest` 加 `args?` | Modify |
| `src/cli/agent.ts` | `agentCreateNonInteractive` 加可选 `onPhase` 回调（构建进度插桩，向后兼容） | Modify |
| `src/core/message/create-status.ts` | 构建进度文件 `create-status.json` 读写（`CreateStatusWriter` + `readCreateStatus`） | Create |
| `src/core/command-handler.ts` | 进程级鉴权 helper；`/agent`、`/trigger`、`/system` 分支；query/options 加 args 透传；trigger 组装逻辑抽共享方法 | Modify |
| `src/core/message/command-handler-agent-control.ts` | `name=agent` 操作执行（受理即返回 create + 构建进度 + delete/enable/disable/list/show + project 兜底） | Create |
| `src/core/message/message-bridge.ts` | `MENU_NAME_MAP` 加 `agent`/`trigger`；query/options 透传 args | Modify |
| `src/cli/index.ts`（或 daemon 启动处） | 启动时 owners 为空 warn（D1 迁移引导） | Modify |
| `tests/unit/create-status.test.ts` | 构建进度读写单测 | Create |
| `tests/unit/agent-control.test.ts` | agent 控制面单测（含 createProgress） | Create |
| `tests/unit/menu-process-auth.test.ts` | 进程级鉴权单测 | Create |
| `tests/unit/trigger-menu.test.ts` | trigger menu 入口单测 | Create |

---

## Task 1: `DefaultsConfig.owners` 字段

**Files:**
- Modify: `src/types.ts`（`DefaultsConfig` interface，`:738`）
- Test: `tests/unit/menu-process-auth.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/menu-process-auth.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import type { DefaultsConfig } from '../../src/types.js';

describe('DefaultsConfig.owners', () => {
  it('accepts owners as string array', () => {
    const cfg: DefaultsConfig = {
      $schema_version: 1,
      owners: ['eleans-2022.agentid.pub'],
      admins: ['elean.agentid.pub'],
    };
    expect(cfg.owners).toEqual(['eleans-2022.agentid.pub']);
  });
});
```

- [ ] **Step 2: 运行测试，确认编译失败**

Run: `npx vitest run tests/unit/menu-process-auth.test.ts`
Expected: FAIL — TS 报 `owners` 不存在于 `DefaultsConfig`

- [ ] **Step 3: 加字段**

在 `src/types.ts` 的 `DefaultsConfig` 中，`admins?: string[];`（`:750`）上方加：

```typescript
  /** defaults.owners 提供全局 owner 基础（AID），与 per-agent owners 数组合并去重。
   *  用于进程级 menu 操作（system / agent）鉴权：仅名单内 AID 可执行。 */
  owners?: string[];
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/unit/menu-process-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/unit/menu-process-auth.test.ts
git commit -m "feat(menu): add DefaultsConfig.owners for process-level auth"
```

---

## Task 2: 进程级鉴权 helper

**Files:**
- Modify: `src/core/command-handler.ts`
- Test: `tests/unit/menu-process-auth.test.ts`

进程级（`/agent`、`/system`）鉴权：发送方 AID 必须在 `defaults.owners` 中。不调 `resolveIdentity`，不读 channel owner 绑定。

- [ ] **Step 1: 写失败测试**

向 `tests/unit/menu-process-auth.test.ts` 追加（**全部用 ESM import，禁止 require**）：

```typescript
import { isProcessLevelOwner } from '../../src/core/command-handler.js';

describe('isProcessLevelOwner', () => {
  it('allows AID in defaults.owners', () => {
    expect(isProcessLevelOwner('a.agentid.pub', { $schema_version: 1, owners: ['a.agentid.pub'] })).toBe(true);
  });
  it('rejects AID not in owners', () => {
    expect(isProcessLevelOwner('b.agentid.pub', { $schema_version: 1, owners: ['a.agentid.pub'] })).toBe(false);
  });
  it('rejects when owners missing', () => {
    expect(isProcessLevelOwner('a.agentid.pub', { $schema_version: 1 })).toBe(false);
  });
  it('rejects empty peerId', () => {
    expect(isProcessLevelOwner('', { $schema_version: 1, owners: ['a.agentid.pub'] })).toBe(false);
  });
  it('rejects null defaults', () => {
    expect(isProcessLevelOwner('a.agentid.pub', null)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/menu-process-auth.test.ts`
Expected: FAIL — `isProcessLevelOwner` 未导出

- [ ] **Step 3: 实现**

在 `src/core/command-handler.ts` 顶部 import 区确认有 `import type { DefaultsConfig } from '../types.js';`（无则加，`../types.js` 已在 `:1` import 其它符号，可合并）。在文件末尾 `CommandHandler` class **外**，加导出函数：

```typescript
/** 进程级 menu 操作（/agent、/system）鉴权：发送方 AID 必须在 defaults.owners 中。
 *  不依赖 session / channel owner 绑定，纯静态名单比对。 */
export function isProcessLevelOwner(peerId: string | undefined, defaults: DefaultsConfig | null): boolean {
  if (!peerId) return false;
  const owners = defaults?.owners ?? [];
  return owners.includes(peerId);
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/menu-process-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/command-handler.ts tests/unit/menu-process-auth.test.ts
git commit -m "feat(menu): add isProcessLevelOwner helper for process-level auth"
```

---

## Task 3: agent 控制执行模块（含 D2 model/chatmode、D3 受理即返回 + 构建进度）

**Files:**
- Create: `src/core/message/create-status.ts`（构建进度文件读写）
- Modify: `src/cli/agent.ts`（`agentCreateNonInteractive` 加 `onPhase` 回调）
- Create: `src/core/message/command-handler-agent-control.ts`
- Test: `tests/unit/create-status.test.ts`、`tests/unit/agent-control.test.ts`

把 `name=agent` 的执行逻辑独立成模块：装配参数 → 调 `cli/agent.ts` 函数 → 映射成 `{ data } | { error, code }`。

**D3 设计：create 受理即返回 + 构建进度可查。** `execAgentAction` create 分支做完**同步必填校验**后，`void runCreateInBackground(...)` 异步触发，立即返回 `{ accepted:true, aid }`。后台任务把 create 各环节（见 D3 关键约束的环节表）写入 `agents/<aid>/create-status.json`，`agentShow` 读它附 `createProgress`，客户端轮询感知完成/失败/卡点。

---

- [ ] **Step 0a: 构建进度文件读写模块（先写测试）**

创建 `tests/unit/create-status.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CreateStatusWriter, readCreateStatus, type CreatePhase } from '../../src/core/message/create-status.js';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('CreateStatusWriter', () => {
  it('records phases and reaches ready', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.begin('validating');
    w.done('validating');
    w.begin('registering_aid');
    w.done('registering_aid', 'created');
    w.finishReady();
    const s = readCreateStatus(tmpDir)!;
    expect(s.status).toBe('ready');
    expect(s.steps.find(p => p.phase === 'validating')?.state).toBe('done');
    expect(s.steps.find(p => p.phase === 'registering_aid')?.detail).toBe('created');
  });

  it('marks warn but still ready (soft failure)', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.begin('uploading_agentmd');
    w.warn('uploading_agentmd', '3 次重试后仍失败');
    w.finishReady();
    const s = readCreateStatus(tmpDir)!;
    expect(s.status).toBe('ready');
    expect(s.steps.find(p => p.phase === 'uploading_agentmd')?.state).toBe('warn');
  });

  it('finishFailed sets failed + error (hard failure)', () => {
    const w = new CreateStatusWriter(tmpDir, 'x.agentid.pub');
    w.begin('registering_aid');
    w.finishFailed('registering_aid', 'AID creation failed: network');
    const s = readCreateStatus(tmpDir)!;
    expect(s.status).toBe('failed');
    expect(s.error).toContain('network');
    expect(s.steps.find(p => p.phase === 'registering_aid')?.state).toBe('failed');
  });

  it('readCreateStatus returns null when absent', () => {
    expect(readCreateStatus(tmpDir)).toBeNull();
  });
});
```

Run: `npx vitest run tests/unit/create-status.test.ts` → FAIL（模块不存在）

- [ ] **Step 0b: 实现 `create-status.ts`**

创建 `src/core/message/create-status.ts`：

```typescript
import fs from 'fs';
import path from 'path';

export type CreatePhase =
  | 'validating' | 'registering_aid' | 'config_saved'
  | 'uploading_agentmd' | 'applying_config' | 'hot_loading';

export type StepState = 'in_progress' | 'done' | 'warn' | 'failed';

export interface CreateStep { phase: CreatePhase; state: StepState; detail?: string; ts: number; }

export interface CreateStatus {
  aid: string;
  status: 'in_progress' | 'ready' | 'failed';
  currentPhase: CreatePhase | null;
  steps: CreateStep[];
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

const FILE = 'create-status.json';

export function readCreateStatus(agentDir: string): CreateStatus | null {
  try {
    const raw = fs.readFileSync(path.join(agentDir, FILE), 'utf-8');
    return JSON.parse(raw) as CreateStatus;
  } catch { return null; }
}

/** 构建进度写入器。每次状态变更原子落盘（写临时文件 + rename）。 */
export class CreateStatusWriter {
  private status: CreateStatus;
  constructor(private agentDir: string, aid: string) {
    const now = Date.now();
    this.status = { aid, status: 'in_progress', currentPhase: null, steps: [], error: null, startedAt: now, updatedAt: now };
    fs.mkdirSync(agentDir, { recursive: true });
    this.flush();
  }
  begin(phase: CreatePhase): void {
    this.status.currentPhase = phase;
    this.status.steps.push({ phase, state: 'in_progress', ts: Date.now() });
    this.flush();
  }
  done(phase: CreatePhase, detail?: string): void { this.mark(phase, 'done', detail); }
  warn(phase: CreatePhase, detail?: string): void { this.mark(phase, 'warn', detail); }
  finishReady(): void { this.status.status = 'ready'; this.status.currentPhase = null; this.flush(); }
  finishFailed(phase: CreatePhase, error: string): void {
    this.mark(phase, 'failed', error);
    this.status.status = 'failed';
    this.status.error = error;
    this.status.currentPhase = null;
    this.flush();
  }
  private mark(phase: CreatePhase, state: StepState, detail?: string): void {
    const step = [...this.status.steps].reverse().find(s => s.phase === phase);
    if (step) { step.state = state; if (detail) step.detail = detail; step.ts = Date.now(); }
    else { this.status.steps.push({ phase, state, detail, ts: Date.now() }); }
    this.flush();
  }
  private flush(): void {
    this.status.updatedAt = Date.now();
    const file = path.join(this.agentDir, FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.status, null, 2));
    fs.renameSync(tmp, file);
  }
}
```

Run: `npx vitest run tests/unit/create-status.test.ts` → PASS

- [ ] **Step 0c: `agentCreateNonInteractive` 加 `onPhase` 回调（向后兼容）**

在 `src/cli/agent.ts`：

(a) `AgentCreateNonInteractiveOpts`（`:582`）加可选字段：
```typescript
  /** 环节进度回调（可选）。CLI 不传 → 零行为变化；后台 runner 传入以驱动 create-status。
   *  state='begin' 进入环节，'done'/'warn' 结束环节，'failed' 硬失败。 */
  onPhase?: (phase: string, state: 'begin' | 'done' | 'warn' | 'failed', detail?: string) => void;
```

(b) 在 `agentCreateNonInteractive` 体内的环节边界插桩（`opts.onPhase?.(...)`），对照 D3 环节表：
- `:596` 校验前 → `onPhase('validating','begin')`；校验全过 `:637` 后 → `onPhase('validating','done')`；**任一校验 return 失败前** → `onPhase('validating','failed', <error>)`
- `:641` 前 → `onPhase('registering_aid','begin')`；`:644` 成功后 → `onPhase('registering_aid','done', aidCreated?'created':'existed')`；`:646` catch return 前 → `onPhase('registering_aid','failed', <error>)`
- `:672` `saveAgent` 前 → `onPhase('config_saved','begin')`；`:673` 后 → `onPhase('config_saved','done')`
- `:677` agent.md 前 → `onPhase('uploading_agentmd','begin')`；成功 `:695` → `onPhase('uploading_agentmd','done')`；3 次失败 `:701` → `onPhase('uploading_agentmd','warn', lastError)`
- `:716` IPC 前 → `onPhase('hot_loading','begin')`；`:718` 成功 → `onPhase('hot_loading','done')`；否则 → `onPhase('hot_loading','warn', hotLoadError)`

**约束**：插桩只新增 `onPhase?.()` 调用，**不改动任何现有控制流/返回值**。CLI 调用方不传 `onPhase` 时行为完全不变。现有 `agentCreateNonInteractive` 测试（如有）须保持绿。

---

把 `name=agent` 的执行逻辑独立成模块。**D2 model/chatmode**：create 成功后由 `runCreateInBackground` 调 `agentSet` 落盘（属环节 `applying_config`）。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/agent-control.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/cli/agent.js', () => ({
  agentCreateNonInteractive: vi.fn(),
  agentDelete: vi.fn(),
  agentEnable: vi.fn(),
  agentDisable: vi.fn(),
  agentList: vi.fn(),
  agentShow: vi.fn(),
  agentSet: vi.fn(),
}));

// 隔离构建进度文件写盘——本测聚焦控制流，进度写入在 create-status.test.ts 单独覆盖
vi.mock('../../src/core/message/create-status.js', () => ({
  CreateStatusWriter: vi.fn().mockImplementation(() => ({
    begin: vi.fn(), done: vi.fn(), warn: vi.fn(), finishReady: vi.fn(), finishFailed: vi.fn(),
  })),
  readCreateStatus: vi.fn(() => null),
}));

import * as cliAgent from '../../src/cli/agent.js';
import { execAgentAction } from '../../src/core/message/command-handler-agent-control.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('execAgentAction create (accepted-return)', () => {
  it('rejects missing required args synchronously', async () => {
    const r = await execAgentAction('create', { name: 'X', baseagent: 'claude' }, 'peer.agentid.pub');
    expect('error' in r).toBe(true);
    expect((r as any).code).toBe('INVALID_ARGS');
  });

  it('rejects missing project (no fallback)', async () => {
    const r = await execAgentAction('create', { aid: 'x.agentid.pub', name: 'X', baseagent: 'claude' }, 'peer.agentid.pub');
    expect((r as any).code).toBe('INVALID_ARGS');
  });

  it('returns accepted immediately and fires create in background', async () => {
    (cliAgent.agentCreateNonInteractive as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', configPath: '/c', aidCreated: true });
    const r = await execAgentAction('create',
      { aid: 'x.agentid.pub', name: 'X', baseagent: 'claude', project: '/tmp/x' }, 'peer.agentid.pub');
    expect((r as any).data.accepted).toBe(true);
    expect((r as any).data.aid).toBe('x.agentid.pub');
    // 让后台 promise 跑一拍
    await new Promise(r => setImmediate(r));
    expect((cliAgent.agentCreateNonInteractive as any).mock.calls[0][0].owner).toBe('peer.agentid.pub');
  });

  it('applies model/chatmode via agentSet in background (D2)', async () => {
    (cliAgent.agentCreateNonInteractive as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', configPath: '/c', aidCreated: true });
    (cliAgent.agentSet as any).mockResolvedValue({ ok: true });
    await execAgentAction('create',
      { aid: 'x.agentid.pub', name: 'X', baseagent: 'claude', project: '/tmp/x', model: 'sonnet', chatmode: { private: 'interactive' } },
      'peer.agentid.pub');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const setKeys = (cliAgent.agentSet as any).mock.calls.map((c: any[]) => c[1]);
    expect(setKeys).toContain('active_model');   // 实现时以 agentSet 实际 key 为准，见 Step 3 注
    expect(setKeys).toContain('chatmode');
  });
});

describe('execAgentAction delete/enable/disable', () => {
  it('maps NOT_FOUND on delete of missing agent', async () => {
    (cliAgent.agentDelete as any).mockResolvedValue({ ok: false, error: 'Agent "x" not found' });
    const r = await execAgentAction('delete', { aid: 'x.agentid.pub' }, 'peer.agentid.pub');
    expect((r as any).code).toBe('NOT_FOUND');
  });

  it('returns data on enable success', async () => {
    (cliAgent.agentEnable as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', enabled: true, reloaded: true });
    const r = await execAgentAction('enable', { aid: 'x.agentid.pub' }, 'peer.agentid.pub');
    expect((r as any).data.enabled).toBe(true);
  });

  it('rejects unknown action', async () => {
    const r = await execAgentAction('frobnicate', { aid: 'x.agentid.pub' }, 'peer.agentid.pub');
    expect((r as any).code).toBe('INVALID_ARGS');
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/agent-control.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现模块**

创建 `src/core/message/command-handler-agent-control.ts`：

```typescript
import {
  agentCreateNonInteractive,
  agentDelete,
  agentEnable,
  agentDisable,
  agentSet,
} from '../../cli/agent.js';
import { logger } from '../../utils/logger.js';
import { resolvePaths } from '../../paths.js';
import path from 'path';
import { CreateStatusWriter } from './create-status.js';

export type ExecResult = { data: any } | { error: string; code: string };

/** 把 cli/agent.ts 的 error 字符串映射为结构化错误码 */
function classifyError(error: string): string {
  if (/already exists/i.test(error)) return 'CONFLICT';
  if (/not found/i.test(error)) return 'NOT_FOUND';
  if (/invalid|must be|required|缺少/i.test(error)) return 'INVALID_ARGS';
  return 'INTERNAL';
}

/** 后台异步：实际创建 agent + 落 model/chatmode，全程写构建进度（D3）。
 *  失败仅写日志 + create-status，不回传（受理即返回）。
 *  注：agentSet 的 key 名以 cli/agent.ts 实际接受的 nested key 为准
 *  （model → 'active_model' 或 'models.<baseagent>'；chatmode → 'chatmode'）。
 *  实现者须先读 agentSet + agentShow 确认 key 拼写，本处占位命名，对照校正。 */
async function runCreateInBackground(opts: {
  aid: string; name: string; baseagent: string; project: string; owner: string;
  model?: string; chatmode?: any;
}): Promise<void> {
  const agentDir = path.join(resolvePaths().agentsDir, opts.aid);
  const w = new CreateStatusWriter(agentDir, opts.aid);
  try {
    // onPhase 把 agentCreateNonInteractive 内部环节（0-3、5）映射到进度文件
    const res = await agentCreateNonInteractive({
      aid: opts.aid, name: opts.name, baseagent: opts.baseagent,
      project: opts.project, owner: opts.owner,
      onPhase: (phase, state, detail) => {
        if (state === 'begin') w.begin(phase as any);
        else if (state === 'done') w.done(phase as any, detail);
        else if (state === 'warn') w.warn(phase as any, detail);
        else if (state === 'failed') w.finishFailed(phase as any, detail ?? 'failed');
      },
    });
    if (!('ok' in res) || res.ok !== true) {
      // 硬失败：onPhase('failed') 已写终态；这里兜底（防回调未覆盖的 return 路径）
      const err = (res as any).error;
      logger.warn(`[agent-control] create ${opts.aid} failed: ${err}`);
      w.finishFailed('validating', err);   // 兜底 phase，实际 phase 已由 onPhase 标注
      return;
    }
    // 环节 4：applying_config（model/chatmode，agentCreateNonInteractive 之外）
    if (opts.model || opts.chatmode) {
      w.begin('applying_config');
      let warned: string | undefined;
      if (opts.model) {
        const r = await agentSet(opts.aid, 'active_model', opts.model);  // ← 校正 key
        if (!('ok' in r) || !r.ok) warned = `model: ${(r as any).error}`;
      }
      if (opts.chatmode) {
        const r = await agentSet(opts.aid, 'chatmode', JSON.stringify(opts.chatmode));
        if (!('ok' in r) || !r.ok) warned = `${warned ? warned + '; ' : ''}chatmode: ${(r as any).error}`;
      }
      if (warned) { logger.warn(`[agent-control] applying_config ${opts.aid}: ${warned}`); w.warn('applying_config', warned); }
      else w.done('applying_config');
    }
    w.finishReady();
    logger.info(`[agent-control] create ${opts.aid} ready`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    logger.warn(`[agent-control] create ${opts.aid} threw: ${msg}`);
    w.finishFailed('validating', msg);   // 兜底终态
  }
}

/** name=agent 的 menu.action 执行。peerId 自动填为新 agent 的 owner。
 *  create 受理即返回（D3）；delete/enable/disable 同步等结果。
 *  调用方负责传入已兜底的 args.project（见 command-handler 装配）。 */
export async function execAgentAction(
  action: string,
  args: Record<string, any> | undefined,
  peerId: string,
): Promise<ExecResult> {
  const a = args ?? {};

  if (action === 'create') {
    if (!a.aid || !a.name || !a.baseagent) {
      return { error: '缺少必填参数：aid / name / baseagent', code: 'INVALID_ARGS' };
    }
    if (!a.project || typeof a.project !== 'string') {
      return { error: 'project 缺失且无法兜底（需 defaults.projects.rootPath/defaultPath）', code: 'INVALID_ARGS' };
    }
    // D3: 受理即返回，重副作用转后台
    void runCreateInBackground({
      aid: a.aid, name: a.name, baseagent: a.baseagent,
      project: a.project, owner: peerId,
      model: a.model, chatmode: a.chatmode,
    });
    return { data: { accepted: true, aid: a.aid } };
  }

  if (action === 'delete') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = await agentDelete(a.aid, false);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    return { data: { aid: res.aid, purged: res.purged } };
  }

  if (action === 'enable' || action === 'disable') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = action === 'enable' ? await agentEnable(a.aid) : await agentDisable(a.aid);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    return { data: { aid: res.aid, enabled: res.enabled, reloaded: res.reloaded } };
  }

  return { error: `不支持的 action: ${action}`, code: 'INVALID_ARGS' };
}
```

**实现者注**：`AgentResult<T> = T | { ok:false, error }`，成功体也带 `ok:true`。判定用 `!('ok' in res) || res.ok !== true` 兼顾两种失败可能。`agentSet` 的 key 名（model/chatmode）**必须**对照 `cli/agent.ts` 的 `agentSet` + `setNestedValue` 实际接受的 keyPath 校正——本处 `active_model`/`chatmode` 为占位。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/create-status.test.ts tests/unit/agent-control.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/agent.ts src/core/message/create-status.ts src/core/message/command-handler-agent-control.ts \
  tests/unit/create-status.test.ts tests/unit/agent-control.test.ts
git commit -m "feat(menu): accepted-return create with build-progress (create-status.json) + onPhase callback + model/chatmode"
```

---

## Task 4: agent 的 query/options 执行 + project 兜底

**Files:**
- Modify: `src/core/message/command-handler-agent-control.ts`
- Test: `tests/unit/agent-control.test.ts`

补 list（options）和 show（query），并实现 create 用的 project 兜底（`defaults.projects.rootPath` 合成 `<rootPath>/<aid 第一段>`，否则 `defaults.projects.defaultPath`）。**`execAgentQuery` 附加 `createProgress`**（读 `create-status.json`）——这是 D3「构建进度可查」的客户端侧：create 受理后 config 很早落盘，`agentShow` 立即可查，再叠加进度文件让客户端轮询感知 `ready`/`failed`/卡点。

- [ ] **Step 1: 写失败测试**

向 `tests/unit/agent-control.test.ts` 追加（`readCreateStatus` 已在文件顶部 mock，可按用例覆写返回）：

```typescript
import { execAgentQuery, execAgentOptions, resolveProjectPath } from '../../src/core/message/command-handler-agent-control.js';
import { readCreateStatus } from '../../src/core/message/create-status.js';

describe('resolveProjectPath fallback', () => {
  it('uses explicit project when provided', () => {
    expect(resolveProjectPath('/tmp/explicit', 'mybot.agentid.pub', { $schema_version: 1 })).toBe('/tmp/explicit');
  });
  it('composes from rootPath + first aid segment', () => {
    expect(resolveProjectPath(undefined, 'mybot.agentid.pub',
      { $schema_version: 1, projects: { rootPath: '/data/agents' } })).toBe('/data/agents/mybot');
  });
  it('falls back to defaultPath', () => {
    expect(resolveProjectPath(undefined, 'mybot.agentid.pub',
      { $schema_version: 1, projects: { defaultPath: '/data/default' } })).toBe('/data/default');
  });
  it('returns undefined when nothing available', () => {
    expect(resolveProjectPath(undefined, 'mybot.agentid.pub', { $schema_version: 1 })).toBeUndefined();
  });
});

describe('execAgentQuery / execAgentOptions', () => {
  it('show maps NOT_FOUND', async () => {
    (cliAgent.agentShow as any).mockResolvedValue({ ok: false, error: 'Agent "x" not found' });
    const r = await execAgentQuery({ aid: 'x.agentid.pub' });
    expect((r as any).code).toBe('NOT_FOUND');
  });
  it('attaches createProgress when status file present (D3)', async () => {
    (cliAgent.agentShow as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', status: 'stopped' });
    (readCreateStatus as any).mockReturnValue({ status: 'in_progress', currentPhase: 'hot_loading', steps: [] });
    const r = await execAgentQuery({ aid: 'x.agentid.pub' });
    expect((r as any).data.createProgress.status).toBe('in_progress');
    expect((r as any).data.createProgress.currentPhase).toBe('hot_loading');
  });
  it('omits createProgress when no status file', async () => {
    (cliAgent.agentShow as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', status: 'running' });
    (readCreateStatus as any).mockReturnValue(null);
    const r = await execAgentQuery({ aid: 'x.agentid.pub' });
    expect((r as any).data.createProgress).toBeUndefined();
  });
  it('options=all returns full list', async () => {
    (cliAgent.agentList as any).mockResolvedValue({ ok: true, agents: [{ aid: 'a', status: 'running' }, { aid: 'b', status: 'disabled' }] });
    const r = await execAgentOptions({ options: 'all' });
    expect((r as any).data.agents.length).toBe(2);
  });
  it('options=enabled filters disabled', async () => {
    (cliAgent.agentList as any).mockResolvedValue({ ok: true, agents: [{ aid: 'a', status: 'running' }, { aid: 'b', status: 'disabled' }] });
    const r = await execAgentOptions({ options: 'enabled' });
    expect((r as any).data.agents.length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/unit/agent-control.test.ts`
Expected: FAIL — `execAgentQuery` / `execAgentOptions` / `resolveProjectPath` 未导出

- [ ] **Step 3: 实现**

在 `command-handler-agent-control.ts` 顶部 import 区加（`path`/`resolvePaths`/`readCreateStatus` 若 Step 0/3 已 import 则跳过）：

```typescript
import type { DefaultsConfig } from '../../types.js';
import { agentList, agentShow } from '../../cli/agent.js';
import { readCreateStatus } from './create-status.js';
```

文件内追加：

```typescript
/** project 兜底：显式值 > rootPath 合成 > defaultPath > undefined */
export function resolveProjectPath(
  explicit: string | undefined,
  aid: string,
  defaults: DefaultsConfig | null,
): string | undefined {
  if (explicit && explicit.trim()) return explicit;
  const root = defaults?.projects?.rootPath;
  if (root) return path.join(root, aid.split('.')[0]);
  return defaults?.projects?.defaultPath;
}

/** name=agent 的 menu.query：查单个 agent 详情，附构建进度（D3）。 */
export async function execAgentQuery(args: Record<string, any> | undefined): Promise<ExecResult> {
  const aid = args?.aid;
  if (!aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
  const res = await agentShow(aid);
  if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
  // 叠加构建进度（create 受理后、ready 前可见；ready 后文件仍在，可反映软失败 warn）
  const agentDir = path.join(resolvePaths().agentsDir, aid);
  const progress = readCreateStatus(agentDir);
  return { data: progress ? { ...res, createProgress: progress } : res };
}

/** name=agent 的 menu.options：列出 agent（enabled 默认 / all） */
export async function execAgentOptions(args: Record<string, any> | undefined): Promise<ExecResult> {
  const scope = args?.options === 'all' ? 'all' : 'enabled';
  const res = await agentList();
  if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
  const agents = scope === 'all'
    ? res.agents
    : res.agents.filter((x: any) => x.status !== 'disabled');
  return { data: { agents, scope } };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/unit/agent-control.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/message/command-handler-agent-control.ts tests/unit/agent-control.test.ts
git commit -m "feat(menu): add agent query/options + project fallback"
```

---

## Task 5: CommandHandler 接入 /agent + 进程级鉴权 + args 透传

**Files:**
- Modify: `src/core/command-handler.ts`（`execMenuAction` `:1054`、`execMenuQuery` `:803`、`getSubMenuItems` `:668`）
- Modify: `src/types.ts`（`MenuQueryRequest`/`MenuOptionsRequest` 加 `args?`）
- Modify: `src/core/message/message-bridge.ts`（query/options 透传 args）

在三个 menu 入口加 `/agent` 分支，进程级先鉴权。create 时在此装配兜底 project（`loadDefaults()` + peerId）。

- [ ] **Step 1: import + 类型扩展**

(a) `command-handler.ts` 顶部 import 区加：
```typescript
import { loadDefaults } from '../config-store.js';
import { execAgentAction, execAgentQuery, execAgentOptions, resolveProjectPath } from './message/command-handler-agent-control.js';
```
（`isProcessLevelOwner` 与 `execMenu*` 同文件，无需 import。）

(b) `src/types.ts`：`MenuQueryRequest` 与 `MenuOptionsRequest` 各加一行：
```typescript
  args?: Record<string, any>;
```

- [ ] **Step 2: `execMenuAction` 加 `/agent` 分支**

在 `execMenuAction`（`:1054`）方法体，`const identity = ...`（`:1061`）**之后**、`/session` 分支之前插入：

```typescript
    // ── 进程级 /agent（owners 鉴权，不依赖 session/channel） ──
    if (cmdBase === '/agent') {
      if (!isProcessLevelOwner(userId, loadDefaults())) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
      const a = { ...(args ?? {}) };
      if (action === 'create') {
        a.project = resolveProjectPath(a.project, a.aid ?? '', loadDefaults());
      }
      return await execAgentAction(action, a, userId ?? '');
    }
```

- [ ] **Step 3: `execMenuQuery` 加 args 形参 + `/agent` 分支**

(a) 签名改为：
```typescript
  async execMenuQuery(
    cmd: string, channel: string, channelId: string, userId?: string, args?: Record<string, any>
  ): Promise<{ data: any } | { error: string; code?: string }> {
```
删除方法体首行 `void userId;`（现在 userId 实际使用）。

(b) `const cmdBase = ...` 之后加：
```typescript
    if (cmdBase === '/agent') {
      if (!isProcessLevelOwner(userId, loadDefaults())) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
      return await execAgentQuery(args);
    }
```

(c) `message-bridge.ts` 的 `handleMenuQuery`（`:311`）透传 args：
```typescript
      const result = await this.cmdHandler.execMenuQuery(resolvedCmd, channel, msg.channelId, msg.peerId, (req as any).args);
```

- [ ] **Step 4: `getSubMenuItems` 加 args 形参 + `/agent` 分支**

(a) 签名改为：
```typescript
  async getSubMenuItems(cmd: string, channel: string, channelId: string, userId?: string, args?: Record<string, any>): Promise<MenuItem[] | null> {
```

(b) 在方法内现有分支旁加：
```typescript
    if (cmd === '/agent') {
      if (!isProcessLevelOwner(userId, loadDefaults())) {
        throw { code: 'FORBIDDEN', message: '操作需要 owner 权限' };
      }
      const res = await execAgentOptions(args);
      if ('error' in res) throw { code: res.code, message: res.error };
      return (res.data.agents as any[]).map(ag => ({ value: ag.aid, label: ag.name || ag.aid, desc: ag.status }));
    }
```

(c) `message-bridge.ts` 的 `handleMenuOptions`（`:331`）透传 args：
```typescript
      const data = await this.cmdHandler.getSubMenuItems(resolvedCmd, channel, msg.channelId, msg.peerId, (req as any).args) ?? [];
```

- [ ] **Step 5: 编译 + 运行测试**

Run: `npm run build && npx vitest run tests/unit/agent-control.test.ts tests/unit/menu-process-auth.test.ts`
Expected: PASS，无 TS 错误

- [ ] **Step 6: Commit**

```bash
git add src/core/command-handler.ts src/core/message/message-bridge.ts src/types.ts
git commit -m "feat(menu): wire /agent into execMenuAction/Query/options with owners auth + args passthrough"
```

---

## Task 6: MENU_NAME_MAP 注册 + /system 鉴权迁移（D1）

**Files:**
- Modify: `src/core/message/message-bridge.ts`（`MENU_NAME_MAP` `:232`）
- Modify: `src/core/command-handler.ts`（`/system` 分支，`execMenuAction` `:1119`、`execMenuQuery` `:912`）

- [ ] **Step 1: 注册 name→cmd**

`message-bridge.ts` 的 `MENU_NAME_MAP`（`:232`）加：
```typescript
    agent: '/agent',
    trigger: '/trigger',
```

- [ ] **Step 2: 写迁移测试**

向 `tests/unit/menu-process-auth.test.ts` 追加：
```typescript
describe('system uses process-level owners auth (D1 migration)', () => {
  it('owners list is the gate for /system', () => {
    expect(isProcessLevelOwner('outsider.agentid.pub', { $schema_version: 1, owners: ['op.agentid.pub'] })).toBe(false);
    expect(isProcessLevelOwner('op.agentid.pub', { $schema_version: 1, owners: ['op.agentid.pub'] })).toBe(true);
  });
});
```

- [ ] **Step 3: 迁移 `/system` 鉴权（execMenuAction `:1119`）**

把 `/system` 分支入口改为进程级统一鉴权，删除各 action 内联的 `identity.role !== 'owner'` 判断：

```typescript
    if (cmdBase === '/system') {
      if (!isProcessLevelOwner(userId, loadDefaults())) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
      if (action === 'restart') {
        // （删除原 `if (identity.role !== 'owner') return ...`）
        const restartInfo: Record<string, any> = { channel, channelId, timestamp: Date.now() };
        // ...原逻辑不变...
      }
      // upgrade 分支：删除其内联 identity.role 判断
      // check 分支：不变
    }
```

**`/cli` 不动**：`/cli`（`:1148`）虽同属进程级、也用 `identity.role==='owner'`，但**不在本次范围**（D1 仅迁移 `/system`）。保持其现状的 `resolveIdentity` 判断不变，留待未来统一。

- [ ] **Step 4: 迁移 `execMenuQuery` 的 `/system` 分支（`:912`）**

在 `/system` query 分支入口加同样的进程级鉴权闸。

- [ ] **Step 5: 编译 + 测试**

Run: `npm run build && npx vitest run tests/unit/menu-process-auth.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/message/message-bridge.ts src/core/command-handler.ts tests/unit/menu-process-auth.test.ts
git commit -m "feat(menu): register agent/trigger names; migrate /system to owners auth"
```

---

## Task 7: trigger 的 menu protocol 接入（D4 直调底层）

**Files:**
- Modify: `src/core/command-handler.ts`（抽 trigger 组装共享方法 + menu 入口分支）
- Test: `tests/unit/agent-control.test.ts` 或新建 `tests/unit/trigger-menu.test.ts`

**D4 决策**：set/update/cancel 用结构化 args **直接调** `manager.*`/`scheduler.*`，**不拼文本**。list 走 options，映射成每个 trigger 一个 MenuItem。

**关键约束（现状 12）**：`handleTrigger` 的 set 分支内联了大量组装逻辑（`calcNextFireAt`、name 自动生成、`targetSessionStrategy` 的 session/thread 绑定、`targetChannelType` 解析）。直调底层前**必须先重构**：把"从已解析参数 → 组装 Trigger 对象 → register"这段抽成私有方法 `registerTriggerFromParsed(parsed, channel, channelId, peerId, messageId)`，供文本路径（`handleTrigger`）和 menu 路径共用。

- [ ] **Step 1: 重构——抽共享组装方法**

在 `command-handler.ts` 把 `handleTrigger` set 分支（`:3640` 起）的"`const parsed = result.value;` 之后到 `scheduler.register(trigger)`"整段，抽成：

```typescript
/** 从已解析的 trigger 参数组装 Trigger 并注册。文本路径与 menu 路径共用。
 *  parsed 形状 = parseTriggerSet 的 result.value。 */
private async registerTriggerFromParsed(
  parsed: ParsedTriggerSet,            // 用 parseTriggerSet 返回值的类型
  channel: string, channelId: string, peerId: string, messageId?: string,
): Promise<{ ok: true; trigger: Trigger } | { ok: false; error: string }> {
  const owningAgent = this.getOwningAgent(channel);
  const scheduler = (owningAgent?.triggerScheduler ?? this.triggerScheduler);
  const manager = (owningAgent?.triggerManager ?? this.triggerManager);
  if (!manager || !scheduler) return { ok: false, error: '触发器功能未启用' };
  // ...原 set 分支 from calcNextFireAt 到 manager.register/scheduler.register 的逻辑...
  // 失败 return { ok:false, error }；成功 return { ok:true, trigger };
}
```

`handleTrigger` 的 set 分支改为调用此方法（保持原文本返回格式）。**此步不改变任何现有行为**，先跑现有 trigger 测试确认绿。

Run: `npx vitest run` 中 trigger 相关测试，Expected: PASS（重构无行为变化）

- [ ] **Step 2: 写 menu trigger 测试**

新建 `tests/unit/trigger-menu.test.ts`，测 menu 入口路由到底层调用。因 `CommandHandler` 装配重，用最小 stub（注入 fake manager/scheduler，验证 set 经 menu 调到 `registerTriggerFromParsed`、cancel 调到 `manager.moveToDone`+`scheduler.cancel`、admin vs scoped 查找差异）。具体 stub 方式参照 `tests/unit/` 现有 CommandHandler 测试模式。

- [ ] **Step 3: 接入 `execMenuAction` 的 `/trigger` 分支**

trigger 是关系级，**不走 owners 鉴权**，复用现有 isAdmin + scoped 逻辑。在 `execMenuAction` 加：

```typescript
    if (cmdBase === '/trigger') {
      const role = identity.role;
      const isAdmin = role === 'owner' || role === 'admin';
      if (action === 'set') {
        // args: { name, scheduleType, scheduleValue, prompt, targetSessionStrategy }
        // 直接组装 ParsedTriggerSet（绕过 parseTriggerSet 文本解析，无注入风险）
        const parsed = {
          name: args?.name,
          scheduleType: args?.scheduleType,
          scheduleValue: args?.scheduleValue,
          prompt: args?.prompt,
          targetSessionStrategy: args?.targetSessionStrategy,
          // 其余字段按 ParsedTriggerSet 可选项补 undefined
        } as any;
        const r = await this.registerTriggerFromParsed(parsed, channel, channelId, userId ?? '', undefined);
        if (!r.ok) return { error: r.error, code: classifyTriggerError(r.error) };
        return { data: { id: r.trigger.id, name: r.trigger.name, nextFireAt: r.trigger.nextFireAt } };
      }
      if (action === 'cancel') {
        const manager = ...; const scheduler = ...;  // 同 handleTrigger 解析方式
        const nameOrId = args?.nameOrId;
        if (!nameOrId) return { error: '缺少 nameOrId', code: 'INVALID_ARGS' };
        const trigger = isAdmin
          ? (manager.getByName(nameOrId) ?? manager.getById(nameOrId))
          : (manager.getByNameScoped(nameOrId, userId ?? '', channel) ?? manager.getByIdScoped(nameOrId, userId ?? '', channel));
        if (!trigger) return { error: '触发器不存在', code: 'NOT_FOUND' };
        manager.moveToDone(trigger.id, 'cancelled');
        scheduler.cancel(trigger.id);
        return { data: { id: trigger.id, cancelled: true } };
      }
      return { error: `不支持的 trigger action: ${action}`, code: 'INVALID_ARGS' };
    }
```

- [ ] **Step 4: 接入 `execMenuUpdate` 的 `/trigger` 分支（update 调度参数）**

```typescript
    if (cmdBase === '/trigger') {
      // value 是 JSON 字符串 { nameOrId, scheduleValue?, ... }
      let patch: any;
      try { patch = JSON.parse(value); } catch { return { error: 'value 需为 JSON', code: 'INVALID_ARGS' }; }
      const manager = ...; const scheduler = ...;
      const role = this.sessionManager.resolveIdentity(channel, userId).role;
      const isAdmin = role === 'owner' || role === 'admin';
      const trigger = isAdmin
        ? (manager.getByName(patch.nameOrId) ?? manager.getById(patch.nameOrId))
        : (manager.getByNameScoped(patch.nameOrId, userId ?? '', channel) ?? manager.getByIdScoped(patch.nameOrId, userId ?? '', channel));
      if (!trigger) return { error: '触发器不存在', code: 'NOT_FOUND' };
      const updated = manager.update(trigger.id, { scheduleValue: patch.scheduleValue /* ...其它可改字段 */ });
      scheduler.update(updated);
      return { data: { id: updated.id, nextFireAt: updated.nextFireAt } };
    }
```

- [ ] **Step 5: 接入 `getSubMenuItems` 的 `/trigger` 分支（list）**

修正原计划的映射 bug——每个 trigger 一个 MenuItem：

```typescript
    if (cmd === '/trigger') {
      const owningAgent = this.getOwningAgent(channel);
      const manager = (owningAgent?.triggerManager ?? this.triggerManager);
      if (!manager) return [];
      const scope = args?.options === 'all' ? 'all' : 'enabled';
      const role = this.sessionManager.resolveIdentity(channel, userId).role;
      const isAdmin = role === 'owner' || role === 'admin';
      // 列表：enabled→listActive；all→listAll。非 admin 须按 (peerId, channel) 过滤
      const list = scope === 'all' ? manager.listAll().active.concat(manager.listAll().history) : manager.listActive();
      const visible = isAdmin ? list
        : list.filter((t: any) => t.createdByPeerId === (userId ?? '') && t.createdByChannel === channel);
      return visible.map((t: any) => ({
        value: t.id,
        label: t.name,
        desc: `${t.scheduleType} | 下次 ${new Date(t.nextFireAt).toLocaleString()}`,
      }));
    }
```

**实现者注**：`manager` 的方法名（`listActive`/`listAll`/`getByNameScoped`/`moveToDone`/`update` 等）已在 `handleTrigger` 用到，照抄即可；过滤字段 `createdByPeerId`/`createdByChannel` 见 `Trigger` 类型与 set 组装处。

- [ ] **Step 6: 编译 + 全量 trigger 测试**

Run: `npm run build && npx vitest run tests/unit/trigger-menu.test.ts tests/unit/agent-control.test.ts tests/unit/menu-process-auth.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/command-handler.ts tests/unit/trigger-menu.test.ts
git commit -m "feat(menu): wire trigger into menu protocol via direct manager/scheduler calls (no text assembly)"
```

---

## Task 8: D1 迁移引导 warn + isControlChannel 跟进标注（D5）

**Files:**
- Modify: `src/cli/index.ts`（或 daemon 启动初始化处）

- [ ] **Step 1: 启动时 owners 为空 warn（D1）**

在 daemon 启动初始化处（加载 defaults 后），加：
```typescript
const defaults = loadDefaults();
if (!defaults?.owners || defaults.owners.length === 0) {
  logger.warn('[startup] defaults.owners 未配置：进程级 menu 操作（/system /agent）将一律拒绝。' +
    '如需远程管理，请在 agents/defaults.json 配置 owners: [<你的 AID>]');
}
```

定位：找 daemon 主启动流程里已 `loadDefaults()` 或可加载处（参考 `src/index.ts` 初始化段）。若该处已有 defaults 加载，复用即可。

- [ ] **Step 2: 代码内标注 isControlChannel 跟进（D5）**

在 `execMenuAction`/`execMenuQuery` 的 `/agent` 分支上方加注释，标明本次范围与后续收紧：
```typescript
    // NOTE(D5): 本次进程级 /agent 仅按 defaults.owners 鉴权，任意 evolagent 的 AUN
    // channel 均可作为入口。part1（daemon 控制 AID）落地后，应叠加 isControlChannel(channelId)
    // 闸：仅控制 AID channel 上的 /agent /system 生效。见 part1 计划。
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts src/core/command-handler.ts
git commit -m "feat(menu): warn on empty defaults.owners; annotate isControlChannel follow-up"
```

---

## Task 9: 全量回归 + 文档（含 D1 迁移说明）

**Files:**
- Modify: `README.md` 或 `docs/`（D1 迁移说明）
- Modify: `agents/defaults.json` 示例（如仓库有示例文件）

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: 无 TS 错误

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含既有 ~585 测试 + 新增）

- [ ] **Step 3: 写 D1 迁移说明**

在合适的文档（README 或 docs/）加一段：
> **Breaking（v3.x）**：进程级 menu 操作（`/system restart/upgrade`、新增的 `/agent`）的鉴权已从"channel 自动绑定 owner"迁移到 `defaults.owners` 名单。升级后**必须**在 `agents/defaults.json` 配置 `owners: [<管理者 AID>]`，否则这些操作一律 `FORBIDDEN`。

`defaults.json` 示例：
```json
{
  "$schema_version": 1,
  "owners": ["eleans-2022.agentid.pub"],
  "admins": ["elean.agentid.pub"]
}
```

- [ ] **Step 4: 手测协议（可选，需运行中的 daemon + AUN 对端）**

owner AID 发送 list：
```json
{ "type": "menu.options", "id": "1", "name": "agent", "args": { "options": "all" } }
```
Expected: `menu.response`，`data.agents` 为 agent 列表。

owner AID 发送 create：
```json
{ "type": "menu.action", "id": "2", "name": "agent", "action": "create",
  "args": { "aid": "x.agentid.pub", "name": "X", "baseagent": "claude", "model": "sonnet" } }
```
Expected: 立即收到 `data.accepted = true`（D3）。

轮询构建进度（D3）——重复发送直到 `createProgress.status` 为 `ready`/`failed`：
```json
{ "type": "menu.query", "id": "3", "name": "agent", "args": { "aid": "x.agentid.pub" } }
```
Expected: `data.createProgress` 含 `status`/`currentPhase`/`steps[]`；依次经过 `validating → registering_aid → config_saved → uploading_agentmd → applying_config → hot_loading`，终态 `status='ready'`（model 已落盘）。若某网络环节软失败，对应 step `state='warn'` 但终态仍 `ready`；若硬失败（如 AID 注册失败）则 `status='failed'` + `error`。

非 owner AID 发送 create：
Expected: `error.code = "FORBIDDEN"`。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(menu): document /system owners-auth migration; full regression for agent control plane"
```

---

## Self-Review 结果

**Spec 覆盖**：
- ✅ §四 协议格式 agent → Task 3/4/5
- ✅ §四 协议格式 trigger → Task 7
- ✅ §四 授权 owners → Task 1/2/5
- ✅ §四 system 迁移 → Task 6（+ D1 引导 Task 8/9）
- ✅ §五 复用 cli/agent.ts 函数 → Task 3/4
- ✅ §五 project 兜底 → Task 4
- ✅ §五 model/chatmode → **D2 真支持**（Task 3，create 后 agentSet）
- ✅ §七 错误码映射 → Task 3 `classifyError`
- ✅ §七 测试矩阵 → Task 2/3/4/6/7

**修订决策落点**：
- D1（/system 迁移引导）→ Task 6 + Task 8 Step 1 + Task 9 Step 3
- D2（model/chatmode 真支持）→ Task 3 `runCreateInBackground`（环节 `applying_config`）
- D3（create 受理即返回 + 构建进度可查）→ Task 3 `execAgentAction` create 分支 + `create-status.json`（环节序列）+ `onPhase` 插桩；Task 4 `execAgentQuery` 附 `createProgress`
- D4（trigger 直调底层）→ Task 7（含 Step 1 共享方法重构）
- D5（先 owners，收紧跟进）→ Task 8 Step 2 注释标注
- 修掉原计划的 ESM `require()` bug（Task 2/5 全用 import）、trigger list 映射 bug（Task 7 Step 5）、`loadDefaults` 未 import（Task 5 Step 1）

**实现者须注意的 gap（计划已显式标注）**：
1. `agentSet` 的 model/chatmode key 名（Task 3 占位 `active_model`/`chatmode`）须对照 `cli/agent.ts` 校正。
2. Task 3 Step 0c 的 `onPhase` 插桩**只新增回调、不改控制流**；现有 `agentCreateNonInteractive` 行为对不传 `onPhase` 的 CLI 调用方必须完全不变。
3. Task 7 Step 1 的共享方法重构须保证原 `handleTrigger` 行为不变（先跑现有 trigger 测试确认绿，再接 menu）。
4. `ParsedTriggerSet` 类型须从 `trigger/parser.ts` 的 `parseTriggerSet` 返回类型取。
5. D5：本次任意 agent 入口；part1 完成后须叠加 `isControlChannel` 闸。
6. `create-status.json` 落在 `agents/<aid>/`，与 agent 配置同目录；`agentDelete` 时随目录一并清理（核实 `agentDelete` 是否删整个 agent 目录，若否则补删该文件）。
