# 改造方案 2：AID 操作工具 + AUN RPC + Storage

## 目标与动机

把 AID 相关的操作从"散在 daemon、CLI、slash、init wizard 里"收敛成**独立的、命令行可调用的、agent 用 Bash 就能驱动的工具集**——目标是 agent 通过三套原子工具覆盖所有 AID / 网络 / 存储场景，不再需要专门工具封装也不需要走 daemon。

三套工具：

```
evolclaw aid <verb>          — 身份层（涉及私钥，不能用文件操作替代）
evolclaw rpc --as <aid> --params      — 网络层（AUN RPC，需要认证连接）
evolclaw storage <verb>      — 存储层（多步文件操作封装）
```

## 完整命令一览

| 命令 | 说明 | 私钥 | 网络 |
|---|---|:---:|:---:|
| **身份层** | | | |
| `evolclaw aid list` | 列本地所有 AID | ✗ | ✗ |
| `evolclaw aid show <aid>` | 查看本地 AID 详情（证书有效期、私钥、agent.md 状态） | ✗ | ✗ |
| `evolclaw aid new <aid>` | 创建 AID：keygen + 注册 + 写证书 + 同步 CA | ✓ | ✓ |
| `evolclaw aid delete <aid>` | 本地删除 AID（无网络注销） | ✗ | ✗ |
| `evolclaw aid lookup <aid>` | 远程探测：是否存在 + 网关地址 + 查看 agent.md 内容 | ✗ | ✓ |
| `evolclaw aid agentmd put <aid>` | 读本地 agent.md → 自动签名 → 上传 | ✓ | ✓ |
| `evolclaw aid agentmd get <aid>` | 下载 → 自动验签 → 本地持久化 | ✗ | ✓ |
| **网络层** | | | |
| `evolclaw rpc --as <aid> --params <params>` | 通用 AUN RPC 调用（单行 JSON=单次，多行 JSONL=批量，文件路径=从文件读取参数） | ✓ | ✓ |
| **存储层** | | | |
| `evolclaw storage upload <aid> <local-file> <remote-path> [--public]` | 上传文件（默认私有，`--public` 设为公开） | ✓ | ✓ |
| `evolclaw storage download <aid> <url> [local-path]` | 下载文件（`<url>` 格式：`[https://]<owner-aid>/<path>`） | ✓ | ✓ |
| `evolclaw storage ls <aid> [prefix]` | 列文件 | ✓ | ✓ |
| `evolclaw storage rm <aid> <remote-path>` | 删文件 | ✓ | ✓ |
| `evolclaw storage quota <aid>` | 查配额 | ✓ | ✓ |

所有命令支持 `--format json` 输出结构化数据。所有命令独立于 daemon 运行。

为什么独立成工具：

- AID 涉及私钥，不能让 agent 用 `Read/Write/Edit` 直接动 `~/.aun/<aid>/private/`——必须有签名/注册的封装。
- 但**不应该**让 agent 必须连上 daemon 才能管 AID——AID 是**身份层**资产，应当在 daemon 不在的时候也能创建/查询。
- agent.md 有完整的签名验签链（SDK 提供 `sign_agent_md` / `verify_agent_md` / `upload_agent_md` / `download_agent_md`），上传自动签名，下载自动验签。
- storage 的文件上传下载是多步流程（`create_upload_session` → HTTP PUT → `complete_upload`），需要封装成单条命令。
- 通用 RPC 覆盖所有协议方法，但需要支持批量调用以减少 agent 的来回次数。

不做：

- 不重写底层（继续复用 `@agentunion/fastaun` SDK + 现有 `aun-ops.ts`）。
- 不接管 daemon 内部的 AUN 通信（那是 channel 的事）。
- agent.md 的**编辑**不走工具——`Edit ~/.aun/AIDs/<aid>/agent.md` 就够了；工具只管"签名+上传"。

## 现状盘点

### 现有 AID 相关入口

| 现有入口 | 在哪 | 功能 |
|---|---|---|
| `evolclaw aid list` | cli.ts:1971 | 列本地 AID（本质是 ls 目录） |
| `evolclaw aid new <aid>` | cli.ts:1971 | 注册 AID + 写证书 + 同步 CA |
| `evolclaw agentmd <aid>` | cli.ts:2043 | 远程拉 agent.md |
| `evolclaw agentmd put <aid>` | cli.ts:2043 | 上传本地 agent.md |
| `evolclaw agentmd set <aid> <text>` | cli.ts:2043 | 直接设置并上传（参数过长易出错） |
| `evolclaw init aun` | utils/init-channel.ts | 交互式 wizard：创 AID + 配 channel + 配 owner |
| `/aid list` `/aid new` slash | command-handler.ts:1511 | 同 CLI，但走 daemon 内 |
| `/agentmd` slash | command-handler.ts:1564 | 同 CLI |
| `aun-ops.ts` 函数 | src/channels/aun-ops.ts | 底层实现（aidList、aidCreate、agentmdGet/Put、buildInitialAgentMd 等） |

底层实现已经齐了，缺的是**统一对外形态**。

### SDK 已有能力（关键修正）

| SDK 方法 | 说明 |
|---|---|
| `auth.create_aid()` | 注册新 AID |
| `auth.authenticate()` | 认证获取令牌 |
| `auth.renew_cert()` | 续期证书（**自动续期，无需暴露为工具**） |
| `auth.rekey()` | 密钥轮换（**危险操作，不暴露**） |
| `auth.sign_agent_md(content)` | 为 agent.md 生成尾部签名 |
| `auth.verify_agent_md(content, aid)` | 验证 agent.md 尾部签名 |
| `auth.upload_agent_md(content)` | 上传（自动复用 token） |
| `auth.download_agent_md(aid)` | 匿名下载 |
| `list_identities()` | 列本地身份 |
| `call(method, params)` | 通用 RPC 调用 |

### 本地 AID 目录结构

```
~/.aun/
├── CA/
│   └── root/root.crt
└── AIDs/
    └── <aid>/
        ├── private/         # 私钥（不能让 agent 直接读写）
        ├── public/          # 公钥/证书
        ├── agent.md         # 自我介绍（agent 可直接读写编辑）
        └── aun.db           # SDK 内部状态（消息缓存等）
```

## 工具形态

### 1. `evolclaw aid` — 身份管理

不依赖 daemon（独立进程，直接调 SDK 完成）。

#### 子命令一览

| Verb | 动作 | 私钥 | 网络 | SDK 方法 |
|---|---|:---:|:---:|---|
| `list` | 列本地 AID | ✗ | ✗ | `list_identities()` + 本地目录 |
| `show <aid>` | 查看本地 AID 详情（证书有效期、私钥状态、agent.md 状态） | ✗ | ✗ | 本地文件解析 |
| `new <aid>` | 创建：keygen + 注册 nameservice + 写证书 + 同步 CA root | ✓ | ✓ | `auth.create_aid()` |
| `delete <aid>` | 本地删除（无网络注销，AUN 协议不支持） | ✗ | ✗ | `rm -rf ~/.aun/AIDs/<aid>/` |
| `lookup <aid>` | 远程查 AID：是否存在 + 网关地址 + 查看 agent.md 内容 | ✗ | ✓ | `GET https://<aid>/` + gateway discovery |
| `agentmd put <aid>` | 读本地 agent.md → 自动签名 → 上传 | ✓ | ✓ | `sign_agent_md()` + `upload_agent_md()` |
| `agentmd get <aid>` | 下载 → 自动验签 → 验签失败输出警告 | ✗ | ✓ | `download_agent_md()` + `verify_agent_md()` |

**`show` vs `lookup` vs `agentmd get` 的区别**：

| | `show <aid>` | `lookup <aid>` | `agentmd get <aid>` |
|---|---|:---:|---|
| 数据源 | 本地 `~/.aun/AIDs/<aid>/` | 网络 `GET https://<aid>/` | 网络（SDK `download_agent_md`） |
| 网络 | ✗ | ✓ | ✓ |
| 验签 | ✗ | ✗ | ✓ |
| 本地持久化 | ✗ | ✗ | ✓（保存到本地） |
| 用途 | 看自己的 AID 本地状态 | 快速探测：AID 是否存在？内容是什么？ | 正式获取：下载 + 验签 + 持久化 |
| 类比 | `ls -la` 本地目录 | 看一眼名片 | 把名片存进通讯录并核实身份 |

`lookup` 实现：`GET https://<aid>/` + `GET https://<aid>/.well-known/aun-gateway`，无副作用的只读探测。三个作用：判断是否存在、得到网关地址、存在的话查看 agent.md 内容。

**lookup 成功（AID 已注册，HTTP 200）**：
```bash
$ evolclaw aid lookup toleiliang2.agentid.pub
✓ toleiliang2.agentid.pub 已注册
  网关: wss://gateway.agentid.pub:20001/aun

---
aid: "toleiliang2.agentid.pub"
name: "夙夜无偕1号"
type: "codeagent"
...
---

$ evolclaw aid lookup toleiliang2.agentid.pub --format json
{"exists": true, "aid": "toleiliang2.agentid.pub", "gateway": "wss://gateway.agentid.pub:20001/aun", "content": "---\naid: ..."}
```

**lookup 失败（AID 未注册，HTTP 404）**：
```bash
$ evolclaw aid lookup toleiliang8.agentid.pub
✗ toleiliang8.agentid.pub 未注册
  网关: wss://gateway.agentid.pub:20001/aun

$ evolclaw aid lookup toleiliang8.agentid.pub --format json
{"exists": false, "aid": "toleiliang8.agentid.pub", "gateway": "wss://gateway.agentid.pub:20001/aun", "error": "agent_md_not_found"}
```

**`agentmd get` 行为**：

- 下载 → 验签 → 持久化到本地
- 验签通过：正常输出内容 + 保存
- 验签失败（`status: invalid`）：输出内容 + stderr 打 warning + 仍然保存（但标记验签状态）
- 未签名（`status: unsigned`）：输出内容 + stderr 提示未签名 + 保存
- JSON 模式：`{"content": "...", "verification": {"status": "verified|invalid|unsigned", "reason": "..."}}`

**不做的**：

- ~~`revoke <aid>`~~ — AUN 协议无注销功能
- ~~`renew <aid>`~~ — SDK 自动续期，无需手动
- ~~`rekey <aid>`~~ — 危险操作，不暴露给 agent
- ~~`sign --purpose` 通用签名~~ — agent.md 有专用方法，不需要通用签名工具
- ~~`agentmd set <aid> <content>`~~ — 用 `Edit ~/.aun/AIDs/<aid>/agent.md` + `aid agentmd put <aid>` 替代
- ~~`agentmd sign / verify / diff`~~ — put 自动签名，get 自动验签，够用

### 2. `evolclaw rpc` — 通用 RPC

```bash
evolclaw rpc --as <aid> --params <params>
```

`--params` 自动判断三种输入形式：

| 输入形式 | 判断规则 | 行为 |
|---|---|---|
| 单行 JSON | 单行且以 `{` 开头 | 单次调用 |
| 多行 JSONL | 多行且每行以 `{` 开头 | 逐行执行，失败即停 |
| 文件路径 | 值对应一个存在的文件 | 读取文件内容作为 JSONL |

**单次调用**：
```bash
evolclaw rpc --as alice.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'
```

**批量调用**（多行，逐行执行直到失败）：
```bash
evolclaw rpc --as alice.agentid.pub --params '{"method":"storage.create_upload_session","params":{"object_key":"a.txt","content_type":"text/plain"}}
{"method":"storage.complete_upload","params":{"object_key":"a.txt","sha256":"abc..."}}'
```

**文件输入**：
```bash
evolclaw rpc --as alice.agentid.pub --params calls.jsonl
```

**输出**：

单次调用：
```json
{"ok": true, "result": {"upload_url": "https://...", "blob_key": "..."}}
```

批量调用（JSONL，每行对应一个结果）：
```jsonl
{"ok": true, "result": {"upload_url": "https://...", "blob_key": "..."}}
{"ok": true, "result": {"version": 1, "etag": "..."}}
```

失败时中止并输出错误：
```jsonl
{"ok": true, "result": {...}}
{"ok": false, "error": {"code": -32000, "message": "quota exceeded"}}
```

**覆盖的 RPC 命名空间**：`message.*`、`group.*`、`storage.*`（小对象 inline）、`stream.*`、`meta.*`、`nameservice.*` 等所有协议方法。

### 3. `evolclaw storage` — 文件存储

封装 storage 的多步流程，agent 一条命令完成文件上传下载。

| Verb | 动作 | 底层流程 |
|---|---|---|
| `upload <aid> <local-file> <remote-path> [--public]` | 上传文件（默认私有） | `create_upload_session` → HTTP PUT → `complete_upload`（`is_private` 由 `--public` 决定） |
| `download <aid> <url> [local-path]` | 下载文件（始终走 RPC） | 解析 URL 得到 owner + path → `create_download_ticket` → HTTP GET → 写本地 |
| `ls <aid> [prefix]` | 列文件 | `storage.list_objects` |
| `rm <aid> <remote-path>` | 删文件 | `storage.delete_object` |
| `quota <aid>` | 查配额 | `storage.get_quota` |

**参数说明**：

- `<aid>`：用哪个身份操作（认证用，必须是本地 AID）
- `<remote-path>`（upload/ls/rm）：文件在自己存储中的相对路径（如 `notes/hello.txt`）
- `<url>`（download）：`[https://]<owner-aid>/<path>` 格式，owner 和路径从 URL 中解析。下载自己的文件时 owner 就是自己，下载他人公开文件时 owner 是对方 AID
- `--public`：上传时设为公开文件（默认私有，`is_private=true`）

**download 示例**：

```bash
# 下载自己的文件
evolclaw storage download myaid.agentid.pub myaid.agentid.pub/notes/secret.txt ./secret.txt

# 下载别人的公开文件（owner 在 URL 里，无需额外参数）
evolclaw storage download myaid.agentid.pub bob.agentid.pub/public/doc.pdf ./doc.pdf

# 带 https:// 前缀也行
evolclaw storage download myaid.agentid.pub https://bob.agentid.pub/public/doc.pdf ./doc.pdf
```

**与 `rpc` 的关系**：小对象（几 KB 以内）可以直接用 `evolclaw rpc` 调 `storage.put_object` / `storage.get_object`（inline base64）。`evolclaw storage` 是大文件多步流程的封装。

### 4. 输出格式

所有子命令默认 human 可读输出（彩色文本），加 `--format json` 输出结构化 JSON。

```bash
# 人类看
$ evolclaw aid list
✓ alice.agentid.pub (私钥: 有, agent.md: 有)
✓ bob.agentid.pub   (私钥: 有, agent.md: 无)

# Agent 解析
$ evolclaw aid list --format json
[
  {"aid": "alice.agentid.pub", "hasPrivateKey": true, "hasAgentMd": true, "certExpiresAt": "2027-04-12T00:00:00Z"},
  {"aid": "bob.agentid.pub", "hasPrivateKey": true, "hasAgentMd": false, "certExpiresAt": "2027-03-01T00:00:00Z"}
]
```

## 实现链路

### Agent 调用 CLI 的链路

CLI 工具是**独立的 Node 进程**——agent 用 `Bash("evolclaw aid ...")` 启动一个新进程，干完活退出。**不走 IPC，不依赖 daemon**。

```
Agent (Claude Code)
  ↓ Bash("evolclaw aid agentmd put alice.agentid.pub")
  ↓
新 Node.js 进程启动（独立于 daemon）
  ↓
import src/aid/agentmd.ts
  ↓
new AUNClient({ aun_path: "~/.aun" })
  ↓
client.auth.upload_agent_md(content)
  ├─ SDK 内部自动复用本地缓存的 access token
  └─ token 缺失/过期 → SDK 自动重新认证 → 上传
  ↓
client.close()
  ↓
进程退出，stdout 返回给 Agent
```

### Token 持久化由 SDK 负责

SDK（`@agentunion/fastaun`）内部已经实现 token 持久化——文档明确说明 `upload_agent_md` "自动复用本地缓存的 access token；若 token 缺失或过期，会自动重新认证后再上传"。Token 存储在 `~/.aun/AIDs/<aid>/` 下，跨进程复用。

**CLI 端不需要做任何 token 管理**——只需要正常调 SDK 方法，认证、缓存、刷新全由 SDK 透明处理。

### 与现有实现的对比

现有 CLI 已有两种模式，新方案沿用模式 B：

| 模式 | 走法 | 适用 | 例子 |
|---|---|---|---|
| **A. IPC 转发** | CLI → Unix socket → daemon 处理 | 运行时状态变更 | `ctl`、slash 命令转发、`agent reload` |
| **B. 直接执行** | CLI 进程内直接调 SDK | 短生命周期操作 | 现有 `aid new`、`agentmd put` |

**新方案的 `aid` / `rpc` / `storage` 全部走模式 B**——不依赖 daemon，daemon 不在也能用。只有 `ctl` 工具走模式 A。

## 与 daemon 的关系

三套工具**完全独立于 daemon**——daemon 不在也能用。

| 场景 | 调用 daemon? | 原因 |
|---|---|---|
| `aid list / show / delete / lookup / agentmd get` | ✗ | 纯本地 / 纯网络读 |
| `aid new / agentmd put` | ✗（默认） | 工具自己连 AUN |
| `rpc / storage` | ✗ | 工具自己建短连接 |
| 同上 + `--reload-daemon` | ✓ | 改完文件让 daemon 重载 |

daemon 用的是**会话级**的 AUNClient 实例，证书在内存——除非 reload，工具改 `~/.aun/AIDs/<aid>/` 不影响 daemon 当前连接。

## 与 slash / ctl 的关系

| 调用方式 | 走法 |
|---|---|
| 终端用户 | `evolclaw aid/aun/storage <verb>` |
| Agent（聊天里被 owner 命令） | `Bash("evolclaw aid/aun/storage <verb>")`，agent 自己起子进程 |
| 旧 slash `/aid` `/agentmd` | 改成在 daemon 内**执行同一段代码**，保留聊天体验 |

slash 命令保留 UI 入口，但**实现路径**是直接调公共模块；CLI 也调同一组函数。两者共享底层模块（`src/aid/`），不是 ipc 互调。

## 改造步骤

### 阶段 A：抽公共模块（不改外观）

| 步骤 | 内容 |
|---|---|
| A1 | 把 `aun-ops.ts` 里 AID 相关函数迁到 `src/aid/`（新增 lookup、delete） |
| A2 | 现有 `cmdAid` / `cmdAgentmd` 改成调 `src/aid/`，行为不变 |
| A3 | 现有 `/aid` `/agentmd` slash 也改调 `src/aid/` |
| A4 | `init aun` wizard 拆出"创 AID 这一段"调 `src/aid/aidCreate` |

**`aun-ops.ts` 迁移策略**：

| `aun-ops.ts` 现有函数 | 迁移目标 |
|---|---|
| `aidList()` | → `src/aid/identity.ts` |
| `aidCreate()` | → `src/aid/identity.ts` |
| `agentmdGet()` | → `src/aid/agentmd.ts`（加验签） |
| `agentmdPut()` | → `src/aid/agentmd.ts`（加签名） |
| `buildInitialAgentMd()` | → `src/aid/agentmd.ts` |
| `getAunClient()` | → `src/aid/client.ts` |
| `downloadCaRoot()` | → `src/aid/client.ts` |
| `ensureAunSdk()` / `resolveAunCoreSdkPkg()` | → `src/aid/client.ts` |
| `isValidAid()` | → `src/aid/identity.ts` |
| `appendAunInstance()` | → `src/config.ts`（配置操作，不是 AID 操作） |

过渡期 `aun-ops.ts` 改为 re-export，保持现有调用方不报错：

```typescript
// src/channels/aun-ops.ts（过渡期）
export { aidList, aidCreate, agentmdGet, agentmdPut, ... } from '../aid/index.js';
```

阶段 C 时把所有 import `aun-ops.ts` 的地方改成直接 import `src/aid/`，然后删除 `aun-ops.ts`。

模块结构：

```
src/aid/
├── index.ts          — re-exports
├── client.ts         — getAunClient / ensureAunSdk（现有逻辑）
├── identity.ts       — list / show / new / delete / lookup
└── agentmd.ts        — get(自动验签) / put(自动签名)

src/aun-rpc/
├── index.ts          — re-exports
├── caller.ts         — 单次 call + batch call
└── connection.ts     — 短连接管理（authenticate + connect + close）

src/storage/
├── index.ts          — re-exports
├── upload.ts         — 三步上传封装
├── download.ts       — ticket + HTTP GET 封装
└── manage.ts         — ls / rm / quota
```

### 阶段 B：扩 CLI 表面

| 步骤 | 内容 |
|---|---|
| B1 | 实现 `aid show / delete / lookup` CLI 入口 |
| B2 | 实现 `aid agentmd put/get`（签名验签集成） |
| B3 | 实现 `rpc` 单次 + 批量（自动判断） |
| B4 | 实现 `storage upload / download / ls / rm / quota` |
| B5 | 所有子命令加 `--format json` |

### 阶段 C：收编旧入口

| 步骤 | 内容 |
|---|---|
| C1 | `evolclaw agentmd <aid>` 标记 deprecated，提示用 `evolclaw aid agentmd get <aid>` |
| C2 | `evolclaw agentmd set` 删除 |
| C3 | slash `/agentmd set` 同步删 |
| C4 | 跑 2 个 release 后删 deprecated 命令 |

## 验收标准

- `evolclaw aid list --format json` 输出可用 jq 处理
- `evolclaw aid new <aid>` 创建成功，`evolclaw aid show <aid>` 能看到证书信息
- `evolclaw aid delete <aid>` 后本地目录清除
- `evolclaw aid agentmd put <aid>` 自动签名并上传成功
- `evolclaw aid agentmd get <other-aid>` 下载并验签，验签失败有 warning
- `evolclaw rpc --as <aid> --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'` 能发消息
- `evolclaw rpc --as <aid> --params '<多行 JSONL>'` 批量执行成功
- `evolclaw storage upload <aid> ./test.txt files/test.txt` 上传成功
- `evolclaw storage download <aid> <aid>/files/test.txt ./downloaded.txt` 下载自己的文件成功
- `evolclaw storage download <aid> other.agentid.pub/public/doc.txt ./doc.txt` 下载他人公开文件成功
- daemon 不在的情况下，所有子命令可用
- 旧 `/aid new` slash 仍能工作（底层换实现）
- agent 在聊天里被命令"创建 reviewer.agentid.pub"——能用 `Bash("evolclaw aid new reviewer.agentid.pub")` 完成

## 设计决策记录

| # | 决策 | 结论 | 原因 |
|---|---|---|---|
| 1 | `revoke` 是否做？ | 不做 | AUN 协议无注销功能 |
| 2 | `renew` 是否暴露？ | 不暴露 | SDK 自动续期 |
| 3 | `rekey` 是否暴露？ | 不暴露 | 危险操作，不给 agent |
| 4 | `agentmd set` 是否保留？ | 删除 | 用 Edit + put 流程替代 |
| 5 | `sign/verify/diff` 是否独立子命令？ | 不独立 | put 自动签名，get 自动验签，够用 |
| 6 | `storage` 是否独立顶级命令？ | 是 | storage 操作不等于身份管理 |
| 7 | 是否独立 binary？ | 否 | 留作 evolclaw 子命令，避免 PATH/打包成本 |
| 8 | batch 模式如何传参？ | 无 `<method>` 时 `--params` 自动按 JSONL 多行执行 | 不需要额外 flag，根据参数自动判断 |
| 9 | `--aun-path` 全局参数？ | 是（`AUN_HOME` 环境变量 + flag） | 方便测试和多身份隔离 |
