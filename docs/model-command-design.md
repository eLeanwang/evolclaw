# `model` CLI 命令集设计

> 状态：设计定稿 v2.0（已实现）
> 关联：`agent-command-design.md`、`msg-command-design.md`、`cli-reference.md`
> 定位：面向 **agent 使用** 的模型管理命令集。与对话内 slash 命令（`/model` `/setmodel` `/effort` `/baseagent`）**互不影响**，本命令集不修改它们。

## 1. 目标

给 agent 一组 CLI 命令，用来：

- 查看代理（`{baseUrl}/v1/models`）支持哪些模型
- 查看当前实际生效的模型及其来源
- 查看单个模型的详情（价格 / 上下文长度 / 模态 / 是否支持 effort 等）
- 在 **全局 / agent级 / 关系级** 三个作用域切换模型与推理强度

机制全面对齐 `agent` / `aid` 命令集：

- 支持 `--format json`
- 任意位置支持 `help` / `--help` / `-h`
- 不带子命令时输出帮助

## 2. 三级作用域

| 作用域 | 存储位置 | 语义 |
|--------|---------|------|
| **全局** | `agents/defaults.json` → `baseagents.<ba>.{model,effort}` | 所有 agent 的兜底默认 |
| **agent级** | `agents/<self>/config.json` → `baseagents.<ba>.{model,effort}` | 单个 agent 的默认 |
| **关系级** | `agents/<self>/relations/<peerKey>/preferences.json` → `{model,effort}` | 该 agent 与某对端的模型 |

- `<ba>` = 当前活跃 baseagent（claude/codex/gemini），由 `active_baseagent` 决定。
- 关系级文件 **不按 baseagent 分键**，扁平存储。切换 baseagent 后若模型 ID 体系不匹配，由运行时校验并回落（见 §9）。
- 不再有会话级作用域：模型按对端解析，同一对端的所有会话共用同一模型。改关系级即影响该对端全部会话。

### 文件 schema

关系级 `preferences.json` 结构：

```json
{
  "model": "deepseek-v4-pro",
  "effort": "high",
  "updatedAt": 1780000000000
}
```

字段均可选：只设 model 不设 effort 时，effort 字段缺省。`reset` 删除对应字段或整文件（见 §6）。

## 3. 读取解析优先级

```
关系级  >  agent级  >  全局
```

三级全空 → **不传 model**（沿用现状：不读 `~/.claude/settings.json`、不使用硬编码默认）。effort 同理。

## 4. 生效语义（核心）

运行时（message-processor）**每条消息**按 `关系级 > agent级 > 全局` 解析出模型/强度，作为 per-call 入参直接传给 `runQuery`——不缓存、不绑会话 id。

因此：
- 改 **关系级** → 该 agent 与该对端的**所有会话**，下一条消息起即时生效。
- 改 **agent级** → 该 agent 的所有对端（未单独设关系级的），下一条消息起即时生效。
- 改 **全局** → 所有 agent（未设上层的），下一条消息起即时生效。
- 不存在"只影响新会话 / 需要重新 pin"的延迟——`/new` 产生新会话也照常按对端解析，与旧会话结果一致。

> 多对端并发：每条消息各自独立解析、各自把模型作为 `runQuery` 入参传入，runner 无共享可变状态（不再用 agent 级 `this.model` 承载当前模型），互不污染。

## 5. 子命令 × 作用域矩阵

读 = 读取该作用域用于解析/标注；写 = 写入该作用域；删 = 清除该作用域。

| 子命令 | 功能 | 全局 | agent级 | 关系级 |
|--------|------|:---:|:---:|:---:|
| `model`（无参） | 输出帮助 | — | — | — |
| `model list` | 列出 `{baseUrl}/v1/models` 全部可用模型 + 标注各级命中 | 读 | 读 | 读 |
| `model current` | 按 `关系>agent>全局` 解析**实际生效**模型 + 命中来源 | 读 | 读 | 读 |
| `model info <id>` | 单模型详情（厂商/上下文窗口/最大输出/输入输出价格/模态/支持effort/状态） | — | — | — |
| `model use <id>` | 设置模型，作用域由参数决定 | 写 | 写 | 写 |
| `model reset` | 清除指定作用域设置，回落上一级 | 删 | 删 | 删 |
| `model effort <level>` | 设置推理强度（low/medium/high/xhigh/max/auto），作用域同 use | 写 | 写 | 写 |

- `model info` 查的是模型目录（catalog），是全局共享的元数据，与"谁在用"无关，不涉及任何作用域。
- `list` / `current` 只读，从不写。

## 6. 参数 → 作用域映射（写命令通用）

| 参数组合 | 作用域 | 写入文件 |
|---------|--------|---------|
| （无） | 全局 | `defaults.json` |
| `--self <aid>` | agent级 | `config.json` |
| `--self <aid> --peer <X>` | 关系级 | `relations/<peerKey>/preferences.json` |

### 依赖约束

- `--peer` 必须配 `--self`（关系层既属 agent 又属对端）。单独 `--peer` → 报错 `PEER_WITHOUT_SELF`。

### `reset` 的回落

| 参数 | 清除 | 效果 |
|------|------|------|
| `--self --peer` | 删关系级 `preferences.json` 的 model/effort | 该对端所有会话回落到 agent级（下条消息生效） |
| `--self` | 删 `config.json` 的 `baseagents.<ba>.{model,effort}` | 该 agent 回落到全局 |
| （无） | 删 `defaults.json` 的 `baseagents.<ba>.{model,effort}` | 全部回落到"不传 model" |

## 7. `--peer` 归一化

`--peer <X>` 接受两种形态：

- `channelType#channelId`（如 `feishu#ou_xxx`、`aun#alice.aid.pub`）
- 裸 `aid`（如 `alice.aid.pub`）→ 归一为 `aun#alice.aid.pub`

内部统一为 `peerKey = <channelType>#<urlEncode(channelId)>`（与 `peer-key.ts` 的 `formatPeerKey` 一致）。群聊场景 `channelId = groupId`，所有发言者共用同一 peerKey（环境层不单独参与）。

> self / peer 一律由 agent 显式传入（`--self` / `--peer`），不做任何反查。selfAid 与 peerKey 在 private/group 模式下已由 ECK 注入到 agent 上下文（见 `identity.md` / `relation.md` fragment），agent 从上下文取值带上即可。

## 8. 模型目录来源

四级降级（前两级本地接口未实现时自动落到远端）：

- 1：`{baseUrl}/v1/models`（OpenAI list 格式）
- 2：`{baseUrl}/models`
- 3：远端目录接口 `https://mg-new.evolai.cn/claude-proxy/models`（临时，无需鉴权）
- 4：内置 mock catalog（远端也不可达时兜底）

`baseUrl` / `apiKey` 复用现有解析链（与发消息同源，命令本身不接收 url/key 参数）：

```
per-agent config.json  →  defaults.json  →  env(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)  →  ~/.claude/settings.json
```

各 baseagent 的稳定别名（claude 的 opus/sonnet/haiku）作为虚拟条目并入目录头部（`owned_by: alias`），保证 `defaults.json` 默认存的别名可选可校验。

### 列表格式解析（多网关兼容）

不同 AI 网关的 `/models` 返回格式不一，解析分两层（`parseModelList`）：

1. **网关专用 parser**（`GATEWAY_PARSERS` 注册表）：按 URL/响应结构匹配，处理特异格式。当前为空——ModelGate 是标准 OpenAI list 风格，通用解析已覆盖。接入异形网关时往注册表加一条 `{name, match, parse}` 即可，不动主流程。
2. **通用容错 parser**（`genericParse`）：
   - 容器：`json.data[]` | `json.models[]` | `json.data.models[]` | 裸数组
   - 条目：字符串 或 `{id|name|model, owned_by|owner|provider, created}`
   - 无 id 的脏条目跳过，空结果返回 `[]` 触发下一级降级

`model list` 输出标注目录来源：`[remote]`（远端）/ `[mock]`（兜底）/ 无标注（本地 baseUrl 接口）。`info` 的厂商字段对远端的网关标签 `ModelGate` 和 `alias` 一律按模型 ID 推断真实厂商（deepseek/moonshot/zhipu/minimax/anthropic 等）。

> 实：当前 `defaults.json` 未设 baseUrl，apiKey 为 `$ENV:` 占位，故实际落到 env 一级（本地代理 `http://127.0.0.1:12654/claude-proxy`）。本地代理仅代理 `/v1/messages`，`/models` 与 `/v1/models` 返回空 → 自动降级到远端目录接口（已能返回完整列表）。待本地 baseUrl 的目录接口就绪后，第 1/2 级自然命中，远端级不再触发。

### baseagent 与模型 ID 校验

关系级扁平存储模型 ID。当 `active_baseagent` 切换导致存储的模型 ID 不属于当前 baseagent 体系时，运行时**忽略该级并回落下一级**，并在 `model current` 输出中以告警标注（`stale: true`）。

## 10. 命令骨架（对齐 aid/agent）

```
evolclaw model                                          → 帮助
evolclaw model help | --help | -h                       → 帮助

evolclaw model list    [--self X] [--peer Y] [--format json]
evolclaw model current [--self X] [--peer Y] [--format json]
evolclaw model info    <model-id> [--format json]
evolclaw model use     <model-id> [--self X] [--peer Y] [--effort E]
evolclaw model reset             [--self X] [--peer Y]
evolclaw model effort  <level>   [--self X] [--peer Y]
```

全部子命令：任意位置 `help`/`--help`/`-h`、支持 `--format json`、无子命令输出帮助。

## 11. 输出格式与 JSON schema

### `model list`

文本：

```
当前生效: deepseek-v4-pro  (来源: 关系级)

可用模型 (16):
  ✓ deepseek-v4-pro       ★关系级
  ◆ claude-opus-4-7       ◆agent级
  ⬡ claude-sonnet-4-6     ⬡全局
    glm-5
    MiniMax-M2.7
    ...
```

图标：`✓`实际生效 `⬡`全局默认 `◆`agent级默认 `★`关系级。

JSON：

```json
{
  "ok": true,
  "effective": { "model": "deepseek-v4-pro", "source": "relation" },
  "scopes": {
    "global":   { "model": "claude-sonnet-4-6", "effort": null },
    "agent":    { "model": "claude-opus-4-7",   "effort": "high" },
    "relation": { "model": "deepseek-v4-pro",   "effort": "high" }
  },
  "models": [
    { "id": "deepseek-v4-pro", "owned_by": "deepseek", "created": 1704067200 }
  ]
}
```

未提供的作用域参数对应的 scope 为 `null`。

### `model current`

文本：

```
当前生效模型: deepseek-v4-pro
推理强度:     high
来源:         关系级
解析链:       关系级 ✓(deepseek-v4-pro) > agent级(claude-opus-4-7) > 全局(claude-sonnet-4-6)
```

JSON：

```json
{
  "ok": true,
  "model": "deepseek-v4-pro",
  "effort": "high",
  "source": "relation",
  "chain": [
    { "scope": "relation", "model": "deepseek-v4-pro", "hit": true },
    { "scope": "agent",    "model": "claude-opus-4-7", "hit": false },
    { "scope": "global",   "model": "claude-sonnet-4-6","hit": false }
  ]
}
```

### `model info <id>`（现 mock）

文本：

```
模型: deepseek-v4-pro
  厂商:       deepseek (via ModelGate)
  上下文窗口: 128000 tokens
  最大输出:   8192 tokens
  输入价格:   $0.27 / 1M tokens   (mock)
  输出价格:   $1.10 / 1M tokens   (mock)
  支持模态:   text                 (mock)
  推理强度:   不支持
  状态:       ✓ 可用
```

JSON：

```json
{
  "ok": true,
  "id": "deepseek-v4-pro",
  "owned_by": "deepseek",
  "context_window": 128000,
  "max_output_tokens": 8192,
  "pricing": { "input_per_mtok": 0.27, "output_per_mtok": 1.10, "currency": "USD" },
  "modalities": ["text"],
  "supports_effort": false,
  "status": "available",
  "mocked": true
}
```

`mocked: true` 标明数据来自 mock，接口接通后变 `false`。

### `model use` / `model effort` / `model reset`

文本：

```
✓ 已设置
  作用域: 关系级 (aun#alice.aid.pub) [self=bot.agentid.pub]
  模型:   deepseek-v4-pro
  生效:   该范围所有会话的下一条消息起生效。
```

JSON：

```json
{ "ok": true, "scope": "relation", "self": "bot.agentid.pub",
  "peerKey": "aun#alice.aid.pub", "model": "deepseek-v4-pro", "effort": null }
```

## 12. 错误码

| code | 含义 |
|------|------|
| `MISSING_MODEL_ID` | `use`/`info` 缺少模型 id |
| `UNKNOWN_MODEL` | 模型 id 不在 catalog 中 |
| `INVALID_EFFORT` | effort 不在 low/medium/high/xhigh/max/auto |
| `PEER_WITHOUT_SELF` | 给了 `--peer` 未给 `--self` |
| `INVALID_PEER` | `--peer` 无法解析为 channelType#channelId 或合法 aid |
| `AGENT_NOT_FOUND` | `--self` 指向的 agent 不存在 |
| `CATALOG_UNAVAILABLE` | 模型目录拉取失败且无 mock 兜底（一般不会触发） |

错误 JSON：`{ "ok": false, "error": "...", "code": "UNKNOWN_MODEL" }`。

## 13. 运行时配合点（CLI 之外）

1. **每条消息**：message-processor 按 `关系>agent>全局` 解析 model/effort（`resolveEffectiveModel({self, peerKey})`），作为 `runQuery` 的 `modelOverride` 入参传入。
2. **runner**：`runQuery(..., modelOverride)` 本次调用用 `modelOverride.model/effort`，缺省回落 `this.model`。无共享可变状态承载"当前模型"，多对端并发互不污染。
3. **压缩重试**：compact 后的 `runQuery` 重试同样带上 `modelOverride`，保持一致。
4. **baseagent 不匹配校验**：见 §9。

## 附录 A：模型可用性实测（原理验证）

通过 cc 实际调用方式（`claude -p --model <id>`，env 注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，仅改 `--model`）与 HTTP `POST /v1/messages` 两条路验证。结论：**切换模型只需改 model 字符串，baseUrl/key 不变**；cc 对 model ID 不做白名单，原样透传给代理。

| 模型 | 状态 |
|------|------|
| claude-opus-4-6 / 4-7 | ✅ 可用 |
| claude-sonnet-4-6 | ✅ 可用 |
| claude-haiku-4-5-20251001 | ✅ 可用 |
| deepseek-v4-pro / v4-flash | ✅ 可用 |
| kimi-k2.5 / k2.6 | ✅ 可用 |
| glm-5 / glm-5.1 / glm-4.7 | ✅ 可用 |
| MiniMax-M2.7 | ✅ 可用 |
| gpt-5.5 / gpt-5.4 / gpt-5.3-codex | ⚠️ 瞬时不可用（算力池切换中） |
| gemini-3-flash-preview / gemini-3.1-pro-preview | ❌ 代理后端 key 格式不符 |
| deepseek-v3.2 | ❌ 未配置定价 |

共 12 个稳定可用，横跨 claude / deepseek / kimi / glm / minimax 五个厂商系列。
