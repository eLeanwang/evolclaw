# 需求2：plist 显示会话状态和新消息

## 需求描述

plist 命令显示：
1. 是否有会话
2. 是否正在执行任务
3. 有多少条未读消息

## 方案设计

### 核心机制

**分散查询**：
- MessageQueue 负责跟踪"是否正在处理"
- MessageCache 负责跟踪"未读消息数"
- SessionManager 负责会话管理
- `/plist` 命令组装这些信息

### 架构优势

**职责清晰**：
- 各组件只负责自己的状态
- 无需跨组件回调
- 易于测试和维护

### 关键实现

#### 1. MessageQueue 增加查询接口

**方法**：`getProcessingProject(sessionKey: string): string | undefined`

**实现**：
```typescript
getProcessingProject(sessionKey: string): string | undefined {
  return this.currentMessages.get(sessionKey)?.projectPath;
}
```

**说明**：
- 利用现有的 `currentMessages` Map
- 返回当前正在处理的项目路径
- 处理完成后自动返回 `undefined`

#### 2. 路径规范化

**问题**：路径格式不一致导致匹配失败
- 配置：`/home/project`
- 实际：`/home/project/`

**解决**：
```typescript
const normalizePath = (p: string) => p.replace(/\/+$/, '');
```

#### 3. /plist 命令实现

**核心逻辑**：
```typescript
if (content === '/plist') {
  const projects = config.projects?.list || {};
  const lines = ['可用项目:'];
  const sessionKey = `${channel}-${channelId}`;
  const processingProject = messageQueue.getProcessingProject(sessionKey);
  const queueLength = messageQueue.getQueueLength(sessionKey);

  const normalizePath = (p: string) => p.replace(/\/+$/, '');

  for (const [name, projectPath] of Object.entries(projects)) {
    const isCurrent = session.projectPath === projectPath;
    const prefix = isCurrent ? '  ✓' : '   ';

    const projectSession = await sessionManager.getSessionByProjectPath(
      channel, channelId, projectPath
    );

    if (!projectSession) {
      lines.push(`${prefix} ${name} (${projectPath}) - 无会话`);
      continue;
    }

    const statusParts = [];

    // 活跃状态或空闲时间
    if (isCurrent) {
      statusParts.push('活跃');
    } else {
      const idleMs = Date.now() - projectSession.updatedAt;
      statusParts.push(formatIdleTime(idleMs));
    }

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

    lines.push(`${prefix} ${name} (${projectPath}) - ${statusParts.join(' ')}`);
  }
  return lines.join('\n');
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

### 场景2：其他项目正在处理
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

## 状态说明

### 队列N条（输入消息，未处理）
- **含义**：用户发送的消息，还在排队等待处理
- **位置**：MessageQueue 中
- **状态**：还未被 Agent 处理

### N条新消息（输出消息，已缓存）
- **含义**：Agent 已经处理完并输出的消息，但用户切换项目了，所以被缓存
- **位置**：MessageCache 中
- **状态**：已处理完成，等待用户查看

### 关键区别
- 队列消息：输入（用户→Agent），未处理
- 缓存消息：输出（Agent→用户），已处理

## 实现要点

### 1. 状态查询
- 从 MessageQueue 查询正在处理的项目
- 从 MessageCache 查询未读消息数
- 从 SessionManager 查询会话信息

### 2. 路径规范化
- 去除尾部斜杠
- 确保路径匹配准确

### 3. 状态优先级
- 处理中 > 未读消息 > 空闲
- 可以同时显示"处理中"和"未读消息"
- 只在无任务且无消息时显示"空闲"

## 测试要点

### 单元测试
- MessageQueue.getProcessingProject() 返回正确的项目路径
- 路径规范化函数正确处理各种格式
- 队列长度计算正确

### 集成测试
- 不同项目的处理状态显示正确
- 未读消息数显示正确
- 多项目切换时状态更新正确

## 注意事项

1. **MessageQueue 是按聊天组织的**
   - 同一个聊天只有一个队列
   - 所以"处理中"状态只能显示一个项目

2. **未读消息是按会话组织的**
   - 每个项目会话有独立的缓存
   - 可以同时有多个项目有未读消息

3. **性能考虑**
   - 每次 `/plist` 需要查询所有项目的会话
   - 如果项目很多（>100个），可能有延迟
   - 通常项目数 < 10个，可以接受
