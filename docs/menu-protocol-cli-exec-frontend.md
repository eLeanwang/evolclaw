# Menu Protocol — CLI 透传（`name=cli`）前端集成指南

> 本文是 EvolClaw `menu.action name=cli` CLI 透传能力的集成文档，面向前端开发者（App / Web / Bot）。
> 它是 [Menu Protocol 主文档](./aun-menu-protocol-dev-guide-v2(1).md) 的补充——传输层、`menu.response` 配对、错误处理等通用机制以主文档为准，本文只讲 CLI 透传专有部分。

最后更新：2026-06-02
对应代码：`src/types.ts` · `src/core/message/message-bridge.ts` · `src/core/command-handler.ts`

---

## 1. 这是什么

让前端**程序化执行后端 evolclaw 的 CLI 命令并取回结果**——不经过聊天会话页面、不经过菜单选项交互。

一次请求 = 一条命令，daemon 在子进程里跑 `evolclaw <argv>`，把 `stdout` / `stderr` / `exitCode` 结构化回传。前端用 `menu.response` 的 `id` 配对，跟其他 menu 请求一样。

> ⚠️ **本质是经消息通道的远程命令执行（RCE）**。因此服务端强制 **owner-only + 命令白名单 + 无 shell + 超时/截断**四道护栏，详见 §5。

---

## 2. 请求格式

`menu.action`，固定 `name: "cli"`、`action: "exec"`。命令通过 `args` 传，两种写法二选一：

### 2.1 argv 数组（推荐，无注入风险）

```jsonc
{
  "type": "menu.action",
  "id": "c-001",
  "name": "cli",
  "action": "exec",
  "args": { "argv": ["model", "list", "--format", "json"] }
}
```

### 2.2 command 字符串（退化路径）

```jsonc
{
  "type": "menu.action",
  "id": "c-002",
  "name": "cli",
  "action": "exec",
  "args": { "command": "model list --format json" }
}
```

字符串由 daemon 侧分词，**尊重单/双引号**，不走 shell。例如 `agent set bot.agentid.pub active_baseagent codex` 会正确切成 4 个 token。

**两者同时给时 `argv` 优先。** 能用 `argv` 就别用 `command`——数组无需分词、无歧义。命令行里带空格/特殊字符的参数（路径、名称）尤其应该用 `argv`。

> 不要把命令前缀写成 `evolclaw` 或 `ec`。`argv[0]` 直接是子命令名，如 `model` / `status` / `agent`。

---

## 3. 成功响应

```jsonc
{
  "type": "menu.response",
  "id": "c-001",
  "name": "cli",
  "data": {
    "exitCode": 0,           // CLI 进程退出码，0 = 成功
    "stdout": "{ ...JSON... }",
    "stderr": "",
    "truncated": false,      // true = 输出超 128KB 被截断
    "durationMs": 320
  }
}
```

关键点：

- **`exitCode` 才是命令成败的判据**，不是 `menu.response` 有没有 `data`。只要命令被允许执行并跑完（哪怕它自己报错 exit 1），都会带 `data` 返回，错误信息在 `stderr` 里。
- **`menu.response.error` 只代表透传层拒绝**（权限/白名单/超时），命令根本没跑或被中断。
- 想要结构化输出，**给 CLI 命令加 `--format json`**——大多数子命令支持，`stdout` 直接 `JSON.parse`。
- `truncated: true` 时 `stdout`/`stderr` 已被切到上限，需要完整输出就缩小命令范围。

---

## 4. 可执行命令白名单

只放**只读 + 配置类**命令。破坏性 / 进程控制 / 数据面命令一律拒绝。

| `argv[0]` | 允许的子命令 | 说明 |
|---|---|---|
| `status` | 全部 | 服务状态 |
| `model` | 全部 | `list` / `current` / `info`（读）、`use` / `effort` / `reset`（多作用域配置） |
| `agent` | `list` `show` `get` | 只读；`new`/`delete`/`enable`/`disable`/`rename`/`reload`/`set` 被拒 |
| `aid` | `list` `show` `lookup` | 只读；`new`/`delete`/`agentmd` 被拒 |
| `storage` | `ls` `quota` | 只读；`upload`/`download`/`rm` 被拒 |

**明确不可用**（返回 `NOT_ALLOWED`）：`restart` `stop` `start` `init` `dev` `mv` `rpc` `msg` `group` `net`，以及上表各命令的写操作子命令。

> 发消息 / 群发属于**数据面**，应直接用 AUN 的 `message.send` / `group.*`，不要试图通过 CLI 透传绕路。

> 💡 下面每条命令都建议带 `--format json`，`stdout` 即为可 `JSON.parse` 的结构。不带 `--format json` 时输出是给人看的中文文本，前端别去解析。
> 命令自身的失败（如模型不存在）走 `data.exitCode != 0`，且 `stdout` 里是 `{ "ok": false, "code": "...", "error": "..." }`——注意这与透传层的 `menu.response.error` 是**两回事**（见 §3、§5）。

---

## 4A. `model` — 模型管理（重点）

`model` 是 CLI 透传里最常用的命令，**全部子命令放行**。它管理的是**多作用域**模型配置，与对话内 `/model` slash（仅改运行时）不同。

### 作用域：由参数隐式决定（越具体越优先：关系 > agent > 全局）

| 参数 | 作用域 | 写入位置 |
|---|---|---|
| 无 | 全局 | `defaults.json` |
| `--self <aid>` | agent 级 | 该 agent 的 `config.json` |
| `--self <aid> --peer <X>` | 关系级 | `relations/<peerKey>/preferences.json` |

- `--peer` 必须和 `--self` 一起给，否则 `PEER_WITHOUT_SELF`。
- `--peer` 接受 `channelType#channelId` 或裸 aid（裸 aid 视为 `aun#<aid>`）。
- 改某作用域后，**该范围所有会话的下一条消息即时生效**。

### 子命令一览

| 子命令 | argv 示例 | 作用 |
|---|---|---|
| `list` | `["model","list","--format","json"]` | 列可用模型 + 各作用域命中标注 |
| `current` | `["model","current","--format","json"]` | 按优先级解析后**实际生效**的模型 + 来源链 |
| `info` | `["model","info","opus","--format","json"]` | 单模型详情（厂商/上下文/价格/模态/effort） |
| `use` | `["model","use","opus","--format","json"]` | 设置模型（作用域由 `--self`/`--peer` 决定） |
| `effort` | `["model","effort","high","--format","json"]` | 设置推理强度（low/medium/high/xhigh/max/auto） |
| `reset` | `["model","reset","--self","bot.agentid.pub","--format","json"]` | 清除指定作用域设置，回落上一级 |

### `model list` — 列出可用模型 + 作用域命中

```jsonc
// → args.argv
["model", "list", "--format", "json"]
// 加作用域：["model","list","--self","bot.agentid.pub","--peer","alice.agentid.pub","--format","json"]

// ← data.stdout（JSON.parse 后）
{
  "ok": true,
  "effective": { "model": "opus", "source": "global" },  // 当前实际生效 + 来源作用域
  "scopes": {                                              // 各可达作用域的当前值
    "global":   { "model": "opus" },
    "agent":    { "model": "sonnet", "effort": "high" },  // 仅 --self 时出现
    "relation": { "model": "deepseek-v4-pro" }            // 仅 --self+--peer 时出现
  },
  "catalogSource": "remote",                               // "remote" | "mock"
  "models": [ { "id": "opus", ... }, { "id": "sonnet", ... } ]
}
```

### `model current` — 实际生效模型 + 解析链

```jsonc
// → ["model","current","--self","bot.agentid.pub","--peer","alice.agentid.pub","--format","json"]
// ← data.stdout
{
  "ok": true,
  "model": "deepseek-v4-pro",
  "effort": "high",
  "source": "relation",        // 命中的作用域；null = 未设置，回落 SDK 默认
  "chain": [                   // 解析顺序，hit 标命中点
    { "scope": "relation", "model": "deepseek-v4-pro", "hit": true },
    { "scope": "agent",    "model": "sonnet",          "hit": false },
    { "scope": "global",   "model": "opus",            "hit": false }
  ]
}
```

### `model info <id>` — 单模型详情

```jsonc
// → ["model","info","opus","--format","json"]
// ← data.stdout
{
  "ok": true,
  "id": "opus",
  "owned_by": "anthropic",
  "context_window": 200000,
  "max_output_tokens": 64000,
  "pricing": { "input_per_mtok": 15, "output_per_mtok": 75 },  // mock 目录时为 null
  "modalities": ["text", "image"],
  "supports_effort": true,
  "status": "available",
  "mocked": false
}
```

### `model use` / `effort` / `reset` — 写入（按作用域）

```jsonc
// 全局设模型：["model","use","opus","--format","json"]
// agent 级：  ["model","use","opus","--self","bot.agentid.pub","--format","json"]
// 关系级：    ["model","use","deepseek-v4-pro","--self","bot.agentid.pub","--peer","alice.agentid.pub","--format","json"]
// use 时顺带设强度：追加 "--effort","high"

// ← data.stdout（use/effort/reset 同结构）
{ "ok": true, "scope": "relation", "self": "bot.agentid.pub",
  "peerKey": "aun#alice.agentid.pub", "model": "deepseek-v4-pro", "effort": "high" }

// effort：["model","effort","high","--self","bot.agentid.pub","--format","json"]
// reset： ["model","reset","--self","bot.agentid.pub","--peer","alice.agentid.pub","--format","json"]
```

### model 命令级错误（在 `stdout`，非透传层 error）

模型不存在、作用域参数非法等，命令自身 `exitCode=1`，`stdout` 为：

```jsonc
{ "ok": false, "code": "UNKNOWN_MODEL", "error": "模型不在目录中: gpt-9（model list 查看可用模型）" }
```

常见 `code`：`UNKNOWN_MODEL`（模型不在目录）、`PEER_WITHOUT_SELF`（给了 `--peer` 没给 `--self`）、`INVALID_EFFORT`（强度非法）、`MISSING_MODEL_ID`（`use`/`info` 缺模型 id）。

---

## 4B. `agent` — EvolAgent 管理（只读子集）

仅 `list` / `show` / `get` 放行（增删改/启停被拒）。

| 子命令 | argv 示例 | 输出 |
|---|---|---|
| `list` | `["agent","list","--format","json"]` | 全部 agent 概览 |
| `show` | `["agent","show","bot.agentid.pub","--format","json"]` | 单 agent 详情（身份/配置/连接/会话/路径） |
| `get` | `["agent","get","bot.agentid.pub","active_baseagent","--format","json"]` | 读单个配置字段，`key` 支持点路径如 `channels.aun.enabled` |

```jsonc
// agent list ← data.stdout
{ "ok": true, "agents": [
  { "name": "bot", "aid": "bot.agentid.pub", "status": "running",
    "channels": ["aun"], "projectPath": "/home/u/proj", "baseagent": "claude" }
]}

// agent get ← data.stdout
{ "ok": true, "value": "claude" }   // value 可能是字符串/对象（对象=点路径命中子树）

// 失败（agent 不存在等）：exitCode=1，stdout = { "ok": false, "error": "..." }
```

---

## 4C. `aid` — 身份管理（只读子集）

仅 `list` / `show` / `lookup` 放行（`new` / `delete` / `agentmd` 被拒）。

| 子命令 | argv 示例 | 输出 |
|---|---|---|
| `list` | `["aid","list","--format","json"]` | 本地 AID 列表（含 sign/verify 自检）。可加 `--mine`/`--broken`/`--peer-cert`/`--no-verify` |
| `show` | `["aid","show","bot.agentid.pub","--format","json"]` | 单 AID 详情：私钥/证书/agent.md 状态 |
| `lookup` | `["aid","lookup","alice.agentid.pub","--format","json"]` | 远程探测：是否注册 + 网关 + agent.md（**有网络开销，注意 15s 超时**） |

```jsonc
// aid list ← data.stdout（数组）
[ { "aid": "bot.agentid.pub", "category": "mine", "hasPrivateKey": true,
    "signVerified": true, "hasCert": true, "certExpired": false, "hasAgentMd": true } ]

// aid lookup ← data.stdout
{ "exists": true, "gateway": "https://...", "content": "---\nname: Alice\n...---\n..." }
{ "exists": false, "gateway": "https://...", "error": "not registered" }
```

---

## 4D. `storage` — 文件存储（只读子集）

仅 `ls` / `quota` 放行（`upload` / `download` / `rm` 被拒）。两者都需要 `<aid>` 作为第二参数。

| 子命令 | argv 示例 | 输出 |
|---|---|---|
| `ls` | `["storage","ls","bot.agentid.pub","notes/"]` | 列对象；prefix 可省。**注意：`ls` 不支持 `--format json`，stdout 直接是 JSON 数组文本** |
| `quota` | `["storage","quota","bot.agentid.pub"]` | 配额信息，stdout 是 JSON 文本 |

```jsonc
// storage ls ← data.stdout（直接是 JSON 数组，或字符串 "(空)"）
[ { "key": "notes/doc.txt", "size": 1234, "lastModified": "..." } ]

// storage quota ← data.stdout
{ "used": 10485760, "limit": 1073741824, "objectCount": 42 }
```

> `storage` 的只读子命令不走 `--format` 开关，输出本身就是 JSON（`ls` 空目录时是字面量 `(空)`，需容错）。其余命令统一推荐 `--format json`。

---

## 5. 错误响应

```jsonc
{ "type": "menu.response", "id": "c-001", "name": "cli",
  "error": { "code": "NOT_ALLOWED", "message": "命令不在白名单: restart" } }
```

| code | 触发场景 | 前端处理建议 |
|---|---|---|
| `NO_PERMISSION` | 调用方不是 owner | 隐藏入口；非 owner 不该看到 CLI 透传 |
| `NOT_ALLOWED` | 命令或子命令不在白名单 | 开发期排查；不要给用户开放任意命令输入 |
| `MISSING_VALUE` | 既无 `argv` 也无 `command`，或为空 | 协议层错误，检查请求构造 |
| `NOT_SUPPORTED` | `action` 不是 `exec` | 协议层错误 |
| `TIMEOUT` | 执行超过 15 秒，子进程已被强杀 | 提示超时；考虑命令是否本就耗时 |
| `INTERNAL` | spawn 失败等运行时异常 | 上报 |

注意 `NO_PERMISSION` / `NOT_ALLOWED` / `MISSING_VALUE` / `NOT_SUPPORTED` 在命令**未执行**时返回；命令执行了但自身失败 → 走成功响应的 `exitCode != 0`。

---

## 6. 护栏参数（前端需知）

| 护栏 | 值 | 影响 |
|---|---|---|
| 权限 | **owner-only** | 非 owner 直接 `NO_PERMISSION` |
| 命令范围 | **白名单**（§4） | 白名单外 `NOT_ALLOWED` |
| 执行超时 | **15 秒** | 超时 `TIMEOUT`，子进程被 SIGKILL |
| 输出上限 | **stdout+stderr 合计 128KB** | 超出 `truncated: true` |
| 注入面 | argv 数组传参，**无 shell** | 无命令注入风险 |

前端据此：给可能慢的命令留足超时 UI；对 `truncated` 输出做"结果过长"提示；owner 判定由服务端 `resolveIdentity()` 决定，前端无需自行计算，但应避免给非 owner 暴露入口。

---

## 7. 传输层

与所有 menu 消息一致，走 AUN `message.send`，payload 是 JSON 字符串，`id` 配对响应。完整收发样例见主文档 §12。

```typescript
await client.call('message.send', {
  to: targetAid,
  payload: JSON.stringify({
    type: 'menu.action', id: 'c-001',
    name: 'cli', action: 'exec',
    args: { argv: ['model', 'list', '--format', 'json'] },
  }),
  encrypt: true,
});
// 响应在 onMessage 里按 parsed.id 配对，parsed.data / parsed.error 二选一
```

`menu.action` 已在服务端 `MENU_REQUEST_TYPES` 白名单内，CLI 透传**不需要**前端或服务端改动传输层。当前仅 AUN 通道承载 Menu Protocol。

---

## 8. 速查卡

```
请求
  menu.action name=cli action=exec args={ argv:[...] | command:"..." }

响应（成功 = 命令跑完）
  data = { exitCode, stdout, stderr, truncated, durationMs }
  → exitCode===0 判成功；--format json 时 JSON.parse(stdout)

响应（失败 = 透传层拒绝，命令没跑）
  error = { code, message }
  code ∈ NO_PERMISSION | NOT_ALLOWED | MISSING_VALUE | NOT_SUPPORTED | TIMEOUT | INTERNAL

白名单
  status  *                       服务状态
  model   *                       模型查看/多作用域配置
  agent   list show get           agent 只读
  aid     list show lookup        AID 只读
  storage ls quota                存储只读

护栏  owner-only · 15s 超时 · 128KB 截断 · 无 shell
```
