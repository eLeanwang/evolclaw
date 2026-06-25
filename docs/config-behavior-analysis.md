# config.json vs behavior.json 参数差异分析

## 设计原则

EvolClaw 采用**双文件配置系统**：

| 文件 | Schema | 权限 | 用途 |
|------|--------|------|------|
| **config.json** | agent-config.schema.1.json | **H** (Human-only) | 身份、凭证、管控字段（仅人类可修改） |
| **behavior.json** | behavior.schema.1.json | **HA** (Human-Agent) | 行为参数（人类和 Agent 均可修改） |

**硬约束**：两个 schema 的字段名空间必须**严格不相交**（由 `assertDisjointFields()` 在加载期校验）。

---

## config.json (H 权限字段)

仅人类可修改的敏感设置：

| 字段 | 类型 | 合并语义 | 说明 |
|------|------|----------|------|
| `$schema_version` | number | scalar | Schema 版本号 |
| `aid` | string | scalar | Agent 标识（必填） |
| `enabled` | boolean | scalar | Agent 启用状态 |
| `initialized` | boolean | scalar | AUN 首次初始化标记 |
| `owners` | array | list | Agent owner（AID 列表，沿链并集） |
| `admins` | array | list | Agent 管理员（AID 列表，沿链并集） |
| `channels` | array | list | 渠道实例（含 appSecret/token 等凭证） |
| `aun` | object | dict | AUN 配置（keystorePath, encryptionSeed, gatewayUrl） |
| `models` | object | dict | 模型白名单（default, allowed） |
| `projects` | object | dict | 项目路径（rootPath, defaultPath） |
| `debug` | object | dict | 调试选项 |
| `observable` | boolean | scalar | 观察者模式：入站/出站各转一份给 owners |
| `extra_backup` | array | list | 快照额外备份文件声明（不得指向 .env） |

**核心特征**：包含所有**凭证、权限、身份相关**的敏感字段。

---

## behavior.json (HA 权限字段)

人类和 Agent 均可修改的行为参数：

| 字段 | 类型 | 合并语义 | 说明 |
|------|------|----------|------|
| `$schema_version` | number | scalar | Schema 版本号 |
| `active_baseagent` | string | scalar | 当前活跃 base agent（claude/codex/gemini） |
| `baseagents` | object | dict | 各 base agent 的 model/effort 等配置 |
| `chatmode` | object | dict | 对话模式（private/group/nothuman: interactive/proactive） |
| `flush_delay` | number | scalar | 消息 flush 间隔（秒） |
| `debounce` | number | scalar | 入站消息去抖（秒） |
| `dispatch` | string | scalar | 群聊分发策略（mention/broadcast） |
| `show_activities` | string | scalar | 中间活动可见性（all/none） |
| `proactive` | object | dict | proactive 模式运行策略开关 |
| `render` | object | dict | 各渲染类型当前激活的 modeName |
| `enable_rich_content` | boolean | scalar | 启用富内容渲染（如飞书富文本卡片） |
| `permissionMode` | string | scalar | 执行权限模式（bypass/readonly/auto 等） |
| `roles` | object | dict | 角色级行为覆盖（role → { baseagents, permissionMode }） |

**核心特征**：包含所有**运行时行为、响应策略、模型选择**等可动态调整的参数。

---

## 实际文件问题

### evolai.agentid.pub

**config.json 中的错位字段**（应移至 behavior.json）：
- ❌ `active_baseagent`: "claude"
- ❌ `baseagents`: { claude: { model, effort }, codex, gemini }
- ❌ `chatmode`: { private, group }
- ❌ `show_activities`: "all"

**behavior.json 当前内容**（正确）：
```json
{
  "$schema_version": 1,
  "baseagents": {
    "claude": { "model": "claude-opus-4-7" }
  }
}
```

**冲突**：`baseagents` 字段同时存在于两个文件中！
- config.json: `baseagents.claude.model = "claude-opus-4-8", effort = "xhigh"`
- behavior.json: `baseagents.claude.model = "claude-opus-4-7"`

### eleanbot.agentid.pub

**config.json 中的错位字段**（应移至 behavior.json）：
- ❌ `active_baseagent`: "claude"
- ❌ `baseagents`: { claude: { apiKey, model, effort } }
- ❌ `chatmode`: { private, group, nothuman }
- ❌ `dispatch`: "mention"

**behavior.json 当前内容**（正确）：
```json
{
  "$schema_version": 1,
  "baseagents": {
    "claude": { "model": "claude-opus-4-8" }
  }
}
```

**冲突**：同样 `baseagents` 字段重复！
- config.json: `baseagents.claude.model = "deepseek-v4-pro"`
- behavior.json: `baseagents.claude.model = "claude-opus-4-8"`

---

## 建议修复方案

### 1. evolai.agentid.pub

**config.json（保留）**：
```json
{
  "$schema_version": 1,
  "aid": "evolai.agentid.pub",
  "enabled": true,
  "owners": ["elean.agentid.pub"],
  "admins": ["eleans-2022.agentid.pub"],
  "channels": [ /* 保持原样 */ ],
  "projects": {
    "defaultPath": "/home/evolclaw",
    "autoCreate": true,
    "list": { /* 保持原样 */ }
  },
  "initialized": true
}
```

**behavior.json（迁移字段）**：
```json
{
  "$schema_version": 1,
  "active_baseagent": "claude",
  "baseagents": {
    "claude": {
      "model": "claude-opus-4-8",
      "effort": "xhigh"
    },
    "codex": {},
    "gemini": {}
  },
  "chatmode": {
    "private": "interactive",
    "group": "proactive"
  },
  "show_activities": "all"
}
```

### 2. eleanbot.agentid.pub

**config.json（保留）**：
```json
{
  "$schema_version": 1,
  "aid": "eleanbot.agentid.pub",
  "enabled": true,
  "initialized": true,
  "owners": ["elean.agentid.pub"],
  "channels": [ /* 保持原样 */ ],
  "projects": {
    "defaultPath": "/home/evolclaw"
  },
  "debug": {
    "aunTrace": true
  }
}
```

**behavior.json（迁移字段）**：
```json
{
  "$schema_version": 1,
  "active_baseagent": "claude",
  "baseagents": {
    "claude": {
      "apiKey": "",
      "model": "deepseek-v4-pro",
      "effort": "xhigh"
    }
  },
  "chatmode": {
    "private": "interactive",
    "group": "proactive",
    "nothuman": "proactive"
  },
  "dispatch": "mention"
}
```

---

## 迁移注意事项

1. **字段冲突解决**：当同一字段在两个文件中有不同值时，以 **config.json 中的值为准**（因为它是用户手动配置的实际运行值）

2. **projects 字段特殊性**：
   - evolai 的 `projects` 包含 `autoCreate` 和 `list`（扩展字段）
   - schema 中只定义了 `rootPath` 和 `defaultPath`
   - 建议保留扩展字段在 config.json 中（这些是路径配置，属于 H 权限范畴）

3. **baseagents.apiKey**：
   - eleanbot 的 `baseagents.claude.apiKey` 字段不在 schema 中
   - 但 apiKey 是凭证，理论上应在 H 权限文件
   - **建议**：将 apiKey 移至 `aun` 或单独的凭证存储机制

4. **迁移步骤**：
   1. 停止 evolclaw 进程
   2. 修改文件
   3. 验证 schema（可选：运行加载期校验）
   4. 重启进程

---

## 架构演进方向

当前代码应该已经支持双文件系统（schema-registry.ts 已实现），但旧配置文件还未迁移。

建议：
1. 提供 `evolclaw config migrate` 命令自动执行字段迁移
2. 在启动期检测混合状态并警告用户
3. 逐步弃用 config.json 中的 HA 字段（向后兼容期后）
