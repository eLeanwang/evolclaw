# EvolClaw 测试规范

## 测试策略

### 测试金字塔

```
       /\
      /  \  E2E Tests (10%)
     /----\
    / Unit \ Integration Tests (30%)
   /  Tests \
  /----------\ Unit Tests (60%)
```

### 测试类型

**单元测试**：测试独立的函数和类
- Logger 工具
- Error handler
- Retry 机制
- 数据库操作

**集成测试**：测试模块间交互
- 消息处理流程
- 数据库 + 消息去重
- Logger + 文件系统

**端到端测试**：测试完整业务流程
- 飞书消息接收 → 处理 → 响应
- 项目切换流程
- 错误恢复流程

## 测试覆盖率要求

### 核心模块（>80%）
- `src/utils/logger.ts`
- `src/utils/error-handler.ts`
- `src/utils/retry.ts`
- `src/core/database.ts`
- `src/channels/feishu.ts`（消息去重部分）

### 业务模块（>60%）
- `src/session-manager.ts`
- `src/agent-runner.ts`
- `src/gateway/claude-instance.ts`

### 其他模块（>40%）
- `src/index.ts`
- `src/channels/aun.ts`

## 测试文件组织

### 目录结构

```
tests/
  unit/
    utils/
      logger.test.ts
      error-handler.test.ts
      retry.test.ts
    core/
      database.test.ts
  integration/
    message-processing.test.ts
    message-dedup.test.ts
    logging-system.test.ts
  e2e/
    feishu-flow.test.ts
```

### 命名约定

- 测试文件：`*.test.ts`
- 测试套件：`describe('模块名', () => {})`
- 测试用例：`it('should 做什么', () => {})`

## 测试用例编写规范

### 基本结构（AAA 模式）

```typescript
it('should return error message for API 429 error', () => {
  // Arrange（准备）
  const error = new Error('API Error: 429 rate limit');

  // Act（执行）
  const result = getErrorMessage(error);

  // Assert（断言）
  expect(result).toBe('⚠️ 请求过于频繁，请稍后再试');
});
```

### 异步测试

```typescript
it('should retry 3 times on failure', async () => {
  let attempts = 0;
  const fn = async () => {
    attempts++;
    if (attempts < 3) throw new Error('Temporary failure');
    return 'success';
  };

  const result = await simpleRetry(fn, 3);

  expect(result).toBe('success');
  expect(attempts).toBe(3);
});
```

### Mock 和 Stub

```typescript
import { jest } from '@jest/globals';

it('should log to file stream', () => {
  // Mock 文件流
  const mockStream = {
    write: jest.fn()
  };

  logger.info('test message');

  expect(mockStream.write).toHaveBeenCalledWith(
    expect.stringContaining('[INFO] test message')
  );
});
```

### 数据库测试

```typescript
import Database from 'better-sqlite3';

describe('processed_messages table', () => {
  let db: Database.Database;

  beforeEach(() => {
    // 使用内存数据库
    db = new Database(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should insert and query message', () => {
    db.prepare(
      'INSERT INTO processed_messages (message_id, channel, channel_id, processed_at) VALUES (?, ?, ?, ?)'
    ).run('msg1', 'feishu', 'chat1', Date.now());

    const result = db.prepare(
      'SELECT * FROM processed_messages WHERE message_id = ?'
    ).get('msg1');

    expect(result).toBeDefined();
    expect(result.message_id).toBe('msg1');
  });
});
```

## 本次重构专项测试清单

### 1. Logger 工具测试

**测试文件**：`tests/unit/utils/logger.test.ts`

- [ ] 日志等级过滤（DEBUG/INFO/WARN/ERROR）
- [ ] 主日志文件写入（evolclaw.log）
- [ ] 消息日志文件写入（messages.log）
- [ ] 事件日志文件写入（events.log）
- [ ] 环境变量配置（LOG_LEVEL/MESSAGE_LOG/EVENT_LOG）
- [ ] 日志格式正确（时间戳、等级、内容）
- [ ] JSONL 格式输出（messages/events）
- [ ] 文件流正确关闭

### 2. 消息去重测试

**测试文件**：`tests/integration/message-dedup.test.ts`

- [ ] 首次消息正常处理
- [ ] 重复消息被过滤
- [ ] 数据库持久化（重启后仍有效）
- [ ] 24 小时后自动清理
- [ ] 并发消息处理
- [ ] 不同 channel 的消息独立

### 3. 错误处理测试

**测试文件**：`tests/unit/utils/error-handler.test.ts`

- [ ] API 400 错误识别
- [ ] API 500 错误识别
- [ ] API 429 错误识别
- [ ] Timeout 错误识别
- [ ] Permission 错误识别
- [ ] 默认错误消息
- [ ] 错误消息格式（包含 ⚠️）

### 4. 重试机制测试

**测试文件**：`tests/unit/utils/retry.test.ts`

- [ ] 首次成功无重试
- [ ] 临时失败后重试成功
- [ ] 达到最大重试次数后失败
- [ ] 重试间隔正确（1s, 2s, 3s）
- [ ] 异常正确抛出

### 5. 数据库测试

**测试文件**：`tests/unit/core/database.test.ts`

- [ ] processed_messages 表创建
- [ ] 索引创建
- [ ] WAL 模式启用
- [ ] 插入记录
- [ ] 查询记录
- [ ] 删除旧记录

### 6. 日志集成测试

**测试文件**：`tests/integration/logging-system.test.ts`

- [ ] 消息处理流程日志完整
- [ ] Hook 事件日志记录
- [ ] 错误日志记录
- [ ] 日志文件轮转（模拟大文件）
- [ ] 多线程写入安全

### 7. 端到端测试

**测试文件**：`tests/e2e/message-flow.test.ts`

- [ ] 完整消息处理流程
- [ ] 错误恢复流程
- [ ] 重启后状态恢复
- [ ] 性能测试（消息处理时间）

## 测试工具和框架

### 推荐工具

- **测试框架**：Jest 或 Vitest
- **断言库**：内置 expect
- **Mock 库**：jest.fn() 或 vi.fn()
- **覆盖率**：c8 或 istanbul

### 配置示例（Vitest）

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'c8',
      reporter: ['text', 'html'],
      exclude: ['tests/**', 'dist/**']
    }
  }
});
```

## 测试命令

```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm test -- logger.test.ts

# 监听模式
npm run test:watch

# 生成覆盖率报告
npm test -- --coverage

# 运行集成测试
npm test -- tests/integration

# 运行 E2E 测试
npm test -- tests/e2e
```

## 测试数据管理

### 测试数据库

```typescript
// 使用内存数据库
const testDb = new Database(':memory:');

// 或使用临时文件
const testDb = new Database('test.db');
afterAll(() => {
  testDb.close();
  fs.unlinkSync('test.db');
});
```

### 测试日志

```typescript
// 重定向到临时目录
process.env.LOG_DIR = 'tests/tmp/logs';

afterAll(() => {
  // 清理测试日志
  fs.rmSync('tests/tmp', { recursive: true });
});
```

### Mock 数据

```typescript
// tests/fixtures/messages.ts
export const mockMessages = {
  valid: {
    messageId: 'msg_123',
    senderId: 'user_456',
    content: 'Hello'
  },
  duplicate: {
    messageId: 'msg_123', // 相同 ID
    senderId: 'user_456',
    content: 'Hello again'
  }
};
```

## 性能测试

### 响应时间测试

```typescript
it('should process message within 5 seconds', async () => {
  const start = Date.now();

  await processMessage('msg1', 'test content');

  const duration = Date.now() - start;
  expect(duration).toBeLessThan(5000);
});
```

### 并发测试

```typescript
it('should handle 10 concurrent messages', async () => {
  const promises = Array.from({ length: 10 }, (_, i) =>
    processMessage(`msg_${i}`, 'test')
  );

  const results = await Promise.all(promises);

  expect(results).toHaveLength(10);
  expect(results.every(r => r !== null)).toBe(true);
});
```

### 内存泄漏测试

```typescript
it('should not leak memory after 1000 messages', async () => {
  const initialMemory = process.memoryUsage().heapUsed;

  for (let i = 0; i < 1000; i++) {
    await processMessage(`msg_${i}`, 'test');
  }

  global.gc(); // 需要 --expose-gc 标志
  const finalMemory = process.memoryUsage().heapUsed;

  const increase = finalMemory - initialMemory;
  expect(increase).toBeLessThan(10 * 1024 * 1024); // 10MB
});
```

## 测试最佳实践

### DO（推荐）

✅ 测试用例独立，不依赖执行顺序
✅ 使用描述性的测试名称
✅ 每个测试只验证一个行为
✅ 使用 beforeEach/afterEach 清理状态
✅ Mock 外部依赖（网络、文件系统）
✅ 测试边界条件和异常情况
✅ 保持测试代码简洁

### DON'T（避免）

❌ 测试实现细节而非行为
❌ 过度 Mock 导致测试无意义
❌ 测试用例之间共享状态
❌ 忽略异步测试的 await
❌ 测试覆盖率作为唯一目标
❌ 复制粘贴测试代码

## 持续集成

### GitHub Actions 示例

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: codecov/codecov-action@v3
```

## 测试报告

### 生成测试报告

```bash
# HTML 报告
npm test -- --coverage --reporter=html

# JSON 报告
npm test -- --coverage --reporter=json

# 查看报告
open coverage/index.html
```

### 报告内容

- 测试通过率
- 代码覆盖率（行、分支、函数、语句）
- 失败用例详情
- 性能指标

## 调试测试

### 使用 console.log

```typescript
it('should work', () => {
  console.log('Debug info:', someValue);
  expect(someValue).toBe(expected);
});
```

### 使用调试器

```bash
# Node.js 调试器
node --inspect-brk node_modules/.bin/vitest

# VS Code 调试配置
{
  "type": "node",
  "request": "launch",
  "name": "Debug Tests",
  "program": "${workspaceFolder}/node_modules/.bin/vitest",
  "args": ["--run"]
}
```

## 测试检查清单

提交代码前确认：

- [ ] 所有测试通过
- [ ] 新代码有对应测试
- [ ] 测试覆盖率达标
- [ ] 没有跳过的测试（skip/todo）
- [ ] 测试用例命名清晰
- [ ] 清理了测试数据和临时文件
- [ ] 测试在 CI 环境可以运行

## 参考资源

- [Vitest 文档](https://vitest.dev/)
- [Jest 文档](https://jestjs.io/)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
