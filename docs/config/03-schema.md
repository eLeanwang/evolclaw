# Schema 治理

> EvolClaw 配置体系 v3
> 上一篇：[02-merge-rules.md](./02-merge-rules.md) | 下一篇：[04-config-manager.md](./04-config-manager.md)

---

## 一、Schema 的核心作用

schema 是 **「参数 → (类型, 归属文件)」的唯一事实源**：

1. **参数类型** — string/number/bool/list/dict。类型同时决定该参数在覆盖链里的合并语义。
2. **参数归属哪个文件** — 决定写入落点。

CLI 的"字段自动判定落点"、合并语义全部挂在这两条上。

### 派生用途

- 写入校验（ajv）
- `ensureFile` 骨架生成
- TS 类型生成
- 机器可读文档

---

## 二、Schema 文件位置与命名

### 目录结构

```
kits/schemas/
├── evolclaw.schema.1.json            ← evolclaw.json（v1）
├── defaults.schema.1.json            ← agents/defaults.json（v1）
├── agent-config.schema.1.json        ← agents/{aid}/config.json（v1）
├── relation-config.schema.1.json     ← relations/{peerKey}/config.json
├── behavior.schema.1.json            ← behavior.json（HA 行为字段）
├── migrations/                       ← 版本间迁移函数
│   ├── agent-config.1-to-2.ts
│   └── ...
└── _meta.json                        ← 各 schema 当前版本号索引
```

### 命名规则

**实际文件名 = `逻辑名.schema.{版本}.json`**

| 逻辑名 | 对应配置文件 |
|--------|-------------|
| `evolclaw` | `evolclaw.json` |
| `defaults` | `agents/defaults.json` |
| `agent-config` | `agents/{aid}/config.json` |
| `relation-config` | `relations/{peerKey}/config.json` |
| `behavior` | `agents/{aid}/behavior.json` / `relations/{peerKey}/behavior.json` |

### 为什么放在 kits/schemas/

- Schema 随 npm 包发布（`kits/` 在 package.json `files` 字段中）
- daemon 运行时可直接读取
- 是 SSOT，`types.ts` 的 TS 接口从对应版本 schema 推导
- 历史版本保留 → 旧配置文件升级时能找到自己当前版本的 schema 作为迁移起点

---

## 三、Schema 版本与迁移机制

### 版本化

每个 schema 文件带版本号（体现在文件名）。**配置文件中的 `$schema_version` 指向它当前匹配的 schema 版本**。

### 迁移流程

```
新安装包带来更高的 schema 版本（_meta.json 里某 schema currentVersion 上升）
  ↓
daemon 启动时比对：配置文件 $schema_version < 该 schema 的 currentVersion
  ↓
先快照（trigger=schema-migration）
  ↓
逐版本应用迁移函数：v1→v2→v3...
  ↓
迁移后写回新文件，更新文件内 $schema_version
```

### 迁移函数契约

```typescript
// migrations/{schema}.{N}-to-{N+1}.ts
export function migrate(old: object): object;   // 旧版本完整 JSON → 新版本完整 JSON
```

**要点**：
- 入参/返回都是**完整对象**——整体重写，不做字段级 patch
- 迁移产物直接覆盖原文件（先快照已保证可回滚）
- 多版本串联即函数复合：`v1→v3 = migrate_2to3(migrate_1to2(old))`

**要求**：
- 每次升版必须提供 `migrations/{schema}.{N}-to-{N+1}.ts`
- 历史 schema 全保留
- 逐版本串联不跨版本直跳

---

## 四、_meta.json

```json
{
  "schemas": {
    "evolclaw":       { "currentVersion": 1 },
    "defaults":       { "currentVersion": 1 },
    "agent-config":   { "currentVersion": 1 },
    "relation-config":{ "currentVersion": 1 },
    "behavior":       { "currentVersion": 1 }
  },
  "history": [
    { "schema": "behavior", "version": 1, "date": "2026-06-23", "description": "agent-writable behavior fields (HA)" }
  ]
}
```

---

## 五、Schema 示例

### evolclaw.schema.1.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "evolclaw.schema.1.json",
  "title": "ProcessConfig (evolclaw.json)",
  "description": "进程级配置",
  "type": "object",
  "required": ["aid"],
  "properties": {
    "$schema_version": { "type": "number", "default": 1 },
    "aid": { "type": "string", "description": "进程 AID" },
    "owners": { "type": "array", "items": { "type": "string" } },
    "aun": {
      "type": "object",
      "properties": {
        "encryptionSeed": { "type": "string" }
      }
    },
    "ecweb": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean" },
        "port": { "type": "number" }
      }
    }
  }
}
```

### agent-config.schema.1.json（精简示例）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "agent-config.schema.1.json",
  "title": "AgentConfig (agents/{aid}/config.json)",
  "description": "Agent 级 H 配置 - 身份、授权、渠道和基础设施",
  "type": "object",
  "required": ["aid", "channels"],
  "properties": {
    "$schema_version": { "type": "number", "default": 1 },
    "aid": { "type": "string", "description": "Agent AID" },
    "enabled": { "type": "boolean" },
    "owners": { "type": "array", "items": { "type": "string" } },
    "channels": { "type": "array", "items": { "type": "object" } },
    "baseagents": { "type": "object" },
    "projects": { "type": "object" },
    "debug": { "type": "object" }
  }
}
```

### behavior.schema.1.json（精简示例）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "behavior.schema.1.json",
  "title": "BehaviorConfig (behavior.json)",
  "description": "Agent-writable runtime behavior fields (HA)",
  "type": "object",
  "properties": {
    "$schema_version": { "type": "number", "default": 1 },
    "active_baseagent": { "type": "string" },
    "baseagents": { "type": "object" },
    "chatmode": {
      "type": "object",
      "properties": {
        "private": { "type": "string", "enum": ["interactive", "proactive"] },
        "group": { "type": "string", "enum": ["interactive", "proactive"] },
        "nothuman": { "type": "string", "enum": ["interactive", "proactive"] }
      }
    },
    "dispatch": { "type": "string", "enum": ["mention", "broadcast"] },
    "permissionMode": {
      "type": "string",
      "enum": ["auto", "bypass", "readonly", "request", "edit", "plan", "noask"]
    }
  }
}
```

---

## 六、Schema 元数据（x- 扩展）

当前保留 H/HA 文件物理分离。schema 根字段 `x-permission` 标注该 schema 的 owner：

- `H`：人类/进程管理配置。
- `HA`：agent 可写行为配置。

字段级扩展可继续用于文档和未来权限细化：

```json
{
  "properties": {
    "aid": {
      "type": "string",
      "description": "Agent AID",
      "x-permission": "human-only",
      "x-category": "identity"
    },
    "chatmode": {
      "type": "object",
      "description": "对话模式",
      "x-permission": "configurable",
      "x-category": "behavior"
    }
  }
}
```

**元数据用途**（未来）：
- `x-permission: "human-only"` - 标记人类专属参数
- `x-permission: "configurable"` - 标记 agent 可修改参数
- `x-category` - 参数分类（用于文档生成）

**当前**：CLI 已按 schema owner 拒绝 agent 托管环境写 H 字段；HA 字段允许通过受控入口修改。

---

## 七、Schema 验证

### 验证时机

1. **写入时**：ConfigManager.write() 调用 ajv 验证
2. **启动时**：加载所有配置文件并验证
3. **手动**：`ec config validate`

### 验证规则

- 必填字段检查
- 类型检查
- 枚举值检查
- 自定义规则（如 `.env` 引用格式）

### 验证失败处理

- 写入时验证失败 → 拒绝写入，返回错误
- 启动时验证失败 → 进入自检模式（如果启用）
- 手动验证 → 输出错误详情

---

## 八、TS 类型生成

### 从 Schema 生成 TypeScript 类型

使用 `json-schema-to-typescript` 或类似工具：

```bash
# 生成类型
json2ts kits/schemas/agent-config.schema.1.json > src/types/agent-config.ts
```

### 类型定义位置

```
src/types.ts
├── ProcessConfig        ← 从 evolclaw.schema.1.json 生成
├── DefaultsConfig       ← 从 defaults.schema.1.json 生成
├── AgentConfig          ← 从 agent-config.schema.1.json 生成
├── RelationConfig       ← 从 relation-config.schema.1.json 生成
└── EffectiveAgentConfig ← 手动定义（合并结果）
```

### 保持同步

- Schema 是 SSOT
- TS 类型从 Schema 生成
- 构建时检查：types.ts 与 schema 一致性

---

## 九、Schema 设计原则

### 1. 最小化嵌套

合并不递归，深层嵌套会导致覆盖语义不直观。

**❌ 不好**：
```json
{
  "baseagents": {
    "claude": {
      "config": {
        "model": "opus"
      }
    }
  }
}
```

**✅ 好**：
```json
{
  "baseagents": {
    "claude": {
      "model": "opus"
    }
  }
}
```

### 2. 用类型表达语义

- 想要追加 → 用 array
- 想要覆盖 → 用 scalar
- 想要命名条目 → 用 object

### 3. 提供合理默认值

通过 `default` 字段提供兜底值：

```json
{
  "properties": {
    "flush_delay": {
      "type": "number",
      "default": 3,
      "description": "消息 flush 间隔（秒）"
    }
  }
}
```

### 4. 完善文档

每个字都应有 `description`：

```json
{
  "properties": {
    "chatmode": {
      "type": "object",
      "description": "对话模式：interactive=直接输出即回复；proactive=须显式发送",
      "properties": {
        "private": {
          "type": "string",
          "enum": ["interactive", "proactive"],
          "description": "私聊对话模式"
        }
      }
    }
  }
}
```

---

## 十、Schema 演进策略

### 增加字段（非破坏性）

只需在 schema 中增加字段，不需要版本升级：

```json
{
  "properties": {
    "new_field": {
      "type": "string",
      "description": "新增字段"
    }
  }
}
```

### 修改字段类型（破坏性）

需要升级版本 + 提供迁移函数：

1. 创建 `agent-config.schema.2.json`
2. 创建 `migrations/agent-config.1-to-2.ts`
3. 更新 `_meta.json` 的 currentVersion

### 删除字段

标记为 deprecated，保留若干版本后再移除：

```json
{
  "properties": {
    "old_field": {
      "type": "string",
      "deprecated": true,
      "description": "已废弃，将在 v3 中移除"
    }
  }
}
```

---

## 相关文档

- [01-overview.md](./01-overview.md) - 总体架构
- [02-merge-rules.md](./02-merge-rules.md) - 覆盖链与合并规则
- [04-config-manager.md](./04-config-manager.md) - ConfigManager API
- [config-params-classified.md](./config-params-classified.md) - 完整参数清单
