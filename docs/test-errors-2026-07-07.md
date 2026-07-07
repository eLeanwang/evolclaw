# Test Errors Analysis - 2026-07-07

## 概览

- **总测试数**: 81
- **失败数**: 48
- **通过数**: 33
- **通过率**: 40.74%

## 错误分类

### 1. 配置系统错误 (最严重，影响范围最广)

#### 错误根源
`src/config/role-model-sync.ts:107` - `Cannot read properties of undefined (reading 'roles')`

```typescript
// 问题代码：
for (const [roleName, roleDef] of Object.entries(roles.roles || {})) {
                                                   ^
```

#### 影响范围 (21个测试)
- `tests/ctl-model-permission.test.ts` (5个测试全挂)
- `tests/model-cli-role-inference.test.ts` (4个测试全挂)
- `tests/peer-role-resolver.test.ts` (4个测试全挂)
- `tests/role-second-fixes.test.ts` (4个测试全挂)
- `tests/role-third-fixes.test.ts` (4个测试全挂)

#### 触发路径
```
buildLockedModelDefaults (role-model-sync.ts:107)
  ↑
syncNoOverrideRoleModelsForAgent (role-model-sync.ts:63)
  ↑
writeRoleAssignments (role-assignments.ts:53)
  ↑
setPrivateRoleAssignment / setScopedRoleAssignment
```

#### 诊断
`buildLockedModelDefaults` 函数接收的 `roles` 参数是 `undefined`，导致访问 `roles.roles` 失败。
这是 v3 配置体系迁移后的残留问题——调用方传入了错误的参数或未正确初始化。

---

### 2. Response System 架构错误 (14个测试)

#### 文件
`tests/response-system/modes/dual-session-lite-mode.test.ts`

#### 错误类型
所有14个测试全部失败，但错误信息被截断（输出超长）

#### 失败的测试
- 应该有显示名称
- 应该能够初始化（群聊场景）
- 应该能够初始化（单聊场景）
- 应该能够清理资源
- 应该能够处理入站消息
- 应该能够处理出站消息
- 应该能够获取引擎状态
- 应该反映队列状态
- 不同于 interactive：使用双会话架构
- 不同于 proactive：有显式的决策过程
- 适合群聊场景：支持消息缓冲和批量处理
- 单聊场景：队列容量限制为 15
- 群聊场景：队列容量使用配置值
- 引擎错误后应该能够恢复

#### 诊断
Dual-session-lite 模式的核心功能全部失效，可能是：
- 模式初始化失败
- 依赖的配置系统损坏（关联问题1）
- 架构重构后接口不匹配

---

### 3. Observer Insert / Session Selection 错误 (4个测试)

#### 文件
`tests/integration/observer-insert-session-selection.test.ts`

#### 失败的测试
- `inject(target=peer) hits the SAME session as a real peer message`
- `agent↔peer session is DISTINCT from agent↔owner session`
- `inject session and peer session share the same agentSessionId once set`
- `group inject(target=groupId) hits the agent↔group session`

#### 诊断
会话选择逻辑错误，observer insert 注入的消息没有正确路由到目标会话。
影响：
- 代理注入消息不能正确到达 peer 会话
- agent↔peer 与 agent↔owner 的会话隔离失效
- 群组注入路由错误

---

### 4. Menu System / Message Bridge 错误 (8个测试)

#### 文件
`tests/unit/message-bridge-command-payload.test.ts`

#### 失败的测试
- `menu.list 按角色调用 getMenuItems`
- `menu.list 在控制 channel 使用 control scope`
- `menu.query 通过 name 解析 cmd 并调用 execMenuQuery`
- `menu.options 通过 name 解析 cmd 并调用 getSubMenuItems`
- `menu.update 写入 value 并返回结构化结果`
- `menu.action 调用 execMenuAction`
- `menu.action 透传 args`
- `menu.options 支持 topic name 映射`

#### 诊断
菜单系统的命令桥接层失效，可能原因：
- 命令解析逻辑变更
- 角色权限检查失败（关联问题1）
- Message bridge 接口变更

---

### 5. Logical Queue Bridge 错误 (1个测试)

#### 文件
`tests/unit/logical-queue-bridge.test.ts`

#### 失败的测试
- `injected LIFO moves last message to head`

#### 诊断
LIFO (后进先出) 队列注入逻辑错误，注入的消息没有正确移到队列头部。

---

## 空测试文件 (0 tests - 10个文件)

以下文件没有实际运行的测试（可能是跳过或文件内容有问题）：
- `tests/unit/manifest-engine-each.test.ts`
- `tests/unit/observer-insert-render-modes.test.ts`
- `tests/unit/trigger-menu.test.ts`
- `tests/response-system/engines/v2/main-session.test.ts`
- `tests/unit/response-depth.test.ts`
- `tests/response-system/engines/v2/auxiliary-queue.test.ts`
- `tests/response-system/engines/v2/p0-fixes-verification.test.ts`
- `tests/unit/peer-key.test.ts`
- `tests/response-system/engines/v2/auxiliary-session.test.ts`
- `tests/unit/observer-insert-e2e.test.ts`
- `tests/integration/observer-insert-runtime.test.ts`
- `tests/unit/codex-runner-alignment.test.ts`

---

## 修复优先级

### P0 - Critical (阻塞性错误)
**问题1: 配置系统 - `roles.roles` undefined**
- 影响: 21个测试，多个核心功能模块
- 文件: `src/config/role-model-sync.ts:107`
- 修复策略: 
  1. 检查 `buildLockedModelDefaults` 的所有调用点
  2. 确保传入的 `roles` 参数已正确初始化
  3. 添加防御性检查：`if (!roles || !roles.roles) return new Map();`

### P1 - High (功能性错误)
**问题2: Response System - dual-session-lite 全部失败**
- 影响: 14个测试，群聊/单聊响应系统
- 文件: `tests/response-system/modes/dual-session-lite-mode.test.ts`
- 修复策略:
  1. 获取完整错误输出（当前被截断）
  2. 检查模式初始化代码
  3. 验证依赖的配置是否正确

**问题3: Observer Insert - 会话选择错误**
- 影响: 4个测试，消息注入路由
- 文件: `tests/integration/observer-insert-session-selection.test.ts`
- 修复策略:
  1. 检查会话选择逻辑
  2. 验证 `agentSessionId` 的分配机制
  3. 确认 peer/owner/group 会话隔离逻辑

### P2 - Medium (功能受限)
**问题4: Menu System - 命令桥接失败**
- 影响: 8个测试，菜单交互
- 修复策略: 检查 message bridge 的命令解析和分发逻辑

**问题5: Logical Queue - LIFO 注入错误**
- 影响: 1个测试
- 修复策略: 检查队列注入时的顺序调整逻辑

### P3 - Low (待调查)
**空测试文件** - 12个文件没有运行测试
- 需要检查是否是 skip 标记、条件跳过或文件内容错误

---

## 建议修复顺序

1. **立即修复 P0**: 解决 `role-model-sync.ts:107` 的 undefined 访问，这会立刻恢复21个测试
2. **跟进 P1**: 修复 response system 和 observer insert，恢复核心消息流
3. **清理 P2**: 修复 menu system 和 queue bridge
4. **调查 P3**: 检查空测试文件的状态

修复 P0 后，预计通过率可从 40.74% 提升到 ~66%。
