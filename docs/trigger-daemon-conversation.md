# Trigger V3: Daemon-Agent Conversation 设计

## 一、当前问题

现有 trigger 的 `feedback.mode` 有三种：

| 模式 | 实际行为 | 问题 |
|------|---------|------|
| `direct-message` | 渲染模板文本直接发送，不经过 agent | 无法利用 agent 推理能力 |
| `agent-session` | 构造 Message 入队后立即返回（fire-and-forget） | daemon 看不到 agent 回复，无法基于回复做决策 |
| `none` | 仅审计 | - |

**核心矛盾**：`agent-session` 模式下，scheduler 在入队后就认为"成功"（发 `trigger:completed`），但 agent 实际执行结果（成功/失败/回复内容）完全不可见。这导致：

1. 无法根据 agent 回复内容决定是否转发、转发给谁
2. 无法实现"agent 判断无事可报时静默"（noop 协议）
3. 无法支持 agent-to-agent 协作（一个 agent 的输出喂给另一个）
4. 审计记录缺失 agent 实际回复和 token 用量

## 二、设计目标

**语义转变**：从"调用路由"到"回复路由"

```
旧 feedback（执行前决策）：
  "触发了，我该怎么把它喂给系统？"
  → direct-message / agent-session / none

新 feedback（执行后决策）：
  "daemon 和 agent 对话完了，agent 回复了 X，这个 X 该怎么处置？"
  → 转发给谁 / 怎么包装 / 空回复算不算数
```

**核心能力**：

1. daemon 能**拿到** agent 的完整回复（文本、文件、token、耗时）
2. 基于回复内容**分支决策**（有回复/无回复/出错）
3. 支持**执行与反馈分离**（在隔离 session 执行，结果转发到群聊）
4. 为 agent 协作链铺路（一个 agent 的输出 → 另一个 agent 的输入）

## 三、核心设计：两段式模型

把一次 trigger 执行拆成两条独立的腿：

```
┌─ 执行腿 (execution leg) ──────────────────┐
│  daemon ──prompt──▶ DaemonChannel          │
│         ◀──reply──  (agent 在某个 session   │
│                      里思考、调工具)         │
└────────────────────┬───────────────────────┘
                     │ TriggerReply
                     ▼
┌─ 反馈腿 (feedback leg) ────────────────────┐
│  FeedbackRouter 根据 reply.outcome 决定：    │
│   • 转发到目标 channel（Feishu/AUN/...）     │
│   • 回到触发来源                             │
│   • 静默仅审计                               │
└─────────────────────────────────────────────┘
```

**为什么必须拆开**：执行腿回答"agent 在哪个上下文里干活"（用哪个 session、要不要隔离），反馈腿回答"结果给谁看"。这俩经常不是同一个对象——比如定时任务在一个**隔离 thread** 里跑（不污染用户主会话），但结果要**转发到群里**给所有人。

## 四、V3 Schema 定义

本设计不保留 V2 运行时兼容。运行时只接受 `$schema_version: 3`；旧 trigger 必须先通过独立升级步骤或人工改写为 V3 后再导入。

### 4.1 完整结构

```typescript
interface TriggerDefinitionV3 {
  $schema_version: 3;
  id: string;
  agentAid: string;
  enabled: boolean;
  name: string;
  description?: string;
  source: TriggerSource;  // delay/at/cron/interval/event（不变）

  // ── 执行腿 ──
  execution: {
    mode: 'agent' | 'script';
    prompt?: string;              // mode=agent 时必填
    script?: TriggerScriptConfig; // mode=script 时必填
    session: {
      strategy: 'isolated' | 'thread' | 'main';
      baseagent?: string;
      channelKey?: string;         // strategy=main 时必填；thread 时可选，默认 daemon
      channelId?: string;          // strategy=main 时必填；thread 时可选，默认 trigger:{id}
      sessionId?: string;          // strategy=main 可绑定具体主会话
      threadId?: string;           // strategy=thread 可复用固定 thread
      name?: string;               // session 可选名称（用于 UI 展示）
    };
    onError?: 'fail' | 'retry';   // 默认 'fail'
    noopSentinel?: string;        // 默认 '[[NOOP]]'
  };

  // ── 反馈腿 ──
  feedback: {
    onReply?: FeedbackDisposition;   // agent 回复了（非空、非哨兵）
    onNoop?: FeedbackDisposition;    // agent 回了 [[NOOP]] 或空
    default?: FeedbackDisposition;   // 其他情况兜底
  };

  reliability: TriggerReliability;
  origin?: TriggerOrigin;
  createdAt: number;
  updatedAt: number;
}

type FeedbackDisposition =
  | { kind: 'forward'; targets: FeedbackTarget[]; template?: string }
  | { kind: 'reply-origin'; template?: string }
  | { kind: 'silent' };

interface FeedbackTarget {
  channelKey: string;
  channelId: string;
  delivery: 'direct' | 'inbound';
  threadId?: string;
}
```

### 4.2 关键字段说明

#### execution.session.strategy

| 策略 | 含义 | 适用场景 |
|------|------|---------|
| `isolated` | 每次跑在 `daemon#trigger:{id}` 的一次性 thread，执行完可清空历史 | 定时报告、巡检类（默认推荐） |
| `thread` | 复用 `daemon#trigger:{id}` 固定 thread，跨次累积上下文 | 需要"记得上次"的任务 |
| `main` | 跑在用户主会话里 | 想让 agent 带着完整对话上下文干活 |

#### execution.onError

| 策略 | 行为 |
|------|------|
| `fail`（默认） | 记 audit（status=failed）+ 发 `trigger:failed`，不重试 |
| `retry` | 按 `reliability.retry` 重试 N 次，仍失败 → 退化为 `fail` |

#### feedback.delivery

| delivery | 执行 | 进不进目标 agent context |
|----------|------|-------------------------|
| `direct` | `adapter.send(result.text)` 直接投递显示 | **不进** —— 不构造 inbound Message，没有 agent 处理它 |
| `inbound` | 构造 inbound Message 入队，目标 agent 当新消息处理 | **进** —— agent 处理它，落进那个 session 的历史 |

## 五、DaemonChannel 架构

### 5.1 核心职责

DaemonChannel 是一个**进程内虚拟 ChannelAdapter**（**新增文件** `src/channels/daemon.ts`），负责：

1. **接收 daemon 的对话请求**：`converse(prompt, ctx): Promise<TriggerReply>`
2. **捕获 agent 的回复流**：实现 `send(envelope, payload)` 归并 OutboundPayload
3. **完成信号检测**：收到 `status.completed | status.error | status.interrupted` 时 resolve

### 5.2 回复归并结构

```typescript
interface TriggerReply {
  outcome: 'success' | 'noop' | 'error' | 'interrupted' | 'timeout';
  text: string;                    // 累积的最终回复（isFinal 那条，或全部 text 块拼接）
  files: { path: string; name?: string }[];  // result.file 收集
  error?: { reason?: string; text: string };  // result.error / status.error
  meta: {
    runId: string;
    durationMs: number;
    numTurns?: number;
    tokenUsage?: AgentTokenUsage;  // 来自 status.completed
    toolCallCount: number;         // 数 status.progress 里 tool_call 的次数
  };
}
```

### 5.3 OutboundPayload 归并逻辑

从 response-engine 的实际出站序列看，一次执行 agent 会吐出：

```
result.text (isFinal=false) × N    ← 流式文本块
result.text (isFinal=true)         ← 最终回复
result.file × M                    ← 文件标记产出（可选）
result.error                       ← 出错时
status.completed { durationMs, tokenUsage, contextUsage }  ← 收尾信号（成功）
status.error / status.interrupted  ← 收尾信号（失败/打断）
```

DaemonChannel 据此归并：

```typescript
class DaemonChannel implements ChannelAdapter {
  readonly channelName = 'daemon';
  readonly channelKey = 'daemon';

  private pending = new Map<string, {
    resolve: (r: TriggerReply) => void;
    acc: { text: string; files: any[]; error?: any; toolCalls: number };
    timer: NodeJS.Timeout;
  }>();

  async send(env: OutboundEnvelope, payload: OutboundPayload): Promise<void> {
    const runId = env.replyContext?.metadata?.triggerRunId;
    const slot = runId ? this.pending.get(runId) : undefined;
    if (!slot) return;
    switch (payload.kind) {
      case 'result.text':
        if (payload.isFinal) slot.acc.text = payload.text;
        else slot.acc.text += payload.text;
        break;
      case 'result.file':
        slot.acc.files.push({ path: payload.filePath, name: payload.fileName });
        break;
      case 'result.error':
        slot.acc.error = { reason: payload.reason, text: payload.text };
        break;
      case 'status.progress':
        if (payload.metadata?.activityType === 'tool_call') slot.acc.toolCalls++;
        break;
      case 'status.completed': this.finish(runId, 'success', payload.metadata); break;
      case 'status.error':     this.finish(runId, 'error'); break;
      case 'status.interrupted': this.finish(runId, 'interrupted'); break;
      case 'status.timeout':   this.finish(runId, 'timeout'); break;
    }
  }

  async converse(prompt: string, ctx: ConversationContext): Promise<TriggerReply> {
    const captureId = ctx.runId;
    const promise = new Promise<TriggerReply>((resolve) => {
      this.pending.set(captureId, {
        resolve,
        acc: { text: '', files: [], toolCalls: 0 },
        timer: setTimeout(() => this.finish(captureId, 'timeout'), 120_000),
      });
    });

    // 构造 inbound Message 入队
    const message: Message = {
      channel: this.channelName,
      channelId: ctx.sessionChannelId,
      content: prompt,
      peerId: `trigger:${ctx.triggerId}`,
      source: 'trigger',
      triggerMeta: {
        triggerId: ctx.triggerId,
        runId: ctx.runId,
      },
      // ... session/threadId 等
    };

    await this.messageQueue.enqueue(sessionId, message, ctx.projectPath);
    return promise;
  }
}
```

### 5.4 完成信号与 response-engine 解耦

V3 不再保留旧 trigger 的 status 抑制。response-engine 不应因为 `message.source === 'trigger'`
跳过 `status.started/completed/error/interrupted`，执行腿是否对用户可见由 channel 决定：

- agent 执行腿默认走 `DaemonChannel`，status 和 result 只被 daemon 捕获
- 反馈腿走真实 channel，是否展示由 `feedback` 的 disposition 决定
- 不再用 `triggerMeta.silent` 在 response-engine 里做隐藏语义

```typescript
this.touchAgentActivity(channelKey);
adapter.send(envelope, { kind: 'status.started' }).catch(() => {});
// completed/error/interrupted 同理
```

## 六、Feedback 分支与路由

### 6.1 分支判定

```typescript
type FeedbackBranch = 'onReply' | 'onNoop' | 'default';

function selectBranch(reply: TriggerReply, noopSentinel: string): FeedbackBranch {
  if (reply.outcome === 'error' || reply.outcome === 'timeout' || reply.outcome === 'interrupted') {
    return 'default';
  }

  const trimmed = reply.text.trim();
  if (!trimmed || trimmed === noopSentinel || trimmed.includes(noopSentinel)) {
    return 'onNoop';
  }

  return 'onReply';
}
```

### 6.2 Feedback 动作实现

#### forward

```typescript
async function dispatchForward(
  reply: TriggerReply,
  disposition: FeedbackDisposition & { kind: 'forward' },
  trigger: TriggerDefinition,
  getTriggerChannel: (agentAid: string, channelKey: string) => ChannelInfo | undefined,
  messageQueue: MessageQueue,
  sessionManager: SessionManager,
): Promise<void> {
  const renderedText = renderTemplate(disposition.template, { reply, trigger });

  for (const target of disposition.targets) {
    const channelInfo = getTriggerChannel(trigger.agentAid, target.channelKey);
    if (!channelInfo) {
      logger.warn(`[Feedback] target channel not found: ${target.channelKey}`);
      continue;
    }

    if (target.delivery === 'direct') {
      // 直接发送显示
      await channelInfo.adapter.send(
        buildEnvelope({ taskId: reply.meta.runId, channelId: target.channelId, ... }),
        { kind: 'result.text', text: renderedText, isFinal: true }
      );
    } else {
      // delivery === 'inbound': 构造 Message 入队
      const message: Message = {
        channel: target.channelKey,
        channelId: target.channelId,
        content: renderedText,
        peerId: `trigger:${trigger.id}`,
        peerType: 'system',
        source: 'trigger',
        threadId: target.threadId,
        // ...
      };
      const session = await sessionManager.getOrCreateSession(/* ... */);
      await messageQueue.enqueue(session.id, message, channelInfo.projectPath);
    }
  }
}
```

#### reply-origin

回到 `trigger.origin` 指定的 channel（创建这条 trigger 的人/渠道）。逻辑同 `forward` 但目标固定为 origin。

#### silent

仅写审计，不发任何消息。

### 6.3 模板上下文

```typescript
interface TemplateContext {
  reply: {
    text: string;
    outcome: 'success' | 'noop' | 'error' | 'interrupted' | 'timeout';
    files: Array<{ path: string; name?: string }>;
    meta: {
      durationMs: number;
      toolCallCount: number;
      tokenUsage?: { output_tokens?: number; input_tokens?: number; /* ... */ };
    };
  };
  trigger: TriggerDefinition;
  timestamp: number;
  date: string;  // YYYY-MM-DD
  time: string;  // HH:MM:SS
}
```

例：`📊 {{trigger.name}}（{{reply.meta.durationMs}}ms，调用 {{reply.meta.toolCallCount}} 次工具）\n\n{{reply.text}}`

## 七、执行异常处理

### 7.1 execution.onError

| 策略 | 行为 |
|------|------|
| `fail`（默认） | 写 audit（status=failed）+ 发 `trigger:failed`，不重试；反馈分支走 `feedback.default` |
| `retry` | 按 `reliability.retry` 退避重试 N 次，仍失败 → 退化为 `fail` |

**关键**：`error` / `timeout` / `interrupted` 都归入 `default` 分支。`feedback.default` 可以选择通知或静默，但 audit 的最终状态仍按 `reply.outcome` 记为 failed。

### 7.2 超时

依赖现有 `StreamIdleMonitor`（默认 120s idle-kill）。agent 卡死会被 kill，产生 `status.timeout` / `status.error` → DaemonChannel resolve 为 `timeout` / `error`。DaemonChannel 自身也有兜底 timeout，防止 response-engine 收尾事件缺失导致永久挂起。

### 7.3 中断

- `strategy: 'isolated'`：跑在独立 thread，不与用户主会话抢队列，天然不会被真实用户消息打断
- `strategy: 'thread'` / `'main'`：可能被打断。MessageQueue 的中断机制会发 `status.interrupted`，DaemonChannel 收到后 resolve `outcome: 'interrupted'`，scheduler 走 `default` 分支并按 failed 记 audit。

## 八、V2→V3 升级映射（离线）

以下映射只作为升级旧配置时的参考，不能放进 trigger 运行时。`validation.ts` 和 `manager.ts` 不做 V2 自动迁移，避免旧语义继续进入 V3 执行路径。

### 8.1 execution 层映射

| V2 字段 | V3 字段 | 映射规则 |
|---------|---------|---------|
| `processing.mode: 'prompt'` | `execution.mode: 'agent'` | - |
| `processing.mode: 'template'` | `execution.mode: 'agent'` | prompt 取 template |
| `processing.mode: 'script'` | `execution.mode: 'script'` | - |
| `processing.prompt` | `execution.prompt` | - |
| `processing.script` | `execution.script` | - |
| `session.strategy: 'latest'` | `execution.session.strategy: 'isolated'` | 动态选最新 → 每次隔离 |
| `session.strategy: 'current'` | `execution.session.strategy: 'main'` | 绑定当前 → 主会话 |
| `session.strategy: 'thread'` | `execution.session.strategy: 'thread'` | - |

### 8.2 feedback 层映射

| V2 字段 | V3 字段 | 映射规则 |
|---------|---------|---------|
| `feedback.mode: 'agent-session'` | `feedback.onReply: { kind: 'reply-origin' }` | 入队后撒手 → 回复给创建者 |
| `feedback.mode: 'direct-message'` | `feedback.onReply: { kind: 'forward', targets: [...], delivery: 'direct' }` | 直发 |
| `feedback.mode: 'none'` | `feedback.default: { kind: 'silent' }` | - |
| `feedback.target` | `FeedbackTarget` | channelKey/channelId 不变，delivery 默认 'direct' |
| `reliability.scriptRetry` | `reliability.retry` | 泛化：agent 模式和 script 模式共用 |

### 8.3 schema_version 校验逻辑

```typescript
// validation.ts
function normalizeTriggerDefinition(input: unknown): TriggerDefinition {
  const raw = input as Record<string, unknown>;
  if (version === 3) {
    return normalizeV3(raw);
  }

  throw new Error(`trigger schema version 3 is required; got ${String(version)}`);
}
```

写回时保持 V3：

```typescript
// manager.ts
write(definition: TriggerDefinition): void {
  const normalized = normalizeTriggerDefinition(definition);
  fs.writeFileSync(this.definitionPath(definition.id), JSON.stringify(normalized, null, 2));
}
```

## 九、配置示例

### 9.1 每日报告（隔离执行，转发到群）

```json
{
  "name": "daily-report",
  "source": { "type": "cron", "expression": "0 9 * * *" },
  "execution": {
    "mode": "agent",
    "prompt": "统计昨天的关键数据，生成简报。无数据则只回复 [[NOOP]]。",
    "session": { "strategy": "isolated" }
  },
  "feedback": {
    "onReply": {
      "kind": "forward",
      "targets": [{
        "channelKey": "feishu#oc_work",
        "channelId": "oc_work",
        "delivery": "direct"
      }],
      "template": "📊 每日简报\n\n{{reply.text}}"
    },
    "onNoop": { "kind": "silent" }
  }
}
```

### 9.2 巡检任务（thread 复用，结果回到创建者）

```json
{
  "name": "health-check",
  "source": { "type": "interval", "everyMs": 600000 },
  "execution": {
    "mode": "agent",
    "prompt": "检查服务健康，异常则回复异常详情，正常回复 [[NOOP]]",
    "session": { "strategy": "thread" },
    "onError": "retry"
  },
  "feedback": {
    "onReply": { "kind": "reply-origin" },
    "onNoop": { "kind": "silent" }
  },
  "reliability": {
    "retry": { "maxAttempts": 2, "backoffMs": 30000 }
  }
}
```

### 9.3 Agent 协作（巡检结果喂给修复 agent）

```json
{
  "name": "health-check-with-remediation",
  "source": { "type": "interval", "everyMs": 600000 },
  "execution": {
    "mode": "agent",
    "prompt": "检查服务健康，异常则回复详情",
    "session": { "strategy": "isolated" }
  },
  "feedback": {
    "onReply": {
      "kind": "forward",
      "targets": [{
        "channelKey": "internal#remediate-agent",
        "channelId": "remediate",
        "delivery": "inbound"
      }]
    },
    "onNoop": { "kind": "silent" }
  }
}
```

## 十、实施路径

### Phase 1：地基（types + DaemonChannel）

**任务**：
1. ~~定义 V3 schema 类型（`src/trigger/types.ts`）~~ ✅ 已完成
2. 实现 `DaemonChannel`（`src/channels/daemon.ts`）——**新增文件**
3. 解除 response-engine 的 trigger 消息 status 抑制，并删除 `triggerMeta.silent` 路径

**验证**：单测覆盖 DaemonChannel 的回复捕获（mock OutboundPayload 流 → 验证 TriggerReply）

### Phase 2：执行腿改造

**任务**：
1. ~~改 `scheduler.ts` 的 `runExecutionAttempt`：`mode: 'agent'` 时调 `DaemonChannel.converse`~~ ✅ 已完成（L438-450）
2. ~~按 `reply.outcome` 判定 branch（onReply / onNoop）~~ ✅ 已完成（`branchFromReply` L911-915）
3. ~~`execution.onError='retry'` 复用 `reliability.retry` 重试逻辑~~ ✅ 已完成（L372-380）
4. ~~验证 `publishTriggerRunOutcome` 在 feedback 完成后才调用~~ ✅ 已完成（L326 在 feedback.dispatch 后）

**验证**：集成测试覆盖 agent 模式执行 + noop 判定 + 错误重试

### Phase 3：反馈腿改造

**任务**：
1. ~~改 `feedback.ts`：实现 `forward`（direct/inbound）、`reply-origin`、`silent` 三个动作~~ ✅ 已完成（dispatch L56-102）
2. ~~扩展模板上下文（`{{reply.*}}`）~~ ✅ 已完成（renderTemplate L58-65）
3. ~~更新 audit 结构（加 `reply` 段存回复摘要）~~ ✅ 已完成（types.ts L236-246）

**当前状态**：feedback.ts 已实现完整 V3 逻辑，需验证与 DaemonChannel 的集成。

**验证**：单测覆盖三种 disposition + 两种 delivery

### Phase 4：V3 收尾

**任务**：
1. ~~改 `validation.ts`：只接受 v3 schema~~ ✅ 已完成（L24-27）+ ✅ 错误信息已改进（明确提示 `$schema_version` 缺失）
2. 更新 CLI/parser（`trigger-command.ts`）支持新字段
3. 改 `index.ts` wiring（注册 DaemonChannel）
4. 补齐所有单测 + 集成测试

**验证**：
- 旧 v2 定义读入时报错，必须先升级为 v3
- `npm run build` + `npm test` 全通过
- 手动测试：cron trigger 执行 → 回复捕获 → forward 到群

## 十一、风险与注意事项

### 11.1 中断与并发

- **isolated 策略推荐为默认**：避免与用户主会话抢队列、避免污染上下文
- **main 策略慎用**：用户发消息可能打断 trigger 执行，导致 `status.interrupted`

### 11.2 完成信号可靠性

依赖 response-engine **必发** `status.completed | status.error | status.interrupted | status.timeout` 之一。如果 response-engine 逻辑改动导致收尾事件缺失，DaemonChannel 会靠自身 timeout 兜底结束。

### 11.3 V2 升级边界

V2 定义不在运行时自动迁移。旧配置升级必须发生在导入前，升级后的 `trigger.json` 必须已经是 `$schema_version: 3`；运行时发现 V2 或缺失 schema 直接拒绝。

### 11.4 系统 upgrade-check trigger

安装/升级后的 daemon 启动必须重新创建系统 trigger：`__upgrade-check`。

- 作为 daemon/control AID 级 trigger 创建，不依赖 self-agent 是否存在；`evolclaw init` 后只有 control plane 也能定时检查升级
- owner 优先使用 `evolclaw.json.aid`；若没有 control AID，退回内部 owner `__daemon__`
- 固定写入 `data/triggers/<daemonOwnerAid>/__upgrade-check/trigger.json`，并覆盖旧定义
- `origin` 使用 `{ channel: "daemon", peerId: <controlAid>, sessionKey: "daemon#<controlAid>#__system__" }`，表示该 trigger 由 daemon 系统任务创建
- 启动时会自动删除旧的 agent 级系统 `__upgrade-check` 目录，避免 primary agent 和 daemon 双份定时检查；系统升级检查只保留 daemon/control AID 这一份
- 清理该 trigger 的 `active.json`，让 cron 游标按新定义重新计算
- 使用 V3 `execution.mode: "script"`，脚本输出标准 `TriggerReply`：`outcome/text/files`
- dev/source 模式下脚本返回 `noop`，避免开发仓凌晨自重启
- install 模式下脚本比较本地 `evolclaw --version` 与 `npm view evolclaw version`；只有本地版本落后时才启动 `restart-monitor`
- feedback 三个分支均为 `silent`，升级检查不主动对外 notice；重启/升级结果仍由 restart-monitor 的既有通知链路负责
