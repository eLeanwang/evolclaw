# OpenCode SDK 可行性验证结果

**初次研究日期**：2026-06-26

**修订日期**：2026-07-14

**验证基线**：当前 EvolClaw 工作树、`@opencode-ai/sdk` 1.17.18、OpenCode CLI 1.17.11

**状态**：可作为第四种 BaseAgent 接入；生产可用性取决于协议 PoC

本文结合当前 EvolClaw 代码、OpenCode v2 SDK 生成类型、CLI/SDK 源码和既有隔离烟测，纠正早期文档中与现有 BaseAgent 骨架不一致的结论。详细实施方式见 [OpenCode BaseAgent 集成方案](./opencode-integration-plan.md)。

## 一、结论摘要

1. OpenCode 基础对话、持久 session、中断、模型选择、Token/费用信息、fork、compact 和 question 均有 API 或事件基础，技术上可集成。
2. OpenCode 最适合采用 **Codex Runner 的结构骨架**：每个 `EvolAgent × opencode` 创建一个 Runner，Runner 私有并惰性启动常驻后端、client 和事件流。
3. 不应增加进程级共享 `OpenCodeServiceManager`。固定端口冲突应通过每 Runner 内部动态端口解决，而不是改变 EvolClaw 的 Runner 所有权模型。
4. Runner 输入必须保持当前 `runQuery()` 参数，输出必须保持当前十种 `AgentEvent`；普通文件、音视频和渠道交互不能另建 OpenCode 专属协议。
5. EvolClaw 只公开 `readonly`、`auto`、`request`、`bypass` 四种权限模式，OpenCode 必须复用 `PermissionGateway` 和 `PermissionContext`。
6. 技术决策为：**按现有骨架实施协议 PoC 可行；按旧的共享服务/独立消息架构直接开发不可行；生产发布待验收**。

## 二、现有 BaseAgent 骨架核对

### 2.1 代码事实

当前 `AgentLoader` 明确规定：

- 一个 plugin 对应一种 BaseAgent；
- 为每个可运行 EvolAgent 和其声明的 BaseAgent 创建独立 Runner；
- `AgentPlugin.createAgent()` 是同步方法；
- `agentMap` 使用 `${aid}::${baseagent}`；
- Runner 同时实现 session map、active turn、权限上下文、stream 和 dispose。

Codex Runner 已经给出最接近 OpenCode 的先例：构造时只创建轻量对象，第一次需要时创建 Runner 私有 app-server client；通知按 thread/turn 路由；`dispose()` 清理私有后端。

### 2.2 三种实现方式对比

| 实现 | 传输/生命周期 | OpenCode 可复用部分 | 适配度 |
| --- | --- | --- | --- |
| Claude | SDK query 私有流 | 权限和 AskUserQuestion 的交互模式 | 中 |
| Codex | Runner 私有常驻进程/client + 异步通知 | Runner 结构、session/turn map、惰性启动、中断和 dispose | **最高** |
| Gemini | 每轮 CLI 子进程 + stdout JSONL | CLI 探测、临时图片文件兜底 | 低 |

因此“采用 Codex 方式”指结构同构，不是复用 Codex client，也不是让所有 OpenCode Runner 共享一个进程。

### 2.3 服务粒度结论修正

隔离烟测确认两个服务不能同时绑定固定 `4096`。这一结果只能否定固定端口方案。可行且符合现有骨架的设计是：

- 每个 `OpencodeRunner` 私有一个 OpenCode server/client；
- 首次 `runQuery()` / `listModels()` 时惰性启动；
- 为每个 Runner 分配独立内部动态端口；
- 一个 Runner 的服务承载该 EvolAgent 的多个 session；
- server、SSE、permission、question 和 env 都在 Runner `dispose()` 时回收。

这比进程级共享服务多占用少量本地进程，但保留 AID 配置、权限、plugin、故障和敏感环境的隔离边界，符合现有设计意图。

## 三、OpenCode 协议事实

### 3.1 依赖和启动

- SDK 包为 `@opencode-ai/sdk`；
- CLI 包为 `opencode-ai`，命令名为 `opencode`；
- `npm install -g opencode` 不是正确安装方式；
- SDK server helper 仍通过 PATH 启动 `opencode serve`；
- SDK 1.17.18 helper 默认端口是 `4096`，并未自动为多个 Runner 解决端口冲突；
- helper 将命令名硬编码为 `opencode`，若要支持 `cliPath`，需要薄 client/process wrapper。

开发版本应 exact pin，并在实现时重新确认 SDK 与 CLI 的兼容组合。当前本机验证基线是 SDK 1.17.18 类型和 CLI 1.17.11；不能假设不同补丁版本的生成协议完全一致。

### 3.2 Prompt 与事件流

`client.session.prompt()` 返回请求结果，不提供旧文档写的 `response.stream`。实时事件来自独立 SSE：

```typescript
const subscription = await client.event.subscribe({ directory: projectPath });

for await (const event of subscription.stream) {
  // Runner 按 sessionID + project 绑定路由到本地 turn queue
}
```

SDK 1.17.18 同时提供细粒度 `session.next.*` 事件和兼容事件/part 更新。实现应在锁定版本选择一个权威来源，避免 text/tool/compaction 被两套事件重复投递。

### 3.3 已确认的事件种类

| 协议种类 | SDK 1.17.18 证据 | EvolClaw 用途 |
| --- | --- | --- |
| text | started/delta/ended、message part update/delta | `AgentEvent.text` |
| reasoning | started/delta/ended、reasoning part | `AgentEvent.status(reasoning)` |
| tool | input started/delta/ended、called/progress/success/failed、tool part | `tool_use` / `tool_result` / `status` |
| todo | `todo.updated`，包含 content/status/priority | `task_progress` 摘要 |
| retry | `session.next.retried`、`session.status: retry` | `status(retry)` |
| session state | busy/idle、`session.error`、`session.compacted` | state/complete/error/compact |
| permission | `permission.v2.asked/replied` | `PermissionGateway` 桥 |
| question | `question.v2.asked/replied/rejected` 和 reply/reject API | `InteractionRouter` 桥 |
| diff/revert | session diff、revert staged/cleared/committed | rewind PoC 和内部记录 |

OpenCode 事件不能原样透传。`AgentEvent` 没有 `thinking`、`reasoning` 或 `todo` 类型，适配器只能映射为现有合法事件。

### 3.4 完成和错误

旧文档中的 `stop_reason` 不是当前 OpenCode 完成契约。一个 turn 的完成应关联同一 `sessionID` 的最终 assistant message 与 idle；错误来自 session error、assistant message error、请求或 SSE 异常；中断需等待 abort/idle 收敛。

每个活跃 turn 必须有独立队列、消息/part 去重、callID 状态和 terminal flag。来自旧 turn、其他 session 或兼容事件副本的 idle/message 不能结束当前 turn。

## 四、EvolClaw 消息契约核对

### 4.1 Runner 输入

当前 `AgentRunnerFull.runQuery()` 只定义：

```text
sessionId
prompt
projectPath
initialAgentSessionId
images
systemPromptAppend
sessionManager
modelOverride
runtimeEnv
```

因此消息支持应解释为“渠道如何标准化到这些参数”，而不是给 OpenCode 增加独有参数。

| 入站种类 | 现有链路中的标准形态 | OpenCode 判断 |
| --- | --- | --- |
| 文本、富文本 | `prompt` | 可直接支持 |
| 图片 | `images: ImageData[]` | 映射为 file part/data URL；模型能力需验证 |
| 普通文件 | Channel 下载到项目目录，路径和提示进入 `prompt` | 通过工具读取；不是结构化附件参数 |
| 视频 | 下载后的路径/说明进入 `prompt` | 路径可用，不承诺原生视频理解 |
| 语音 | 有 transcript 时作为 `prompt`；否则走文件路径能力 | 有条件支持 |
| 引用/回复/转发 | Channel 展开后的文本与附件 | 沿用现状 |
| @/群聊/批次 | ECK/消息渲染后的 prompt | 沿用现状 |
| thread/topic | EvolClaw session/reply 路由 | 不作为 OpenCode part |
| trigger/inject/handoff/restart | `prompt` / `systemPromptAppend` | 沿用现状 |
| slash/menu/card command | Runner 前的 CommandHandler 快速路径 | 不进入 Runner |
| permission/card reply | InteractionRouter/PermissionGateway | 不进入普通 prompt |

### 4.2 Runner 输出

现有完整集合为：

```text
session_id / state_changed / text / status / tool_use / tool_result /
compact / task_progress / complete / error
```

普通模型事件由 `ResponseEngine → IMRenderer → ChannelAdapter` 转换为 `result.text`、`result.file`、`result.image`、`result.error`、`activity.batch` 和生命周期 status。Runner 不应为普通输出直接发送 IM，也不应返回 OpenCode 专属 outbound payload。

文件输出继续依赖模型文本中的 `[SEND_FILE:...]`，由 ResponseEngine 校验路径后产生 `result.file`。OpenCode 首版没有直接图片输出到现有 `AgentEvent` 的契约，不应声明原生图片输出支持。

权限和 question 使用当前 BaseAgent 已有的受控交互旁路：`PermissionContext`、`PermissionGateway`、`InteractionRouter` 和 `sendInteractionPayload()` 生成 `interaction`。`status.queued`、`command.result/error`、`system.notice/error` 和 `custom` 仍由队列、命令、系统或渠道扩展负责，OpenCode Runner 不接管这些类型。

## 五、四种权限模式

### 5.1 公开模式和迁移

| 输入 | 公共归一化结果 |
| --- | --- |
| `readonly` / `auto` / `request` / `bypass` | 原值 |
| `edit` | `request` |
| `noask` | `readonly` |
| `plan` | `readonly` + legacy workflow |
| 未知值 | `readonly` |

Runner 的 `listModes()`、`/perm` 和新配置只暴露四种模式。

### 5.2 权限桥可行性

OpenCode session 支持 `PermissionRuleset`，v2 permission request 包含 action、resources、metadata 和 source，回复为 `once`、`always` 或 `reject`。适配可行，但不是简单字符串映射：

1. ruleset 必须按当前 session 和 per-call mode 应用，不能写共享全局配置；
2. `readonly`、`auto` 的禁区直接 deny，不变成人工可放行项；
3. `request` 和 `bypass` 的必要升级项进入现有 `PermissionGateway`；
4. 绝对禁止、H 类、EC 鉴权、危险命令、路径 canonicalize 和外部工具指纹仍由 EvolClaw 判定；
5. 只向 OpenCode 回复 `once` / `reject`，不以 `always` 替代 EvolClaw 临时授权；
6. 缺失 session/project 绑定、精确输入、Gateway、审批人或渠道时失败关闭。

OpenCode 没有独立通用 `delete` permission。删除可能来自 bash、edit 或具体扩展工具，不能依赖虚构的 `{ delete: "deny" }` 作为边界。

### 5.3 待 PoC 风险

当前 session permission update 可能存在合并语义。必须证明每轮完整 ruleset 能替换旧模式；若旧 allow 规则无法可靠移除，模式降低时必须重建/fork session 或拒绝继续，不能带着残留权限运行。

OpenCode plugin/MCP/自定义工具也必须枚举、限制和加入审批指纹。无法识别精确输入或生命周期的外部工具首版禁用。

## 六、Question 和 capability

OpenCode question 协议在 SDK 中明确存在，但“API 存在”不等于 EvolClaw 已支持。完整支持需要：

- question/options/multiple/custom → `ActionInteraction`；
- `PermissionContext` 提供 adapter、channel、reply 和 operator 信息；
- `InteractionRouter` 完成卡片或文本 fallback 回调；
- reply/reject 绑定正确 `sessionID` 和 request ID；
- 超时、中断、渠道失败和非法 operator 全部 reject。

因此首版 capability 应保守声明：

| capability | MVP | 开放条件 |
| --- | --- | --- |
| `clear` | `true` | session delete/绑定清理通过测试 |
| `compact` | `false` | 真实模型下完成语义通过 |
| `fork` | `false` | 目录/权限/metadata 隔离通过 |
| `askUserQuestion` | `false` | question bridge 全链路通过 |
| `planApproval` | `false` | 无等价公共契约 |
| `fileRewind` | `unsupported` | chat/file/all 拆分语义专项通过 |

MVP 必须在 OpenCode tools/ruleset 中禁用 question；若意外收到 question 事件，则 reject 并失败关闭，而不是让 turn 永久等待。

## 七、Session 与高级能力

### 7.1 持久化和恢复

既有隔离烟测确认 session 创建、服务重启后按 ID 恢复和删除可用。恢复时仍必须读取 session 记录并校验 canonical directory。实测仅改变查询 directory 不能防止按 ID 取到其他项目记录。

### 7.2 Fork

SDK 提供原生 `session.fork()`，既有隔离烟测已通过基础调用。生产开放前还需验证：

- fork 后 directory 与源项目一致；
- 标题和 EvolClaw metadata 同步；
- 当前四模式 ruleset 重新应用；
- 永久/临时授权和 `runtimeEnv` 不被错误继承。

### 7.3 Compact

OpenCode 提供 summarize/compaction API 和事件。还需用真实模型验证手动完成边界、统计、中断/失败、自动 compact，以及是否与 EvolClaw 自动 compact 重复触发。在此之前 `capabilities.compact` 保持 false。

### 7.4 Rewind

OpenCode revert 与内部 Git snapshot 有文件回退基础，不是早期文档所说的“只有消息删除”。但它可能同时改变对话历史和文件状态，而 EvolClaw 将 `/rewind chat|file|all` 分开。项目非 Git、大文件、gitignored 文件和关闭 snapshot 也存在边界。因此首版不能声明 checkpoint file rewind。

## 八、模型、统计和运行环境

### 8.1 模型和 effort

OpenCode 使用 provider/model，prompt 可按轮指定模型。provider model 目录可用于 `listModels()`。模型 variant 与 EvolClaw `effort` 因 provider 而异，不能假设通用一一映射。

### 8.2 Token 和费用

当前 AssistantMessage 字段可转换：

| OpenCode | EvolClaw |
| --- | --- |
| `tokens.input` | `input_tokens` |
| `tokens.output` | `output_tokens` |
| `tokens.cache.read` | `cache_read_input_tokens` |
| `tokens.cache.write` | `cache_creation_input_tokens` |
| `tokens.reasoning` | 模型调用扩展明细 |
| `cost` | `costUsd`，需验证币种/语义 |

字段名并不与 Claude 完全相同。context percentage 需要 provider model limit；缺失时不应估算伪值。Gateway 定价继续使用 EvolClaw 价格解析逻辑。

### 8.3 `runtimeEnv`

OpenCode prompt 无 per-turn env 字段，但 plugin `shell.env` hook 带 session ID，可作为实现路径。安全要求：

- env 只存 Runner 内存并绑定活跃 OpenCode session/turn；
- prompt 前注册，complete/error/abort/finally 删除；
- 不写 metadata、配置或日志；
- 项目 plugin 不能覆盖宿主 hook；
- 无法证明 session 隔离时，不注入短期 delegation token。

## 九、配置核对

应沿用现有配置结构：

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

只增加 `BaseagentOpencodeConfig { model?, cliPath? }`。不要增加用户端 `port`、`baseUrl`、认证字段或顶层 `agents.opencode`。动态端口属于 Runner 内部；provider 凭证属于 OpenCode。

## 十、验证汇总

| 能力 | 当前判断 | 说明 |
| --- | --- | --- |
| 现有 BaseAgent 骨架适配 | 可行 | 采用 Codex Runner 结构，每 Runner 私有后端 |
| 基础对话 | 有条件可行 | 需 SSE → `AgentEvent` 状态机 |
| 文本/图片输入 | 有条件可行 | 图片模型能力和 data URL 需 PoC |
| 文件/视频/语音 | 沿用现有能力 | 文件路径或 transcript 进入 prompt，不扩 Runner 参数 |
| 完整消息输出 | 可行 | 只输出十种 `AgentEvent`，由现有出站链处理 |
| 四种权限模式 | 有条件可行 | ruleset + PermissionGateway + 安全层 |
| Question | API 可用 | InteractionRouter 桥完成前 capability=false |
| Todo/reasoning/retry | 可映射 | 分别转 task_progress/status/status |
| Session 持久化 | 已验证基础能力 | 恢复时必须校验 project |
| 中断 | API 可用 | 需 prompt/abort 竞态测试 |
| 模型切换 | API 可用 | provider/model 和 variant 适配 |
| Token/费用 | 可映射 | 需验证 cost 语义 |
| Compact | API 可用 | capability 暂不开放 |
| Fork | 已验证基础调用 | capability 暂不开放 |
| File rewind | 有实现基础 | 语义未兼容，首版 unsupported |
| 多 EvolAgent 隔离 | 有明确实现路径 | 每 Runner 独立 server/client/动态端口 |
| Runner 内多 session | 有明确实现路径 | sessionID + project 路由和去重 |
| `runtimeEnv` | 有实现路径 | 需证明 hook 隔离和清理 |

## 十一、PoC 验收门槛

1. 两个 EvolAgent 各自创建独立 `OpencodeRunner`、server/client 和内部端口，无配置或事件串扰。
2. 每个 Runner 同时运行两个 session，text、reasoning、todo、tool success/error、retry、session error 和 idle 全部转换为合法 `AgentEvent`。
3. 文本、图片、文件路径、视频路径、语音 transcript、引用/批次/trigger 按既有 `runQuery()` 参数进入。
4. 四种公开模式逐项验证；`bypass` 的危险命令和显式扩权仍审批；`readonly/auto` 禁区不可人工放行。
5. permission request 路由到正确 owner，只回复 `once/reject`；缺少任一安全上下文时 deny。
6. question bridge 的卡片、文本 fallback、operator 身份、回复、拒绝、超时和中断全部正确后，才开放 capability。
7. 新消息中断与 prompt/turn 建立竞态不误杀其他 session。
8. compact、fork、跨进程恢复和项目目录不匹配保护通过后，再开放对应 capability。
9. `runtimeEnv` 只注入目标 turn，结束后清除，日志和 session 记录无 token。
10. SIGTERM 和错误路径后所有 Runner 的 SSE 和 OpenCode 子进程全部退出。

## 最终判断

OpenCode 集成在技术上**可行，但必须按 EvolClaw 现有 BaseAgent 骨架实现**。最佳方案是 Codex Runner 式的“每 Runner 私有、惰性启动的常驻后端”，而不是进程级共享 Manager。协议事件、四模式权限、question 交互和生命周期仍需 PoC；在这些验收完成前，不应宣称核心功能 100% 或直接排期生产发布。
