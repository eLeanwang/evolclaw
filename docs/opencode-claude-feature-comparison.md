# OpenCode 与现有 BaseAgent 集成方式对比

**初次对比日期**：2026-06-26

**修订日期**：2026-07-14

**目的**：确定 OpenCode 应采用 Claude、Codex、Gemini 三种现有方式中的哪一种，并明确功能差异

## 一、推荐结论

OpenCode 应作为 EvolClaw 的第四种 BaseAgent，**采用 Codex Runner 的结构骨架集成**：

- 每个 `EvolAgent × opencode` 创建独立 `OpencodeRunner`；
- 每个 Runner 私有一个惰性启动的 OpenCode server/client；
- 一个 Runner 内复用服务并承载该 EvolAgent 的多个 session；
- Runner 内维护 session/turn/SSE/permission/question/runtime-env map；
- 通过既有 `AgentRunnerFull` 输入和 `AgentEvent` 输出接入 `ResponseEngine`；
- 权限审批复用现有 `PermissionGateway`，用户提问复用 `InteractionRouter`。

这不是复制 Codex 协议，也不是建立所有 Runner 共享的 OpenCode 服务。Codex 提供的是最相似的**进程和状态所有权模式**。

## 二、三种现有方式比较

| 维度 | Claude Runner | Codex Runner | Gemini Runner | OpenCode 特征 |
| --- | --- | --- | --- | --- |
| 后端生命周期 | SDK query 为主 | Runner 私有常驻 app-server client | 每轮 CLI 子进程 | 常驻 HTTP server/client |
| 实时输出 | query 私有 AsyncIterable | 独立通知流按 thread/turn 路由 | stdout JSONL | 独立 SSE 按 session 路由 |
| Session 并发 | Runner 内 map | Runner 内 thread/turn map | Runner 内 process/session map | 需要 Runner 内 session/turn map |
| 异步权限 | SDK callback/hook | server request/approval | headless policy，交互能力弱 | permission SSE + reply API |
| 用户提问 | AskUserQuestion hook | requestUserInput server request | 不支持 | question SSE + reply/reject API |
| 惰性后端 | query 时使用 SDK | `getAppServerClient()` | runQuery 时 spawn | 应在 runQuery/listModels 时启动 |
| 最接近部分 | 权限/交互语义 | **结构和生命周期** | CLI 探测/图片兜底 | — |

### 2.1 为什么不以 Claude 为主模板

Claude SDK 的单次 query 本身就是事件流，权限和 AskUserQuestion 通过宿主 callback 进入。OpenCode 的 prompt、SSE、permission 和 question 是分离的 API/事件，需要长期 client、订阅和本地路由状态。因此可以复用 Claude 的交互体验，但不能照搬其 query 生命周期。

### 2.2 为什么选择 Codex

Codex Runner 已经解决了与 OpenCode 最相近的问题：

- `AgentPlugin.createAgent()` 同步创建轻量 Runner；
- 后端 client 在第一次使用时惰性创建；
- 一个 Runner 内有多个 session 和 active turn；
- 异步通知按 thread/turn 过滤和去重；
- 权限上下文按 EvolClaw session 保存；
- 中断需要同时处理远端 turn 和本地 queue；
- `dispose()` 关闭 Runner 私有后端。

OpenCode 应把 Codex 的 thread 换成 OpenCode session，把 app-server notification 换成 SSE，而不改变上层架构。

### 2.3 为什么不以 Gemini 为主模板

Gemini Runner 每轮启动 CLI 并从 stdout 读取 JSONL，生命周期短且没有常驻共享事件流。OpenCode server 的启动成本、SSE、permission/question 回调和 session 状态都要求长生命周期 client。Gemini 只适合借鉴 CLI 可用性检查、spawn 安全和必要时的图片临时文件处理。

## 三、架构落点

```text
AgentLoader
  ├─ ClaudeAgentPlugin → Claude Runner
  ├─ CodexAgentPlugin  → Codex Runner
  ├─ GeminiAgentPlugin → Gemini Runner
  └─ OpencodeAgentPlugin → OpencodeRunner

agentMap[`${aid}::${baseagent}`]
  → AgentRunnerFull.runQuery()
  → AgentEvent
  → ResponseEngine
  → IMRenderer
  → ChannelAdapter
```

OpenCode 不新增第二套 loader、service registry、message router 或 outbound channel API。

### 3.1 Runner 粒度

| 项目 | Codex 当前做法 | OpenCode 目标做法 |
| --- | --- | --- |
| Runner 数量 | 每 EvolAgent × Codex 一个 | 每 EvolAgent × OpenCode 一个 |
| 后端进程 | Runner 私有 app-server | Runner 私有 OpenCode server |
| 启动时机 | 首次需要 client | 首次 `runQuery()` / `listModels()` |
| 端口 | app-server 私有协议 | Runner 内部动态端口，不暴露配置 |
| Session | Runner 内多个 thread | Runner 内多个 OpenCode session |
| 事件路由 | threadId + turnId | sessionID + project + turn state |
| shutdown | Runner `dispose()` | Runner `dispose()`，并补齐主进程统一调用 |

不采用进程级共享 `OpenCodeServiceManager`。固定 `4096` 冲突通过动态端口解决；共享服务会削弱 AID 的配置、权限、plugin、环境和故障隔离。

## 四、`AgentRunnerFull` 能力对比

| EvolClaw 接口 | Claude | Codex | Gemini | OpenCode 目标 |
| --- | --- | --- | --- | --- |
| `runQuery()` | SDK query stream | turn start + notification queue | CLI JSONL | prompt + SSE queue |
| `interrupt()` | query interrupt | turn interrupt + local abort | kill child | session abort + local queue end |
| `updateSessionId()` | session map | thread map | session map | OpenCode session map |
| `closeSession()` | 清活跃状态 | 清 turn/context | 清 process/context | 清 turn/permission/question/env，保留持久 session |
| `clearSession()` | lifecycle query/文件语义 | 当前 capability=false | 清本地 resume | session delete + 清绑定 |
| `compactSession()` | 支持 | 支持 | 不支持 | API 存在，验证后开放 |
| `forkSession()` | 支持 | 支持 | 不支持 | API 存在，验证后开放 |
| `getSessionMessages()` | 支持 | 支持 | 适配器能力 | 可转换 OpenCode messages |
| `setPermissionContext()` | 支持 | 支持 | 保存但无交互审批 | 必须支持 |
| `setPermissionGateway()` | 支持 | 支持 | 不支持交互审批 | 必须支持四模式审批 |
| `dispose()` | 清 query/状态 | 关闭 app-server | kill children | 关闭 SSE/server/client 和所有待处理交互 |

## 五、输入消息对比

OpenCode Runner 不接触渠道原始消息，只接收现有 `runQuery()` 参数。

| 消息种类 | 当前 EvolClaw 标准化 | Claude | Codex | Gemini | OpenCode 目标 |
| --- | --- | --- | --- | --- | --- |
| 文本/富文本 | `prompt` | 支持 | 支持 | 支持 | 支持 |
| 图片 | `images` | SDK image block | localImage | 临时文件 `@path` | file part/data URL |
| 普通文件 | 下载后路径写进 `prompt` | 工具读取 | 工具读取 | 工具读取 | 工具读取 |
| 视频 | 下载后路径写进 `prompt` | 路径语义 | 路径语义 | 路径语义 | 路径语义；不承诺原生理解 |
| 语音 | transcript 或文件路径进入 `prompt` | 文本/路径 | 文本/路径 | 文本/路径 | 文本/路径 |
| 引用/回复/转发 | Channel 展开为文本/图片 | 沿用 | 沿用 | 沿用 | 沿用 |
| @/群聊/批次 | ECK/渲染层加入 prompt | 沿用 | 沿用 | 沿用 | 沿用 |
| thread/topic | EvolClaw session 路由 | 非 SDK 消息类型 | 非协议消息类型 | 非 CLI 消息类型 | 非 OpenCode part |
| trigger/inject/handoff/restart | `prompt` / `systemPromptAppend` | 沿用 | 沿用 | 沿用 | 沿用 |
| slash/menu/CommandCard | Runner 前快速路径 | 不进入 | 不进入 | 不进入 | 不进入 |
|权限回复 | InteractionRouter/Gateway | callback | server request | 不支持 | permission reply API |
|模型提问回复 | InteractionRouter | AskUserQuestion | requestUserInput | 不支持 | question reply/reject API |

当前 `AgentRunnerFull` 没有普通文件、音频或视频参数，因此不能只为 OpenCode扩展一套结构化输入。

## 六、事件和出站消息对比

### 6.1 OpenCode → `AgentEvent`

| `AgentEvent` | Claude 来源 | Codex 来源 | OpenCode 来源 |
| --- | --- | --- | --- |
| `session_id` | init/session event | thread start/resume | session create/bind |
| `state_changed` | SDK state | turn/approval state | busy/idle、permission/question asked |
| `text` | assistant text | agent message delta | text delta/end/part update |
| `status` | thinking/retry/phase | reasoning/plan/phase | reasoning、retry、step、tool progress |
| `tool_use` | tool use block | item started | tool called 或 running part |
| `tool_result` | tool result block | item completed | tool success/failed |
| `compact` | compact boundary | compact completion | compaction ended/session compacted |
| `task_progress` | subagent progress | plan/progress 可转换项 | `todo.updated` 汇总 |
| `complete` | SDK result | turn completed | final assistant message + idle |
| `error` | SDK/query error | turn/item/transport error | session/message/HTTP/SSE error |

Reasoning 不能生成不存在的 `AgentEvent.thinking`；应映射为 `status(reasoning)`。Todo 不是新事件类型；应映射为去重后的 `task_progress`。

### 6.2 出站保持统一

四种 Runner 的普通模型输出都先转换为 `AgentEvent`，之后统一生成：

- `result.text`；
- `activity.batch`；
- `status.started/progress/completed/interrupted/error/timeout`；
- `result.error`；
- `interaction`；
- 经 `[SEND_FILE:...]` 扫描产生的 `result.file`；
- 框架已有 Buffer 时产生的 `result.image`。

OpenCode Runner 不直接发送渠道消息，不自行上传文件。OpenCode 首版不声明原生图片输出。

权限和模型提问沿用现有受控交互例外，通过 `PermissionContext`、Gateway/Router 和 `sendInteractionPayload()` 生成 `interaction`；这不是普通输出旁路。`status.queued`、`command.result/error`、`system.notice/error` 和 `custom` 继续由现有队列、命令、系统及渠道扩展处理，OpenCode 不改变其责任归属。

## 七、权限和交互对比

### 7.1 四种公开模式

| 模式 | Claude/Codex 统一语义 | OpenCode 目标语义 |
| --- | --- | --- |
| `readonly` | 明确只读允许，写/Shell/未知拒绝 | 只读 ruleset，禁区 deny，不询问 |
| `auto` | 基线内常规操作允许，危险/扩权拒绝 | workspace 常规允许，危险/越界/扩权 deny |
| `request` | 需要升级项进 `PermissionGateway` | permission asked → `PermissionGateway` |
| `bypass` | 常规免审，危险操作仍审批 | 常规 allow，危险/越界/扩权仍 ask |

历史值继续由公共层迁移：`edit → request`、`noask → readonly`、`plan → readonly + workflow`、未知值 → `readonly`。

### 7.2 权限实现差异

| 维度 | Claude | Codex | OpenCode |
| --- | --- | --- | --- |
| 原生入口 | hook/canUseTool | app-server approval request | permission v2 SSE |
| 单次回复 | callback result | request response | `once` / `reject` |
|永久授权 | 不作为公共语义 | 不替代 Gateway | 不使用 `always` 替代 Gateway |
| EvolClaw 安全层 | 绝对禁止/H 类/路径/EC/危险命令 | 同左 | 必须同左 |
| 外部工具 | config + approval fingerprint | MCP/tool config fingerprint | plugin/MCP 必须枚举并指纹化 |

### 7.3 模型提问

Claude 和 Codex 已有将模型问题转为 `ActionInteraction`、卡片或文本 fallback 的实现模式。OpenCode SDK 已提供 question v2 事件和 reply/reject API，可复用这一上层交互设计。

但在桥接完成前应禁用 question，并声明 `askUserQuestion: false`。API 存在并不意味着 capability 已实现。

## 八、Session 与高级能力

| 能力 | Claude | Codex | Gemini | OpenCode 判断 |
| --- | --- | --- | --- | --- |
| 持久化/恢复 | 支持 | 支持 | CLI resume | 支持；恢复必须校验 canonical directory |
| 多 session | Runner map | Runner map | Runner map/process | Runner map + SSE queue |
| Fork | 原生 | 原生 | 不支持 | 原生 API，验证隔离后开放 |
| Compact | 原生/流程 | 原 | 不支持 | API/事件可用，真实模型验证后开放 |
| 获取历史 | 支持 | 支持 | 文件适配 | API 可转换 |
| 文件回退 | checkpoint | git-head 降级 | 不支持 | Git snapshot 基础，但公共语义未兼容 |
| 标题/metadata | 支持程度有限 | 支持部分 | 有限 | API 较完整 |
| 分享/导出 | 非核心 | 非核心 | 非核心 | OpenCode 有能力，但首版非目标 |

OpenCode revert 可能同时修改历史和文件，而 EvolClaw 将 chat/file/all rewind 分开。因此首版 `fileRewind` 必须为 `unsupported`。

## 九、模型、统计和上下文

| 维度 | Claude | Codex | Gemini | OpenCode |
| --- | --- | --- | --- | --- |
| 每轮模型覆盖 | query option | turn option | CLI args | prompt model |
| 模型目录 | Gateway/配置 | app-server catalog | CLI/fallback | provider/model API |
| effort | Claude effort | reasoning effort |模型/CLI能力 | provider variant，不能假设通用 |
| input/output token | Claude 字段 | Codex usage | CLI usage | `tokens.input/output` |
| cache token | Claude cache 字段 | Codex usage | 取决于 CLI | `tokens.cache.read/write` |
| reasoning token | 模型相关 | 模型相关 | 模型相关 | `tokens.reasoning`，放扩展明细 |
| cost | SDK/Gateway |统计/价表 |价表 | assistant `cost`，需验证语义 |
| context percentage | 模型窗口计算 |模型窗口计算 |可得时计算 | provider limit 可得时计算 |

## 十、配置对比

OpenCode 应保持与其他 BaseAgent 相同的配置位置：

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

| 字段 | Claude | Codex | Gemini | OpenCode |
| --- | --- | --- | --- | --- |
| `model` | 有 | 有 | 有 | 有 |
| `cliPath` | executable 字段 | PATH/app-server 检测 | 有 | 有 |
| provider key/base URL | 可由 EvolClaw 配置 | 可由 EvolClaw 配置 | 可配置 | 不新增，由 OpenCode 管理 |
|用户端 port | 无 | 无 | 无 | **无，内部动态端口** |
| `permissionMode` |公共作用域 |公共作用域 |公共作用域 |公共作用域，不放 baseagent block |

## 十一、初始 capability 建议

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

compact、fork、askUserQuestion 都应在对应桥或语义测试完成后再改为 true；不要因为 SDK 有 endpoint 就提前声明。

## 十二、风险对比

| 风险 | 等级 | OpenCode 必要控制 |
| --- | --- | --- |
| SSE 同 Runner 多 session 串流 | 高 | sessionID + project + turn 三重关联和事件去重 |
|两个 EvolAgent 配置/权限串扰 | 高 | 每 Runner 私有 server/client，不使用全局 Manager |
| permission ruleset 残留旧模式 | 高 | 验证完整替换；否则降权时重建或失败关闭 |
| plugin/MCP 绕过权限 | 高 |枚举、禁用或精确审批，配置参与指纹 |
| question 永久等待 | 高 | capability 开放前禁用；意外事件 reject + fail closed |
| project directory 越权恢复 | 高 |读取 session 并比较 canonical directory |
| `runtimeEnv` token 泄漏 | 高 |仅 Runner 内存绑定 turn，finally 清理 |
| 子进程/SSE 遗留 | 中 |主进程统一 await Runner dispose |
| SDK/CLI 版本漂移 | 中 | exact pin + capability probe + 升级回归 |
| rewind 语义不一致 | 中 |首版 unsupported，专项验证 |

## 十三、推荐实施顺序

1. 按 Codex Runner 骨架实现轻量 Plugin、Runner 私有惰性 server/client 和内部动态端口。
2. 验证两个 EvolAgent 的 Runner 隔离，以及每个 Runner 内两个并发 session 的事件路由。
3. 完成现有 `runQuery()` 全参数和十种 `AgentEvent`，覆盖 text/reasoning/todo/tool/retry/error/idle。
4. 接入配置、alias、selector、模型目录、session 持久化和统一 dispose。
5. 先实现 `readonly`、`auto`；再接 `request`、`bypass` 的 `PermissionGateway`。
6. 完成 question → `InteractionRouter` 后开放 `askUserQuestion`。
7. 真实模型验证后开放 compact/fork；专项决定 rewind。

## 最终判断

OpenCode 核心集成**可行**，且无需背离 EvolClaw 现有 BaseAgent 设计。三种现有方式中应明确选择 **Codex Runner 的结构骨架**，再复用 Claude/Codex 的权限与交互桥。代码和配置应保持局部增量：一个 Runner 文件、可选薄 client 文件、现有 `baseagents.opencode` 配置，以及既有注册/目录/schema 接入点；不采用全局共享服务或 OpenCode 专属消息链。
