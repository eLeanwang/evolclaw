# OpenCode BaseAgent 集成方案

**初次编写日期**：2026-06-26

**修订日期**：2026-07-14

**状态**：按 EvolClaw 现有 BaseAgent 骨架修订，进入实现前仍需协议 PoC

本方案以当前代码中的 `AgentPlugin`、`AgentRunnerFull`、`ResponseEngine` 和[权限模式与审批契约](./permission-mode-contract.md)为边界。OpenCode 是 EvolClaw 的第四种 BaseAgent，不是独立于 BaseAgent 体系之外的新服务层。

## 一、决策摘要

### 1.1 采用哪一种现有集成方式

在 Claude、Codex、Gemini 三种实现中，OpenCode **最适合采用 Codex Runner 的结构方式**：

| 现有实现 | 后端形态 | 与 OpenCode 的相似度 | 结论 |
| --- | --- | --- | --- |
| Claude Runner | SDK query 自带单次事件流 | 中 | 可借鉴权限和提问交互，不适合作为进程结构模板 |
| Codex Runner | Runner 私有的常驻 app-server client、通知流、session/turn map | 高 | **作为主要结构骨架** |
| Gemini Runner | 每轮启动 CLI，解析 stdout JSONL | 低 | 只借鉴 CLI 可用性检查和图片临时文件兜底 |

OpenCode 与 Codex 都需要处理常驻后端进程、客户端协议、独立事件流、并发 session、主动中断和异步权限请求。因此实现应复用 `codex-runner.ts` 的组织方式，而不是建立进程级 `OpenCodeServiceManager`。

### 1.2 不变的 EvolClaw 主链路

```text
AgentLoader
  → OpencodeAgentPlugin
  → 每个 EvolAgent × opencode 创建一个 OpencodeRunner
  → agentMap[`${aid}::opencode`]
  → AgentRunnerFull.runQuery()
  → AsyncIterable<AgentEvent>
  → ResponseEngine
  → IMRenderer
  → OutboundPayload
  → ChannelAdapter
```

必须保持以下现有约束：

- `AgentPlugin.createAgent()` 同步创建轻量 Runner；
- Runner 在第一次 `runQuery()` 或 `listModels()` 时惰性启动后端；
- 每个 Runner 独立保存模型、权限上下文、session、active turn、SSE 和后端进程；
- 一个 Runner 可以并发承载其所属 EvolAgent 的多个 EvolClaw session；
- `runQuery()` 只接收既有参数并产出既有 `AgentEvent`；permission/question 只走现有受控交互接口；
- 渠道消息解析和 IM 出站均不下沉到 OpenCode Runner。

## 二、Runner 所有权与生命周期

### 2.1 每个 Runner 私有一个 OpenCode 后端

```text
EvolAgent A :: OpencodeRunner
  ├─ private OpenCode server/client
  ├─ session A1 / A2 / ...
  ├─ active turn queues
  ├─ permission contexts
  └─ runtime env bindings

EvolAgent B :: OpencodeRunner
  ├─ private OpenCode server/client
  └─ independent state
```

不使用全局单例，也不跨 EvolAgent 共享 OpenCode client/server。这样与当前 `AgentLoader` 的隔离语义一致，并避免以下状态串扰：

- 不同 AID 的 provider/plugin/config 被同一个 OpenCode 进程合并；
- 一个 Runner 的权限规则或临时授权影响另一个 Runner；
- `runtimeEnv` 中的 session、task、AID 或 delegation token 注入错误后端；
- shutdown、热加载或单个 Runner 故障牵连其他 EvolAgent。

先前固定 `4096` 端口的第二实例冲突，只能证明“每个 Runner 使用同一固定端口”不可行，不能推出“必须共享服务”。正确修复是每个 Runner 使用独立的内部动态端口。

### 2.2 惰性启动

Runner 构造函数只保存解析后的配置和空 map，不执行异步 I/O。私有 `ensureClient()` 使用单一初始化 Promise 防止同一 Runner 并发首调用重复启动：

1. 解析并校验 `cliPath`；
2. 在回环地址选择内部空闲端口，或在锁定版本验证支持后使用端口 `0`；
3. 以 `shell: false` 启动 `opencode serve`；
4. 从实际监听地址创建 SDK client；
5. 启动该 Runner 私有的 SSE 订阅；
6. 完成版本和关键 endpoint capability probe。

端口仅是 Runner 内部实现细节，不进入用户配置。`@opencode-ai/sdk` 1.17.18 的 server helper 将命令名硬编码为 `opencode`；为支持现有配置风格中的 `cliPath`，可选的 client wrapper 应自行安全 spawn 指定可执行文件。

### 2.3 清理

`dispose()` 必须：

- abort 全部活跃 turn 和 SSE；
- reject 尚未完成的 permission/question 请求；
- 清理 session、去重状态和 `runtimeEnv` map；
- 关闭 SDK client 和 Runner 私有 server 子进程；
- 等待进程退出，超时后再执行受控终止。

当前主进程 shutdown 尚未统一调用所有 Runner 的 `dispose()`。正式实现必须补齐该调用，并按 runner 对象去重，避免同一实例重复 dispose。

## 三、代码结构

### 3.1 建议文件

```text
src/agents/
  opencode-runner.ts       # OpencodeRunner + OpencodeAgentPlugin
  opencode-client.ts       # 可选；进程、SDK client、SSE 的薄封装
```

`opencode-runner.ts` 首版内部包含：

- `AgentRunnerFull` 方法；
- EvolClaw session ↔ OpenCode session 映射；
- OpenCode event → `AgentEvent` 转换；
- 四模式 ruleset 和 `PermissionGateway` 桥；
- question 交互桥；
- 模型、统计和 capability 声明。

只有当单文件复杂度经过实现证明过高时，再提取 event mapper 或 permission helper。首版不新增 manager/router/runtime-plugin 五件套，也不引入第二套插件系统。

### 3.2 现有文件接入点

| 文件/模块 | 必要改动 |
| --- | --- |
| `src/agents/baseagent.ts` | 增加 `opencode` canonical alias 和配置解析 |
| `src/types.ts` | 增加 `BaseagentOpencodeConfig` 并接入 `BaseagentsBlock` |
| `src/index.ts` | 注册 `OpencodeAgentPlugin`；shutdown dispose 全部 Runner |
| `src/config/config-field-policy.ts` | 把 `opencode` 纳入已知 BaseAgent，允许既有安全字段 |
| CLI init/agent selector | 把 `opencode` 加入候选项和 CLI 可用性检测 |
| gateway/model/menu 配置路径 | 识别 `baseagents.opencode.model` 和 OpenCode 模型目录 |
| config schema/tests | 增加配置、Runner、事件、权限和生命周期覆盖 |

`AgentLoader`、`AgentRunnerFull`、`ResponseEngine`、`IMRenderer` 和 `ChannelAdapter` 的公共接口不需要为 OpenCode 改形。

## 四、配置

### 4.1 配置形态

```json
{
  "active_baseagent": "opencode",
  "baseagents": {
    "opencode": {
      "model": "anthropic/claude-sonnet-4-6",
      "cliPath": "opencode"
    }
  }
}
```

```typescript
export interface BaseagentOpencodeConfig {
  model?: string;
  cliPath?: string;
}

export interface BaseagentsBlock {
  claude?: BaseagentClaudeConfig;
  codex?: BaseagentCodexConfig;
  gemini?: BaseagentGeminiConfig;
  opencode?: BaseagentOpencodeConfig;
  hermes?: Record<string, any>;
}
```

不要增加：

- 顶层 `agents.opencode` 用户配置；
- `enabled`；
- 用户可见的 `port`；
- 远程 `baseUrl`；
- `username` / `password`；
- provider API key 字段。

Provider 凭证和 provider 连接继续由 OpenCode 自己的配置、认证和环境变量管理。EvolClaw 只选择 BaseAgent、CLI 和模型。

### 4.2 Plugin 行为

`OpencodeAgentPlugin.isEnabled()` 应同时检查：

1. 当前 EvolAgent 的 effective config 声明了 `baseagents.opencode`；
2. `cliPath` 指向可执行命令，或 PATH 中存在 `opencode`；
3. CLI 版本满足锁定的最低版本。

不在 `isEnabled()` 中校验某个 provider 的 API key；OpenCode 可能使用本地模型、OAuth 或其自身 provider 凭证。`createAgent()` 保持同步，只返回带该 EvolAgent 配置和 callback 的轻量 Runner。

## 五、Runner 输入与渠道消息

### 5.1 不扩展 `runQuery()`

OpenCode 实现保持当前完整签名：

```typescript
runQuery(
  sessionId,
  prompt,
  projectPath,
  initialAgentSessionId,
  images,
  systemPromptAppend,
  sessionManager,
  modelOverride,
  runtimeEnv,
): Promise<AsyncIterable<AgentEvent>>
```

| 参数 | OpenCode 映射 |
| --- | --- |
| `sessionId` | Runner 内 session/turn/permission context 的主键 |
| `prompt` | OpenCode text part |
| `projectPath` | session directory/query directory，并用于恢复校验 |
| `initialAgentSessionId` | 待恢复的 OpenCode session ID |
| `images` | OpenCode file part，使用受控 data URL 和 MIME |
| `systemPromptAppend` | prompt 的 `system` 字段；PoC 验证与 OpenCode instruction 的合并顺序 |
| `sessionManager` | 保持接口兼容；不借此建立另一套 session 存储 |
| `modelOverride` | 每轮 model/effort/permissionMode 覆盖 |
| `runtimeEnv` | 仅绑定当前活跃 OpenCode session/turn 的 shell env |

当前接口没有普通文件、音频或视频的结构化参数。OpenCode Runner 不得私自添加一套仅自身可用的输入协议。

### 5.2 入站消息支持矩阵

| 渠道入站种类 | 到达 Runner 前的处理 | Runner 实际接收 | 首版状态 |
| --- | --- | --- | --- |
| 普通文本、富文本 | Channel/消息渲染层转为文本 | `prompt` | 支持 |
| 图片、引用中的可下载图片 | Channel 下载/解码并生成 `ImageData[]` | `images` + 可选文字 `prompt` | 支持；取决于所选模型视觉能力 |
| 普通文件 | Channel 下载到项目上传目录，并把安全路径写入文本 | 含文件路径的 `prompt` | 支持；由工具读取，不是原生附件参数 |
| 视频 | Channel 下载并把路径/说明写入文本 | 含视频路径的 `prompt` | 路径支持；不承诺模型原生理解视频 |
| 语音/音频 | 渠道有 transcript 时转成文本；否则按渠道文件能力处理 | `prompt` 或文件路径 | 有 transcript 时支持；无通用音频参数 |
| 引用、回复、合并转发 | Channel 展开为引用文本和附件描述 | `prompt` / `images` | 支持 |
| `@`、群聊发送者、批量消息 | ECK/消息渲染层加入身份和批次上下文 | `prompt` | 支持 |
| link、location、personal card、JSON 等结构化消息 | 支持的 Channel 先转成可读文本 | `prompt` | 按现有 Channel 能力支持 |
| thread/topic | EvolClaw 用于 session 路由和 reply context | 不作为 OpenCode part | 支持，沿用现有路由 |
| trigger、owner inject、handoff、restart resume | ResponseEngine 渲染运行上下文 | `prompt` / `systemPromptAppend` | 支持 |
| 新消息打断当前任务 | 现有队列/ResponseEngine 先调用 `interrupt()` | 新一轮 `runQuery()` | 支持，需竞态测试 |
| slash command、menu、CommandCard | 通常由 CommandHandler 快速路径处理 | 不进入 Runner | 沿用现状 |
|权限卡片回复 | `InteractionRouter` / `PermissionGateway` 消费 | 不作为普通 prompt | 沿用现状 |
| OpenCode question 回复 | question bridge 经 `InteractionRouter` 回调 | 调 OpenCode question reply/reject API | 完成桥后支持 |

关键原则是：OpenCode 只看到 EvolClaw 已标准化的文本、图片和运行上下文，不解析飞书、AUN、企微等渠道原始 payload。

## 六、Session、并发与中断

### 6.1 Runner 内状态

```typescript
class OpencodeRunner {
  private activeSessions = new Map<string, string>();
  private activeTurns = new Map<string, OpenCodeTurnContext>();
  private permissionContexts = new Map<string, PermissionContext>();
  private projectSubscriptions = new Map<string, OpenCodeSubscription>();
  private runtimeEnvByOpenCodeSession = new Map<string, Record<string, string>>();
  private client: OpencodeClient | null = null;
  private clientPromise: Promise<OpencodeClient> | null = null;
}
```

这些 map 全部是 Runner 私有状态。事件至少按 OpenCode `sessionID` 路由，并再次校验其 project directory 属于当前 Runner 的绑定。

### 6.2 创建和恢复

`runQuery()` 的 session 选择顺序：

1. 优先使用 `initialAgentSessionId`；
2. 否则使用 `activeSessions.get(sessionId)`；
3. 都不存在时创建 OpenCode session；
4. 新建成功后发出 `session_id`，并调用 `onSessionIdUpdate()` 持久化。

恢复已有 ID 时必须调用 `session.get()`，然后 canonicalize 并比较记录中的 directory 与 `projectPath`。隔离烟测表明，只传错误的 directory 查询参数仍可能按 ID 取到其他项目的 session，因此查询参数不能作为安全边界。

### 6.3 生命周期方法

| `AgentRunnerFull` 方法 | OpenCode 实现 |
| --- | --- |
| `updateSessionId()` | 更新 EvolClaw session → OpenCode session map |
| `interrupt()` | 精确 abort 当前 session 的 OpenCode turn，并结束本地队列 |
| `closeSession()` | 清理活跃 turn、permission/question 和 env；保留持久 session |
| `clearSession()` | 删除 OpenCode session 并清除绑定；下轮新建 |
| `compactSession()` | 调用 summarize/compact 并等待同 session 终态事件 |
| `forkSession()` | 使用原生 fork；校验目录并重新应用当前权限规则 |
| `getSessionMessages()` | 转换 OpenCode messages 为现有统一历史结构 |

同一 OpenCode session 同时只允许一个普通 turn。若 EvolClaw 决定由新消息打断，先记录 pending interrupt，确保 prompt 尚未返回 turn 标识时也不会漏中断。

## 七、OpenCode 事件到 `AgentEvent`

### 7.1 SSE 订阅

`session.prompt()` 返回请求结果，不是旧方案假设的 `response.stream`。实时事件来自独立 SSE：

```typescript
const subscription = await client.event.subscribe({ directory: projectPath });

for await (const event of subscription.stream) {
  routeBySessionId(event);
}
```

一个 Runner 可按 project 复用订阅；由于 server 已由 Runner 私有，不需要进程级 SSE router。每个 `runQuery()` 仍建立独立的本地事件队列、去重状态和终态状态机。

### 7.2 完整事件映射

| OpenCode 事件 | EvolClaw 输出 | 处理要求 |
| --- | --- | --- |
| session create/首次绑定 | `session_id` | 每个新绑定只发一次 |
| `session.status: busy` | `state_changed: running` | 标记当前 turn 运行中 |
| text delta/end、text part update | `text` | 按 text/part ID 去重，只发新增内容 |
| reasoning delta/end | `status`，subtype=`reasoning` | 当前 `AgentEvent` 无 reasoning 类型；不伪造 `thinking` |
| step started/ended | `status` | 仅保留有用户价值的阶段状态 |
| retry/status retry | `status`，subtype=`retry` | 包含 attempt、message、next 等可用摘要 |
| tool called / tool part pending、running | `tool_use` | 同一 `callID` 只发一次；解析完整 input 后再发 |
| tool progress | `status` 或去重后的 `task_progress` | 避免高频刷屏 |
| tool success | `tool_result` | 保留 `callId` 和结果 |
| tool failed | `tool_result` with `isError` | 保留结构化错误 |
| `todo.updated` | `task_progress` | 汇总 pending/in_progress/completed；仅变化时发 |
| compaction started/delta | `status` | 作为压缩过程状态 |
| compaction ended / `session.compacted` | `compact` | 只有能取得真实 preTokens 时发；否则发 `status`，不伪造数值 |
| permission v2 asked | `state_changed: requires_action` + 权限桥 | 不是普通工具结果或用户 prompt |
| question v2 asked | `state_changed: requires_action` + question bridge | 回复走 question API |
| final assistant message + idle | `complete`，随后 `state_changed: idle` | 聚合 title、usage、cost、终止原因；只完成一次 |
| session/assistant error | `error` + error `complete` | 分类为 context/auth/network/unknown |
| abort confirmed | `complete` with interrupted terminal reason + idle | 不把用户中断渲染成普通失败 |
| patch/diff/file watcher | 内部记录，通常不单独发事件 | 文件编辑已由对应 tool 事件表达 |

`AgentEvent` 的十种现有类型必须全部有明确处理：`session_id`、`state_changed`、`text`、`status`、`tool_use`、`tool_result`、`compact`、`task_progress`、`complete`、`error`。

### 7.3 完成条件

完成不能依赖不存在的 `stop_reason`。同一 turn 仅在以下条件之一满足时结束：

- 收到对应 session 的 idle，且能关联到本轮 assistant message；
- 收到明确 session/assistant error；
- abort 得到确认；
- transport 失败且状态查询/有限重连无法恢复。

最终 assistant message 中的模型、token、cost、title 和 finish 信息聚合到 `complete`。来自旧 turn 或其他 session 的 idle/message 不能结束当前队列。

## 八、提问、权限和四种模式

### 8.1 四种公开模式

OpenCode Runner 的 `listModes()` 只返回：

```text
readonly / auto / request / bypass
```

每轮仍使用公共 `normalizePermissionMode()`：

| 输入值 | 运行时结果 |
| --- | --- |
| `readonly` / `auto` / `request` / `bypass` | 原值 |
| legacy `edit` | `request` |
| legacy `noask` | `readonly` |
| legacy `plan` | `readonly` + legacy workflow hint |
| 未知或空值 | `readonly` |

### 8.2 模式语义

| 模式 | OpenCode ruleset 基线 | EvolClaw 行为 |
| --- | --- | --- |
| `readonly` | 明确只读 allow-list，其余 deny | 写、Shell、未知和外部副作用工具直接拒绝，不询问 |
| `auto` | workspace 内常规操作允许，危险/越界/扩权 deny | 禁区直接拒绝，不转成人工可放行项 |
| `request` | 安全基线允许，需要升级的精确动作 ask | 进入现有 `PermissionGateway` |
| `bypass` | 常规动作允许，危险/越界/显式扩权 ask | 常规免审，危险动作仍进入 Gateway |

`bypass` 不是无限权限。绝对禁止命令、H 类路径、EC 角色鉴权、路径边界、危险命令审批和外部工具配置指纹仍然生效。

### 8.3 Permission bridge

仅处理锁定版本的 `permission.v2.asked`：

1. 校验 `sessionID`、Runner 所有权和 canonical project；
2. 从 action/resources/metadata/source 提取精确动作和输入；
3. 先执行 EvolClaw 绝对禁止、H 类、EC 鉴权、危险命令和路径检查；
4. 按当前 per-call mode 决定直接 allow、直接 deny 或请求 `PermissionGateway`；
5. 授权绑定 EvolClaw session、权限 profile、工具类别、精确输入指纹和外部配置哈希；
6. 只向 OpenCode 回复 `once` 或 `reject`，不使用 `always` 替代 EvolClaw 的临时授权；
7. 超时、中断、缺少 Gateway/审批人/渠道或无法重建精确输入时一律拒绝。

OpenCode 没有可充当安全边界的通用 `delete` permission；删除可能由 bash、edit 或自定义工具完成，必须按真实工具和输入判断。

### 8.4 Question bridge

SDK 1.17.18 明确提供 `question.v2.asked`、`question.v2.replied`、`question.v2.rejected` 及 reply/reject API。接入方式应复用 Claude/Codex Runner 已有模式：

1. 将 questions/options/multiple/custom 转为 `ActionInteraction`；
2. 用当前 session 的 `PermissionContext`、`InteractionRouter` 和 `sendInteractionPayload()` 投递；
3. 卡片或文本回复只进入 interaction callback，不进入普通消息队列；
4. 回调调用 OpenCode question reply；取消、超时、中断调用 reject；
5. 校验 operator 身份，群聊只允许合法 initiator/approver 回答。

在这条桥完整实现并通过测试前：

- `capabilities.askUserQuestion = false`；
- 在 OpenCode ruleset/tools 中禁用 question；
- 若仍收到意外 question 事件，立即 reject 并使本轮失败关闭。

## 九、出站消息

普通模型输出不直接调用 Channel，而是保持：

```text
AgentEvent
  → ResponseEngine
  → IMRenderer
  → OutboundPayload
  → ChannelAdapter
```

| 用户可见输出 | 来源 |
| --- | --- |
| `result.text` | `text`/`complete` 经现有聚合和最终回复逻辑生成 |
| `activity.batch` | text、tool call/result、progress、notice 等现有投影 |
| `status.started/progress/completed/interrupted/error/timeout` | ResponseEngine 的任务生命周期 |
| `result.error` | `error` 或错误 `complete` 经统一错误处理生成 |
| `interaction` | PermissionGateway 或 question bridge 使用现有交互发送工具生成 |
| `result.file` | 模型文本中的 `[SEND_FILE:路径]` 由 ResponseEngine 校验并转换 |
| `result.image` | 仅在现有框架拿到图片 Buffer 时生成；OpenCode 首版不承诺原生图片输出 |

工具生成的文件继续使用 EvolClaw 公共 `[SEND_FILE:...]` 协议。OpenCode Runner 不自行上传文件，也不把工具 patch/diff 假装成文件消息。

权限审批和模型提问是现有架构中的受控例外：Runner/Gateway 使用 `PermissionContext`、`InteractionRouter` 和 `sendInteractionPayload()` 发送 `interaction`，不能借此发送任意普通文本或绕过身份校验。

以下现有 `OutboundPayload` 仍由 Runner 之外的框架路径负责，接入 OpenCode 不改变其行为：

| 出站种类 | 现有责任方 | OpenCode 改动 |
| --- | --- | --- |
| `status.queued` | 消息队列/任务调度 | 无 |
| `command.result` / `command.error` | CommandHandler/MenuHandler | 无；通常不进入 Runner |
| `system.notice` / `system.error` | 系统和控制面 | 无 |
| `custom` | 特定 Channel/扩展 | 无；不得由 OpenCode 事件任意构造 |

最终呈现继续受各 `ChannelAdapter.capabilities` 约束；不支持 thought、status、interaction、file 或 image 的渠道使用现有降级行为，而不是由 OpenCode Runner 实现渠道特例。

## 十、模型、统计与运行环境

### 10.1 模型

配置使用 OpenCode 的 `provider/model` 形式，按第一个 `/` 拆为 `providerID` 和 `modelID`，保留 model ID 中可能出现的后续 `/`。`modelOverride.model` 仅作用于本轮，不修改 Runner 中其他 session 的状态。

`listModels()` 惰性启动当前 Runner 的 client，从 OpenCode provider/model API 获取可用目录；失败时返回受控 fallback 或明确错误，不把 provider 认证失败误报成 Runner 不存在。

OpenCode 的 variant 与 EvolClaw `effort` 不完全等价。只有 provider/model capability 明确支持映射时才应用，否则忽略并产生可诊断状态，不伪造通用推理强度。

### 10.2 Token 和费用

| OpenCode AssistantMessage | EvolClaw `complete` |
| --- | --- |
| `tokens.input` | `tokenUsage.input_tokens` |
| `tokens.output` | `tokenUsage.output_tokens` |
| `tokens.cache.read` | `tokenUsage.cache_read_input_tokens` |
| `tokens.cache.write` | `tokenUsage.cache_creation_input_tokens` |
| `tokens.reasoning` | 保留在模型调用扩展明细；公共 tokenUsage 暂无对应字段 |
| `cost` | `costUsd`，需验证 provider 的币种和语义 |

`contextUsage.maxTokens` 从 provider model limit 获取；缺失时不伪造百分比。Gateway 自定义价格继续走 EvolClaw 现有价格解析逻辑。

### 10.3 `runtimeEnv`

OpenCode prompt API 没有 per-turn env 参数。可行路径是 Runner 管理的 OpenCode plugin `shell.env` hook，按 OpenCode `sessionID` 从内存 map 读取：

- prompt 前绑定；
- 只返回当前活跃 turn 的 env；
- complete/error/abort/finally 后删除；
- 不写入 session metadata、持久配置或日志；
- 不允许项目同名 plugin 覆盖宿主管理的 hook。

若锁定版本无法证明该 hook 的 session 隔离，涉及 delegation token 的能力不能上线。

## 十一、高级能力与 capability

### 11.1 首版声明

```typescript
readonly capabilities = {
  clear: true,
  compact: false,
  fork: false,
  askUserQuestion: false,
  planApproval: false,
  fileRewind: 'unsupported' as const,
};
```

### 11.2 验证后开放

| 能力 | OpenCode 基础 | 开放条件 |
| --- | --- | --- |
| compact | summarize/compaction API 和事件 | 手动/自动 compact、统计和中断语义通过真实模型测试 |
| fork | 原生 `session.fork()` | 目录、metadata、权限和临时授权隔离通过测试 |
| ask user question | question v2 API | InteractionRouter 卡片/文本 fallback、身份、超时和中断通过测试 |
| file rewind | Git snapshot + revert/unrevert | `/rewind chat|file|all` 能安全符合现有拆分语义 |
| plan approval | 无 Claude `ExitPlanMode` 等价契约 | 保持 false，除非另行设计公共能力 |

OpenCode `revert()` 可能同时改变历史和 Git snapshot，而 EvolClaw 把 chat/file/all rewind 分开。在不能安全拆分前不得声明 `checkpoint`。

## 十二、实施顺序

### 阶段 A：按现有骨架做协议 PoC

1. 在 `OpencodeRunner` 内实现私有惰性 server/client 和动态端口。
2. 建立两个 EvolAgent 各自 Runner，验证进程、配置和事件完全隔离。
3. 每个 Runner 建立两个并发 session，验证 text/tool/todo/retry/error/idle 不串流。
4. 验证图片 part、system prompt、model override 和 runtime env。
5. 验证四模式 ruleset 替换语义以及 permission `once/reject`。

### 阶段 B：MVP BaseAgent

1. 接入 `BaseagentOpencodeConfig`、alias、CLI selector、Plugin 注册和模型目录。
2. 实现完整 `runQuery()` 输入和十种 `AgentEvent` 映射。
3. 实现 session create/resume/clear/interrupt 和 project 校验。
4. 实现 `readonly`、`auto`，并关闭未审计 plugin/MCP/question。
5. 补齐主进程 Runner dispose。

### 阶段 C：审批和交互

1. 实现 `request`、`bypass` 的 `PermissionGateway` 桥。
2. 实现 question v2 → `InteractionRouter` 桥，再开放 `askUserQuestion`。
3. 完成外部 plugin/MCP 枚举、配置指纹和失败关闭。
4. 验证 `runtimeEnv` 中短期 token 的精确隔离和清理。

### 阶段 D：高级能力和发布

1. 验证后开放 compact、fork；专项决定 rewind。
2. 锁定兼容 SDK/CLI 版本并增加启动 capability probe。
3. 完成 Linux/macOS/Windows 的路径、端口和进程清理测试。
4. 运行单元、集成、真实 provider 和渠道消息矩阵测试。

## 十三、验收门槛

| 验收项 | 必须结果 |
| --- | --- |
| 架构一致性 | `agentMap` 仍为 `${aid}::${baseagent}`；无全局 OpenCode Manager |
| Runner 隔离 | 两个 EvolAgent 使用独立 server/client/端口/权限/env |
| Runner 内并发 | 同一 Runner 多 session 的文本、工具、权限、question、完成事件不串流 |
| 输入消息 | 文本、图片、文件路径、视频路径、语音 transcript、引用、批次和 trigger 均按既有参数进入 |
| 输出消息 | 十种 `AgentEvent` 均合法，出站只经 ResponseEngine/IMRenderer/ChannelAdapter |
| 权限 | 四种公开模式逐项通过；`bypass` 危险动作仍审批；失败路径全部 deny |
| 交互 | question/permission 回复不进入普通 prompt，身份、超时、中断正确 |
| Session | create/resume/clear/interrupt、跨进程恢复和目录不匹配保护通过 |
| 生命周期 | SIGTERM、热加载替换和异常路径后无 SSE 或 OpenCode 子进程遗留 |
| 敏感环境 | `runtimeEnv` 只注入目标 turn，结束后不可读取且日志中无 token |

## 最终结论

OpenCode 作为第四种 BaseAgent **技术上可行**，最佳集成方式是采用 Codex Runner 的私有惰性后端结构，同时复用现有 PermissionGateway 和 InteractionRouter。实现不需要改变 EvolClaw 的 BaseAgent 公共骨架，也不应新增进程级共享服务或 OpenCode 专属消息协议。进入正式开发前，仍需用上述骨架完成事件、权限、question、并发和生命周期 PoC。
