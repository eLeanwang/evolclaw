# 可点击文件链接 + 缓存校验设计

> 状态：服务端已实现（2026-06-10）。`menu name=file`（query + action:fetch）落地于 `src/core/command/menu-handler.ts`，白名单 + 名称映射于 `src/core/message/message-bridge.ts`。配套实现命令见 `docs/file-command.md`、菜单协议见 `docs/aun-menu-protocol-dev-guide-v2.2.md`。客户端（Evol App/Web）缓存接线为待实现项。

## 1. 目标

聊天里 agent 输出的文件引用（如 `docs/codex-runner-decisions.md`、`/home/evolclaw/TODO.md`）在客户端（Evol App / Web / CLI）渲染为**可点击链接**。点击行为：

- 本地无缓存 → 通过 `/file` 拉取文件，落盘后打开。
- 本地已有同一文件缓存 → 先查服务端文件元信息，与本地比对；服务端更新了才重新下载，否则直接打开本地缓存。

目的：避免重复传输大文件，点击即开。

## 2. 传输模型：menu 协议 + /file（不走 HTTP）

文件链接**不经 HTTP**，复用现有两条通道的组合：

| 阶段 | 通道 | 作用 | 是否传文件 |
|---|---|---|---|
| ① 元信息校验 | `menu.query name=file` | 取服务端 `{ sha256, size, mtime }` | 否，轻量 |
| ② 拉取 | `menu.action name=file action=fetch`（内部走 `/file` 路径） | 通过渠道把文件作为 `result.file → sendFile` 消息发回 | 是 |

阶段①只在「本地已有缓存」时发生；无缓存时直接走阶段②。

### 2.1 实际投递路径（参考 aun.ts 现有 /file 实现）

`/file` 在 AUN 上的真实收发链（设计据此对齐，不另造）：

**发送方**（`slash-handler.ts` → `adapter.send({kind:'result.file'})` → `aun.ts:3018` → `sendFile`）：
1. `storage.put_object`（小文件）或 `create_upload_session` + HTTP PUT + `complete_upload`（大文件）上传到 AUN 存储。
2. `message.send`（私聊）/ `group.send`（群）发出 `{ type:'file', text:'📎 …', attachments:[{ owner_aid, object_key, filename, size_bytes, sha256, content_type }] }`。

**接收方**（`aun.ts:1095+`）：
1. 从 attachment 取 `owner_aid` + `object_key`，调 `storage.create_download_ticket` 换取**受信任**的 `download_url`（**不信任** `att.url`，防 SSRF）。
2. 下载后用 `att.sha256` 校验内容完整性。

→ 客户端在第 1 步就拿到了 `size_bytes` + `sha256`，缓存比对直接复用，无需 mtime。

## 3. 客户端缓存 Key

### 3.1 解析为绝对路径

- 链接是**相对路径** → `abspath = join(pwd, relpath)`，`pwd` 由 `menu.query name=pwd` 获取（按目标 AID + 会话）。
- 链接已是**绝对路径** → 直接用，无需拼装。

### 3.2 归一化

把 `abspath` 归一化为缓存 key，要求：

- **大小写不敏感**：`Docs/X.md` 与 `docs/x.md` 命中同一 key。
- **中英文可比对**：Unicode 先做 `NFC` 归一化，避免组合字符（如带声调拼音、繁简兼容字）产生不同字节序列却是同一路径。
- 路径分隔符统一为 `/`。

```
key = nfc(abspath).toLowerCase().replace(/\\/g, '/')
```

> ⚠️ 大小写折叠仅用于 **cache key 去重**，真实下载/打开仍用原始 `abspath`（Linux 文件系统区分大小写）。

### 3.3 缓存条目

```jsonc
key → {
  abspath,            // 原始绝对路径（打开用）
  localPath,          // 本地落盘路径
  sha256,             // 上次下载文件的内容哈希（来自 attachment，权威）
  size,               // 上次下载的 size_bytes（来自 attachment）
  serverMtime?,       // 可选：上次下载时服务端文件 mtimeMs（同源比对用，非本地接收时间）
}
```

> **关键：`sha256` 和 `size` 不需要额外请求**——AUN 文件消息的 attachment 本来就带
> `{ sha256, size_bytes }`（`aun.ts:2558-2565`），客户端收到文件即同时拿到内容哈希。
> 所以缓存比对天然可用内容哈希，无需把 mtime 当主信号。

## 4. 点击流程

```
click(linkPath)
  │
  ├─ resolve abspath        // 相对→join(pwd,rel)；绝对→原样
  ├─ key = normalize(abspath)
  │
  ├─ cache.has(key)?
  │     │
  │     ├─ 否 ─→ fetch(path) ─→ cache.put(key,{mtime,size,localPath}) ─→ open(localPath)
  │     │
  │     └─ 是 ─→ menu.query name=file {path}      // 取服务端 sha256/size/mtime
  │                 │
  │                 ├─ 服务端更新？                 // sha256 优先；无 hash 时回退 size+mtime
  │                 │     ├─ 是 ─→ fetch(path) ─→ cache.update ─→ open(localPath)
  │                 │     └─ 否 ─→ open(localPath)  // 直接开本地，不传输
  │                 │
  │                 └─ NOT_FOUND（服务端已删）─→ 清缓存 + 提示
```

**「服务端更新」判定**（按可靠性排序）：

1. 双方都有 `sha256`（缓存里存的是上次下载 attachment 的 sha256，query 返回的是当前文件 sha256）→ **直接比 hash**，不同即更新。这是首选，因为同源、内容级、无时钟问题。
2. 仅在 query 未返回 sha256（如大文件跳过哈希，见 §7 决策 2）时回退：`server.size != cached.size` → 更新。
3. size 也相等时，再比 mtime 兜底（见下方说明）。

> ⚠️ **mtime 比对的正确姿势**（回应「按文件接收时间肯定和远端不一致」）：
> 比对**绝不用本地文件的 mtime**——本地 mtime 是接收/落盘时间，必然与远端不同。
> 缓存里存的 `serverMtime` 是**上次下载时服务端 `fs.statSync().mtimeMs` 的快照**，
> query 返回的也是服务端当前 `statSync().mtimeMs`。二者**同源**（都是服务端文件系统的 mtime），
> 才可比较。本地文件时间戳从不参与比对。
> 即便如此，mtime 仍受服务端时钟漂移/`git checkout` 重写影响，故仅作 sha256/size 之后的末位兜底。

## 5. 服务端：新增 menu `name=file`

在 `docs/aun-menu-protocol-dev-guide-v2.2.md` 的 name 能力矩阵中新增一行：

| name | list | query | options | update | action | 作用层级 | 鉴权 |
|---|:---:|:---:|:---:|:---:|:---:|---|---|
| `file` | — | ✅ | — | — | `fetch` | 会话级 | agent owner/admin 或 aid channel owner（见 §6） |

### 5.1 query — 文件元信息

```jsonc
// →
{ "type": "menu.query", "id": "q-f1", "name": "file",
  "args": { "path": "docs/codex-runner-decisions.md" } }

// ← 成功
{ "type": "menu.response", "id": "q-f1", "name": "file",
  "data": { "path": "docs/codex-runner-decisions.md",
            "sha256": "ab12…", "size": 4096, "mtime": 1717900000000 } }

// ← 文件不存在
{ "error": { "code": "NOT_FOUND", "message": "文件不存在" } }

// ← 无权限
{ "error": { "code": "NO_PERMISSION", "message": "无权限" } }
```

- `path` 接受相对路径或**项目内绝对路径**（见 §6）。
- `size` = `stat.size`；`mtime` = `fs.statSync().mtimeMs`（服务端快照，客户端只与上次 query 的同源 mtime 比，见 §4）。
- `sha256` 是首选比对字段，与 attachment 的 `sha256` 同算法（`createHash('sha256')`）。**≤ 2 MB 计算；超过返回 `null`**，客户端回退 size+mtime（§4、§7 决策 2）。

### 5.2 action: fetch — 拉取文件

```jsonc
// →
{ "type": "menu.action", "id": "a-f1", "name": "file", "action": "fetch",
  "args": { "path": "docs/codex-runner-decisions.md" } }

// ← 成功（文件作为独立 result.file 消息异步发回）
{ "type": "menu.response", "id": "a-f1", "name": "file",
  "data": { "action": "fetch", "success": true, "size": 4096 } }
```

内部等价于 `/file <path>`：复用 `slash-handler.ts` 现有路径校验 + `adapter.send(..., { kind: 'result.file', filePath })` → `aun.ts` `sendFile`（上传存储 + `message.send` attachment）。
相比文本 `/file`，结构化 args 免去飞书 Markdown 链接还原、含空格路径分词等坑。

## 6. 安全与权限

### 6.1 路径校验（沿用 /file）

`menu file` 的 query/fetch 复用 `slash-handler.ts` `/file` 的校验链：

- 拒绝 `..` 路径穿越。
- `realpathSync` 后验证落点。
- fetch 文件大小上限 10 MB；query 无大小限制（只 stat / 算 hash）。

### 6.2 绝对路径支持（决策 1）

聊天里的链接常是绝对路径，故 `menu file` **接受项目内绝对路径**（区别于文本 `/file` 仍拒绝绝对路径，保持向后兼容）。判定流程：

```
realPath = realpathSync(input)            // input 可为相对或绝对
  │
  ├─ realPath 在 session.projectPath 内？
  │     ├─ 是 ─→ 放行（与现有 /file 项目内语义一致）
  │     └─ 否 ─→ 判定请求者是否为 aid channel 的 owner
  │                 ├─ 是 ─→ 放行传输（owner 可取项目外文件）
  │                 └─ 否 ─→ 拒绝 NO_PERMISSION
```

即：**项目内**文件按常规权限（§6.3）放行；**项目外**文件仅 aid channel owner 可取。

### 6.3 操作权限（决策 4）

`file` 的 query/fetch 允许：**agent 的 owner / admin**，以及 **aid channel 的 owner**。
（不再是文本 `/file` 的 owner-only。）鉴权走 `resolveIdentity()` 的 channel 角色；aid channel owner 判定用于 §6.2 项目外放行那一支。

## 7. 待决策

1. ~~绝对路径支持~~ → **已定**（§6.2）：menu file 接受项目内绝对路径；项目外仅 aid channel owner 可取；文本 `/file` 不变。
2. ~~hash 阈值~~ → **已定**：query 的 `sha256` 对 **≤ 2 MB** 文件计算；超过返回 `sha256: null`，客户端自动降级到 size + mtime 比对（§4）。
3. ~~文件到达与点击的关联~~ → **已定 + 已落地**（见 §7.1）。
4. ~~权限~~  **已定**（§6.3）：agent owner/admin + aid channel owner。

四项决策已全部收敛，本文档进入**实现就绪**状态。

### 7.1 correlation 链路（已实现）

`fetch` 的文件作为独立 `file` 入站消息异步到达，靠 `correlationId` 与点击对账。已打通的端到端链路：

| 环节 | 位置 | 字段 |
|---|---|---|
| 类型 | `src/types.ts` `OutboundPayload` | `result.file` 新增可选 `correlationId` |
| AUN 出站分发 | `src/channels/aun.ts` `result.file` case | 有 `payload.correlationId` 时注入 `replyCtx.metadata.correlationId` |
| 文件消息封装 | `src/channels/aun.ts` `sendFile` | `context.metadata.correlationId` → file payload 顶层 `correlation_id`（与既有 `task_id`/`thread_id`/`chatmode` 同模式） |
| 客户端对账 | 收到的 `{type:'file'}` 消息 | 读 `correlation_id` 配对发起的点击请求 `id` |

**已实现**：`menu.action name=file action=fetch` handler 把请求的 `id` 作为 `correlationId` 透传到 `result.file` payload（`menu-handler.ts` → `execMenuAction` 新增 `requestId` 形参，由 message-bridge `handleMenuAction` 用 `req.id` 注入）。其它渠道（feishu/wecom/wechat/qqbot/dingtalk）的 `result.file` 暂未透传 `correlationId`，按需再加。

## 8. 与现有文档的关系

- 扩展 `docs/file-command.md`（`/file` 命令规格）。
- 在 `docs/aun-menu-protocol-dev-guide-v2.2.md` 新增 `name=file`（query + action:fetch），并同步 `src/channels/aun.ts` 的 `MENU_REQUEST_TYPES` 白名单与 message-bridge 分发器（见该文档 §12 维护提示）。
