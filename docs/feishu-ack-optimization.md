# Feishu 表情回复优化

## 背景

原有机制：
1. **入队时**：添加 📌 Pin 表情（"已排队"）
2. **开始执行时**：升级为 ✓ CheckMark（"正在处理"）

问题：当队列空闲时（没有正在执行的任务），消息会立即开始处理，导致 Pin → CheckMark 表情快速切换，造成视觉闪烁。

## 优化方案

**条件添加 Pin 表情**：仅在队列繁忙时添加 Pin 表情

```typescript
// message-bridge.ts:242
if (fullMessage.messageId && this.messageQueue.getGlobalProcessingCount() > 0) {
  adapter?.acknowledge?.(fullMessage.messageId).catch(() => {});
}
```

### 优化效果

| 场景 | 队列状态 | 入队表情 | 开始执行表情 | 用户看到 |
|------|---------|---------|-------------|---------|
| **空闲** | processingCount = 0 | ❌ 不添加 | ✓ CheckMark | 直接显示 ✓ |
| **繁忙** | processingCount > 0 | 📌 Pin | ✓ CheckMark | 📌 → ✓ |

### 实现位置

- **判断逻辑**：`src/core/message/message-bridge.ts:242`
- **升级逻辑**：`src/core/message/message-processor.ts:1250`（保持不变）
- **测试文件**：`tests/unit/feishu-ack-optimization.test.ts`

## 技术细节

### 队列计数
使用 `messageQueue.getGlobalProcessingCount()` 判断全局处理中任务数：
- 返回 0：队列空闲，跳过 Pin 表情
- 返回 > 0：队列繁忙，添加 Pin 表情

### 表情升级
无论是否添加过 Pin 表情，开始执行时都会调用 `promoteAckReaction()`：
- 如果有 Pin：删除 Pin，添加 CheckMark
- 如果没有 Pin：直接添加 CheckMark

Feishu 的 `promoteAckReaction` 实现（`src/channels/feishu.ts:1165`）：
```typescript
async promoteAckReaction(messageId: string): Promise<void> {
  // 先加 CheckMark，再删 Pin——用户看到的是 Pin→Pin+CheckMark→CheckMark，无空窗
  this.client.im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: 'CheckMark' } },
  }).catch(() => {});
  const pending = this.pinReactions.get(messageId);
  this.pinReactions.delete(messageId);
  const reactionId = await pending;
  if (reactionId) {
    this.client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => {});
  }
}
```

### 兼容性
- 其他渠道（AUN、WeChat）不受影响（它们使用不同的 ACK 机制）
- 向后兼容：如果 `getGlobalProcessingCount()` 不存在，条件判断会失败，不调用 acknowledge

## 测试覆盖

三个测试场景（`tests/unit/feishu-ack-optimization.test.ts`）：
1. ✅ 队列空闲时不添加 Pin 表情
2. ✅ 队列繁忙时添加 Pin 表情
3. ✅ 没有 messageId 时不调用 acknowledge

## 相关修改

- `src/core/message/message-bridge.ts`：添加 `getGlobalProcessingCount()` 判断
- `tests/unit/message-bridge-command-payload.test.ts`：更新 mock 对象
- `tests/unit/thread-create-denial-silent.test.ts`：更新 mock 对象
- `tests/unit/feishu-ack-optimization.test.ts`：新增专项测试

## 日期

2026-06-23
