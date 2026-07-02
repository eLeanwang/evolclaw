# 配置中长期项实施计划

> 创建时间：2026-06-23
> 依据：[PARAMS-GAPS-AND-FIXES.md](./PARAMS-GAPS-AND-FIXES.md)、[01-overview.md](./01-overview.md)
> 当前路线：保留 `behavior.json`，继续采用 H 配置链 + HA 行为链。

本文把剩余中长期配置问题拆成可以直接排期实现的工作项。每个工作项都包含目标设计、代码落点、迁移策略、测试和验收标准。

## 一、目标与非目标

目标：

1. 补齐 HA 全局默认层，避免把行为默认值塞进 H 链 `agents/defaults.json`。
2. 为 `effective` 配置提供完整来源追踪，解释每个最终值来自哪一层、哪个文件。
3. 收敛 agent/channel/process schema，使 CLI 写入、启动加载和文档使用同一套 AJV schema。
4. 统一 project path、ecweb、serviceProxy 等仍分散的默认值和解析逻辑。
5. 明确 debounce、dispatch、show_activities 的运行时优先级和热更新语义，并补测试。

非目标：

- 不移除 `behavior.json`。
- 不做 v4 标记文件架构迁移。
- 不重写权限模型；仅把现有 H/HA owner 和写入路由收敛清楚。

## 二、当前基线

已完成：

- `ConfigTarget` 已有 `Behavior` / `RelationBehavior`。
- `ec config set/get/unset`、`ec agent set/get` 已按字段路径写入 canonical owner。
- `permissionMode`、`dispatch`、`flush_delay`、`idleMonitor`、`chatmode` 新 session 默认值已完成第一轮修正。
- agent/relation `behavior.json` 已纳入配置快照。

仍缺：

- HA 链没有全局默认层。
- `resolveEffective()` 只返回最终值，不返回来源。
- `channels[]` schema 仍是宽松 object。
- `loadAllAgents()` 启动加载仍走 `validateAgentConfig()` 业务校验。
- project path fallback 分散在 `EvolAgent`、`index.ts`、CLI agent 创建逻辑里。
- `serviceProxy.services[]` schema 仍是任意 object，`ecweb.port` 默认值没有物化到 schema/default helper。
- debounce、dispatch、show_activities 的优先级和热更新行为还没有形成测试契约。

## 三、阶段总览

| 阶段 | 主题 | 依赖 | 建议优先级 | 主要产物 |
|------|------|------|------------|----------|
| M1 | source trace | 当前 H/HA 路由已完成 | 高 | `resolveEffectiveWithTrace()`、`ec config effective --trace` |
| M2 | 全局 HA 默认层 | M1 可并行，但建议先有 trace | 高 | `agents/defaults.behavior.json`、`ConfigTarget.BehaviorDefaults` |
| M3 | channel discriminated schema | M1/M2 后 | 中 | `channels[]` oneOf schema、schema 测试 |
| M4 | 启动加载切 AJV | M3 后 | 中 | `loadAllAgents()` 使用 schema 校验 + 业务校验补充 |
| M5 | project path 默认解析统一 | 可并行 | 中 | `resolveProjectPath()` helper、路径测试 |
| M6 | ecweb/serviceProxy schema 细化 | 可并行 | 中 | process schema defaults、service item schema |
| M7 | 运行时语义测试 | M1/M2/M5/M6 后 | 中 | debounce/dispatch/show_activities 契约测试 |

推荐顺序：M1 -> M2 -> M3 -> M4，同时 M5/M6 可独立推进，最后用 M7 固化行为。

## 四、M1：完整 source trace

### 问题

当前 `resolveEffective()` 只能看到最终值。发生 H 字段被 HA 字段覆盖、relation behavior 覆盖 role behavior、旧 H `dispatch` 被兼容归一时，CLI 和用户无法解释来源。

### 目标设计

新增只读 API：

```ts
export interface ConfigSourceTraceEntry {
  path: string;
  target: ConfigTarget;
  file: string;
  layer: 'defaults' | 'agent' | 'relation' | 'behavior-defaults' | 'agent-behavior' | 'role' | 'relation-behavior' | 'compat';
  permission: 'H' | 'HA';
  merge: 'scalar' | 'list' | 'dict';
  overridden?: boolean;
  note?: string;
}

export interface EffectiveConfigWithTrace {
  config: EffectiveAgentConfig;
  trace: Record<string, ConfigSourceTraceEntry[]>;
}
```

约定：

- trace 默认不输出敏感值，只输出 path、文件、层级和覆盖关系。
- scalar 记录顶层字段路径，例如 `dispatch`。
- dict 先记录第一层 key，例如 `baseagents.claude`；对 `baseagents.<name>.model/effort/reasoning` 这类已知 HA 字段，额外记录完整路径。
- list 记录字段级来源，例如 `channels`，不逐项输出 token/appSecret。
- 兼容归一单独记录 `compat`，例如旧 H `dispatch=all` 最终归一为 `broadcast`。

### 代码落点

- `src/config/merge.ts`
  - 新增 `mergeLayersWithTrace()`，复用现有 `mergeLayers()` 规则，不改变当前合并语义。
- `src/config/behavior.ts`
  - 新增 `resolveBehaviorWithTrace()` 或让 `resolveBehavior()` 支持可选 trace collector。
- `src/config/config-manager.ts`
  - 新增 `resolveEffectiveWithTrace(sel, opts)`。
  - `normalizeEffectiveCompatibility()` 输出兼容 trace。
- `src/cli/config.ts`
  - `ec config effective --trace --self <aid> [--peer <peerKey>] [--json]`。
  - `ec config get <field> --trace` 可作为第二步，不作为 M1 必需项。
- `docs/config/04-config-manager.md`、`08-quick-reference.md`
  - 增加 trace 用法。

### 测试

- `tests/config-source-trace.test.ts`
  - H 链：defaults -> agent -> relation 的 trace 顺序正确。
  - HA 链：agent behavior -> role -> relation behavior 的 trace 顺序正确。
  - HA 覆盖 H 同名字段时，H entry 标记 `overridden: true`。
  - `dispatch=all/none` 兼容归一时出现 `compat` trace。
  - trace 不包含 `apiKey`、`appSecret`、`token` 等明文值。

### 验收标准

- `ec config effective --trace --self <aid>` 能解释 `dispatch`、`permissionMode`、`baseagents.<name>.model`、`projects.defaultPath` 的来源。
- 不改变现有 `resolveEffective()` 返回值。
- 现有 build/test 通过。

### 风险

- trace 与 merge 逻辑重复会再次漂移。实现时必须让 trace 版本复用同一套 merge 规则，不能手写第二套覆盖逻辑。

## 五、M2：全局 HA 默认层

### 问题

HA 链目前从 `agents/{aid}/behavior.json` 开始，没有全局行为默认值。`chatmode`、`dispatch`、`flush_delay`、`debounce`、`show_activities`、`proactive` 等默认值如果写进 `agents/defaults.json`，会混淆 H/HA 所有权。

### 目标设计

新增文件：

```text
agents/defaults.behavior.json
```

使用现有 `behavior.schema`，作为 HA 链最低优先级：

```text
agents/defaults.behavior.json
  -> agents/{aid}/behavior.json
  -> behavior.roles.{role}
  -> agents/{aid}/relations/{peerKey}/behavior.json
```

推荐默认骨架：

```jsonc
{
  "$schema_version": 1,
  "dispatch": "mention",
  "flush_delay": 3,
  "debounce": 0,
  "show_activities": "all",
  "permissionMode": "auto",
  "chatmode": {
    "private": "interactive",
    "group": "proactive",
    "nothuman": "proactive"
  },
  "proactive": {
    "pre_tool_1stmsgchk": true,
    "tool_use_reminder": true
  }
}
```

### 代码落点

- `src/paths.ts`
  - 新增 `behaviorDefaultsConfig()` 或在 `resolvePaths()` 中返回 `behaviorDefaultsConfig`。
- `src/config/config-manager.ts`
  - 新增 `ConfigTarget.BehaviorDefaults`。
  - `TARGET_SCHEMA[BehaviorDefaults] = 'behavior'`。
  - `targetPath(BehaviorDefaults)` 指向 `agents/defaults.behavior.json`。
  - `routeFieldPath(field, 'defaults')`：HA 字段路由到 `BehaviorDefaults`，H 字段仍路由到 `Defaults`。
  - `listFields('defaults')` 同时列出 H defaults 和 HA behavior defaults。
- `src/config/behavior.ts`
  - 新增 `readBehaviorDefaults()`。
  - `resolveBehavior()` 合并层改为 `[globalBehaviorDefaults, agentBehavior, role, relationBehavior]`。
- `src/config/snapshot.ts`
  - 纳入 `agents/defaults.behavior.json`。
- `src/cli/config.ts`
  - `ec config init/validate/show` defaults scope 纳入 HA defaults。
- `src/cli/init.ts`
  - 初始化时可创建该文件；若不创建，也必须有内置 fallback 常量。
- `docs/config/01-overview.md`、`02-merge-rules.md`、`PARAMS-FULL-REFERENCE.md`
  - 更新 HA 链图和参数归属。

### 迁移策略

1. 不自动移动用户现有 `agents/defaults.json` 中的行为字段，避免误判。
2. 新写入从 M2 起按 route 写入 `agents/defaults.behavior.json`。
3. `resolveEffective()` 继续兼容旧 H 链行为字段，HA 默认层优先级高于 H defaults 但低于 agent behavior。
4. M1 trace 可提示：`agents/defaults.json` 中的行为字段为 legacy H behavior source。

### 测试

- `tests/config-behavior-defaults.test.ts`
  - defaults scope 写 `dispatch` 落到 `defaults.behavior.json`。
  - agent behavior 覆盖全局 behavior defaults。
  - role 覆盖 agent behavior。
  - relation behavior 覆盖 role。
  - H defaults 中同名旧字段仍可被读取，但被 HA defaults 覆盖时 trace 清楚。

### 验收标准

- `ec config set dispatch mention --scope defaults` 写入 `agents/defaults.behavior.json`。
- 未创建 agent behavior 文件时，agent effective 仍能拿到全局 HA 默认值。
- 快照、恢复、validate 都覆盖新文件。

### 风险

- 如果同时允许 `agents/defaults.json` 和 `agents/defaults.behavior.json` 配置同一行为字段，用户可能困惑。必须用 trace 和文档明确 `defaults.behavior.json` 是 canonical owner。

## 六、M3：channel discriminated schema

### 问题

`agent-config.schema` 中 `channels[]` item 目前是宽松 object。启动校验只能靠 `validateAgentConfig()` 检查 type/name/重复 name，无法校验每种渠道的必填凭证字段。

### 目标设计

在 `agent-config.schema.1.json` 中把 `channels.items` 改为 discriminated schema：

- common 字段：`type`、`name`、`enabled`、`owners`、`admins`、`flushDelay`、`debounce`、`showActivities`。
- `feishu`：`appId`、`appSecret`。
- `wechat`：`baseUrl`、`token`。
- `dingtalk`：`clientId`、`clientSecret`、`requireMention`、`freeResponseChats`。
- `qqbot`：`appId`、`clientSecret`。
- `wecom`：`botId`、`secret`。
- `aun`：保留兼容，但标记为 deprecated；运行时仍由 agent AID 隐式创建，显式 `channels[].type=aun` 只 warn 并忽略。

### 代码落点

- `kits/schemas/agent-config.schema.1.json`
  - 使用 `oneOf` + `const` 或 `if/then` 定义各 channel。
  - 分支内 `additionalProperties: false`。
- `src/types.ts`
  - 对齐 `ChannelInstance` union。
- `src/config-store.ts`
  - `validateAgentConfig()` 保留业务规则：AID 合法性、重复 channel name、AUN 显式 entry warn、支持类型集合。
  - 字段类型/必填项逐步交给 AJV。
- `docs/config/03-schema.md`、`PARAMS-FULL-REFERENCE.md`
  - 增加各 channel 的字段表。

### 兼容策略

- 第一步只把已有 TypeScript 类型中已经明确的字段纳入 schema。
- 对历史配置中可能存在但代码未正式声明的字段，先用实际样本扫描确认，不直接禁止。
- 如果发现生产配置依赖额外字段，先加入 schema 并标注用途，再启用 `additionalProperties: false`。

### 测试

- `tests/config-channel-schema.test.ts`
  - 每种 channel 的最小合法配置通过。
  - 缺少必填字段失败。
  - 未知 channel type 失败。
  - 同 type 下重复 name 仍由业务校验失败。
  - 显式 AUN entry 通过 schema，但业务校验只 warn 不 fail。

### 验收标准

- `validateConfig(ConfigTarget.Agent, cfg)` 能发现 channel 字段错误。
- 现有 channel loader 不需要再猜测缺失凭证字段。
- 文档列出的 channel 字段与 schema 一致。

## 七、M4：启动加载全面切 AJV schema

### 问题

`ConfigManager.write()` 使用 AJV schema，但 `loadAllAgents()` 启动加载仍走 `validateAgentConfig()`。这会导致“CLI 可写入”和“启动可加载”的规则不完全一致。

### 目标设计

启动加载分两层校验：

1. AJV schema 校验：字段类型、必填字段、枚举、additionalProperties。
2. 业务校验：AID 合法性、目录名与 `aid` 一致、channel name 重复、AUN 显式 entry warn、owner/admin AID 合法性。

### 代码落点

- `src/config-store.ts`
  - `loadAgent(aid)` 读取后调用 `validateConfig(ConfigTarget.Agent, raw)`。
  - `validateAgentConfig()` 改名或拆分为 `validateAgentBusinessRules()`。
  - 启动跳过原因区分 `SCHEMA_INVALID` 和 `BUSINESS_INVALID`。
- `src/config/config-manager.ts`
  - 确认 `read()` 是否需要可选 validate 模式。建议先不改变 `read()` 默认行为，避免 CLI 只读路径被历史文件阻断。
- `src/config/schema-registry.ts`
  - 确认 schema fields 和 AJV compile 对新增 definitions/oneOf 支持正常。

### 前置条件

- M3 完成 agent/channel schema 补齐。
- `projects.autoCreate`、`projects.list` 等当前业务允许字段必须先进入 schema。
- 如果 `AgentConfig` 仍存在 schema 未定义字段，禁止切换。

### 测试

- `tests/config-startup-validation.test.ts`
  - 启动加载非法 schema agent 时跳过并记录原因。
  - 合法 schema 但业务规则非法时跳过。
  - 历史兼容字段未迁移前不导致全量 agent 加载失败。
  - `loadAllAgents()` 返回 skipped 列表稳定。

### 验收标准

- `loadAllAgents()` 使用 AJV 作为第一道校验。
- `validateAgentConfig()` 注释中的“schema 尚未完整”债务被删除或改为“仅业务规则”。
- build/test 通过。

## 八、M5：project path 默认解析统一

### 问题

当前 project path fallback 分散：

- `EvolAgent.projectPath` 使用 `projects.defaultPath || process.cwd()`。
- `index.ts` 使用 `primaryAgent.projectPath -> defaults.projects.defaultPath -> paths.root/projects/default`。
- CLI agent 创建逻辑使用显式值、`rootPath` 派生和 `defaultPath`。

### 目标设计

新增统一 resolver：

```ts
export interface ResolveProjectPathInput {
  explicitPath?: string;
  agentConfig?: Pick<EffectiveAgentConfig, 'projects'>;
  defaults?: Pick<DefaultsConfig, 'projects'>;
  root: string;
  cwd?: string;
}

export function resolveProjectPath(input: ResolveProjectPathInput): string;
```

优先级：

```text
explicitPath
  -> agent effective projects.defaultPath
  -> defaults.projects.defaultPath
  -> defaults.projects.rootPath/default
  -> {EVOLCLAW_HOME}/projects/default
```

规则：

- 返回绝对路径。
- 统一去除尾部 slash。
- 是否自动创建目录由调用点决定，resolver 不做写盘。
- `process.cwd()` 只作为测试注入或最后兼容 fallback，不再作为主要默认值。

### 代码落点

- `src/config/project-path.ts` 或 `src/core/project-path.ts`
  - 新增 resolver。
- `src/core/evolagent.ts`
  - `projectPath` getter 改用 resolver。
- `src/index.ts`
  - `defaultProjectPath` 和 `onProjectPathRequest` 改用 resolver。
- `src/cli/agent.ts`
  - agent 创建路径建议和写入改用 resolver。
- `src/core/channel-loader.ts`
  - `ChannelBuildContext.defaultProjectPath` 改用 agent projectPath，不再 fallback `process.cwd()`。

### 测试

- `tests/project-path.test.ts`
  - 覆盖优先级。
  - 相对路径转绝对路径。
  - 尾部 slash 清理。
  - 没有任何配置时落到 `{root}/projects/default`。

### 验收标准

- 代码中 project path 默认逻辑只剩 resolver 一个事实源。
- 文档能说明唯一优先级。
- 不再新增 `process.cwd()` 作为业务默认路径。

## 九、M6：ecweb/serviceProxy schema 与默认值细化

### 问题

`ecweb.port`、`serviceProxy.enabled` 等已有代码兜底，但 schema 没有明确默认值；`serviceProxy.services[]` 仍是 object，无法校验 service name、source、visibility、endpoint 等字段。

### 目标设计

在 `evolclaw.schema` 中细化：

```jsonc
{
  "ecweb": {
    "enabled": { "type": "boolean", "default": true },
    "port": { "type": "number", "default": 42705, "minimum": 1, "maximum": 65535 }
  },
  "serviceProxy": {
    "enabled": { "type": "boolean", "default": false },
    "services": [
      {
        "name": "ecweb",
        "enabled": true,
        "source": "ecweb",
        "serviceType": "http",
        "visibility": "private"
      }
    ]
  }
}
```

`services[]` item 字段：

- `name`：`^[a-z0-9_-]+$`，且不能是保留名 `api`、`health`、`proxy`、`ws`。
- `enabled`：boolean，默认 true。
- `endpoint`：string，`source=static` 时需要。
- `source`：`ecweb` / `static`，默认 `static`。
- `serviceType`：`http` / `websocket` / `sse` / `mcp`，默认 `http`。
- `visibility`：`private` / `public`，默认 `private`。
- `metadata`：object，允许非敏感展示信息。

### 代码落点

- `kits/schemas/evolclaw.schema.1.json`
  - 增加 defaults、enum、pattern、service item schema。
- `src/config-store.ts`
  - `ServiceProxyService` 类型与 schema 对齐。
  - `loadEvolclawConfig()` 可选接入 `applyProcessDefaults()`，先只对运行时返回值补默认，不强制写盘。
- `src/index.ts`
  - `ecweb.port ?? 42705` 改为常量或 defaults helper。
- `src/cli/daemon-commands.ts`
  - 同步使用同一常量/helper。
- `src/aun/service-proxy.ts`
  - `source/static`、保留名、endpoint 策略与 schema 保持一致。
- `docs/config/09-ecweb-integration.md`
  - 补 serviceProxy 配置样例。

### 测试

- `tests/process-schema.test.ts`
  - `ecweb.port` 范围校验。
  - `serviceProxy.services[].name` pattern 校验。
  - `source=ecweb` 允许无 endpoint。
  - `source=static` 缺 endpoint 的处理要么 schema fail，要么业务校验 fail，二选一并固定。
  - 保留名失败。

### 验收标准

- `validateConfig(ConfigTarget.Process, cfg)` 能发现 serviceProxy item 错误。
- 代码中 `42705` 不再散落多处，统一为常量或 defaults helper。
- serviceProxy 文档、schema、类型一致。

## 十、M7：运行时语义契约测试

### 10.1 debounce

目标语义：

```text
channels[].debounce
  -> owning agent effective debounce
  -> global HA defaults debounce
  -> 0
```

热更新语义：

- debouncer 按 `channelName` 缓存。
- channel reload 或 `MessageBridge.removeChannel(channelName)` 后新配置生效。
- 不承诺在不重载 channel 的情况下立即修改既有 debouncer。

测试：

- 私聊 interrupt 模式下 debounce > 0 会合并窗口内消息。
- 群聊 FIFO 模式不走 debouncer。
- removeChannel 后 debounce 重新读取。

代码落点：

- `src/core/message/message-bridge.ts`
- `src/core/message/stream-debouncer.ts`
- `tests/message-debounce.test.ts`

### 10.2 dispatch

目标优先级：

```text
session.metadata.dispatchModeOverride
  -> session.metadata.dispatchMode
  -> message.dispatchMode
  -> agent effective dispatch
  -> global HA defaults dispatch
  -> mention
```

注意：

- AUN 当前本地 resolver 只返回 `dispatchModeOverride`，服务器下发值会进入 `message.dispatchMode` 并同步到 session metadata。
- slash/menu `/dispatch clear` 只清除 override，不删除服务器缓存值。

代码落点：

- `src/channels/aun.ts`
- `src/core/message/message-processor.ts`
- `src/core/command/slash-handler.ts`
- `src/core/command/menu-handler.ts`
- `tests/dispatch-priority.test.ts`

验收标准：

- slash/menu 显示值、AUN 过滤值、ECK venue fragment 中的 dispatch 值一致。

### 10.3 show_activities

目标语义：

```text
channels[].showActivities
  -> agent effective show_activities
  -> global HA defaults show_activities
  -> all
```

显示策略：

- `none`：不显示中间活动。
- `all`：仅私聊显示中间活动；群聊仍不显示中间活动。

代码落点：

- `src/core/channel-loader.ts`
  - `resolveShowActivities(inst, agentDefault?)` 支持 agent 默认。
- 各 channel plugin
  - 传入 agent default。
- `src/core/evolagent.ts`
  - agent 级 setter 保持写 HA behavior。
- `tests/show-activities.test.ts`

验收标准：

- channel 未配置 `showActivities` 时使用 agent effective。
- channel 配置后覆盖 agent effective。
- 群聊在 `all` 下仍不发中间活动。

## 十一、实施检查清单

每个阶段提交前必须检查：

- schema、TypeScript 类型、运行时读取三者一致。
- CLI 写入路径与 ConfigManager route 一致。
- `docs/config/README.md` 和参数参考已更新。
- 新增默认值不能只写在文档里，必须有 schema default、常量或 resolver。
- 涉及 secret 的 trace/log 不输出明文。
- 兼容历史字段时必须有 trace 或 warning，不能静默改变用户配置含义。

## 十二、完成定义

全部中长期项完成后，应满足：

1. `ec config fields` 能列出 process/defaults/agent/relation/behavior 的 canonical 字段。
2. `ec config effective --trace` 能解释最终值来源。
3. `agents/defaults.behavior.json` 成为行为默认值唯一写入入口。
4. agent 启动加载与 ConfigManager 写入使用同一套 AJV schema。
5. project path、ecweb port、serviceProxy defaults 没有分散硬编码。
6. debounce、dispatch、show_activities 的优先级由测试固定。
7. `PARAMS-GAPS-AND-FIXES.md` 中“仍未完成的中长期项”可以逐项标记为已完成。
