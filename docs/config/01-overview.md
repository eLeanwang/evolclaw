# 配置体系总体架构

> EvolClaw 配置体系 v3 - 2026-06-19

---

## 一、设计原则

### 核心决策

**所有参数统一在 config.json**
- 所有参数都在同一个 config.json 中
- 权限控制在 API 层，而非文件级
- Hook 禁止 agent 直接读写所有配置文件

---

## 二、四层配置体系

EvolClaw 采用「1 + 3」四层配置：

```
{evolclaw_home}/
├── evolclaw.json                          ← ① 进程级
├── .env                                    ← 全局凭证（禁读）
├── backups/config/                        ← 配置快照目录
│   ├── current.json                       ← 回落起点指针
│   ├── w-version.json                     ← W当前版本标记
│   ├── boot-log.jsonl                     ← 启动日志
│   ├── v100/                              ← 全量版本（百位递增）
│   │   ├── meta.json                      ← 版本元数据
│   │   ├── snapshot/                      ← 完整配置树
│   │   ├── v101/ v102/ ...                ← 增量版本
│   └── v200/
└── agents/
    ├── defaults.json                      ← ② 全局级
    └── {aid}/
        ├── config.json                    ← ③ Agent级
        ├── .env                            ← agent 级凭证
        └── relations/{peerKey}/
            ├── config.json                ← ④ 关系级
            └── .env                        ← 关系级凭证
```

### 「1 + 3」的含义

- **① 进程级** (`evolclaw.json`)：daemon 自身配置，不参与覆盖链
- **②③④** 形成覆盖链：`defaults → agent → relation`（越靠后优先级越高）

---

## 三、各层职责

### ① 进程级 `evolclaw.json`

daemon 自身的运行配置，与 agent 行为无关。

**Schema 逻辑名**：`evolclaw`

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | string | daemon 默认身份（AID） |
| `owners` | string[] | 进程控制面鉴权名单 |
| `aun.encryptionSeed` | string | keystore 加密种子（应用 .env 引用） |
| `tunnel` | TunnelConfig | 内网穿透配置 |
| `ecweb` | {enabled, port} | web 控制台 |
| `debug` | DebugBlock | daemon 级日志 |

---

### ② 全局级 `agents/defaults.json`

所有 agent 共享的基础设施默认值，是覆盖链的**最低优先级**。

**Schema 逻辑名**：`defaults`

| 字段 | 类型 | 说明 |
|------|------|------|
| `owners` | string[] | 全局 owner（list 并集） |
| `admins` | string[] | 全局 admin（list 并集） |
| `models.default` | string | 全局默认模型 |
| `models.allowed` | string[] | 模型白名单 |
| `active_baseagent` | string | 当前活跃的 base agent |
| `baseagents` | BaseagentsBlock | 各 base agent 配置 |
| `projects` | ProjectsBlock | 项目路径默认值 |
| `aun` | AunRuntimeBlock | AUN 连接默认配置 |
| `debug` | DebugBlock | 全局日志配置 |

**说明**：defaults.json 可以包含任何"所有 agent 共享"的字段。

---

### ③ Agent 级 `agents/{aid}/config.json`

单 agent 的身份、凭证、行为参数。覆盖 defaults。

**Schema 逻辑名**：`agent-config`

| 字段分类 | 字段 | 说明 |
|---------|------|------|
| **身份** | `aid` | Agent 标识（必填） |
| | `enabled` | Agent 启用状态 |
| | `initialized` | AUN 首次初始化标记 |
| | `observable` | 是否对外可观测 |
| **权限** | `owners` | Agent owner（list 并集） |
| | `admins` | Agent 管理员（list 并集） |
| **渠道** | `channels[]` | 渠道实例（含凭证引用） |
| **模型** | `models` | 模型配置 |
| | `active_baseagent` | 当前活跃的 base agent |
| | `baseagents` | 各 base agent 配置 |
| **行为** | `chatmode` | 对话模式 |
| | `flush_delay` | 消息 flush 间隔 |
| | `debounce` | 入站消息去抖 |
| | `dispatch` | 群聊分发策略 |
| | `show_activities` | 中间活动可见性 |
| | `proactive` | Proactive 模式策略 |
| | `render` | 渲染模式 |
| | `enable_rich_content` | 富内容渲染 |
| | `permissionMode` | 执行权限模式 |
| | `roles` | 角色级覆盖 |
| **基础设施** | `aun` | AUN 配置 |
| | `projects` | 项目路径 |
| | `debug` | agent 级日志 |
| | `extra_backup` | 额外备份声明 |

---

### ④ 关系级 `agents/{aid}/relations/{peerKey}/config.json`

针对特定对端的个性化配置。覆盖链最高优先级。

**Schema 逻辑名**：`relation-config`

**支持 29 个关系级参数**（详见 `docs/config/config-params-classified.md`）：

| 参数类别 | 典型字段 |
|---------|---------|
| **模型配置** | `models.default`, `active_baseagent`, `baseagents.*.model/effort` |
| **对话模式** | `chatmode.*`, `flush_delay`, `debounce`, `dispatch` |
| **交互体验** | `show_activities`, `enable_rich_content` |
| **Proactive 策略** | `proactive.*` |
| **渲染模式** | `render.*` |
| **权限控制** | `permissionMode`, `roles.*` |

**peerKey 格式**：`{channelType}#{urlEncode(channelId)}`
- 例：`aun#alice.aid.pub`、`feishu#ou_xxx`

---

## 四、覆盖链

配置参数按以下优先级合并：

```
关系级（最高） > agent级 > 全局级 defaults（最低）
```

**进程级独立**，不参与覆盖链。

### 合并规则

对每个参数，按类型合并：

| 参数类型 | 合并行为 |
|---------|---------|
| **标量** (string/number/bool) | 高优先级整体覆盖 |
| **列表** (array) | 并集追加去重 |
| **字典** (object) | 键并集；同键 → 高优先级值覆盖 |

**关键点**：
- 合并粒度 = 字典的第一层键，不递归
- 例如：`owners[]` 是列表 → 沿链并集合并
- 例如：`baseagents` 是字典 → 键并集，`baseagents.claude.model` 可独立覆盖

详见 `02-merge-rules.md`。

---

## 五、凭证管理

**规则**：凭证一律写入 `.env` 文件，配置 JSON 只放引用。

### .env 三级

| 级别 | 路径 |
|------|------|
| 全局 | `{evolclaw_home}/.env` |
| agent | `{evolclaw_home}/agents/{aid}/.env` |
| 关系 | `{evolclaw_home}/agents/{aid}/relations/{peerKey}/.env` |

### 引用格式

```jsonc
// agents/{aid}/config.json
{
  "channels": [
    { "type": "feishu", "appSecret": "${FEISHU_APP_SECRET}" }
  ]
}

// evolclaw.json
{ "aun": { "encryptionSeed": "${AUN_ENCRYPTION_SEED}" } }
```

### 解析优先级

```
关系级 .env > agent 级 .env > 全局 .env > process.env
```

### 安全保证

- CLI 读命令**永不展开** `${VAR}`（显示字面量）
- 只有 ConfigManager 内部运行时展开
- Hook 拦截 agent 对任何 `.env` 的读写
- 快照不包含 `.env`

---

## 六、权限控制

**核心原则**：权限控制在 API 层，而非文件级。

### 实施方式

1. **Hook 拦截直接文件访问**
   - 禁止 agent 直接读写所有配置文件
   - 禁止 agent 读写所有 `.env` 文件

2. **API 层权限判断**
   - Agent 通过 CLI（`ec model`, `ec ctl`, `ec config`）修改配置
   - CLI 内部根据参数类型和调用方身份判断是否允许
   - 某些参数可能标记为"人类专属"（未来实现）

3. **当前状态**
   - Agent 可以通过 CLI 修改任意配置参数
   - 权限体系的具体设计待完善

详见 `07-security.md`。

---

## 七、配置快照

自动备份机制保证配置可回滚。

### 双指针模型

| 文件 | 语义 |
|------|------|
| `current.json` | 回落起点指针 |
| `w-version.json` | W当前展开的版本 |

### 版本产生时机

| 场景 | 类型 |
|------|------|
| 手动 `ec config snapshot` | 全量/增量自动判定 |
| 启动成功 + W≠w-version | 自动增量 |
| 启动成功 + W==w-version | 不建版本，successCount+1 |
| 进入自检模式 | 存档当前 W |
| schema 迁移前 | 无条件全量 |

### 自检模式

启动失败时，`ec start --diagnose` 逐版本回落，直到找到可用版本。

详见 `05-snapshot.md`。

---

## 八、CLI 命令

统一的配置读写入口：`ec config`

### 核心命令

| 命令 | 功能 |
|------|------|
| `ec config get <field>` | 读参数 + 解析链 + 来源标注 |
| `ec config set <field> <value>` | 写参数（自动判定层级） |
| `ec config show` | 查看文件原始内容 |
| `ec config effective` | 打印合并后的全部配置 |
| `ec config snapshot` | 创建快照 |
| `ec config restore <version>` | 恢复到指定版本 |

### Selector

| 参数 | 作用域 |
|------|--------|
| `--self <aid>` | agent 层 |
| `--self <aid> --peer <peerKey>` | relation 层 |
| `--default` | defaults 层 |
| `--process` | process 层（进程级） |

详见 `06-cli-commands.md`。

---

## 九、Schema 治理

Schema 是**参数类型与归属的唯一事实源**。

### Schema 文件

```
kits/schemas/
├── evolclaw.schema.1.json            ← evolclaw.json
├── defaults.schema.1.json            ← agents/defaults.json
├── agent-config.schema.1.json        ← agents/{aid}/config.json
├── relation-config.schema.1.json     ← relations/{peerKey}/config.json
├── migrations/                       ← 版本迁移函数
└── _meta.json                        ← 各 schema 当前版本索引
```

### Schema 版本化

- 每个 schema 带版本号（文件名：`逻辑名.schema.{版本}.json`）
- 配置文件中的 `$schema_version` 指向匹配的 schema 版本
- 升级时逐版本应用迁移函数

详见 `03-schema.md`。

---

## 十、TypeScript 类型

### 核心接口

```typescript
/** 进程级 */
interface ProcessConfig {
  aid: string;
  owners: string[];
  aun?: { encryptionSeed?: string };
  // ...
}

/** 全局级 */
interface DefaultsConfig {
  owners?: string[];
  admins?: string[];
  models?: ModelsBlock;
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  // ...
}

/** Agent 级 */
interface AgentConfig {
  aid: string;
  enabled?: boolean;
  owners?: string[];
  channels: ChannelInstance[];
  // 模型配置
  models?: ModelsBlock;
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  // 行为参数
  chatmode?: ChatmodeBlock;
  flush_delay?: number;
  debounce?: number;
  // ...
}

/** 关系级 */
interface RelationConfig {
  // 支持 29 个关系级参数
  models?: ModelsBlock;
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  chatmode?: ChatmodeBlock;
  // ...
}

/** 运行时合并结果 */
interface EffectiveAgentConfig {
  aid: string;
  enabled?: boolean;
  owners?: string[];
  channels: ChannelInstance[];
  // 所有参数的合并结果
  models?: ModelsBlock;
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  chatmode?: ChatmodeBlock;
  // ...
}
```

详见 `04-config-manager.md`。

---

## 十一、ConfigManager

统一的配置读写入口。所有配置操作经过 `ConfigManager`。

### 核心方法

```typescript
ConfigManager
├── read<T>(target, selector?): T | null
├── write<T>(target, value, opts?): void
├── resolveAgentConfig(selector): AgentConfig   // 覆盖链合并
├── resolveEffectiveAgentConfig(selector): EffectiveAgentConfig
├── ensureFile(target, selector?): void
└── snapshot(opts?): SnapshotResult
```

### ConfigTarget

```typescript
enum ConfigTarget {
  Process   = 'process',         // evolclaw.json
  Defaults  = 'defaults',        // agents/defaults.json
  Agent     = 'agent',           // agents/{aid}/config.json
  Relation  = 'relation',        // relations/{peerKey}/config.json
}
```

详见 `04-config-manager.md`。

---

## 十二、相关文档

| 文档 | 说明 |
|------|------|
| `02-merge-rules.md` | 覆盖链与合并规则详解 |
| `03-schema.md` | Schema 治理与版本化 |
| `04-config-manager.md` | ConfigManager API 详解 |
| `05-snapshot.md` | 快照与回滚机制 |
| `06-cli-commands.md` | CLI 命令完整清单 |
| `07-security.md` | 安全与权限控制 |
| `08-quick-reference.md` | 快速参考与常用操作 |
| `config-params-classified.md` | 完整参数清单（81+ 个参数） |
| `code-refactoring-plan.md` | 代码改造清单 |

---

**版本**：v3 (2026-06-19)
