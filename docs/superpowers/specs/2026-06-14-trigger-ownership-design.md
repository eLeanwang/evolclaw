# Trigger 归属模型修复设计

**日期**: 2026-06-14
**状态**: 设计已确认

## 背景与问题

EvolClaw 的定时触发器（Trigger）系统存在归属模型缺陷。具体表现：在 wcguard 私聊里为 wcguard 创建的 3 条 trigger，实际被存进了 **eleanbot** 的 `triggers.json`，由 eleanbot 的 scheduler 调度触发。

### 根因

注册 trigger 时（`command-handler.ts:registerTriggerFromParsed`），代码用**当前会话渠道**解析归属 agent，且解析失败时兜底到 **primary agent**：

```typescript
const owningAgent = this.getOwningAgent(channel);   // channel = 创建命令所在渠道
const scheduler = owningAgent?.triggerScheduler ?? this.triggerScheduler;  // 兜底 primary
const manager   = owningAgent?.triggerManager   ?? this.triggerManager;    // 兜底 primary
```

`this.triggerScheduler/Manager` 由 `index.ts:771` 注入，等于 `runnableAgents()[0]`（primary agent = eleanbot）。当 `resolveByChannel(channel)` 没命中时（wcguard 注册时机或 channelIndex 时序问题），归属悄悄落到 eleanbot。

`/trigger list/cancel/update` 管理路径（`command-handler.ts:730-732`）用的是**同一个缺陷模式**，兜底同样落到 primary。

### 后果

- 归属错乱：wcguard 的 trigger 存在 eleanbot 名下
- 触发权错位：eleanbot 的 scheduler 触发本应属于 wcguard 的任务
- 管理盲区：在 wcguard 会话里 `/trigger list` 看不到自己的任务
- 生命周期风险：eleanbot 被禁用/删除时，wcguard 的巡检任务静默消失

### 建模缺陷

`Trigger` 结构里有 25 个字段，分两类：
- **目标类**：`targetChannel` / `targetChannelId` / `targetChatType` — 在哪执行、结果发到哪
- **来源类**：`createdByPeerId` / `createdByChannel` — 谁、从哪个会话发的命令

**缺一个"归属"字段** — 这条 trigger 归哪个 agent 调度。因为没有，"该放进哪个 TriggerManager"被迫用 `resolveByChannel(createdByChannel)` 反推，反推失败再兜底 primary，一步步偏离。

## 核心模型

**一条 trigger 归属于执行它的 agent。**

该 agent 负责三件事，全部统一在同一个 aid：

```
存储目录 aid  =  scheduler.aid  =  schedulerAid 字段  =  parseChannelKey(targetChannel).selfAID
```

- **存储**：`data/triggers/<aid>/triggers.json`
- **调度**：该 agent 的 TriggerScheduler
- **管理**：在该 agent 的会话里 `/trigger list/cancel/update`

`targetChannel` 回归本职——只表示"结果发到哪个渠道"，不再被借用作归属凭证。归属由新的显式字段 `schedulerAid` 承载。

### schedulerAid vs 人类 owner（命名澄清）

- `schedulerAid`：调度归属，指哪个 **agent**（aid）负责这条 trigger 的存储/调度/执行
- agent 的人类 owner（`config.owners`）：完全独立的维度

命名用 "scheduler" 而非 "owner"，避免与 agent 的人类 owner 混淆。

## 变更清单

### 1. 字段变更（`src/types.ts`）

`Trigger` 接口新增字段，放在 `createdByChannel` 附近（归属类字段聚拢）：

```typescript
schedulerAid: string;   // 拥有/调度/执行这条 trigger 的 agent aid
```

数值上等于 `targetChannel` 解析出的 selfAID，但语义不同：`targetChannel` 是"结果发到哪个渠道"，`schedulerAid` 是"谁负责这条 trigger"。显式字段让归属变成"读字段"，而非每处从渠道反推。

### 2. 注册路径修复（`command-handler.ts:registerTriggerFromParsed`）

用 `targetChannel` 解析归属 agent，去掉 primary 兜底。

**关键：调整解析顺序。** 现状代码在方法**开头**（行 892-895）就用 `channel` 解析 scheduler/manager，但 `targetChannelName` 要到行 904 才计算。新方案依赖 `targetChannelName`，因此必须把 scheduler/manager 的解析**移到 `targetChannelName` 计算和"目标渠道存在"校验（行 904-907）之后**。

移除开头的（行 892-895）：
```typescript
const owningAgent = this.getOwningAgent(channel);
const scheduler = (owningAgent?.triggerScheduler ?? this.triggerScheduler) as TriggerScheduler | undefined;
const manager = (owningAgent?.triggerManager ?? this.triggerManager) as TriggerManager | undefined;
if (!manager || !scheduler) return { ok: false, error: '触发器功能未启用' };
```

在 `targetChannelName` 解析（行 904）与现有渠道校验之后，插入：
```typescript
// 用 targetChannel 解析归属 agent（谁执行归谁）
const parsedKey = tryParseChannelKey(targetChannelName);
const schedulerAid = parsedKey?.selfAID;
const owningAgent = schedulerAid ? this.agentRegistry?.get(schedulerAid) : null;
const scheduler = owningAgent?.triggerScheduler as TriggerScheduler | undefined;
const manager = owningAgent?.triggerManager as TriggerManager | undefined;
if (!manager || !scheduler) {
  return { ok: false, error: `目标 agent 不存在或未就绪：${schedulerAid ?? targetChannelName}` };
}
```

`now` / `nextFireAt` / `name` 这些早期计算（行 897-901）不依赖 scheduler，可保留原位或随解析一起后移——以编译通过和可读性为准，由实现 plan 决定。

组装 trigger 对象时写入 `schedulerAid` 字段。

`this.agentRegistry.get(aid)` 为已存在方法（`evolagent-registry.ts:230`，按 aid 直接查 `this.agents.get(aid)`），无需新增。`tryParseChannelKey` 已在 `command-handler.ts` 可用或可从 `channel-loader.js` 引入。

### 3. 管理路径一致性（`command-handler.ts:handleTrigger`）

list/cancel/update 去掉 primary 兜底：

```typescript
const owningAgent = this.getOwningAgent(channel);
const scheduler = owningAgent?.triggerScheduler as TriggerScheduler | undefined;  // 不再 ?? this.triggerScheduler
const manager = owningAgent?.triggerManager as TriggerManager | undefined;
```

**语义**：你在哪个 agent 的会话里，就管理那个 agent 名下的 trigger。

**跨渠道创建的后果**（可接受）：若在 wcguard 会话里建了 `--channel other` 的 trigger，它归 other，需到 other 的会话管理——"trigger 活在它运行的地方"。主流场景 `targetChannel == createdByChannel`（给当前渠道建任务），创建后能在同一会话 list 到。

管理路径无 agent/manager 时，沿用现有的 `⚠️ 触发器功能未启用` 提示。

### 4. 执行时防御校验（`scheduler.ts:fireTrigger`）

scheduler 触发时校验归属，迁移期容错（不匹配只 warn + skip，不崩）：

```typescript
if (fresh.schedulerAid && fresh.schedulerAid !== this.aid) {
  logger.warn(`[${this.aid}] schedulerAid mismatch: trigger ${fresh.name} (${fresh.id}) owned by ${fresh.schedulerAid}, skipping`);
  return;
}
```

`this.aid` 是 scheduler 自己的 aid（= 存储目录 aid）。`schedulerAid` 为空时（旧数据未补字段）跳过校验，保持向后兼容。

放置位置：`fireTrigger` 内 `getByIdFresh` 取得 `fresh` 之后、`updateFireStats` 之前。

### 5. 存量数据迁移（手动编辑 JSON）

直接编辑两个文件：

- 从 `data/triggers/eleanbot.agentid.pub/triggers.json` **删除** 3 条 wcguard trigger（`wcguard-hourly-health` / `wcguard-daily-summary` / `wcguard-daily-rally`），保留 eleanbot 自己的 `__upgrade-check`
- 写入 `data/triggers/wcguard.agentid.pub/triggers.json`，每条补 `schedulerAid: "wcguard.agentid.pub"`

迁移需在服务停止状态下进行，避免与运行中的 scheduler 写盘竞争。迁移后重启，wcguard scheduler 在 init 时（`index.ts:469` 循环遍历所有 `runnableAgents()`，与 channel 配置无关）加载这 3 条。日志已确认 wcguard 有 scheduler（`Scheduler initialized with 0 trigger(s)`），迁移后变 3。

## Scheduler 可用性（已验证，无需改动）

每个 `runnableAgent` 在 `index.ts:469-475` 循环里都创建 TriggerManager + TriggerScheduler，**与 channel 配置无关**。wcguard 虽然 config `channels: []`（搭车 AUN sidecar），但仍是 runnableAgent，scheduler 已创建。日志佐证：`[wcguard.agentid.pub] Scheduler initialized with 0 trigger(s)`。

## 错误处理

| 场景 | 行为 |
|------|------|
| 注册时 `targetChannel` 解析不出 aid | 报错拒绝：`目标 agent 不存在或未就绪：<aid>` |
| 注册时 aid 对应 agent 未就绪（无 scheduler/manager） | 报错拒绝：同上 |
| 管理路径（list/cancel/update）无 owning agent | `⚠️ 触发器功能未启用` |
| 执行时 `schedulerAid != this.aid`（错位数据） | warn + skip，不执行 |
| 执行时 `schedulerAid` 为空（旧数据） | 跳过校验，正常执行（向后兼容） |

## 测试策略

1. **单元测试**：`registerTriggerFromParsed` 用 `targetChannel` 解析 schedulerAid；解析失败返回 error；schedulerAid 正确写入 trigger 对象
2. **单元测试**：`fireTrigger` 在 schedulerAid 不匹配时 skip；为空时正常执行
3. **回归**：现有 trigger 测试套件全绿（字段新增不破坏旧用例，schedulerAid 可选兼容旧数据）
4. **手动验证**：迁移后重启，确认 wcguard scheduler 加载 3 条；整点触发由 wcguard 自己执行（日志 `[wcguard.agentid.pub] Firing trigger`）；`/trigger list` 在 wcguard 会话可见

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/types.ts` | Trigger 加 `schedulerAid` 字段 |
| `src/core/command/command-handler.ts` | 注册路径用 targetChannel 解析、写入 schedulerAid、去 primary 兜底；管理路径去 primary 兜底 |
| `src/core/trigger/scheduler.ts` | fireTrigger 加 schedulerAid 防御校验 |
| `data/triggers/eleanbot.agentid.pub/triggers.json` | 手动删除 3 条 |
| `data/triggers/wcguard.agentid.pub/triggers.json` | 手动写入 3 条（补 schedulerAid） |

## 非目标（YAGNI）

- 不做"从 channelKey 抽 aid 兜底"的复杂解析（早期方案，已否决）
- 不做跨 agent trigger 迁移命令（存量手动处理一次即可）
- 不改 `targetChannel` 的语义或字段名
- 不引入自动数据迁移逻辑（仅本次手动处理 3 条）
