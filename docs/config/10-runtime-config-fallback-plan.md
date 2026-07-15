# 运行时行为配置统一规范与实施方案

> 状态：方案（待评审）  ·  日期：2026-07-12  ·  范围：agent / relation / role 参与的运行时行为配置

## 1. 目标

本方案不是只修复 model/effort 的空值问题，而是建立一套适用于所有运行时行为配置的统一规范。

每个可配置的**叶子字段**必须能由系统回答以下问题：

1. 字段是什么类型，系统实际支持哪些值？
2. 字段允许写在哪些作用域？
3. 字段的默认值是否随角色变化？
4. 关系级未设置、设置非法或角色策略缺失时，最终值是什么？
5. 当前角色能否覆盖，能够选择哪些值？
6. 最终值来自 relation、role、agent 还是 system？

Schema、角色定义、CLI、Menu、运行时解析器和展示层必须共享同一份字段元数据，不能各自维护选项和默认值。

---

## 2. 基本概念

### 2.1 配置值策略与命令授权分离

两个维度必须分开：

- **值策略**：当前角色可使用哪些值、默认值是什么、关系值非法时如何修正。
- **命令授权**：当前调用者是否有权执行 `config.set`、`model.use`、`response.set` 等操作。

通过命令授权不代表值一定合法；值合法也不代表调用者有权写入。写入必须同时通过两者。

### 2.2 只以叶子字段为策略单元

角色约束、默认值、选项和来源都定义在叶子字段上，不以整个对象作为策略单元。

示例：

```text
response_modes.default_private
response_modes.default_group
response_modes.configs.proactive.pre_tool_1stmsgchk
baseagents.claude.model
chatmode.private
```

`response_modes`、`baseagents`、`chatmode` 等父对象只用于组织数据和只读展示，不直接声明默认值或 `allowedValues`。

### 2.3 两类字段策略

#### A. 角色控制字段（role-governed）

不同角色可以具有不同的：

- 默认值 `default`；
- 可选范围 `constraint`；
- 是否允许关系级覆盖 `allowOverride`。

关系级未设置时，必须使用当前角色的默认值。

典型字段：模型、推理强度、权限模式、响应模式、活动可见性。

#### B. 统一字段（uniform）

所有角色共享同一份：

- 系统默认值；
- 值域或参数 Schema；
- 运行时修正规则。

它不因角色不同而改变生效值。是否允许某个角色写入，仍由命令授权决定。

典型字段：布尔型运行参数、渲染模式、部分响应模式插件参数。

### 2.4 作用域不是默认值策略

字段可以允许以下作用域：

```text
agent    agents/<aid>/config.json
relation agents/<aid>/relations/<peerKey>/config.json
```

当前普通配置路由已经通过 `DEFAULT_BEHAVIOR_REJECT` 禁止向 `agents/defaults.json` 写入行为字段；新规范是**延续并收口现有门禁**，不是重新引入限制。

现状仍有两个兼容例外需要迁移：

- 初始化及部分专用代码可绕过普通路由，直接在 `defaults.json` 写入 `active_baseagent` / `baseagents`；
- `resolveAgentConfig` 仍会读取历史 defaults 层并参与合并。

目标态不再把 defaults 作为运行时行为配置作用域：代码内的 system default 是产品默认，不是磁盘配置层。迁移完成前，历史 defaults 只作为明确标记的兼容输入读取，不允许新增普通写入。

某字段允许 relation 作用域，不等于它一定是角色控制字段；某字段为统一字段，也不等于所有角色都能修改它。

### 2.5 总决策表

| 字段类型 | 外部角色会话解析顺序 | 无关系配置时 | 关系级写入 |
|----------|----------------------|--------------|------------|
| role-governed | 合法 relation → role.default → safe system value 或 policy-rejection | 使用当前角色 default | 必须同时通过命令授权和角色值策略 |
| uniform，允许 relation | relation → agent → system default | 使用 agent，未设则 system default | 只检查系统值域；调用者仍需通过命令授权 |
| uniform，agent-only | agent → system default | 使用 agent，未设则 system default | 禁止 |
| 控制面/敏感字段 | 专用解析 | 由专用规范决定 | 禁止普通行为配置入口写入 |

对 role-governed 字段，agent 值不是外部角色会话的角色默认。角色默认必须显式存在于角色策略中，避免修改 agent 基线后意外扩大所有角色的能力。

---

## 3. 字段规范注册表

新增单一事实源 `runtime-field-registry.ts`。Schema、CLI、Menu、角色策略校验和运行时解析均从这里读取字段定义。

建议类型：

```ts
type RuntimeScope = 'agent' | 'relation';
type PolicyMode = 'role-governed' | 'uniform';

interface RuntimeContext {
  selfAid: string;
  peerKey?: string;
  chatType?: 'private' | 'group';
  role?: string;
  principalType: 'external-role' | 'service' | 'trigger' | 'trusted-system';
  baseagent?: string;
  runnerCapabilities?: Record<string, unknown>;
}

type ValueDomain<T> =
  | { kind: 'enum'; values: readonly T[] }
  | { kind: 'boolean' }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'pattern'; pattern: RegExp }
  | { kind: 'dynamic'; provider: string }
  | { kind: 'schema'; provider: string };

interface RuntimeFieldSpec<T = unknown> {
  path: string;                 // 可为路径模板，如 baseagents.<ba>.model
  description: string;
  scopes: readonly RuntimeScope[];
  policy: PolicyMode;
  domain: ValueDomain<T>;
  systemDefault: SystemFallback<T> | ((context: RuntimeContext) => SystemFallback<T>);
  invalidRuntimeValue: 'fallback' | 'reject';
  sensitive?: boolean;
  deprecatedBy?: string;
}
```

动态 provider 和 system default 使用显式契约，不允许由实现者自行决定同步、异步或空值语义：

```ts
interface DynamicValueProvider<T> {
  /** per-message 路径只读同步快照，禁止网络和磁盘扫描 */
  getSnapshot(context: RuntimeContext): ValueSnapshot<T>;
  /** 启动、配置变更或管理命令触发异步刷新 */
  refresh(context: RuntimeContext): Promise<ValueSnapshot<T>>;
}

interface ValueSnapshot<T> {
  values: readonly T[];
  status: 'fresh' | 'stale' | 'unavailable';
  authoritative: boolean;
  updatedAt?: number;
}

type SystemFallback<T> =
  | { kind: 'value'; value: T }
  | { kind: 'passthrough'; target: 'runner-model' | 'runner-effort' | 'consumer-default' }
  | { kind: 'reject'; reason: string };
```

每个动态 provider 还必须声明缓存策略：

```ts
interface ProviderCachePolicy {
  key: (context: RuntimeContext) => string; // 至少隔离 selfAid/baseagent/config fingerprint
  maxAgeMs: number;
  staleWhileRefresh: boolean;
  refreshOn: readonly ('startup' | 'config-change' | 'registry-change' | 'manual')[];
}
```

本地 registry/provider 在注册或注销时同步更新 snapshot；远端 provider 由后台任务刷新。per-message 路径发现 stale 时只能调度刷新并继续使用允许的 stale snapshot，不能等待刷新。

注册表必须支持路径模板和动态值域：

- `baseagents.<ba>.model` 的选项来自对应 runner/model catalog；
- `response_modes.default_<scene>` 的选项来自**运行时已注册**且适用该 scene 的模式；
- `response_modes.configs.<mode>.<key>` 的类型和默认值来自该模式的 `configSchema`；
- `render.<scene>` 的选项来自 render registry；
- `sessionManifests.<sessionType>` 的值必须通过 manifest 文件名和存在性校验。

### 3.1 与现有 `config-field-policy.ts` 的迁移关系

`runtime-field-registry.ts` 建成后立即成为字段类型、值域、作用域和角色 permission key 的唯一事实源。现有 `config-field-policy.ts` 在阶段 1 就改为兼容适配层：

```text
resolveConfigFieldRule(path)
parseConfigFieldValue(path, raw)
isBehaviorConfigFieldPath(path)
        ↓ 全部从 registry 派生
runtime-field-registry.ts
```

过渡期不得同时手写两份枚举、路径集合或类型解析。阶段 6 删除的是兼容适配层和旧 API，不是等到阶段 6 才切换事实源。

### 3.2 响应模式双系统是阶段 0 前置

当前同时存在 `src/response-modes/` 与 `src/response-system/`，各自包含 registry、resolver、builtin metadata 等近似实现。主消息运行时当前使用 `src/response-system/`，但 CLI、旧调用和重复元数据仍可能引用另一套实现。

在把“运行时 registry”作为动态选项源之前，必须先完成：

1. 盘点两套目录的全部生产调用者和测试调用者；
2. 确认唯一保留实现（默认以当前主运行时使用的 `response-system` 为候选）；
3. 将另一套改为显式兼容转发或删除；
4. 合并 registry、resolver、builtin metadata 和扩展注册入口；
5. 增加构建期断言，确保 CLI 可选项和主运行时 registry 来自同一来源。

该工作是阶段 1 注册响应模式动态 provider 的硬前置，不能推迟到最终清理阶段。

---

## 4. 角色字段策略规范

角色控制字段必须在角色定义中使用完整策略：

```ts
interface RoleFieldPolicy<T = unknown> {
  default: T;
  allowOverride: boolean;
  constraint?:
    | { kind: 'enum'; values: T[] }
    | { kind: 'model-patterns'; patterns: string[] }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'schema'; schema: object };
  reason?: string;
}
```

兼容期可继续读取现有 `allowedModels` / `allowedValues`，但写入后统一规范化为 `constraint`。

### 4.1 必须满足的不变量

保存角色策略时必须校验：

1. role-governed 字段必须存在非空 `default`；
2. `default` 必须属于字段的系统值域；
3. `default` 必须满足角色 `constraint`；
4. 角色约束只能缩小系统值域，不能引入系统不支持的值；
5. `allowOverride=false` 时仍必须有合法 `default`；
6. scene 相关默认必须适用于对应 scene；
7. 动态值域暂时不可用时，不允许把未经验证的新值写入，但已有合法 default 可继续使用。

非法角色策略必须在写入时拒绝，不能依赖运行时猜测一个兜底值。

### 4.2 有效选项计算

```text
roleEffectiveOptions = systemDomain ∩ roleConstraint
```

例如：

- 系统已注册群聊响应模式：`proactive`、`dual-session`；
- member 允许：`proactive`、`dual-session`；
- visitor 允许：`proactive`；
- 未注册的 `workflow` 即使写在角色策略中，也不是有效选项。

---

## 5. 统一解析算法

### 5.1 角色控制字段

对具有有效角色身份的外部会话：

```text
1. 读取 relation 显式值
2. relation 有值且 allowOverride=true 且值满足有效选项/约束
   → 使用 relation 值
3. relation 缺失、禁止覆盖或值非法
   → 使用 role.default
4. 角色策略缺失或非法
   → 字段声明了安全 system value 时使用该值；否则返回 policy-rejection
```

即：

```text
合法 relation 值 > role.default > safe system value 或 policy-rejection
```

对于 role-governed 字段，存在角色时 agent 值不覆盖角色默认。agent 值用于：

- 无对端上下文的 agent 自身运行；
- 内部/service 会话；
- 管理界面查看 agent 基线；
- 角色系统尚未接管该字段时的兼容路径。

### 5.2 统一字段

```text
1. relation 合法值
2. agent 合法值
3. field.systemDefault（value 或 passthrough）
```

即：

```text
relation > agent > system default
```

外部调用者能否写 relation 值仍由命令授权决定。

### 5.3 无角色、未知角色和内部会话

- 外部消息的 `none` / 未知角色应在访问控制层拒绝，不进入普通行为配置解析。
- system/service/trigger 等内部上下文必须显式传递 `principalType`，使用 agent 值或专用 system default。
- 禁止把 `none` 静默映射为 member 或 owner。
- 是否把匿名外部访问映射为 visitor，应由身份解析器决定，而不是配置解析器决定。

### 5.4 非法存量值

- 运行时不抛出导致会话中断；
- 返回 default，并记录 `corrected` 信息和一次性告警；
- 默认只修正生效值，不在读取路径隐式回写磁盘；
- 使用 `config doctor` 显式扫描和修复历史数据。

---

## 6. 统一解析结果

所有专用解析器最终返回同一结构：

```ts
interface ResolvedRuntimeValue<T> {
  path: string;
  resolution:
    | { kind: 'value'; value: T }
    | { kind: 'passthrough'; target: 'runner-model' | 'runner-effort' | 'consumer-default' }
    | { kind: 'rejected'; reason: 'missing-role-policy' | 'invalid-role-policy' | 'no-safe-default' };
  source:
    | 'relation'
    | 'role-default'
    | 'agent'
    | 'system-default'
    | 'runner-default'
    | 'policy-rejection';
  policy: 'role-governed' | 'uniform';
  options?: T[];
  canOverride: boolean;
  corrected?: {
    attempted: unknown;
    reason:
      | 'override-disabled'
      | 'not-allowed'
      | 'invalid-type'
      | 'invalid-value'
      | 'missing-role-policy'
      | 'unavailable-option'
      | 'unavailable-target';
  };
}
```

`passthrough` 不是空值错误。对于模型和 effort，它表示调用 runner 时省略对应 override，由 runner 自己选择默认值；展示层可显示 runner 当前值，但不得把该值伪装成 relation、role 或 agent 配置。

`rejected` 用于无法安全修复的 role-governed 配置。调用者必须停止该字段对应的运行或整次请求，并返回稳定错误，不能再静默使用 agent/runner 默认。

修正原因同时覆盖两类策略：

- `override-disabled`、`not-allowed`、`missing-role-policy` 主要用于 role-governed；
- `invalid-type`、`invalid-value` 两类字段均可使用；
- `unavailable-option` 表示动态枚举中的选项已注销或当前未启用，例如响应模式；
- `unavailable-target` 表示配置指向的外部目标不存在，例如 renderer、manifest 或动态资源。

CLI、Menu、日志和运行时必须展示/消费同一个解析结果，禁止展示层重新推导默认值。

---

## 7. 全字段推荐分类

以下各表明确区分现状和目标态：

- **现状可用**：代码已按该值域/作用域工作；
- **现状静态**：当前为硬编码集合，目标改为动态 provider；
- **需迁移**：目标值域、作用域或策略与当前实现不同；
- **待决策**：实现前需要先完成产品/安全决策。

### 7.1 Baseagent 与模型

| 字段 | 现状 | 目标策略 | 目标作用域 | 目标值域/默认 | 说明 |
|------|------|----------|------------|---------------|------|
| `active_baseagent` | 静态集合 `claude/codex/gemini/hermes`；Schema 仍允许 relation | uniform | agent | 已安装且启用的 baseagent / 初始化选择 | **需迁移、待决策**：增加可用性 provider，并收缩 relation |
| `baseagents.<ba>.model` | 合并值；角色约束主要覆盖 Claude | role-governed | agent, relation | 对应 model catalog / runner default | **需迁移**：每角色、每 baseagent 分别定义策略 |
| `baseagents.<ba>.effort` / `reasoning` | 静态 effort 集合；角色覆盖不完整 | role-governed | agent, relation | runner capability / runner default | **需迁移**：不统一硬编码 `medium` |
| `baseagents.claude.agentProgressSummaries` | boolean，可 relation 写 | uniform | agent, relation | boolean / runner default | 目标基本延续现状 |
| `baseagents.claude.excludeDynamicSections` | boolean，可 relation 写 | role-governed | agent, relation | boolean / `false` | **待决策**：可能影响对端获得的上下文 |
| `baseagents.codex.enableRequestUserInput` | boolean，可 relation 写 | role-governed | agent, relation | boolean / `true` | **需迁移**：补角色策略 |
| `baseagents.codex.approvalsReviewer` | 静态三值，可 relation 写 | role-governed | agent, relation | `user/auto_review/guardian_subagent` / `user` | **需迁移**：涉及审批边界 |
| `baseagents.gemini.mode` | 静态 `cli/sdk`，当前允许 relation | uniform | agent | `cli/sdk` / runner default | **需迁移**：收缩 relation |
| `baseagents.gemini.useVertex` | boolean，当前允许 relation | uniform | agent | boolean / runner default | **需迁移**：收缩 relation |

模型字段的 system default 是 runner default，允许保持“未显式传 model”。禁止用 Claude 模型常量为 Codex、Gemini 或 Hermes 兜底。

### 7.2 会话模式与响应模式

| 字段 | 现状 | 目标策略 | 目标作用域 | 目标值域/默认 | 说明 |
|------|------|----------|------------|---------------|------|
| `response_modes.default_private` | CLI 静态 metadata；主运行时仅注册部分模式；无角色策略 | role-governed | agent, relation | 单一运行时 registry 的 private 模式 / `interactive` | **需迁移**：关系未设时使用角色默认 |
| `response_modes.default_group` | 同上 | role-governed | agent, relation | 单一运行时 registry 的 group 模式 / `proactive` | **需迁移**：关系未设时使用角色默认 |
| `response_modes.configs.<mode>.<key>` | 顶层 object；内部 Schema 校验不足 | 由模式声明 | agent, relation | mode `configSchema` | **需迁移**：每个参数声明策略和作用域 |
| `response_modes.overrides.<peerKey>` | agent/relation 对象内均可出现 | 迁移字段 | agent | registry + mode schema | **需迁移**：relation 文件不再重复保存 peerKey map |
| `chatmode.private/group/nothuman` | 静态 `interactive/proactive`，仍是有效兼容路径 | 兼容别名 | agent, relation | 映射至响应模式 | **需迁移**：最终由 `response_modes` 替代 |
| `dispatch` | 静态 `mention/broadcast`，有部分角色约束 | 兼容别名 | agent, relation | 映射至群聊响应模式参数 | **需迁移** |

响应模式的“可列出模式”必须以运行时 registry 为准。静态 metadata 可以描述未启用模式，但 CLI 不得把未注册模式列为可选值。

模式参数示例：

| 参数 | 推荐策略 | 默认来源 |
|------|----------|----------|
| `proactive.pre_tool_1stmsgchk` | uniform | mode schema `true` |
| `proactive.tool_use_reminder` | uniform | mode schema `true` |
| `dual-session.auxiliaryModel` | role-governed | 角色模型策略 |
| `dual-session.mainModel` | role-governed | 角色模型策略 |
| `rate-limited.cooldown_ms` | role-governed | 角色数值范围/default |
| 普通队列批次参数 | uniform | mode schema default |

### 7.3 权限、可见性与内容

| 字段 | 现状 | 目标策略 | 目标作用域 | 目标值域/默认 | 说明 |
|------|------|----------|------------|---------------|------|
| `permissionMode` | 静态模式集合；已有专用角色 fallback | role-governed | agent, relation | runner 支持权限模式 / safe default | **需迁移**：role default 必填；`none` 决策是准入条件 |
| `show_activities` | 类型含 `text`，Schema/CLI 当前主要只认 `all/none` | role-governed | agent, relation | `all/text/none` / `none` | **需迁移**：先统一现状值域再开放 `text` |
| `enable_rich_content` | boolean，已有部分角色默认 | uniform | agent, relation | boolean / `false` | **需迁移**：移除角色差异，最终与渠道 capability 求交集 |
| `render.private/group/inject` | 任意非空字符串，缺 registry 校验 | uniform | agent, relation | render registry / 默认 renderer | **需迁移**：未注册目标回退并告警 |
| `sessionManifests.<sessionType>` | 文件名校验，可 relation 写 | role-governed | agent | manifest registry / 主 manifest | **需迁移、待决策**：影响系统提示，建议收缩 relation |

### 7.4 节流与调度

| 字段 | 现状 | 目标策略 | 目标作用域 | 目标值域/默认 | 说明 |
|------|------|----------|------------|---------------|------|
| `flush_delay` | 非负数；角色 default 已存在但无 min/max | role-governed | agent, relation | 角色 min/max / `3` | **需迁移、待决策**：补数值范围 |
| `debounce` | 非负数；角色 default 已存在但无 min/max | role-governed | agent, relation | 角色 min/max / `0` | **需迁移、待决策**：补数值范围 |
| `proactive.pre_tool_1stmsgchk` | 顶层 boolean 子键 | uniform | agent, relation | boolean / `true` | **需迁移**：迁入 response mode config |
| `proactive.tool_use_reminder` | 顶层 boolean 子键 | uniform | agent, relation | boolean / `true` | **需迁移**：迁入 response mode config |

### 7.5 运行时只读或非关系配置

| 字段 | 现状 | 目标策略 | 目标作用域 | 处理方式 |
|------|------|----------|------------|----------|
| `group_venue_sync` | 行为字段中只读 object；agent/relation Schema 均可承载 | uniform/read-only | agent | **需迁移**：运行时生成或管理面维护，收缩 relation，不开放普通 scalar 写入 |
| baseagent endpoint/API key/path | 敏感字段 | 非行为配置 | agent | 走敏感配置规范，不进入本注册表 |
| `channels`、`projects`、`capabilities` | 专用配置对象 | 非行为配置 | agent | 使用专用 Schema 和权限规范 |
| `owners/admins/roles` | 控制面配置 | 控制面 | process/agent | 不进入运行时行为值解析 |

---

## 8. 响应模式完整示例

字段注册：

```ts
{
  path: 'response_modes.default_private',
  description: '私聊响应模式',
  scopes: ['agent', 'relation'],
  policy: 'role-governed',
  domain: { kind: 'dynamic', provider: 'registeredResponseModes.private' },
  systemDefault: { kind: 'value', value: 'interactive' },
  invalidRuntimeValue: 'fallback',
}
```

角色策略：

```ts
member: {
  default: 'interactive',
  allowOverride: true,
  constraint: { kind: 'enum', values: ['interactive', 'proactive'] },
}

visitor: {
  default: 'proactive',
  allowOverride: false,
  constraint: { kind: 'enum', values: ['proactive'] },
}
```

解析结果示例：

```text
visitor + relation 未配置
→ proactive（source=role-default, canOverride=false）

member + relation=proactive
→ proactive（source=relation, canOverride=true）

member + relation=未注册模式 workflow
→ interactive（source=role-default, corrected=unavailable-option）
```

---

## 9. 模型完整示例

字段注册：

```ts
{
  path: 'baseagents.<ba>.model',
  description: '当前 baseagent 使用的模型',
  scopes: ['agent', 'relation'],
  policy: 'role-governed',
  domain: { kind: 'dynamic', provider: 'modelCatalog.<ba>' },
  systemDefault: { kind: 'passthrough', target: 'runner-model' },
  invalidRuntimeValue: 'fallback',
}
```

角色策略：

```ts
member.claude = {
  default: 'claude-sonnet-4-6',
  allowOverride: true,
  constraint: {
    kind: 'model-patterns',
    patterns: ['claude-sonnet-*', 'claude-haiku-*'],
  },
}
```

解析：

```text
relation 合法模型 > role model default > runner default
```

每个 baseagent 独立配置角色策略。不存在 `baseagents.codex.model` 角色策略时，不得套用 Claude 的默认值或白名单。

---

## 10. 写入与运行时校验

### 10.1 写入期

所有写入入口统一调用 `validateRuntimeConfigWrite()`：

1. 路径必须存在于字段注册表；
2. scope 必须被字段允许；
3. 值必须属于系统值域；
4. role-governed 的 relation 写入必须满足当前角色策略；
5. 调用者必须通过命令授权；
6. 动态字段必须确认目标当前可用；
7. 复合对象写入拆为叶子逐项校验，禁止用整个对象绕过策略。

CLI、Menu、ECWeb 和内部命令不得各自实现一套枚举校验。

所有行为配置写入统一收口为：

```ts
writeRuntimeConfigPatch({
  target,
  selector,
  patch,
  principal: { type, role, issuer },
  mode: 'enforce' | 'migration',
})
```

- `enforce` 用于 CLI、Menu、ECWeb 和普通内部命令，必须完成命令授权与值策略校验；
- `migration` 只允许受信任维护代码使用，必须记录审计，不接受外部输入；
- patch 必须展开为叶子字段逐项校验；
- 低层 `write()` 只承担 Schema 和原子持久化，迁移完成后不再作为行为配置的公开写入口；
- 不再使用缺少 principal/role 时“告警后放行”的 fail-open 语义。

### 10.2 启动期

启动时验证：

- 字段注册表无重复路径或冲突模板；
- 所有 system default 满足自身值域；
- 所有内置角色策略满足不变量；
- 动态 provider 存在；
- 响应模式 metadata 与实际 registry 一致；
- Schema 中开放的行为字段都能映射到字段注册表。

### 10.3 运行时

运行时只负责：

- 读取各作用域候选值；
- 应用字段策略；
- 对历史非法值回退；
- 返回来源和修正信息。

运行时不应再次发明选项、默认值或角色规则。

### 10.4 `triggerMeta` 与可信内部 override 安全边界

`triggerMeta.modelOverride`、`effortOverride`、`permissionModeOverride`、`chatModeOverride` 当前在普通配置解析后覆盖最终值。这不是普通 relation 配置，而是一条独立的运行时提权路径，必须显式定义信任边界。

目标规范：

1. `triggerMeta` 必须携带不可由外部消息伪造的 `principalType` 和 `issuer`；
2. 默认情况下，trigger override 仍须通过字段 registry 的系统值域校验；
3. 面向外部角色会话的 trigger 默认仍须通过角色值策略，不得绕过模型白名单、权限模式和响应模式限制；
4. 只有声明为 `trusted-system` 且调用点完成内部身份认证的 trigger，才能请求 `bypassRolePolicy`；
5. `bypassRolePolicy` 必须按字段授权，禁止一个总开关绕过所有策略；
6. 每次 bypass 必须记录 issuer、字段、原值、覆盖值和原因；
7. 不可信或来源不明的 override 按普通 relation 候选值处理，不得直接覆盖最终结果。

建议统一入口：

```ts
resolveRuntimeField(path, {
  ...context,
  ephemeralOverride: {
    value,
    issuer,
    principalType,
    bypassRolePolicy,
  },
})
```

在该决策完成前，不能声称角色白名单和权限默认是完整的运行时安全边界。

---

## 11. 查询与展示规范

统一提供：

```text
config describe <field> [--self ... --peer ...]
config current <field> [--self ... --peer ...]
```

`describe` 返回：

- 字段类型与说明；
- policy 类型；
- 支持作用域；
- 系统值域；
- 当前角色有效选项；
- 当前角色 default；
- 是否允许覆盖。

`current` 返回：

- 实际生效值；
- source；
- relation/role/agent/system 各候选值；
- 是否发生运行时修正；
- 修正原因。

`model current`、`response current`、Menu 和 ECWeb 只包装这两个通用接口。

---

## 12. 与当前实现的主要差距

1. `config-field-policy.ts` 只描述写入类型，没有统一默认值、作用域和动态选项。
2. `resolveEffective` 先合并 defaults/agent/relation，再应用角色约束，已丢失叶子来源。
3. 角色约束字段列表硬编码且只覆盖部分 Claude 字段。
4. 多数复合字段按顶层 dict 合并，不能可靠表达叶子来源和叶子策略。
5. `src/response-modes/` 与 `src/response-system/` 两套响应模式实现并存；静态 metadata、CLI 和主运行时 registry 可能不一致。
6. Schema 对 `response_modes` 等对象只校验为 object，没有内部结构约束。
7. `show_activities` 在类型、Schema 和字段解析器中的允许集合不一致。
8. CLI、Menu、专用 resolver 和运行时分别维护默认值。
9. `triggerMeta` 等最终 override 路径可以绕过普通运行时字段策略，尚未形成可信 issuer、字段级 bypass 和审计规范。

---

## 13. 实施计划

### 阶段 0：解决前置决策和双系统

- 确定 `none` 外部身份策略：拒绝，或由身份系统显式映射为 visitor；
- 盘点并收敛 `response-modes` / `response-system` 双实现；
- 确定 `triggerMeta` 的 issuer、principalType 和字段级 bypass 规则；
- 固化当前各旧 resolver 的输入输出样本，作为迁移对拍基线。

双系统收敛默认按兼容等价迁移处理；若发现两套实现存在有意语义差异，必须先记录差异并单独评审，不能在目录合并时顺带改变行为。

**阶段 0 准出条件**：主运行时只有一个响应模式 registry；`none` 不再由字段解析器猜测；trigger override 的信任边界可测试、可审计。`none` 身份决策和 trigger 安全决策都是阶段 3 的硬前置。

### 阶段 1：建立注册表，不改变外部行为

- 新增 `runtime-field-registry.ts`；
- 立即让 `config-field-policy.ts` 的路径分类、值解析和 permission key 从 registry 派生；
- 纳入所有行为叶子字段和动态路径模板；
- 新增 registry 自检测试；
- 提供 `describeRuntimeField()`；
- 实现同步 snapshot / 异步 refresh provider 接口；
- 对照 Schema 检查遗漏字段。

**阶段 1 准出条件**：不存在 registry 与 `config-field-policy.ts` 两份手写值域；响应模式 provider 使用阶段 0 确立的唯一 registry。

### 阶段 2：统一解析框架

- 新增 `resolveRuntimeField(path, context)`；
- 新增 `validateRuntimeConfigWrite()` 与 `writeRuntimeConfigPatch()` 基础设施；
- 分别实现 role-governed 和 uniform 算法；
- 返回统一 source/options/canOverride/corrected；
- 在旧实现尚可独立调用时，对相同配置矩阵运行新旧 resolver 对拍；
- 对有意改变的行为建立显式 golden case，并要求评审确认差异；
- 对拍通过后，保留旧 resolver API 作为薄包装，内部改调新接口。

**阶段 2 准出条件**：未声明的行为差异为零；每个声明差异都有测试、迁移说明和回滚路径。

### 阶段 3：按字段原子迁移核心配置

**硬准入条件**：阶段 0 的 `none` 身份决策和 trigger override 安全决策已经落地。当前 `response-engine` 会传入 `role || 'none'`，未满足该条件不得迁移 permissionMode/model 等安全字段。

按风险从高到低迁移：

1. `permissionMode`；
2. `baseagents.<ba>.model`；
3. `baseagents.<ba>.effort/reasoning`；
4. `response_modes.default_private/default_group`；
5. `show_activities`；
6. `flush_delay/debounce`。

每个字段必须作为一个不可拆分的迁移单元，同时完成：注册表定义、角色策略、读取解析、所有写入入口、展示、对拍/golden 测试和旧逻辑清理。禁止只切读取、不切写入。

### 阶段 4：响应模式与遗留模式收敛

- 让 runtime registry 成为响应模式选项来源；
- 给模式参数 schema 增加 policy/scopes 元数据；
- 将 `proactive.*` 迁入 response mode config；
- 将 `chatmode` / `dispatch` 转换为兼容别名；
- 处理 `response_modes.overrides` 的重复 peer 寻址。

### 阶段 5：统一写入与管理面

- 将尚未迁移的 CLI、Menu、ECWeb 行为字段全部切到阶段 2 已建立的统一写入入口；
- 增加 `config describe/current/doctor`；
- 禁止父对象整体写入绕过叶子校验；
- 对历史非法值提供显式修复。

### 阶段 6：清理旧实现

- 删除 `behaviorFieldNames` 硬编码；
- 删除各消费端内联 fallback；
- 删除阶段 0 保留的响应模式兼容转发和废弃入口；
- Schema 从注册表生成或增加一致性测试；
- 更新所有配置文档和示例。

---

## 14. 必须覆盖的测试矩阵

每个字段至少覆盖：

1. role-governed：relation 合法值；
2. role-governed：relation 缺失使用 role default；
3. role-governed：allowOverride=false 强制 role default；
4. role-governed：relation 越界回退 role default；
5. role-governed：角色 default 本身非法时拒绝写入；
6. uniform：relation > agent > system default；
7. 动态选项不可用或已注销；
8. 父对象写入不能绕过叶子策略；
9. CLI/Menu/运行时解析结果一致；
10. source 和 corrected 信息准确；
11. internal/service 与外部角色上下文隔离；
12. 历史非法配置只修正生效值，不隐式写盘；
13. uniform 的 invalid-value / unavailable-target 回退；
14. trigger 普通 override 必须经过系统值域和角色策略；
15. trusted-system 字段级 bypass 的 issuer 校验与审计；
16. 迁移期新旧 resolver 对拍，以及有意差异 golden case。

---

## 15. 六个实现阻塞契约的定案

以下六项采用本节方案作为默认实现决策；如需改变，必须单独形成 ADR，不在编码中临时选择。

### 15.1 动态 provider：同步快照 + 异步刷新

**决策**：`resolveRuntimeField()` 保持同步，per-message 路径禁止网络请求、远端 catalog 拉取和目录全量扫描。

动态 provider 分两条路径：

```text
启动/配置变化/显式 refresh
    → provider.refresh() 异步更新缓存

每条消息/CLI current/Menu query
    → provider.getSnapshot() 同步读取缓存
```

provider 分为两类：

| provider | authoritative | unavailable 时的处理 |
|----------|---------------|----------------------|
| 本地响应模式 registry、renderer registry、manifest registry、runner capability | 是 | 不接受新写入；历史值回退并记录 unavailable-target/option |
| 远端 model catalog/discovery | 否 | 不因网络失败否定已有模型；继续检查格式、角色 pattern 和 runner 本地 capability |

模型 catalog 的远端结果只用于发现和 UI 列表，不是运行时安全边界。角色 `allowedModels` 和 runner capability 才参与强制校验。

验收条件：per-message 解析无 Promise、无网络 I/O；provider stale/unavailable 均有确定行为和测试。

### 15.2 无值语义：显式 passthrough

**决策**：`undefined` 不再同时表示“缺配置”“解析失败”和“使用 runner 默认”。解析结果使用 `resolution.kind` 区分。

对具有有效外部角色的会话，role-governed 字段的默认链是：

```text
合法 relation → role.default
```

角色 default 是强制不变量。角色策略缺失或非法时返回 `resolution.kind='rejected'`，不能回落 runner passthrough，否则可能绕过模型白名单或权限限制。

对无外部角色上下文的 agent 基线、service 或获得字段级 bypass 的 trusted-system，模型/effort 未显式配置时才返回：

```ts
{
  resolution: { kind: 'passthrough', target: 'runner-model' },
  source: 'runner-default',
}
```

消费端看到 passthrough 必须省略 model/effort override。`model current` 可以附加展示 runner 当前模型，但其配置来源仍标记为 `runner-default`。

验收条件：reset model 后不会被硬编码模型重新覆盖；不同 baseagent 不共享兜底模型常量。

### 15.3 角色策略迁移：新旧双读，叶子优先

**决策**：角色策略目标存储使用叶子路径和 `constraint`；兼容期采用确定的规范化顺序。

读取规范化：

```text
1. 读取旧父对象策略并展开为叶子候选
2. 读取旧 allowedModels / allowedValues 并转换为 constraint
3. 读取新叶子策略
4. 同一叶子冲突时，新叶子策略覆盖父对象展开值
5. 同一策略同时有 constraint 和 legacy allowed* 时，constraint 胜出并告警
```

例如旧：

```ts
chatmode: {
  default: { private: 'interactive', group: 'proactive' },
  allowOverride: true,
}
```

规范化为：

```ts
'chatmode.private': { default: 'interactive', allowOverride: true }
'chatmode.group': { default: 'proactive', allowOverride: true }
```

写入规则：

- 新管理入口只写叶子策略和 `constraint`；
- 兼容窗口内可生成 legacy mirror，供旧版本读取；
- mirror 仅在叶子策略可无损合并为父对象时生成；
- 无法无损 mirror 时，切换新语义前必须创建配置快照，回滚依赖恢复快照，不承诺旧二进制读取新语义；
- agent schema 升为 v4，提供显式、幂等的 v3→v4 迁移与备份；禁止读取时隐式改盘。

缺失策略迁移：

- 内置角色由代码提供完整叶子策略，可自动迁移并在启动期验证；
- 自定义角色不得从 agent 值、member 策略或 system passthrough 自动推断缺失的 role-governed default；
- 首次升级先以 shadow 模式运行 `config doctor`，为每个自定义角色生成缺失字段报告和建议补丁；
- 管理员确认补丁后，该角色才进入新策略的 enforce 模式；
- 未完成确认的自定义角色继续走旧 resolver 兼容路径，并记录迁移告警；安全字段不得半切换；
- 兼容窗口结束前仍未完成的角色必须禁用相关能力或阻止升级启用新语义，不能静默放权。

验收条件：父键、叶子键、legacy allowed*、新 constraint 的所有组合都有规范化测试，且冲突结果唯一。

### 15.4 群关系多角色：共享候选值，按发言者解析

**决策**：群 relation 中的行为值是该群的**共享候选值**，不是所有成员共同的最终值。每条消息按当前发言者的有效角色解析：

```text
group relation candidate
    + current member role policy
    → current message effective value
```

具体规则：

- 共享群行为值属于 group-global 配置，默认只有 owner/admin 或显式获得 `groupBehavior.update` 权限的角色可以写入；普通 member/visitor 的 `config.set` 不自动获得共享群写权限；
- 获得 group-global 写权限的 A 写入时，仍必须通过 A 的字段值策略；
- 持化后，member B 读取同一候选值时重新按 B 的角色约束；
- B 不允许该值或 `allowOverride=false` 时，B 使用自己的 role.default；
- 不要求共享候选值同时满足群内所有角色的交集，否则低权限角色会锁死 owner/admin 的群级配置；
- 不在运行时惰性回写“修正值”，因为不同角色的正确结果可能不同；
- `config doctor` 按角色列出同一候选值的不同生效结果；
- 现有 `role-model-sync` 将锁定角色默认写回共享 relation 的做法必须停用或仅用于所有相关角色默认完全一致的兼容场景。

如果普通成员需要保存自己的偏好，新增独立的 member override 数据结构，例如 `memberBehavior.<aid>.<field>`，读取顺序为 member candidate → group candidate → role default；该数据只能影响对应成员触发的消息，不复用共享 relation 字段。

验收条件：同一群、同一 relation 候选值、两个不同角色可得到不同且稳定的 effective value；普通成员不能修改会影响其他成员的共享候选值。

### 15.5 读写切换：按字段原子迁移

**决策**：统一写入基础设施从阶段 5 提前到阶段 2；阶段 3 不允许出现新 resolver + 旧 writer 的组合。

每个字段的切换清单：

1. 注册表 spec 与 provider；
2. 内置角色策略和自定义角色规范化；
3. `resolveRuntimeField()` 读取；
4. `validateRuntimeConfigWrite()` 写入；
5. CLI、Menu、ECWeb、trigger/internal 调用；
6. current/describe 展示；
7. 新旧对拍或经批准的 golden difference；
8. 删除该字段旧 fallback/constraint。

低层 relation `write()` 当前在缺少 `sel.role` 或校验异常时可能 fail open。迁移字段必须改走 `writeRuntimeConfigPatch()`；维护任务只能使用审计化的 `mode:'migration'`。

验收条件：任一已迁移字段不存在能够绕开统一验证的生产写入口。

### 15.6 Schema 与磁盘迁移：生成行为片段、显式升版

**决策**：registry 是行为字段语义的单一事实源；JSON Schema 继续负责磁盘结构，并由 registry 生成/校验行为字段片段。

```text
runtime-field-registry
    ├─ 生成 agent-config 行为 properties
    ├─ 生成 relation-config 行为 properties
    ├─ 生成静态 type/enum/range/pattern
    └─ 动态 availability 仍由运行时 provider 校验
```

版本策略：

- agent config：v3→v4，承载叶子角色策略规范化；
- relation config：发生作用域收缩、响应模式结构迁移或新增 canonical 结构时 v2→v3；
- 每个迁移函数必须幂等，写盘前创建快照，成功后写 migration marker；
- 历史 defaults 行为字段先物化到各 agent config，再停止参与运行时合并；
- `defaults.json` 可继续作为“新建 agent 模板”，但不作为已存在 agent 的每消息行为层；
- 兼容窗口内保留可无损生成的旧字段 mirror；无法无损兼容的新语义通过 feature flag 延后启用；
- 回滚分为二进制回滚和配置回滚：只保证在 mirror 可表达范围内直接二进制回滚，其他情况必须恢复迁移前快照。

验收条件：生成产物可重复、仓库无 diff；v3/v2 fixtures 可迁移；重复迁移无变化；失败可恢复原文件。

---

## 16. 开发准入结论

满足以下条件后，文档状态可从“待评审”改为“Approved / Ready for Phase 1”：

1. 阶段 0 确认唯一响应模式实现；
2. `none` 身份策略形成 ADR；
3. trigger issuer/bypass 策略形成 ADR；
4. 本节六个阻塞契约获得负责人确认；
5. 阶段 0 对拍 fixtures 已提交；
6. agent v4 / relation v3 的迁移与回滚方案通过评审。

在此之前可以开发阶段 0、provider 接口和 registry 骨架，但不能切换生产字段语义。

---

## 17. 待确认决策

1. `active_baseagent` 是否正式收缩为 agent-only；
2. `sessionManifests` 是否正式收缩为 agent-only；
3. `excludeDynamicSections` 是否按角色控制；
4. `flush_delay/debounce` 各内置角色的 min/max/default；
5. `chatmode/dispatch` 的兼容期长度；
6. 扩展响应模式如何向独立 CLI 暴露运行时可用性。

以下两项已提升为阶段 0 / 阶段 3 硬前置，不再作为可延后问题：

- `none` 外部身份是否拒绝，或由身份系统显式映射 visitor；
- trigger override 是否允许绕过角色策略，以及可信 issuer 和字段级 bypass 的定义。

以上决策确定后，字段注册表和内置角色策略即可成为后续实现与文档的唯一依据。
