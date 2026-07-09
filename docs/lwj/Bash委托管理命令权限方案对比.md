# Bash 委托管理命令权限方案对比

> 议题：当 owner/admin 通过消息要求 agent 执行管理命令，例如
> `ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member`，
> 是否可以继续使用 Bash 命令形式，以及如何保证权限判断可信。
>
> 本文只讨论“用户消息驱动 agent 执行管理操作”的 Bash 兼容方案。
> 配置文件路径描述遵循 `docs/config/01-overview.md`：使用 `{evolclaw_home}`、
> `agents/{aid}/config.json`、`agents/{aid}/relations/{peerKey}/config.json`。

---

## 1. 问题背景

当前系统已经有三类相关机制：

1. `config.json` 已是受保护配置文件：
   - `{evolclaw_home}/evolclaw.json`
   - `{evolclaw_home}/agents/defaults.json`
   - `{evolclaw_home}/agents/{aid}/config.json`
   - `{evolclaw_home}/agents/{aid}/relations/{peerKey}/config.json`
2. agent 不能直接读写上述配置文件，应通过 API/CLI/ConfigManager 修改。
3. `role.assign` / `role.revoke` 是管理操作，理论上应只允许 owner/admin 触发。

但当 owner 给 agent 发消息：

```bash
ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member
```

如果 agent 直接通过 Bash 执行，系统需要回答两个问题：

- 这次操作到底是 **agent 自己要做**，还是 **owner 授权 agent 代做**？
- Bash 命令执行前后的权限上下文如何可信传递，避免被伪造？

核心原则：

> 允许 owner/admin 驱动 agent 执行管理命令时，权限主体必须是 AUN 已认证的消息发送者，
> agent 只是执行代理。不能把 agent 自己当成权限主体。

---

## 2. 当前直接放行 Bash 的问题

不建议简单做成：

```text
hook 检查通过 -> 放行原始 Bash -> CLI 本地写配置
```

原因：

1. Hook 检查的是命令字符串，shell 执行的是解释后的命令。
2. `PATH`、脚本替换、alias、包装命令可能导致实际执行对象不是预期的 `ec`。
3. 如果 CLI 自己不鉴权，绕过 hook 直接运行 CLI 仍可能修改配置。
4. Hook 检查和 CLI 写入不是同一个原子流程，中间状态可能变化。
5. 审计日志可能只记录 hook 放行，而不是实际写入结果。

因此，Bash 可以保留为用户/agent 的命令表达形式，但不能把普通 Bash 作为最终可信执行边界。

---

## 3. 共同设计基础

无论采用哪种方案，都需要先建立一套通用能力。

### 3.1 新增委托来源

建议新增命令来源：

```ts
type CommandSource =
  | 'ecweb'
  | 'control'
  | 'agent-tool'
  | 'agent-delegated';
```

语义：

- `agent-tool`：agent 自主工具调用，不代表用户授权。
- `agent-delegated`：AUN 已认证用户通过消息授权，agent 代为执行。

`role.assign` 可允许：

```ts
sources: ['ecweb', 'control', 'agent-delegated']
```

但不能允许普通 `agent-tool`。

### 3.2 委托上下文

委托上下文必须由系统注入，agent 不能通过命令参数提供。

```ts
interface DelegationContext {
  source: 'agent-delegated';
  actorId: string;        // AUN 已认证的消息发送者 AID
  actorRole: string | null; // 当前会话解析出的 owner/admin/member/visitor；无角色为 null
  selfAid: string;        // 当前 agent AID
  peerKey?: string;       // 当前关系 key
  channel?: string;
  chatType?: 'private' | 'group';
  messageId?: string;
  sessionId?: string;
}
```

禁止由 Bash 参数传入以下字段：

```text
--actor
--actor-role
--source
--from-control-channel
--is-owner
```

这些字段全部来自 session/message/AUN 层。

### 3.3 管理命令解析器

新增严格解析器，例如：

```ts
parseEcManagementCommand(command: string): CommandIntent | null
```

首批支持：

```bash
ec role assign --self <aid> --peer <peerKey> --role <role>
ec role revoke --self <aid> --peer <peerKey>
```

必须拒绝包含 shell 控制符的命令：

```text
;  &&  ||  |  `  $()  >  <  换行
```

解析结果示例：

```ts
{
  operation: 'role.assign',
  scope: 'agent',
  source: 'agent-delegated',
  args: {
    self: 'bot.aid.pub',
    peer: 'aun#alice.aid.pub',
    role: 'member'
  }
}
```

### 3.4 统一鉴权规则

执行 `role.assign` 时至少校验：

1. `actorId` 必须来自 AUN 已认证消息发送者。
2. `actorRole` 必须是 `owner` 或 `admin`。
3. `--self` 必须等于当前 `selfAid`，除非后续明确支持跨 agent 管理。
4. `--role` 必须是用户角色，例如 `member`、`visitor`、自定义用户角色。
5. 禁止通过 `role.assign` 分配 `owner` / `admin`。
6. 写入必须通过 ConfigManager / 配置 API，不能直接写配置文件。
7. 必须记录审计：actor、operation、target peer、target role、messageId、结果。

写入目标按配置体系设计应落到关系级配置，例如：

```text
{evolclaw_home}/agents/{aid}/relations/{peerKey}/config.json
```

---

## 4. 方案一：Hook 短路执行

### 4.1 核心思想

Bash 命令仍作为表达形式，但命中管理命令后，不再真正执行原始 Bash。

流程：

```text
agent 调用 Bash:
  ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member
    ↓
Bash PreToolUse Hook 识别 ec role assign
    ↓
从 session/message 层构造 DelegationContext
    ↓
parseEcManagementCommand() 生成 CommandIntent
    ↓
authorizeCommand(source = agent-delegated)
    ↓
ActionGateway / handler 执行业务
    ↓
ConfigManager 写关系级 config.json
    ↓
写审计日志
    ↓
Hook 阻止原始 Bash 继续执行，并返回类似 CLI 的结果文本
```

### 4.2 示例

用户消息：

```text
给 alice 分配 member 角色
```

agent 生成：

```bash
ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member
```

Hook 内部转换为：

```ts
authorizeCommand({
  source: 'agent-delegated',
  actorId: 'owner.aid.pub',
  role: 'owner',
  selfAid: 'bot.aid.pub',
  intent: {
    operation: 'role.assign',
    scope: 'agent',
    source: 'agent-delegated',
    args: {
      self: 'bot.aid.pub',
      peer: 'aun#alice.aid.pub',
      role: 'member'
    }
  }
});
```

鉴权通过后，由 handler 写入：

```text
{evolclaw_home}/agents/bot.aid.pub/relations/aun#alice.aid.pub/config.json
```

### 4.3 优点

- 实现相对简单，不需要 token 系统。
- 原始 Bash 不执行，减少 shell 注入、PATH 替换、CLI 绕行风险。
- 权限判断和实际写入处于同一进程/同一调用链，审计更准确。
- 适合 agent 会话内的委托管理操作。

### 4.4 缺点

- Hook 需要有能力执行业务 handler，并把结果返回给 agent。
- 如果 hook 框架只能 `allow/block`，不能返回 stdout，则用户体验会比较别扭。
- 人类在终端直接执行 `ec role assign` 不能复用这个 hook 流程。
- Hook 逻辑会变重，需要维护 ActionGateway 调用能力。

### 4.5 适用场景

适合优先解决：

- owner/admin 在聊天中让 agent 修改权限；
- 不强调真实 CLI 执行语义；
- 希望最大限度降低 Bash 风险；
- 管理操作主要发生在 agent 会话内。

---

## 5. 方案二：Hook 签发一次性委托凭证，CLI 执行

### 5.1 核心思想

Hook 不直接执行业务，而是给这次命令签发一次性委托凭证。

CLI 收到凭证后，不能本地直接写配置，必须调用 daemon / ActionGateway 校验凭证并执行。

流程：

```text
agent 调用 Bash:
  ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member
    ↓
Bash PreToolUse Hook 识别 ec role assign
    ↓
从 session/message 层构造 DelegationContext
    ↓
预解析命令，计算 argsHash
    ↓
签发一次性 delegation token
    ↓
将 token 注入子进程环境变量
    ↓
放行 CLI 执行
    ↓
CLI 携带 token 调 daemon / ActionGateway
    ↓
daemon 校验 token + 重新 authorizeCommand()
    ↓
handler 写 config.json
    ↓
审计并返回 CLI 输出
```

### 5.2 Token 内容

建议使用 opaque token，即 token 本身只是随机 ID，真实内容保存在 daemon 内存或受控存储中。

```ts
interface DelegationTokenRecord {
  tokenId: string;
  actorId: string;
  actorRole: string;
  selfAid: string;
  operation: 'role.assign';
  scope: 'agent';
  argsHash: string;
  sessionId?: string;
  messageId?: string;
  issuedAt: number;
  expiresAt: number;      // 建议 30 秒以内
  oneTime: true;
  used: boolean;
}
```

CLI 执行时通过环境变量携带：

```bash
EVOLCLAW_DELEGATION_TOKEN=<opaque-token> \
ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member
```

不建议通过可见参数传递：

```bash
ec role assign ... --delegation-token <token>
```

因为命令行参数更容易进入日志和进程列表。

### 5.3 daemon 校验规则

daemon / ActionGateway 必须校验：

1. token 存在。
2. token 未过期。
3. token 未使用。
4. token 绑定的 operation 等于当前 CLI operation。
5. `hash(currentArgs)` 等于 token 的 `argsHash`。
6. token 绑定的 `selfAid` 等于 `--self`。
7. token 绑定的 actor 当前仍是 owner/admin。
8. 目标 role 不是 `owner` / `admin`。
9. 校验通过后立即标记 token 已使用。

### 5.4 优点

- 保留真实 CLI 执行路径，用户体验最接近普通 Bash。
- 同一套 CLI 可同时服务人类终端、ecweb/control、agent delegated 场景。
- CLI/daemon 自身具备二次鉴权，即使绕过 hook 也不能直接写配置。
- 更适合后续扩展到更多管理命令。

### 5.5 缺点

- 实现复杂度明显高于方案一。
- 需要 token 生命周期管理、一次性消费、过期清理。
- CLI 必须改造为“调用 daemon / ActionGateway”，不能本地直接写配置。
- 需要谨慎处理 token 泄漏、日志脱敏、并发重复执行。

### 5.6 适用场景

适合长期目标：

- 希望保留完整 CLI 行为；
- 管理命令既可能来自 agent Bash，也可能来自人类 CLI；
- 希望所有入口都统一走 daemon / ActionGateway；
- 后续会扩展大量 `ec config`、`ec role`、`ec trigger`、`ec session` 管理命令。

---

## 6. 两种方案对比

| 维度 | 方案一：Hook 短路执行 | 方案二：Hook 签发 token，CLI 执行 |
|---|---|---|
| Bash 是否真实执行 | 否，命中后阻止原始 Bash | 是，但必须携带有效 token |
| 权限上下文来源 | Hook 从 session/message 注入 | Hook 签发 token，daemon 校验 |
| CLI 是否需要改造 | 可少量或不改 | 必须改造，不能本地直接写配置 |
| daemon / ActionGateway 要求 | Hook 直接调用 handler 或 gateway | CLI 必须调用 daemon / gateway |
| 安全边界 | Hook + gateway | Hook + token + CLI + daemon |
| 防绕过能力 | agent 会话内强；终端 CLI 需另行保护 | 强，绕过 hook 无 token也不能执行 |
| 实现复杂度 | 中 | 高 |
| 用户体验 | 可能不像真实 CLI stdout | 最接近真实 CLI |
| 审计准确性 | 高，hook 执行即审计 | 高，daemon 最终审计 |
| 扩展大量管理命令 | 可以，但 hook 会变重 | 更适合 |
| 适合阶段 | 短中期落地 | 长期统一入口 |

---

## 7. 推荐路线

建议分两阶段实施。

### 阶段一：先做 Hook 短路执行

优先目标是解决 agent 会话内的权限安全问题：

```text
ec role assign/revoke
  ↓
hook 识别
  ↓
agent-delegated 鉴权
  ↓
ActionGateway 执行
  ↓
阻止原始 Bash
```

这样可以较快建立正确边界：

- `agent-tool` 不能执行 `role.assign`；
- `agent-delegated` 必须绑定 AUN 已认证 actor；
- 写配置必须走 ConfigManager；
- 原始 Bash 不再直接触碰权限变更。

### 阶段二：再升级为 token + CLI

当 `ec role`、`ec config`、`ec trigger`、`ec session` 等管理命令都需要统一 CLI 体验时，再引入一次性委托凭证：

```text
hook token
  ↓
CLI
  ↓
daemon / ActionGateway
```

这时 CLI 本身也应成为受控入口：

- 无 token、非 control、非 ecweb 的管理写操作一律拒绝；
- CLI 不直接写 `{evolclaw_home}/agents/{aid}/config.json`；
- CLI 不直接写 `{evolclaw_home}/agents/{aid}/relations/{peerKey}/config.json`；
- 所有写入都经 ConfigManager 和审计。

---

## 8. 不变量

无论采用哪种方案，都必须守住以下不变量：

1. `agent-tool` 不能直接执行管理权限变更。
2. `agent-delegated` 必须绑定 AUN 已认证消息发送者。
3. actor 身份不能由 Bash 参数声明。
4. owner/admin 的身份名单来自 config，能力边界来自代码。
5. 用户角色分配只能写用户角色，不能通过分配产生 owner/admin。
6. 配置写入只能走 ConfigManager / 配置 API。
7. 所有管理写操作必须有审计日志。
8. 未识别、解析失败、鉴权失败时一律 fail-closed。

---

## 9. 最终建议

如果目标是尽快安全支持：

```bash
ec role assign --self bot.aid.pub --peer aun#alice.aid.pub --role member
```

推荐先采用 **方案一：Hook 短路执行**。

如果目标是长期统一所有 CLI 管理命令入口，则在方案一稳定后演进到 **方案二：Hook 签发一次性委托凭证，CLI 执行**。

一句话总结：

> Bash 可以保留为命令表达形式，但权限变更不能信任普通 Bash 执行边界。
> 短期用 hook 短路执行，长期用一次性委托凭证把 CLI 纳入统一 ActionGateway。
