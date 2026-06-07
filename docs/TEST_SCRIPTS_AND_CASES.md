# 测试脚本和用例

## 单元测试

### MessageCache 测试

**文件**：`tests/unit/message-cache.test.ts`

**测试场景**（19个）：
1. 基本功能：添加、获取、清空、计数
2. 边界条件：空字符串、超长消息、特殊字符
3. FIFO 顺序：超过100条时丢弃最旧的
4. 过期清理：1小时后自动清理
5. Unicode/Emoji 支持

### ChannelProxy 测试

**文件**：`tests/unit/channel-proxy.test.ts`

**测试场景**（19个）：
1. 上下文处理：有/无 AsyncLocalStorage 上下文
2. 会话匹配：活跃/非活跃会话
3. 错误处理：SessionManager 失败时的降级
4. 并发操作：多个消息同时发送

### MessageQueue 项目路径测试

**文件**：`tests/unit/message-queue-project.test.ts`

**测试场景**（17个）：
1. 项目路径传递：正确传递到 handler
2. 中断逻辑：同项目才触发中断
3. 路径格式：绝对路径、相对路径、特殊字符
4. 并发队列：多个聊天独立处理

## 集成测试

### 消息缓存集成测试

**文件**：`tests/integration/message-cache.test.ts`

**测试场景**（20个）：
1. 基本缓存：切换项目时缓存消息
2. 消息刷新：切换回来时按顺序输出
3. 文件处理：文件标记的提取和发送
4. 多项目：多个项目同时有缓存
5. 边界条件：空缓存、超长消息、特殊字符
6. 错误场景：文件不存在、发送失败

### 项目上下文隔离测试

**文件**：`tests/integration/project-context-isolation.test.ts`

**测试场景**（4个）：
1. 消息在正确的项目上下文中执行
2. 项目路径在整个处理过程中不变
3. 多项目切换时保持上下文隔离
4. 正确跟踪正在处理的项目

### plist 状态显示测试

**文件**：`tests/integration/plist-status.test.ts`

**测试场景**（7个）：
1. 正确返回正在处理的项目路径
2. 处理完成后返回 undefined
3. 不同项目间切换时正确跟踪
4. 路径规范化（去除尾部斜杠）
5. 正确计算队列长度
6. 正确跟踪未读消息数
7. 多个会话间独立跟踪状态

## Mock 工具

### MockFeishuClient

**文件**：`tests/mock-feishu-client.ts`

**功能**：
- 模拟 Feishu 客户端
- 跟踪发送的消息和文件
- 提供等待工具用于异步测试

**使用示例**：
```typescript
const mockFeishu = new MockFeishuClient();
const adapter: ChannelAdapter = {
  name: 'feishu',
  sendText: (channelId, text) => mockFeishu.sendMessage(channelId, text),
  sendFile: (channelId, filePath) => mockFeishu.sendFile(channelId, filePath)
};

// 测试
await adapter.sendText('chat-1', '测试消息');
expect(mockFeishu.sentMessages).toHaveLength(1);
expect(mockFeishu.sentMessages[0].text).toBe('测试消息');
```

## 运行测试

### 全部测试
```bash
npm test
```

### 单个测试文件
```bash
npm test -- tests/unit/message-cache.test.ts
```

### 监听模式
```bash
npm run test:watch
```

### 覆盖率报告
```bash
npm test -- --coverage
```

## 测试结果

### 总计
- 单元测试：55个
- 集成测试：31个
- 总计：86个
- 通过率：100%

### 覆盖率
- 核心组件：>90%
- 边界条件：完整覆盖
- 错误场景：完整覆盖
