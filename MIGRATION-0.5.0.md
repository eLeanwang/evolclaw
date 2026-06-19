# Evolclaw 0.5.0 迁移指南

> 版本：0.5.0
> 发布日期：2026-06-19
> 重大变更：配置系统 v3 重构 + 类型系统简化

---

## 概述

0.5.0 版本对配置系统进行了重大重构，主要变更：

1. **删除 behavior.json** - 所有参数统一在 config.json
2. **删除 BehaviorConfig 类型** - 统一使用 AgentConfig/EffectiveAgentConfig
3. **删除 MergedAgentConfig 类型** - 统一使用 EffectiveAgentConfig
4. **简化覆盖链** - defaults → agent/config → relation/config

---

## 破坏性变更

### 1. behavior.json 已删除

**变更说明**：
- ❌ 不再有 `agents/<aid>/behavior.json`
- ❌ 不再有 `agents/<aid>/relations/<peerKey>/preferences.json`
- ✅ 所有参数统一在 `config.json`

**迁移步骤**：

#### 如果你有自定义的 behavior.json：

**原文件结构**：
```
agents/mybot.agent/
├── config.json       # 身份、凭证、渠道
└── behavior.json     # 模型、对话模式、权限
```

**新文件结构**：
```
agents/mybot.agent/
└── config.json       # 所有参数统一
```

**手动合并示例**：

```json
// 原 config.json（身份信息）
{
  "aid": "mybot.agent",
  "owners": ["admin.user"],
  "channels": [...]
}

// 原 behavior.json（行为参数）
{
  "active_baseagent": "claude",
  "baseagents": {
    "claude": { "model": "opus-4.8", "effort": "high" }
  },
  "chatmode": { "private": "proactive" }
}

// 合并后的 config.json
{
  "aid": "mybot.agent",
  "owners": ["admin.user"],
  "channels": [...],
  "active_baseagent": "claude",
  "baseagents": {
    "claude": { "model": "opus-4.8", "effort": "high" }
  },
  "chatmode": { "private": "proactive" }
}
```

**自动迁移**：
- 启动时会自动检测并合并 behavior.json 到 config.json
- 迁移后 behavior.json 会被重命名为 `.migrated-to-config`

#### 如果你有关系级 preferences.json：

**原路径**：`agents/<aid>/relations/<peerKey>/preferences.json`

**新路径**：`agents/<aid>/relations/<peerKey>/config.json`

**迁移**：
- 自动迁移，将 preferences.json 合并到 config.json
- 原文件重命名为 `.migrated-to-config`

---

### 2. BehaviorConfig 类型已删除

**变更说明**：
- ❌ `BehaviorConfig` 接口已删除
- ✅ 使用 `AgentConfig`（存储层）或 `EffectiveAgentConfig`（运行时）

**如果你的代码引用了 BehaviorConfig**：

```typescript
// ❌ 旧代码
import type { BehaviorConfig } from 'evolclaw/types';

function updateBehavior(config: BehaviorConfig) {
  // ...
}

// ✅ 新代码（完整配置）
import type { AgentConfig } from 'evolclaw/types';

function updateBehavior(config: AgentConfig) {
  // ...
}

// ✅ 新代码（只需要部分字段）
import type { AgentConfig } from 'evolclaw/types';

function updateBehavior(config: Partial<AgentConfig>) {
  // ...
}

// ✅ 新代码（运行时合并结果）
import type { EffectiveAgentConfig } from 'evolclaw/types';

function getBehavior(): EffectiveAgentConfig {
  // ...
}
```

**常见场景替换表**：

| 原用途 | 旧类型 | 新类型 |
|--------|--------|--------|
| 读取 agent 配置 | `BehaviorConfig` | `AgentConfig` |
| 读取关系级配置 | `BehaviorConfig` | `RelationConfig` |
| 运行时合并结果 | `BehaviorConfig` | `EffectiveAgentConfig` |
| 部分配置更新 | `Partial<BehaviorConfig>` | `Partial<AgentConfig>` |
| 只需要特定字段 | `Pick<BehaviorConfig, 'model' \| 'chatmode'>` | `Pick<AgentConfig, 'model' \| 'chatmode'>` |

---

### 3. MergedAgentConfig 类型已删除

**变更说明**：
- ❌ `MergedAgentConfig` 类型已删除
- ✅ 使用 `EffectiveAgentConfig`

**如果你的代码引用了 MergedAgentConfig**：

```typescript
// ❌ 旧代码
import type { MergedAgentConfig } from 'evolclaw/types';

function processConfig(config: MergedAgentConfig) {
  // ...
}

// ✅ 新代码
import type { EffectiveAgentConfig } from 'evolclaw/types';

function processConfig(config: EffectiveAgentConfig) {
  // ...
}
```

**说明**：
- `MergedAgentConfig` 曾是 `AgentConfig & BehaviorConfig` 的合并类型
- v3 重构后简化为 `EffectiveAgentConfig` 的别名
- 现在直接使用 `EffectiveAgentConfig` 更清晰

---

### 4. mergeForAgent() 已弃用

**变更说明**：
- ⚠️ `mergeForAgent()` 标记为 `@deprecated`
- ✅ 使用 `ConfigManager.resolveEffective()`

**如果你的代码调用了 mergeForAgent**：

```typescript
// ❌ 旧代码
import { mergeForAgent, loadAgent, loadDefaults } from 'evolclaw';

const agent = loadAgent('mybot.agent');
const defaults = loadDefaults();
const merged = mergeForAgent(agent, defaults);

// ✅ 新代码
import { resolveEffective } from 'evolclaw/config/config-manager';

const effective = resolveEffective({ self: 'mybot.agent' });
```

**说明**：
- `mergeForAgent()` 仍可用但已弃用，计划 v2.2 删除
- `resolveEffective()` 是唯一的合并入口，支持完整覆盖链

---

## 新功能

### 1. 统一的配置覆盖链

**覆盖链（优先级从低到高）**：
```
defaults → agent/config → relation/config
```

**示例**：

```typescript
import { resolveEffective } from 'evolclaw/config/config-manager';

// Agent 级配置
const agentConfig = resolveEffective({ 
  self: 'mybot.agent' 
});

// 关系级配置（针对特定用户）
const relationConfig = resolveEffective({ 
  self: 'mybot.agent',
  peerKey: 'user123.user@channel'
});
```

### 2. 角色级覆盖（新增）

**在 config.json 中定义角色**：

```json
{
  "aid": "mybot.agent",
  "active_baseagent": "claude",
  "baseagents": {
    "claude": { "model": "sonnet-4.6" }
  },
  "roles": {
    "power-user": {
      "baseagents": {
        "claude": { "model": "opus-4.8", "effort": "high" }
      },
      "permissionMode": "owner"
    }
  }
}
```

**运行时解析**：

```typescript
import { resolveEffective } from 'evolclaw/config/config-manager';

// 普通用户
const normalConfig = resolveEffective({ 
  self: 'mybot.agent',
  peerKey: 'user1.user@channel'
});
// → model: "sonnet-4.6"

// Power user
const powerConfig = resolveEffective({ 
  self: 'mybot.agent',
  peerKey: 'user2.user@channel',
  role: 'power-user'
});
// → model: "opus-4.8", effort: "high"
```

---

## 非破坏性变更

### 1. 配置文件格式兼容

**旧格式仍然支持**：
- 如果只有 config.json（身份字段），仍然有效
- 如果有 behavior.json，会自动合并
- 如果有 preferences.json，会自动迁移

### 2. API 保持兼容

**这些函数签名未变**：
- `loadAgent(aid)` - 返回 AgentConfig
- `loadDefaults()` - 返回 DefaultsConfig
- `loadAllAgents()` - 返回 AgentConfig[]

**这些属性未变**：
- `EvolAgent.config` - 返回运行时配置（类型从 MergedAgentConfig 改为 EffectiveAgentConfig，字段不变）
- `AgentInfo.config` - 同上

---

## 检查清单

迁移到 0.5.0 时，检查以下内容：

### 配置文件

- [ ] 确认 behavior.json 已自动合并到 config.json
- [ ] 确认 preferences.json 已自动迁移到 config.json
- [ ] 检查 config.json 是否包含所有必要字段

### TypeScript 代码

- [ ] 将 `BehaviorConfig` 替换为 `AgentConfig` 或 `EffectiveAgentConfig`
- [ ] 将 `MergedAgentConfig` 替换为 `EffectiveAgentConfig`
- [ ] 将 `mergeForAgent()` 替换为 `resolveEffective()`
- [ ] 运行 TypeScript 编译检查类型错误

### 运行时测试

- [ ] 启动 agent，确认配置正确加载
- [ ] 测试模型切换功能
- [ ] 测试对话模式切换
- [ ] 测试关系级配置覆盖

---

## 常见问题

### Q1: 我的 behavior.json 会丢失吗？

**A**: 不会。
- 自动迁移会合并到 config.json
- 原 behavior.json 重命名为 `.migrated-to-config`
- 如果合并失败，会保留原文件并记录错误日志

### Q2: 我需要手动更新配置文件吗？

**A**: 不需要。
- 启动时自动检测并迁移
- 迁移成功后自动保存
- 只需确认迁移日志无错误

### Q3: 类型错误如何修复？

**A**: 按上述替换表修改：
```typescript
// BehaviorConfig → AgentConfig / EffectiveAgentConfig
// MergedAgentConfig → EffectiveAgentConfig
```

### Q4: mergeForAgent() 什么时候会删除？

**A**: 计划 v2.2 删除。
- 当前版本仍可用（已弃用）
- 建议尽快迁移到 `resolveEffective()`

### Q5: 如何回退到旧版本？

**A**: 
```bash
npm install evolclaw@0.4.x
```
- 如果已迁移，需要手动还原配置文件
- 建议迁移前备份 agents/ 目录

---

## 获取帮助

如果遇到迁移问题：

1. **查看日志**：`~/.evolclaw/logs/boot.log`
2. **查看文档**：`docs/config/`
3. **提交 Issue**：https://github.com/your-org/evolclaw/issues

---

## 相关文档

- [配置系统概览](docs/config/01-overview.md)
- [合并规则](docs/config/02-merge-rules.md)
- [配置 Schema](docs/config/03-schema.md)
- [BehaviorConfig 删除报告](docs/config/behaviorconfig-mergedconfig-removal-completion.md)
