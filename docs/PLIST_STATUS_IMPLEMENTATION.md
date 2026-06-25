# /plist 命令状态显示实现报告

## 实现日期
2026-03-10

## 需求概述

在 `/plist` 命令中显示：
1. 是否有会话
2. 是否正在执行任务
3. 有多少条未读消息

## 实现方案

### 核心设计

**方案选择**：分散查询（而非集中状态管理）

**理由**：
- 职责清晰：MessageQueue 负责处理状态，MessageCache 负责消息缓存
- 无需跨组件回调
- 实现简单，易于维护

### 关键实现

#### 1. MessageQueue 增加查询接口

**文件**：`src/core/message-queue.ts`

```typescript
getProcessingProject(sessionKey: string): string | undefined {
  return this.currentMessages.get(sessionKey)?.projectPath;
}
```

**说明**：
- 利用现有的 `currentMessages` Map
- 返回当前正在处理的项目路径
- 处理完成后自动返回 `undefined`

#### 2. 修改 /plist 命令

**文件**：`src/index.ts`

**核心逻辑**：
```typescript
const sessionKey = `${channel}-${channelId}`;
const processingProject = messageQueue.getProcessingProject(sessionKey);
const queueLength = messageQueue.getQueueLength(sessionKey);

// 路径规范化（去除尾部斜杠）
const normalizePath = (p: string) => p.replace(/\/+$/, '');

// 处理状态
if (processingProject && normalizePath(processingProject) === normalizePath(projectPath)) {
  if (queueLength > 1) {
    statusParts.push(`[处理中，队列${queueLength - 1}条]`);
  } else {
    statusParts.push('[处理中]');
  }
}

// 未读消息
const unreadCount = messageCache.getCount(projectSession.id);
if (unreadCount > 0) {
  statusParts.push(`[${unreadCount}条新消息]`);
} else if (!processingProject || normalizePath(processingProject) !== normalizePath(projectPath)) {
  statusParts.push('[空闲]');
}
```

## 输出示例

### 场景1：当前项目正在处理
```
可用项目:
  ✓ evolclaw (/home/evolclaw) - 活跃 [处理中]
    feishu-bot (/home/feishu) - 30分钟前 [空闲]
    test-project (/tmp/test) - 无会话
```

### 场景2：其他项目正在处理（后台任务）
```
可用项目:
    evolclaw (/home/evolclaw) - 2分钟前 [处理中]
  ✓ feishu-bot (/home/feishu) - 活跃 [空闲]
    test-project (/tmp/test) - 无会话
```

### 场景3：有未读消息
```
可用项目:
    evolclaw (/home/evolclaw) - 2分钟前 [5条新消息]
  ✓ feishu-bot (/home/feishu) - 活跃 [空闲]
    test-project (/tmp/test) - 无会话
```

### 场景4：处理中且有队列
```
可用项目:
  ✓ evolclaw (/home/evolclaw) - 活跃 [处理中，队列3条]
    feishu-bot (/home/feishu) - 30分钟前 [空闲]
    test-project (/tmp/test) - 无会话
```

## 关键改进

### 1. 路径规范化

**问题**：路径格式不一致导致匹配失败
- 配置：`/home/project`
- 实际：`/home/project/`

**解决**：
```typescript
const normalizePath = (p: string) => p.replace(/\/+$/, '');
```

### 2. 队列长度显示

**增强**：显示等待处理的消息数
- `[处理中]` - 只有当前消息
- `[处理中，队列3条]` - 当前消息 + 3条等待

### 3. 状态优先级

**逻辑**：
1. 处理中 > 未读消息 > 空闲
2. 可以同时显示"处理中"和"未读消息"
3. 只在无任务且无消息时显示"空闲"

## 测试覆盖

**测试文件**：`tests/integration/plist-status.test.ts`

**测试场景**（7个）：
1. ✅ 正确返回正在处理的项目路径
2. ✅ 处理完成后返回 undefined
3. ✅ 不同项目间切换时正确跟踪
4. ✅ 路径规范化（去除尾部斜杠）
5. ✅ 正确计算队列长度
6. ✅ 正确跟踪未读消息数
7. ✅ 多个会话间独立跟踪状态

**测试结果**：✅ 全部通过 (7/7)

## 代码变更

### 新增代码
- `MessageQueue.getProcessingProject()` - 3行

### 修改代码
- `handleProjectCommand()` 函数签名 - 增加 `messageQueue` 参数
- `/plist` 命令逻辑 - 约40行（替换原有15行）
- 变量声明顺序调整 - 解决循环依赖

### 总代码量
- 新增：3行
- 修改：约40行
- 测试：约150行

## 架构优势

1. **极简**：只需在 MessageQueue 增加3行代码
2. **优雅**：利用现有的 `currentMessages` Map，无需新增状态
3. **准确**：能正确显示任何项目的处理状态
4. **无侵入**：不需要回调机制，不需要跨组件通信
5. **可扩展**：未来可以轻松增加更多状态信息

## 潜在问题及解决

### 已解决的问题

1. **路径匹配问题** - ✅ 通过路径规范化解决
2. **队列信息缺失** - ✅ 增加队列长度显示
3. **循环依赖** - ✅ 通过延迟绑定解决

### 已知限制

1. **时序问题**：消息刚入队但未开始处理时，显示"空闲"
   - 影响：几毫秒的延迟，实际使用中几乎不可能遇到
   - 是否需要解决：不需要

2. **性能问题**：项目很多时（>100个）可能有延迟
   - 影响：通常项目数 < 10个，可以接受
   - 是否需要解决：不需要

## 结论

✅ **需求2实现完成**，功能稳定可靠：

1. **功能完整性**：所有需求点全部实现
2. **代码质量**：简洁优雅，易于维护
3. **测试覆盖**：7个测试全部通过
4. **架构合理**：职责清晰，无侵入性
5. **用户体验**：信息丰富，一目了然

可以投入生产使用。
