# EvolClaw 代码审查清单

## 审查流程

### 1. 提交审查请求
- 创建功能分支并推送代码
- 确保代码可以编译（`npm run build`）
- 确保测试通过（`npm test`）
- 填写变更说明

### 2. 审查者检查
- 按照本清单逐项检查
- 在代码中添加评论
- 标记需要修改的地方

### 3. 修改和重审
- 作者根据反馈修改代码
- 重新提交审查
- 审查者确认修改

### 4. 批准合并
- 所有检查项通过
- 至少一位审查者批准
- 合并到主分支

## 通用检查项

### 代码质量

- [ ] 代码遵循项目风格规范（见 DEV_GUIDELINES.md）
- [ ] 变量和函数命名清晰、有意义
- [ ] 没有重复代码（DRY 原则）
- [ ] 函数职责单一，长度合理（<50 行）
- [ ] 复杂逻辑有注释说明
- [ ] 没有被注释掉的代码
- [ ] 没有调试用的 console.log

### 类型安全

- [ ] 函数参数和返回值有类型注解
- [ ] 没有使用 `any` 类型（除非必要）
- [ ] 正确处理 null/undefined
- [ ] 类型转换安全（使用类型守卫）

### 错误处理

- [ ] 所有异步操作有错误处理
- [ ] 错误信息清晰、有帮助
- [ ] 不吞掉错误（catch 后要处理或重新抛出）
- [ ] 使用 logger.error() 记录错误

### 性能

- [ ] 没有不必要的循环或递归
- [ ] 数据库查询使用索引
- [ ] 避免 N+1 查询问题
- [ ] 大数据处理使用流式处理
- [ ] 没有内存泄漏（事件监听器、定时器正确清理）

### 安全

- [ ] 输入验证和清理
- [ ] SQL 查询使用参数化（防止注入）
- [ ] 没有硬编码敏感信息（API key、密码）
- [ ] 文件路径验证（防止路径遍历）

### 测试

- [ ] 新功能有对应的测试用例
- [ ] 测试覆盖率达标
- [ ] 测试用例命名清晰
- [ ] 边界条件和异常情况有测试

### 文档

- [ ] 复杂函数有 JSDoc 注释
- [ ] README 或相关文档已更新
- [ ] API 变更有文档说明
- [ ] 配置变更有说明

## 本次重构专项检查

### Logger 工具

- [ ] 日志等级正确使用（DEBUG/INFO/WARN/ERROR）
- [ ] 文件流正确创建和关闭
- [ ] 环境变量配置正确读取
- [ ] JSONL 格式输出正确
- [ ] 日志目录不存在时自动创建
- [ ] 并发写入安全（使用流而非同步写入）

**示例检查**：
```typescript
// ✅ 正确
const stream = fs.createWriteStream('log.txt', { flags: 'a' });
stream.write('log line\n');

// ❌ 错误（同步写入，性能差）
fs.appendFileSync('log.txt', 'log line\n');
```

### 数据库操作

- [ ] 使用 prepared statements（防止 SQL 注入）
- [ ] 索引正确创建
- [ ] WAL 模式启用
- [ ] 事务使用正确
- [ ] 数据库连接正确关闭

**示例检查**：
```typescript
// ✅ 正确
const stmt = db.prepare('SELECT * FROM table WHERE id = ?');
const result = stmt.get(id);

// ❌ 错误（SQL 注入风险）
const result = db.prepare(`SELECT * FROM table WHERE id = '${id}'`).get();
```

### 消息去重

- [ ] 数据库查询性能优化（使用索引）
- [ ] 清理任务正确启动
- [ ] 清理逻辑正确（24 小时前）
- [ ] 并发消息处理安全
- [ ] 错误处理完整

**示例检查**：
```typescript
// ✅ 检查索引存在
CREATE INDEX idx_processed_at ON processed_messages(processed_at);

// ✅ 检查清理逻辑
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
db.prepare('DELETE FROM processed_messages WHERE processed_at < ?').run(cutoff);
```

### 日志集成

- [ ] 所有 console.log 已替换为 logger.info
- [ ] 所有 console.error 已替换为 logger.error
- [ ] 消息追溯日志完整（received/processing/completed/failed）
- [ ] Hook 事件日志正确记录
- [ ] 日志信息包含必要的上下文（messageId, sessionId）

**示例检查**：
```typescript
// ✅ 正确
logger.message({
  msgId: messageId,
  sessionId: session.id,
  status: 'completed',
  duration: Date.now() - startTime
});

// ❌ 错误（缺少上下文）
logger.message({ status: 'completed' });
```

### 错误处理

- [ ] 错误类型识别正确
- [ ] 错误消息用户友好
- [ ] 错误消息使用中文
- [ ] 包含 ⚠️ emoji 前缀
- [ ] 有默认错误消息

**示例检查**：
```typescript
// ✅ 正确
if (msg.includes('API Error: 429')) {
  return '⚠️ 请求过于频繁，请稍后再试';
}

// ❌ 错误（英文消息，不友好）
if (msg.includes('429')) {
  return 'Rate limit exceeded';
}
```

### 重试机制

- [ ] 重试次数合理（默认 3 次）
- [ ] 退避策略正确（线性或指数）
- [ ] 最后一次失败正确抛出错误
- [ ] 不重试不可恢复的错误（如 400）

**示例检查**：
```typescript
// ✅ 正确
for (let i = 0; i < maxRetries; i++) {
  try {
    return await fn();
  } catch (error) {
    if (i === maxRetries - 1) throw error;
    await sleep((i + 1) * 1000);
  }
}

// ❌ 错误（无限重试）
while (true) {
  try {
    return await fn();
  } catch (error) {
    await sleep(1000);
  }
}
```

### 向后兼容性

- [ ] 数据库表使用 IF NOT EXISTS
- [ ] 新增字段有默认值
- [ ] 配置项有默认值
- [ ] 旧代码可以正常运行

**示例检查**：
```typescript
// ✅ 正确
CREATE TABLE IF NOT EXISTS processed_messages (...);

// ✅ 正确
const logLevel = process.env.LOG_LEVEL || 'INFO';

// ❌ 错误（破坏兼容性）
CREATE TABLE processed_messages (...); // 如果表已存在会报错
```

## 性能检查

### 数据库性能

- [ ] 查询使用索引
- [ ] 避免全表扫描
- [ ] 批量操作使用事务
- [ ] 定期清理旧数据

**性能测试**：
```bash
# 检查查询计划
sqlite3 data/evolclaw.db "EXPLAIN QUERY PLAN SELECT * FROM processed_messages WHERE message_id = 'xxx'"

# 应该显示使用索引
# SEARCH processed_messages USING INDEX sqlite_autoindex_processed_messages_1 (message_id=?)
```

### 日志性能

- [ ] 使用流式写入
- [ ] 避免频繁打开关闭文件
- [ ] 生产环境使用合适的日志等级
- [ ] 大对象不直接序列化到日志

### 内存使用

- [ ] 文件流正确关闭
- [ ] 事件监听器正确移除
- [ ] 定时器正确清理
- [ ] 大数据使用流式处理

## 安全检查

### 输入验证

```typescript
// ✅ 正确
if (!messageId || typeof messageId !== 'string') {
  throw new Error('Invalid message ID');
}

// ❌ 错误（未验证）
processMessage(messageId);
```

### SQL 注入防护

```typescript
// ✅ 正确
db.prepare('SELECT * FROM table WHERE id = ?').get(id);

// ❌ 错误
db.prepare(`SELECT * FROM table WHERE id = '${id}'`).get();
```

### 敏感信息

- [ ] 没有硬编码 API key
- [ ] 没有提交 data/config.json
- [ ] 日志不包含敏感信息
- [ ] 错误消息不泄露内部信息

## 代码示例审查

### 示例 1：Logger 实现

```typescript
// 需要检查的点：
// 1. 文件流是否正确创建
// 2. 日志等级过滤是否正确
// 3. 环境变量是否正确读取
// 4. JSONL 格式是否正确

const streams = {
  main: fs.createWriteStream(path.join(LOG_DIR, 'evolclaw.log'), { flags: 'a' }),
  message: config.messageLog ? fs.createWriteStream(path.join(LOG_DIR, 'messages.log'), { flags: 'a' }) : null,
  event: config.eventLog ? fs.createWriteStream(path.join(LOG_DIR, 'events.log'), { flags: 'a' }) : null
};

// ✅ 检查点：
// - flags: 'a' 表示追加模式
// - 条件创建流（config.messageLog）
// - null 检查（write 函数中）
```

### 示例 2：消息去重

```typescript
// 需要检查的点：
// 1. 查询是否使用索引
// 2. 插入是否使用 OR IGNORE
// 3. 清理逻辑是否正确

private async isDuplicate(messageId: string): Promise<boolean> {
  const result = this.db.prepare(
    'SELECT 1 FROM processed_messages WHERE message_id = ? LIMIT 1'
  ).get(messageId);
  return !!result;
}

// ✅ 检查点：
// - 使用 prepared statement
// - SELECT 1 而非 SELECT *（性能优化）
// - LIMIT 1（只需要知道存在与否）
// - !!result 转换为布尔值
```

### 示例 3：错误处理

```typescript
// 需要检查的点：
// 1. 错误类型识别是否完整
// 2. 错误消息是否用户友好
// 3. 是否有默认消息

export function getErrorMessage(error: any): string {
  const msg = error?.message || String(error);

  if (msg.includes('API Error: 400')) {
    return '⚠️ 请求格式错误，请检查输入内容';
  }
  // ... 其他错误类型

  return '⚠️ 处理消息时出错，请稍后重试';
}

// ✅ 检查点：
// - error?.message 安全访问
// - String(error) 兜底转换
// - 有默认返回值
// - 所有消息包含 ⚠️ 前缀
```

## 审查通过标准

### 必须满足（P0）

- [ ] 代码可以编译
- [ ] 所有测试通过
- [ ] 没有明显的 bug
- [ ] 没有安全漏洞
- [ ] 遵循代码规范

### 应该满足（P1）

- [ ] 测试覆盖率达标
- [ ] 性能符合要求
- [ ] 文档完整
- [ ] 代码可维护性好

### 建议满足（P2）

- [ ] 代码优雅
- [ ] 有适当的注释
- [ ] 考虑了边界情况

## 审查反馈模板

### 需要修改

```
❌ 需要修改

文件：src/utils/logger.ts:45
问题：文件流未正确关闭，可能导致内存泄漏
建议：在进程退出时添加清理逻辑

process.on('exit', () => {
  streams.main.end();
  streams.message?.end();
  streams.event?.end();
});
```

### 建议改进

```
💡 建议改进

文件：src/channels/feishu.ts:120
问题：清理任务间隔可以配置化
建议：从配置文件读取清理间隔

const cleanupInterval = config.cleanupInterval || 60 * 60 * 1000;
setInterval(() => { ... }, cleanupInterval);
```

### 询问

```
❓ 询问

文件：src/utils/retry.ts:30
问题：为什么使用线性退避而非指数退避？
说明：指数退避在高负载场景下表现更好
```

## 常见问题

### Q: 代码风格问题需要拒绝吗？

A: 轻微的风格问题可以标记为"建议改进"，严重的风格问题（影响可读性）应该要求修改。

### Q: 测试覆盖率不达标怎么办？

A: 核心模块必须达标，其他模块可以标记为"建议改进"，但要求后续补充。

### Q: 发现性能问题怎么办？

A: 如果影响用户体验，要求修改。如果是潜在问题，可以创建 Issue 跟踪。

### Q: 审查需要多长时间？

A: 小改动（<100 行）：15-30 分钟
中等改动（100-500 行）：1-2 小时
大改动（>500 行）：2-4 小时

## 参考资源

- [Google Code Review Guidelines](https://google.github.io/eng-practices/review/)
- [Code Review Best Practices](https://github.com/thoughtbot/guides/tree/main/code-review)
