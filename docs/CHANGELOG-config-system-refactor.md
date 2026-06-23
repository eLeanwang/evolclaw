# 配置系统重构变更总结

**实施时间**：2026-06-13/14  
**测试状态**：✅ 1748 tests passed

---

## 核心变化

### 1. 四层配置解析体系

```
全局     agents/defaults.json                          
agent    agents/<aid>/config.json                      
 └ 角色  └ config.json 内的 "roles" 块        ← 新增
关系     agents/<aid>/relations/<peerKey>/config.json  ← 新启用
```

**解析优先级**：关系 > 角色 > agent > 全局（越具体越优先）

### 2. 字段变化

| 字段 | 旧行为 | 新行为 |
|------|--------|--------|
| **model/effort** | 单一作用域 | 四层独立回退 |
| **permissionMode** | session.metadata | 实时解析（不缓存） |
| **show_activities** | 四值（all/dm-only/owner-dm-only/none） | 二值（all/none） |
| **chatmode** | 对象 `{private, group}` | 标量 `'interactive' \| 'proactive'` |

### 3. 角色级配置（新增）

**agent config.json 新增 `roles` 块：**
```json
{
  "aid": "bot.agentid.pub",
  "baseagents": { "claude": { "model": "sonnet" } },
  "roles": {
    "owner": { 
      "baseagents": { "claude": { "model": "opus" } },
      "permissionMode": "bypass"
    },
    "guest": {
      "baseagents": { "claude": { "model": "haiku" } },
      "permissionMode": "readonly"
    }
  }
}
```

**效果**：owner 自动用 opus，guest 自动用 haiku + 只读权限。

### 4. 关系级配置（启用）

**`relations/<peerKey>/config.json`：**
```json
{
  "baseagents": { "claude": { "model": "opus", "effort": "xhigh" } },
  "permissionMode": "bypass"
}
```

**效果**：针对单个对端（如 VIP 用户）覆盖模型和权限，不影响其他人。

### 5. 命令变化

| 命令 | 变化 |
|------|------|
| `/perm` | 写入关系级 config.json（不再写 session.metadata） |
| `/activity` | 选项精简为 `all \| none` |
| `/safe` | 删除（死代码） |

---

## 升级指南

### 自动兼容（无需手动操作）

1. **旧关系级 preferences.json**：自动识别旧扁平 model/effort，首次写入时迁移
2. **session.metadata.permissionMode**：旧值被忽略，解析器优先级更高

### 需手动调整

1. **show_activities**: `dm-only` / `owner-dm-only` → 改为 `all` 或 `none`
2. **chatmode.group**: 配置被忽略（群聊强制 proactive）

---

## 使用示例

### 场景 1：给不同角色分配不同模型

**配置**（`agents/<aid>/config.json`）：
```json
{
  "roles": {
    "owner": { "baseagents": { "claude": { "model": "opus" } } },
    "guest": { "baseagents": { "claude": { "model": "haiku" } } }
  }
}
```

**效果**：owner 对话自动用 opus，guest 对话自动用 haiku。

### 场景 2：给 VIP 用户单独升级模型

**命令**（关系级）：
```bash
evolclaw model use opus --self bot.agentid.pub --peer alice.agentid.pub
```

**或手动编辑**（`relations/aun#alice.agentid.pub/config.json`）：
```json
{
  "baseagents": { "claude": { "model": "opus" } }
}
```

**效果**：alice 用 opus，其他 guest 仍用默认的 haiku。

### 场景 3：关系级只改推理强度

```bash
evolclaw model effort xhigh --self bot.agentid.pub --peer alice.agentid.pub
```

**效果**：alice 的推理强度变 xhigh，model 继续从角色/agent/全局解析（独立回退）。

---

## 主要文件变动

| 文件 | 变化 |
|------|------|
| `src/core/model/model-scope.ts` | → `config-scope.ts`（改名+扩展） |
| `src/types.ts` | 新增 `RoleOverride`；字段简化 |
| `src/config-store.ts` | `mergeForAgent` 深合并 roles |
| `src/core/message/message-processor.ts` | permissionMode 改实时解析；model/effort 补传 role |
| `src/core/channel-loader.ts` | showActivitiesPolicy 简化 |
| `src/core/command/slash-handler.ts` | `/perm` 改向关系级；删 `/safe` |
| `src/cli/model.ts` | 新增 `--role` 支持 |

---

## 测试覆盖

- **新增**：`tests/unit/config-scope.test.ts`（54 条专项测试）
- **更新**：3 个既有测试适配新机制
- **总计**：1748 tests passed

---

## 详细文档

- **实施报告**：`docs/role-relation-config-implementation.md`（本次改动详情）
- **设计文档**：`docs/role-relation-config-plan.md`（原始设计）
- **核心代码**：`src/core/model/config-scope.ts`（475 行）
