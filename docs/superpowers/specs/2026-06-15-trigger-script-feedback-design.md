# Trigger script + feedback 改造设计

**日期**: 2026-06-15
**状态**: Phase 1 core implemented（2026-06-16）

## 背景

现有 trigger runtime 支持 daemon 调用同目录脚本产出结果，再按持久化配置选择直接发消息或交给 agent-runner。

本设计只定义改造目标，不要求兼容当前 `data/triggers/<aid>/triggers.json` 的内部字段形态。当前实现仍是 JSON 持久化，不使用 YAML。

## 实现状态（2026-06-16）

Phase 1 核心路径已落地，daemon 运行时只使用当前 trigger runtime，不再启动旧 JSON manager / scheduler：

| 能力 | 当前状态 | 代码位置 |
|---|---|---|
| Schema + Types | 已实现，含 source/script/feedback/reliability 校验与默认值 | `src/core/trigger/types.ts`、`src/core/trigger/validation.ts` |
| Trigger definition 目录布局 | 已实现，每个 trigger 独立目录，`trigger.json` + 同目录脚本 + `active.json`（`runs` + `schedule`） | `src/core/trigger/manager.ts` |
| delay / at / cron / interval | 已实现 daemon 内调度，cron 使用现有 `cron-parser` | `src/core/trigger/scheduler.ts` |
| missedPolicy | 已实现 one-shot `delay/at` 的 `skip/run_once`；已实现 periodic `cron/interval` 的 `skip/run_once`（通过 `active.json.schedule` 持久化下一次触发点）；`run_all` 尚未实现 | `src/core/trigger/state.ts`、`src/core/trigger/scheduler.ts` |
| ScriptExecutor | 已实现 stdin JSON、stdout result JSON、timeout、AbortController abort、无 shell 执行 | `src/core/trigger/script-executor.ts` |
| FeedbackDispatcher | 已实现 `none` / `direct-message` / `agent-runner`，含模板渲染 | `src/core/trigger/feedback.ts` |
| RunStateStore | 已实现 `active.json` 快照、阶段事件、周期调度游标、善终清理、重启恢复 | `src/core/trigger/state.ts`、`src/core/trigger/scheduler.ts` |
| AuditLogger | 已实现 `logs/trigger-runs.log`，复用 `LogWriter` daily rotation + 7 天 retention | `src/core/trigger/audit.ts` |
| IPC | 已实现 `trigger.list/show/create/update/setEnabled/cancel/run` | `src/ipc.ts`、`src/index.ts` |
| CLI | 已实现 `ec trigger list/show/create/update/enable/disable/cancel/run --dry-run` | `src/cli/trigger-command.ts`、`src/cli/index.ts` |
| `/trigger` 会话入口 | 已切到当前 definition 模型：文本/menu 参数映射成 trigger definition，prompt 存入 `feedback.onSuccess.template`，执行走 `agent-runner` | `src/core/command/command-handler.ts`、`src/core/command/menu-handler.ts` |
| 旧 trigger 迁移 | daemon 首次加载 manager 时将 legacy `triggers.json` 转成 trigger 目录，并把旧文件重命名为 `triggers.legacy.migrated.<ts>.json` 备份 | `src/core/trigger/manager.ts` |
| daemon 生命周期 | 已实现启动、热加载、resync、shutdown 中的 scheduler 生命周期管理；旧 scheduler 不再由 daemon 创建/启动 | `src/index.ts` |
| 测试 | 已补 manager/script/scheduler dry-run、legacy migration、menu 入口覆盖 | `tests/unit/trigger-manager.test.ts`、`tests/unit/trigger-menu.test.ts` |

当前实现与目标设计的差异：

- `event` / `state` source 尚未实现。
- Trigger template 只保留 CLI 入口占位，未实现模板渲染。
- dry-run 已实现 `ec trigger run --dry-run`，不会写 `active.json`、不会写正式 audit、不会执行副作用；尚未实现 `ec trigger test --file`、`--source-payload` 和独立 test run 日志。
- `run_all` 尚未实现；需要先补 `maxCatchupRuns` / `maxCatchupWindowMs` 之类的上限策略，避免长时间停机后无限补跑。
- direct-message feedback 已有 pragmatic retryable/permanent 分类；尚未要求各 channel adapter 统一抛结构化 `{ code, retryable }` 错误。
- agent-runner 等待队列空闲当前使用短轮询，未改成订阅 `task:completed` 事件门控。
- 旧 JSON trigger 实现已从源码默认路径移除；保留的只是 `triggers.json` 数据迁移逻辑。

### 2026-06-16 增量实现说明

本次补齐三个运行时缺口：

- periodic source（`cron` / `interval`）现在把下一次计划触发点持久化到 `data/triggers/<agentAid>/<triggerId>/active.json` 的 `schedule` 字段，字段为 `nextFireAt`、`updatedAt`、`sourceSignature`。
- `active.json.schedule` 在 create / update / enable / disable / cancel 时清理；daemon 注册周期 source 时若 `sourceSignature` 不匹配，也会按当前 definition 重新计算。
- missedPolicy 当前覆盖：
  - one-shot `delay` / `at`：`skip` 会写 `skipped(missed_skip)` 并停用 trigger；`run_once` 会立即跑一次并停用 trigger。
  - periodic `cron` / `interval`：`skip` 会对错过的 `nextFireAt` 写一条 `skipped(missed_skip)` 并推进到下一次；`run_once` 会立即补跑一次，然后推进到下一次。
  - `run_all` 仍只是 schema 预留枚举，当前运行时不枚举所有错过的 occurrence；在补 `maxCatchupRuns` / `maxCatchupWindowMs` 前不要依赖它。
- direct-message feedback 现在会区分 retryable / permanent 发送错误：网络、断连、超时、限流、408 / 429 / 5xx 归为 retryable；认证、权限、非法参数、目标不存在、不支持能力、普通 4xx 归为 permanent。
- `/trigger` 与菜单入口现在全面走当前 trigger runtime；旧 `triggers.json` 会迁移为 trigger 目录结构后备份，不再被调度。

## 功能概述

当前 trigger runtime 是 daemon 内部的自动化调度单元，用于把“什么时候触发”“触发后如何取结果”“结果如何反馈”拆成三个独立模块。

它支持：

- 按时间触发任务；事件和状态触发作为后续扩展预留。
- 触发后可选执行 trigger 同目录脚本，产出结构化 result。
- 由 daemon 根据持久化配置选择反馈路径。
- 直接通过 daemon 发消息，保证固定提醒类任务准时反馈。
- 把结果注入 agent-runner，让 agent 自主判断和生成回复。
- 对每次 run 做审计记录，能追溯触发原因、脚本结果、反馈分支和副作用。
- 通过 `ec trigger` 提供 daemon 级 CLI 管理能力，不依赖当前会话。
- 为未来 trigger 模板和 dry-run 模拟测试预留接口。

核心抽象：

```text
source   -> 什么时候触发
script   -> 触发后如何产生 result，可选
feedback -> result 如何处理
audit    -> 一次 run 如何被记录和追溯
```

典型用例：

| 场景 | source | script | feedback |
|---|---|---|---|
| 每天固定提醒 | cron | 无 | direct-message |
| 周期健康检查 | interval | health-check.js | onSuccess none，onFailure direct-message |
| agent 空闲检测 | interval | check-agent-idle.js | agent-runner 或 direct-message |
| 事件转发（待实现） | event | 无或格式化脚本 | direct-message |

## 架构说明

整体架构：

```text
                 +---------------------------+
                 |        ec trigger         |
                 |  /trigger / template / test|
                 +-------------+-------------+
                               |
                               v
                    +----------+-----------+
                    |       daemon         |
                    |----------------------|
                    | TriggerDefinitionManager       |
                    | TriggerRuntimeScheduler     |
                    | RunStateStore        |
                    | AuditLogger          |
                    | DirectMessageService |
                    | AgentRunnerQueue     |
                    +----------+-----------+
                               |
                               v
                +--------------+----------------+
                |   trigger runtime (daemon 内) |
                |--------------------------------|
                | TimeScheduler  delay/at/cron   |
                | IntervalTimer   interval       |
                | EventMonitor    event (future) |
                | StatePoller     state (future) |
                | ScriptExecutor   同目录脚本    |
                | ResultNormalizer  stdout/error  |
                | FeedbackDispatcher onSuccess/...|
                +--------------+----------------+
                               |
                +--------------+------------------------------+
                |                                             |
                v                                             v
     +------------------------+                 +------------------------+
     | trigger.agentAid 对应的  |                 | trigger.agentAid 的    |
     | channel adapter         |                 | agent-runner / session |
     +------------------------+                 +------------------------+

  trigger definition  ->  data/triggers/<agentAid>/<triggerId>/trigger.json
  运行态/调度态       ->  data/triggers/<agentAid>/<triggerId>/active.json
  审计历史            ->  logs/trigger-runs.log（复用 logs/*.log 滚动机制）
```

组件职责：

| 组件 | 职责 |
|---|---|
| `TriggerDefinitionManager` | trigger definition 的 CRUD、schema 校验、目录管理 |
| `TriggerRuntimeScheduler` | 加载 enabled trigger，注册 `source`，触发 run，维护 concurrency 运行态 |
| `TimeScheduler` | 处理 `delay` / `at` / `cron` |
| `IntervalTimer` | 处理固定轮询型 `interval` source |
| `EventMonitor` | 订阅内部事件总线，处理 `event` source（待实现） |
| `StatePoller` | 轮询内部状态，处理 `state` source（待实现） |
| `ScriptExecutor` | 在受控环境中执行 trigger 同目录脚本，通过 stdin JSON 传参 |
| `FeedbackDispatcher` | 根据脚本结果和 `feedback` 配置选择反馈分支 |
| `DirectMessageService` | 由 `trigger.agentAid` 对应 channel 发送消息 |
| `AgentRunnerQueue` | 把 trigger result 注入指定 session，标记为 trigger 信息 |
| `RunStateStore` | 维护 `active.json` 运行态与周期调度游标（concurrency 判定 + 重启恢复 + missedPolicy） |
| `AuditLogger` | 善终 run 写入 `logs/trigger-runs.log`（复用现有 logger） |
| `ec trigger` | daemon 级结构化管理入口 |

关键边界：

- Trigger 不持有 AID，也不直接收发网络消息。
- Script 不持有 token，不调用 `ec msg` / `ec rpc`，不决定 target。
- Feedback 的执行主体固定为 `trigger.agentAid`。
- `feedback.target` 只描述接收目标或投递位置。
- Daemon 是唯一允许执行副作用的进程。

`TriggerRuntimeScheduler` 是调度协调层，不直接负责所有触发判定细节；它根据 `source.type` 调用不同的子模块：

```text
source.type=delay/at/cron -> TimeScheduler
source.type=interval      -> IntervalTimer
source.type=event         -> EventMonitor（待实现）
source.type=state         -> StatePoller（待实现）
```

这些子模块都运行在 daemon 内部，不是独立进程。真正的独立执行单元是 `ScriptExecutor` 启动的同目录脚本进程。

运行生命周期：

```text
1. daemon 启动
2. 扫描 data/triggers/<agentAid>/<triggerId>/trigger.json
3. 校验 schema、路径和 agentAid
4. 扫描各 trigger 目录 active.json.runs，恢复未善终 run（见恢复语义）
5. 注册 source
6. source 触发
7. concurrency 判定（见 Reliability）：forbid 跳过 / replace 中断旧 run / allow 并行
8. 生成 runId，创建运行态（写 active.json，phase=running）
9. 如果有 script，daemon 执行脚本并读取 stdout result
10. 如果没有 script，daemon 用 source payload 构造默认 result
11. exit 0 且 result.matched !== false -> feedback.onSuccess
12. exit 0 且 result.matched === false -> feedback.onNoop，缺省 none
13. exit 非 0 或 daemon 执行失败 -> feedback.onFailure
14. daemon 执行 feedback（见 Feedback 投递与队列交互）
15. run 善终：写一条汇总到 logs/trigger-runs.log，清空 active.json.runs 中该 run
16. 根据 reliability 更新下一次调度
```

**Run 生命周期边界**：从 script 开始到 feedback 完成（整体算一个 run）。

- 对 agent-runner 模式，"feedback 完成" = 成功入队执行。
- 队列规则：目标队列有 active 任务时 trigger **不入队**，等待队列空闲；一旦入队即立即执行，所以入队成功等价于开始执行。
- run 善终（completed/noop/skipped/failed）前，run 始终 open，同一 trigger 再次触发由 concurrency 判定处理。

恢复语义：

- daemon 重启后只恢复 `enabled: true` 的 trigger。
- `source` 由 definition 重建，不依赖 runner 进程状态。
- 启动时扫描各 trigger 目录的 `active.json.runs`：非空即存在未善终 run。
  - 中断时处于 `running`（脚本阶段）-> 恢复记录标 `failed`，reason `daemon_restart`。
  - 中断时处于 `feedback-pending`（脚本已完、未投递成功）-> 恢复记录标 `skipped`，reason `daemon_restart`。
  - 恢复记录写入 `logs/trigger-runs.log`，随后清空 `active.json.runs`，保留 `active.json.schedule`。
- 错过触发时间时按 `reliability.missedPolicy` 处理。

## 核心原则

- Trigger 是持久化调度定义。
- `source` 只描述什么时候触发。
- `script` 是可选执行步骤；脚本来自 trigger 同目录，不来自模板或全局注册表。
- Script 只产出 result，不决定反馈路径、目标或副作用。
- Feedback 只能由 `trigger.agentAid` 执行；`feedback.target` 只描述接收目标或投递位置，不包含 agent 身份。
- Daemon 是唯一执行反馈和网络副作用的一方。
- 第一版不支持跨 agent feedback。
- 创建和更新权限由入口层校验 owner/admin，不在 trigger 定义里落 `permissions`。

## 存储布局

为支持“脚本来自 trigger 同目录”，目标布局改为每个 trigger 一个目录：

```text
data/triggers/<agentAid>/
  <triggerId>/
    trigger.json      # 定义
    check-agent-idle.js  # 脚本（可选）
    active.json       # runtime state：open runs + 周期 source 下一次计划触发点

logs/
  trigger-runs.log              # 审计历史活跃文件：每个善终 run 一条汇总
  trigger-runs-20260615.log     # 归档切片（LogWriter daily 命名：<base>-YYYYMMDD.log），retention 7 天
```

`trigger.json` 使用 JSON，并沿用配置 schema 机制：

```json
{
  "$schema_version": 1
}
```

`script.path` 必须解析在 trigger 目录内。绝对路径、`..` 路径穿越和 shell 拼接执行都应拒绝。

**runtime state 与审计历史分离**（关键设计）：

- `active.json`（trigger 目录内）：runtime state，记录当前 open run 的阶段与事件流，并记录周期 source 的下一次计划触发点。**快照重写**（每次状态转换原子重写整份）。供 concurrency 判定、重启恢复和 missedPolicy 使用。是内存 `runningTriggers` Map 与周期调度游标的持久化镜像。
- `logs/trigger-runs.log`（全局 logs 目录）：审计历史，run 善终时写一条汇总记录。**复用 `logs/*.log` 现有 logger 滚动机制**，不单独设计滚动策略。只含善终记录，不含 active 中的中间事件。

两者无重叠：`active.json` 是“当前 runtime state”，`trigger-runs.log` 是“过去的善终记录”。对外查询通过 `ec trigger show/list`，避免用户直接依赖文件名。

## Trigger Definition

完整示例：

```json
{
  "$schema_version": 1,
  "id": "trig_agent_idle_notify",
  "agentAid": "eleanbot.agentid.pub",
  "enabled": true,
  "name": "agent_idle_notify",
  "description": "检测 agent 是否长时间无输出",
  "createdAt": 1781500000000,
  "updatedAt": 1781500000000,

  "origin": {
    "channel": "feishu",
    "peerId": "ou_be804567a0966c059d9fdc9d15899989",
    "sessionKey": "feishu#oc_xxx#main"
  },

  "source": {
    "type": "interval",
    "everyMs": 60000
  },

  "script": {
    "path": "./check-agent-idle.js",
    "runtime": "node",
    "args": {
      "lookbackMs": 600000,
      "includeActiveSessions": true
    },
    "timeoutMs": 30000
  },

  "feedback": {
    "onSuccess": {
      "mode": "direct-message",
      "target": {
        "channelType": "feishu",
        "channelName": "feishu#evolai.agentid.pub#feishu",
        "channelId": "ou_xxx"
      },
      "template": "{{result.text}}"
    },
    "onNoop": {
      "mode": "none"
    },
    "onFailure": {
      "mode": "direct-message",
      "target": {
        "channelType": "feishu",
        "channelName": "feishu#evolai.agentid.pub#feishu",
        "channelId": "ou_be804567a0966c059d9fdc9d15899989"
      },
      "template": "触发器 {{trigger.name}} 执行失败：{{error.message}}"
    }
  },

  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "run_once",
    "scriptRetry": {
      "maxAttempts": 0,
      "backoffMs": 30000
    }
  }
}
```

字段职责：

| 字段 | 含义 |
|---|---|
| `$schema_version` | schema 版本，沿用 agent 配置 schema 机制 |
| `id` | daemon 生成的稳定 trigger ID |
| `agentAid` | trigger 归属和唯一 feedback 执行主体 |
| `enabled` | 是否启用 |
| `name` / `description` | 展示和说明 |
| `createdAt` / `updatedAt` | daemon 写入的审计时间 |
| `origin` | 创建来源上下文，只用于追溯和默认值生成 |
| `source` | 触发来源 |
| `script` | 可选；同目录脚本执行配置 |
| `feedback` | result 的反馈策略 |
| `reliability` | 调度可靠性策略 |

## Source

`source` 表示触发来源。当前版本支持：

```json
{ "type": "delay", "afterMs": 1800000 }
```

```json
{ "type": "at", "at": "2026-06-15T18:00:00+08:00" }
```

```json
{ "type": "cron", "expression": "0 9 * * *", "timezone": "Asia/Shanghai" }
```

```json
{ "type": "interval", "everyMs": 60000 }
```

`event` 和 `state` 作为待实现的 source 类型预留：

```text
event -> 订阅内部事件总线
state -> 轮询内部状态
```

这两类 source 的 schema、调度实现和审计行为需要后续单独落地。

## Script

`script` 可选。存在时，daemon 在 trigger 触发后执行同目录脚本；不存在时，daemon 直接使用 source payload 构造 result 进入 feedback。

```json
{
  "path": "./check-agent-idle.js",
  "runtime": "node",
  "args": {
    "lookbackMs": 600000
  },
  "timeoutMs": 30000
}
```

字段语义：

| 字段 | 含义 |
|---|---|
| `path` | 相对 trigger 目录的脚本路径 |
| `runtime` | 执行器，如 `node` / `python` / `bash` |
| `args` | 传给脚本的业务配置 |
| `timeoutMs` | 脚本最大运行时间，上限 15 分钟（900000ms） |

`args` 只放脚本业务参数。`timeoutMs` 是 daemon 执行控制参数，不放入 `args`。

第一版只实现 `timeoutMs`（脚本总运行时间限制）。`idleTimeoutMs`（无输出超时检测）作为后续优化预留。

Daemon 通过 stdin JSON 传参，不拼 shell command：

```json
{
  "trigger": {
    "id": "trig_agent_idle_notify",
    "name": "agent_idle_notify",
    "agentAid": "eleanbot.agentid.pub"
  },
  "run": {
    "id": "run_123",
    "firedAt": 1781510000000
  },
  "source": {
    "type": "interval",
    "payload": {
      "everyMs": 60000
    }
  },
  "args": {
    "lookbackMs": 600000
  }
}
```

脚本 stdout 输出 result JSON：

```json
{
  "matched": true,
  "text": "agent 已经 10 分钟没有输出",
  "data": {
    "idleMs": 612000
  }
}
```

退出码只分两类：

| 退出码 | 含义 |
|---|---|
| `0` | 脚本成功，daemon 解析 stdout result |
| 非 `0` | 脚本失败，daemon 读取 stdout/stderr 形成 error |

业务上的命中或未命中由 `result.matched` 表达，不使用退出码编码。

## Feedback

`feedback` 决定 result 怎么处理。所有 feedback 都只能由 `trigger.agentAid` 执行。

### Target 结构

direct-message 和 agent-runner 共用同一套 `target` 结构，描述「发给哪个 channel / 哪个 session」：

```json
{
  "channelType": "feishu",
  "channelName": "feishu#evolai.agentid.pub#feishu",
  "channelId": "ou_xxx",
  "sessionStrategy": "latest",
  "sessionId": "meta_20260615_xxx",
  "threadId": "thread-456"
}
```

字段规则：

| 字段 | 必填 | 依赖关系 |
|---|---|---|
| `channelType` | 是 | 渠道类型（feishu / aun / wechat） |
| `channelName` | 否 | 精确 channel 实例名；多实例时由 `/trigger` 创建入口写入，老数据缺失时按 `channelType` 回退 |
| `channelId` | 是 | 渠道内的目标 ID（ou_xxx / AID / openid） |
| `sessionStrategy` | 否 | 默认 `latest`，可选 `latest` / `current` / `thread` |
| `sessionId` | 条件必填 | `sessionStrategy=current` 时必填 |
| `threadId` | 条件必填 | `sessionStrategy=thread` 时必填 |

`sessionStrategy` 不能脱离 `channelType` + `channelId` 单独存在。`channelName` 用于同一 agent 下同类型多实例的精确出站路由，不改变接收目标身份。三种策略：

- `latest`（默认）：取该 channel+channelId 下最近更新的 session，无需额外字段。
- `current`：发到指定的 `sessionId`，必须显式提供 `sessionId`。
- `thread`：发到指定 thread 的 session，必须显式提供 `threadId`。

创建时校验：
- `channelType` + `channelId` 必填。
- `trigger.agentAid` 是否配置了 `channelType` 对应的 channel；未配置则拒绝。
- 若提供 `channelName`，必须能定位到 `trigger.agentAid` 下对应的 channel 实例；未提供时按 `channelType` 查找首个兼容实例，兼容老数据。
- `sessionStrategy=current` 缺 `sessionId`、`sessionStrategy=thread` 缺 `threadId`，均拒绝。

### direct-message

```json
{
  "mode": "direct-message",
  "target": {
    "channelType": "feishu",
    "channelName": "feishu#evolai.agentid.pub#feishu",
    "channelId": "ou_xxx"
  },
  "template": "{{result.text}}"
}
```

语义：由 `trigger.agentAid` 对应的 channel adapter 直接发送消息，不经过 agent-runner 队列，不依赖 session 上下文。

**失败处理**（带 deadline，默认 30s）：

```text
send 成功                    -> completed
send 瞬时错误（retryable）   -> backoff 重试（网络/限流/channel 重连中）
send 永久错误（非 retryable）-> 立即 failed，不重试（peerId 非法 / channel 未配置）
deadline 到仍失败            -> failed (send_error)
```

当前实现先采用 pragmatic 分类，不要求 channel adapter 统一抛结构化错误：

| 分类 | 判定来源 | 例子 | 行为 |
|---|---|---|---|
| retryable | HTTP 状态 / 错误码 / message 文本 | 408、429、5xx、timeout、rate limit、network、disconnect、not connected、`ECONNRESET`、`ECONNREFUSED`、`ETIMEDOUT`、`EAI_AGAIN`、socket hang up、gateway、service unavailable | 继续按 1s backoff 重试，直到 deadline |
| permanent | HTTP 状态 / 错误码 / message 文本 | 普通 4xx、auth、unauthorized、forbidden、permission、invalid、bad request、not found、unknown receiver、user/chat/peer/target not found、not configured、unsupported | 立即 failed，不消耗 deadline 重试 |
| unknown | 无法判断 | adapter 抛出的未知错误文本 | 暂按 retryable 处理，避免瞬时通道问题被过早判死 |

每次发送尝试都写入 audit 的 `effects`，可数清重试次数。

后续若各 channel adapter 统一抛 `{ code, retryable }`，这里应优先使用结构化字段，再退回文本分类。

### agent-runner

```json
{
  "mode": "agent-runner",
  "target": {
    "channelType": "feishu",
    "channelName": "feishu#evolai.agentid.pub#feishu",
    "channelId": "oc_xxx",
    "sessionStrategy": "latest"
  },
  "template": "这是触发器结果，不是用户直接消息。\n{{result.text}}"
}
```

语义：把 trigger result 注入 `trigger.agentAid` 的 agent-runner 队列。注入内容必须明确标记为 trigger 信息，不能伪装成用户消息。

**Session 查找**（执行时）：
- `current`：直接定位 `sessionId` 对应 session。
- `thread`：定位 `channelType` + `channelId` + `threadId` 的 thread session。
- `latest`：取 `channelType` + `channelId` 下最近更新的 session。
- 查找不到可用 session：记录 audit 错误，run 标记 `failed`（reason `session_not_found`）。

**队列交互**（带 deadline，默认 30s）：

```text
目标队列空闲          -> 入队，立即执行 -> completed
目标队列有 active 任务 -> 不入队，等待 task:completed 事件后重试
deadline 到仍未空闲    -> skipped (queue_busy_timeout)
```

队列繁忙期间 run 处于 `feedback-pending` 中间态，run 仍 open，同一 trigger 再次触发由 `concurrency` 判定处理。注意此分支终态是 `skipped`（队列门一直没开，从未真正入队），区别于 direct-message 发送失败的 `failed`（真的尝试了投递但出错）。

### none

```json
{
  "mode": "none"
}
```

只记录 run，不产生用户可见反馈。

### 分支规则

```text
script exit 0 且 result.matched !== false -> feedback.onSuccess
script exit 0 且 result.matched === false -> feedback.onNoop，缺省为 none
script exit 非 0 或 daemon 执行失败 -> feedback.onFailure
```

无 script 时，daemon 构造默认 result：

```json
{
  "matched": true,
  "text": "",
  "data": {
    "source": {}
  }
}
```

### skipped vs failed 的语义区分

两类「未成功」终态故意分开，便于排障：

- `skipped`：前置条件一直不满足，**从未真正尝试副作用**。例如 `concurrency_forbid`、`queue_busy_timeout`、`missed_skip`。
- `failed`：**尝试了副作用但出错**。例如 `script_error`、`script_timeout`、`session_not_found`、`send_error`。

## Reliability

```json
{
  "concurrency": "forbid",
  "missedPolicy": "run_once",
  "scriptRetry": {
    "maxAttempts": 0,
    "backoffMs": 30000
  }
}
```

字段语义：

| 字段 | 可选值 | 含义 |
|---|---|---|
| `concurrency` | `forbid` / `replace` / `allow` | 同一 trigger 上次 run 未结束时如何处理 |
| `missedPolicy` | `skip` / `run_once` / `run_all` | daemon 停机或延迟导致错过触发时间后如何处理 |
| `scriptRetry.maxAttempts` | number | 脚本执行失败后的额外重试次数 |
| `scriptRetry.backoffMs` | number | 重试间隔 |

第一版默认：

```json
{
  "concurrency": "forbid",
  "missedPolicy": "run_once",
  "scriptRetry": {
    "maxAttempts": 0,
    "backoffMs": 30000
  }
}
```

`reliability` 不包含 `runTimeoutMs`。脚本超时由 `script.timeoutMs` 控制，feedback 投递超时由 daemon 内部固定 deadline（默认 30s）处理。

**Retry 语义明确**：`scriptRetry` 只针对脚本执行失败（exit code 非 0）时的重试。Feedback 投递失败有独立的 deadline 重试机制（见 Feedback 章节），不受 `scriptRetry` 控制。

### MissedPolicy 当前语义

`missedPolicy` 只处理“daemon 没有在计划时间附近启动 run”的情况，不处理 run 内部失败；脚本失败交给 `scriptRetry` 和 `feedback.onFailure`。

当前覆盖：

| source | 持久化依据 | `skip` | `run_once` | `run_all` |
|---|---|---|---|---|
| `delay` | `createdAt + afterMs` | 若 daemon 注册时已过期，写 `skipped(missed_skip)`，随后停用 trigger | 若已过期，立即执行一次，run 善终后停用 trigger | 无额外意义；当前不要依赖 |
| `at` | `source.at` | 若 daemon 注册时已过期，写 `skipped(missed_skip)`，随后停用 trigger | 若已过期，立即执行一次，run 善终后停用 trigger | 无额外意义；当前不要依赖 |
| `interval` | `active.json.schedule.nextFireAt` | 若重启后 `nextFireAt` 已错过，写一条 `skipped(missed_skip)`，推进到下一次 | 若重启后 `nextFireAt` 已错过，立即补跑一次，推进到下一次 | schema 预留，但当前不枚举全部错过周期 |
| `cron` | `active.json.schedule.nextFireAt` | 若重启后 `nextFireAt` 已错过，写一条 `skipped(missed_skip)`，按 cron 表达式推进到下一次 | 若重启后 `nextFireAt` 已错过，立即补跑一次，按 cron 表达式推进到下一次 | schema 预留，但当前不枚举全部错过周期 |

`active.json.schedule` 只用于周期 source：

```json
{
  "runs": {},
  "schedule": {
    "nextFireAt": 1781510000000,
    "updatedAt": 1781509940000,
    "sourceSignature": "{\"type\":\"interval\",\"everyMs\":60000}"
  }
}
```

生命周期：

- daemon 首次注册 `cron` / `interval` 且没有有效游标时，按当前时间计算 `nextFireAt` 并写入。
- 每次周期触发后，在开始 run 前推进到下一次；因此 daemon 重启时可以知道上次计划的周期点是否已错过。
- create / update / enable 会清理旧游标；source 配置变化导致 `sourceSignature` 不匹配时，也会重新计算游标。
- `run_all` 需要先定义上限，例如 `maxCatchupRuns`、`maxCatchupWindowMs` 和审计聚合方式，否则长时间停机可能造成大量补跑和副作用风暴。

### Concurrency 判定

判定依据「同一 trigger 是否有未善终的 run」。

- **判定状态**：内存 `runningTriggers: Map<triggerId, RunContext>`，是 `active.json` 的内存镜像。判定 O(1)，不读盘。
- **判定时机**：source 触发时，进入 run 创建流程的第一步。
- **Run 边界**：script 开始 → feedback 完成（见运行生命周期）。run 善终前始终算「未结束」。

```text
source 触发
  runningTriggers.has(triggerId)?
    否 -> 创建 run，登记 runningTriggers + active.json
    是 -> 按 concurrency:
            forbid  -> 跳过本次，写 skipped(concurrency_forbid)，记 conflictRunId
            replace -> kill 旧 run 的脚本进程，旧 run 标 failed(replaced, replacedBy)，启动新 run
            allow   -> 不检查，并行启动新 run（active.json 支持同 trigger 多 run）
```

- `forbid`（默认）：适合不希望积压的场景（健康检查、空闲检测）。
- `replace`：按 Run 边界，feedback 已是瞬时（入队即执行 / 进不去就等待），唯一耗时阶段是 script，所以 replace 实际只中断 script 阶段（kill 子进程）。旧 run 终态 `failed`，reason `replaced`。
- `allow`：仅适合无副作用脚本；并行脚本若写文件/调 API 可能冲突。

判定状态 daemon 重启后从 `active.json` 重建（见持久化模型）。

## Run 状态与持久化模型

### Run 状态枚举

**终态**（写入 `logs/trigger-runs.log`，参与调度统计）：

| 状态 | 含义 | reason code 示例 |
|---|---|---|
| `completed` | feedback 成功投递（direct-message 发出 / agent-runner 入队执行） | — |
| `noop` | script 返回 `matched=false` 且 onNoop=none，刻意无反馈 | `matched_false` |
| `skipped` | 按策略/条件未执行副作用，**无错误** | `concurrency_forbid` / `queue_busy_timeout` / `missed_skip` |
| `failed` | 执行或投递**出错** | `script_error` / `script_timeout` / `session_not_found` / `send_error` / `replaced` / `daemon_restart` |
| `dry-run` | 模拟执行，不更新 lastFiredAt/计数/调度 | — |

**中间态**（仅存在于 `active.json`，可被折叠重建，非终态）：

| 状态 | 阶段 |
|---|---|
| `running` | script 执行中 |
| `feedback-pending` | feedback 等待队列空闲 / 重试发送中 |

`feedback-pending` 期间 run 仍 open，同一 trigger 再触发由 `concurrency: forbid` 自然跳过——与「run 边界含 feedback」一致。

### 两类持久化文件

runtime state 和审计历史是两种不同性质的数据，分开存储：

| 文件 | 性质 | 位置 | 生命周期 |
|---|---|---|---|
| `active.json` | runtime state 快照（可变） | `data/triggers/<aid>/<triggerId>/active.json` | 存在 open run 或周期 schedule 时存在；两者都为空时删除 |
| `trigger-runs.log` | 审计历史（append-only） | `logs/trigger-runs.log` | 复用现有 logger 滚动机制（`daily` 切片 + retention 7 天） |

职责切分：
- `active.json.runs` 持有正在跑的 run 事件流，供 concurrency 判定 + 重启恢复，**不进 log**。
- `active.json.schedule` 持有周期 source 的下一次计划触发点，供 missedPolicy 判断，**不记录 run 过程**。
- `trigger-runs.log` 只收善终后的汇总记录，**不含 active 中的中间事件**。
- 两个文件无重叠：active 是「当前 runtime state」，log 是「过去」。

### active.json — runtime state 快照

每次阶段转换或周期计划点推进时**原子重写整份**（快照写法，非 append）。run 善终后清空该 run 的条目；周期 trigger 空闲时仍可只保留 `schedule` 字段。

```json
{
  "runs": {
    "run_1781510180000_g7h8": {
      "phase": "feedback-pending",
      "triggerId": "trig_idle",
      "startedAt": 1781510180000,
      "deadlineAt": 1781510210202,
      "events": [
        { "seq": 0, "event": "run.started", "ts": 1781510180000 },
        { "seq": 1, "event": "script.completed", "ts": 1781510180200, "exitCode": 0 },
        { "seq": 2, "event": "feedback.pending", "ts": 1781510180202, "reason": "queue_busy" }
      ]
    }
  },
  "schedule": {
    "nextFireAt": 1781510240000,
    "updatedAt": 1781510180202,
    "sourceSignature": "{\"type\":\"interval\",\"everyMs\":60000}"
  }
}
```

- 内存 `runningTriggers: Map` 是主，`active.json` 是其持久化镜像；concurrency 判定读内存 O(1)，仅阶段转换时重写文件。
- `concurrency: allow` 下 `runs` 为 map，天然支持同一 trigger 多并发 run。
- 严格“当前执行”和“下一次计划”不能互斥：周期 trigger 在当前 run 尚未结束时，下一次计划点可能已经推进；因此同一个 `active.json` 允许 `runs` 和 `schedule` 同时存在。
- 重启恢复：扫描各 trigger 目录的 `active.json.runs`，非空即未善终 run，按 phase 标终态（`running`→`failed`，`feedback-pending`→`skipped`），刷一条恢复记录到 `trigger-runs.log`，仅清空 `runs`，保留 `schedule` 供 missedPolicy 使用。

### active.json.schedule — 周期调度游标

只对 `cron` / `interval` source 写入；`delay` / `at` 不需要游标，因为计划点可直接由 definition 算出。

```json
{
  "runs": {},
  "schedule": {
    "nextFireAt": 1781510000000,
    "updatedAt": 1781509940000,
    "sourceSignature": "{\"type\":\"interval\",\"everyMs\":60000}"
  }
}
```

- `nextFireAt` 是下一次计划触发时间，不是最近一次实际触发时间。
- `sourceSignature` 来自 source 配置，用于识别 cron 表达式、timezone 或 interval 周期变化；不匹配时丢弃旧游标并重新计算。
- daemon 重启时若 `nextFireAt` 已落后于当前时间，按 `missedPolicy` 生成补跑或跳过行为。
- `schedule` 字段不参与 concurrency 判定，也不记录 feedback / script 状态。

### trigger-runs.log — 审计历史

run 善终时把 active.json 的事件流**汇总成一条记录**写入，一 run 一行 JSON：

```json
{
  "runId": "run_1781510000000_abcd",
  "triggerId": "trig_agent_idle_notify",
  "agentAid": "eleanbot.agentid.pub",
  "startedAt": 1781510000000,
  "finishedAt": 1781510001234,
  "status": "completed",

  "definition": {
    "schemaVersion": 1,
    "revision": "sha256:...",
    "name": "agent_idle_notify"
  },

  "source": {
    "type": "interval",
    "scheduledAt": 1781510000000,
    "firedAt": 1781510000002,
    "payload": { "everyMs": 60000 }
  },

  "script": {
    "path": "./check-agent-idle.js",
    "runtime": "node",
    "argsHash": "sha256:...",
    "inputHash": "sha256:...",
    "exitCode": 0,
    "durationMs": 230,
    "stdoutBytes": 96,
    "stderrBytes": 0,
    "result": {
      "matched": true,
      "text": "agent 已经 10 分钟没有输出",
      "data": { "idleMs": 612000 }
    }
  },

  "feedback": {
    "branch": "onSuccess",
    "mode": "direct-message",
    "target": { "channelType": "feishu", "channelName": "feishu#evolai.agentid.pub#feishu", "channelId": "ou_xxx" },
    "renderedTextHash": "sha256:...",
    "renderedTextPreview": "agent 已经 10 分钟没有输出"
  },

  "effects": [
    {
      "type": "message.send",
      "status": "success",
      "channelType": "feishu",
      "channelId": "ou_xxx",
      "messageId": "om_xxx",
      "attempt": 1,
      "startedAt": 1781510001000,
      "finishedAt": 1781510001234
    }
  ],

  "error": null
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `runId` | 单次执行 ID，格式 `run_<firedAt>_<rand>` |
| `status` | 终态枚举，见上表 |
| `definition.revision` | 执行时 `trigger.json` 规范化后的 hash |
| `source` | 本次触发来源、计划时间和实际触发时间 |
| `script.argsHash` / `inputHash` | 保留可追溯性，避免审计日志无限膨胀 |
| `script.result` | 脚本结构化结果；超大字段应截断或落外部 blob |
| `feedback` | daemon 选择的反馈分支和渲染摘要 |
| `effects` | daemon 实际尝试的副作用（每次发送/入队尝试一条，可数清重试） |
| `error` | 失败时的结构化错误 |

脚本失败但 onFailure 投递成功的记录示例（注意 `status=completed`，脚本失败信息在 `script` + `branch=onFailure`）：

```json
{
  "runId": "run_1781510120000_e5f6",
  "triggerId": "trig_health",
  "status": "completed",
  "source": { "type": "interval", "firedAt": 1781510120000 },
  "script": {
    "exitCode": 1,
    "durationMs": 498,
    "stderrBytes": 128,
    "error": { "code": "SCRIPT_EXIT_NON_ZERO", "stderrPreview": "DB connection refused" }
  },
  "feedback": { "branch": "onFailure", "mode": "direct-message" },
  "effects": [
    { "type": "message.send", "status": "success", "messageId": "om_zz", "attempt": 1 }
  ],
  "error": null
}
```

> run 终态描述「这次 run 的处理是否善终」，不等于「脚本是否成功」。脚本失败但 onFailure 成功投递 → `completed`；用 `feedback.branch` 区分是否走了失败分支，不污染 status 枚举。

### 审计约束

- `trigger-runs.log` append-only，复用现有 logger（`daily` 切片，归档名 `trigger-runs-YYYYMMDD.log`，活跃文件固定 `trigger-runs.log`，retention 7 天）。
- 正式 run 和 dry-run 必须区分，dry-run 不更新调度统计、不写 active.json。
- 不默认写入完整 stdout/stderr，避免泄露敏感数据和撑爆日志；保留 bytes、hash、preview。
- 发送消息、agent-runner 注入等副作用都必须写入 `effects`。
- 若 feedback 渲染出长文本，记录 hash 和 preview；完整内容可按配置落 blob。
- 对外查询通过 `ec trigger show/list`，避免用户直接依赖文件名。

## CLI：`ec trigger`

现有 CLI 只有 `ec ctl "trigger ..."` 间接路径，依赖 `EVOLCLAW_SESSION_ID`，只适合被托管会话内调用。下一版需要增加顶级命令：

```text
ec trigger <subcommand>
```

`ec trigger` 是 daemon 级入口，通过 IPC 直接调用 TriggerDefinitionManager / TriggerRuntimeScheduler，不经过 agent，不要求当前有活跃 session。

### 命令形态

```text
ec trigger list --agent <aid> [--all] [--json]
ec trigger show --agent <aid> <triggerId> [--json]
ec trigger create --file <trigger.json|trigger-dir> [--enable]
ec trigger update --agent <aid> <triggerId> --file <trigger.json>
ec trigger enable --agent <aid> <triggerId>
ec trigger disable --agent <aid> <triggerId>
ec trigger cancel --agent <aid> <triggerId>
ec trigger run --agent <aid> <triggerId> [--dry-run]
ec trigger template list [--json]
ec trigger template show <name> [--json]
ec trigger create --template <name> --var key=value ...
```

说明：

| 命令 | 含义 |
|---|---|
| `list` | 列出指定 agent 的 trigger |
| `show` | 查看单个 trigger definition 和最近 run 摘要 |
| `create` | 从 JSON 文件或 trigger 目录注册 |
| `update` | 替换已有 trigger definition，保留 run history |
| `enable` / `disable` | 启停 trigger |
| `cancel` | 取消 trigger，移入历史或标记 done |
| `run` | 手动触发一次，用于调试 |
| `template list/show` | 查看可用 trigger 模板 |
| `create --template` | 从模板生成 trigger 目录并注册 |

`create --file` 支持两种输入：

```text
ec trigger create --file ./trigger.json
ec trigger create --file ./trig_agent_idle_notify/
```

当输入是目录时，目录内必须有 `trigger.json`，脚本文件按 `script.path` 从该目录复制到 daemon 管理目录。

### CLI 与 agentAid

`trigger.agentAid` 是唯一执行主体。`ec trigger create` 读取 `trigger.json` 内的 `agentAid`，不通过 `--agent` 覆盖，避免命令行参数和持久化定义冲突。

其他命令使用 `--agent <aid>` 定位存储目录：

```text
data/triggers/<agentAid>/
```

如果 `--agent` 与 trigger 文件中的 `agentAid` 不一致，应拒绝。

### IPC 协议

`ec trigger` 不走 `ctl`。新增 IPC command family：

```json
{ "type": "trigger.list", "agentAid": "eleanbot.agentid.pub", "all": false }
```

```json
{ "type": "trigger.show", "agentAid": "eleanbot.agentid.pub", "triggerId": "trig_123" }
```

```json
{
  "type": "trigger.create",
  "definition": {},
  "files": [
    {
      "relativePath": "check-agent-idle.js",
      "contentBase64": "..."
    }
  ],
  "enable": true
}
```

```json
{ "type": "trigger.update", "agentAid": "eleanbot.agentid.pub", "triggerId": "trig_123", "definition": {} }
```

```json
{ "type": "trigger.setEnabled", "agentAid": "eleanbot.agentid.pub", "triggerId": "trig_123", "enabled": false }
```

```json
{ "type": "trigger.cancel", "agentAid": "eleanbot.agentid.pub", "triggerId": "trig_123" }
```

```json
{ "type": "trigger.run", "agentAid": "eleanbot.agentid.pub", "triggerId": "trig_123", "dryRun": true }
```

Daemon 负责校验：

- `agentAid` 对应 agent 存在且 trigger scheduler 可用。
- `definition.agentAid` 与请求 agent 一致。
- `script.path` 位于 trigger 目录内。
- `feedback` 只能由 `definition.agentAid` 执行。
- `source` / `script` / `feedback` / `reliability` 符合 schema。

### 与 `/trigger` 的关系

`/trigger` 保留为会话内简化入口，适合自然语言或 agent 工具调用场景。

`ec trigger` 是结构化运维入口，适合：

- 导入复杂 trigger definition。
- 附带同目录脚本文件。
- 管理不绑定当前 session 的 trigger。
- 自动化部署和调试。

`ec ctl "trigger ..."` 只作为兼容路径，不作为下一版主要接口。

## Trigger 模板

模板未来需要实现，但它只参与创建阶段，不改变运行时模型。

模板职责：

- 生成 `trigger.json`。
- 生成同目录脚本文件。
- 提供变量 schema、默认值和说明。
- 降低常见 trigger 的创建成本。

模板不承担运行时职责。创建完成后，daemon 只认持久化后的 trigger 目录：

```text
template -> render -> data/triggers/<agentAid>/<triggerId>/trigger.json + script files
```

模板示例布局：

```text
kits/trigger-templates/
  agent-idle-notify/
    template.json
    trigger.json.tpl
    check-agent-idle.js
```

`template.json` 示例：

```json
{
  "name": "agent-idle-notify",
  "description": "检测 agent 长时间无输出后反馈",
  "variables": {
    "agentAid": { "type": "string", "required": true },
    "channelType": { "type": "string", "required": true },
    "channelName": { "type": "string", "required": false },
    "channelId": { "type": "string", "required": true },
    "lookbackMs": { "type": "number", "default": 600000 }
  }
}
```

CLI 示例：

```text
ec trigger template list
ec trigger template show agent-idle-notify
ec trigger create --template agent-idle-notify \
  --var agentAid=eleanbot.agentid.pub \
  --var channelType=feishu \
  --var channelId=ou_xxx \
  --var lookbackMs=600000
```

渲染后仍然必须经过同一套 schema 校验、路径校验和权限校验。

## 模拟测试

创建后的模拟测试功能未来需要实现，用于在不真正发送消息、不注入 agent-runner 的情况下验证 trigger 行为。

建议提供：

```text
ec trigger run --agent <aid> <triggerId> --dry-run
ec trigger test --file <trigger.json|trigger-dir>
ec trigger test --agent <aid> <triggerId> --source-payload <json|file>
```

模拟测试分层：

| 层级 | 作用 |
|---|---|
| schema validate | 校验 `trigger.json` 字段、枚举、必填和默认值 |
| source simulate | 用指定 source payload 构造一次虚拟触发 |
| script execute | 按 `script` 配置执行脚本，传入 stdin JSON |
| feedback render | 渲染 feedback template |
| side-effect dry-run | 返回将要执行的 direct-message 或 agent-runner payload，但不发送、不入队 |

`--dry-run` 输出示例：

```json
{
  "ok": true,
  "triggerId": "trig_agent_idle_notify",
  "script": {
    "exitCode": 0,
    "result": {
      "matched": true,
      "text": "agent 已经 10 分钟没有输出",
      "data": {
        "idleMs": 612000
      }
    }
  },
  "feedback": {
    "branch": "onSuccess",
    "mode": "direct-message",
    "senderAgentAid": "eleanbot.agentid.pub",
    "target": {
      "channelType": "feishu",
      "channelId": "ou_xxx"
    },
    "text": "agent 已经 10 分钟没有输出"
  },
  "sideEffects": []
}
```

模拟测试必须保证：

- 不发送网络消息。
- 不注入 agent-runner 队列。
- 不更新 trigger 的 `lastFiredAt`、计数和调度时间。
- 可以写独立 test run 日志，但不能污染正式 run 审计记录，除非显式加 `--record`。

## 与现有 trigger 的关系

Legacy 输入（仅迁移读取，不再作为运行真相源）：

```text
data/triggers/<aid>/triggers.json
data/triggers/<aid>/history.jsonl
```

当前运行真相源：

```text
data/triggers/<aid>/<triggerId>/trigger.json    # 定义
data/triggers/<aid>/<triggerId>/active.json     # runtime state：open runs + 周期 source 调度游标
logs/trigger-runs.log                            # 审计历史，复用现有 logger 滚动
```

daemon 首次加载某个 agent 的 trigger manager 时，如果发现 `data/triggers/<aid>/triggers.json`，会尝试迁移到 per-trigger 目录结构，然后把原文件改名为 `triggers.legacy.migrated.<ts>.json`。`history.jsonl` 不再参与运行时决策；新的运行审计写入 `logs/trigger-runs.log`。

Legacy 字段中的 `schedulerAid` 语义在当前模型中收敛为根字段 `agentAid`。Legacy 字段中的 `targetChannel` / `targetChannelId` 语义收敛到 `feedback.<branch>.target` 的 `channelName` / `channelType` / `channelId`：`targetChannel` 若是完整实例名则保留为 `channelName`，并从中解析 `channelType`；无法解析时按老字段回退。

旧的合成字段（`peerId: __trigger__:<id>`、`messageId: trigger:<id>:<fireTime>`）在当前模型中废弃：

- 不再用 `__trigger__:` 前缀防 session 合并；session 定位改由 `feedback.target` 的 `sessionStrategy`（latest/current/thread）显式表达。
- `messageId` 合成 ID 由 `runId`（`run_<firedAt>_<rand>`）替代，作为 run 审计与事件追踪的关联键；实际发送返回的 channel messageId 记入 `effects`。

## 非目标

- 不支持 generated script。
- 不支持 script 决定 feedback mode、target 或 action。
- 不支持跨 agent feedback。
- 不在 trigger 定义中落 `permissions`。
- 不用 YAML。
- 第一版可以不实现模板和模拟测试，但 schema、CLI 命名和目录布局需要为它们预留空间。

## 实施计划

基于架构简化和边界明确，第一版实施计划：

### Phase 1：核心功能（预计 18-25 天）

| 模块 | 工作量 | 说明 |
|------|--------|------|
| Schema + Types | 1-2天 | trigger.json schema 定义、TypeScript 类型、校验逻辑 |
| TriggerDefinitionManager | 2-3天 | CRUD、目录管理、路径安全检查、sessionKey 格式校验 |
| TriggerRuntimeScheduler（简化版） | 2-3天 | delay/at/cron/interval 四种 source 类型 |
| ScriptExecutor（简化版） | 2-3天 | stdin JSON 传参、stdout 捕获、timeoutMs（最大 15 分钟） |
| FeedbackDispatcher | 2天 | 三分支逻辑（onSuccess/onNoop/onFailure）+ 模板渲染 |
| DirectMessageService | 1-2天 | sessionKey 解析 + channel adapter 调用 |
| AgentRunnerQueue 扩展 | 2-3天 | 注入逻辑 + session 查找策略（latest/current/thread）+ 队列交互 + 兜底处理 |
| RunStateStore | 1-2天 | active.json 快照原子重写、concurrency 内存镜像、周期调度游标、重启恢复扫描 |
| AuditLogger | 1天 | 善终 run 汇总写入 logs/trigger-runs.log（复用现有 logger） |
| CLI (ec trigger) | 3-4天 | IPC 协议扩展、命令实现（list/show/create/update/enable/disable/run） |
| 测试 | 3-4天 | 单元测试 + 集成测试 + 边界测试 |
| **总计** | **19-27天** | |

### 关键技术决策

1. **Cron 库选择**：推荐 `node-cron`（轻量、7.3k⭐）
2. **Target 解析**：`channelType` + `channelId` 必填，`channelName` 可选用于同类型多实例精确路由，`sessionStrategy` 默认 `latest`（current→sessionId / thread→threadId）
3. **Timeout 实现**：使用 AbortController + setTimeout，跨平台兼容
4. **Agent-runner 兜底**：session 查找失败时记录 audit 错误，run 标记 failed
5. **持久化模型**：`active.json` 快照重写（`runs` 负责 concurrency + 重启恢复，`schedule` 负责周期下一次计划点）；审计历史 `logs/trigger-runs.log` 复用现有 logger 滚动机制
6. **Concurrency 判定**：内存 `runningTriggers` Map（active.json 镜像），source 触发时 O(1) 判定

### 后续 Phase（待定）

- **Phase 2**：event/state source 类型
- **Phase 3**：Trigger 模板系统
- **Phase 4**：完整 Trigger test harness（`ec trigger run --dry-run` 已在 Phase 1 落地，仍需 `ec trigger test --file` / `--source-payload`）
- **Phase 5**：idleTimeoutMs 无输出超时检测
