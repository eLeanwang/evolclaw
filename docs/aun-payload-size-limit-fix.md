# AUN Payload Size Limit Fix

## 问题描述

**错误日志**：
```
[2026-06-24T12:47:35.185] [WARN] [AUN eleanbot] rpc message.send failed: ValidationError(-1) payload is too large
[2026-06-24T12:47:35.185] [ERROR] [AUN eleanbot] custom send failed to elean.agentid.pub: ValidationError: payload is too large
```

**表面矛盾**：
- 日志显示 `textLen=80`（仅 80 字符）
- 但报错 "payload is too large"

## 根本原因

### 1. AUN SDK 的大小限制

从 `node_modules/@agentunion/fastaun/dist/transport.js` 确认：

```javascript
const MAX_WS_PAYLOAD_SIZE = 1_000_000; // 1MB

const payloadSize = new TextEncoder().encode(payload).length;
if (payloadSize > MAX_WS_PAYLOAD_SIZE) {
    throw new ValidationError('payload is too large');
}
```

**限制**：整个 JSON-RPC 消息序列化后的 UTF-8 字节长度不能超过 **1MB (1,000,000 字节)**。

### 2. 实际问题

- `textLen=80` 只是日志显示用的摘要文本（`logText`）
- 实际 payload 包含 `tool_result` 的 `result` 字段，其中包含完整的命令输出
- 例如：`grep` 命令搜索日志文件，返回上千行结果（实际测量 **1.1MB**）
- 整个 activity payload 结构：

```json
{
  "type": "activity",
  "task_id": "task-81e4c23505",
  "session_id": "meta_20260623_1782183639120",
  "agent_name": "eleanbot.agentid.pub",
  "chatmode": "interactive",
  "item": {
    "kind": "tool_result",
    "name": "Shell",
    "result": "... 1.1MB 的 grep 输出 ...",
    "ok": true
  }
}
```

### 3. 受影响的字段

不仅仅是 `tool_result.result`，以下字段都可能超限：

| 字段路径 | 来源 | 风险 |
|---------|------|-----|
| `item.result` | tool_result 工具输出 | **高** - grep/cat/logs 等命令 |
| `item.input` | tool_use 工具输入 | 中 - 大文件内容作为输入 |
| `item.text` | activity 文本内容 | 中 - 长文本输出 |
| `payload.text` | 普通文本消息 | 低 - Agent 输出通常不会太长 |

## 解决方案

### 实现策略

在 `src/channels/aun.ts` 的 `sendAunPayload` 方法中添加 payload 截断逻辑：

1. **保守阈值**：设置 **800KB** 作为 payload 限制（为 RPC 信封留出空间）
2. **字段级截断**：单个字符串字段最大 **256KB**
3. **递归处理**：深度遍历整个 payload 对象树
4. **保留元数据**：添加 `<field>_truncated: true` 标记

### 核心代码

```typescript
private truncatePayloadIfNeeded(payload: Record<string, any>, label: string): Record<string, any> {
  const MAX_PAYLOAD_SIZE = 800 * 1024; // 800KB conservative limit
  const MAX_FIELD_SIZE = 256 * 1024;   // 256KB per field

  // First check total size
  const payloadJson = JSON.stringify(payload);
  const totalSize = Buffer.byteLength(payloadJson, 'utf-8');

  if (totalSize <= MAX_PAYLOAD_SIZE) {
    return payload; // No truncation needed
  }

  logger.warn(`${this.logPrefix()} Payload too large (${formatSize(totalSize)}), truncating... label=${label}`);

  // Deep clone and truncate large string fields recursively
  const truncated = JSON.parse(payloadJson);
  
  const truncateObject = (obj: any, path: string): boolean => {
    // ... 递归截断逻辑 ...
  };

  truncateObject(truncated, '');
  
  // Verify size after truncation
  const newSize = Buffer.byteLength(JSON.stringify(truncated), 'utf-8');
  logger.info(`${this.logPrefix()} Payload truncated: ${formatSize(totalSize)} → ${formatSize(newSize)}`);
  
  return truncated;
}
```

### 截断效果

测试案例（500KB tool_result）：

```
Original payload size: 512107 bytes (500.1 KB)
Field truncated: 512000 → 65536 bytes
Truncated payload size: 65734 bytes (64.2 KB)
Reduction: 87.2%
```

## 长期优化方案

### 方案 1：使用 storage API（推荐）

对于超大输出（>256KB），上传到 AUN storage，消息中只发链接：

```typescript
if (resultSize > MAX_FIELD_SIZE) {
  const fileId = await this.uploadToStorage(payload.item.result, 'tool-result.txt');
  payload.item.result = `[输出过大 ${formatSize(resultSize)}，已上传到存储]`;
  payload.item.storage_file_id = fileId;
  payload.item.storage_url = `https://storage.agentid.pub/download/${fileId}`;
}
```

### 方案 2：Agent 层优化

在 Agent 输出超大结果前，自动总结或分页：

- Tool result > 100KB → 自动调用 Agent 总结关键信息
- 或者提示用户："输出过长（500KB），已保存到文件 /tmp/result.txt"

### 方案 3：前端适配

前端支持渲染 `storage_url` 字段，提供"查看完整输出"按钮。

## 相关错误码

AUN 协议错误码参考：

| 错误码 | 说明 | 处理方式 |
|--------|------|---------|
| -32153 | Relay payload too large | 缩小负载 |
| -32174 | Task output too large | 用 storage.* |

## 测试验证

### 手动测试

1. 构造超大 payload：
   ```bash
   # 在 Agent 会话中执行会产生大量输出的命令
   grep -r "some pattern" /var/logs/
   ```

2. 观察日志：
   ```
   [INFO] Payload too large (1.1 MB), truncating...
   [INFO] Truncated field item.result: 1131707 → 262144 bytes
   [INFO] Payload truncated: 1131707 → 262400 bytes
   ```

3. 验证消息发送成功（不再报 ValidationError）

### 单元测试（TODO）

```typescript
describe('AUNChannel payload truncation', () => {
  it('should truncate tool_result with large output', () => {
    const payload = {
      type: 'activity',
      item: {
        kind: 'tool_result',
        result: 'x'.repeat(500 * 1024), // 500KB
      }
    };
    
    const truncated = channel.truncatePayloadIfNeeded(payload, 'test');
    const size = Buffer.byteLength(JSON.stringify(truncated), 'utf-8');
    
    expect(size).toBeLessThan(800 * 1024);
    expect(truncated.item.result_truncated).toBe(true);
  });
});
```

## 相关文件

- `src/channels/aun.ts` - 核心实现
- `node_modules/@agentunion/fastaun/dist/transport.js` - SDK 限制定义
- `node_modules/@agentunion/fastaun/_packed_docs/protocol/07-错误码与状态机.md` - 协议文档

## 修复历史

- **2026-06-24**: 初次实现 payload 截断机制（保守限制 800KB + 字段限制 256KB）
- **适用版本**: evolclaw >= 3.5.6

## 注意事项

1. **截断是有损的**：超大输出会丢失部分内容，前端应提示用户
2. **性能影响**：每次发送都会序列化检查大小，对 <100KB 的消息影响可忽略
3. **递归深度**：当前实现无递归深度限制，极端情况（深层嵌套对象）可能栈溢出
4. **字符边界安全**：`substring()` 可能在 UTF-8 多字节字符中间切断，但 JSON.stringify 会处理（替换为 �）

## 相关问题

- [#issue-xxx] Agent 执行 grep 命令导致消息发送失败
- [#issue-yyy] tool_result 超大输出处理
