# Tool Hook 安全检查与时延感知设计

## 背景

两个独立需求，共用 Claude Agent SDK 的 hook 扩展点：

1. **安全检查**：工具调用前拦截 agent 对 H 类（人专属）配置文件的直接写入。H/HA 权限模型由 `config-system-design.md` 第五节定义（SSOT），其"两道防线"的具体实施方案即本文档（配置文档第五节指回此处）。同步补上 menu protocol 命令执行的签名鉴权方案框架。
2. **时延感知**：工具调用后，向模型追加"距上次工具调用过了多久、队列里有没有积压消息"的元信息，让模型在长流程中自主决定是否收尾。

---

## 威胁模型与现状审计（2026-06-11）

核心问题：远端通过发消息，能否实现提权 / 重启 / 改代码 / 改 owner，从而获取系统控制权？

审计区分两条攻击路径，安全性截然不同。

### 路径 A：远端直接发结构化命令（menu protocol / CLI exec）—— 已防住

- 身份不可伪造：入站 AUN 消息的发送方 AID 取自 gateway 鉴权后的 `envelope.from`（`aun.ts:1134`），消息体自报的 `from`/`sender_aid` 被明确忽略。远端无法冒充 owner 的 AID。
- 危险动词有门禁：`/system restart`、`/agent reload/delete`（`command-handler.ts:1278/1434`）全部经 `isProcessLevelOwner(peerId, owners)`，owners 取自 `evolclaw.json`，纯名单比对，无绕过分支。
- CLI exec 白名单硬编码只读子命令；`menu.update` 无任何修改 owners/admins 的路径。

**结论：非 owner 远端走这条路无法提权或重启。**

### 路径 B：远端发自然语言诱导 agent 调用工具 —— 部分防住，存在缺口

这是真正的风险面。agent 在 proactive 模式对 guest 自主响应，攻击者无需提权命令，直接用提示词让 agent 替它执行。

**已实现的防线（你的防范模型，部分成立）：**

`session-manager.ts:101` 的 `resolvePermissionMode(role)` 按对端角色设定权限模式，三处真实调用（`568`/`648` 新建解析、`1119` fork）写入 session metadata：

```typescript
private resolvePermissionMode(role): string {
  return (role === 'owner' || role === 'admin') ? 'bypass' : 'readonly';
}
```

owner/admin → `bypass`（全放行）；guest/anonymous → `readonly`。`/perm` 切换权限模式也仅 owner 可用（`command-handler.ts:2089`）。所以"非 owner 对端 agent 跑在 readonly"这个设计**确实生效**——改源码 Write .ts 在 readonly 下被拦（只准写 `.evolclaw/tmp/`）。

**缺口一：readonly 名不副实，不拦可执行命令。**

`checkReadonly` 的 Bash 拦截清单 `READONLY_WRITE_PATTERNS`（`permission.ts:29-38`）只覆盖**写文件类命令**（`mkdir/touch/cp/mv/rm/chmod/ln/npm/git/sed/重定向`），**不含** `ec`、`node`、`python`、`bash`、`sh`、`curl`。后果：

- readonly 下 agent 仍可执行 `ec agent reload` / `ec restart`（`ec` 不在清单）
- readonly 下 agent 可 Write 脚本到 `.evolclaw/tmp/`（允许），再 `node .evolclaw/tmp/x.js` 执行（`node` 不在清单）→ 等于任意 RCE

即 readonly 拦住了"直接改项目文件"，但拦不住"经子进程执行任意代码"。

**缺口二：daemon IPC 无调用者鉴权。**

`ec agent reload` 经 `ipcQuery(socket, {type:'evolagent.reload', name})` 直连 daemon（`cli/agent.ts:860`）。daemon 侧 handler（`ipc.ts:205`）**不校验调用者身份**，任何能连到 socket（`0o600`，同用户任意进程）的本地进程都能触发 reload。这意味着：

> 命令层（menu protocol）的 owner 门禁，被"agent 经 Bash 起 ec 子进程直连 IPC"这条路**绕过**了——子进程路径根本不经过 `command-handler` 的身份检查。

**对你的防范模型的判定：**

| 你的假设 | 现状 |
|---------|------|
| 非 owner → 只读模式 | ✅ 成立（resolvePermissionMode 已实现） |
| 只读模式下只能读、不能改代码/重启 | ⚠️ 部分——Write 改源码被拦，但 `ec`/`node` 等可执行命令不拦 |
| 命令会检查对端身份决定能否执行 | ⚠️ 仅对 menu protocol 成立；agent 经 Bash → ec → IPC 这条路绕过身份检查，IPC 端也不鉴权 |

**方向正确，但当前实现堵不死路径 B。** 要让你的模型真正生效，需补三处（见下方需求 1 扩展）。

### 加固方案（路径 B）

经过对 `ec ctl` / `ec msg` 两条命令链路的完整审计，侧门的真实修法比"加 exec 黑名单"更聚焦，分三个正交的点：

| # | 问题 | 修法 | 详见 |
|---|------|------|------|
| B1 | `ec ctl` 凭证是明文 sessionId，agent 能从日志读到别的会话凭证冒充 | **per-session token 机制**：daemon 生成随机 token 绑定会话身份，注入子进程 env，不落盘不进日志 | 1.3节 |
| B2 | `ec msg send` 完全绕过会话约束，agent 可自选 from/to 向任意人发消息 | **托管环境禁用 `ec msg send`**，agent 一律走 `ec ctl send`（self 锁死，to 可任意） | 1.3节 |
| B3 | daemon IPC 的 evolagent.reload / load 等写操作无调用者鉴权 | **IPC 写操作校验 token**，非 owner token 拒绝 | 1.3节 |

`node .evolclaw/tmp/x.js` 这条任意代码执行路径（readonly 写 tmp 再跑）是已知残余风险，**接受**——禁 `node` 会破坏所有 skill，代价不可接受。B1/B2/B3 三条加固后，即使 agent 能跑任意脚本，它改不了配置（H 类文件保护）、reload/restart 不了 daemon（IPC token 拒绝）、发不了冒充消息（ec msg 在托管环境被禁），损害已被限制在进程内。



---

## 需求 1：工具调用前安全检查

### 1.1 H 类文件保护（PreToolUse hook，待实现第二道防线）

`config-system-design.md` 已定义：**H 类文件只有人能改**，等价关系：

```
能被 agent 写 ⟺ 是 HA 字段 ⟺ 存在 behavior.json 中
```

H 类文件路径清单：

| 文件 | 相对于 `$EVOLCLAW_HOME` |
|------|------------------------|
| 进程级 | `evolclaw.json` |
| 全局级 | `agents/defaults.json` |
| Agent 身份凭证 | `agents/*/config.json` |
| 关系级人工判定 | `agents/*/relations/*/config.json` |

**实现位置**：`claude-runner.ts` 的 `preToolUseHook`（已存在，不可绕过）。

**逻辑**：Write / Edit / NotebookEdit 工具 → 解析 `file_path`/`path` 参数 → 如果路径 match H 类 pattern → block 并返回原因。

```typescript
// src/core/permission.ts — 新增函数
const H_CLASS_PATTERNS = [
  /[/\\]evolclaw\.json$/,
  /[/\\]agents[/\\]defaults\.json$/,
  /[/\\]agents[/\\][^/\\]+[/\\]config\.json$/,
  /[/\\]agents[/\\][^/\\]+[/\\]relations[/\\][^/\\]+[/\\]config\.json$/,
];

export function checkHClassWrite(toolName: string, input: Record<string, unknown>): { behavior: 'allow' | 'deny'; message?: string } {
  if (!['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return { behavior: 'allow' };
  const filePath = (input.file_path ?? input.path ?? '') as string;
  if (!filePath) return { behavior: 'allow' };
  // 规范化路径分隔符后做匹配
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of H_CLASS_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        behavior: 'deny',
        message: `[H类文件保护] ${filePath} 是人专属配置文件，agent 不可直接写入。如需修改行为参数请通过 ec 命令（写入 behavior.json）。`,
      };
    }
  }
  return { behavior: 'allow' };
}
```

**接入**：在 `preToolUseHook` 中（`claude-runner.ts:1124`），黑名单检查之后加一步：

```typescript
const hResult = checkHClassWrite(input.tool_name, input.tool_input || {});
if (hResult.behavior === 'deny') {
  return { decision: 'block' as const, reason: hResult.message };
}
```

---

### 1.2 menu protocol 命令签名鉴权（框架设计，待前端配合实现）

#### 现状缺口

- menu protocol（`aun-menu-protocol-dev-guide-v2.md`）全部请求字段无签名占位
- `command-handler.ts` 只做 channel+peerId 的角色绑定，无加密凭证验证
- AID PKI（证书/签名能力）已就绪（`src/aun/aid/identity.ts`），但仅用于 `agent.md`，未扩展到指令链路

#### 为什么不复用现有 id

核实了两类现有标识，都不适合直接当防重放 nonce：

| 标识 | 来源 | 唯一性 | 问题 |
|------|------|--------|------|
| menu 请求的 `id` | 客户端生成（nanoid/计数器） | 仅客户端进程内唯一 | 不跨重启，重启后计数器重置，强度不足 |
| AUN `messageId` | gateway 生成 | 全局唯一 | 在消息层，不在 menu 应用层；且不被 sig 覆盖，重放者可改写 |

结论：menu 机制层需要**自带专用 nonce 字段**，且 nonce 必须被 sig 覆盖签名——重放者没有私钥，无法为篡改后的请求重新签名，只能原样重发，而原样重发会因 nonce 已被记录而被拒。

#### 签名方案：nonce + sig（menu 机制层原生支持）

> 需要前端（Evol App/ECWeb）配合实现，本节为协议设计规范，供前端开发对接。
> 设计目标：防重放与验签**完全由 menu 机制层承担**，上传/传输层不感知。

menu protocol 请求新增两个字段：

```typescript
interface MenuRequestBase {
  type:  string;
  id:    string;      // 现有：客户端配对用，不变更语义
  nonce: string;      // 新增：全局唯一防重放令牌（UUID v4 等），每个请求重新生成
  ts:    number;      // 新增：Unix ms，仅用于界定 nonce 表保留窗口
  sig:   string;      // 新增：Base64 DER 签名
  // sig 签名内容：SHA-256( type + id + nonce + ts + name? + JSON.stringify(value|args) )
}
```

只对 `menu.update` / `menu.action` 这类**写操作 / 触发动词**强制要求三字段；
`menu.list` / `menu.query` / `menu.options` 等只读请求可不要求（按角色裁剪即可）。

服务端验签流程（`command-handler.ts` 写操作入口）：

```
1. 提取请求方 AID（来自 channel peerId 或 payload.aid）
2. ts 窗口校验：|now - ts| > NONCE_WINDOW(5min) → 拒绝（EXPIRED）
   （超窗请求直接拒，nonce 表只需保留窗口内的，避免无限增长）
3. nonce 去重：nonce 已在 recentMenuNonces 中 → 拒绝（EREPLAY）
4. 验签：AidObj.verify(signedContent, sig, peerCert)
   验签失败 → 拒绝（ESIG_INVALID）
5. 全部通过 → 记录 nonce（TTL = NONCE_WINDOW）→ 继续角色鉴权
```

nonce 去重存储（**独立于消息层去重**，不复用 `recentMessageIds`）：

```typescript
// command-handler.ts 或专用模块
private recentMenuNonces = new Map<string, number>();  // nonce → 记录时间
private readonly NONCE_WINDOW = 300_000;               // 5 分钟

private checkAndRecordNonce(nonce: string): boolean {
  if (this.recentMenuNonces.has(nonce)) return false;   // 重放
  this.recentMenuNonces.set(nonce, Date.now());
  setTimeout(() => this.recentMenuNonces.delete(nonce), this.NONCE_WINDOW);
  return true;
}
```

为什么独立于消息层去重：消息层 `recentMessageIds` 用 `sessionKey:messageId` 做 key、60s 窗口，服务于高频文本/图片去重；menu 写操作更敏感、窗口更长（5min），且 key 是纯 nonce（不带 sessionKey 前缀，因为 nonce 全局唯一）。两者层级和语义都不同，混用会互相干扰。

SDK 已提供 `verifyAgentMd()` 的底层验签能力，扩展到指令签名只需复用同一证书链（Root CA → Registry CA → Issuer CA → Agent Cert）。

#### 与 H 类文件保护的分工

| 层 | 拦截的是 | 机制 |
|----|---------|------|
| PreToolUse hook（工具层） | 模型直接调用 Write/Edit 写 H 类文件 | 正则 match 路径，block |
| command-handler 入口（命令层） | 通过 menu protocol 发来的写 H 类字段命令 | 时间窗口 → 将来签名 |

两道防线互补，覆盖绕过 CLI 的直接工具调用和通过 menu 协议下发的远程命令两条路径。

---

### 1.3 ec CLI 身份凭证机制（修复路径 B 的三个缺口）

#### 现状：凭证是明文 sessionId

审计发现 `ec ctl` 的身份继承完全依赖单一环境变量 `EVOLCLAW_SESSION_ID`（`claude-runner.ts:288`，三个 runner 均相同）。`ctl-command.ts:55-72` 把它原样透传进 IPC 请求，daemon 用它反查 session 取 `peerId`，再 `resolveIdentity` 得 role。

**问题**：sessionId 是明文标识符，**不是**密钥——它出现在 daemon 日志（`command-handler.ts:1123`）和 eck-debug 文件里。agent 可通过 Read 工具读到另一个 owner session 的 sessionId，然后用它冒充 owner 调 `ec ctl restart`。

同时审计发现 `ec msg send`（`aun-commands.ts:735`）是一条**完全绕过 daemon 的独立链路**：它在 CLI 进程内自建 AUN 短连接直发，from/to 均为命令行参数，无任何会话约束——agent 可向任意 AID 发消息、以本机任意有私钥的 AID 身份发送。

**入站链路已安全**：另一方面审计确认 AUN 入站消息的会话归属和身份判定完全来自 gateway 可信信封（`env.from` / `env.group_id`），payload 里发送方自报字段不用于任何权限判定（`aun.ts:1177-1178` 明确注释）。发送方无法通过消息字段伪造身份或注入错误会话。

#### 修法 B1：per-session token

daemon 在每次 `runQuery` 启动 agent 子进程时生成随机 token，绑定会话身份，注入子进程 env，**绝不落盘、绝不进日志**：

```typescript
// daemon 侧（claude-runner.ts getAgentEnv() 调用处，或 runQuery 入口）
const ctlToken = crypto.randomBytes(32).toString('hex');
ctlTokens.set(ctlToken, {
  sessionId,
  peerId: session.metadata.peerId,   // 消息层已鉴权的真实身份
  role: session.identity.role,        // resolvePermissionMode 来源
  expiresAt: Date.now() + SESSION_TOKEN_TTL,
});
// 注入 env：
EVOLCLAW_CTL_TOKEN: ctlToken   // 新增，取代 sessionId 作为凭证
EVOLCLAW_SESSION_ID: sessionId  // 保留，用于"是哪个会话"（非凭证）
```

`ec ctl` 读取并透传 token（`ctl-command.ts`）：

```typescript
const token = process.env.EVOLCLAW_CTL_TOKEN;
// IPC 请求：{ type: 'ctl', cmd, token }  （不再用 sessionId 作凭证）
```

daemon IPC handler 用 token 查内存表，取出绑定的 `{peerId, role}` 做鉴权：

```typescript
// ipc.ts — ctl 分支
const bound = ctlTokens.get(cmd.token);
if (!bound || bound.expiresAt < Date.now()) return { ok: false, error: 'ETOKEN_INVALID' };
// 用 bound.peerId / bound.role 做后续 role 检查，不再从请求字段读
```

token 在 `runQuery` 结束 / session 销毁时撤销（`ctlTokens.delete(token)`），每次 `runQuery` rotate。

**为什么能堵住冒充**：token 是 32字节随机，不可猜；不落盘不进日志，agent 读遍文件系统也找不到别的会话的 token；agent 的 env 里只有代表**自己真实身份**的 token，guest 的 token 绑定的就是 `role: guest`，拿它去调 `ec ctl restart` → daemon 查到"guest" → 拒绝。

**同时**：`evolagent.reload` / `evolagent.load` 等 IPC 写操作 handler（`ipc.ts:205/221`）目前完全无鉴权，需补上 token 校验（或调用方通过 `ec ctl agent reload` 走有 token 的路径，而不是绕过 ctl 直接 IPC）。

#### 修法 B2：托管环境禁用 ec msg send，ec ctl send 支持任意 to

**ec msg send 禁用**：检测到 `EVOLCLAW_SESSION_ID`（或 `EVOLCLAW_CTL_TOKEN`）存在时，`ec msg send` 直接拒绝并提示：

```typescript
// aun-commands.ts — cmdMsg send 入口
if (process.env.EVOLCLAW_CTL_TOKEN) {
  console.error('ec msg send 不可在 agent 托管环境中使用，请改用：ec ctl send [to <目标AID>] "<内容>"');
  process.exit(1);
}
```

`ec msg pull/ack/recall` 等只读/接收类子命令不受影响。

**ec ctl send 扩展**：当前 `ec ctl send` 强制发给当前会话对端（self 锁死 ✓），需扩展支持显式指定 to：

```
ec ctl send "<内容>"              # 原有：发给当前会话对端
ec ctl send to <目标AID> "<内容>" # 新增：发给指定 AID，self 仍锁死为当前会话本端
```

self 始终来自 token 绑定的会话本端 AID，不可由 agent 通过参数覆盖。

#### 修法 B3：生命周期命令的托管环境护栏

`ec restart` / `ec start` / `ec stop` 是给终端人用的进程生命周期命令，不走 IPC，直接发信号杀/起进程。在托管环境下检测到 env 时拒绝：

```typescript
// daemon-commands.ts — cmdRestart/cmdStop 入口
if (process.env.EVOLCLAW_CTL_TOKEN) {
  console.error('进程生命周期命令不可在 agent 托管环境中使用，请改用：ec ctl restart');
  process.exit(1);
}
```

**说明**：这是**护栏，不是硬边界**。agent 理论上可以 `unset EVOLCLAW_CTL_TOKEN; ec stop` 或直接 `kill <pid>` 绕过，因为同 OS 用户有权限杀进程——应用层防不住。护栏的作用是引导 agent 走带身份验证的正规路径（`ec ctl restart` → token → owner 验证），并在违规时留下审计痕迹。真正的硬边界需要 OS 级隔离（不同用户 / 容器）。

#### 残余风险（已知、已接受）

| 风险 | 条件 | 接受原因 |
|------|------|---------|
| agent 运行任意脚本（`node .evolclaw/tmp/x.js`） | readonly 允许写 tmp、不拦 node | 禁 node 破坏所有 skill；B1-B3 已限制损害范围 |
| 同机多 agent keystore 互读 | 同 OS 用户，`$EVOLCLAW_HOME/AIDs/` 都可读 | 设计边界：同 OS 用户 = 同信任域；跨信任域须 OS 级隔离 |
| IPC socket 同用户无隔离 | `0o600` 文件权限，同用户任意进程可连 | token 机制使连上 socket 也没用，无有效 token 写操作被拒 |

---

## 需求 2：工具调用后时延与队列感知（PostToolUse hook）

### 2.1 技术可行性

Claude Agent SDK 的 `PostToolUse` hook 支持 `hookSpecificOutput.additionalContext`，文档原文：

> For PostToolUse hooks, you can set additionalContext to append information to the tool result.

这段内容会追加到工具结果之后，模型在下一轮推理时可以读到，不影响当前流，不需要中断。

### 2.2 为什么选择元信息注入而非中断

| 方案 | 优点 | 缺点 |
|------|------|------|
| 中断（现有单聊行为） | 立即响应新消息 | 丢弃当前进度，模型需要重新理解上下文 |
| PostToolUse 元信息注入 | 不丢进度，模型自主决策 | 需要模型配合，不能强制收尾 |

群聊场景（`interruptible: false`）中断不可用，且慢模型长流程正是群聊的主要场景。元信息方案在每个工具调用的自然断点给模型施加压力，让它自主决定是收尾还是继续——这比硬中断更智能。

### 2.3 架构：ECK vars + 声明式模板

注入文案**不在 runner 里硬编码**，走 ECK 既有的"声明式 manifest + `renderTemplate` + vars"机制：

- **文案** → `kits/templates/system-fragments/tool-call-status.md`（模板，可按渠道/场景覆盖）
- **数据** → `peekQueue` 结果进 ECK vars，由 `message-processor.ts` 的 vars 构造处（`~818`行）填入
- **渲染** → `PostToolUse` hook 在运行时调 `renderTemplate(template, vars)` 得到字符串，作为 `additionalContext` 返回

这样文案改动不需要动 runner 代码，且可通过 manifest `when` 条件控制"只在群聊/积压大于N时才注入"。

### 2.4 MessageQueue 新增 peek 接口

```typescript
// src/core/message/message-queue.ts
peekQueue(sessionKey: string): { count: number; bySender: { sender: string; count: number }[]; latestAgeMs?: number } {
  const pending: QueuedMessage[] = [];
  for (const [key, items] of this.queues) {
    if (key.startsWith(sessionKey + '::')) pending.push(...items);
  }
  const byMap = new Map<string, number>();
  let latestTs = 0;
  for (const m of pending) {
    const s = m.message.peerId ?? m.message.from ?? 'unknown';
    byMap.set(s, (byMap.get(s) ?? 0) + 1);
    if (m.message.timestamp && m.message.timestamp > latestTs) latestTs = m.message.timestamp;
  }
  return {
    count: pending.length,
    bySender: [...byMap.entries()].map(([sender, count]) => ({ sender, count })),
    latestAgeMs: latestTs ? Date.now() - latestTs : undefined,
  };
}
```

### 2.5 ECK vars 扩展

在 `message-processor.ts` vars 构造处（`~818` 行）新增三个字段，每次组装上下文时由上层传入（`runQuery` 后/下一轮消息处理时）；`PostToolUse` hook 触发时这些值已经是调用 peekQueue 的新鲜结果：

```typescript
// 在 kitCtx.vars 中新增（值由 PostToolUse hook 在 runQuery 期间动态更新，此处为初始值）
toolCallElapsedSec: undefined as string | undefined,   // 距上次工具调用秒数，如 "8.3"
queueCount:         undefined as string | undefined,   // 积压总条数，如 "4"
queueBySender:      undefined as string | undefined,   // 按发送者统计，如 "王老板×3、李工×1"
queueLatestAgeSec:  undefined as string | undefined,   // 最新消息距今秒数，如 "12"
```

注：`PostToolUse` hook 在 `runQuery` 的 SDK 流内执行，`additionalContext` 不经过 ECK vars 流程——它直接调 `renderTemplate` 并把结果作为字符串返回。vars 里这几个字段供将来在其他 ECK fragment 里引用（如 session.md 调试信息），PostToolUse 本身走下面的直接渲染路径。

### 2.6 模板文件

新建 `kits/templates/message-fragments/tool-call-status.md`（与 `item.md` / `inject-default.md` 同目录——message-fragments 放消息渲染模板，system-fragments 放 system prompt ECK 片段，additionalContext 的性质属于前者）：

```markdown
{{?queueCount}}
[tool-call-status]
⏱ 距上次工具调用 {{toolCallElapsedSec}}s{{?queueLatestAgeSec}}，最新消息来自 {{queueLatestAgeSec}}s 前{{/}}。
📬 消息队列积压 {{queueCount}} 条（{{queueBySender}}）。
如积压消息与当前任务相关，建议尽快收尾本轮以纳入处理；否则可继续。
{{/}}
```

条件 `{{?queueCount}}` 保证无积压时不输出任何内容，不打扰模型。

### 2.7 PostToolUse hook 实现

```typescript
// claude-runner.ts — runQuery() 内，与 preToolUseHook 并列定义

import { renderTemplate } from '../eck/manifest-engine.js';

let lastToolUseAt = Date.now();
const toolCallStatusTemplate = fs.readFileSync(
  path.join(getPackageRoot(), 'kits', 'templates', 'message-fragments', 'tool-call-status.md'), 'utf-8'
);

const postToolUseHook = async (_input: any): Promise<any> => {
  const elapsed = Date.now() - lastToolUseAt;
  lastToolUseAt = Date.now();

  const q = this.messageQueue?.peekQueue(sessionKey);
  if (!q || q.count === 0) return {};   // 无积压时不注入

  const vars = {
    toolCallElapsedSec: (elapsed / 1000).toFixed(1),
    queueCount:         String(q.count),
    queueBySender:      q.bySender.map(({ sender, count }) => `${sender}×${count}`).join('、'),
    queueLatestAgeSec:  q.latestAgeMs != null ? (q.latestAgeMs / 1000).toFixed(0) : undefined,
  };

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: renderTemplate(toolCallStatusTemplate, vars, false),
    },
  };
};
```

hooks 注册：

```typescript
hooks: {
  PreCompact:       [{ matcher: '.*', hooks: [preCompactHook] }],
  PreToolUse:       [{ matcher: '.*', hooks: [preToolUseHook] }],
  PostToolUse:      [{ matcher: '.*', hooks: [postToolUseHook] }],  // 新增
  PermissionDenied: [{ matcher: '.*', hooks: [permissionDeniedHook] }],
},
```

### 2.8 批量队列处理（dequeueGreedy 改造）

当前 `dequeueGreedy` 只合并连续同 peerId 的消息——群聊 A/B/C 交替发消息时合并效果差。

新设计：**每次出队时把整个队列作为一批处理，批次超上限则分批，每批携带剩余统计**。

#### MessageQueue 改动

`dequeueGreedy` 替换为 `dequeueBatch`，同时 `peekQueue` 也复用相同统计逻辑：

```typescript
// src/core/message/message-queue.ts
private static readonly BATCH_SIZE = 20;  // 单批最大消息数，可配置

/** 出队一批：最多 BATCH_SIZE 条，剩余留队列 */
private dequeueBatch(queue: QueuedMessage[]): { batch: QueuedMessage[]; remaining: QueueStats } {
  const batch = queue.splice(0, MessageQueue.BATCH_SIZE);
  return { batch, remaining: this.statsOf(queue) };
}

/** 只读统计，不出队 */
peekQueue(sessionKey: string): QueueStats {
  const pending: QueuedMessage[] = [];
  for (const [key, items] of this.queues) {
    if (key.startsWith(sessionKey + '::')) pending.push(...items);
  }
  return this.statsOf(pending);
}

private statsOf(items: QueuedMessage[]): QueueStats {
  const byMap = new Map<string, number>();
  let latestTs = 0;
  for (const m of items) {
    const s = m.message.peerId ?? m.message.from ?? 'unknown';
    byMap.set(s, (byMap.get(s) ?? 0) + 1);
    if (m.message.timestamp && m.message.timestamp > latestTs) latestTs = m.message.timestamp;
  }
  return {
    count: items.length,
    bySender: [...byMap.entries()].map(([sender, count]) => ({ sender, count })),
    latestAgeMs: latestTs ? Date.now() - latestTs : undefined,
  };
}
```

```typescript
// src/types.ts 或 message-queue.ts
export interface QueueStats {
  count: number;
  bySender: { sender: string; count: number }[];
  latestAgeMs?: number;
}
```

`processNext` 改为调用 `dequeueBatch`，把 `batch`（多条 QueuedMessage）和 `remaining` 一起传给 `MessageProcessor.processMessage`。

#### 消息合并：跨 peerId 全批合并

现有 `mergeItems` 只合并同 peerId 消息。批量场景改为：**把 batch 中所有消息按时间顺序合并为一个带 `items` 的 Message**，每条 item 保留自己的 `peerId/peerName/content/timestamp`（渲染层用 `item.md` 逐条渲染，已支持多发送者）。

#### remaining 随消息传递

`processMessage` 入参扩展 `remaining?: QueueStats`，注入到 `kitCtx.vars`：

```typescript
// message-processor.ts vars 构造处（~818行）
queueCount:        remaining?.count > 0 ? String(remaining.count) : undefined,
queueBySender:     remaining?.bySender.map(({ sender, count }) => `${sender}×${count}`).join('、'),
queueLatestAgeSec: remaining?.latestAgeMs != null ? (remaining.latestAgeMs / 1000).toFixed(0) : undefined,
```

这样 system prompt 里的 session fragment 就能感知剩余队列；同时 `PostToolUse` hook 的 peekQueue 也会拿到同样的数据——**两者数据源统一，不需要 PostToolUse 单独维护 `toolCallElapsedSec` 之外的状态**。

`PostToolUse` hook 简化为只计算时间间隔，队列统计直接从 vars 读（已在 session 渲染时注入），模板 `tool-call-status.md` 不变。

---

## 实施顺序

### Phase 0：安全加固（优先，堵侧门）

| 步骤 | 文件 | 改动 | 依赖 |
|------|------|------|------|
| S1 | `src/agents/claude-runner.ts` | 生成 per-session token，注入 `EVOLCLAW_CTL_TOKEN` env | 无 |
| S2 | `src/cli/ctl-command.ts` | 读 `EVOLCLAW_CTL_TOKEN`，IPC 请求改带 token | S1 |
| S3 | `src/ipc.ts` | ctl handler 用 token 反查身份做鉴权；`evolagent.reload/load/resync` 同步加 token 校验 | S1、S2 |
| S4 | `src/cli/aun-commands.ts` | `ec msg send` 检测托管环境（`EVOLCLAW_CTL_TOKEN` 存在）时拒绝 | S1 |
| S5 | `src/core/command-handler.ts` | `ec ctl send` 扩展支持 `to <AID>` 参数（self 仍锁死） | S3 |
| S6 | `src/cli/daemon-commands.ts` | `ec restart/stop` 检测托管环境时拒绝，引导走 `ec ctl restart` | S1 |

S1→S2→S3 是核心链路，可快速合并为一个 PR。S4/S5/S6 独立。

### Phase 1：工具层安全检查

| 步骤 | 文件 | 改动 | 依赖 |
|------|------|------|------|
| 1 | `src/core/permission.ts` | 新增 `checkHClassWrite()` | 无 |
| 2 | `src/agents/claude-runner.ts` | `preToolUseHook` 调用 `checkHClassWrite` | 步骤 1 |

### Phase 2：时延感知与批量队列

| 步骤 | 文件 | 改动 | 依赖 |
|------|------|------|------|
| 3 | `src/core/message/message-queue.ts` | 新增 `peekQueue()` + `dequeueBatch()` + `QueueStats` | 无 |
| 4 | `kits/templates/message-fragments/tool-call-status.md` | 新建模板 | 无 |
| 5 | `src/agents/claude-runner.ts` | `postToolUseHook` + hooks 注册 | 步骤 3、4 |

### Phase 3：menu 命令签名鉴权（需前端配合）

| 步骤 | 文件 | 改动 | 依赖 |
|------|------|------|------|
| 6 | menu protocol 文档 + 前端 | 请求带 `nonce`/`ts`/`sig` 字段 | — |
| 7 | `src/core/command-handler.ts` | nonce 去重 + ts 窗口 + AID 验签 | 步骤 6、AID PKI |

Phase 0 最紧急（安全漏洞修复），Phase 1/2 互不依赖可并行，Phase 3 待前端配合。

---

## 审计确认项

| 审计对象 | 结论 | 时间 |
|---------|------|------|
| 路径 A：menu protocol / CLI exec 命令层 | ✅ 安全（owner 门禁 + gateway 身份不可伪造） | 2026-06-11 |
| AUN 入站链路（会话归属/身份判定） | ✅ 安全（全部来自 gateway 可信信封，payload 不参与权限） | 2026-06-13 |
| `ec ctl` 身份继承机制 | ❌ 凭证为明文 sessionId（可从日志读取冒充）→ 修法 B1 | 2026-06-13 |
| `ec msg send` 链路 | ❌ 绕过 daemon、from/to 任意填（受限于本机 keystore）→ 修法 B2 | 2026-06-13 |
| daemon IPC 写操作（evolagent.reload 等） | ❌ 无调用者鉴权 → 修法 B3（含于 B1 token 方案） | 2026-06-13 |

---

## 关联文档

- `docs/config-system-design.md` — H/HA 文件权限体系（SSOT）
- `docs/permission-redesign.md` — PreToolUse / canUseTool 架构
- `docs/aun-menu-protocol-dev-guide-v2.md` — menu protocol 字段规范
- `src/core/permission.ts` — checkBlacklist / checkReadonly / PermissionGateway
- `src/agents/claude-runner.ts:1123` — preToolUseHook 入口
- `src/core/message/message-queue.ts` — 消息队列实现
