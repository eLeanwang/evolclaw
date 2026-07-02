# 命令执行角色权限设计

> 文档版本：v1.0  
> 日期：2026-06-30  
> 状态：✅ **已实施** (2026-06-30)  
> 背景：远程详情页通过 `menu.action name=cli action=exec` 获取模型列表时，guest 角色在 `/cli` 入口被 `identity.role === 'owner'` 前置判断拦截，导致 `src/cli/model.ts` 内部已有的角色模型过滤没有机会执行。这个问题不是单点 bug，而是命令执行入口缺少统一角色权限模型的表现。

---

## 实施状态

✅ **Phase 1: 基础架构** - 已完成
- ✅ 类型定义 (src/types.ts)
- ✅ Schema v4 (kits/schemas/roles.schema.4.json)
- ✅ Operation Registry (src/core/command/operation-registry.ts)

✅ **Phase 2: 解析与授权** - 已完成
- ✅ CLI Intent Parser (src/core/command/cli-intent-parser.ts)
- ✅ Command Permission (src/core/command/command-permission.ts)
- ✅ Command Audit (src/core/command/command-audit.ts)

✅ **Phase 3: 配置集成** - 已完成
- ✅ roles.ts 升级到 v4
- ✅ roles-merge.ts 支持 commandPermissions
- ✅ config-manager.ts 添加 v3→v4 迁移

✅ **Phase 4: 入口改造** - 已完成
- ✅ menu-handler.ts /cli 入口改造

✅ **Phase 5: 测试与文档** - 已完成
- ✅ 单元测试
- ✅ 文档更新

---

## 1. 结论

命令执行权限需要一次性纳入统一角色权限体系，而不是只给 `/cli model list` 做特例。最终状态应该是：

1. 所有用户可触发的命令入口都先归一化为稳定的 `OperationId`。
2. 所有入口都调用同一个 `authorizeCommand()`。
3. 角色配置通过 `roles.schema.4.json` 的 `commandPermissions` 显式表达命令能力。
4. 普通能力和高危能力都能授权给任意 role，但高危能力必须有 `dangerous=true` 元数据、显式 grant、审计日志和额外约束。
5. 原始 `/cli exec` 不再是代码里的 owner-only 特例，而是 `cli.exec.raw` 这个高危 operation。
6. 能安全解析的 CLI argv 必须映射到具体 operation；不能安全解析的 argv 一律映射到 `cli.exec.raw`。
7. `model.use` 等写操作必须同时通过命令授权和字段权限约束，例如 `allowOverride`、`allowedModels`。
8. 进程级能力必须区分 `daemon owner` 与普通 agent-channel `owner`，不能混用同一个字符串角色边界。

一句话：`owner/admin/member/guest/custom role` 只是默认策略名，不是代码硬边界；真正的权限边界应该是 operation、scope、constraints、dangerous metadata 和可审计授权决策。

---

## 2. 当前代码事实

### 2.1 `/cli` 当前链路

当前远程 menu action 入口大致为：

```text
MessageBridge.handleMenuAction()
  -> CommandHandler.execMenuAction()
  -> src/core/command/menu-handler.ts
  -> cmdBase === '/cli'
  -> action 必须为 exec
  -> identity.role 必须为 owner
  -> CLI_EXEC_WHITELIST
  -> execCliPassthrough(argv)
  -> spawn node dist/cli/index.js ...
```

当前白名单：

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

问题：

1. `/cli` 在 argv 解析之前用 `identity.role === 'owner'` 拦截。
2. `model list --self A --peer U` 这类只读、安全、可按 role 过滤的命令也被挡住。
3. `model:*` 和 `stats:*` 白名单粒度过粗，一个顶层白名单同时包含读、写、诊断和高危 flags。
4. 授权结果不可配置、不可审计、不可扩展到 custom role。

### 2.2 进程级 owner 与 channel role 已经分层

代码里已经有两类不同权限主体：

| 主体 | 来源 | 用途 |
|---|---|---|
| channel role | `session.identity.role` / `resolvePeerRoleDetail()` | 关系级、agent 自管理、普通菜单/命令 |
| daemon owner | `evolclaw.json.owners` | `/system` 等进程级操作、control channel |

`/system` 已经改为查 `evolclaw.json.owners`，而 `/cli` 仍用 channel role owner-only。统一授权器必须把这两个主体都放进 context，而不是只传 `role`。

### 2.3 ECWeb 与 control channel 当前不暴露 CLI

当前代码：

```text
execMenuForEcweb()   -> name=cli 直接 NOT_SUPPORTED
execMenuForControl() -> name=cli 直接 NOT_SUPPORTED
```

一步到位方案不要求 ECWeb 复用 `/cli` RCE 通道。ECWeb 如果需要同类能力，应走同一个 `authorizeCommand()`，但可以通过专用 API 或 `menu.exec` 风格入口接入。

### 2.4 模型 CLI 内部已有角色过滤，但信任 argv

`src/cli/model.ts` 当前行为：

1. `--self` 决定 agent。
2. `--peer` 经 `normalizePeer()` 归一化；裸 AID 会变成 `aun#<aid>`。
3. `--self + --peer` 可通过 `resolvePeerRoleDetail()` 推导 role。
4. `model list/current/use/check` 走 role 相关逻辑。
5. `model info` 当前只按 `modelId` 查询详情，没有按 role 做过滤。
6. `--role` 是本地调试参数；远程受限 CLI 不能允许低权限用户传入该参数伪造 role。

统一方案必须把 argv 参数纳入授权约束，尤其是 `--self`、`--peer`、`--role`、`--local`、`--sql`、`--rebuild`。

### 2.5 model 的 global scope 已退场

当前 `src/core/model/config-scope.ts` 中：

```text
relation > role > agent
global model 作用域已退场，只读 agent 兜底
write global 会抛 NO_GLOBAL_SCOPE
```

因此新权限模型不再把 `model use <id>` 无 `--self` 当作可写 global scope。需要表达的是：

```text
model.use relation
model.use role
model.use agent
```

### 2.6 roles schema v3 只能表达字段权限

当前 `roles.schema.3.json`：

```text
RoleDefinition = description + allowAccess + permissions
additionalProperties: false
```

一步到位方案必须升级 `roles.schema.4.json`，并同时更新类型、内置角色、merge/diff、ConfigManager、ECWeb role API 和前端。

---

## 3. 设计目标

1. 一次性建立统一命令授权体系，不保留散落的入口级角色硬编码。
2. 所有 slash/menu/CLI passthrough/ctl/IPC/ecweb/control 可触发动作都映射到 `OperationId`。
3. 所有 operation 有元数据：category、defaultScopes、dangerous、description、argument policy。
4. `roles.schema.4.json` 支持 `commandPermissions`。
5. 任意 role string 都可配置命令能力，包括 custom role。
6. 任意 role 都可以被显式授予高危能力，但高危能力必须额外标记、显式 grant、审计，并可要求 daemon owner/control channel。
7. CLI argv 不作为权限配置单元，只作为解析输入。能识别的 argv 映射到具体 operation；不能识别的 argv 映射到 `cli.exec.raw`。
8. 业务约束不被命令权限替代：`model.use` 仍要检查 `allowOverride` / `allowedModels`；file 要查路径沙箱；trigger 要查 ownership。
9. 授权器支持审计和测试，拒绝原因结构化。
10. 升级后 owner/admin 当前可用能力保持兼容，guest/member/custom role 可通过配置获得明确能力。

---

## 4. 身份主体、Scope 与上下文

### 4.1 授权上下文

```ts
interface CommandAuthorizationContext {
  intent: CommandIntent;

  actorId?: string;
  channel?: string;
  channelId?: string;
  chatType?: 'private' | 'group';

  selfAid?: string;
  peerKey?: string;
  role: string;

  isDaemonOwner?: boolean;
  fromControlChannel?: boolean;
  source: CommandSource;
}
```

| 字段 | 来源 | 用途 |
|---|---|---|
| `actorId` | 入站消息发送者，例如 `msg.peerId` | 判断 ownPeerOnly |
| `channel/channelId/chatType` | 入站消息上下文 | 区分 private/group/control |
| `selfAid` | 当前 channel 归属 agent AID | 判断 ownAgentOnly |
| `peerKey` | `formatPeerKey(channelType, actorId/conversationId)` | 关系级 scope |
| `role` | `resolvePeerRoleDetail()` 或 session identity | 角色权限匹配 |
| `isDaemonOwner` | `evolclaw.json.owners.includes(actorId)` | 进程级/高危约束 |
| `fromControlChannel` | control AID channel | 控制面约束 |
| `source` | slash/menu/menu.cli/ctl/ecweb/control | 审计和差异约束 |

### 4.2 Scope

| Scope | 含义 | 示例 |
|---|---|---|
| `relation` | 当前 actor 与当前 agent 的关系级 | `model.list --self A --peer U` |
| `role` | 当前 agent 下某个 role 默认行为 | `model use --self A --role member` |
| `agent` | 当前 agent 默认配置 | `model use --self A` |
| `process` | daemon 进程级 | restart、upgrade、gateway/config 管理 |
| `filesystem` | 文件系统读写 | `file.list`、`file.fetch` |
| `control` | 控制 AID / IPC 管理面 | agent create/delete/enable/disable |
| `raw-cli` | 原始 CLI 透传 | 无法安全归一化的 `/cli exec` |

---

## 5. Operation Registry

新增：

```text
src/core/command/operation-registry.ts
```

核心类型：

```ts
type CommandSource = 'slash' | 'menu' | 'menu.cli' | 'ctl' | 'ipc' | 'ecweb' | 'control';

type CommandScope =
  | 'relation'
  | 'role'
  | 'agent'
  | 'process'
  | 'filesystem'
  | 'control'
  | 'raw-cli';

type OperationCategory =
  | 'read'
  | 'diagnose'
  | 'write-own'
  | 'write-agent'
  | 'process'
  | 'dangerous';

interface OperationMeta {
  id: string;
  category: OperationCategory;
  dangerous: boolean;
  defaultScopes: CommandScope[];
  description: string;
  sources?: CommandSource[];
}
```

示例 registry：

| Operation ID | 类型 | 高危 | 默认 scope | 来源示例 |
|---|---|---:|---|---|
| `model.list` | read | 否 | relation/role/agent | `/model`、`model list` |
| `model.current` | read | 否 | relation/role/agent | `model current` |
| `model.info` | read | 否 | relation/role/agent | `model info <id>` |
| `model.check` | diagnose | 否 | agent | `model check` |
| `model.use` | write-own/write-agent | 否 | relation/role/agent | `model use <id>` |
| `model.effort` | write-own/write-agent | 否 | relation/role/agent | `model effort <level>` |
| `model.reset` | write-own/write-agent | 否 | relation/role/agent | `model reset` |
| `session.list` | read | 否 | relation | `/session`、`/slist` |
| `session.create` | write-own | 否 | relation | `/new` |
| `session.rename` | write-own | 否 | relation | `/rename` |
| `session.delete` | write-own | 否 | relation | `/del` |
| `file.list` | read/filesystem | 否 | filesystem | `menu.action name=file action=list` |
| `file.fetch` | read/filesystem | 否 | filesystem | `menu.action name=file action=fetch` |
| `trigger.list` | read | 否 | agent/relation | `/trigger list` |
| `trigger.create` | write-agent | 否/谨慎 | agent | `/trigger create` |
| `trigger.update` | write-agent | 否/谨慎 | agent | `/trigger update` |
| `trigger.delete` | write-agent | 是 | agent | `/trigger cancel/delete` |
| `agent.list` | read | 否/敏感 | control | `agent list` |
| `agent.show` | read | 否/敏感 | control/agent | `agent show` |
| `agent.getConfig` | read | 是 | control | `agent get` |
| `agent.create` | process | 是 | control | `agent new/create` |
| `agent.reload` | process | 是 | control/agent | `/reload`、`agent reload` |
| `agent.delete` | dangerous | 是 | control | `agent delete --purge` |
| `system.status` | read | 否/敏感 | process | `status` |
| `system.restart` | process | 是 | process | `/restart` |
| `system.upgrade` | process | 是 | process | `/upgrade` |
| `stats.summary` | read | 否/敏感 | relation/control | `stats` |
| `stats.sqlReadonly` | dangerous | 是 | control/raw-cli | `stats --sql` |
| `stats.rebuild` | dangerous | 是 | process | `stats --rebuild` |
| `aid.listLocal` | read | 是 | control | `aid list` |
| `aid.showLocal` | read | 是 | control | `aid show` |
| `aid.lookupRemote` | diagnose | 否/敏感 | control | `aid lookup` |
| `storage.list` | read | 否/敏感 | control | `storage ls` |
| `storage.quota` | read | 否/敏感 | control | `storage quota` |
| `storage.upload` | write-agent | 是 | control | `storage upload` |
| `storage.download` | write-agent | 是 | control | `storage download` |
| `storage.delete` | dangerous | 是 | control | `storage rm` |
| `gateway.read` | read | 是 | process | gateway config query |
| `gateway.write` | process | 是 | process | gateway config update |
| `config.read` | read | 是 | process | config query |
| `config.write` | process | 是 | process | config update |
| `cli.exec.raw` | dangerous | 是 | raw-cli | 无法归一化的 CLI argv |
| `shell.exec` | dangerous | 是 | raw-cli | 预留 |
| `rce.exec` | dangerous | 是 | raw-cli | 预留 |

说明：

1. “否/敏感”代表 operation 本身不是破坏性，但返回内容敏感，默认策略可以只给 owner/admin。
2. `dangerous=true` 的 operation 不能被普通 `*` 隐式匹配。
3. `model global` 不进入新 registry；当前已退场。

---

## 6. CLI Intent Parser

新增：

```text
src/core/command/cli-intent-parser.ts
```

职责：

1. 输入 `argv: string[]`。
2. 解析为 `CommandIntent`。
3. 不能可靠识别时返回 `cli.exec.raw`。
4. 解析过程中保留 normalized args，不信任 argv 原值。

```ts
interface CommandIntent {
  operation: string;
  scope: CommandScope;
  source: CommandSource;
  args: Record<string, unknown>;
  rawArgv?: string[];
  dangerous?: boolean;
}

type CliIntentParseResult =
  | { kind: 'recognized'; intent: CommandIntent }
  | { kind: 'raw'; intent: CommandIntent; reason: string }
  | { kind: 'invalid'; code: string; reason: string };
```

### 6.1 parser 覆盖范围

一步到位不是只解析 `model list/current`，而是覆盖当前 `CLI_EXEC_WHITELIST` 中所有已允许远程透传的 CLI：

```text
status
model *
stats *
agent list/show/get
aid list/show/lookup
storage ls/quota
```

覆盖方式：

| CLI | 解析方式 |
|---|---|
| `status` | `system.status` |
| `model list/current/info/check/use/effort/reset` | 明确解析子命令、scope、flags |
| `stats ...flags` | 按 flags 映射到 stats operation |
| `agent list/show/get` | 明确解析 aid/key |
| `aid list/show/lookup` | 明确解析 aid |
| `storage ls/quota` | 明确解析 aid/prefix |
| 其他 argv | `cli.exec.raw` |

现有白名单不再作为授权真相，只作为迁移参考。最终是否允许执行由 `authorizeCommand()` 决定。

### 6.2 CLI 字符串命令

`args.command` 字符串仍可支持，但必须作为 raw CLI 风险处理：

```text
args.argv:
  可进入 cli-intent-parser 解析具体 operation

args.command:
  不做低权限受限解析
  映射为 cli.exec.raw
```

原因：当前 `tokenizeArgv()` 是简化正则，不是完整 shell parser。允许低权限用户用字符串命令进入普通 operation 会增加解析歧义。

### 6.3 远程 CLI 参数规则

parser 必须处理：

1. 禁止重复 flag，除非该命令明确允许多值。
2. 禁止未知 flag 伪装为普通参数。
3. 禁止低权限远程传 `--role`。
4. `--self` 必须能映射到当前 channel owning agent，除非 operation 明确允许跨 agent 且授权通过。
5. `--peer` 必须归一化为 peerKey 后参与 scope 校验。
6. `--format json` 可强制要求，用于 menu protocol 稳定解析。

---

## 7. roles.schema.4.json

### 7.1 RoleDefinition

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
  scopes?: CommandScope[];
  constraints?: CommandPermissionConstraints;
  reason?: string;
}

interface CommandPermissionConstraints {
  ownPeerOnly?: boolean;
  ownAgentOnly?: boolean;
  privateOnly?: boolean;
  groupOnly?: boolean;
  requireDaemonOwner?: boolean;
  requireControlChannel?: boolean;
  requireExplicitDangerousGrant?: boolean;
  requireFieldOverride?: string;

  allowedArgs?: Record<string, Array<string | number | boolean>>;
  deniedArgs?: Record<string, Array<string | number | boolean>>;
  forbiddenFlags?: string[];
  allowedConfigKeys?: string[];
  allowedPrefixes?: string[];

  timeoutMs?: number;
  outputLimitBytes?: number;
  cwdPolicy?: 'agentProject' | 'evolclawHome' | 'none';
  envAllowlist?: string[];
}
```

### 7.2 通配匹配语义

匹配顺序：

```text
1. exact operation，例如 model.list
2. namespace wildcard，例如 model.*
3. category wildcard，例如 category:read
4. dangerous wildcard，例如 dangerous:*
5. ordinary wildcard *
```

冲突处理：

```text
exact deny > exact allow > namespace deny > namespace allow > category > wildcard
dangerous=true 的 operation 不匹配普通 "*"
dangerous=true 的 operation 必须 exact 或 dangerous:* 显式授权
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
            "privateOnly": true
          }
        },
        "model.current": {
          "allow": true,
          "scopes": ["relation"],
          "constraints": {
            "ownPeerOnly": true,
            "ownAgentOnly": true,
            "privateOnly": true
          }
        },
        "model.use": {
          "allow": true,
          "scopes": ["relation"],
          "constraints": {
            "ownPeerOnly": true,
            "ownAgentOnly": true,
            "privateOnly": true,
            "requireFieldOverride": "baseagents.claude.model"
          }
        },
        "cli.exec.raw": {
          "allow": false,
          "dangerous": true,
          "reason": "默认不允许原始 CLI 透传"
        }
      }
    }
  }
}
```

如果确实要给 guest 完整能力，也必须显式表达：

```json
{
  "commandPermissions": {
    "*": {
      "allow": true,
      "reason": "允许所有普通能力"
    },
    "dangerous:*": {
      "allow": true,
      "dangerous": true,
      "constraints": {
        "requireExplicitDangerousGrant": true,
        "timeoutMs": 15000,
        "outputLimitBytes": 131072
      },
      "reason": "显式允许高危能力"
    }
  }
}
```

---

## 8. 授权器

新增：

```text
src/core/command/command-permission.ts
```

核心函数：

```ts
function authorizeCommand(ctx: CommandAuthorizationContext): CommandAuthorizationDecision;
```

返回：

```ts
type CommandAuthorizationDecision =
  | {
      allow: true;
      operation: string;
      scope: CommandScope;
      role: string;
      dangerous: boolean;
      matchedRule?: string;
      constraints?: CommandPermissionConstraints;
    }
  | {
      allow: false;
      code:
        | 'NO_PERMISSION'
        | 'NOT_ALLOWED'
        | 'SCOPE_MISMATCH'
        | 'ARGUMENT_MISMATCH'
        | 'DANGEROUS_NOT_GRANTED'
        | 'ROLE_ACCESS_DENIED';
      reason: string;
      operation: string;
      scope?: CommandScope;
      role: string;
      dangerous?: boolean;
      matchedRule?: string;
    };
```

### 8.1 决策步骤

```text
1. 读取 operation metadata
   unknown operation -> deny，除非被明确映射为 cli.exec.raw

2. 检查 role
   role 不存在 -> anonymous
   allowAccess=false -> deny

3. 读取 commandPermissions
   schema v4: roles[role].commandPermissions
   无配置则使用内置默认策略

4. 匹配规则
   exact -> namespace -> category -> wildcard
   dangerous operation 不匹配普通 "*"

5. 检查 allow/deny
   deny 优先

6. 检查 scope
   requested scope 必须在 scopes 里

7. 检查 constraints
   ownPeerOnly
   ownAgentOnly
   privateOnly/groupOnly
   requireDaemonOwner
   requireControlChannel
   allowedArgs/deniedArgs/forbiddenFlags

8. 返回 allow/deny
```

### 8.2 daemon owner 的使用方式

`daemon owner` 不是 role 的替代品，而是 context 里的额外事实。

推荐规则：

```text
process/control/dangerous operation:
  默认约束 requireDaemonOwner 或 requireControlChannel

relation/agent ordinary operation:
  默认不需要 daemon owner

自定义 role 可显式移除或增加 requireDaemonOwner 约束
```

这允许管理员配置“某个 custom role 可以执行 process 操作”，但配置必须显式，并且审计日志能看到它绕过了默认 daemon owner 约束。

---

## 9. 业务约束层

命令授权只决定“能不能发起动作”，不替代业务约束。

### 9.1 model

| Operation | 命令授权 | 业务约束 |
|---|---|---|
| `model.list` | relation/agent/role scope | 输出必须按 effective role 的 `allowedModels` 裁剪 |
| `model.current` | relation/agent/role scope | 解析链必须带 role 约束 |
| `model.info` | read scope | 只能查询当前 role 可见模型，或返回裁剪字段 |
| `model.check` | diagnose scope | 可能触发网关探测，默认 admin/owner；低权限需显式授权 |
| `model.use` | write scope | `allowOverride=true` 且 model 匹配 `allowedModels` |
| `model.effort` | write scope | 对应 `baseagents.<ba>.effort/reasoning` 字段允许覆盖 |
| `model.reset` | write scope | 只能 reset 已授权 scope，避免清 agent/role 配置 |

### 9.2 file

`file.list/fetch` 必须继续走路径沙箱：

```text
项目内路径 -> 按 file.list/file.fetch 授权
项目外路径 -> 必须额外 dangerous 或 daemon owner/control 约束
.. 穿越 -> 永远拒绝
```

### 9.3 stats

`stats` 不能再用顶层 `*`。必须按 flags 解析：

| Flags | Operation |
|---|---|
| 无 flags / `--today` / `--summary` | `stats.summary` |
| `--peers` | `stats.peers` |
| `--groups` | `stats.groups` |
| `--session <id>` | `stats.session` |
| `--context <id>` | `stats.context` |
| `--sql <query>` | `stats.sqlReadonly` dangerous |
| `--rebuild` | `stats.rebuild` dangerous |

`stats.sqlReadonly` 即使只允许 SELECT，也必须是高危能力，因为它能绕过业务 API 进行任意数据枚举。

### 9.4 agent/aid/storage

`agent get`、`aid list/show`、`storage ls/quota` 都不是普通 read。它们可能暴露配置、身份、证书状态、对象名和路径结构。默认策略应只给 owner/admin 或 daemon owner；低权限开放必须配置 key/prefix/AID 范围。

---

## 10. 接入点改造

### 10.1 `/cli`

最终逻辑：

```text
if cmdBase === '/cli':
  parse argv or command

  if argv:
    intent = parseCliIntent(argv)
  else if command:
    intent = cli.exec.raw
  else:
    MISSING_VALUE

  decision = authorizeCommand(context + intent)
  if deny:
    return structured error

  execute:
    recognized operation 可继续 spawn CLI，也可逐步替换为 in-process handler
    cli.exec.raw 走 execCliPassthrough
```

删除 `identity.role !== 'owner'` 的前置硬编码。owner/admin/guest/custom role 都由 `authorizeCommand()` 决定。

### 10.2 menu query/update/action

所有 menu name/action 映射到 operation：

```text
menu.query name=model       -> model.current/list/options
menu.update name=model      -> model.use
menu.action name=file list  -> file.list
menu.action name=file fetch -> file.fetch
menu.action name=system restart -> system.restart
```

handler 内部仍保留业务约束，但入口权限统一前置授权。

### 10.3 slash

`guardRoleCommand()` 不再作为最终权限真相。它可以保留为快速 UI/UX 预判，但所有实际 handler 必须调用 `authorizeCommand()`。

例如：

```text
/model          -> model.list/model.current
/model <id>     -> model.use relation
/restart        -> system.restart process
/reload         -> agent.reload
/file <path>    -> file.fetch
```

### 10.4 ctl / IPC

ctl 当前依赖 session context 推导 role。新方案中 ctl 也必须构造 `CommandAuthorizationContext`：

```text
sessionId -> session.identity.role
session -> selfAid/peerKey/channel
ctl cmd -> operation
authorizeCommand()
```

### 10.5 ECWeb / control

ECWeb/control 不必暴露 `/cli`，但如果提供等价操作，也应走 operation 授权：

```text
ECWeb role definitions 写入 -> roleDefinition.write 或 config.write
ECWeb model query/update -> model.list/current/use
control channel system restart -> system.restart
```

---

## 11. 默认角色策略

| Operation | owner | admin | member | guest | anonymous |
|---|---:|---:|---:|---:|---:|
| `model.list` relation | allow | allow | allow | allow | deny |
| `model.current` relation | allow | allow | allow | allow | deny |
| `model.info` relation | allow | allow | allow filtered | allow filtered | deny |
| `model.check` | allow | allow | optional | deny | deny |
| `model.use` relation | allow + field | allow + field | allow + field | allow + field | deny |
| `model.use` role | allow | allow | deny | deny | deny |
| `model.use` agent | allow | allow | deny | deny | deny |
| `model.effort/reset` relation | allow + field | allow + field | optional + field | optional + field | deny |
| `session.*` own private | allow | allow | allow | allow | deny |
| `file.list/fetch` project | allow | allow | optional | deny by default | deny |
| `trigger.list` own | allow | allow | allow own | allow own | deny |
| `trigger.create/update` | allow | allow | optional | deny | deny |
| `trigger.delete` | allow | allow | optional dangerous | deny | deny |
| `agent.list/show` | allow | allow | deny by default | deny | deny |
| `agent.getConfig` | allow dangerous | allow dangerous | deny | deny | deny |
| `agent.create/delete/enable/disable` | daemon owner/default dangerous | daemon owner/default dangerous | deny | deny | deny |
| `agent.reload` own | allow | allow own | deny | deny | deny |
| `system.status` full | allow | allow | deny | deny | deny |
| `system.status` cropped | allow | allow | optional | optional | deny |
| `system.restart/upgrade` | daemon owner + dangerous | daemon owner + dangerous | deny | deny | deny |
| `stats.summary` own/cropped | allow | allow | optional | optional | deny |
| `stats.sqlReadonly` | dangerous | dangerous | deny | deny | deny |
| `stats.rebuild` | dangerous | dangerous | deny | deny | deny |
| `aid.* local` | dangerous | dangerous | deny | deny | deny |
| `storage.list/quota` | allow | allow | optional scoped | optional scoped | deny |
| `storage.upload/download/delete` | dangerous | dangerous | deny | deny | deny |
| `gateway.*` / `config.*` | dangerous/process | dangerous/process | deny | deny | deny |
| `cli.exec.raw` | dangerous | dangerous | deny by default | deny by default | deny |
| `shell.exec` / `rce.exec` | deny by default | deny by default | deny | deny | deny |

说明：

1. 表格是内置默认策略，不是硬编码边界。
2. `model.use relation` 对 guest 默认会被字段权限拒绝，因为当前 guest 的 `allowOverride=false`。
3. 任意 role 都可通过 `commandPermissions` 显式覆盖默认策略。
4. dangerous operation 默认不被普通 `*` 放开。

---

## 12. 审计

新增统一审计事件：

```ts
interface CommandAuthorizationAuditEvent {
  ts: number;
  source: CommandSource;
  operation: string;
  scope: CommandScope;
  dangerous: boolean;

  actorId?: string;
  selfAid?: string;
  peerKey?: string;
  channel?: string;
  channelId?: string;
  role: string;
  isDaemonOwner?: boolean;
  fromControlChannel?: boolean;

  decision: 'allow' | 'deny';
  code?: string;
  reason?: string;
  matchedRule?: string;

  argvHash?: string;
  argsSummary?: Record<string, unknown>;
  durationMs?: number;
  exitCode?: number;
}
```

要求：

1. 所有 deny 必须审计。
2. dangerous allow 必须审计。
3. `cli.exec.raw` 必须审计 argv hash，不记录完整敏感命令。
4. stdout/stderr 不进授权审计，只记录大小、截断状态、exitCode。

---

## 13. 一步到位实施清单

### 13.1 Schema 与类型

1. 新增 `kits/schemas/roles.schema.4.json`。
2. 更新 `kits/schemas/_meta.json`：roles currentVersion=4。
3. `src/types.ts` 增加 `CommandPermission`、`CommandPermissionConstraints`、`CommandScope`。
4. `RoleDefinition` 增加 `commandPermissions`。

### 13.2 配置读写

1. `src/config/roles.ts`
   - 内置角色增加 `commandPermissions`。
   - 提供 `getCommandPermissions(role)`。

2. `src/config/roles-merge.ts`
   - merge/diff 支持 `commandPermissions`。
   - overlay 迁移支持 v4。

3. `src/config/config-manager.ts`
   - roles v3 -> v4 migration。
   - `writeRoles()` 按 v4 schema 校验。

4. 测试：
   - schema v4 校验。
   - merge/diff。
   - v3 overlay 自动迁移。

### 13.3 Operation 与授权器

1. 新增 `operation-registry.ts`。
2. 新增 `command-permission.ts`。
3. 实现 rule matching。
4. 实现 dangerous 不匹配普通 `*`。
5. 实现 constraints 检查。
6. 实现审计事件。

### 13.4 CLI parser

1. 新增 `cli-intent-parser.ts`。
2. 覆盖当前 `CLI_EXEC_WHITELIST` 中的所有命令。
3. `args.command` 一律映射 `cli.exec.raw`。
4. `stats --sql`、`stats --rebuild` 映射高危 operation。
5. 禁止未知/重复/伪造 flags。

### 13.5 入口接入

1. `/cli` 删除 `identity.role === 'owner'` 前置判断，改为 `authorizeCommand()`。
2. menu query/update/action 接入 operation 授权。
3. slash handler 的实际执行路径接入 operation 授权。
4. ctl/IPC 接入 operation 授权。
5. ECWeb/control 对等操作接入 operation 授权；是否暴露 `/cli` 仍可保持不暴露。

### 13.6 ECWeb

1. role definitions API 保留/校验 `commandPermissions`。
2. 角色详情页新增命令权限配置区。
3. 高危能力显示危险标识、默认折叠、二次确认。
4. 支持按 operation 分类筛选。
5. 支持查看 effective command permissions。

### 13.7 文档同步

1. `docs/aun-menu-protocol-dev-guide-v2.5.md`
2. `docs/menu-protocol-cli-exec-frontend.md`
3. `docs/stats-frontend-guide.md`
4. `docs/model-command-design.md`
5. `docs/config/03-schema.md`
6. ECWeb role management docs

---

## 14. 验收测试

### 14.1 `/cli` 统一授权

1. guest `model list --self A --peer U --format json` allow，返回 guest 可见模型。
2. guest `model list --self A --peer other --format json` deny。
3. guest `model list --self otherAgent --peer U --format json` deny。
4. guest `model list --role owner ...` deny。
5. guest `model use opus --self A --peer U` 因字段权限 deny。
6. member `model use sonnet --self A --peer U` 在 `allowOverride=true` 且 `allowedModels` 匹配时 allow。
7. guest `stats --sql "select ..."` deny。
8. guest role 被显式授予 `stats.sqlReadonly` 后 allow，并产生 dangerous audit。
9. guest `args.command="model list ..."` 映射 `cli.exec.raw`，默认 deny。
10. guest 显式授予 `cli.exec.raw` 后 allow，并产生 dangerous audit。

### 14.2 menu/slash/ctl 一致性

1. slash `/model` 与 menu `model list` 对同一 actor 返回一致模型集合。
2. menu `model use` 与 CLI `model use` 遵守同一字段权限。
3. ctl setmodel 通过 session context 得到同一 role 约束。
4. `/restart`、`system.restart`、control restart 都映射 `system.restart`。
5. 非 daemon owner 即使 agent role 是 owner，也不能默认执行 process operation，除非 commandPermissions 显式覆盖。

### 14.3 schema v4

1. v3 roles.json 迁移到 v4 后行为不变。
2. 自定义 role 可配置 `model.*`。
3. 自定义 role 的 `"*"` 不包含 `cli.exec.raw`。
4. `dangerous:*` 可以显式包含高危 operation。
5. deny 规则优先于 allow 规则。

### 14.4 审计

1. 所有 deny 有审计记录。
2. 所有 dangerous allow 有审计记录。
3. raw CLI 审计不落完整命令，只落 argvHash/summary。
4. 审计包含 actor、role、operation、scope、decision、reason。

---

## 15. 风险与约束

### 15.1 不允许用 CLI 字符串白名单替代 operation

不允许把角色配置设计成：

```json
{
  "allowedCli": ["model *", "stats *", "agent *"]
}
```

原因：

1. CLI 新增子命令会扩大权限面。
2. flags 组合会改变读写/高危属性。
3. 参数伪造难审计。
4. 无法表达 scope 和业务约束。
5. 无法区分普通能力和高危能力。

### 15.2 前端隐藏按钮不是权限

前端可以根据 effective permissions 隐藏入口，但 daemon 必须最终授权。所有入口必须 fail-closed。

### 15.3 permissionMode 不等于命令权限

`permissionMode` 管 baseagent 工具执行策略，例如模型是否能执行 Bash、读写文件、请求审批。

`commandPermissions` 管用户能否控制 daemon，例如切模型、查文件、改配置、重启服务。

两者不能互相替代。

### 15.4 高危能力必须显式

`dangerous=true` operation：

1. 不匹配普通 `"*"`。
2. 必须 exact 或 `dangerous:*` 授权。
3. 默认要求审计。
4. 可默认要求 daemon owner/control channel。
5. UI 必须明显标识。

---

## 16. 当前模型问题在新方案下的链路

当前失败链路：

```text
menu.action name=cli action=exec argv=["model","list","--self",A,"--peer",U]
  -> /cli owner-only
  -> guest NO_PERMISSION
  -> CLI 内部 role 过滤没有机会执行
```

一步到位后的链路：

```text
menu.action name=cli action=exec argv=["model","list","--self",A,"--peer",U,"--format","json"]
  -> parseCliIntent()
  -> operation=model.list
  -> scope=relation
  -> context: actor=U, self=A, role=guest
  -> authorizeCommand()
  -> commandPermissions['model.list'] allow relation + ownPeerOnly + ownAgentOnly
  -> execCliPassthrough 或 in-process model handler
  -> model list 内部继续按 guest allowedModels 过滤
  -> 返回 guest 可见模型列表
```

这不是 `/cli` 特例，而是统一命令授权体系的一个普通读操作。

