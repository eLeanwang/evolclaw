# Trigger 系统重构方案

**日期**: 2026-06-21  
**状态**: V2 已落地，专用 Trigger V2 集成测试、相关单元测试与集成 smoke tests 已通过；真实渠道端到端测试待补充

---

## 一、改造目标

将现有 Trigger 系统从"Script + Feedback 三分支"模式重构为三层解耦架构：

1. **触发层（Source）**：决定什么时候触发
2. **处理层（Processing）**：决定产出什么内容
3. **反馈层（Feedback）**：决定内容如何投递

### 已落地范围

- Source 保持现有 `delay` / `at` / `cron` / `interval`
- Processing 做单态：`script` / `template` / `prompt` 三选一
- Feedback 保留 `direct-message` / `agent-session` / `none`
- Session strategy 保留 `latest` / `current` / `thread`
- `thread` 通过 `thread.mode = reuse | once` 控制固定 thread 或每次新建 thread
- 暂不引入 `selfactive` chatMode
- 暂不支持 `script + prompt` pipeline
- `prompt + feedback:none` 仅允许搭配 thread session

## 实施状态（2026-06-22）

本轮已完成 Trigger V2 主要改造：

- `$schema_version` 固定为 `2`，Trigger 定义统一归一化为 V2 结构。
- `session.channelKey` / `session.channelId` / `session.strategy` / `session.thread` 已替代旧的 `channelType + channelName + targetSessionStrategy` 组合。
- `feedback.mode=agent-runner` 作为旧名兼容输入，归一化后统一存储和执行为 `agent-session`。
- `processing.mode` 已做单态：`script` / `template` / `prompt`。
- `latest` 只选择主会话，排除 thread 会话；找不到主会话时自动创建主会话。
- `current` 按 `sessionId` 直接绑定复用，主会话和 thread 都不切换 active session。
- `thread.mode=reuse` 复用固定 thread；`thread.mode=once` 每次 run 生成 `trigger:<triggerId>:<runId>`。
- `prompt + none` 仅允许 thread session；执行时设置 `triggerMeta.silent=true` 和 `chatModeOverride=proactive`，不永久修改 session chatMode。
- `script/template + agent-session` 已实现：daemon 渲染处理结果后注入目标 agent session。
- `script -> prompt` pipeline 仍未实现，后续需要新增显式 pipeline processing。

主要落地文件：

- `src/trigger/types.ts`：V2 类型、processing/feedback/session 定义。
- `src/trigger/validation.ts`：schema 归一化、legacy 兼容、语义校验。
- `src/trigger/feedback.ts`：direct-message / agent-session 投递、session 解析、silent trigger 入队。
- `src/trigger/scheduler.ts`：processing 单态执行、run/audit 状态。
- `src/trigger/manager.ts`：触发器存储与 legacy triggers.json 迁移。
- `src/trigger/script-executor.ts`：脚本 stdin/stdout 协议。
- `src/core/message/message-processor.ts`：silent trigger 输出抑制、proactive override、bound session 复用。
- `src/core/command/command-handler.ts`、`src/cli/trigger-command.ts`：CLI/菜单创建和更新路径的 V2 组装。

### 核心问题

改造前架构问题：
- Agent-runner 既是处理器又是发送者，职责混淆
- 配置复杂：三分支（onSuccess/onNoop/onFailure）x 三模式（none/direct-message/agent-runner）
- 用户主会话忙碌时，指向主会话的 agent-runner trigger 会等待队列，30s 超时后跳过

新架构解决：
- 职责解耦：触发/处理/反馈各司其职
- 配置简化：Processing 单态 + Feedback 投递方式
- 并发路径明确：需要和主会话并行时使用 thread session

---

## 二、配置结构

```json
{
  "$schema_version": 2,
  "id": "trig_daily_summary",
  "agentAid": "evolai.agentid.pub",
  "enabled": true,
  "name": "每日总结",
  "description": "每天 18:00 总结对话要点",
  "createdAt": 1718970000000,
  "updatedAt": 1718970000000,

  "origin": {
    "channel": "feishu#evolai.agentid.pub#default",
    "peerId": "ou_xxx",
    "sessionKey": "feishu#ou_xxx#main"
  },

  "source": {
    "type": "cron",
    "expression": "0 18 * * *",
    "timezone": "Asia/Shanghai"
  },

  "session": {
    "channelKey": "feishu#evolai.agentid.pub#default",
    "channelId": "ou_xxx",
    "strategy": "thread",
    "thread": {
      "mode": "reuse",
      "threadId": "trigger:trig_daily_summary"
    }
  },

  "processing": {
    "mode": "prompt",
    "prompt": "总结今天的对话要点，如无重要内容则不发送"
  },

  "feedback": {
    "mode": "agent-session"
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

### channelKey

`session.channelKey` 是渠道实例的唯一标识，作为路由真相源。它替代旧方案里的 `channelType + channelName` 组合。

格式：`<channelType>#<selfAID>#<name>`，例如 `feishu#evolai.agentid.pub#default`、`aun#evolai.agentid.pub#main`。

规则：
- `channelKey` 必填
- `channelId` 必填
- `channelType` 从 `channelKey` 解析或从 channel registry 查询
- AUN 场景必须保留完整 channelKey，避免同一 agent 或多 agent 下渠道实例混淆
- `origin.channel` 也应写 channelKey，便于权限和审计回溯

---

## 三、Session 配置

### 类型

```typescript
interface TriggerSession {
  channelKey: string;
  channelId: string;
  strategy: 'latest' | 'current' | 'thread';
  sessionId?: string;
  thread?: TriggerThreadSession;
}

interface TriggerThreadSession {
  mode: 'reuse' | 'once';
  threadId?: string;
  name?: string;
}
```

### Strategy 语义

| Strategy | 行为 | 适用场景 |
| --- | --- | --- |
| `latest` | 使用最近更新的主会话，必须排除 thread 会话 | 沿用当前对话上下文 |
| `current` | 使用指定 `sessionId`，不切换 active session | 精确绑定某个已存在 session |
| `thread` + `reuse` | 复用固定 thread，不存在则创建 | 周期性后台任务、和主会话并行 |
| `thread` + `once` | 每次触发创建新 thread | 无历史污染的一次性 Agent 处理 |

### 关键约束

- `latest` 只查主会话：`!session.threadId`，按 `updatedAt desc` 排序
- `latest` 找不到主会话时自动创建主会话
- `current` 指向主会话或 thread 会话时都必须无副作用复用，不能调用 `switchToSession()`
- `thread.reuse` 复用或创建指定 thread，会话持久化应使用现有 thread 的 `intent='none'` 语义，不更新 `active.json`
- `thread.once` 每次触发动态生成 threadId，例如 `trigger:${triggerId}:${runId}`
- 并发突破只依赖 thread session；主会话 `latest/current` 不承诺并发

---

## 四、Processing 配置

### Mode: script

```json
{
  "mode": "script",
  "script": {
    "path": "./check-idle.js",
    "runtime": "node",
    "args": { "lookbackMs": 600000 },
    "timeoutMs": 30000
  }
}
```

脚本通过 stdin 接收 JSON 参数，通过 stdout 输出结果：

```json
{
  "matched": true,
  "text": "检测到空闲 10 分钟",
  "data": { "idleMs": 600000 }
}
```

分支判定：
- exit 0 且 `result.matched !== false` -> `onSuccess`
- exit 0 且 `result.matched === false` -> `onNoop`
- exit 非 0 或结果解析失败 -> `onFailure`

### Mode: template

```json
{
  "mode": "template",
  "template": "今天是 {{date}}，{{time}}，早上好！"
}
```

输出为渲染后的文本。

### Mode: prompt

```json
{
  "mode": "prompt",
  "prompt": "总结今天的对话要点，如无重要内容则不发送"
}
```

`prompt` 表示将渲染后的提示注入 agent session，由底层 runner 处理。V2 中 `prompt` 支持两种反馈方式：
- `feedback.mode = agent-session`：正常注入目标 session，由 agent 输出完成反馈
- `feedback.mode = none`：仅允许目标 session 为 thread；执行时强制 thread session 使用 `proactive`，并设置 trigger 静默标记，daemon 不做 direct-message 或额外投递

### 占位符

V2 支持统一基础占位符：
- `{{timestamp}}`
- `{{date}}`
- `{{time}}`
- `{{trigger.id}}`
- `{{trigger.name}}`
- `{{trigger.agentAid}}`
- `{{session.channelKey}}`
- `{{session.channelId}}`

`script` 的 feedback template 继续支持：
- `{{result.text}}`
- `{{result.data.*}}`
- `{{error.message}}`
- `{{error.code}}`

`script + prompt` pipeline 不属于本轮范围。以后如需要，应新增明确的 pipeline processing，而不是让 `mode` 单态字段承载组合语义。

---

## 五、Feedback 配置

### Script 模式：三分支

```json
{
  "onSuccess": {
    "mode": "direct-message",
    "target": {
      "channelKey": "feishu#evolai.agentid.pub#default",
      "channelId": "ou_xxx"
    }
  },
  "onNoop": {
    "mode": "none"
  },
  "onFailure": {
    "mode": "direct-message",
    "target": {
      "channelKey": "feishu#evolai.agentid.pub#default",
      "channelId": "ou_admin"
    }
  }
}
```

### Template/Prompt 模式：单一配置

```json
{
  "mode": "direct-message",
  "target": {
    "channelKey": "feishu#evolai.agentid.pub#default",
    "channelId": "ou_xxx"
  }
}
```

说明：
- `template` 可使用 `direct-message` / `agent-session` / `none`
- `prompt` 只能使用 `agent-session`，或在 `session.strategy=thread` 时使用 `none`

### Feedback Mode

| Mode | 行为 | V2 限制 |
| --- | --- | --- |
| `direct-message` | Daemon 直接发送处理结果 | 支持 `script` / `template` |
| `agent-session` | 将处理结果注入 agent session | 支持 `script` / `template` / `prompt` |
| `none` | Daemon 不投递，仅记录日志 | 支持 `script` / `template`；`prompt` 仅限 thread session |

### Target 覆盖规则

- Feedback 有 `target` -> 使用 `feedback.target`
- Feedback 无 `target` -> 使用根层 `session`
- `target.channelKey` 与 `target.channelId` 必须同时存在

### Agent-session 注入规则

`feedback.mode = agent-session` 会把处理层产出的文本包装成 trigger message 并入队：
- `prompt`：注入渲染后的 prompt
- `template`：注入渲染后的 template 文本
- `script`：按分支选择对应 feedback template，渲染后注入 agent session

`agent-session` 是投递动作，不改变 Processing 单态语义。`script -> prompt` 这类二阶段 pipeline 仍不属于本轮范围。

---

## 六、典型组合

### 固定文本定时提醒

```json
{
  "processing": { "mode": "template", "template": "早上好！" },
  "feedback": { "mode": "direct-message" }
}
```

行为：daemon 渲染模板，daemon 发送。

### 脚本检查 + 分支通知

```json
{
  "processing": { "mode": "script", "script": { "...": "..." } },
  "feedback": {
    "onSuccess": { "mode": "direct-message" },
    "onNoop": { "mode": "none" },
    "onFailure": {
      "mode": "direct-message",
      "target": { "channelKey": "feishu#evolai.agentid.pub#default", "channelId": "ou_admin" }
    }
  }
}
```

行为：daemon 执行脚本，根据脚本结果走三分支。

### Agent 参与处理，使用固定 thread 并行

```json
{
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#default",
    "channelId": "ou_xxx",
    "strategy": "thread",
    "thread": { "mode": "reuse", "threadId": "trigger:daily-summary" }
  },
  "processing": { "mode": "prompt", "prompt": "总结今天的对话要点" },
  "feedback": { "mode": "agent-session" }
}
```

行为：daemon 将 prompt 注入固定 thread session，thread session 与主会话使用不同 queueKey，可以并行执行。

### Agent 参与处理，每次新建 thread

```json
{
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#default",
    "channelId": "ou_xxx",
    "strategy": "thread",
    "thread": { "mode": "once", "name": "一次性触发器任务" }
  },
  "processing": { "mode": "prompt", "prompt": "检查当前状态并给出处理建议" },
  "feedback": { "mode": "agent-session" }
}
```

行为：每次触发创建一个临时 thread，避免历史互相污染。

### Agent 后台自决，仅限 thread

```json
{
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#default",
    "channelId": "ou_xxx",
    "strategy": "thread",
    "thread": { "mode": "reuse", "threadId": "trigger:background-check" }
  },
  "processing": { "mode": "prompt", "prompt": "检查状态；只有需要通知时才主动发送消息" },
  "feedback": { "mode": "none" }
}
```

行为：daemon 将 prompt 注入 thread agent session。运行时强制该 thread session 使用 `proactive`，并设置 trigger 静默标记；daemon 只记录 run/audit，不做 direct-message 或额外投递。

---

## 七、Thread 并行机制

Thread session 有独立 `sessionId` 和 queueKey：

```text
主会话
sessionId: meta_001
queueKey: meta_001::path

Trigger thread
sessionId: meta_002
queueKey: meta_002::path
```

队列隔离点：
- MessageQueue 的队列 key 为 `sessionId::projectPath`
- 不同 sessionId 对应不同 queueKey
- `processing` Set 和 `processingAgent` Map 按 queueKey 隔离

注意：
- 这只说明 thread session 可与主会话并行
- 同一个 reuse thread 的多次触发仍会进入同一个 queueKey
- 是否允许同一个 trigger 多个 run 并发仍由 `reliability.concurrency` 控制

---

## 八、实现要点

### 8.1 类型定义

```typescript
type TriggerProcessingMode = 'script' | 'template' | 'prompt';

interface TriggerSession {
  channelKey: string;
  channelId: string;
  strategy: 'latest' | 'current' | 'thread';
  sessionId?: string;
  thread?: {
    mode: 'reuse' | 'once';
    threadId?: string;
    name?: string;
  };
}

interface TriggerFeedbackTarget {
  channelKey: string;
  channelId: string;
}

type TriggerFeedbackMode = 'none' | 'direct-message' | 'agent-session';
```

### 8.2 Session 解析逻辑

```typescript
async function resolveTriggerSession(definition, runId): Promise<Session> {
  const sessionConfig = definition.session;

  switch (sessionConfig.strategy) {
    case 'latest': {
      const sessions = await sessionManager.listSessions(
        sessionConfig.channelKey,
        sessionConfig.channelId
      );
      const main = sessions.filter(s => !s.threadId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return main ?? await sessionManager.getOrCreateSession(
        sessionConfig.channelKey,
        sessionConfig.channelId,
        defaultProjectPath,
        undefined,
        metadata,
        undefined,
        undefined,
        chatType,
        baseagent,
        selfAID,
        channelType
      );
    }

    case 'current': {
      if (!sessionConfig.sessionId) throw new Error('sessionId required for current strategy');
      const existing = await sessionManager.getSessionById(sessionConfig.sessionId);
      if (!existing) throw new Error('session not found');
      if (existing.channelId !== sessionConfig.channelId) throw new Error('session channelId mismatch');
      return existing;
    }

    case 'thread': {
      const mode = sessionConfig.thread?.mode ?? 'reuse';
      const threadId = mode === 'once'
        ? `trigger:${definition.id}:${runId}`
        : sessionConfig.thread?.threadId ?? `trigger:${definition.id}`;
      return await sessionManager.getOrCreateSession(
        sessionConfig.channelKey,
        sessionConfig.channelId,
        defaultProjectPath,
        threadId,
        metadata,
        sessionConfig.thread?.name,
        undefined,
        chatType,
        baseagent,
        selfAID,
        channelType
      );
    }
  }
}
```

实现时需要注意：
- `current` 只校验并复用指定 `sessionId`，不能调用 `switchToSession()`
- `thread` 创建需要 channel registry 提供 `channelType` / `selfAID` / `baseagent` / `projectPath`
- `prompt + none` 创建或解析 thread session 后，必须把本次执行的 chatMode 强制为 `proactive`，并设置 trigger 静默标记，避免 daemon 输出路径产生额外投递

### 8.3 Processing 执行

```typescript
type ProcessingOutput =
  | { kind: 'script'; branch: 'onSuccess' | 'onNoop' | 'onFailure'; text: string; result?: Record<string, unknown>; error?: TriggerError }
  | { kind: 'template'; text: string }
  | { kind: 'prompt'; text: string };
```

规则：
- `script` 负责执行脚本并判定 branch
- `template` 只渲染文本
- `prompt` 只渲染提示文本
- `prompt` 会注入 agent session 交给底层 runner 执行；feedback 只决定 daemon 是否额外投递

### 8.4 Feedback 解析

```typescript
function resolveFeedbackTarget(action, sessionConfig): TriggerFeedbackTarget {
  return action.target ?? {
    channelKey: sessionConfig.channelKey,
    channelId: sessionConfig.channelId
  };
}
```

V2 校验：
- `processing.mode === 'prompt'` 且 `feedback.mode === 'none'` 时，`session.strategy` 必须是 `thread`
- `processing.mode === 'prompt'` 时，`feedback.mode` 只能是 `agent-session` 或 `none`
- `processing.mode !== 'script'` 时，`feedback` 必须是单一配置，不能出现 `onSuccess/onNoop/onFailure`
- `processing.mode === 'script'` 时，`feedback` 必须是三分支配置

### 8.5 Trigger 静默标记

`prompt + none` 的静默语义是：抑制 daemon/renderer 输出，但保留 agent 主动调用 `ec msg send` 的能力。

实现要求：
- 仅允许 `session.strategy=thread`
- 本次执行的有效 chatMode 强制为 `proactive`
- message.triggerMeta 写入静默标记，例如 `silent: true`
- MessageProcessor / IMRenderer 看到静默 trigger 后，不发送 lifecycle/status/fallback/result.text/activity.batch
- `ec msg send` / `ec group send` 等显式命令仍可正常发送
- 不永久修改 session.chatMode，避免影响该 thread 后续人工交互

---

## 九、兼容性与迁移

### 现有功能映射

| 当前功能 | V2 对应 | 说明 |
| --- | --- | --- |
| Source | `source` | 保持兼容 |
| Script | `processing.mode=script` | 脚本 stdin/stdout 协议保持兼容 |
| Direct message | `feedback.mode=direct-message` | Daemon 直接发送 |
| Agent runner | `processing.mode=prompt` + `feedback.mode=agent-session` | 更名并明确职责 |
| Latest session | `session.strategy=latest` | 改为只选主会话 |
| Current session | `session.strategy=current` | 指定 sessionId 无副作用复用，不切 active |
| Thread session | `session.strategy=thread` + `thread.mode=reuse` | 保留逻辑 thread 语义 |
| One-time thread | `session.strategy=thread` + `thread.mode=once` | 替代原 `oncethread` |

### Legacy 迁移规则

旧 `feedback.onSuccess.mode=agent-runner`：

兼容层仍接受 `agent-runner`，但 normalize 后会写成 `agent-session`。新配置不要继续使用 `agent-runner`。

```json
{
  "session": {
    "channelKey": "旧 target.channelName 或 channelKey normalize 后的完整 channelKey",
    "channelId": "旧 target.channelId",
    "strategy": "latest"
  },
  "processing": {
    "mode": "prompt",
    "prompt": "旧 feedback.onSuccess.template"
  },
  "feedback": {
    "mode": "agent-session"
  }
}
```

旧 `target.sessionStrategy=thread`：

```json
{
  "session": {
    "channelKey": "旧 target.channelName 或 channelKey normalize 后的完整 channelKey",
    "channelId": "旧 target.channelId",
    "strategy": "thread",
    "thread": {
      "mode": "reuse",
      "threadId": "旧 target.threadId"
    }
  }
}
```

旧 `target.sessionStrategy=current`：
- 保留为 `session.strategy=current`
- 写入旧 `target.sessionId`
- 运行时必须无副作用复用

---

## 十、验证状态

### 已执行

构建已通过：

```bash
npm run build
```

Trigger 相关单元测试已通过：

```bash
npx vitest run \
  tests/unit/trigger-manager.test.ts \
  tests/unit/trigger-parser.test.ts \
  tests/unit/trigger-menu.test.ts \
  tests/unit/processor-trigger-reply.test.ts \
  tests/unit/trigger-reply-context.test.ts \
  tests/unit/session-manager-fs.test.ts \
  tests/unit/session-manager-refactor.test.ts
```

结果：7 个 test files 通过，95 个 tests 通过，1 个 skipped。

专用 Trigger V2 集成测试已通过：

```bash
npx vitest run tests/integration/trigger-v2.test.ts
```

结果：1 个 test file 通过，20 个 tests 通过。

相关集成 smoke tests 已通过：

```bash
npx vitest run \
  tests/integration/proactive-mode-system-prompt.test.ts \
  tests/integration/event-stream-output.test.ts \
  tests/integration/event-bus-flow.test.ts
```

结果：3 个 test files 通过，24 个 tests 通过。

本轮合并执行的相关测试命令也已通过：

```bash
npx vitest run \
  tests/unit/trigger-manager.test.ts \
  tests/unit/trigger-parser.test.ts \
  tests/unit/trigger-menu.test.ts \
  tests/unit/processor-trigger-reply.test.ts \
  tests/unit/trigger-reply-context.test.ts \
  tests/unit/session-manager-fs.test.ts \
  tests/unit/session-manager-refactor.test.ts \
  tests/integration/trigger-v2.test.ts \
  tests/integration/proactive-mode-system-prompt.test.ts \
  tests/integration/event-stream-output.test.ts \
  tests/integration/event-bus-flow.test.ts
```

结果：11 个 test files 通过，139 个 tests 通过，1 个 skipped。

### 已覆盖的关键行为

- TriggerDefinition normalize / validation：V2 schema。
- Legacy `agent-runner` 输入归一化为 `agent-session`。
- `latest` 过滤 thread，仅选择主会话。
- `latest` 找不到主会话时自动创建主会话。
- `current` 按 `sessionId` 无副作用复用，不创建或切换 session。
- Script + direct-message。
- Script + agent-session。
- Script `matched=false` 走 `onNoop + none`。
- Script 执行失败走 `onFailure`，并可投递失败通知。
- Template + direct-message。
- Template + agent-session。
- Prompt + agent-session + latest 主会话。
- Prompt + agent-session + reuse thread。
- Prompt + agent-session + once thread。
- Prompt + none + reuse thread。
- Dry-run 只渲染 feedback，不发送、不入队、不写 active state。
- 未配置 channel 失败为 `channel_not_configured`。
- `current` 绑定 session 找不到时失败为 `session_not_found`。
- Feedback target 可覆盖 root session 并指向 thread。
- `reliability.concurrency=forbid` 会跳过重叠 run。
- 主会话 busy 时在 feedback deadline 后跳过。
- thread session 即使 queue busy 也不等待主会话队列。
- Feedback target override。
- `thread.once` 每次生成新 threadId。
- `prompt + none` 仅允许 thread session，搭配 latest/current 会被拒绝。
- `prompt + none` 入队时写入 `silent=true` 和 `chatModeOverride=proactive`。
- MessageProcessor 对 silent trigger 抑制 renderer 输出。
- Trigger source 首次回复不携带 `replyToMessageId`，避免回复不存在的触发器消息。
- Thread session 的基础创建、查找与隔离行为。

### 未完成的端到端覆盖

当前已新增专用 Trigger V2 集成测试，但仍是 fake channel / fake sessionManager / fake messageQueue 的可重复集成测试，不依赖真实飞书/AUN 网络。仍待补充真实渠道端到端覆盖：

- 真实飞书/AUN direct-message 投递。
- 真实 agent runner 消费 trigger 入队消息并产生回复。
- 真实 reuse thread 多次触发进入同一 thread queueKey。
- 真实主会话处理中，reuse thread trigger 与主会话并行执行。
- 真实失败通知路径：成功发用户，失败发管理员

---

## 十一、后续优化方向

1. 增加明确的 processing pipeline，例如 `script -> prompt`
2. 设计后台静默 agent session，再评估是否需要 `selfactive` 或等价概念
3. 多目标投递
4. Trigger 模板系统
5. 更丰富的占位符上下文

---

**下一步**：按需补充 gated e2e 测试，覆盖真实渠道投递、真实 runner 消费和真实 thread 队列隔离。
