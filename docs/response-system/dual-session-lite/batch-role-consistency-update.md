# Dual-Session-Lite 批次角色权限一致性更新

更新时间：2026-07-07

## 📝 更新内容

### 文档：`docs/response-system/dual-session-lite/architecture.md`

#### 1. 新增章节 3.8：群聊批次角色权限一致性

**位置**：第 956 行（3.7 辅助会话失败降级流程 之后）

**内容**：
- 问题背景：为什么需要角色一致性约束
- 解决方案：批次提取时检查角色一致性
- 实现机制：角色层级、批次提取逻辑、batchRole 计算
- 权限矩阵：不同角色的权限判断规则
- 场景示例：角色一致、角色混合、角色交替的具体例子
- 优势：防止权限提升、保守安全、批次完整性、审计清晰

#### 2. 更新 AuxiliaryQueue.extractBatch() 方法

**位置**：第 177-211 行

**变更**：
- 添加 `batchRole` 变量追踪批次角色
- 添加群聊模式下的角色一致性检查
- 遇到角色不一致时停止提取批次

**代码逻辑**：
```typescript
// 群聊中检查发送者角色是否一致
if (this.chatType === 'group') {
  const messageRole = qm.message.role;
  
  if (batch.length === 0) {
    batchRole = messageRole;  // 第一条消息
  } else if (batchRole !== messageRole) {
    break;  // 角色不一致，停止
  }
}
```

#### 3. 更新 MainQueue.extractBatch() 方法

**位置**：第 475-507 行

**变更**：
- 添加群聊模式的专门处理分支
- 实现角色一致性检查逻辑
- 私聊模式保持原有逻辑不变

**代码逻辑**：
```typescript
if (this.chatType === 'group') {
  // 群聊：检查角色一致性
  let batchRole: string | undefined;
  for (let i = 0; i < queue.length && i < maxBatchSize; i++) {
    if (i === 0 || message.role === batchRole) {
      batch.push(message);
    } else {
      break;  // 角色不一致
    }
  }
} else {
  // 私聊：直接提取
  batch = queue.splice(0, maxBatchSize);
}
```

#### 4. 更新批次边界规则说明

**位置**：第 834-842 行

**新增规则**：
- **【群聊权限控制】群聊中，批次内所有消息的发送者角色（role）必须一致**
- 角色包括：owner / admin / member / guest / anonymous
- 遇到第一条角色不一致的消息时停止提取
- 说明原因：Agent 处理批次时可能调用需要权限判断的命令
- 说明安全性：防止低权限用户与高权限用户的消息合并

---

## 🎯 设计原理

### 问题根源

在群聊场景中：
1. 多个用户的消息可能被合并成一个批次
2. Agent 处理批次时可能调用 `ec config set` 等需要权限的命令
3. 权限判断使用批次的 `batchRole`（commonRole）
4. 如果批次包含不同角色的消息，`batchRole` 为 `undefined`

### 解决方案

**批次提取时强制角色一致性**：
- 只有相同角色的消息才能合并成一个批次
- 遇到不同角色时停止提取，留待下一轮
- 保证每个批次都有明确的权限上下文

### 权限判断逻辑

| 批次场景 | batchRole | 配置修改权限 |
|---------|-----------|-------------|
| 全 owner | owner | ✅ 可修改 |
| 全 admin | admin | ⚠️ 部分可修改 |
| 全 guest | guest | ❌ 不可修改 |
| **混合** | undefined | ❌ 拒绝所有 |

### 安全保证

1. **防止权限提升**：guest 不能借用 owner 的权限
2. **保守策略**：混合角色批次拒绝敏感操作
3. **批次完整性**：相同角色的消息语义相关性更强
4. **审计清晰**：每个批次有明确的操作者身份

---

## 📋 相关实现

### 已实现（代码层）

**位置**：`src/core/message/message-queue.ts`

1. **commonRole() 函数**（第 327-338 行）
   - 计算批次中所有消息的共同角色
   - 角色不一致时返回 `undefined`

2. **canDequeueGroupTimeline() 函数**（第 340-345 行）
   - 检查两条消息是否可以合并到同一批次
   - 包含角色一致性检查

3. **batchRole 传递**（第 656-657 行）
   - 合并批次时计算并设置 `message.batchRole`

### 已接入（权限控制）

**位置**：`src/agents/claude-runner.ts`

**PreToolUse Hook**（第 1278-1306 行）
- 获取 `session.identity.role` 或 `message.batchRole`
- 调用 `authorizeEcCommand()` 进行权限判断
- 已接入：ec msg send、ec group send、ec ctl send/file
- 待接入：ec config set/unset

---

## 🚀 下一步工作

### 1. 实现 ec config 权限控制

将 `ec config` 命令接入 PreToolUse Hook：
- [ ] 创建 `field-permissions.ts` - 字段分类（基础设施/运行时）
- [ ] 实现 `parseEvolclawConfigCommand` - 识别 config 命令
- [ ] 实现 `authorizeEcConfigCommand` - 权限判断
- [ ] 在 PreToolUse Hook 中接入

### 2. 补充测试

- [ ] 测试群聊混合角色批次的拆分
- [ ] 测试权限判断（owner/admin/guest）
- [ ] 测试私聊模式不受影响

### 3. 更新其他文档

考虑更新以下文档以保持一致性：
- `message-flow.md` - 消息流程图
- `data-structures.md` - 数据结构定义
- `README.md` - 概览说明

---

## ✅ 总结

本次更新完善了 dual-session-lite 架构中的**群聊批次角色权限一致性机制**：

1. ✅ 文档化批次提取时的角色一致性约束
2. ✅ 更新 AuxiliaryQueue 和 MainQueue 的 extractBatch() 伪代码
3. ✅ 新增专门章节详细说明设计原理和场景示例
4. ✅ 明确权限矩阵和安全保证

**关键原则**：
- 批次内消息角色必须一致
- 混合角色批次拒绝敏感操作
- 防止权限提升攻击

**实现状态**：
- 文档：✅ 完成
- 代码（message-queue.ts）：✅ 已实现
- 代码（ec config 接入）：⏳ 待实现
