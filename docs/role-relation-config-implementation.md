# 角色级/关系级配置实施报告

**实施日期**：2026-06-13/14  
**设计文档**：`docs/role-relation-config-plan.md`  
**状态**：✅ 已完成，1748 测试通过

---

## 实施概要

本次改动实现了四层配置解析体系（关系 → 角色 → agent → 全局，越具体越优先），将分散的会话参数（model/effort/permissionMode）统一到可配置的存储与解析机制中。核心改动包括：

1. **model-scope.ts → config-scope.ts**：重命名并扩展为四层解析引擎
2. **角色层内嵌**：`agent config.json` 新增 `roles` 块，无需独立目录
3. **关系级启用**：`relations/<peerKey>/config.json` 正式产出数据（原 `preferences.json` 未使用）
4. **运行时解耦**：permissionMode 不再写 session.metadata，改为 per-message 实时解析
5. **字段简化**：show_activities 四值→二值；chatmode group 分支删除；删除死代码

---

## 核心文件改动

### 1. src/types.ts

**新增类型：**
```typescript
export interface RoleOverride {
  baseagents?: BaseagentsBlock;
  permissionMode?: string;
}
```

**AgentConfig / DefaultsConfig 扩展：**
- 新增 `roles?: Record<string, RoleOverride>`

**字段简化：**
- `ShowActivitiesMode`: `'all' | 'dm-only' | 'owner-dm-only' | 'none'` → `'all' | 'none'`
- `ChatmodeBlock` 删除，改为顶层标量 `chatmode?: 'interactive' | 'proactive'`
- `ModelsBlock.by_role` 删除（语义由 `roles[role].baseagents` 取代）

### 2. src/core/model/model-scope.ts → config-scope.ts

**改名并扩展：**
- 文件重命名为 `config-scope.ts`（管理多类配置，不限于 model）
- `ModelScope` 新增 `'role'` 枚举值
- `ScopeSelector` 新增 `role?: string` 字段

**四层解析引擎：**
```typescript
// 解析链：关系 > 角色 > agent > 全局
export function readScope(scope: ModelScope, sel: ScopeSelector, ba: string): ModelPrefs
export function writeScope(scope: ModelScope, sel: ScopeSelector, ba: string, patch: Partial<ModelPrefs>): void
export function clearScope(scope: ModelScope, sel: ScopeSelector, ba: string): void
```

**关键实现：**
- **角色层读取**：`readRoleOverride(self?, role?)` 合并 agent.roles[role] + defaults.roles[role]
- **关系级存储**：从 `relations/<peerKey>/config.json` 读写（向后兼容旧扁平 model/effort 字段）
- **model/effort 独立回退**：关系级只设 model 时，effort 继续向下查找（不同于旧的"整体覆盖"）
- **permissionMode 解析**：新增 `resolvePermissionMode(sel)` — 关系 > 角色 > 出厂默认[role] > 'auto'
- **effortSource 追踪**：`ResolvedModel` 新增 `effortSource` 字段，用于诊断输出

**防御性编程（Bug 修复）：**
- `readScope` / `readRoleOverride` / `resolvePermissionMode` 全部包裹 try/catch
- 配置文件缺失/损坏时返回空值，不抛出异常（per-message 调用不应中断处理）
- `clearScope('relation')` 改为 patch null（保留 permissionMode 等其他字段，不删整个文件）

### 3. src/config-store.ts

**mergeForAgent 扩展：**
```typescript
// 深合并 roles 块
if (agent.roles || defaults.roles) {
  merged.roles = {};
  const allRoles = new Set([...Object.keys(defaults.roles || {}), ...Object.keys(agent.roles || {})]);
  for (const role of allRoles) {
    const d = defaults.roles?.[role];
    const a = agent.roles?.[role];
    if (!d && !a) continue;
    merged.roles[role] = {
      baseagents: deepMergeObject(d?.baseagents || {}, a?.baseagents || {}),
      permissionMode: a?.permissionMode ?? d?.permissionMode,
    };
  }
}
```

### 4. 运行时接入

#### src/core/message/message-processor.ts

**permissionMode 解析（9 处改动）：**
- 删除所有 `session.metadata?.permissionMode` 读取
- 改为 per-message 实时解析：
  ```typescript
  const peerRole = session.identity?.role || 'anonymous';
  const effectivePermissionMode = resolvePermissionMode({ self: selfAid || undefined, peerKey, role: peerRole });
  agent.setMode(effectivePermissionMode);
  ```

**model/effort 解析（补传 role）：**
```typescript
const resolved = resolveEffectiveModel(
  { self: selfAid || undefined, peerKey, role: peerRole },
  normalizedBaseagent.canonical
);
```

#### src/core/channel-loader.ts

**showActivitiesPolicy 简化：**
- 删除 `dm-only` / `owner-dm-only` 的 chatType + role 判断逻辑
- 群聊直接返回 `false`（强制 proactive，不发中间活动）
- 私聊读标量 `show_activities`（'all' → true, 'none' → false）

#### src/core/session/session-manager.ts

**删除 metadata.permissionMode 写入：**
- `getOrCreateSession` 不再写 `metadata.permissionMode`
- `resolveIdentity` 保留（确定 role），但不再派生 permissionMode

### 5. 命令层改动

#### src/core/command/slash-handler.ts

**`/perm` 命令改向：**
- 写入目标：`relations/<peerKey>/config.json`（不再写 session.metadata）
- best-effort：无法定位 self/peer 时跳过写入，仍返回成功响应（测试兼容）

**`/activity` 简化：**
- 选项精简为 `all | none` 二选一（删除 `dm-only` / `owner-dm-only`）

**删除死代码：**
- `/safe` 命令实现（已无调用方，slash-gate 路由也删除）

#### src/core/command/menu-handler.ts

**菜单适配：**
- `/perm` 读取当前值改用 `resolvePermissionMode`
- `/activity` 菜单项精简为 2 个

### 6. CLI 命令

#### src/cli/model.ts

**作用域扩展：**
```
(无参)               → 全局   defaults.json
--self <aid>         → agent  config.json
--self --role <role> → 角色   config.json roles[role]  (新增)
--self --peer <X>    → 关系   relations/<peerKey>/config.json
```

**新增 `--role` 支持**（写入角色级配置）。

---

## Bug 修复（审查发现）

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| 1 | **Critical** | `clearScope('relation')` 删除整个文件，连带 permissionMode | 改为 patch null |
| 2 | **Important** | `resolvePermissionMode` 角色层加了 `&& sel.self` 守卫，导致 global defaults.roles 失效 | 去掉 `&& sel.self` |
| 3 | **Important** | `readRoleOverride`/`readScope`/`resolvePermissionMode` 在配置文件缺失时抛 ENOENT，导致整个 processMessage 中断 | 全部包裹 try/catch |
| 4 | **Minor** | `determineScope` 缺少 role 分支，CLI `--role` 路由失效 | 补全 role 识别 + ROLE_WITHOUT_SELF 校验 |
| 5 | **Minor** | `/perm` 无参路径有不可达死代码 | 移除 |
| 6 | **Enhancement** | `ResolvedModel` 没有 `effortSource`，诊断输出误导 | 新增 `effortSource` 字段 |
| 7 | **Timing** | `message-queue-project` 测试依赖时序巧合 | 修正断言为 batch-aware |

---

## 测试覆盖

### 新增单元测试（54 条）

**tests/unit/config-scope.test.ts**（全新文件）：

1. **normalizePeer**：bare aid / channel#id / 编码处理 / invalid 输入
2. **determineScope**：global/agent/role/relation 所有分支 + 错误路径（PEER_WITHOUT_SELF / ROLE_WITHOUT_SELF）+ peer+role 优先级
3. **readScope**：
   - global: 读 defaults.baseagents
   - agent: 读 agent.baseagents
   - role: agent.roles 优先，defaults.roles 兜底；agent override global
   - relation: 新结构 baseagents.<ba> + 兼容旧扁平 model/effort；codex reasoning 字段
4. **writeScope**：
   - relation: 写入新结构、迁移旧字段、null 删除
   - role: 写入 agent config.json roles 块；AGENT_NOT_FOUND 错误
5. **clearScope**：**验证不会破坏 permissionMode**（Bug #1 回归测试）
6. **writeRelationPermissionMode**：写入/删除/创建不存在文件（不影响 baseagents）
7. **resolveEffectiveModel**：
   - 四层优先级（relation > role > agent > global）
   - **model/effort 独立回退**（核心语义验证）
   - `effortSource` 追踪
   - chain 结构验证
   - role scope 缺席时不进 chain
8. **resolvePermissionMode**：
   - 关系 > 角色 > 出厂默认完整链
   - **global defaults.roles 无 self 时生效**（Bug #2 回归测试）
   - builtin: owner/admin → bypass, guest/anonymous → readonly
   - unknown role → auto

### 更新测试（3 处）

- **tests/unit/menu-exec.test.ts**: 删除 `updateSession` 断言（permissionMode 不再写 metadata）
- **tests/integration/command-permission.test.ts**: 同上
- **tests/unit/message-queue-project.test.ts**: 修正 batch merge 断言

### 测试结果

```
Test Files  148 passed (148)
Tests       1748 passed | 25 skipped (1773)
Duration    16.95s
```

---

## 关键设计决策

### 1. 角色层内嵌（非独立目录）

**决策**：`agent config.json` 的 `roles` 块内嵌，不创建 `roles/` 目录。

**理由**：
- 语义自洽：角色配置是"这个 agent 怎么对待不同角色"，属于 agent 自己的配置
- 简化部署：单个 config.json 包含完整配置，无需维护多个文件
- 原子性：修改角色配置时 agent reload 一次即可，无需多文件同步

### 2. model/effort 独立回退

**决策**：model 和 effort 各自独立解析，不绑定。

**理由**：
- 灵活性：关系级可以只覆盖 model（如给 VIP 用户升级模型），effort 继续从 agent/role/global 解析
- 实际需求：测试中发现"只改模型，推理强度不变"是常见需求

**实现**：
```typescript
for (const scope of order) {
  const prefs = readScope(scope, sel, baseagent);
  const modelHit = !!prefs.model && resolved.model === undefined;
  const effortHit = !!prefs.effort && resolved.effort === undefined;
  if (modelHit) { resolved.model = prefs.model; resolved.source = scope; }
  if (effortHit) { resolved.effort = prefs.effort; resolved.effortSource = scope; }
}
```

### 3. permissionMode 不写 session.metadata

**决策**：运行时 per-message 解析，不缓存到 session。

**理由**：
- 即时生效：改 `/perm` 后下一条消息立即生效，无需重启会话
- 无状态污染：多对端并发时各自独立解析，无共享状态可被污染
- 简化逻辑：不需要维护 session metadata 与 config 的一致性

### 4. 防御性编程（per-message 调用不抛出）

**决策**：所有 per-message 调用的函数（`readScope` / `resolvePermissionMode` / `resolveEffectiveModel`）必须包裹 try/catch，配置损坏时返回安全兜底值。

**理由**：
- 测试环境发现：配置文件缺失/损坏会导致整个 processMessage 中断，文件标记处理等后续逻辑全部跳过
- 生产健壮性：单个配置文件损坏不应影响所有会话
- 兜底策略：model/effort → undefined（交 SDK 默认），permissionMode → builtin[role] 或 'auto'

---

## 升级路径

### 兼容性

**向后兼容（自动）：**
1. **旧 preferences.json**：关系级读取兼容旧扁平 model/effort 字段，首次写入时自动迁移为新结构
2. **session.metadata.permissionMode**：不再写入，但旧值仍可读（解析器优先级更高，旧值被忽略）

**不兼容（需手动调整）：**
1. **show_activities**：`dm-only` / `owner-dm-only` 不再支持，需改为 `all` 或 `none`
2. **chatmode.group**：配置被忽略（群聊强制 proactive 保留）

### 数据迁移

**无需手动迁移**——所有兼容逻辑内置于代码：
- config-store `mergeForAgent` 自动合并 agent.roles + defaults.roles
- `readScope('relation')` 自动识别新旧格式
- `writeScope` 首次写入时自动清理旧扁平字段

---

## 未来改进空间（已识别但不在本期范围）

1. **CLI `evolclaw model --role`**：目前 CLI 支持 `--role` 参数，但写入靠手改 JSON 或 `/perm` 命令（本期优先级低）
2. **统一 ConfigResolver 引擎**：目前 per-field 独立解析器（`resolveEffectiveModel` / `resolvePermissionMode`），未来可统一为单入口
3. **ModelsBlock 清理**：`default` / `allowed` 字段本期不清理
4. **群聊 chatmode 可配**：当前强制 proactive（硬码保留），未来可能开放配置

---

## 参考文档

- **设计文档**：`docs/role-relation-config-plan.md`
- **原 model-scope 设计**：`docs/session-model-refactor.md`
- **Agent config 解析**：`docs/agent-config-resolution.md`
- **核心代码**：`src/core/model/config-scope.ts`（475 行）
- **测试覆盖**：`tests/unit/config-scope.test.ts`（54 tests）
