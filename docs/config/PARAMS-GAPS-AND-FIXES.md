# 配置缺口、硬编码与不一致清单（修复建议）

> 生成时间：2026-06-23
> 配套：[PARAMS-FULL-REFERENCE.md](./PARAMS-FULL-REFERENCE.md)
> 数据来源：`kits/schemas/*.json`、`src/config/*`、`src/core/*`、CLI 写入路径、消息处理与渠道实现。

本文用于列出当前配置体系中的真实缺口：写死默认值、schema 缺失、schema 与实现不一致、CLI 写入路径分裂、文档过期，以及更合理的修复顺序。

核心结论：**问题不只是 `defaults.json` 不完整，而是 H/HA 两条配置链的所有权没有收敛。** 在决定保留还是移除 `behavior.json` 之前，不建议简单地把所有行为默认值塞进 `defaults.json`。

## 实施状态（2026-06-23）

本轮按“路线 A：保留 `behavior.json`”处理 P0/P1 中的关键问题：

- 已更新 `01-overview.md`：当前架构明确为 H 配置链 + HA 行为链。
- `ConfigTarget` 已增加 `Behavior` / `RelationBehavior`，`ec config set/get/unset` 与 `ec agent set/get` 按完整字段路径路由到 canonical owner。
- `EvolAgent` 行为 setter 和新 agent 初始行为写入 `behavior.json`。
- `permissionMode` 全局兜底统一为 `auto`，schema 增加 enum。
- `dispatch` canonical enum 统一为 `mention` / `broadcast`，旧 `all` / `none` 在 effective 读取时兼容归一为 `broadcast`。
- `flush_delay` 兜底统一为 `DEFAULT_FLUSH_DELAY_SECONDS = 3`。
- `idleMonitor` 归属 `evolclaw.json`，schema 和 `index.ts` 读取来源已同步。
- `chatmode` 作为新 session 默认值接入 `SessionManager`；已有 session 仍以 session 状态为准，群聊仍强制 `proactive`。
- 配置快照扫描已纳入 agent/relation `behavior.json`。

仍未完成的中长期项：全局 HA 默认层、完整 source trace、channel discriminated schema、project path 默认解析统一、ecweb/serviceProxy item 细化、启动加载全面切 AJV schema。

这些剩余项已拆成可执行阶段，见 [CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md](./CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md)。

---

## 一、完整性结论

原清单已经抓住主线，但还不完整，需要补齐以下判断：

1. `behavior.json` 仍是运行时机制，不是历史残留。`resolveEffective()` 先合并 H 链，再叠加 HA 行为链。
2. 多个字段同时存在于 H 链和 HA 链，导致 `config.json` 中配置的值可能被 `behavior.json` 覆盖。
3. CLI 与运行时写入路径不统一，同一个字段可能被写到不同文件。
4. schema 只约束部分写入路径，启动加载 agent 时仍走业务校验，不等同于完整 AJV schema 校验。
5. 部分原结论已过期：`debounce` 已实现；`chatmode` 的实际新会话默认值主要在 `SessionManager` 中硬编码，不应只看 `EvolAgent.resolveChatMode()`。

---

## 二、当前真实配置链

### 2.1 H 链：人类配置链

代码入口：`src/config/config-manager.ts`

```
agents/defaults.json
  -> agents/{aid}/config.json
  -> agents/{aid}/relations/{peerKey}/config.json
```

关键点：

- `resolveAgentConfig()` 使用 `agent-config.schema` 的字段表合并 H 链。
- `dict` 合并只合并第一层键，同键整体替换，不递归合并。
- `routeField()` 只认识 `process/defaults/agent/relation` 四类 target，没有 behavior target。

### 2.2 HA 链：行为配置链

代码入口：`src/config/behavior.ts`

```
agents/{aid}/behavior.json
  -> behavior.roles.{role}
  -> agents/{aid}/relations/{peerKey}/behavior.json
```

关键点：

- `resolveBehavior()` 按 `agent behavior -> role -> relation behavior` 合并。
- `mergeBehaviorIntoEffective()` 把 HA 链结果叠加在 H 链结果之上。
- 因此同名字段以 `behavior.json` 为高优先级。

### 2.3 进程级配置

代码入口：`src/config-store.ts`、`src/index.ts`

```
evolclaw.json
```

关键点：

- `evolclaw.json` 是链外 process 配置，不参与 agent effective 覆盖链。
- 已处理：`globalSettings.idleMonitor` 现在从 `evolclawCfg.idleMonitor` 读取，归属进程级 `evolclaw.json`。

---

## 三、P0/P1 不一致与风险

### 3.1 文档曾宣称移除 behavior.json，但代码仍在使用（P0，已处理）

原过期文档：

- `docs/config/01-overview.md` 曾声称 v3 “去除 behavior.json，所有参数统一在 config.json”。

当前实现：

- `src/config/config-manager.ts:289` 调用 `mergeBehaviorIntoEffective()`。
- `src/config/behavior.ts:56` 仍实现 `resolveBehavior()`。
- `kits/schemas/behavior.schema.1.json` 仍存在。
- `ec model`、`/model`、`/effort`、`/perm` 等路径会写入或读取 behavior 语义。

处理结果：

- 已更新 `01-overview.md`，明确 `behavior.json` 仍是正式运行机制。
- 已补 `ConfigTarget.Behavior` / `ConfigTarget.RelationBehavior`、CLI 字段路由、schema、文档和测试。
- 中长期仍需二选一：
  - 保留 HA：把 behavior 字段正式纳入字段路由、schema、文档与测试。
  - 移除 HA：写迁移脚本，将 behavior 字段迁回 H 链，并删除运行时合并逻辑。

### 3.2 permissionMode 默认值冲突（P0，安全相关，已处理）

原冲突点：

```ts
// src/types.ts:211
export const DEFAULT_PERMISSION_MODE = 'bypass';

// src/core/model/config-scope.ts:221
const FALLBACK_PERMISSION_MODE = 'auto';
```

当前实际解析链：

```
relation behavior.permissionMode
  -> roles.{role}.permissionMode
  -> built-in role default
  -> auto
```

内置角色默认：

| role | 默认值 |
|------|--------|
| owner | `bypass` |
| admin | `bypass` |
| guest | `readonly` |
| anonymous | `readonly` |
| 其他 | `auto` |

处理结果：

- `DEFAULT_PERMISSION_MODE` 已统一为 `auto`。
- `bypass` 仅作为 owner/admin 的角色默认。
- `behavior.schema` / `relation-config.schema` 已补 `permissionMode` enum。

### 3.3 CLI 与运行时写入路径分裂（P0，已处理核心路径）

原问题：

| 写入口 | 实际目标 | 风险 |
|--------|----------|------|
| `ec config set` | H 链：`config.json` / `defaults.json` / relation `config.json` | 不会写 behavior |
| `ec agent set` | H 链：agent `config.json` | 和 behavior 字段可能同名冲突 |
| `ec model` | behavior 语义 | 与 `ec config set baseagents.*.model` 分裂 |
| `/model`、`/effort` | behavior 语义 | 可能覆盖 H 链配置 |
| `/perm` | relation behavior | 与 relation `config.json.permissionMode` 分裂 |
| `EvolAgent.setShowActivities()` 等 | 方法名叫 mutateBehavior，但实际写 `ConfigTarget.Agent` | 命名与行为不一致 |

关键代码：

- `src/config/config-manager.ts:307`：`routeField()` 没有 behavior target。
- `src/cli/agent.ts:995`：`agentGet/agentSet` 注释仍称“统一在 config.json”。
- `src/core/model/config-scope.ts:1`：model/effort/permissionMode 明确写 behavior。
- `src/core/evolagent.ts:373`：`mutateBehavior()` 实际读写 `ConfigTarget.Agent`。

处理结果：

- 已建立 `routeFieldPath()`，按完整字段路径路由 canonical owner。
- `ec config get/set/unset` 与 `ec agent get/set` 已使用完整路径路由。
- `ec config fields/show/validate/init` 已纳入 behavior target。
- 旧 H 文件中的同名行为字段保留读取兼容，新写入走 canonical owner。

### 3.4 baseagents 在 H/HA 重复，且 dict 不递归（P1）

当前情况：

- H 链 `baseagents` 存 `apiKey/baseUrl/model/effort/...`。
- HA 链 `baseagents` 也存 `model/effort/...`。
- behavior 覆盖 H 链。
- `dict` 合并不递归，同名 baseagent 整块替换。

风险示例：

```jsonc
// defaults.json
{
  "baseagents": {
    "claude": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "baseUrl": "...",
      "model": "claude-sonnet-4"
    }
  }
}

// relation/config.json
{
  "baseagents": {
    "claude": {
      "model": "claude-opus-4"
    }
  }
}
```

由于 `baseagents.claude` 同键整体替换，relation 层只写 `model` 会丢掉低层的 `apiKey/baseUrl`。

建议：

- H 链只保留凭证与基础设施：`apiKey`、`baseUrl`、`useSettingSources` 等。
- HA 链只保留行为：`model`、`effort/reasoning`、`mode` 等。
- 如果必须支持关系级只覆盖 model，需要为 `baseagents.<ba>` 做字段级 schema，或改为递归合并，但这会改变现有覆盖语义，必须配迁移和测试。

### 3.5 dispatch 枚举不一致（P1，已处理）

原枚举：

| 来源 | 允许值 |
|------|--------|
| `agent-config.schema` | `all` / `mention` / `none` |
| `relation-config.schema` | `mention` / `broadcast` |
| `behavior.schema` | `all` / `mention` / `broadcast` / `none` |
| slash/menu 命令 | `mention` / `broadcast` / `clear` |
| AUN 过滤实现 | 只有 `mention` 特判；其他值近似 broadcast |

处理结果：

- `behavior.schema`、`relation-config.schema`、`agent-config.schema` 已统一为 `mention` / `broadcast`。
- 旧 H 配置中的 `all` / `none` 在 effective 读取时兼容归一为 `broadcast`。
- 仍需文档化服务器下发值、session override、agent 默认值的最终优先级。

### 3.6 flush_delay 两套兜底（P1，已处理）

原兜底：

| 位置 | 兜底 |
|------|------|
| `message-processor.ts:902` | `3` 秒 |
| `im-renderer.ts:318` | `4000ms` |
| AUN/Wechat channel options | 多处传入 `3` 秒 |

处理结果：

- 已新增 `DEFAULT_FLUSH_DELAY_SECONDS = 3` / `DEFAULT_FLUSH_DELAY_MS = 3000`。
- `MessageProcessor`、`IMRenderer`、AUN/Wechat channel fallback 已使用同一常量。

---

## 四、硬编码默认值清单

下列默认值在配置缺失时会生效，或在某些路径作为兜底生效。

| 参数 | 当前兜底 | 代码位置 | 当前问题 | 建议落点 |
|------|----------|----------|----------|----------|
| `active_baseagent` | `claude` | `config-scope.ts:108` | behavior/config 都可能影响，默认源不清 | 先定 H/HA；若保留 HA，应作为 behavior 默认 |
| `chatmode.private` | `interactive` | `session-manager.ts`、`evolagent.ts` | 已接入 SessionManager provider；已有 session 仍以状态为准 | behavior 作为新 session 默认 |
| `chatmode.group` | `proactive` | `session-manager.ts:54`、`evolagent.ts:341` | 群聊强制 proactive，配置语义需明确 | 文档化强制规则 |
| `chatmode.nothuman` | `proactive` | `session-manager.ts:57` | agent-to-agent 场景默认硬编码 | behavior 默认或删除未使用项 |
| `flush_delay` | `3` 秒 | `core/defaults.ts` | 已统一常量 | behavior 默认 |
| `dispatch` | `mention` | `aun.ts` server fallback | enum 已统一，session override 优先级仍需文档化 | behavior 默认或 agent 默认 |
| `proactive.pre_tool_1stmsgchk` | `true` | `message-processor.ts:102` | 代码硬编码 | behavior 默认 |
| `proactive.tool_use_reminder` | `true` | `message-processor.ts:103` | 代码硬编码 | behavior 默认 |
| `enable_rich_content` | `false` | `feishu.ts` | 主要 Feishu 使用，默认源不清 | agent/behavior 默认，标注渠道范围 |
| `permissionMode` | `auto` | `config-scope.ts:221`、`types.ts` | 已统一默认 | behavior |
| `idleMonitor.timeout` | `120` 秒 | `message-processor.ts:576` | 已归属 process schema | `evolclaw.json` |
| `idleMonitor.enabled` | `true` | `message-processor.ts:603` | 已归属 process schema | `evolclaw.json` |
| `debounce` | `0` | `message-bridge.ts:36` | 已实现，但默认与热更新语义不清 | behavior/agent 默认，补缓存策略 |
| `show_activities` | `all` | `evolagent.ts:203`、`channel-loader.ts:73` | agent 级与 channel instance 级语义需区分 | behavior 默认，channel 可局部覆盖 |
| `projects.defaultPath` | `paths.root/projects/default` 或 `process.cwd()` | `index.ts:806`、`evolagent.ts:104` | 多处 fallback 不一致 | defaults.projects 明确默认 |
| `ecweb.port` | `42705` | `index.ts:1183`、`config-store.ts:91` | 只有注释/schema 类型，无默认物化 | evolclaw.json schema default |
| `serviceProxy.enabled` | `false` | `index.ts:1217` | 只有存在且 true 才启动 | evolclaw.json schema default |
| `serviceProxy.services[].enabled` | `true` | `config-store.ts` 类型注释、service-proxy 实现 | schema 未细化 service item | evolclaw schema 细化 |
| `serviceProxy.services[].serviceType` | `http` | service-proxy 实现/注释 | schema 未细化 | evolclaw schema 细化 |
| `serviceProxy.services[].visibility` | `private` | service-proxy 实现/注释 | schema 未细化 | evolclaw schema 细化 |

注意：上表的“建议落点”不是要求立即全部写入 `defaults.json`。行为字段必须先解决 H/HA 所有权，否则写入低优先级 H 链后仍可能被 HA 覆盖。

---

## 五、Schema 缺失与 schema/实现不一致

### 5.1 defaults.schema 不支持大量行为字段

`kits/schemas/defaults.schema.1.json` 当前支持：

- `owners`
- `admins`
- `models`
- `active_baseagent`
- `baseagents`
- `projects`
- `aun`
- `debug`

但不支持：

- `chatmode`
- `dispatch`
- `flush_delay`
- `debounce`
- `show_activities`
- `proactive`
- `enable_rich_content`
- `permissionMode`
- `render`
- `idleMonitor`

影响：

- 即使某些 defaults 文件里存在这些字段，也不代表 `ec config set --scope defaults` 能合法写入。
- `ConfigManager.write(ConfigTarget.Defaults)` 会按 schema 拦截未知字段。
- `config-store.loadDefaults()` 直接读 JSON，不等同于 schema 完整校验。

建议：

- 如果保留 HA：不要把行为字段直接扩进 defaults H schema，而是为 HA 增加全局行为默认层，或让 `defaults.json` 显式区分 H 与 HA 子块。
- 如果移除 HA：才把行为字段补进 `defaults.schema`，并删除 behavior 覆盖链。

### 5.2 evolclaw.schema 缺少 idleMonitor（已处理）

代码读取：

- `message-processor.ts:576`：`globalSettings.idleMonitor?.timeout ?? 120`
- `message-processor.ts:603`：`globalSettings.idleMonitor?.enabled !== false`

原 schema：

- `evolclaw.schema.1.json` 没有 `idleMonitor`。
- `index.ts` 从 `defaults` 组装 `globalSettings.idleMonitor`，不是从 `evolclawCfg`。

处理结果：已选择放 `evolclaw.json`。

| 方案 | 含义 | 改动 |
|------|------|------|
| 放 `evolclaw.json` | daemon 进程级空闲监控策略 | 补 evolclaw schema，并把 `index.ts` 改为读 `evolclawCfg.idleMonitor` |
| 放 defaults/behavior | agent 默认行为策略 | 补对应 schema，并让每个 agent/session 解析 effective 值 |

如果按“进程级控制”理解，建议使用第一种。

### 5.3 permissionMode schema 没有 enum

当前 `behavior.schema`、`relation-config.schema` 只声明 `permissionMode` 是 string。

建议 enum：

```jsonc
["auto", "bypass", "readonly", "request", "edit", "plan", "noask"]
```

同时要确认 runner 实际支持这些模式。未支持的值不要进入 schema。

### 5.4 channel 配置 schema 过宽

`agent-config.schema` 中 `channels[]` item 基本是 object，没有细化各渠道字段。

影响：

- 渠道实例字段如 `flushDelay`、`debounce`、`showActivities`、`requireMention` 等缺少统一验证。
- CLI/schema 文档无法准确列出每个 channel type 支持的字段。

建议：

- 短期：在参数参考文档中明确“channel item 当前宽松透传”。
- 中期：为每个 channel type 建立 discriminated schema，或让 channel plugin 提供 schema fragment。

### 5.5 启动加载与 ConfigManager 校验不一致

当前：

- `ConfigManager.write()` 会按 AJV schema 校验。
- `loadAllAgents()` 调用 `validateAgentConfig()`，该函数因 schema 不完整仍保留业务规则校验。

代码注释明确说明：

- agent config schema 尚未完整。
- 现存 agent config 含 schema 未定义子字段。
- 直接切 AJV 会导致加载失败。

建议：

- 不要把“schema 定义存在”等同于“运行时完整约束”。
- 先补全 agent schema，再把启动加载切到统一 schema 校验。

---

## 六、原清单需要修正的项

### 6.1 debounce 已实现，不是“传入即丢”

当前实现：

- `MessageBridge` 维护 `StreamDebouncer`。
- 非群聊 interrupt 模式会在 enqueue 前做 debounce。
- `StreamDebouncer` 会合并窗口内同 session 的多条消息。

真实问题：

- 默认值来自 `primaryAgent?.config.debounce` 或 `0`，多 agent/多 channel 下默认归属不清。
- debouncer 按 channelName 缓存，配置变更后不一定立即生效，除非渠道重载或 removeChannel。
- schema 与 defaults 路由不完整。

建议：

- 文档改为“已实现，但默认源、作用域、热更新语义需补齐”。
- 添加测试：debounce > 0 时多条私聊消息合并；群聊 FIFO 不走 debouncer；channel reload 后 debounce 更新。

### 6.2 chatmode 不是单纯配置默认

当前路径分裂：

- 新 session 创建默认：`SessionManager.resolveDefaultChatMode()`。
- agent context fallback：`EvolAgent.resolveChatMode()`。
- `MessageProcessor` 任务执行主要使用持久化的 `session.chatMode`。

因此，在 `config.json` 或 `behavior.json` 中改 `chatmode.private`，不一定影响已经存在的 session，也不一定影响所有新 session 创建路径。

建议：

- 如果 `chatmode` 是配置项：SessionManager 必须接入 effective config。
- 如果 `chatmode` 是 session 状态：文档应说明配置只作为新 session 初始值，已有 session 以 session metadata 为准。
- 当前文档不能继续写成“defaults.json 中配置即可全局生效”。

### 6.3 admins、models.allowed 不应直接写成安全边界

当前文档可保留这些字段，但需要谨慎描述：

- `admins[]` 在身份/角色解析中有使用价值。
- `models.allowed[]` 是否作为强制安全边界，需要按 model catalog、runner、gateway 路径逐一确认。

建议：

- 在未补测试前，文档写成“配置字段存在，执行强约束需进一步验证”，不要直接承诺安全边界。

### 6.4 render 是有效字段，不应归为未用

`render.{private,group,inject}` 会传给 ECK message renderer，用于选择渲染模式。

建议：

- 保留在参数参考中。
- 标明默认来自 ECK manifest 或 renderer fallback，而不是简单写死在 defaults。

### 6.5 enable_rich_content 主要是 Feishu 范围

当前 `enable_rich_content` 通过 channel build context 传入，实际主要由 Feishu 渠道使用。

建议：

- 文档标注“当前主要 Feishu 生效”。
- schema/default 不要写成全渠道通用行为，除非其他 channel 也接入。

---

## 七、遗漏配置域

### 7.1 project path 默认值分裂

当前 fallback 分布：

- `EvolAgent.projectPath`：`projects.defaultPath || process.cwd()`。
- `index.ts` 创建 `MessageBridge` 默认路径：`primaryAgent.projectPath -> defaults.projects.defaultPath -> paths.root/projects/default`。
- agent 创建路径：显式值 -> `defaults.projects.rootPath` 派生 -> `defaults.projects.defaultPath`。

建议：

- 定义唯一 project 默认解析函数。
- `rootPath` 派生、`defaultPath`、`process.cwd()` 的优先级写入文档和测试。

### 7.2 ecweb 与 serviceProxy 默认值未纳入清单

当前：

- `ecweb.port` 代码兜底 `42705`。
- `serviceProxy.enabled` 默认 false。
- service item 中 `enabled/serviceType/visibility/source` 有注释或实现默认，但 schema 没有细化。

建议：

- 补进 `evolclaw.schema` 的 defaults 或文档默认值。
- 细化 `serviceProxy.services[]` item schema，避免任意 object。

### 7.3 dispatch 的 session 级 override 未说明

群聊 dispatch 不只是 agent 配置：

- 服务器下发值可能进入 session metadata。
- `/dispatch` 会写 session `dispatchModeOverride`。
- agent config/behavior 只是 fallback。

建议：

文档写清优先级：

```
session.metadata.dispatchModeOverride
  -> session.metadata.dispatchMode
  -> agent effective dispatch
  -> mention
```

实际优先级需以 AUN dispatch resolver 与 menu/slash handler 最终实现为准，并补测试。

### 7.4 show_activities 有 agent 级和 channel instance 级两套语义

当前：

- agent effective `show_activities` 通过 `EvolAgent.getShowActivities()` 使用。
- channel instance 还有 `showActivities`，由 `resolveShowActivities(inst)` 读取。
- `all` 实际只对私聊中间活动有意义，群聊通常强制 proactive，不发中间活动。

建议：

- 明确 `show_activities` 和 `channels[].showActivities` 的优先级。
- 文档不要把 `all` 描述成“所有场景都显示”。

---

## 八、推荐修复路线

### 路线 A：保留 behavior.json（推荐短中期）

适用原因：

- 当前代码已经在使用 HA 链。
- model/effort/permissionMode 的运行时语义更接近“可由 agent/会话调整的行为参数”。
- 直接移除 behavior 需要迁移和权限设计，风险更大。

建议规则：

| 配置类别 | 文件归属 |
|----------|----------|
| daemon 运行配置 | `evolclaw.json` |
| 全局基础设施默认 | `agents/defaults.json` |
| agent 身份、owner/admin、channel、凭证引用 | `agents/{aid}/config.json` |
| relation 的人类授权/基础设施覆盖 | `relations/{peerKey}/config.json` |
| model/effort/permissionMode/chatmode/dispatch/proactive/render 等行为 | `behavior.json` |

必须补的能力：

1. 给 behavior 链增加全局行为默认层，或在 defaults 中显式区分 H 默认与 behavior 默认。
2. `ConfigTarget` 增加 Behavior/RelationBehavior，`routeField()` 能返回 behavior target。
3. CLI 文档从“统一写 config.json”改成“按字段 owner 写入不同文件”。
4. `ec config effective` 展示每个字段来源：defaults/config/relation/behavior/role/relation behavior。

### 路线 B：移除 behavior.json（长期备选）

适用前提：

- 已完成权限控制，agent 不能随意改 H 文件。
- 已有迁移脚本把所有 behavior 字段迁回 config/relation config。
- 运行时、CLI、schema、文档全部删除 behavior 入口。

需要改动：

1. 删除 `mergeBehaviorIntoEffective()` 调用。
2. 删除或废弃 `behavior.schema`。
3. 改 `ec model`、`/model`、`/perm` 等写入 H 链。
4. 修复 Hook/API 权限，保证 agent 可写字段不会污染人类专属配置。

当前不建议直接走路线 B，因为现有实现与文档已经严重偏离，强行迁移风险较高。

---

## 九、修复优先级

### P0：先消除错误架构认知和安全冲突

1. 更新 `01-overview.md`：删除“behavior.json 已移除”的表述，改为当前真实 H+HA 架构。
2. 统一 `permissionMode` 默认值：全局兜底 `auto`，owner/admin 角色默认 `bypass`。
3. 建立字段所有权表：每个字段只能有一个 canonical 写入路径。
4. 修复 CLI 文案与实际写入路径：`ec config set`、`ec agent set`、`ec model`、slash/menu 命令必须一致。

### P1：修 schema 与运行时关键不一致

5. 统一 `dispatch` enum 为 `mention` / `broadcast`，迁移或拒绝 `all` / `none`。
6. 统一 `flush_delay` 默认常量，移除 3 秒和 4000ms 双兜底。
7. 决定 `idleMonitor` 归属；若是进程级，补 `evolclaw.schema` 并改 `index.ts` 读取来源。
8. 修正 `chatmode` 语义：配置作为新 session 默认，或 session 独立状态，二选一写清并实现。
9. 拆分 `baseagents` 中凭证与行为，避免 model/effort 在 H/HA 双写。

### P2：完善可维护性

10. 补全 agent/channel schema，逐步替换 `validateAgentConfig()` 的业务校验。
11. 文档化 `debounce` 已实现但受 channel debouncer 缓存影响。
12. 补 project path、ecweb、serviceProxy 默认值文档和 schema。
13. 为配置链加测试：
    - H 链覆盖顺序。
    - HA 链覆盖 H 链。
    - role 与 relation behavior 优先级。
    - `permissionMode` 默认。
    - `dispatch` 过滤。
    - `chatmode` 新 session 初始化。
    - `debounce` 合并与热更新。

---

## 十、建议的字段所有权草案

这张表用于指导后续 schema 和 CLI 路由调整。

| 字段 | 建议 owner | 理由 |
|------|------------|------|
| `aid` | H/process 或 H/agent | 身份字段，不应被 agent 行为层覆盖 |
| `owners` / `admins` | H | 授权字段，人类管理 |
| `channels[]` | H | 渠道凭证和基础设施 |
| `aun` | H/process/defaults | 网络与凭证基础设施 |
| `debug` | process/defaults | 运行诊断 |
| `projects` | H defaults/agent | 项目路径是人类配置 |
| `active_baseagent` | HA 或 H，需二选一 | 当前语义偏行为，但也影响 runner 选择 |
| `baseagents.<ba>.apiKey/baseUrl` | H | 凭证与网关基础设施 |
| `baseagents.<ba>.model/effort/reasoning` | HA | 运行行为，可按 role/relation 调整 |
| `permissionMode` | HA | 会话/关系行为策略 |
| `roles.*` | HA | 行为派生 |
| `chatmode` | HA 或 session 默认模板 | 当前主要是 session 状态 |
| `dispatch` | HA + session override | 群聊行为策略 |
| `flush_delay` | HA | 出站行为参数 |
| `debounce` | HA 或 channel instance | 入站行为参数，需定义 channel 优先级 |
| `show_activities` | HA | 输出可见性策略 |
| `channels[].showActivities` | H/channel instance | 单 channel 局部覆盖 |
| `enable_rich_content` | HA 或 channel feature | 当前主要 Feishu 使用 |
| `render` | HA | 输出渲染行为 |
| `idleMonitor` | process 或 HA，需二选一 | 若控制 daemon 流处理，建议 process |
| `ecweb` | process | daemon 附属服务 |
| `serviceProxy` | process | daemon 附属服务 |

---

## 十一、默认值样例（按路线 A）

如果保留 HA 链，不建议把行为默认值平铺进 H 链 `defaults.json`。更清晰的形态是增加“全局 behavior 默认层”，例如概念上：

```jsonc
{
  "$schema_version": 1,
  "active_baseagent": "claude",
  "baseagents": {
    "claude": {
      "model": "claude-sonnet-4",
      "effort": "auto"
    }
  },
  "flush_delay": 3,
  "debounce": 0,
  "show_activities": "all",
  "dispatch": "mention",
  "enable_rich_content": false,
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

该文件可以是新增的 behavior defaults，也可以是 `defaults.json` 中明确标记的 behavior 子块；关键是 ConfigManager、schema、CLI 和文档必须统一认定它属于 HA 默认，而不是普通 H 字段。

---

## 十二、最终建议

短期不要继续扩散“v3 已经统一 config.json”的说法。当前最稳妥的修复顺序是：

1. 承认当前真实架构是 H 链 + HA 链。
2. 定义字段 owner 和唯一写入口。
3. 修 P0 安全默认与 CLI 写入分裂。
4. 再补 defaults/schema/default 常量。
5. 最后生成参数参考文档，避免手工表格再次过期。
