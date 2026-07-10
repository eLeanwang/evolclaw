# ec config 统一语义、任务委托与 Owner 授权方案

> 状态：已实施
>
> 日期：2026-07-10

## 1. 实施结论

本次升级同时解决了三个问题：

1. `menu.cli`、本地 CLI 和 daemon 不再分别解释 `ec config` 参数。
2. 托管 Agent 发起的配置命令不再只凭可伪造或过期的 `sessionId` 识别操作者。
3. Agent owner、daemon owner、admin、member、visitor 和自定义角色具有明确且不可绕过的权限边界。

最终不变量如下：

- 16 个 `config` 子命令全部由 `resolveConfigCommand()` 严格解析。
- 字段命令继续兼容 `resolveConfigOperation()`，但它只是完整 resolver 的 field-only 适配器。
- 鉴权和执行消费同一个 `ResolvedConfigCommand`，不重新解析 argv。
- menu 只对 canonical argv 授权，并且只 spawn canonical argv。
- 托管 Agent 的所有 `ec config` 命令都通过 daemon IPC 执行，不在子进程本地落盘。
- IPC 同时要求 sessionId 和当前任务的 256-bit 随机委托令牌。
- daemon 每次请求都根据令牌中绑定的当前消息发送者重新计算角色和 daemon-owner 身份。
- 群聊中的配置 mutation 只能作用于当前 relation，任何角色都不能绕过。
- Agent owner 对当前 Agent 和当前 relation 拥有完整配置权限。
- daemon owner 是全局权限超集，但群聊 mutation ceiling 仍然有效。
- owner 的 dangerous config 命令授权后直接执行，不增加确认卡。

## 2. 威胁模型与身份来源

### 2.1 旧问题

旧的托管入口只有：

```text
EVOLCLAW_SESSION_ID -> session.metadata.peerId -> role
```

这有两个问题：

- 子进程只有 session 能力，没有“当前任务由谁发起”的证明。
- 群聊 session 会长期复用，`session.metadata.peerId` 可能仍是上一位发送者，导致当前 visitor
  被错误识别为旧 owner，或当前 owner 被错误识别为旧 visitor。

### 2.2 新的可信链

ResponseEngine 在准备调用模型时，从当前 `Message` 捕获不可变上下文并签发令牌：

```ts
interface AgentDelegationGrant {
  tokenHash: string;
  sessionId: string;
  taskId: string;
  messageId?: string;
  actorId: string;
  channel: string;
  channelType: string;
  chatType: 'private' | 'group';
  selfAid: string;
  peerKey: string;
  issuedRole: string;
}
```

规则：

- token 使用 `crypto.randomBytes(32)` 生成，即 256-bit 随机值。
- registry 只保存 SHA-256 hash，不保存明文 token。
- token 通过 `EVOLCLAW_DELEGATION_TOKEN` 注入 Claude、Codex、Gemini 的任务环境。
- token 不进入 `TaskRuntimeContext`，也不会被现有 task-context IPC 查询返回。
- 一个 token 可在同一活跃任务内执行多次 config 调用。
- token 绑定 session、task、message sender、当前 Agent 和当前 relation。
- 新任务签发时撤销同 session 的旧 token。
- 正常完成、失败、中断时撤销；daemon 重启后内存 registry 自然清空。
- 缺少 token 返回 `DELEGATION_REQUIRED`。
- 伪造、撤销或跨 session token 返回 `INVALID_DELEGATION`。

daemon 不信任 `issuedRole` 作为最终角色。每次请求都使用 `actorId/selfAid/chatType/peerKey`
重新读取当前 owners、admins、relation role 和 process owners。

## 3. 统一命令模型

`ResolvedConfigCommand` 是判定后的结构化事实，不包含 actor 或授权结论：

```ts
type ResolvedConfigCommand =
  | ResolvedConfigOp
  | ResolvedScopedConfigCommand
  | ResolvedGlobalConfigCommand;
```

### 3.1 字段命令

| 子命令 | 安全字段 operation | 敏感/未知/process/defaults operation |
|---|---|---|
| `get` | `config.get` | `config.read` |
| `set` | `config.set` | `config.write` |
| `unset` | `config.unset` | `config.write` |

敏感字段和 process/defaults 字段在 resolver 阶段即标记 `dangerous: true`。

### 3.2 Scoped 管理命令

| 子命令 | operation | scope 来源 | mutation |
|---|---|---|---|
| `show` | `config.show` | selector | 否 |
| `effective` | `config.effective` | selector | 否 |
| `fields` | `config.fields` | selector | 否 |
| `validate` | `config.validate` | selector | 否 |
| `init` | `config.init` | selector | 是 |

### 3.3 Global 管理命令

| 子命令 | operation | mutation |
|---|---|---|
| `list` | `config.list` | 否 |
| `snapshot` | `config.snapshot` | 是 |
| `prune` | `config.prune` | 是 |
| `history` | `config.history` | 否 |
| `diff` | `config.diff` | 否 |
| `restore` | `config.restore` | 是 |
| `current` | `config.current` | 否 |
| `boots` | `config.boots` | 否 |

所有管理命令具有独立 operation，并标记 `dangerous: true`。它们不再伪装为
`config.read/config.write`。所有 global 命令都是 daemon-owner-only。

## 4. 严格语法和 canonical argv

### 4.1 Selector

| selector | 配置文件级别 |
|---|---|
| `--process` / `--evolclaw` | process |
| `--default` | defaults |
| `--self <aid>` | agent |
| `--self <aid> --peer <peerKey>` | relation |

约束：

- `--peer` 不能脱离 `--self`。
- process、defaults、self 三类 selector 互斥。
- 重复 option、未知 option、缺少 value、多余 positional 一律拒绝。
- `set/unset/init` 必须有 selector；menu/daemon 可注入当前 relation 后再解析。
- `show/effective/validate` 在本地 CLI 必须显式选择 scope；托管路径默认当前 relation。
- `fields` 允许不带 selector，用于查看 agent schema；托管路径仍默认当前 relation。
- `unset --process` 拒绝，因为 process 层没有可回落的下层。
- 显式 selector 永远不会被默认 relation 覆盖。
- `--format` 只接受 `json` 或 `text`。

### 4.2 Global 参数

- `snapshot [--full] [--desc <text>]`
- `prune [--keep-full <N>] [--keep-delta <N>] [--yes]`
- `diff <v1> <v2>`
- `restore <version>`
- `boots [-n <N> | --num <N>]`
- 其余 global 命令不接受业务 positional。

数值参数必须是安全整数；保留数允许 0，boots 条数必须大于 0。

### 4.3 确定性

canonical 顺序固定，满足：

```text
resolve(input) == resolve(input)
resolve(resolve(input).canonicalArgv) == resolve(input)
```

menu 的鉴权、spawn 和 argv audit hash 均使用 canonical argv。

## 5. 三条执行路径

### 5.1 人类本地 CLI

```text
argv
  -> resolveConfigCommand
  -> executeResolvedConfigCommand
  -> config files
```

本地 CLI 是受信运维入口，不做会话角色鉴权，但仍使用相同严格语法和执行服务。

### 5.2 menu.cli

```text
menu argv + current relation
  -> parseCliIntent
  -> resolveConfigCommand
  -> authorizeResolvedConfigCommand
  -> canonical argv
  -> spawn CLI canonical argv
  -> child resolveConfigCommand
  -> executeResolvedConfigCommand
```

拒绝分支不会 spawn。dangerous owner 命令授权后直接执行，不进入确认卡流程。

### 5.3 托管 Agent CLI

```text
ec config <any-subcommand>
  + EVOLCLAW_SESSION_ID
  + EVOLCLAW_DELEGATION_TOKEN
  -> config.op IPC
  -> validate active delegation
  -> load session
  -> recompute current role + daemon owner
  -> resolveConfigCommand(defaultRelation)
  -> non-bypassable ceilings
  -> role/grant/field authorization
  -> audit
  -> execute the same resolved command
```

IPC 失败返回 `DAEMON_UNAVAILABLE`，绝不回退到本地配置写入。

## 6. 授权顺序

授权严格按以下顺序执行：

1. 校验任务委托 token 和 session 绑定。
2. 完整解析命令，得到 operation、scope、mutation、field 和 canonical argv。
3. 检查 operation 是否允许 `agent-tool` / `menu.cli` source。
4. 检查当前 Agent 和当前 relation 目标约束。
5. 应用不可绕过 ceiling。
6. daemon owner 或 Agent owner 在 ceiling 内直通。
7. 其他角色匹配 command permission、dangerous grant、scope 和字段策略。
8. 审计 allow/deny。
9. 只在 allow 后执行同一个 resolved command。

### 6.1 不可绕过 Ceiling

- relation target 必须同时满足 `self === current selfAid` 和 `peerKey === current peerKey`。
- agent target 必须满足 `self === current selfAid`。
- 群聊中的任何 mutation 都必须是当前 relation scope。
- Agent owner 不能访问 process、defaults 或 global config。
- global config 只能由 daemon owner 使用。
- 非管理角色（包括自定义角色）只能访问当前 relation config。

`targetCurrentAgentOnly` 与 `currentRelationOnly` 的双约束是有意保留的纵深防御。

## 7. Owner 权限矩阵

| 调用者 | 私聊 | 群聊 |
|---|---|---|
| daemon owner | process/defaults/当前 Agent/当前 relation/global 全部能力 | 读能力保留；mutation 仅当前 relation |
| Agent owner | 当前 Agent + 当前 relation 全部能力，含敏感字段 | 可读当前 Agent/当前 relation；mutation 仅当前 relation |
| admin | 不享受 owner 直通，按内置 command/field permission | 同左，并受群聊 ceiling |
| member/visitor/custom | 仅当前 relation，按显式 grant 和字段权限 | 仅当前 relation，按显式 grant 和字段权限 |

daemon owner 即使没有 Agent role，也会在入站 access gate 前映射为有效 `owner` identity，避免
`role=none` 在 Agent 执行前被错误拒绝。

## 8. 白名单、黑名单与危险 Grant

### 8.1 安全字段

`config-field-policy.ts` 将允许用户平面访问的字段归类为：

- `safe-scalar`
- `safe-readonly-object`

非 owner 访问安全字段需要：

- 命中 `config.get/set/unset` 或 `config.*`；category/global wildcard 不算显式 config grant。
- 命中 role field permission。
- 写入需要 `allowOverride: true`。
- set 值满足类型、enum、`allowedModels` 和 `allowedValues`。
- readonly object 只能读取。

### 8.2 敏感/未知字段

`owners/admins/roles/channels/aun/models/projects/capabilities/debug/observable` 等身份、策略、
凭证或进程字段，以及 unknown 字段，都会升级为 `config.read/config.write` dangerous operation。

除 owner 直通外，危险字段必须同时满足：

1. command permission key 与 operation 完全相等。
2. `allow: true`。
3. `dangerous: true`。
4. 显式且非空的 `scopes`。
5. 显式且非空的 `constraints.allowedConfigKeys`，并包含目标 field。

`*`、`config.*`、`category:*` 和 `dangerous:*` 都不能隐式授予危险 config。

### 8.3 管理命令

非 owner 获得 scoped 管理能力时，必须使用完全匹配的 operation，例如：

```json
{
  "config.show": {
    "allow": true,
    "dangerous": true,
    "scopes": ["relation"]
  }
}
```

wildcard 或 category grant 不能授予管理命令。global 命令无论如何仍是 daemon-owner-only。

## 9. 共享执行服务

`config-operation-service.ts` 统一实现所有子命令：

- get：process 单层读取；其他 scope 使用 effective field + source。
- set：按 resolver 给出的 route 写入；list 保留 append-union。
- unset：只删除目标层叶子，不修改下层。
- show/effective/fields：返回结构化数据供 CLI 和 IPC 共用。
- init：只物化解析后的目标文件。
- snapshot/history/diff/restore/prune/current/boots：直接调用共享 snapshot/boot 服务。
- validate：使用 `validateConfigFile()` 读取原始 JSON 并调用纯 `validateConfig()`。

`validate` 不再借用 `write()` 做校验，因此不会迁移、重写或触碰目标文件 mtime。

## 10. 审计

每个 `agent-tool config.*` 请求，无论安全 allow、dangerous allow 还是 deny，都会记录：

- actorId
- taskId / messageId
- 当前重新计算后的 role
- daemon-owner 标记
- operation / scope / dangerous
- current selfAid / peerKey
- decision / reason / matched rule
- canonical argv hash

审计不记录明文 delegation token。

## 11. 主要代码变更

| 文件 | 职责 |
|---|---|
| `src/core/auth/agent-delegation.ts` | token 签发、hash 存储、校验和撤销 |
| `src/core/message/response-engine.ts` | 按当前 Message 签发 token 并注入 runner |
| `src/agents/*-runner.ts` | Claude/Codex/Gemini 传播任务环境 |
| `src/config/resolved-config-op.ts` | 16 子命令统一 resolver 和 canonical argv |
| `src/config/config-operation-service.ts` | 16 子命令共享执行服务 |
| `src/config/config-manager.ts` | 无副作用文件 schema 校验 |
| `src/core/command/cli-intent-parser.ts` | resolved command 到 intent 的唯一适配 |
| `src/core/command/command-permission.ts` | owner 直通、ceiling、精确 grant 和字段策略 |
| `src/core/command/menu-handler.ts` | canonical 授权与 spawn |
| `src/core/command/command-handler.ts` | token 校验、身份重算、审计和 daemon 执行 |
| `src/core/auth/auth-gateway.ts` | daemon owner 入站有效 owner identity |
| `src/ipc.ts` | 带 delegationToken 的 `config.op` 协议 |
| `src/cli/config.ts` | 本地执行与全部托管命令 IPC 分流 |

## 12. 验收与完成报告

已覆盖以下回归：

- 16 子命令严格语法、operation 映射和 canonical 幂等。
- 缺失、伪造、撤销、跨 session token。
- Claude/Codex/Gemini runtime token 传播。
- 群 session 保存旧 owner、当前 visitor 时按 visitor 拒绝。
- 群 session 保存旧 visitor、当前 owner 时按 owner 放行 relation mutation。
- Agent owner 私聊读取/设置/删除 `owners/admins` 等敏感字段。
- Agent owner 的 process/default/global 请求拒绝。
- daemon owner 私聊 process 和 global 请求放行。
- daemon owner/Agent owner 群聊 agent/process/global mutation 拒绝。
- 自定义角色危险字段和管理命令只接受 exact dangerous grant。
- wildcard/category/dangerous wildcard 不能授予危险 config。
- 合法 relation 写只修改 `relations/<peerKey>/config.json`，不修改 Agent 文件。
- `validate` 内容和 mtime 均不变化。
- daemon owner 在入站 access gate 前映射为有效 owner。

工程验收：

- `npm run build`：通过。
- 定向测试：通过。
- `npm test`：通过，79 个测试文件、983 项测试。
- `git diff --check`：通过。

## 13. 后续边界

1. 本次只收紧 `config.*`。其他既有 `write-own` operation 暂不全局改为 relation-only，待旧前端/
   menu 路径完成迁移后分期处理。
2. delegation token 证明“当前任务允许 Agent 代表当前发送者调用 config”，不是通用 shell sandbox。
3. 若未来开放任意 object 写入，必须同时增加结构化 value parser、schema 校验和字段级授权，不能
   回退到任意 JSON 字符串写入。
