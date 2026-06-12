# EvolClaw 开发指南

## TypeScript 代码风格

### 基本规范
- 使用 2 空格缩进
- 使用单引号（字符串）
- 语句末尾使用分号
- 每行最大长度 120 字符

### 命名约定

**变量和函数**：camelCase
```typescript
const messageId = 'xxx';
function processMessage() {}
```

**类和接口**：PascalCase
```typescript
class SessionManager {}
interface AgentConfig {}
```

**常量**：UPPER_SNAKE_CASE
```typescript
const MAX_RETRIES = 3;
const LOG_LEVEL = 'INFO';
```

**文件名**：kebab-case
```
session-manager.ts
error-handler.ts
```

**私有成员**：前缀下划线（可选）
```typescript
private _internalState: any;
```

### 导入规范

**ES Modules**：必须使用 `.js` 扩展名
```typescript
// ✅ 正确
import { logger } from './utils/logger.js';
import { SessionManager } from './core/session-manager.js';

// ❌ 错误
import { logger } from './utils/logger';
import { logger } from './utils/logger.ts';
```

**导入顺序**：
1. Node.js 内置模块
2. 第三方依赖
3. 项目内部模块

```typescript
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { Agent } from '@anthropic-ai/agent-sdk';

import { logger } from './utils/logger.js';
import { SessionManager } from './core/session-manager.js';
```

### 类型注解

**函数参数和返回值**：必须注解
```typescript
function processMessage(messageId: string, content: string): Promise<string> {
  // ...
}
```

**变量**：类型明确时可省略
```typescript
// ✅ 可以省略
const count = 0;
const name = 'test';

// ✅ 需要注解
let result: string | null = null;
const config: Config = loadConfig();
```

### 错误处理

**使用 try-catch**：
```typescript
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  logger.error('Operation failed:', error);
  throw error; // 或返回默认值
}
```

**错误类型检查**：
```typescript
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Error:', message);
}
```

**不要吞掉错误**：
```typescript
// ❌ 错误
try {
  await operation();
} catch (error) {
  // 什么都不做
}

// ✅ 正确
try {
  await operation();
} catch (error) {
  logger.error('Operation failed:', error);
  // 处理或重新抛出
}
```

### 日志使用规范

**使用 logger 工具**：
```typescript
import { logger } from './utils/logger.js';

// 系统运行信息
logger.info('Server started on port 3000');

// 调试信息
logger.debug('Processing message:', messageId);

// 警告信息
logger.warn('Rate limit approaching');

// 错误信息
logger.error('Failed to process message:', error);

// 消息追溯（可选，需要 MESSAGE_LOG=true）
logger.message({
  msgId: 'xxx',
  sessionId: 'yyy',
  status: 'completed'
});

// Hook 事件（可选，需要 EVENT_LOG=true）
logger.event({
  type: 'stop',
  sessionId: 'yyy'
});
```

**日志等级选择**：
- DEBUG：详细的调试信息（开发环境）
- INFO：重要的业务流程信息（生产环境默认）
- WARN：警告信息，不影响功能但需要关注
- ERROR：错误信息，功能受影响

### 异步处理

**优先使用 async/await**：
```typescript
// ✅ 推荐
async function loadData() {
  const data = await fetchData();
  return processData(data);
}

// ❌ 避免
function loadData() {
  return fetchData().then(data => processData(data));
}
```

**并发处理**：
```typescript
// 并发执行
const [result1, result2] = await Promise.all([
  operation1(),
  operation2()
]);

// 串行执行
const result1 = await operation1();
const result2 = await operation2();
```

### 数据库操作

**使用 prepared statements**：
```typescript
// ✅ 正确（防止 SQL 注入）
const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
const result = stmt.get(sessionId);

// ❌ 错误
const result = db.prepare(`SELECT * FROM sessions WHERE id = '${sessionId}'`).get();
```

**事务处理**：
```typescript
const transaction = db.transaction(() => {
  db.prepare('INSERT INTO table1 ...').run();
  db.prepare('UPDATE table2 ...').run();
});

transaction();
```

### 注释规范

**函数注释**：
```typescript
/**
 * 处理消息并返回响应
 * @param messageId 消息 ID
 * @param content 消息内容
 * @returns 处理后的响应文本
 */
async function processMessage(messageId: string, content: string): Promise<string> {
  // ...
}
```

**行内注释**：
```typescript
// 清理 24 小时前的记录
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
```

**TODO 注释**：
```typescript
// TODO: 优化查询性能
// FIXME: 修复边界情况处理
```

## Git 提交规范

### Conventional Commits

**格式**：
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type 类型**：
- `feat`: 新功能
- `fix`: Bug 修复
- `refactor`: 重构（不改变功能）
- `perf`: 性能优化
- `style`: 代码格式调整
- `docs`: 文档更新
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例**：
```
feat(logger): 实现独立日志文件系统

- 添加 evolclaw.log/messages.log/events.log
- 支持环境变量配置
- 实现 JSONL 格式输出

Closes #123
```

```
fix(feishu): 修复消息去重失效问题

将内存 Map 改为数据库持久化存储

Fixes #456
```

### 提交原则

1. **原子性**：每次提交只做一件事
2. **完整性**：提交的代码可以编译和运行
3. **清晰性**：提交信息清楚描述改动内容
4. **可追溯**：关联相关的 Issue 或任务

## 代码审查要点

### 提交前自查

- [ ] 代码可以正常编译（`npm run build`）
- [ ] 所有测试通过（`npm test`）
- [ ] 遵循代码风格规范
- [ ] 添加了必要的注释
- [ ] 更新了相关文档
- [ ] 没有遗留 console.log 调试代码
- [ ] 没有提交敏感信息（API key、密码）

### 审查清单

详见 `docs/CODE_REVIEW_CHECKLIST.md`

## 开发工作流

### 1. 开始新任务

```bash
# 确保在最新代码上工作
git pull origin main

# 创建功能分支
git checkout -b feat/logger-system

# 查看任务详情
# 参考 TaskList 和任务描述
```

### 2. 开发过程

```bash
# 开发模式（热重载）
npm run dev

# 运行测试
npm test

# 检查代码风格
npm run lint  # 如果配置了 ESLint
```

### 3. 提交代码

```bash
# 构建检查
npm run build

# 提交代码
git add .
git commit -m "feat(logger): 实现日志工具模块"

# 推送到远程
git push origin feat/logger-system
```

### 4. 代码审查

- 创建 Pull Request（如果使用 GitHub）
- 或通知团队进行代码审查
- 根据反馈修改代码

### 5. 合并代码

```bash
# 合并到主分支
git checkout main
git merge feat/logger-system

# 删除功能分支
git branch -d feat/logger-system
```

## 性能优化建议

### 数据库查询

- 使用索引优化查询
- 避免 N+1 查询问题
- 使用事务批量操作

### 日志性能

- 生产环境使用 INFO 级别
- 避免在循环中频繁写日志
- 使用流式写入而非同步写入

### 内存管理

- 及时关闭文件流
- 避免内存泄漏（事件监听器、定时器）
- 大数据处理使用流式处理

## 安全注意事项

### 输入验证

```typescript
// 验证用户输入
if (!messageId || typeof messageId !== 'string') {
  throw new Error('Invalid message ID');
}
```

### SQL 注入防护

```typescript
// ✅ 使用参数化查询
db.prepare('SELECT * FROM table WHERE id = ?').get(id);

// ❌ 避免字符串拼接
db.prepare(`SELECT * FROM table WHERE id = '${id}'`).get();
```

### 敏感信息

- 不要在代码中硬编码 API key
- 使用环境变量或配置文件
- 不要提交 `data/config.json` 到 git

## 测试规范

详见 `docs/TEST_GUIDELINES.md`

## 常见问题

### Q: 为什么导入必须使用 .js 扩展名？

A: 项目使用 ES modules（`"type": "module"`），Node.js 要求显式指定扩展名。

### Q: 如何调试代码？

A: 使用 `logger.debug()` 输出调试信息，设置 `LOG_LEVEL=DEBUG` 查看详细日志。

### Q: 数据库文件在哪里？

A: `data/evolclaw.db`（原 `data/sessions.db` 已重命名）

### Q: 如何查看日志？

A:
```bash
# 主日志
tail -f logs/evolclaw.log

# 消息日志（需要 MESSAGE_LOG=true）
tail -f logs/messages.log

# 事件日志（需要 EVENT_LOG=true）
tail -f logs/events.log
```

## 参考资源

- [TypeScript 官方文档](https://www.typescriptlang.org/docs/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Better SQLite3 文档](https://github.com/WiseLibs/better-sqlite3/wiki)
- [Claude Agent SDK 文档](https://github.com/anthropics/anthropic-sdk-typescript)
