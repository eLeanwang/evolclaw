# EvolClaw 触发器功能设计

**日期**: 2026-05-13
**状态**: Implemented
**实现日期**: 2026-05
**作者**: 设计讨论产出

---

## 1. 背景与目标

### 1.1 背景

EvolClaw 当前是**纯被动响应**的 AI Gateway——必须由用户发消息才能触发 Agent 执行。缺少主动执行能力：
- AI 无法设置「稍后做某事」
- 没有定时任务（日报、定期清理等）
- 用户要求「30 分钟后提醒我」只能依赖外部工具

### 1.2 目标

提供一套**触发器基础设施**，让 AI 能自主决定在未来某个时间点重新激活自己并执行指定任务。设计原则：

1. **系统层只做「调度 + 投递」**，不做意图理解
2. **AI 层完全自决**：何时触发、触发条件、执行上下文、输出方式都由 AI 判断
3. **复用现有架构**：消息队列、会话管理、事件总线、命令系统全部复用
4. **最小侵入**：不改变现有消息处理语义，通过扩展字段和新模块完成

### 1.3 非目标

- 不做自然语言时间解析（AI 负责把用户意图翻译成结构化命令）
- 不做触发器修改（cancel + 重建）
- 不做跨设备/跨用户的触发器共享
- 不做失败自动重试
- 不做事件驱动触发器（v1 仅支持时间触发，事件驱动未来可扩展）

---

## 2. 命令格式

AI 在回复中输出 `/trigger` 命令，系统从 agent 输出流中拦截（沿用现有 `CommandHandler` 机制）。

### 2.1 注册

```
/trigger set <时间> [定位] [选项] --prompt "<任务内容>"
```

**时间**（三选一，必填）：

| 参数 | 示例 | 语义 |
|------|------|------|
| `--delay <duration>` | `30m`、`2h`、`1d`、`2h30m` | 从当前起相对延迟 |
| `--at <ISO>` | `2026-05-15T09:00` | 绝对时间点 |
| `--cron <expr>` | `"0 9 * * *"` | 周期执行（标准 5 字段 cron） |

**定位**（可选，默认值见表）：

| 参数 | 默认 | 语义 |
|------|------|------|
| `--channel <name>` | 当前 channel 实例名 | 目标通道实例（adapter.channelName） |
| `--channelid <id>` | 当前 channelId | 目标对话 ID |
| `--thread <id>` | 无 | 进入指定 thread（需通道支持；与 `--session` 互斥） |
| `--session latest\|current\|thread` | `latest` | 会话策略（见 2.2） |

**其他**：

| 参数 | 默认 | 语义 |
|------|------|------|
| `--name <id>` | 自动生成 | 触发器标识符（会话内唯一） |
| `--agent <name>` | 当前 agent | 目标 agent 后端 |
| `--prompt "<text>"` | — | 任务内容（必填） |

### 2.2 Session 策略

| 值 | 触发时行为 | 输出可见性 | 上下文累积 |
|----|-----------|----------|----------|
| `latest` | 续接触发时的当前活跃会话 | 按 sessionMode | 当前活跃会话历史 |
| `current` | 续接**创建时**绑定的会话（切 active，不切回） | 可见 | 该会话历史，跨触发累积 |
| `thread` | 专属 thread 话题会话 | 可见（落在话题里） | 该 thread 会话，跨触发累积 |

**策略说明**：
- `latest`：适用于临时提醒（"30 分钟后提醒我开会"），触发时插入当前对话
- `current`：适用于周期任务需要保留上下文（日报、定期检查），每次触发续接同一会话
- `thread`：适用于独立话题隔离（周报生成、后台监控），输出不干扰主对话

**实现细节**：
- `current` 注册时绑定 `boundSessionId`，触发时检查会话忙闲状态（忙则延迟补发）
- `thread` 在 AUN 上使用合成 threadId（`trigger-<triggerId>`），在飞书上首次触发时通过 `reply_in_thread` 创建话题并回填 `targetThreadId`

详细设计见 `2026-06-01-trigger-dedicated-session-design.md`。

### 2.3 管理

```
/trigger                           # 列出所有 status=active 的触发器（默认视图）
/trigger list                      # 列出所有触发器（含已完成/已取消）
/trigger cancel <name>             # 取消自己创建的触发器
/trigger cancel <id>               # owner/admin 通过 ID 取消任意触发器（name 不唯一时）
```

**视图差异**：
- `/trigger`：仅 `status='active'`，是日常查看用途（"当前还有什么待执行"）
- `/trigger list`：全量，用于审计/排障（包括 `done` 状态的历史记录）

**定位规则**：
- `cancel <name>`：在当前 `(peer_id, channel)` 作用域内查找 `status='active'` 且 name 匹配的触发器。找不到 → 报错。
- `cancel <id>`：直接按 UUID 匹配，不受作用域限制。仅 owner/admin 可用。

**输出字段**：name、schedule、next_fire、fire_count、created_by、状态。owner/admin 视角额外显示触发器 ID。

### 2.4 校验规则

注册时校验（失败直接报错给 AI）：

1. `--delay`、`--at`、`--cron` 三选一（互斥且必一）
2. `--thread` 与 `--session` 互斥
3. `--channel` 与 `--channelid` 需配对（要么都给，要么都不给）
4. `--thread` 仅在目标 channel 支持 threads 时有效
5. `--channel` / `--channelid` / `--thread` / `--agent` 指向的对象必须存在
6. `--prompt` 必填
7. `--name` 在 `(created_by_peer_id, created_by_channel)` 作用域内唯一
8. cron 表达式合法性

### 2.5 示例

```
# 30 分钟后检查 CI 状态
/trigger set --delay 30m --prompt "检查 PR #42 CI 状态并汇报"

# 明天 9 点在指定项目生成日报
/trigger set --at 2026-05-14T09:00 --agent evolclaw --prompt "生成昨日日报"

# 每天 9 点在专属 thread 生成工作摘要
/trigger set --cron "0 9 * * *" --name daily --session thread \
  --prompt "汇总昨日提交写入 daily.md"

# 跨对话通知（群里注册，私聊通知）
/trigger set --delay 1h --channel feishu-main --channelid ou_user_xxx \
  --prompt "构建已完成"
```

---

## 3. 架构集成

### 3.1 组件关系

```
Agent 输出 /trigger → CommandHandler 拦截
                        ↓
                    TriggerManager（CRUD + 持久化）
                        ↓
                    SQLite: triggers 表
                        ↓
                    TriggerScheduler（小顶堆 + 单 Timer）
                        ↓ 到期
                    构造合成 Message → MessageQueue → MessageProcessor → Agent
                        ↓
                    EventBus: trigger:fired / trigger:completed / trigger:skipped
```

### 3.2 合成消息设计

扩展 `Message` 接口，新增可选字段：

```typescript
interface Message {
  // ...现有字段
  source?: 'user' | 'trigger';   // 与 InboundMessage.source 风格一致
  triggerMeta?: {
    triggerId: string;
    triggerName?: string;
    fireTime?: number;
  };
}
```

**合成消息关键字段**：

| 字段 | 值 | 说明 |
|------|-----|------|
| `channel` | trigger.targetChannel | 目标 adapter 名 |
| `channelId` | trigger.targetChannelId | 目标对话 ID |
| `selfAID` | 触发器所属 EvolAgent 的 AID | 从 `targetChannel` 的 channelKey 解析，回落 scheduler 所属 agent 的 aid |
| `threadId` | trigger.targetThreadId | 可选（thread 策略使用） |
| `content` | trigger.prompt | 任务内容原文 |
| `peerId` | `__trigger__:<triggerId>` | 每个触发器唯一的虚拟 ID，避免不同触发器/用户消息被 greedy merge |
| `messageId` | `trigger:<id>:<fireTime>` | 全局唯一（`fireTime` 区分 cron 多次触发），便于日志追踪 |
| `chatType` | 从目标 trigger 解析 | 保持一致（group 时额外带 `groupId`） |
| `source` | `'trigger'` | 来源标记 |
| `triggerMeta` | `{ triggerId, ... }` | 触发器详细信息 |

### 3.3 MessageProcessor 差异化分支

识别 `message.source === 'trigger'` 时：

- **跳过 processing status**：不发 `sendProcessingStatus('start')` / `sendProcessingStatus('done')`
- **输出控制**：按 session 的 sessionMode 正常输出（latest/current/thread 策略决定目标会话）
- **事件发射**：处理完成后发 `trigger:completed`（携带 triggerId、duration），处理失败发 `trigger:failed`

### 3.4 并发冲突（中断策略）

**核心原则**：用户优先，触发器互不打断。

| 新消息源 \ 当前处理 | 用户消息 | 触发器 | 空闲 |
|---------------------|----------|--------|------|
| 用户消息 | 中断重来（现有逻辑） | **立即中断** | 立即执行 |
| 触发器 | **排队等待** | **排队等待** | 立即执行 |

**实现方式**：触发器投递时使用 `messageQueue.enqueue(sessionKey, message, projectPath, { interruptible: false })`。现有 `enqueue` 已支持 `interruptible` 选项——`false` 时不触发中断，仅追加到队列。

用户消息到达时（默认 `interruptible: true`）：照现有逻辑中断，无论被中断的是用户还是触发器。

**被中断的触发器**：在 MessageProcessor 检测到中断时发 `trigger:skipped(reason=interrupted)` 事件，写日志。**不修改 triggers 存储状态**（delay/at 在投递时已移入 history；cron 继续后续调度）。**不自动重排**——AI 需要重试的话在后续交互中自行重建触发器。

---

## 4. 调度器设计（TriggerScheduler）

### 4.1 数据结构

```
TriggerScheduler
  ├─ triggers:    Map<id, Trigger>               — 所有活跃触发器
  ├─ fireHeap:    小顶堆，按 nextFireAt 排序     — 下一次触发就绪队列
  ├─ currentTimer: NodeJS.Timeout | null         — 指向堆顶的 setTimeout
  └─ inflightCronJobs: Set<id>                   — 正在执行的 cron 任务 ID
```

### 4.2 核心操作

**register(trigger)**：
1. 计算 `nextFireAt`（delay: now + ms；at: ISO → ms；cron: cron-parser.next()）
2. 持久化到 SQLite
3. 插入 `fireHeap`
4. 若堆顶改变，重设 `currentTimer` 对准新的堆顶时间

**cancel(id)**：
1. 从 `triggers` 和 `fireHeap` 移除
2. 持久化更新 `status='done'`
3. 若堆顶改变，重设 timer

**onFire()**（timer 到期回调）：
1. 弹出堆顶 trigger
2. 若是 cron 且该 id 仍在 `inflightCronJobs`（上次未完成）→ 发 `trigger:skipped` 事件，写日志，跳过本次
3. 否则：
   a. 构造合成 Message（§3.2），生成唯一 `messageId = trigger:<id>:<fireTime>`
   b. 投递到 MessageQueue
   c. 写日志 `[trigger.<id>] fired`
   d. 更新 `triggers.last_fired_at = now`，`fire_count++`
   e. 若是 cron → 加入 `inflightCronJobs`
4. **处理下次调度**：
   - 若 cron → 计算下次 nextFireAt，插回堆
   - 若 delay/at → 置 `status='done'`，从 `triggers` 移除
5. 重设 `currentTimer` 对准新堆顶

**cron 完成检测**：TriggerScheduler 订阅 `trigger:completed` / `trigger:failed` / `trigger:skipped`（interrupted reason）事件，收到匹配 triggerId 时从 `inflightCronJobs` 移除。事件由 `MessageProcessor` 在消息处理结束（含正常完成、失败、被中断）时发出。

### 4.3 单 Timer 的理由

- 规模无关：1 万个触发器也只持有 1 个 active timer
- 插入/删除 O(log n)
- 避免 Node event loop 压力

### 4.4 Cron 重叠处理

| 情况 | 行为 |
|------|------|
| 上次执行仍 running，下次到点 | **跳过本次**，写日志 + 发 `trigger:skipped`，更新 next_fire_at |
| 上次执行完成，下次到点 | 正常投递 |

**不做队列堆积**：避免慢任务 × 高频 cron 导致无限 backlog。

### 4.5 启动恢复

服务启动时 `TriggerScheduler.init()`：

1. 读取 `data/triggers/<aid>/triggers.json`，解析所有条目
2. 逐条处理：
   - `next_fire_at >= now()` → 正常入堆
   - `next_fire_at < now()`（服务停机期间错过）：
     - **delay / at** → 立即触发一次（补执行），然后置 `done`
     - **cron** → 不补执行，重新计算从 now 起的 next_fire_at，入堆
3. 启动 timer

**理由**：
- delay/at 是一次性承诺，不补执行就违约
- cron 是周期任务，短暂缺失几个周期不算违约；长时间停机可能积压几十上百次，不该瞬间全跑

---

## 5. 持久化设计

### 6.1 存储布局

按 EvolAgent AID 隔离，存放在 `data/triggers/` 下：

```
{EVOLCLAW_HOME}/data/triggers/
├── <aid>/
│   ├── triggers.json       # 该 agent 的所有 active 触发器
│   └── history.jsonl       # done 状态归档（append-only）
└── <aid>/
    └── ...
```

与 `data/outbox/<aid>.jsonl`、`data/sessions/aun/<encode(selfAid)>/` 的隔离风格一致。

### 6.2 triggers.json 结构

```json
{
  "version": 1,
  "triggers": {
    "<uuid>": {
      "id": "...",
      "name": "...",
      "scheduleType": "delay | at | cron",
      "scheduleValue": "...",
      "nextFireAt": 1747200000000,
      "targetChannel": "feishu-main",
      "targetChannelId": "oc_xxx",
      "targetThreadId": null,
      "targetSessionStrategy": "latest | silent",
      "agentId": "claude",
      "prompt": "...",
      "createdByPeerId": "ou_xxx",
      "createdByChannel": "feishu-main",
      "lastFiredAt": null,
      "fireCount": 0,
      "createdAt": 1747000000000,
      "updatedAt": 1747000000000
    }
  }
}
```

写入策略：通过 `atomicWrite()` 原子重写。

### 6.3 history.jsonl

触发器达到 done 状态时：从 `triggers.json` 删除 + 追加一行到 `history.jsonl`：

```json
{"id":"...","name":"...","scheduleType":"delay","prompt":"...","doneAt":1747200000000,"doneReason":"fired|cancelled|expired",...}
```

### 6.4 不引入执行历史表

触发器执行事件统一写 `evolclaw.log`，日志行前缀 `[trigger.<id>]`。理由：

- 执行走的是正常 MessageProcessor 流程，现有日志已覆盖完整事件
- "成功/失败"没有明确可定义的边界——Agent 执行过程中的各种状态不适合压缩成一个状态位
- `/trigger` / `/trigger list` 仅展示触发器元数据 + `lastFiredAt` + `fireCount` 已足够
- 排障用 `grep '[trigger.<id>]' logs/evolclaw.log`

### 6.5 Status 语义（二态）

```
status: 'active' | 'done'
```

active 触发器存在 `triggers.json` 中；转为 done 时移入 `history.jsonl`。

**active → done 的时机**：
- 用户 / admin / owner 执行 `cancel`
- delay / at 类型：投递合成消息到 MessageQueue 后
- 任意类型：执行时发现目标 session/channel 永久不存在

**核心语义**：**触发器的职责到"投递"为止**。丢进 MessageQueue 就 done，后续 Agent 执行结果不影响触发器状态。

### 6.6 启动恢复

见 §4.5。每个 EvolAgent 启动时读取 `data/triggers/<aid>/triggers.json`，将所有条目加载到该 agent 的 TriggerScheduler 堆中。

### 6.7 调度器架构

**Per-agent scheduler**：每个 `EvolAgent` 实例持有自己的 `TriggerScheduler`（独立堆 + 独立 timer）。

理由：
- EvolAgent 热重载时只需 stop 该 agent 的 scheduler，不影响其他 agent
- 删除 evolagent 直接 stop scheduler + 删目录，无残留
- 多 timer 不构成性能问题（agent 数量有限）

### 6.8 Name 唯一性

`name` 在同一 evolagent 下全局唯一（不按 peer 隔离）。理由：
- 简化 cancel 定位逻辑
- AI 通过 `/trigger` 查看现存 name 避免冲突
- 不同用户在同一 agent 下不能创建同名触发器

---

## 7. 权限设计

### 7.1 命令权限

| 命令 | 权限 | 作用域 |
|------|------|--------|
| `/trigger set` | 所有人 | — |
| `/trigger` | 所有人 | 全局可见，**仅 active 状态** |
| `/trigger list` | 所有人 | 全局可见，**所有状态**（active + done） |
| `/trigger cancel <name>` | 普通用户 | 仅能取消 `created_by_peer_id + created_by_channel` 匹配自己的 active 触发器 |
| `/trigger cancel <name\|id>` | owner / admin | 不受限制，可取消任意触发器 |

### 7.2 创建者归属

- `created_by_peer_id` / `created_by_channel` = 当前命令消息的 peerId / channel
- **无论是 AI 自主决定创建还是用户明确要求创建，创建者都是当前 peer**——AI 是用户的代理，其行为归属于当前用户
- 同一个人在不同通道身份不互通（飞书创建的触发器不能从微信取消，除非是 owner/admin）

### 7.3 权限复用

复用现有 `permission.ts` 的 `getUserIdentity()` 逻辑判断 owner/admin/user。

---

## 8. AI 侧引导（System Prompt 注入）

### 8.1 注入机制

在 `MessageProcessor.buildSystemPrompt()` 或 `promptTemplates` 中新增触发器章节。**全局注入**：只要 `config.triggers.enabled !== false`，所有会话的 system prompt 都追加。

### 8.2 注入内容（示例文案）

```markdown
## 触发器

你可以通过 /trigger 命令设置延迟或定时任务，系统会在指定时间重新激活你执行任务。

### 注册

/trigger set <时间> [定位] [选项] --prompt "<任务内容>"

时间（三选一）：
  --delay <时长>         相对延迟，如 30m、2h、1d、2h30m
  --at <ISO>             绝对时间，如 2026-05-15T09:00
  --cron <expr>          周期，如 "0 9 * * *"

定位（默认当前上下文）：
  --channel <实例名>     目标通道实例
  --channelid <id>       目标对话 ID
  --thread <id>          目标 thread（与 --session 互斥，需通道支持）
  --session latest       续接最后活跃会话（默认）
  --session current      续接创建时绑定的会话（跨触发累积上下文）
  --session thread       专属 thread 话题会话（隔离输出）

其他：
  --name <标识>          触发器名（默认自动生成）
  --agent <名称>         目标 agent（默认当前）
  --prompt "<内容>"      任务内容（必填）

### 管理

/trigger                   查看当前活跃的触发器（默认视图）
/trigger list              查看所有触发器（含已结束的历史记录）
/trigger cancel <name>     取消触发器（仅能取消自己创建的 active 触发器）

### 使用原则

- 当用户要求"稍后/明天/定时"做某事时使用
- 当你判断某任务需要延迟到特定时刻才合适时主动使用
- latest：临时提醒，触发时插入当前对话
- current：周期任务需要保留上下文（如日报、定期检查）
- thread：独立话题隔离（如周报生成、后台监控）
- 触发器不支持修改，改内容请 cancel 后重建
- 失败不自动重试，由你在后续交互中自行决定是否重建
```

### 8.3 禁用时不注入

`config.triggers.enabled: false` 时，system prompt 不注入触发器章节，AI 不会尝试使用该功能。

---

## 9. 事件总线扩展

在 `src/core/event-bus.ts` 的 `GatewayEvent` 联合类型中新增 `TriggerEvent`：

```typescript
type TriggerEvent =
  | { type: 'trigger:registered'; triggerId: string; name: string; peerId: string }
  | { type: 'trigger:fired'; triggerId: string; name: string; fireTime: number }
  | { type: 'trigger:completed'; triggerId: string; messageId: string; durationMs: number }
  | { type: 'trigger:failed'; triggerId: string; messageId: string; error: string }
  | { type: 'trigger:skipped'; triggerId: string; reason: 'overlap' | 'interrupted' }
  | { type: 'trigger:cancelled'; triggerId: string; by: string };
```

事件订阅者可用于：日志、统计、未来接入监控系统。

---

## 10. 配置项

`src/config.ts` 新增配置段：

```typescript
interface Config {
  // ...现有字段
  triggers?: {
    enabled?: boolean;       // 默认 true
    // v1 保留极简，后续视需要扩展
  };
}
```

v1 有意不暴露过多配置项，避免设计过度。

---

## 11. 相关改动清单

### 11.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/trigger/manager.ts` | `TriggerManager` — CRUD + 持久化 + 与 scheduler 对接 |
| `src/core/trigger/scheduler.ts` | `TriggerScheduler` — 小顶堆 + 单 timer + cron 计算 |
| `src/core/trigger/parser.ts` | 命令参数解析、时间表达式解析、校验 |
| `tests/unit/trigger-*.test.ts` | 单元测试 |

### 11.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/types.ts` | 新增 `Trigger` 类型、`Message.source` 扩展（`'trigger'`）、`Message.triggerMeta` 字段、`TriggerSessionStrategy` 类型 |
| `src/config.ts` 或 `src/config-store.ts` | 新增 `triggers` 配置段 |
| `src/paths.ts` | 新增 `agentTriggersDir(aid)` 路径辅助函数 |
| `src/core/command-handler.ts` | 新增 `/trigger set/list/cancel/update` 命令处理 + 权限检查 |
| `src/core/message/message-queue.ts` | 支持触发器消息的排队和中断策略 |
| `src/core/message/message-processor.ts` | 识别 trigger 源消息：跳过 processing status |
| `src/core/session/session-manager.ts` | 支持 `current` 策略的 boundSessionId 查找，`thread` 策略的话题会话 |
| `src/core/event-bus.ts` | 新增 `TriggerEvent` 到 `GatewayEvent` 联合类型 |
| `src/core/evolagent.ts` | EvolAgent 实例持有 TriggerScheduler 引用 |
| `src/core/evolagent-registry.ts` | reload 时重启对应 agent 的 scheduler |
| `src/index.ts` | 启动时为每个 EvolAgent 初始化 TriggerScheduler；注入 system prompt |
| `src/templates/skills.md` 或 `src/templates/prompts.md` | 新增触发器章节 |

### 11.3 新增依赖

| 依赖 | 用途 |
|------|------|
| `cron-parser` | 仅计算 cron 表达式的下次执行时间，无运行时开销（~10KB） |

---

## 12. 待落地的开放问题

本设计文档已覆盖所有关键决策。实施阶段可能遇到的细节问题：

1. **时区处理**：`--at` 是本地时区还是 UTC？建议 ISO 字符串带时区时按标注解析，不带时区时按系统本地时区。
2. **cron 时区**：`cron-parser` 支持 tz 参数；可在 `--cron` 后加可选 `--tz <zone>`（v1 先用系统默认时区）。
3. **触发器数量上限**：防止单用户滥用，可加软上限（默认每用户 50 个）。v1 可暂不实现。
4. **`--prompt` 长度限制**：过长 prompt 可能导致 Agent 处理压力，建议 4KB 上限（注册时校验）。
5. **系统重启期间的 channel/session 变化**：恢复时若目标 channel 不存在，触发器转为 `done` 并写日志。

---

## 13. 设计决策汇总

| 维度 | 决策 |
|------|------|
| 命令格式 | 严格结构化 `--flag value`，AI 负责翻译用户意图 |
| 时间表达 | delay / at / cron 三选一 |
| 定位参数 | channel + channelid + thread/session（thread 与 session 互斥） |
| Session 策略 | `latest` / `current` / `thread`（详见 2026-06-01-trigger-dedicated-session-design.md） |
| 执行路径 | 合成 Message → MessageQueue → MessageProcessor（复用现有流程） |
| 中断策略 | 用户优先：用户打断触发器，触发器不打断用户，触发器间排队 |
| 失败处理 | 不重试，写日志，AI 自决是否重建 |
| Cron 重叠 | 跳过本次 + 发 skipped 事件 |
| 持久化 | `data/triggers/<aid>/` 文件系统，per-agent 隔离 |
| 状态语义 | 二态 `active / done`，以"投递"为完成标志 |
| 启动恢复 | delay/at 补执行，cron 不补执行 |
| 修改操作 | 支持 `/trigger update`（修改 schedule/prompt/session 等参数） |
| 权限 | list 全局可见；cancel/update 仅创建者可操作，owner/admin 不受限 |
| 创建者归属 | `(peer_id, channel)`，AI 代创建 = 用户创建 |
| AI 引导 | system prompt 全局注入 `/trigger` 说明 |
| 执行历史 | 写 `evolclaw.log`，日志前缀 `[trigger.<id>]` |

---

## 14. 下一步

本 spec 审阅通过后进入 [writing-plans] 阶段，产出实施计划（按文件/任务拆分 + 测试策略 + 迁移步骤）。
