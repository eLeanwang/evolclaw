# 配置文档更新计划

> 生成时间：2026-06-19
> 原因：决定去掉 behavior.json 这一套，所有参数统一在 config.json，权限控制在 API 层

---

## 核心决策

### 决策：去掉 behavior.json，统一用 config.json

**原设计**：
- config.json(H) - 人类修改，hook 禁止 agent 写
- behavior.json(HA) - agent 可修改，hook 允许 agent 写

**问题**：
- 实际所有配置修改都通过 evolclaw 代码/CLI 完成
- Hook 可以直接禁止 agent 直接读写**所有**配置文件
- 文件级权限控制过于粗粒度

**新设计**：
- 所有参数统一在 config.json
- Hook 禁止所有配置文件的直接读写
- 权限控制在 API 层（代码层判断哪些参数 agent 不能修改）

---

## 配置层级（简化后）

```
process (evolclaw.json)
  ↓
defaults (defaults.json)
  ↓
agent (agent/config.json) - 包含所有参数
  ↓
relation (relation/config.json) - 关系级个性化配置
```

**没有 behavior.json！**

---

## 已完成的清理工作

### ✅ 删除的文件
- `kits/schemas/behavior.schema.1.json` - 已删除

### ✅ 删除的过程性文档（11个）
1. config-params-audit.md
2. config-params-complete-list.md
3. config-params-complete-list-v2.md
4. config-params-complete-list-v3.md
5. config-params-master-list.md
6. config-params-permission-analysis.md
7. config-params-permission-final.md
8. config-params-permission-relaxed.md
9. config-system-design.md (v1，已被 v2 替代)
10. config-v2-inconsistencies-analysis.md
11. schema-update-summary.md

---

## 保留的核心文档（4个）

### 1. config-params-classified.md ✅ 无需更新
**状态**：已经是基于实际配置梳理的最新版本  
**内容**：按功能分类的完整参数清单（81+ 个参数）  
**behavior 引用**：0 处

### 2. config-roles-layer-design.md ⚠️ 需要轻微更新
**状态**：有 1 处 behavior 引用  
**位置**：第 58 行  
**更新内容**：
- 删除 "不碰 `HA字段 ⟺ behavior.json` 硬约束" 这句话
- 说明：角色系统暂不实现，先走最简单的 H 链

### 3. config-system-design-v2.md ⚠️ 需要重大更新
**状态**：有 75 处 behavior 引用（大量）  
**更新内容**：
- 删除整个 "HA 链" 的设计章节
- 删除 behavior.json 相关的所有描述
- 更新为：所有参数在 config.json，权限控制在 API 层
- 保留：H 链的覆盖设计（process → defaults → agent → relation）

### 4. config-system-v2-implementation-status.md ⚠️ 需要更新
**状态**：有 11 处 behavior 引用  
**更新内容**：
- 删除 behavior.json 相关的任务项
- 更新实现状态
- 补充：Schema 已生成完成

---

## 需要更新的具体内容

### config-roles-layer-design.md

**第 58 行需要改为**：
```markdown
建议先只走 H 链（纯权限/访问控制：可用命令、配额、特性开关）。
角色系统的具体设计待权限体系明确后再完善。
```

---

### config-system-design-v2.md

**需要删除的章节**：
1. "HA 链（人+agent 可写）" 相关章节
2. "behavior.json" 的所有设计描述
3. "H/HA 物理分离" 相关设计

**需要更新的章节**：
1. **配置层级** - 删除 behavior.json，只保留 config.json
2. **权限控制** - 从"文件级权限"改为"API 层权限控制"
3. **Schema 设计** - 删除 behavior.schema.1.json

**新增章节**：
- 权限控制在 API 层的设计（待权限体系设计完成后补充）

---

### config-system-v2-implementation-status.md

**需要删除的任务**：
- [ ] H/HA 物理分离的数据迁移
- [ ] behavior.schema.1.json 的生成
- [ ] behavior.json 相关的所有任务

**需要更新的状态**：
- [x] Schema 文件已生成（relation-config, agent-config, defaults 已更新）
- [x] 去掉 behavior 这一套（决策已确认）

**需要新增的任务**：
- [ ] 权限体系设计（确定哪些参数 agent 不能修改）
- [ ] API 层权限检查实现

---

## 其他需要调整的地方

### Schema 文件
- ✅ 已删除 `behavior.schema.1.json`
- ✅ `agent-config.schema.1.json` 已包含所有参数（active_baseagent, baseagents 等）
- ✅ `defaults.schema.1.json` 已包含所有参数
- ✅ `relation-config.schema.1.json` 已更新（支持 29 个关系级参数）

### 代码引用
需要搜索代码中对 behavior.json 的引用并清理（如果有的话）

---

## 下一步工作

1. ⏭️ **更新 config-roles-layer-design.md**（轻微更新）
2. ⏭️ **重写 config-system-design-v2.md 的相关章节**（重大更新）
3. ⏭️ **更新 config-system-v2-implementation-status.md**（更新状态）
4. ⏭️ **编写关系级配置迁移脚本**（preferences.json → config.json）
5. ⏭️ **改造 config-store.ts**（委托给 ConfigManager）

---

## 需要你确认

在我开始更新文档之前，请确认：

1. **config-system-design-v2.md 是否需要完全重写？** 还是只删除 behavior 相关章节？
2. **权限控制的设计章节是否现在写？** 还是等权限体系设计完成后再补充？
3. **是否需要保留"未来可能重新引入 behavior.json"的说明？** 还是完全去掉？

请告诉我你的决定，我会据此更新文档。
