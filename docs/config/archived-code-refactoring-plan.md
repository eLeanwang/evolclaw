# 去除 behavior.json 后的代码改造清单

> 生成时间：2026-06-19
> 审查范围：src/ 目录所有 TypeScript 文件
> 引用统计：136 处 behavior 引用，分布在 19 个文件中

---

## 核心变更

### 变更前（当前设计）

```
H 链：defaults/config → agent/config → relation/config
HA 链：agent/behavior → role → relation/behavior
运行时：EffectiveAgentConfig = H 链结果 + behavior 段
```

### 变更后（新设计）

```
H 链：defaults/config → agent/config → relation/config
       ↑ 包含所有参数（H + HA）
运行时：EffectiveAgentConfig = H 链结果（不再有 behavior 段）
```

---

## 需要改造的文件清单（19个）

### 1. src/types.ts ⚠️ 重要

**当前问题**：
- `BehaviorConfig` 接口（line 900-924）- 定义了 HA 字段
- `EffectiveAgentConfig.behavior` 字段（line 946）- 包含 behavior 段

**需要修改**：
1. ✅ **保留** `BehaviorConfig` 接口（代码中很多地方在用）
2. ❌ **删除** `EffectiveAgentConfig.behavior` 字段
3. ✅ **合并** `BehaviorConfig` 的字段到 `EffectiveAgentConfig` 顶层

**修改方案**：
```typescript
// 修改前
export interface EffectiveAgentConfig {
  aid: string;
  // ... H 字段
  behavior: BehaviorConfig;  // ← 删除这个
}

// 修改后
export interface EffectiveAgentConfig {
  aid: string;
  // ... H 字段
  // HA 字段直接在顶层
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  chatmode?: ChatmodeBlock;
  flush_delay?: number;
  debounce?: number;
  dispatch?: 'mention' | 'broadcast';
  show_activities?: ShowActivitiesMode;
  proactive?: ProactiveBehaviorBlock;
  render?: { private?: string; group?: string; inject?: string };
  enable_rich_content?: boolean;
  permissionMode?: string;
  roles?: Record<string, RoleOverride>;
}
```

---

### 2. src/config/config-manager.ts ⚠️ 核心文件

**当前问题**：
- `ConfigTarget.AgentBehavior` 和 `RelationBehavior` 枚举（line 49, 51）
- `resolveBehavior()` 函数（line 272-308）- 合并 HA 链
- `resolveEffectiveAgentConfig()` 函数（line 314-340）- 合并 H + behavior

**需要修改**：
1. ❌ **删除** `ConfigTarget.AgentBehavior` 和 `RelationBehavior` 枚举值
2. ❌ **删除** `resolveBehavior()` 函数
3. ✅ **简化** `resolveEffectiveAgentConfig()` - 只合并 H 链

**修改方案**：
```typescript
// 删除这些
export enum ConfigTarget {
  // AgentBehavior = 'agent-behavior',     // ← 删除
  // RelationBehavior = 'relation-behavior', // ← 删除
}

// 简化 resolveEffectiveAgentConfig
export function resolveEffectiveAgentConfig(sel: Selector, opts: ResolveOpts = {}): EffectiveAgentConfig {
  const h = resolveAgentConfig(sel, opts);
  // 不再调用 resolveBehavior
  return {
    $schema_version: h.$schema_version ?? 1,
    aid: h.aid!,
    enabled: h.enabled,
    // ... 所有字段直接从 H 链取（H 链的 config.json 已包含所有参数）
    active_baseagent: h.active_baseagent,
    baseagents: h.baseagents,
    chatmode: h.chatmode,
    // ...
  };
}
```

---

### 3. src/config/schema-registry.ts ⚠️

**当前问题**：
- 注册了 `behavior` schema
- `loadSchema('behavior')` 被多处调用

**需要修改**：
1. ❌ **删除** `behavior` schema 的注册
2. ✅ **检查** 所有 `loadSchema('behavior')` 的调用点并修改

**搜索调用点**：
```bash
grep -n "loadSchema('behavior')" src/
```

---

### 4. src/config/snapshot.ts

**当前问题**：可能涉及备份 behavior.json

**需要检查**：
- 是否备份 behavior.json
- 如果有，删除相关逻辑

---

### 5. src/config-store.ts ⚠️ 旧接口

**当前问题**：
- 旧的配置访问接口，应该委托给 ConfigManager
- 可能包含 behavior 相关逻辑

**需要检查**：
- 是否有 behavior 相关的读写逻辑
- 确保委托给 ConfigManager 后行为正确

---

### 6. src/paths.ts

**当前问题**：可能定义了 behavior.json 的路径

**需要修改**：
- 删除 behavior.json 路径定义（如果有）

---

### 7. src/cli/*.ts（4个文件）

**文件列表**：
- src/cli/agent.ts
- src/cli/config.ts
- src/cli/daemon-commands.ts
- src/cli/model.ts

**当前问题**：
- CLI 命令可能引用 behavior 配置
- `/model` 命令可能修改 behavior.json

**需要检查**：
- 所有修改配置的 CLI 命令
- 确保它们操作 config.json 而非 behavior.json

---

### 8. src/core/*.ts（4个文件）

**文件列表**：
- src/core/evolagent.ts
- src/core/message/message-processor.ts
- src/core/model/config-scope.ts
- src/core/model/model-catalog.ts

**当前问题**：
- EvolAgent 可能读取 `config.behavior` 字段
- MessageProcessor 可能读取 behavior 配置

**需要修改**：
- 所有访问 `config.behavior.xxx` 的地方改为 `config.xxx`

---

### 9. src/agents/*.ts（2个文件）

**文件列表**：
- src/agents/claude-runner.ts
- src/agents/codex-runner.ts

**当前问题**：
- BaseAgent runner 可能读取 `config.behavior` 字段

**需要修改**：
- 所有访问 `config.behavior.xxx` 的地方改为 `config.xxx`

---

### 10. src/channels/aun.ts

**当前问题**：
- AUN channel 可能读取 behavior 配置

**需要修改**：
- 访问 behavior 字段的地方

---

### 11. src/core/permission.ts

**当前问题**：
- 权限系统可能基于 behavior 配置

**需要检查**：
- permissionMode 的读取方式

---

### 12. src/utils/bind.ts

**当前问题**：未知，需要检查

---

## 改造步骤（推荐顺序）

### 阶段 1：类型定义修改（基础）

1. ✅ **修改 src/types.ts**
   - 删除 `EffectiveAgentConfig.behavior` 字段
   - 将 `BehaviorConfig` 的字段合并到 `EffectiveAgentConfig` 顶层
   - 保留 `BehaviorConfig` 接口（向后兼容）

2. ✅ **删除 schema 注册**
   - 修改 `src/config/schema-registry.ts`
   - 删除 `behavior` schema 注册

### 阶段 2：ConfigManager 改造（核心）

3. ✅ **修改 src/config/config-manager.ts**
   - 删除 `ConfigTarget.AgentBehavior` 和 `RelationBehavior`
   - 删除 `resolveBehavior()` 函数
   - 简化 `resolveEffectiveAgentConfig()` - 只合并 H 链
   - 修改 `targetPath()` - 删除 behavior 路径逻辑
   - 修改字段归属判断逻辑

4. ✅ **修改 src/paths.ts**
   - 删除 behavior.json 路径定义

5. ✅ **修改 src/config/snapshot.ts**
   - 删除 behavior.json 备份逻辑

### 阶段 3：调用方修改（批量）

6. ✅ **批量修改所有 `config.behavior.xxx` 访问**
   - 搜索：`config\.behavior\.`
   - 替换：`config.`
   - 涉及文件：
     - src/core/evolagent.ts
     - src/core/message/message-processor.ts
     - src/agents/claude-runner.ts
     - src/agents/codex-runner.ts
     - src/channels/aun.ts
     - 等

7. ✅ **修改 CLI 命令**
   - src/cli/config.ts - 配置读写命令
   - src/cli/model.ts - 模型切换命令
   - src/cli/agent.ts - agent 管理命令
   - 确保它们操作 config.json

### 阶段 4：测试与验证

8. ✅ **编译检查**
   ```bash
   npm run build
   ```

9. ✅ **运行时测试**
   - 启动 agent
   - 测试配置读取
   - 测试配置修改（通过 CLI）
   - 测试关系级配置覆盖

10. ✅ **回归测试**
    - 测试模型切换
    - 测试权限模式
    - 测试渲染模式
    - 测试所有 behavior 相关功能

---

## 风险点

### 高风险
1. **EffectiveAgentConfig 结构变更** - 影响所有下游代码
2. **ConfigManager 核心逻辑** - 配置合并算法的改变
3. **CLI 命令** - 用户直接使用，必须保持兼容

### 中风险
4. **BaseAgent runner** - 模型配置读取
5. **MessageProcessor** - 消息处理流程
6. **权限系统** - permissionMode 读取

### 低风险
7. **Snapshot** - 备份功能
8. **Paths** - 路径定义

---

## 向后兼容策略

### 代码兼容
- ✅ 保留 `BehaviorConfig` 接口（很多地方在用）
- ✅ 提供 helper 函数：`getBehaviorFields(config: EffectiveAgentConfig): BehaviorConfig`
- ✅ 渐进式迁移：先让两种方式都能工作

### 配置文件兼容
- ✅ 旧的 agent/config.json（没有 active_baseagent/baseagents）仍能读取
- ✅ 从 defaults.json 继承这些字段
- ❌ 旧的 behavior.json 文件将被忽略（可以保留在磁盘，但不读取）

---

## 检查清单

在开始改造前，先检查：

- [ ] 确认当前有哪些 agent 在运行
- [ ] 备份所有配置文件
- [ ] 确认测试覆盖率
- [ ] 准备回滚方案
- [ ] 与团队同步改造计划

---

## 需要你确认

1. **是否立即开始改造？** 还是先做更详细的影响分析？
2. **是否需要提供降级/回滚机制？** 还是直接硬切换？
3. **是否需要保留 behavior.json 的读取兼容？** 还是完全忽略？

确认后，我可以开始逐个文件改造。建议从阶段 1 开始，每个阶段完成后测试通过再进入下一阶段。
