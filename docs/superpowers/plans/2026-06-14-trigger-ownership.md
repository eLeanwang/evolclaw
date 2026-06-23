# Trigger 归属模型修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每条 trigger 归属于执行它的 agent（`targetChannel` 解析出的 aid），消除"创建者所在 channel 解析失败兜底到 primary agent"的归属错乱。

**Architecture:** Trigger 新增显式 `schedulerAid` 字段承载归属。注册/管理路径用 `targetChannel` 解析归属 agent 并去掉 primary 兜底，解析失败报错拒绝。Scheduler 触发时做防御校验（`schedulerAid !== this.aid` 则 skip）。存量 3 条 trigger 手动从 eleanbot 迁到 wcguard。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀), vitest, Node。

**设计文档:** `docs/superpowers/specs/2026-06-14-trigger-ownership-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src/types.ts` | Trigger 接口 | 加 `schedulerAid: string` 字段 |
| `src/core/command/command-handler.ts` | 注册/管理 trigger | 注册路径用 targetChannel 解析+写 schedulerAid+去兜底；管理路径去兜底 |
| `src/core/trigger/scheduler.ts` | 调度触发 | fireTrigger 加归属校验 |
| `tests/unit/trigger-scheduler.test.ts` | scheduler 单测 | 加归属校验测试 |
| `tests/unit/trigger-ownership.test.ts` | 注册归属单测 | 新建 |
| `data/triggers/eleanbot.agentid.pub/triggers.json` | eleanbot 存量 | 手动删 3 条 |
| `data/triggers/wcguard.agentid.pub/triggers.json` | wcguard 存量 | 手动写 3 条 |

---

## Task 1: Trigger 加 schedulerAid 字段

**Files:**
- Modify: `src/types.ts:945-973`（Trigger 接口）

- [ ] **Step 1: 在 Trigger 接口加字段**

在 `src/types.ts` 的 `Trigger` 接口里，`createdByChannel: string;` 之后加一行：

```typescript
  createdByPeerId: string;
  createdByChannel: string;
  schedulerAid: string;          // 拥有/调度/执行这条 trigger 的 agent aid（= parseChannelKey(targetChannel).selfAID）
  lastFiredAt?: number;
```

- [ ] **Step 2: 验证类型编译**

Run: `cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -30`
Expected: 会报多处 `Property 'schedulerAid' is missing` —— 这是预期的，因为构造 Trigger 的地方还没加字段。记下报错位置（应包含 `command-handler.ts` 的注册处、`index.ts` 的 `__upgrade-check` seed 处、测试里的 `makeTrigger`）。下一步逐个补齐。

- [ ] **Step 3: 提交字段定义**

```bash
cd /home/evolclaw
git add src/types.ts
git commit -m "feat(trigger): add schedulerAid field to Trigger interface"
```

---

## Task 2: 修复 index.ts 的 __upgrade-check seed

**Files:**
- Modify: `src/index.ts`（`__upgrade-check` trigger 组装处，约 786-810）

- [ ] **Step 1: 定位 seed trigger 组装代码**

Run: `cd /home/evolclaw && grep -n "UPGRADE_TRIGGER_NAME\|targetChannel:\|createdByChannel:" src/index.ts | head -20`
Expected: 找到 `const trigger: import('./types.js').Trigger = {` 附近的字段赋值块。

- [ ] **Step 2: 给 seed trigger 加 schedulerAid**

读取该 trigger 对象字面量。它的 `targetChannel` 用的是 `firstChannel`（变量名可能不同，以实际为准）。在 `createdByChannel` 字段后加：

```typescript
      schedulerAid: primaryAgentForTrigger.aid,
```

理由：`__upgrade-check` 是 seed 在 primary agent 自己名下的，归属就是 primary agent 的 aid。`primaryAgentForTrigger` 在该作用域已存在（见 `src/index.ts:770`）。

- [ ] **Step 3: 验证编译**

Run: `cd /home/evolclaw && npx tsc --noEmit 2>&1 | grep -i "index.ts" | head`
Expected: index.ts 不再有 schedulerAid 相关报错。

- [ ] **Step 4: 提交**

```bash
cd /home/evolclaw
git add src/index.ts
git commit -m "feat(trigger): set schedulerAid on __upgrade-check seed trigger"
```

---

## Task 3: 注册路径——用 targetChannel 解析归属 + 写 schedulerAid + 去兜底

**Files:**
- Modify: `src/core/command/command-handler.ts:887-943`（`registerTriggerFromParsed`）
- Test: `tests/unit/trigger-ownership.test.ts`（新建）

- [ ] **Step 1: 写失败测试（新建测试文件）**

创建 `tests/unit/trigger-ownership.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TriggerManager } from '../../src/core/trigger/manager.js';
import { TriggerScheduler } from '../../src/core/trigger/scheduler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Trigger } from '../../src/types.js';

// 验证 schedulerAid 派生规则：parseChannelKey(targetChannel).selfAID
import { tryParseChannelKey } from '../../src/core/channel-loader.js';

describe('trigger schedulerAid 派生', () => {
  it('aun channel key 抽出 selfAID 作为 schedulerAid', () => {
    const key = 'aun#wcguard.agentid.pub#main';
    expect(tryParseChannelKey(key)?.selfAID).toBe('wcguard.agentid.pub');
  });

  it('feishu channel key 抽出 selfAID', () => {
    const key = 'feishu#bot.agentid.pub#main';
    expect(tryParseChannelKey(key)?.selfAID).toBe('bot.agentid.pub');
  });
});

describe('scheduler 加载带 schedulerAid 的 trigger', () => {
  let tmpDir: string;
  let manager: TriggerManager;
  let scheduler: TriggerScheduler;
  let eventBus: EventBus;

  function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
    const now = Date.now();
    return {
      id: 'own-id-1',
      name: 'own-trigger',
      scheduleType: 'delay',
      scheduleValue: String(50),
      nextFireAt: now + 50,
      targetChannel: 'aun#wcguard.agentid.pub#main',
      targetChannelId: 'group.agentid.pub/11718',
      targetSessionStrategy: 'latest',
      prompt: 'test',
      createdByPeerId: 'elean.agentid.pub',
      createdByChannel: 'aun#wcguard.agentid.pub#main',
      schedulerAid: 'wcguard.agentid.pub',
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-test-'));
    manager = new TriggerManager('wcguard.agentid.pub', tmpDir);
    eventBus = new EventBus();
    scheduler = new TriggerScheduler('wcguard.agentid.pub', manager, eventBus);
  });

  it('schedulerAid 与 scheduler aid 匹配时正常触发', async () => {
    const fired: string[] = [];
    scheduler.setFireCallback((_msg, t) => fired.push(t.id));
    const t = makeTrigger({ nextFireAt: Date.now() - 1 });
    manager.register(t);
    await scheduler.init();
    await new Promise(r => setTimeout(r, 80));
    scheduler.stop();
    expect(fired).toContain('own-id-1');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行测试确认通过（派生规则 + 加载）**

Run: `cd /home/evolclaw && npx vitest run tests/unit/trigger-ownership.test.ts 2>&1 | tail -20`
Expected: 这两个 describe 块应 PASS（派生规则和带 schedulerAid 的加载都是已成立的行为）。这是基线，确认测试脚手架可用。

- [ ] **Step 3: 改注册路径——删除开头的解析块**

在 `src/core/command/command-handler.ts` 的 `registerTriggerFromParsed` 方法（约 887 行），**删除**开头这 4 行（约 892-895）：

```typescript
    const owningAgent = this.getOwningAgent(channel);
    const scheduler = (owningAgent?.triggerScheduler ?? this.triggerScheduler) as TriggerScheduler | undefined;
    const manager = (owningAgent?.triggerManager ?? this.triggerManager) as TriggerManager | undefined;
    if (!manager || !scheduler) return { ok: false, error: '触发器功能未启用' };
```

- [ ] **Step 4: 在 targetChannelName 校验后插入新解析块**

找到这段（约 903-907，删除上述代码后行号前移）：

```typescript
    // Validate target channel exists
    const targetChannelName = parsed.targetChannel ?? channel;
    if (parsed.targetChannel && !this.adapters.has(parsed.targetChannel)) {
      return { ok: false, error: `目标渠道不存在或未启用：${parsed.targetChannel}` };
    }
```

在它**之后**插入：

```typescript
    // 用 targetChannel 解析归属 agent（谁执行归谁），不兜底到 primary
    const schedulerAid = tryParseChannelKey(targetChannelName)?.selfAID;
    const owningAgent = schedulerAid ? this.agentRegistry?.get(schedulerAid) : null;
    const scheduler = owningAgent?.triggerScheduler as TriggerScheduler | undefined;
    const manager = owningAgent?.triggerManager as TriggerManager | undefined;
    if (!manager || !scheduler || !schedulerAid) {
      return { ok: false, error: `目标 agent 不存在或未就绪：${schedulerAid ?? targetChannelName}` };
    }
```

- [ ] **Step 5: 在 trigger 对象字面量里写入 schedulerAid**

找到 `registerTriggerFromParsed` 里的 `const trigger: Trigger = {` 块（约 923 行），在 `createdByChannel: channel,` 之后加：

```typescript
      createdByPeerId: peerId,
      createdByChannel: channel,
      schedulerAid,
```

- [ ] **Step 6: 验证编译**

Run: `cd /home/evolclaw && npx tsc --noEmit 2>&1 | grep -i "command-handler.ts" | head`
Expected: 无输出（command-handler.ts 无类型错误）。

- [ ] **Step 7: 运行全部 trigger 测试**

Run: `cd /home/evolclaw && npx vitest run tests/unit/trigger-parser.test.ts tests/unit/trigger-menu.test.ts tests/unit/trigger-ownership.test.ts 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
cd /home/evolclaw
git add src/core/command/command-handler.ts tests/unit/trigger-ownership.test.ts
git commit -m "feat(trigger): resolve owner agent by targetChannel, drop primary fallback"
```

---

## Task 4: 管理路径（list/cancel/update）去兜底

**Files:**
- Modify: `src/core/command/command-handler.ts:729-732`（`handleTrigger` 开头）

- [ ] **Step 1: 定位管理路径解析块**

Run: `cd /home/evolclaw && grep -n "owningAgent?.triggerScheduler ?? this.triggerScheduler\|owningAgent?.triggerManager ?? this.triggerManager" src/core/command/command-handler.ts`
Expected: 应只剩 `handleTrigger` 里的一处（注册路径已在 Task 3 改掉）。记下行号（约 731-732）。

- [ ] **Step 2: 去掉 primary 兜底**

将该处（约 730-732）：

```typescript
    const owningAgent = this.getOwningAgent(channel);
    const scheduler = (owningAgent?.triggerScheduler ?? this.triggerScheduler) as TriggerScheduler | undefined;
    const manager = (owningAgent?.triggerManager ?? this.triggerManager) as TriggerManager | undefined;
```

改为：

```typescript
    const owningAgent = this.getOwningAgent(channel);
    const scheduler = owningAgent?.triggerScheduler as TriggerScheduler | undefined;
    const manager = owningAgent?.triggerManager as TriggerManager | undefined;
```

注意：管理路径无 manager 时已有 `⚠️ 触发器功能未启用` 提示（如 line 736），保持不变。

- [ ] **Step 3: 验证编译**

Run: `cd /home/evolclaw && npx tsc --noEmit 2>&1 | grep -i "command-handler.ts" | head`
Expected: 无输出。

- [ ] **Step 4: 确认 this.triggerScheduler/Manager 是否还有引用**

Run: `cd /home/evolclaw && grep -n "this.triggerScheduler\|this.triggerManager" src/core/command/command-handler.ts`
Expected: 仅剩 `setTriggerScheduler` 赋值处（约 153-155）和私有字段声明（约 94-95）。这些保留——`index.ts:771` 仍会调用 `setTriggerScheduler`，字段本身不删（避免牵连 setter 接口），只是注册/管理路径不再读它。这是有意保留的死引用，下一步加注释说明。

- [ ] **Step 5: 给保留字段加注释**

在 `src/core/command/command-handler.ts` 的字段声明处（约 94-95）：

```typescript
  private triggerScheduler?: TriggerScheduler;
  private triggerManager?: TriggerManager;
```

改为：

```typescript
  // 注：trigger 归属已改为按 targetChannel/channel 解析 owning agent 的 scheduler/manager。
  // 以下字段仅保留 setTriggerScheduler 接口兼容（index.ts 仍调用），注册/管理路径不再读取，避免 primary 兜底。
  private triggerScheduler?: TriggerScheduler;
  private triggerManager?: TriggerManager;
```

- [ ] **Step 6: 提交**

```bash
cd /home/evolclaw
git add src/core/command/command-handler.ts
git commit -m "feat(trigger): drop primary fallback in trigger management path"
```

---

## Task 5: Scheduler 触发时归属校验

**Files:**
- Modify: `src/core/trigger/scheduler.ts:221-250`（`fireTrigger`）
- Test: `tests/unit/trigger-scheduler.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/trigger-scheduler.test.ts` 的 `describe('TriggerScheduler', ...)` 块内，加一个测试（放在已有 `it(...)` 之间即可）：

```typescript
  it('skips trigger whose schedulerAid mismatches scheduler aid', async () => {
    const fired: string[] = [];
    scheduler.setFireCallback((_msg, t) => fired.push(t.id));

    // scheduler 的 aid 是 'test-aid'（见 beforeEach），构造一条归属别人的 trigger
    const t = makeTrigger({ nextFireAt: Date.now() + 50, schedulerAid: 'other.agentid.pub' });
    manager.register(t);
    scheduler.register(t);

    await vi.advanceTimersByTimeAsync(60);
    expect(fired).toHaveLength(0);
  });

  it('fires trigger whose schedulerAid matches scheduler aid', async () => {
    const fired: string[] = [];
    scheduler.setFireCallback((_msg, t) => fired.push(t.id));

    const t = makeTrigger({ nextFireAt: Date.now() + 50, schedulerAid: 'test-aid' });
    manager.register(t);
    scheduler.register(t);

    await vi.advanceTimersByTimeAsync(60);
    expect(fired).toContain('sched-id-1');
  });
```

同时更新该文件顶部的 `makeTrigger` 工厂，给默认对象补 `schedulerAid`（避免其它已有测试因缺字段编译失败）。找到 `makeTrigger` 里 `createdByChannel: 'feishu-main',` 之后加：

```typescript
    createdByChannel: 'feishu-main',
    schedulerAid: 'test-aid',
```

理由：该文件其它测试的 scheduler aid 都是 `'test-aid'`，默认 schedulerAid 设为 `'test-aid'` 让它们继续通过校验。

- [ ] **Step 2: 运行测试确认 mismatch 测试失败**

Run: `cd /home/evolclaw && npx vitest run tests/unit/trigger-scheduler.test.ts 2>&1 | tail -25`
Expected: `skips trigger whose schedulerAid mismatches` FAIL（当前 fireTrigger 无校验，会照常触发，fired 长度为 1 而非 0）。`matches` 测试和其它已有测试 PASS。

- [ ] **Step 3: 在 fireTrigger 加校验**

在 `src/core/trigger/scheduler.ts` 的 `fireTrigger` 方法（约 221 行），`const fresh = this.manager.getByIdFresh(trigger.id) ?? trigger;` 之后、`const messageId = ...` 之前，插入：

```typescript
    const fresh = this.manager.getByIdFresh(trigger.id) ?? trigger;

    // 归属防御：schedulerAid 与本 scheduler 的 aid 不一致 → 错位数据，跳过不执行。
    // 字段为空（旧数据未补）则跳过校验，保持向后兼容。
    if (fresh.schedulerAid && fresh.schedulerAid !== this.aid) {
      logger.warn(`[${this.aid}] schedulerAid mismatch: trigger ${fresh.name} (${fresh.id}) owned by ${fresh.schedulerAid}, skipping`);
      return;
    }

    const messageId = `trigger:${fresh.id}:${now}`;
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `cd /home/evolclaw && npx vitest run tests/unit/trigger-scheduler.test.ts 2>&1 | tail -25`
Expected: 全部 PASS，含新加的两个测试。

- [ ] **Step 5: 验证编译**

Run: `cd /home/evolclaw && npx tsc --noEmit 2>&1 | grep -i "scheduler.ts" | head`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
cd /home/evolclaw
git add src/core/trigger/scheduler.ts tests/unit/trigger-scheduler.test.ts
git commit -m "feat(trigger): defensive schedulerAid check in fireTrigger"
```

---

## Task 6: 全量构建 + 测试

**Files:** 无（验证步骤）

- [ ] **Step 1: 修补其它因新字段失败的测试**

Run: `cd /home/evolclaw && npx tsc --noEmit 2>&1 | head -30`
Expected: 若仍有 `schedulerAid is missing` 报错（如 `trigger-manager.test.ts`、`trigger-reply-context.test.ts`、`integration/trigger*.test.ts` 里的 trigger 字面量），逐个补 `schedulerAid`。补法：测试里构造 Trigger 的地方，按其 `targetChannel`/`createdByChannel` 填一个合理 aid（如该文件已有的 aid 常量，或 `'test-aid'`）。运行此步直到无输出。

- [ ] **Step 2: 全量构建**

Run: `cd /home/evolclaw && npm run build 2>&1 | tail -10`
Expected: 构建成功，无 TS 报错。

- [ ] **Step 3: 全量单测**

Run: `cd /home/evolclaw && npm test 2>&1 | tail -30`
Expected: 全绿。若有 trigger 相关红，回到 Step 1 补字段。

- [ ] **Step 4: 提交（若 Step 1 改了测试）**

```bash
cd /home/evolclaw
git add tests/
git commit -m "test(trigger): add schedulerAid to trigger fixtures"
```

---

## Task 7: 存量数据迁移（手动，需停服务）

**Files:**
- Modify: `data/triggers/eleanbot.agentid.pub/triggers.json`
- Create/Modify: `data/triggers/wcguard.agentid.pub/triggers.json`

> ⚠️ 此 Task 改运行时数据，**必须在 evolclaw 服务停止时执行**，避免与运行中的 scheduler 写盘竞争。迁移后重启。

- [ ] **Step 1: 停止服务**

Run: `cd /home/evolclaw && EVOLCLAW_HOME=/home/evolclaw evolclaw stop 2>&1 | tail -5`
Expected: 服务停止确认。

- [ ] **Step 2: 备份两个文件**

```bash
cd /home/evolclaw
cp data/triggers/eleanbot.agentid.pub/triggers.json /tmp/eleanbot-triggers.bak.json
[ -f data/triggers/wcguard.agentid.pub/triggers.json ] && cp data/triggers/wcguard.agentid.pub/triggers.json /tmp/wcguard-triggers.bak.json || echo "wcguard triggers.json 不存在（将新建）"
```

- [ ] **Step 3: 读取当前 eleanbot triggers.json**

Run: `cd /home/evolclaw && cat data/triggers/eleanbot.agentid.pub/triggers.json`
Expected: 看到 4 条 trigger：`__upgrade-check`（保留）+ 3 条 wcguard（迁出）。记下 3 条 wcguard trigger 的完整 JSON。

- [ ] **Step 4: 用脚本完成迁移（一次性 node 脚本，幂等校验）**

创建并运行迁移脚本 `/tmp/migrate-triggers.mjs`：

```javascript
import fs from 'fs';
const ELEAN = '/home/evolclaw/data/triggers/eleanbot.agentid.pub/triggers.json';
const WC_DIR = '/home/evolclaw/data/triggers/wcguard.agentid.pub';
const WC = `${WC_DIR}/triggers.json`;

const elean = JSON.parse(fs.readFileSync(ELEAN, 'utf8'));
const wc = fs.existsSync(WC) ? JSON.parse(fs.readFileSync(WC, 'utf8')) : { triggers: {} };
if (!wc.triggers) wc.triggers = {};

const moved = [];
for (const [id, t] of Object.entries(elean.triggers ?? {})) {
  if (t.targetChannel === 'aun#wcguard.agentid.pub#main') {
    t.schedulerAid = 'wcguard.agentid.pub';   // 补归属字段
    wc.triggers[id] = t;
    delete elean.triggers[id];
    moved.push(t.name);
  }
}

fs.mkdirSync(WC_DIR, { recursive: true });
fs.writeFileSync(WC, JSON.stringify(wc, null, 2));
fs.writeFileSync(ELEAN, JSON.stringify(elean, null, 2));
console.log('moved:', moved);
console.log('eleanbot 剩余:', Object.keys(elean.triggers ?? {}).length);
console.log('wcguard 现有:', Object.keys(wc.triggers ?? {}).length);
```

Run: `cd /home/evolclaw && node /tmp/migrate-triggers.mjs`
Expected: `moved: [ 'wcguard-hourly-health', 'wcguard-daily-summary', 'wcguard-daily-rally' ]`，eleanbot 剩余 1（`__upgrade-check`），wcguard 现有 3。

- [ ] **Step 5: 校验迁移结果**

Run: `cd /home/evolclaw && node -e "const w=require('./data/triggers/wcguard.agentid.pub/triggers.json'); for(const t of Object.values(w.triggers)) console.log(t.name, '| schedulerAid:', t.schedulerAid, '| target:', t.targetChannel)"`
Expected: 3 条都打印 `schedulerAid: wcguard.agentid.pub`，target 都是 `aun#wcguard.agentid.pub#main`。

- [ ] **Step 6: 校验 eleanbot 只剩 __upgrade-check**

Run: `cd /home/evolclaw && node -e "const e=require('./data/triggers/eleanbot.agentid.pub/triggers.json'); console.log(Object.values(e.triggers).map(t=>t.name))"`
Expected: `[ '__upgrade-check' ]`。

- [ ] **Step 7: 重启服务**

Run: `cd /home/evolclaw && EVOLCLAW_HOME=/home/evolclaw evolclaw start 2>&1 | tail -10`
Expected: 启动成功。

- [ ] **Step 8: 验证 wcguard scheduler 加载 3 条**

Run: `cd /home/evolclaw && sleep 5 && grep "wcguard.agentid.pub] Scheduler initialized" logs/evolclaw.log | tail -1`
Expected: `[wcguard.agentid.pub] Scheduler initialized with 3 trigger(s)`。

- [ ] **Step 9: 清理临时脚本**

```bash
rm -f /tmp/migrate-triggers.mjs
```

---

## Task 8: 运行时验证（整点触发）

**Files:** 无（观察验证）

- [ ] **Step 1: 等待下一个整点（或临时建一条 delay trigger 验证）**

下一个整点 `wcguard-hourly-health` 触发时，观察日志：

Run: `cd /home/evolclaw && grep "Firing trigger\|schedulerAid mismatch" logs/evolclaw.log | tail -10`
Expected: 看到 `[wcguard.agentid.pub] Firing trigger: wcguard-hourly-health`（由 wcguard 自己的 scheduler 触发），**不应**出现 `[eleanbot.agentid.pub] Firing trigger: wcguard-...`，也不应有 `schedulerAid mismatch` warn。

- [ ] **Step 2: 确认无重复/无错位通知**

若该次触发失败，群里应只有 **1 条** 告警（带正确任务名 + 触发时间），且发送方是 wcguard。

---

## Self-Review

**Spec coverage:**
- §字段变更 → Task 1 ✓
- §注册路径修复（含顺序调整）→ Task 3 ✓
- §管理路径一致性 → Task 4 ✓
- §执行时防御校验 → Task 5 ✓
- §存量数据迁移 → Task 7 ✓
- §Scheduler 可用性（已验证无需改） → Task 7 Step 8 验证 ✓
- §__upgrade-check seed 需补字段（spec 未单列但 schedulerAid 必填导致） → Task 2 ✓
- §错误处理表 → Task 3 Step 4（报错拒绝）、Task 5 Step 3（mismatch skip / 空跳过） ✓
- §测试策略 → Task 3/5 单测、Task 6 回归 ✓

**Placeholder scan:** 无 TBD/TODO。所有代码步骤含完整代码块。迁移脚本完整可运行。

**Type consistency:** `schedulerAid: string`（必填）贯穿 types.ts / command-handler 写入 / scheduler 读取 / 测试 fixture 一致。`tryParseChannelKey(...).selfAID`、`agentRegistry.get(aid)`、`owningAgent.triggerScheduler` 均已在探索阶段核实存在。`this.aid` 为 scheduler 构造参数（scheduler.ts:105）。

**注意点:** Task 1 加必填字段后，全代码库构造 Trigger 的地方都会编译失败。Task 2（index seed）、Task 3（注册）显式处理；Task 6 Step 1 兜底扫描并补齐所有测试 fixture。这是必填字段的预期连锁，已在计划中覆盖。
