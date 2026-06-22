# 配置体系 v3 实现状态跟踪文档

> **文档定位**：配置体系 v3 的实现状态跟踪，记录当前进展、待完成项和决策点。
>
> **最后更新**：2026-06-19
>
> **版本变更**：v3 - 去除 behavior.json，所有参数统一在 config.json

---

## 核心设计变更（v2 → v3）

### 已废弃的设计（v2）

❌ **H/HA 物理分离**：
- config.json(H) - 人类修改
- behavior.json(HA) - agent 可修改

❌ **文件级权限控制**：通过 hook 区分 H/HA 文件的读写权限

### 新设计（v3）

✅ **统一配置文件**：
- 所有参数都在 config.json
- 不再有 behavior.json

✅ **API 层权限控制**：
- Hook 禁止所有配置文件的直接访问
- Agent 通过 CLI 修改配置
- 权限检查在 API 层（待实现）

---

## 一、已完成的工作

### 1. Schema 文件生成 ✅

| Schema 文件 | 状态 | 说明 |
|------------|------|------|
| `evolclaw.schema.1.json` | ✅ 已生成 | process 级配置 |
| `defaults.schema.1.json` | ✅ 已更新 | 新增 active_baseagent, baseagents |
| `agent-config.schema.1.json` | ✅ 已更新 | 新增 active_baseagent, baseagents, projects.autoCreate/list |
| `relation-config.schema.1.json` | ✅ 已重写 | 支持 29 个关系级参数 |
| `behavior.schema.1.json` | ✅ 已删除 | 不再需要 |

**完成时间**：2026-06-19

### 2. 文档重写 ✅

| 文档 | 状态 | 说明 |
|------|------|------|
| `01-overview.md` | ✅ 新增 | 总体架构 (452行) |
| `02-merge-rules.md` | ✅ 新增 | 覆盖链与合并规则 (268行) |
| `03-schema.md` | ✅ 新增 | Schema 治理 (396行) |
| `04-config-manager.md` | ✅ 新增 | ConfigManager API (463行) |
| `05-snapshot.md` | ✅ 新增 | 快照与回滚机制 (699行) |
| `06-cli-commands.md` | ✅ 新增 | CLI 命令体系 (297行) |
| `07-security.md` | ✅ 新增 | 安全与权限控制 (313行) |
| `08-quick-reference.md` | ✅ 新增 | 快速参考 (361行) |
| `config-params-classified.md` | ✅ 已有 | 完整参数清单 (267行) |
| `code-refactoring-plan.md` | ✅ 新增 | 代码改造清单 (353行) |
| `config-roles-layer-design.md` | ✅ 已更新 | 删除 behavior 引用 |
| `config-system-design-v2.md` | ✅ 已删除 | 已拆分成 8 个文档 |

**完成时间**：2026-06-19

### 3. 参数梳理 ✅

- ✅ 梳理出 81+ 个配置参数
- ✅ 按功能分类（14 个分类）
- ✅ 标注当前实际位置
- ✅ 标注建议存放层级
- ✅ 标注是否支持关系级（29 个参数）

**文档**：`config-params-classified.md`

---

## 二、待完成的工作

### 阶段 1：类型定义修改（基础）

| 任务 | 文件 | 状态 | 优先级 |
|------|------|------|--------|
| 修改 `EffectiveAgentConfig` | `src/types.ts` | ⏭️ 待开始 | 🔴 高 |
| 删除 `behavior` 字段 | `src/types.ts` | ⏭️ 待开始 | 🔴 高 |
| 将 `BehaviorConfig` 字段合并到顶层 | `src/types.ts` | ⏭️ 待开始 | 🔴 高 |
| 保留 `BehaviorConfig` 接口 | `src/types.ts` | ⏭️ 待开始 | 🟡 中 |
| 删除 `behavior` schema 注册 | `src/config/schema-registry.ts` | ⏭️ 待开始 | 🔴 高 |

**预计耗时**：2-3 小时  
**影响范围**：136 处 behavior 引用，分布在 19 个文件

### 阶段 2：ConfigManager 改造（核心）

| 任务 | 文件 | 状态 | 优先级 |
|------|------|------|--------|
| 删除 `ConfigTarget.AgentBehavior/RelationBehavior` | `src/config/config-manager.ts` | ⏭️ 待开始 | 🔴 高 |
| 删除 `resolveBehavior()` 函数 | `src/config/config-manager.ts` | ⏭️ 待开始 | 🔴 高 |
| 简化 `resolveEffectiveAgentConfig()` | `src/config/config-manager.ts` | ⏭️ 待开始 | 🔴 高 |
| 修改 `targetPath()` 删除 behavior 路径 | `src/config/config-manager.ts` | ⏭️ 待开始 | 🔴 高 |
| 删除 behavior.json 路径定义 | `src/paths.ts` | ⏭️ 待开始 | 🟡 中 |
| 删除 behavior.json 备份逻辑 | `src/config/snapshot.ts` | ⏭️ 待开始 | 🟡 中 |

**预计耗时**：4-6 小时  
**阻塞因素**：依赖阶段 1 完成

### 阶段 3：调用方修改（批量）

| 任务 | 涉及文件 | 引用数 | 状态 | 优先级 |
|------|---------|--------|------|--------|
| 批量替换 `config.behavior.xxx` → `config.xxx` | 15+ 文件 | ~100 处 | ⏭️ 待开始 | 🔴 高 |
| 修改 EvolAgent | `src/core/evolagent.ts` | 多处 | ⏭️ 待开始 | 🔴 高 |
| 修改 MessageProcessor | `src/core/message/message-processor.ts` | 多处 | ⏭️ 待开始 | 🔴 高 |
| 修改 BaseAgent runners | `src/agents/*.ts` | 多处 | ⏭️ 待开始 | 🔴 高 |
| 修改 AUN channel | `src/channels/aun.ts` | 多处 | ⏭️ 待开始 | 🟡 中 |
| 修改 CLI 命令 | `src/cli/*.ts` | 多处 | ⏭️ 待开始 | 🔴 高 |

**预计耗时**：6-8 小时  
**阻塞因素**：依赖阶段 1、2 完成

### 阶段 4：测试与验证

| 任务 | 状态 | 优先级 |
|------|------|--------|
| 编译检查 (`npm run build`) | ⏭️ 待开始 | 🔴 高 |
| 启动 agent 测试 | ⏭️ 待开始 | 🔴 高 |
| 配置读取测试 | ⏭️ 待开始 | 🔴 高 |
| 配置修改测试（CLI） | ⏭️ 待开始 | 🔴 高 |
| 关系级配置覆盖测试 | ⏭️ 待开始 | 🟡 中 |
| 模型切换测试 | ⏭️ 待开始 | 🟡 中 |
| 权限模式测试 | ⏭️ 待开始 | 🟡 中 |
| 渲染模式测试 | ⏭️ 待开始 | 🟡 中 |
| 快照回滚测试 | ⏭️ 待开始 | 🟡 中 |

**预计耗时**：4-6 小时  
**阻塞因素**：依赖阶段 1、2、3 完成

---

## 三、数据迁移任务

### 1. 关系级配置迁移 ⏭️

**任务**：将 `relations/*/preferences.json` 迁移到 `relations/*/config.json`

**当前状态**：
```json
// relations/aun#alice/preferences.json
{
  "model": "deepseek-v4-pro",
  "updatedAt": 1780394372229
}
```

**目标状态**：
```json
// relations/aun#alice/config.json
{
  "$schema_version": 1,
  "baseagents": {
    "claude": {
      "model": "deepseek-v4-pro"
    }
  }
}
```

**迁移脚本**：待编写（`scripts/migrate-preferences-to-config.ts`）

**预计耗时**：2-3 小时

### 2. 实际配置文件清理 ⏭️

**任务**：删除所有 behavior.json 文件（如果存在）

**检查命令**：
```bash
find ~/.evolclaw -name "behavior.json" -type f
```

**预计耗时**：30 分钟

---

## 四、遗留问题

### 问题 1：旧 config-store 函数未清理

**问题描述**：
- `mergeForAgent` 仍被调用（17+ 处）
- `validateAgentConfig` 仍被调用（8+ 处）
- `ensureAgentDirSkeleton` 仍被调用（10+ 处）

**解决方案**：
- 在阶段 3 中统一迁移到 ConfigManager
- 逐步替换调用方
- 最后删除旧函数

**状态**：⏭️ 待处理（纳入阶段 3）

### 问题 2：权限体系未设计

**问题描述**：
- 当前 agent 可以修改任意配置参数
- 哪些参数应该是"人类专属"未明确
- 权限检查逻辑未实现

**解决方案**：
- 设计权限体系（哪些参数 agent 不能修改）
- 在 schema 中标注 x-permission
- 在 ConfigManager.write() 中实施权限检查

**状态**：🔵 待设计

### 问题 3：show_activities 枚举值不一致

**问题描述**：
- 设计文档：4 个值（all / dm-only / owner-dm-only / none）
- 实际实现：2 个值（all / none）

**解决方案**：
- 方案 A：补全为 4 值（需实现对应逻辑）
- 方案 B：设计文档改为 2 值

**决策**：待确认业务需求

**状态**：🔵 待决策

---

## 五、风险评估

### 高风险项

1. **EffectiveAgentConfig 结构变更**
   - 影响：所有下游代码
   - 缓解：分支开发 + 充分测试

2. **ConfigManager 核心逻辑**
   - 影响：配置合并算法
   - 缓解：单元测试 + 集成测试

3. **CLI 命令兼容性**
   - 影响：用户直接使用
   - 缓解：保持命令接口不变，内部改走 ConfigManager

### 中风险项

4. **BaseAgent runner**
   - 影响：模型配置读取
   - 缓解：充分测试各 base agent

5. **MessageProcessor**
   - 影响：消息处理流程
   - 缓解：回归测试

6. **权限系统**
   - 影响：permissionMode 读取
   - 缓解：保持行为不变

### 低风险项

7. **Snapshot**：备份功能，影响范围小
8. **Paths**：路径定义，影响范围小

---

## 六、时间规划

### 总体预计

| 阶段 | 预计耗时 | 开始时间 | 完成时间 |
|------|---------|---------|---------|
| 阶段 1：类型定义 | 2-3 小时 | TBD | TBD |
| 阶段 2：ConfigManager | 4-6 小时 | TBD | TBD |
| 阶段 3：调用方修改 | 6-8 小时 | TBD | TBD |
| 阶段 4：测试验证 | 4-6 小时 | TBD | TBD |
| 数据迁移 | 2-3 小时 | TBD | TBD |
| **总计** | **18-26 小时** | TBD | TBD |

### 建议节奏

- **周期 1**：阶段 1 + 阶段 2（1-2 天）
- **周期 2**：阶段 3（2-3 天）
- **周期 3**：阶段 4 + 数据迁移（1-2 天）

---

## 七、检查清单

### 代码改造

- [ ] 修改 `EffectiveAgentConfig` 类型定义
- [ ] 删除 `behavior` schema 注册
- [ ] 删除 `resolveBehavior()` 函数
- [ ] 简化 `resolveEffectiveAgentConfig()`
- [ ] 删除 behavior.json 路径处理
- [ ] 批量替换 `config.behavior.xxx` 访问
- [ ] 修改所有 CLI 命令
- [ ] 清理旧 config-store 函数

### 测试

- [ ] 编译通过
- [ ] Agent 启动成功
- [ ] 配置读取正常
- [ ] 配置修改正常
- [ ] 关系级覆盖生效
- [ ] 模型切换正常
- [ ] CLI 命令正常
- [ ] 快照回滚正常

### 数据迁移

- [ ] 编写 preferences → config 迁移脚本
- [ ] 测试迁移脚本
- [ ] 执行迁移
- [ ] 验证迁移结果
- [ ] 删除旧 behavior.json 文件

### 文档

- [x] 拆分 config-system-design-v2.md
- [x] 生成 8 个新文档
- [x] 更新 config-roles-layer-design.md
- [x] 更新 config-system-v2-implementation-status.md
- [ ] 更新代码注释

---

## 八、相关文档

| 文档 | 说明 |
|------|------|
| [01-overview.md](./01-overview.md) | 总体架构 |
| [code-refactoring-plan.md](./code-refactoring-plan.md) | 详细代码改造清单 |
| [config-params-classified.md](./config-params-classified.md) | 完整参数清单 |

---

**更新日志**

- 2026-06-19：v3 版本，去除 behavior.json，重新规划实现路径
- 2026-06-14：v2 版本（已废弃）
