# Test Errors Analysis - 2026-07-07 (第二次运行)

## 概览

- **总测试文件**: 87
- **失败文件数**: 23
- **通过文件数**: 64
- **总测试数**: 866
- **失败测试数**: 55
- **通过测试数**: 810
- **跳过测试数**: 1
- **通过率**: 93.5% ✨

## 重要发现

**第一次运行显示21个配置系统错误，第二次运行这些错误消失了！** 

这说明：
1. 配置系统问题是**间歇性的**或**初始化顺序相关的**
2. 测试之间可能有状态泄漏
3. 第二次运行时某些全局状态已经正确初始化

---

## 错误分类（第二次运行）

### 1. 模块缺失错误 (12个文件，0个测试运行)

#### 影响文件
这些文件因为无法加载模块而完全没有运行测试：

1. **Response System 相关** (5个)
   - `tests/response-system/engines/v2/auxiliary-queue.test.ts`
   - `tests/response-system/engines/v2/auxiliary-session.test.ts`
   - `tests/response-system/engines/v2/main-session.test.ts`
   - `tests/response-system/engines/v2/p0-fixes-verification.test.ts`
   - `tests/unit/response-depth.test.ts`

   **缺失模块**: 
   - `src/response-system/engines/v2/auxiliary-queue.js`
   - `src/response-system/engines/v2/auxiliary-session.js`
   - `src/response-system/engines/v2/main-session.js`
   - `src/core/message/response-depth.js`

2. **消息处理相关** (3个)
   - `tests/integration/observer-insert-runtime.test.ts`
   - `tests/unit/codex-runner-alignment.test.ts`
   - `tests/unit/observer-insert-e2e.test.ts`

   **缺失模块**: 
   - `src/core/message/message-processor.js`
   - `src/agents/message-renderer.js`

3. **其他核心模块** (4个)
   - `tests/unit/manifest-engine-each.test.ts` → `src/agents/manifest-engine.js`
   - `tests/unit/observer-insert-render-modes.test.ts` → `src/agents/manifest-engine.js`
   - `tests/unit/peer-key.test.ts` → `src/core/relation/peer-key.js`
   - `tests/unit/trigger-menu.test.ts` → `src/core/trigger/manager.js`

#### 诊断
这些是 **真正缺失的源文件**（不是测试问题）。可能原因：
- 重构时删除了但测试未更新
- 文件被移动到新位置但导入路径未更新
- TypeScript 编译未生成 `.js` 文件（构建问题）

---

### 2. Dual-Session-Lite Mode 实现未完成 (14个测试失败)

#### 文件
`tests/response-system/modes/dual-session-lite-mode.test.ts`

#### 根本原因
```typescript
// src/response-system/modes/dual-session-lite/index.ts:33
throw new Error('[DualSessionLiteMode] V2 engine implementation is not available yet');
```

所有失败都是因为**故意抛出的"未实现"错误**。

#### 失败的测试
- ❌ 应该有显示名称（期望 "双会话响应模式"，实际 "双会话轻量模式"）
- ❌ 应该能够初始化（群聊/单聊场景）
- ❌ 应该能够清理资源
- ❌ 应该能够处理入站/出站消息
- ❌ 应该能够获取引擎状态
- ❌ 应该反映队列状态
- ❌ 不同于 interactive/proactive 的特性
- ❌ 单聊/群聊场景差异
- ❌ 引擎错误恢复
- ❌ `getStatus` 方法未定义

#### 诊断
这是一个**待实现的功能**，不是bug。测试是为未来的实现准备的。

---

### 3. Agent CLI 命令变更 (6个测试失败)

#### 文件
- `tests/integration/agent-cli.test.ts` (6个)
- `tests/integration/agent-scenarios.test.ts` (2个)

#### 问题1: `agent rename` 命令已移除

```
测试期望: help 文本包含 /rename/
实际输出: 帮助文本中没有 rename 命令

测试期望: ec agent rename 返回成功
实际行为: 返回退出码 1，提示"已取消；请编辑 agent.md 后使用 ec aid agentmd put"
```

**诊断**: `rename` 命令已被废弃，改为手动编辑 + `ec aid agentmd put` 的工作流。

#### 问题2: `agent enable/disable` 返回退出码 1

```typescript
// 期望 code = 0，实际 code = 1
seedAgent('alice.agentid.pub', false);
const r = runCli(['agent', 'enable', 'alice.agentid.pub']);
expect(r.code).toBe(0); // ❌ 失败，实际是 1
```

**诊断**: `enable`/`disable` 命令执行逻辑可能有错误，或者错误处理发生了变化。

---

### 4. Observer Insert Session Selection (4个测试失败)

#### 文件
`tests/integration/observer-insert-session-selection.test.ts`

#### 根本原因
```typescript
Error: [SessionManager] getOrCreateSession: baseagent is empty
// at SessionManager.getOrCreateSession src/core/session/session-manager.ts:649
```

#### 失败的测试
- `inject(target=peer) hits the SAME session as a real peer message`
- `agent↔peer session is DISTINCT from agent↔owner session`
- `inject session and peer session share the same agentSessionId once set`
- `group inject(target=groupId) hits the agent↔group session`

#### 诊断
测试环境未正确初始化 `baseagent` 参数，导致会话创建失败。

---

### 5. Menu 系统相关 (11个测试失败)

#### 文件
- `tests/unit/message-bridge-command-payload.test.ts` (8个)
- `tests/unit/menu-exec.test.ts` (11个)

#### 失败类型1: Message Bridge 命令解析失败 (8个)
- `menu.list` 按角色调用失败
- `menu.query` 解析失败
- `menu.options` 解析失败
- `menu.update` 写入失败
- `menu.action` 调用失败

#### 失败类型2: 权限模式切换失败 (11个)
```typescript
// tests/unit/menu-exec.test.ts
✗ returns current mode (60ms)
✗ switches mode (owner)
✗ switches to readonly mode (owner)
✗ switches mode (admin)
✗ handles /perm readonly through the chat command path
✗ switches mode in session
✗ rejects restart for non-owner
✗ rejects upgrade for non-owner
✗ /perm marks current mode as selected
```

#### 诊断
菜单系统的权限检查和命令路由逻辑可能在配置系统重构后失效。

---

### 6. 其他零散错误 (18个)

#### Agent Control (2个)
- `tests/unit/agent-control.test.ts`
  - `returns accepted immediately and fires create in background` - 返回值结构变化
  - `applies model/chatmode via agentSet in background` - agentSet 未被调用

#### Agent.test.ts (4个)
- `enables a disabled agent` (52ms)
- `disables an enabled agent` (54ms)
- `returns error if agent.md missing` (51ms)
- `updates name in agent.md` (34ms)

#### Command Rewind (1个)
- `tests/unit/command-rewind.test.ts`
  - `should reject for non-claude agent` (16ms)

#### CMD Init (2个)
- `tests/unit/cmd-init.test.ts`
  - `rejects existing defaults.json without --force` (910ms)
  - `tail is idempotent: existing aid is not regenerated` (247ms)

#### Logical Queue Bridge (1个)
- `tests/unit/logical-queue-bridge.test.ts`
  - `injected LIFO moves last message to head` (5ms)

---

## 对比第一次运行

| 指标 | 第一次 | 第二次 | 变化 |
|------|--------|--------|------|
| 失败测试数 | 48 | 55 | +7 😱 |
| 通过率 | 40.74% | 93.5% | +52.76% 🎉 |
| 配置系统错误 | 21 | 0 | -21 ✅ |
| 模块缺失错误 | 12 | 12 | 持平 |

**关键洞察**: 
- 第一次运行时配置系统崩溃，导致**大量测试因前置条件失败而未运行**
- 第二次运行配置系统正常，**更多测试得以运行**，暴露了之前被掩盖的问题
- 实际通过率从41%跳到93.5%，说明**大部分代码是健康的**

---

## 修复优先级（更新）

### P0 - Critical（阻塞发布）

**1. 配置系统间歇性崩溃**
- 现象: `roles.roles` 间歇性 undefined
- 影响: 21个测试在第一次运行时全挂
- 修复策略: 
  ```typescript
  // 在 buildLockedModelDefaults 添加防御性检查
  function buildLockedModelDefaults(roles: RolesConfig): Map<...> {
    if (!roles || !roles.roles) {
      console.warn('[role-model-sync] roles config is empty, skipping');
      return new Map();
    }
    // ... 现有逻辑
  }
  ```

**2. 模块缺失 (12个文件)**
- 两种可能：
  - A. 文件真的不存在 → 需要实现或删除测试
  - B. 构建配置问题 → 检查 tsconfig.json 和构建脚本
- 检查方法:
  ```bash
  # 检查源文件是否存在
  ls src/response-system/engines/v2/
  ls src/core/message/message-processor.ts
  ls src/agents/message-renderer.ts
  ```

### P1 - High（功能性问题）

**3. Agent Enable/Disable 命令失败**
- 影响: 6个 CLI 测试 + 2个场景测试
- 修复: 检查 `agent enable/disable` 的实现逻辑

**4. Observer Insert Session 创建失败**
- 影响: 4个会话隔离测试
- 修复: 确保测试环境正确初始化 `baseagent`

**5. Menu 系统权限检查失败**
- 影响: 19个菜单相关测试
- 修复: 检查配置系统重构后的权限验证逻辑

### P2 - Medium（可延后）

**6. Dual-Session-Lite 未实现**
- 状态: 14个测试失败，但这是**已知的未完成功能**
- 策略: 
  - 选项A: 用 `it.todo()` 或 `it.skip()` 标记这些测试
  - 选项B: 保持现状，作为提醒
  - 选项C: 实现该功能

**7. Agent Rename 命令废弃**
- 影响: 4个测试
- 修复: 更新测试以反映新的工作流（编辑 + put）

**8. 其他零散错误** (18个)
- Agent control、command rewind、init 等
- 逐个检查修复

---

## 建议行动

### 立即行动（今天）

1. **确认模块是否真的缺失**
   ```bash
   find src -name "message-processor.*"
   find src -name "auxiliary-queue.*"
   # 如果文件存在，检查构建配置
   # 如果文件不存在，决定是实现还是删除测试
   ```

2. **修复配置系统防御性检查**
   - 在 `role-model-sync.ts:107` 添加 null 检查
   - 追踪 `buildLockedModelDefaults` 被调用时 roles 为何是 undefined

3. **修复 agent enable/disable**
   - 检查这两个命令的返回值和错误处理

### 短期（本周）

4. 修复 observer insert session 初始化
5. 修复 menu 系统权限检查
6. 决定 dual-session-lite 的处理策略（skip测试或实现功能）
7. 更新 agent rename 相关测试

### 预期效果

- 修复 P0 后：通过率 → **98%+** （仅剩 dual-session-lite 的 14个未完成测试）
- 修复 P0+P1 后：通过率 → **100%** （如果 skip dual-session-lite）

---

## 测试稳定性问题

**重要**: 两次运行结果不一致，说明存在：
- 测试间的状态泄漏
- 初始化顺序依赖
- 全局单例状态污染

建议：
- 使用 `beforeEach` 清理全局状态
- 检查是否有测试修改了共享的配置文件
- 考虑使用测试隔离（每个测试独立的临时目录）
