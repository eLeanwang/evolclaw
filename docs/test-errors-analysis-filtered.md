# 测试错误分析 - 2026-07-07 (过滤后)

## 测试概览

- **总测试**: 863
- **通过**: 817 (94.7%)
- **失败**: 45 (5.3%)
- **跳过**: 1

**过滤条件**: 已排除响应系统相关和模块缺失错误

---

## 剩余错误分类（27个失败测试）

### 1. Menu 系统错误 (19个测试失败)

#### 文件
- `tests/unit/menu-exec.test.ts` - 11个失败
- `tests/unit/message-bridge-command-payload.test.ts` - 8个失败

#### Git 提交信息
- **提交者**: win11\agentcp
- **日期**: 2026-07-02
- **提交**: "文档提交+测试脚本"

#### 具体错误

**menu-exec.test.ts (11个)**:
1. `/perm` - returns current mode
2. `/perm` - switches mode (owner)
3. `/perm` - switches to readonly mode (owner)
4. `/perm` - switches mode (admin)
5. `/perm` - handles /perm readonly through the chat command path
6. `/perm` - handles /perm readonly through the chat command path for admin
7. `/chatmode` - switches mode in session
8. `/activity` - switches mode (owner)
9. `/system` - rejects restart for non-owner via control channel (owners check)
10. `/system` - rejects upgrade for non-owner via control channel (owners check)
11. `getSubMenuItems` - /perm marks current mode as selected

**message-bridge-command-payload.test.ts (8个)**:
1. menu.list 按角色调用 getMenuItems
2. menu.list 在控制 channel 使用 control scope
3. menu.query 通过 name 解析 cmd 并调用 execMenuQuery
4. menu.options 通过 name 解析 cmd 并调用 getSubMenuItems
5. menu.update 写入 value 并返回结构化结果
6. menu.action 调用 execMenuAction
7. menu.action 透传 args
8. menu.options 支持 topic name 映射

#### 问题特征
- 权限模式 (`/perm`) 切换失败
- 聊天模式 (`/chatmode`) 切换失败
- 菜单命令解析和执行失败
- 角色权限检查失败

**推测原因**: 配置系统 v3 重构后，menu 系统依赖的配置读取/写入路径变化

---

### 2. Agent 模块错误 (4个测试失败)

#### 文件
- `tests/unit/agent.test.ts` - 2个失败
- `tests/unit/agent-control.test.ts` - 2个失败

#### Git 提交信息

**agent.test.ts**:
- **提交者**: win11\agentcp
- **日期**: 2026-07-07
- **提交**: "test: clean up behavior.json remnants in test files"

**agent-control.test.ts**:
- **提交者**: win11\agentcp
- **日期**: 2026-07-02
- **提交**: "文档提交+测试脚本"

#### 具体错误

**agent.test.ts (2个)**:
1. `agentRename` - returns error if agent.md missing
2. `agentRename` - updates name in agent.md

**原因**: 单元测试中还在测试已废弃的 `agentRename` 函数

---

**agent-control.test.ts (2个)**:
1. `execAgentAction create` - returns accepted immediately and fires create in background
2. `execAgentAction create` - applies model/chatmode via agentSet in background (D2)

**问题**: 返回值结构不符合预期，`data.accepted` 为 undefined

---

### 3. Command Init 错误 (2个测试失败)

#### 文件
- `tests/unit/cmd-init.test.ts`

#### Git 提交信息
- **提交者**: win11\agentcp
- **日期**: 2026-07-02
- **提交**: "文档提交+测试脚本"

#### 具体错误
1. `rejects existing defaults.json without --force (no defaults rewrite)` - 854ms
2. `tail is idempotent: existing aid is not regenerated` - 275ms

**问题特征**: 测试执行时间异常长（应该是瞬时的）

---

### 4. Command Rewind 错误 (1个测试失败)

#### 文件
- `tests/unit/command-rewind.test.ts`

#### Git 提交信息
- **提交者**: win11\agentcp
- **日期**: 2026-07-02
- **提交**: "文档提交+测试脚本"

#### 具体错误
- `should reject for non-claude agent`

---

### 5. Logical Queue Bridge 错误 (1个测试失败)

#### 文件
- `tests/unit/logical-queue-bridge.test.ts`

#### Git 提交信息
- **提交者**: win11\agentcp
- **日期**: 2026-07-02
- **提交**: "文档提交+测试脚本"

#### 具体错误
- `injected LIFO moves last message to head`

**问题**: LIFO (后进先出) 队列注入逻辑错误

---

## 修复优先级

### P1 - High Priority

**1. 删除 agentRename 单元测试** (2个)
- 简单快速
- 函数已废弃，测试无意义

**2. Menu 系统修复** (19个)
- 影响最大
- 可能是配置系统重构的连锁反应
- 需要检查配置读取路径是否正确

### P2 - Medium Priority

**3. Agent Control 返回值结构** (2个)
- 检查 `execAgentAction` 的返回值格式

**4. Command Init 超时问题** (2个)
- 测试执行时间异常，可能有死锁或阻塞

### P3 - Low Priority

**5. Command Rewind** (1个)
**6. Logical Queue Bridge** (1个)

---

## 总结

**所有失败的测试文件都是 `win11\agentcp` 提交的**，主要集中在两个批次：
- **2026-07-02**: "文档提交+测试脚本" - 6个文件
- **2026-07-07**: "test: clean up behavior.json remnants" - 1个文件

**核心问题**: 配置系统 v3 重构后，依赖旧配置路径的测试失效，尤其是 Menu 系统。
