# 需求1：消息缓存方案

## 需求描述

任务中切换项目，原项目数据缓存不再输出，切换回去时增加累计消息条数提示，1秒后按顺序输出。

## 方案设计

### 核心机制

**消息缓存**：
- 当用户切换到其他项目时，原项目的 Agent 输出消息不直接发送，而是缓存
- 当用户切换回原项目时，显示缓存消息数量，1秒后按顺序输出

### 架构设计

**两层机制**：
1. **StreamFlusher**：批量发送工具活动（3秒窗口）
2. **MessageCache**：跨项目消息缓存（切换项目时）

### 关键组件

#### 1. MessageCache（消息缓存）

**文件**：`src/core/message-cache.ts`

**功能**：
- 按 sessionId 组织缓存消息
- FIFO 队列，最多100条
- 1小时过期自动清理

**接口**：
```typescript
class MessageCache {
  add(sessionId: string, text: string): void
  getAll(sessionId: string): CachedMessage[]
  clear(sessionId: string): void
  getCount(sessionId: string): number
  hasMessages(sessionId: string): boolean
  cleanupExpired(): void
}
```

#### 2. ChannelProxy（通道代理）

**文件**：`src/core/channel-proxy.ts`

**功能**：
- 拦截消息发送
- 判断是否为活跃项目
- 活跃项目直接发送，非活跃项目缓存

**核心逻辑**：
```typescript
async sendText(channelId: string, text: string): Promise<void> {
  const context = asyncLocalStorage.getStore();
  const currentSessionId = context?.sessionId;

  const activeSession = await sessionManager.getOrCreateSession(...);

  if (activeSession.id === currentSessionId) {
    await channel.sendText(channelId, text);  // 直接发送
  } else {
    messageCache.add(currentSessionId, text);  // 缓存
  }
}
```

#### 3. AsyncLocalStorage（上下文传递）

**用途**：
- 在消息处理过程中传递 sessionId
- 避免修改函数签名

**使用**：
```typescript
await asyncLocalStorage.run({ sessionId: session.id }, async () => {
  // 处理消息
});
```

### 消息刷新机制

**触发时机**：
- 用户执行 `/switch` 命令切换回项目
- 用户执行 `/bind` 命令绑定项目

**刷新流程**：
1. 检查缓存消息数量
2. 显示提示："有 N 条新消息"
3. 延迟1秒后按顺序输出
4. 处理文件标记（如果有）
5. 清空缓存

**文件处理**：
- 缓存时不处理文件标记
- 刷新时检查文件是否存在
- 存在则发送，不存在则提示"文件已不存在"

### /restart 命令增强

**功能**：
- 检查所有项目是否有未读消息
- 如果有，提示用户并要求二次确认
- 10秒内再次执行 `/restart` 才真正重启

**提示格式**：
```
项目A 有 3 条新消息
项目B 有 5 条新消息
再次输入 /restart 将强制重启。
```

## 配置策略

### 1. 缓存上限
- 每个 session 最多 100 条消息
- 超过后丢弃最旧的消息（FIFO）

### 2. 文件处理
- 缓存时不处理文件标记
- 发送时检查文件是否存在
- 不存在则发送提示消息："⚠️ 文件已不存在：{filePath}"

### 3. 过期清理
- 消息缓存1小时后自动过期
- 每小时执行一次清理

## 实现要点

### 1. 上下文传递
使用 AsyncLocalStorage 传递 sessionId，避免修改大量函数签名。

### 2. 通道包装
使用 ChannelProxy 包装原始 Channel，拦截消息发送。

### 3. 文件标记处理
在刷新缓存消息时，提取文件标记并处理：
- 解析相对路径为绝对路径
- 检查文件是否存在
- 发送文件或提示消息

### 4. 错误处理
- SessionManager 查询失败时，直接发送消息（不缓存）
- 文件发送失败时，继续处理其他消息
- 缓存清理失败时，记录日志但不影响主流程

## 测试要点

### 单元测试
- MessageCache 的基本功能
- ChannelProxy 的拦截逻辑
- 边界条件（空消息、超长消息、特殊字符）

### 集成测试
- 项目切换时的消息缓存
- 切换回来时的消息刷新
- 文件标记的处理
- /restart 命令的未读消息检查

## 注意事项

1. **不要在命令响应中使用 ChannelProxy**
   - 命令响应应该直接发送，不经过缓存
   - 通过检查 AsyncLocalStorage 上下文来判断

2. **文件路径解析**
   - 相对路径需要基于项目路径解析
   - 绝对路径直接使用

3. **缓存清理**
   - 定期清理过期消息
   - 避免内存泄漏

4. **并发安全**
   - JavaScript 单线程，无需额外锁
   - 但要注意异步操作的顺序
