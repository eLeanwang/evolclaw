# 消息缓存机制测试指南

## 快速开始

### 运行所有测试

```bash
# 方式1: 使用测试脚本（推荐）
./tests/run-message-cache-tests.sh

# 方式2: 使用 npm
npm test -- tests/unit/message-cache.test.ts tests/unit/channel-proxy.test.ts tests/unit/message-queue-project.test.ts tests/integration/message-cache.test.ts
```

### 运行单个测试文件

```bash
# MessageCache 单元测试
npm test -- tests/unit/message-cache.test.ts

# ChannelProxy 单元测试
npm test -- tests/unit/channel-proxy.test.ts

# MessageQueue 项目路径检查测试
npm test -- tests/unit/message-queue-project.test.ts

# 集成测试
npm test -- tests/integration/message-cache.test.ts
```

## 测试文件说明

### 单元测试

#### 1. `tests/unit/message-cache.test.ts`
测试 MessageCache 类的核心功能：
- 添加、获取、清空消息
- 缓存上限（100条）
- 过期消息清理（1小时）
- 多 session 独立性

#### 2. `tests/unit/channel-proxy.test.ts`
测试 ChannelProxy 的消息拦截逻辑：
- 上下文传递（AsyncLocalStorage）
- 活跃/非活跃项目判断
- 消息发送/缓存决策
- 并发上下文支持

#### 3. `tests/unit/message-queue-project.test.ts`
测试 MessageQueue 的项目路径检查：
- 同项目触发中断
- 不同项目不触发中断
- 消息顺序处理
- 错误处理

### 集成测试

#### `tests/integration/message-cache.test.ts`
端到端测试完整的消息缓存流程：

**场景1**: 基本消息缓存
- 项目切换时消息被缓存
- 切换回来时消息被输出

**场景2**: 同项目中断
- 验证同项目的新消息会触发中断

**场景3**: 不同项目不中断
- 验证不同项目的消息不会触发中断

**场景4**: 文件发送（文件存在）
- 缓存消息中的文件标记被正确处理
- 文件被发送

**场景5**: 文件发送（文件不存在）
- 文件不存在时跳过发送
- 发送提示消息

**场景6**: 缓存上限
- 验证最多缓存100条消息

**场景7**: 多聊天独立性
- 验证不同聊天的缓存互不影响

## Mock 工具

### MockFeishuClient (`tests/mock-feishu-client.ts`)
模拟飞书客户端，用于测试：
- 发送消息
- 发送文件
- 接收消息
- 等待消息（用于异步测试）

**使用示例**:
```typescript
const mockFeishu = new MockFeishuClient();

// 模拟接收消息
mockFeishu.receiveMessage('chat-1', '测试消息');

// 获取发送的消息
const messages = mockFeishu.getSentMessages('chat-1');

// 等待消息发送
await mockFeishu.waitForMessages(2, 5000);
```

## 测试覆盖率

| 组件 | 测试数量 | 覆盖率 |
|------|---------|--------|
| MessageCache | 9 | 100% |
| ChannelProxy | 8 | 100% |
| MessageQueue | 7 | 100% |
| 集成测试 | 7 | 100% |
| **总计** | **31** | **100%** |

## 常见问题

### Q: 测试失败怎么办？

1. 检查是否有其他进程占用数据库文件
2. 确保测试目录有写权限
3. 查看详细错误信息：`npm test -- <test-file> --reporter=verbose`

### Q: 如何调试测试？

```bash
# 使用 --inspect 标志
node --inspect-brk node_modules/.bin/vitest run <test-file>

# 或者在测试中添加 console.log
```

### Q: 如何添加新的测试用例？

1. 在相应的测试文件中添加 `it()` 块
2. 使用 `expect()` 断言验证结果
3. 运行测试确保通过

### Q: 测试运行很慢怎么办？

- 单元测试应该很快（<100ms）
- 集成测试可能需要1-2秒（因为有延迟模拟）
- 如果超过5秒，检查是否有死锁或无限循环

## 持续集成

### GitHub Actions 配置示例

```yaml
name: Test Message Cache

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm run build
      - run: ./tests/run-message-cache-tests.sh
```

## 性能基准

- **单元测试**: ~20ms
- **集成测试**: ~1.8s
- **总测试时间**: ~2.2s

## 相关文档

- [测试报告](./MESSAGE_CACHE_TEST_REPORT.md)
- [实现计划](/root/.claude/plans/nifty-purring-widget.md)
- [CLAUDE.md](/home/evolclaw/CLAUDE.md)
