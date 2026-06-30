# 命令执行角色权限设计

> 文档版本：v0.1  
> 日期：2026-06-29  
> 状态：设计草案  
> 相关背景：远程详情页通过 `menu.action name=cli action=exec` 获取模型列表时，guest 角色被 `/cli` owner-only 前置权限拦截，导致后续 CLI 内部的角色模型过滤没有机会生效。

---

## 1. 结论

各种命令执行权限需要纳入角色权限体系。即使是原始 CLI、shell 执行、远程命令执行这类高危能力，也不应该在代码里写死为某个角色专属，而应该作为独立能力点进入角色配置。

推荐方案是：

1. 将命令能力抽象成稳定的“能力点 / 操作 ID”，例如 `model.list`、`model.current`、`model.use`、`file.list`、`trigger.create`。
2. 角色只配置这些规范化能力点的允许、拒绝、作用域和约束。
3. slash 命令、menu 协议、远程 CLI 透传、ctl/IPC 都先归一化为同一个能力点，再进入统一授权器判断。
4. 通用 `/cli exec`、shell/RCE 等能力默认不授予普通角色，但可以通过显式高危能力点授权给任意角色。

一句话：角色权限应该管理“用户能做什么”；`owner/admin/guest` 只是默认策略名，不应该成为代码里的硬边界。

---

## 2. 当前问题

### 2.1 权限入口分散

当前系统至少存在以下命令入口：

| 入口 | 示例 | 当前主要权限来源 | 问题 |
|---|---|---|---|
| slash 命令 | `/model`、`/file`、`/trigger` | `guardRoleCommand` + handler 内部判断 | 规则分散，很多地方硬编码 owner/admin/guest |
| menu.query/update/action | `menu.action name=file action=list` | `menu-handler.ts` 内部判断 | 与 slash 命令不完全对齐 |
| 远程 CLI 透传 | `menu.action name=cli action=exec` | `/cli` owner-only + CLI 白名单 | 太粗：guest 无法执行安全的模型查询 |
| 本地 CLI | `evolclaw model list` | 本地用户进程权限 + CLI 内部校验 | 与远程角色上下文需要桥接 |
| ctl / IPC | `ctl setmodel` 等 | IPC/daemon 内部校验 | 需要和角色模型权限保持一致 |
| baseagent 工具执行 | Claude/Codex tool call | `permissionMode`、dangerous command check | 这是运行时工具权限，不应和用户菜单命令混为一层 |

### 2.2 `/cli` 透传粒度过粗

目前 `/cli` 透传逻辑是：

```text
menu.action name=cli action=exec
  -> /cli
  -> identity.role 必须是 owner
  -> CLI_EXEC_WHITELIST
  -> spawn node dist/cli/index.js ...
```

这保证了安全，但也导致一个实际问题：

```text
guest 访问远程详情页
  -> 前端发送 model list --self <agent> --peer <user>
  -> /cli owner-only 拦截
  -> CLI 内部的角色模型过滤不会执行
  -> 前端可能显示缓存或默认全量列表
```

也就是说，我们已经在 CLI 内部实现了“按角色过滤模型”，但远程入口在进入 CLI 前被通用 `/cli` 权限挡住。

### 2.3 角色配置目前主要管理“配置字段”

当前 `roles.schema.3.json` 的 `permissions` 更像字段权限：

```json
{
  "baseagents.claude.model": {
    "default": "claude-haiku-4-5-20251001",
    "allowOverride": false,
    "allowedModels": ["claude-haiku-*"]
  },
  "permissionMode": {
    "default": "readonly",
    "allowOverride": false
  }
}
```

这适合约束模型、effort、chatmode、dispatch 等行为配置，但不适合直接表达“是否可以执行某个命令动作”。

---

## 3. 设计目标

1. 统一授权语义：同一个操作无论来自 slash、menu 还是受限 CLI，都应得到一致判断。
2. 支持角色可配置：owner/admin/member/guest/custom role 都能配置命令能力。
3. 高危能力显式化：任意 CLI、shell、RCE、文件删除、配置写入等都可以配置，但必须是独立能力点，不能被普通读写权限或隐式通配误放开。
4. 支持参数级约束：例如 guest 可以 `model.list/current`，但 `model.use` 必须继续受 `allowedModels` 和 `allowOverride` 约束。
5. 支持审计：授权决策应该能记录 actor、role、operation、scope、decision、reason。
6. 向后兼容：首期不破坏现有 `roles.schema.3.json` 字段权限；可以先代码内置策略，再升级 schema。

---

## 4. 核心概念

### 4.1 Operation ID

把所有外部命令归一化为稳定的操作 ID。

示例：

| Operation ID | 来源示例 | 说明 |
|---|---|---|
| `model.list` | `/model` 查询、`model list`、模型选择页 | 查询可用模型 |
| `model.current` | `model current` | 查询当前有效模型 |
| `model.use` | `/model <id>`、`model use <id>` | 切换模型 |
| `model.effort` | `/effort <level>`、`model effort <level>` | 切换 effort |
| `session.list` | `/session`、`/slist` | 列会话 |
| `session.create` | `/new` | 创建会话 |
| `session.rename` | `/rename` | 重命名会话 |
| `file.list` | `menu.action name=file action=list` | 目录列表 |
| `file.fetch` | `menu.action name=file action=fetch` | 拉取文件 |
| `trigger.list` | `/trigger list` | 查询 trigger |
| `trigger.create` | `/trigger create` | 创建 trigger |
| `agent.reload` | `/reload`、`menu.action name=agent action=reload` | 重载 agent |
| `system.restart` | `/restart`、`menu.action name=system action=restart` | 重启 daemon |
| `cli.exec.raw` | `/cli` 任意透传 | 原始 CLI 透传，高危能力点，默认只给 owner/admin，可显式授予任意角色 |
| `shell.exec` | shell 命令执行 | 高危能力点；当前若没有入口，先作为预留权限模型 |
| `rce.exec` | 任意远程命令执行 | 最高危能力点；用于未来显式开放完整 RCE 场景 |

Operation ID 是角色权限的基本单元，不是 CLI argv。

### 4.2 Scope

每次授权需要明确操作作用域。

| Scope | 含义 | 示例 |
|---|---|---|
| `relation` | 当前用户和当前 agent 的关系级 | `model.use --self A --peer U` |
| `agent` | 当前 agent 级 | `model use --self A` |
| `global` | daemon 全局 | 无 `--self` 的全局默认模型 |
| `process` | daemon 进程级 | restart、upgrade、gateway 配置 |
| `filesystem` | 文件系统读写 | file list/fetch |
| `control` | 控制 AID / IPC 管理面 | agent create/reload、system config |

首期应特别注意：

```text
guest 可以查询自己的 relation 级模型列表
guest 默认不应借 CLI 参数查询或修改其他 peer 的 relation 配置，但可通过显式能力点和 scope 约束覆盖
guest 默认不应修改 agent/global/process/control 级配置，但可通过显式授权覆盖
```

### 4.3 Action Type

为了降低配置复杂度，可以给操作分类：

| 类型 | 含义 | 默认策略 |
|---|---|---|
| `read` | 查询状态、列表、详情 | member/guest 可按范围开放 |
| `write-own` | 写当前用户自己的关系级偏好 | 取决于字段 `allowOverride` 和具体约束 |
| `write-agent` | 写 agent 默认配置 | admin/owner |
| `process` | 进程级控制 | daemon owner |
| `dangerous` | 原始 CLI、shell/RCE、网关凭证、任意文件/命令执行 | 默认关闭或仅给 owner/admin，但允许显式授予任意角色 |

---

## 5. 角色权限模型

### 5.1 推荐新增字段

长期建议把命令能力作为角色定义的独立字段，而不是塞进现有 `permissions` 字段权限里。

```ts
interface RoleDefinition {
  description: string;
  allowAccess?: boolean;
  permissions: Record<string, FieldPermission>;
  commandPermissions?: Record<string, CommandPermission>;
}

interface CommandPermission {
  allow: boolean;
  dangerous?: boolean;
  requireExplicitGrant?: boolean;
  scopes?: Array<'relation' | 'agent' | 'global' | 'process' | 'filesystem' | 'control'>;
  constraints?: {
    ownPeerOnly?: boolean;
    ownAgentOnly?: boolean;
    readonly?: boolean;
    requireFieldOverride?: string;
    allowedArgs?: Record<string, string[]>;
    argvAllowlist?: string[][];
    commandPatterns?: string[];
    cwdPolicy?: 'agentProject' | 'evolclawHome' | 'any';
    envAllowlist?: string[];
    timeoutMs?: number;
  };
  reason?: string;
}
```

示例：

```json
{
  "$schema_version": 4,
  "roles": {
    "guest": {
      "description": "访客",
      "allowAccess": true,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-haiku-4-5-20251001",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"]
        }
      },
      "commandPermissions": {
        "model.list": {
          "allow": true,
          "scopes": ["relation"],
          "constraints": {
            "ownPeerOnly": true,
            "ownAgentOnly": true,
            "readonly": true
          }
        },
        "model.current": {
          "allow": true,
          "scopes": ["relation"],
          "constraints": {
            "ownPeerOnly": true,
            "ownAgentOnly": true,
            "readonly": true
          }
        },
        "model.use": {
          "allow": true,
          "scopes": ["relation"],
          "constraints": {
            "ownPeerOnly": true,
            "ownAgentOnly": true,
            "requireFieldOverride": "baseagents.claude.model"
          }
        },
        "cli.exec.raw": {
          "allow": false,
          "dangerous": true,
          "requireExplicitGrant": true,
          "reason": "默认不授予原始 CLI 透传；如需要可显式打开"
        }
      }
    }
  }
}
```

如果确实希望 `guest` 拥有完整能力，也应该通过配置表达，而不是改代码里的角色判断：

```json
{
  "$schema_version": 4,
  "roles": {
    "guest": {
      "description": "访客，但被显式授予完整命令能力",
      "allowAccess": true,
      "permissions": {},
      "commandPermissions": {
        "*": {
          "allow": true,
          "reason": "允许所有普通命令能力"
        },
        "dangerous.*": {
          "allow": true,
          "dangerous": true,
          "requireExplicitGrant": true,
          "constraints": {
            "timeoutMs": 15000
          },
          "reason": "显式允许高危命令能力"
        }
      }
    }
  }
}
```

这里的关键点是：允许 `guest` 全权限是合法配置；系统只负责确保这是显式授权，并留下可审计的能力点。

### 5.2 为什么不复用现有 FieldPermission

不建议这样写：

```json
{
  "permissions": {
    "commands.model.list": {
      "default": true,
      "allowOverride": false
    }
  }
}
```

原因：

1. `FieldPermission.default` 是字段默认值语义，不适合表达动作授权。
2. 命令权限需要 scope、ownPeerOnly、ownAgentOnly、readonly 等约束。
3. 字段权限和动作权限生命周期不同，混在一起会让 ecweb、schema、diff 逻辑变复杂。

短期如果不想升级 schema，可以先用代码内置默认表实现；等策略稳定后再升 `roles.schema.4.json`。

---

## 6. 默认权限建议

### 6.1 内置角色默认操作矩阵

| Operation | owner | admin | member | guest | anonymous |
|---|---:|---:|---:|---:|---:|
| `model.list` relation | allow | allow | allow | allow | deny |
| `model.current` relation | allow | allow | allow | allow | deny |
| `model.use` relation | allow | allow | allow if field allows | allow if field allows | deny |
| `model.use` agent/global | allow | allow agent | deny | deny | deny |
| `model.effort` relation | allow | allow | allow if field allows | allow if field allows | deny |
| `session.list/create/rename/delete` own private | allow | allow | allow | allow | deny |
| `file.list/fetch` project scope | allow | allow | optional | deny by default | deny |
| `trigger.list` own | allow | allow | allow own | allow own | deny |
| `trigger.create/update/delete` | allow | allow | optional | deny | deny |
| `agent.reload` own agent | allow | allow own | deny | deny | deny |
| `system.restart/upgrade` | allow | allow | deny | deny | deny |
| `gateway.*` | allow | allow | deny | deny | deny |
| `cli.exec.raw` | allow | allow | deny | deny | deny |
| `shell.exec` / `rce.exec` | deny by default | deny by default | deny | deny | deny |

说明：

- owner/admin/member/guest 只是默认建议，自定义角色可覆盖。
- 任何角色都可以被显式授予 `cli.exec.raw`、`shell.exec`、`rce.exec` 等高危能力；默认矩阵只定义出厂策略，不是代码硬限制。
- `model.use relation` 即使操作权限 allow，也必须继续执行模型字段权限校验：`allowedModels`、`allowOverride`、当前 role 推导。
- `process` 级操作应该优先看 daemon owner，而不是普通 agent role。

### 6.2 模型相关首期策略

为解决当前远程详情页模型列表问题，首期推荐：

| CLI argv | 归一化操作 | guest 是否允许 | 附加校验 |
|---|---|---:|---|
| `model list --self A --peer U` | `model.list` | 是 | `A` 必须是当前 channel 的 owning agent，`U` 必须是当前请求用户 |
| `model current --self A --peer U` | `model.current` | 是 | 同上 |
| `model info <id>` | `model.info` | 是 | 只读；返回内容可按 role 过滤或只允许已授权模型 |
| `model use <id> --self A --peer U` | `model.use` | 条件允许 | 先做 own scope 校验，再由 `validateModelSelectionForRole` 判断模型是否允许 |
| `model use <id> --self A` | `model.use` agent scope | 默认否 | 默认 admin/owner；可显式授予 guest |
| `model use <id>` | `model.use` global scope | 默认否 | 默认 admin/owner；可显式授予 guest |

这能保证：

```text
guest 能看到自己的可用模型列表
guest 看不到 owner/admin/member 才有的模型
guest 默认不能通过 --peer 伪造去看别人；如授予跨 peer/scope 能力，则按显式授权执行
guest 即使发 model use，也会被角色字段权限继续约束
```

---

## 7. 授权流程

建议新增统一授权器：

```ts
authorizeCommand({
  operation: 'model.list',
  role: 'guest',
  actorAid: 'user.agentid.pub',
  selfAid: 'bot.agentid.pub',
  peerAid: 'user.agentid.pub',
  channel,
  channelId,
  source: 'menu.cli',
  scope: 'relation',
  args: { model: undefined }
})
```

返回：

```ts
type CommandAuthorizationDecision =
  | { allow: true; role: string; operation: string; scope: string }
  | { allow: false; code: 'NO_PERMISSION' | 'NOT_ALLOWED' | 'SCOPE_MISMATCH'; reason: string };
```

流程：

```text
1. 解析入口
   slash/menu/cli/ctl -> CommandIntent

2. 归一化
   CommandIntent -> operation + scope + normalized args

3. 解析身份
   selfAid + actorAid + conversation -> effective role

4. 授权
   commandPermissions / 内置默认策略
   + scope 校验
   + ownPeerOnly / ownAgentOnly 校验

5. 业务约束
   model.use -> allowedModels / allowOverride
   file.fetch -> path sandbox
   trigger.* -> ownership

6. 执行
   只在授权成功后进入 handler 或受限 CLI passthrough

7. 审计
   记录 operation、role、actor、scope、allow/deny、reason
```

---

## 8. `/cli` 透传改造方案

### 8.1 将原始 `/cli` 作为高危能力点

`cli.exec.raw` 代表“无法归一化或未受控的 CLI 执行”。它不应该写死 owner-only，而应该进入角色权限，作为默认高危能力点。

例如：

```text
agent set ...
storage upload ...
gateway sync ...
任何不在白名单内的 argv
任何 command 字符串无法安全解析的请求
```

默认策略可以只给 owner/admin，但如果管理员把 `cli.exec.raw` 显式授予 guest，daemon 应该尊重配置。

建议将高危能力点单独命名，避免被普通 `*` 隐式包含：

```text
cli.exec.raw
shell.exec
rce.exec
stats.sqlReadonly
stats.rebuild
agent.delete
storage.delete
aid.delete
```

推荐规则：

```text
"*"             只匹配普通能力
"dangerous.*"   匹配高危能力
"cli.exec.raw"  精确授予原始 CLI 透传
```

这样可以同时满足两点：

1. guest 可以被配置成完全权限。
2. 完全权限是否包含高危能力是可审计、可显式表达的。

### 8.2 增加受限 CLI passthrough

对 `name=cli action=exec` 的 argv 做分流：

```text
if argv 可识别为安全操作:
  argv -> operation/scope/args
  authorizeCommand()
  执行业务 handler 或 execCliPassthrough
else:
  fallback 到 cli.exec.raw
  authorizeCommand(operation=cli.exec.raw)
```

首期只建议支持模型相关：

```text
model list
model current
model info
model check
model use
```

不要首期泛化到所有 CLI 命令。

### 8.3 参数防伪造

远程 menu CLI 的 `--self`、`--peer` 不能完全信任前端。

必须校验：

```text
--self == 当前 channel 归属 agent 的 aid
--peer == 当前请求 actor 的 aid 或当前 conversation peer
```

拥有对应能力点的角色可以有更宽权限，但仍建议在审计中记录跨 scope 操作。

---

## 9. 当前 CLI 透传白名单盘点

当前代码位置：`src/core/command/menu-handler.ts` 的 `CLI_EXEC_WHITELIST`。

```ts
const CLI_EXEC_WHITELIST: Record<string, '*' | Set<string>> = {
  status:  '*',
  model:   '*',
  stats:   '*',
  agent:   new Set(['list', 'show', 'get']),
  aid:     new Set(['list', 'show', 'lookup']),
  storage: new Set(['ls', 'quota']),
};
```

注意：这是“当前 `/cli` 透传在代码硬限制下允许 owner 执行的 CLI 范围”，不是未来角色配置的最终形态。后续应取消基于角色名的硬限制，改为能力点授权。其中 `model:*` 和 `stats:*` 需要进一步拆成子命令 / 参数级能力点。

### 9.1 `status`

| CLI | 当前白名单 | 操作 ID 建议 | 类型 | 建议角色策略 | 备注 |
|---|---:|---|---|---|---|
| `status` | 是，`*` | `system.status` | read | guest 可有限开放，admin/owner 全量 | 会暴露 daemon、实例、AID、运行路径等状态；对普通访客建议返回裁剪视图。 |

示例：

```json
["status"]
```

### 9.2 `model`

当前 `model` 在 `/cli` 白名单中是 `*`，实际子命令来自 `src/cli/model.ts`。

| CLI | 当前白名单 | 操作 ID 建议 | 类型 | 建议角色策略 | 备注 |
|---|---:|---|---|---|---|
| `model list` | 是 | `model.list` | read | guest/member/admin/owner 可按 relation scope 开放 | 必须按推导角色过滤 `allowedModels`。 |
| `model current` | 是 | `model.current` | read | guest/member/admin/owner 可按 relation scope 开放 | 查询当前有效模型和来源链。 |
| `model info <model-id>` | 是 | `model.info` | read | 可开放，但建议只允许查询已授权模型或裁剪价格信息 | 避免低权限用户枚举全部高成本模型详情。 |
| `model check` | 是 | `model.check` | read/diagnose | admin/owner 默认开放；guest 谨慎 | 会做网关连通性和模型可用性诊断，可能产生轻量调用。 |
| `model use <model-id>` | 是 | `model.use` | write-own / write-agent / write-global | relation scope 可按 `allowOverride + allowedModels` 条件开放；agent/global scope 默认 admin/owner，可显式授予其他角色 | 当前问题的关键命令之一。 |
| `model effort <level>` | 是 | `model.effort` | write-own / write-agent / write-global | 同 `model.use`，叠加 `baseagents.<ba>.effort` 字段权限 | `auto` 会清空显式 effort。 |
| `model reset` | 是 | `model.reset` | write | relation scope 条件开放；agent/global scope 默认 admin/owner，可显式授予其他角色 | 会清除指定作用域配置，需防止误清 agent/global 默认值。 |

常见 argv：

```json
["model", "list", "--self", "bot.agentid.pub", "--peer", "user.agentid.pub", "--format", "json"]
["model", "current", "--self", "bot.agentid.pub", "--peer", "user.agentid.pub", "--format", "json"]
["model", "use", "claude-haiku-4-5-20251001", "--self", "bot.agentid.pub", "--peer", "user.agentid.pub", "--format", "json"]
```

首期远程放行建议只覆盖：

```text
model.list/current/info/check/use
```

并强制：

```text
--self == 当前 channel 归属 agent AID
--peer == 当前请求 actor AID
scope == relation
```

`model effort/reset` 可以第二批再开放，因为它们更容易造成配置状态混乱。

### 9.3 `stats`

当前 `stats` 在 `/cli` 白名单中是 `*`，实际没有子命令，靠 flags 决定功能。这里风险比 `model` 更高，因为包含 `--rebuild` 写操作和 `--sql` 自定义 SQL。

| CLI / flags | 当前白名单 | 操作 ID 建议 | 类型 | 建议角色策略 | 备注 |
|---|---:|---|---|---|---|
| `stats` / `stats --today` | 是 | `stats.summary.today` | read | admin/owner；member/guest 只可看自己 relation 的裁剪数据 | 默认今日概览。 |
| `stats --hour/--week/--month` | 是 | `stats.summary.range` | read | 同上 | 时间范围汇总。 |
| `stats --summary` | 是 | `stats.summary` | read | 同上 | 总 token / cost。 |
| `stats --peers` | 是 | `stats.peers` | read | admin/owner | 会暴露对端列表和活跃信息。 |
| `stats --groups` | 是 | `stats.groups` | read | admin/owner | 会暴露群列表和统计。 |
| `stats --peer-detail <id>` | 是 | `stats.peerDetail` | read | admin/owner；relation owner 可看自己 | 需校验 peer 是否为当前 actor。 |
| `stats --session <id>` | 是 | `stats.session` | read | 会话可见者 | 需校验 session ownership / relation。 |
| `stats --session <id> --last` | 是 | `stats.sessionLast` | read | 会话可见者 | 用量详情。 |
| `stats --context <id>` | 是 | `stats.context` | read | admin/owner | 会暴露上下文构成。 |
| `stats --budget` | 是 | `stats.budget` | read | admin/owner；可考虑 relation 裁剪 | 预算状态。 |
| `stats --top-peers` | 是 | `stats.topPeers` | read | admin/owner | 排行信息，不建议 guest。 |
| `stats --top-models` | 是 | `stats.topModels` | read | admin/owner | 可暴露模型使用结构。 |
| `stats --traffic` | 是 | `stats.traffic` | read | admin/owner | 网络流量统计。 |
| `stats --task-calls <taskId>` | 是 | `stats.taskCalls` | read | admin/owner | 任务级模型调用明细。 |
| `stats --session-calls <id>` | 是 | `stats.sessionCalls` | read | 会话可见者 | 会话模型调用明细。 |
| `stats --sql "<select ...>"` | 是 | `stats.sqlReadonly` | read/dangerous | 默认 owner/admin；可显式授予任意角色 | 虽然只允许 SELECT，但仍是任意 SQL 查询，必须单独授权。 |
| `stats --rebuild` | 是 | `stats.rebuild` | write/ops/dangerous | 默认 owner/admin；可显式授予任意角色 | 会回填 cost 并重建 `usage_daily`，必须从通配白名单中拆出。 |

建议调整：

```text
不要继续把 stats:* 作为可角色化白名单。
先按 flags 映射到明确 operation。
stats --rebuild 和 stats --sql 必须是独立高危能力点，不能被 stats:* 隐式包含。
```

### 9.4 `agent`

当前 `/cli` 白名单只允许 `agent list/show/get`，虽然 `agent` CLI 本身还支持 new/enable/disable/set/ready/reload/delete/rename。

| CLI | 当前白名单 | 操作 ID 建议 | 类型 | 建议角色策略 | 备注 |
|---|---:|---|---|---|---|
| `agent list` | 是 | `agent.list` | read | admin/owner；member/guest 不建议全量 | 会暴露所有 agent、项目、通道、状态。 |
| `agent show <aid>` | 是 | `agent.show` | read | own agent admin/owner；低权限只可看当前 agent 裁剪信息 | 会暴露身份、配置、连接、会话、路径。 |
| `agent get <aid> <key>` | 是 | `agent.getConfig` | read | admin/owner；低权限仅允许安全 key 白名单 | 任意 key 读取可能暴露敏感配置。 |
| `agent new` | 否 | `agent.create` | write/control | daemon owner | 创建 agent。 |
| `agent enable <aid>` | 否 | `agent.enable` | write/control | daemon owner 或 agent owner/admin | 会热重载。 |
| `agent disable <aid>` | 否 | `agent.disable` | write/control | daemon owner 或 agent owner/admin | 会下线 agent。 |
| `agent set <aid> <key> <value>` | 否 | `agent.setConfig` | write/control/dangerous | 默认 owner/admin；可显式授予任意角色，建议严格 key 白名单 | 任意配置写入风险高。 |
| `agent ready <aid>` | 否 | `agent.ready` | write/control | bootstrap 内部或 owner | 生命周期状态写入。 |
| `agent reload [aid]` | 否 | `agent.reload` | process/control | 默认 daemon owner 或 agent owner/admin；可显式授予任意角色 | slash/menu 已有相关设计。 |
| `agent delete <aid> [--purge]` | 否 | `agent.delete` | destructive/dangerous | 默认 owner/admin；可显式授予任意角色 | `--purge` 会删除运行时数据。 |
| `agent rename` | 否 | `agent.rename` | deprecated | deny | 当前 CLI 已取消。 |

建议调整：

```text
agent get 即使当前白名单允许，也不应保持任意 key 可远程读。
后续应拆成 agent.getPublicProfile、agent.getRuntimeStatus、agent.getConfigKey 三类。
```

### 9.5 `aid`

当前 `/cli` 白名单只允许 `aid list/show/lookup`。`aid new/delete/agentmd` 没有放行。

| CLI | 当前白名单 | 操作 ID 建议 | 类型 | 建议角色策略 | 备注 |
|---|---:|---|---|---|---|
| `aid list` | 是 | `aid.listLocal` | read/sensitive | 默认 owner/admin；可显式授予任意角色 | 会列本地 AID、私钥/证书状态，建议单独授权。 |
| `aid show <aid>` | 是 | `aid.showLocal` | read/sensitive | 默认 owner/admin；可显式授予任意角色，或仅允许 show 当前 self AID 的裁剪信息 | 会暴露私钥是否存在、证书、agent.md 状态。 |
| `aid lookup <aid>` | 是 | `aid.lookupRemote` | read | admin/owner；低权限可考虑开放 | 远程探测 AID 是否存在 + 网关 + agent.md。 |
| `aid new <aid>` | 否 | `aid.create` | write/identity/dangerous | 默认 owner/admin；可显式授予任意角色 | 创建本地身份。 |
| `aid delete ...` | 否 | `aid.delete` | destructive/dangerous | 默认 owner/admin；可显式授予任意角色 | 删除本地 AID 或缓存。 |
| `aid agentmd put <aid>` | 否 | `aid.agentmdPut` | write/network/dangerous | 默认 owner/admin；可显式授予任意角色 | 签名上传 agent.md。 |
| `aid agentmd get <aid>` | 否 | `aid.agentmdGet` | write-local/read-network | 默认 owner/admin；可显式授予任意角色 | 下载并持久化 agent.md。 |

建议调整：

```text
aid list/show 当前虽然在 owner-only /cli 下相对可控，但未来应作为敏感能力点配置。
如果低权限需要身份信息，也可以做专门的 public profile API；如果确实要透传 aid show，则必须显式授权。
```

### 9.6 `storage`

当前 `/cli` 白名单只允许 `storage ls/quota`。`upload/download/rm` 没有放行。

| CLI | 当前白名单 | 操作 ID 建议 | 类型 | 建议角色策略 | 备注 |
|---|---:|---|---|---|---|
| `storage ls <aid> [prefix]` | 是 | `storage.list` | read | 默认 owner/admin；低权限如开放需限定 own AID / prefix | 会列对象名。 |
| `storage quota <aid>` | 是 | `storage.quota` | read | 默认 owner/admin；低权限如开放只可查 own AID | 配额信息。 |
| `storage upload <aid> ...` | 否 | `storage.upload` | write | 默认 owner/admin；可显式授予任意角色，建议强路径和大小限制 | 会上传文件。 |
| `storage download <aid> ...` | 否 | `storage.download` | write-local/read | 默认 owner/admin；可显式授予任意角色 | 会写本地文件。 |
| `storage rm <aid> <remote-path>` | 否 | `storage.delete` | destructive/dangerous | 默认 owner/admin；可显式授予任意角色 | 删除对象。 |

建议调整：

```text
storage ls/quota 可保留为默认 owner/admin 远程运维能力。
guest/member 是否通过 CLI 透传开放由角色配置决定；如果开放，必须限定 own AID / prefix。
```

### 9.7 当前白名单风险汇总

| 模块 | 当前白名单粒度 | 主要风险 | 建议 |
|---|---|---|---|
| `status` | 顶层 `*` | 信息暴露 | 可保留 owner/admin；guest 用裁剪 API。 |
| `model` | 顶层 `*` | 写 relation/agent/global 配置 | 立即拆成子命令 + scope 校验。 |
| `stats` | 顶层 `*` | `--rebuild` 写库、`--sql` 任意 SELECT、统计隐私 | 必须拆 flags；`--rebuild`/`--sql` 作为高危能力点显式授权。 |
| `agent` | 子命令白名单 | `get` 任意 key 读敏感配置 | 限 key 或拆 public/status/config。 |
| `aid` | 子命令白名单 | 本地身份/私钥状态暴露 | 默认不授予普通角色；可显式授权。 |
| `storage` | 子命令白名单 | 对象枚举 | 限 own AID / prefix。 |

首期最小改动建议：

```text
1. 取消 `/cli` 基于角色名的硬编码 owner-only，改为 `authorizeCommand(operation)`。
2. 首期先把 model list/current/info/check/use 映射成普通能力点。
3. stats 暂缓全面角色化；先拆出 `stats.sqlReadonly`、`stats.rebuild` 两个高危能力点。
4. agent/aid/storage 可以保持默认不授予普通角色，但不写死角色名；后续由配置显式开放。
```

---

## 10. 和现有角色字段权限的关系

命令权限解决“能不能发起这个动作”。

字段权限解决“这个动作能写什么值”。

两者必须叠加：

```text
model.use
  -> commandPermissions['model.use'] 允许 relation scope
  -> baseagents.claude.model.allowOverride 为 true
  -> target model 匹配 allowedModels
  -> 写入 relation behavior
```

如果命令权限 allow，但字段权限 deny，仍然拒绝。

如果字段权限 allow，但命令权限 deny，也拒绝。

---

## 11. 与 permissionMode 的边界

`permissionMode` 是 baseagent 工具执行策略，主要约束模型在执行任务时能否读写文件、执行危险命令、是否请求确认。

命令执行角色权限是用户对 daemon 的控制能力，主要约束用户能否通过 slash/menu/CLI 修改配置、查询信息、控制进程。

两者不能互相替代：

| 能力 | 应由 command permission 管 | 应由 permissionMode 管 |
|---|---:|---:|
| guest 能否调用 `model list` | 是 | 否 |
| guest 能否切换自己的 relation 模型 | 是 | 否 |
| 模型执行 Bash `rm -rf` 是否拦截 | 否 | 是 |
| Claude/Codex tool call 是否需要审批 | 否 | 是 |
| daemon 是否允许远程 restart | 是 | 否 |

---

## 12. 实施计划

### 阶段 1：修复当前模型远程访问链路

目标：让远程详情页模型列表和角色权限真正挂钩。

工作项：

1. 新增 `CommandIntent` 和模型 CLI argv 解析函数。
2. 将 `/cli` 入口改为先解析 operation，再调用 `authorizeCommand()`，不再使用 `identity.role === 'owner'` 硬编码判断。
3. 校验 `--self` / `--peer` 只能指向当前 agent 和当前 actor。
4. `model list/current/use/check` 继续使用 CLI 内部角色推导和模型权限校验。
5. 增加日志：`menu.action cli` 的 operation、role、decision、reason。
6. 增加测试：
   - guest `model list --self A --peer U` 返回 guest 模型列表。
   - guest `model list --self A --peer other` 拒绝。
   - guest `model use` 不允许越过 `allowedModels`，除非该角色也被显式授予对应字段覆盖能力。
   - admin/owner 行为保持兼容。

### 阶段 2：抽出统一授权器

目标：把 slash/menu/受限 CLI 的判断收口。

工作项：

1. 新增 `src/core/command/command-permission.ts`。
2. 定义 `OperationId`、`CommandScope`、`CommandIntent`、`CommandPermission`。
3. 先使用内置默认策略，不改 schema。
4. 接入模型、file、trigger、session 的核心路径。
5. 审计日志统一输出。

### 阶段 3：升级 roles schema

目标：允许 ecweb 编辑角色命令权限。

工作项：

1. 新增 `roles.schema.4.json`。
2. `RoleDefinition` 增加 `commandPermissions`。
3. `roles-merge` 支持 `commandPermissions` diff/merge。
4. `ConfigManager.writeRoles()` 支持 schema v4 写入。
5. ecweb 角色详情页增加“命令权限”配置区。

### 阶段 4：扩展更多命令

优先顺序：

1. model
2. session
3. trigger
4. file
5. agent read-only
6. dangerous/process/control 类命令

dangerous/process/control 类命令进入配置后，默认只授予 owner/admin；如果业务需要，可以显式授予 guest/member/custom role。

---

## 13. 风险与约束

### 13.1 不允许用字符串白名单替代能力点

不建议这种设计：

```json
{
  "allowedCli": [
    "model *",
    "agent *",
    "storage *"
  ]
}
```

原因：

- argv 组合太多，容易漏掉写操作。
- CLI 未来新增子命令会扩大权限面。
- 参数伪造难审计。
- 它无法区分普通能力和高危能力。

推荐把同样意图改成能力点：

```json
{
  "commandPermissions": {
    "model.*": { "allow": true },
    "agent.list": { "allow": true },
    "agent.show": { "allow": true },
    "storage.list": { "allow": true },
    "storage.quota": { "allow": true },
    "cli.exec.raw": {
      "allow": true,
      "dangerous": true,
      "requireExplicitGrant": true
    }
  }
}
```

### 13.2 不能只靠前端隐藏按钮

前端可以根据角色隐藏入口，但 daemon 必须做最终授权。

当前问题正说明：前端发送了 `model list`，服务端路径没有正确进入角色模型过滤。权限必须在 daemon 侧闭环。

### 13.3 自定义角色需要字符串 role 支持

授权器必须接受任意 role string，不能只写死 owner/admin/member/guest/anonymous。

默认策略可以按以下方式 fallback：

```text
unknown custom role
  -> 读取 role definition
  -> 没有 commandPermissions 时按 member 或最小权限 fallback
```

建议默认 fallback 到更保守的 `guest`，除非已有文档明确 custom role 继承 member。

---

## 14. 推荐落地决策

1. 需要把命令执行能力纳入角色权限体系。
2. 首期不要升级 schema，先用内置 `OperationId` 策略修复模型链路。
3. `/cli` 不再保持 owner-only 硬编码，而是根据 `cli.exec.raw`、`model.*` 等能力点授权。
4. 受限白名单必须做 `--self/--peer` 防伪造校验。
5. `model.use` 必须同时经过命令授权和 `allowedModels` 字段权限校验。
6. 后续再升级 `roles.schema.4.json`，把普通能力和高危能力都暴露给 ecweb，但高危能力必须有明确标识和审计。

---

## 15. 当前模型问题的直接解释

当前 guest 远程访问模型列表没有变化，根因是：

```text
前端 menu.action name=cli
  -> daemon 收到请求
  -> /cli 要求 identity.role === owner
  -> guest 被 NO_PERMISSION 拦截
  -> execCliPassthrough 没执行
  -> model list 内部角色过滤没有机会运行
```

因此直接修 `src/cli/model.ts` 还不够，还必须修远程命令入口的授权分层。

正确链路应该变成：

```text
前端 menu.action name=cli argv=["model","list","--self",A,"--peer",U]
  -> 识别为 operation=model.list scope=relation
  -> 校验 actor=U、self=A、role=guest
  -> 授权通过
  -> 执行 model list
  -> CLI 内部按 guest allowedModels 过滤
  -> 返回 guest 可用模型列表
```
