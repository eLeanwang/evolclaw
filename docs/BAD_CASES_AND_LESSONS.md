# 失败案例和问题记录（Bad Cases）

## 严重问题：项目上下文隔离Bug

### 问题描述

**现象**：
- 用户在项目A发送消息后切换到项目B
- 再在项目B发送消息
- 结果项目B的消息在项目A的上下文中执行

**影响**：
- 消息在错误的项目中执行
- 文件操作可能影响错误的项目
- 用户体验严重受损

### 根本原因

**MessageQueue 的设计问题**：
- MessageQueue 按 `sessionKey = ${channel}-${channelId}` 组织（聊天级别）
- 同一个聊天只有一个队列
- 入队时记录 `projectPath`，但不传递给消息处理器

**MessageProcessor 的问题**：
- `resolveSession()` 调用 `getOrCreateSession()`
- 返回**当前活跃项目**的会话
- 不使用消息入队时的 `projectPath`

**Bug流程**：
```
1. 用户在 molbox 发送消息
   → 入队：enqueue('feishu-chat-1', message, '/home/molbox')

2. 用户切换回 openclaw
   → 活跃项目变为 openclaw

3. openclaw 任务完成，处理下一条消息（molbox 的消息）
   → resolveSession() 调用 getOrCreateSession()
   → 返回当前活跃项目：openclaw
   → 消息在 openclaw 上下文中执行 ❌
```

### 失败的修复方案

#### 方案1：使用 getOrCreateSessionWithoutActivating()

**思路**：
- 创建不改变活跃状态的方法
- 消息处理时不影响当前活跃项目

**实现**：
```typescript
async getOrCreateSessionWithoutActivating(
  channel: 'feishu' | 'aun',
  channelId: string,
  projectPath: string
): Promise<Session> {
  // 查找或创建会话，但 is_active = 0
  ...
}
```

**失败原因**：
- 创建的会话 `isActive = false`
- 导致所有消息都无法处理
- Claude Code 进程崩溃（exit code 1）

**教训**：
- 会话的活跃状态可能被其他组件依赖
- 不能随意改变会话状态的语义

#### 方案2：频繁切换活跃项目

**思路**：
- 使用 `message.projectPath` 解析会话
- 但仍使用 `getOrCreateSession()`（会激活会话）

**实现**：
```typescript
const projectPath = message.projectPath || ...;
const session = await sessionManager.getOrCreateSession(
  message.channel,
  message.channelId,
  projectPath
);
```

**问题**：
- 处理项目A的消息时，激活项目A的会话
- 如果用户已切换到项目B，会导致活跃项目频繁切换
- 可能影响用户体验和其他功能

**状态**：
- 基本功能可以工作
- 但有副作用，不是最优方案

### 正确的修复方案

**核心思路**：
- Message 增加 `projectPath` 字段
- MessageQueue 将 `projectPath` 附加到消息
- MessageProcessor 使用 `message.projectPath` 解析会话
- 但需要处理好会话状态的问题

**关键点**：
1. 消息携带项目上下文
2. 处理时使用消息的项目路径，而不是当前活跃项目
3. 需要权衡会话状态的影响

## 系统崩溃问题

### 问题描述

**现象**：
- 所有消息都导致 Claude Code 进程崩溃
- 错误：`Claude Code process exited with code 1`
- 即使简单的"你好"也崩溃

### 可能原因

1. **会话状态问题**
   - 使用 `isActive = false` 的会话
   - 某些组件依赖活跃会话

2. **导入路径错误**
   - 备份恢复后导入路径不一致
   - 编译通过但运行时找不到模块

3. **文件缺失**
   - 新增的文件（MessageCache, ChannelProxy）
   - 但依赖的方法不存在

### 解决方法

**恢复备份**：
1. 使用最近的可工作备份（01:27）
2. 删除新增的文件
3. 重新编译和启动

**教训**：
- 大规模修改前要做好备份
- 逐步添加功能，每次都测试
- 不要一次性修改太多文件

## 路径匹配问题

### 问题描述

**现象**：
- 路径格式不一致导致匹配失败
- 配置：`/home/project`
- 实际：`/home/project/`

### 解决方案

**路径规范化**：
```typescript
const normalizePath = (p: string) => p.replace(/\/+$/, '');
```

**应用场景**：
- 比较项目路径时
- 检查是否正在处理某个项目时

## 测试问题

### 问题1：Integration Test 路径问题

**现象**：
- 测试文件导入路径错误
- `../src/` 应该是 `../../src/`

**解决**：
- 检查测试文件的目录结构
- 使用正确的相对路径

### 问题2：Mock 设置时序问题

**现象**：
- Mock 设置在 enqueue 之后
- 导致 interrupt 没有被捕获

**解决**：
- 在 enqueue 之前设置 mock
- 确保回调已注册

### 问题3：错误期望不正确

**现象**：
- 期望缓存被清空，但实际不会
- 发送失败时缓存应该保留

**解决**：
- 理解正确的业务逻辑
- 修改测试期望

## 设计问题

### 问题1：职责不清

**错误做法**：
- 在 SessionManager 中维护处理状态
- 需要跨组件回调

**正确做法**：
- 各组件只负责自己的状态
- 通过查询接口组装信息

### 问题2：过度设计

**错误做法**：
- 创建复杂的状态同步机制
- 增加系统复杂度

**正确做法**：
- 利用现有数据结构
- 简单的查询接口

## 总结

### 关键教训

1. **大规模修改要谨慎**
   - 做好备份
   - 逐步添加功能
   - 每次都测试

2. **理解现有架构**
   - 不要随意改变组件的语义
   - 理解依赖关系

3. **简单优于复杂**
   - 优先使用简单方案
   - 避免过度设计

4. **测试很重要**
   - 单元测试覆盖核心逻辑
   - 集成测试覆盖关键场景
   - 边界条件和错误场景

5. **会话状态很关键**
   - 可能被多个组件依赖
   - 不能随意修改

### 避免重走弯路

1. **不要使用 getOrCreateSessionWithoutActivating()**
   - 会导致系统崩溃
   - 会话状态有隐含依赖

2. **路径比较前要规范化**
   - 去除尾部斜杠
   - 确保匹配准确

3. **测试要覆盖边界条件**
   - 空值、特殊字符、超长内容
   - 错误场景和降级处理

4. **Mock 要在使用前设置**
   - 注意时序问题
   - 确保回调已注册
