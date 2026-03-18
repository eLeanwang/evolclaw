# 多项目并行执行实施方案

## 一、核心问题

**现状**：
- 用户在项目A执行任务时，切换到项目B会导致项目A任务中断
- `/pwd`、`/plist`、`/status` 等命令在任务执行中切换项目后可能报错
- 必须 `/new` 才能恢复

**根本原因**：
1. MessageQueue 按 `${channel}-${channelId}` 排队，同一聊天会话只能串行处理
2. SessionManager 的 `is_active` 标志，每个 channelId 只能有一个活跃会话
3. 切换项目时会将旧会话设为 `is_active=0`，但 AgentRunner 中的任务仍在执行
4. 数据库状态与内存状态不一致

## 二、目标

1. **切换项目时原任务继续执行** - 不中断后台任务
2. **多项目可以并行执行** - 不同项目的任务互不干扰
3. **后台任务输出最小化** - 只通知关键事件（完成、错误）
4. **前台体验不受影响** - 当前项目的输出正常显示
5. **状态可见** - 通过 `/plist` 可以看到各项目状态

## 三、设计决策

### 决策 1：队列模型
- **从**：按聊天会话排队 `${channel}-${channelId}`
- **到**：按项目会话排队 `${channel}-${channelId}-${projectPathHash}`
- **效果**：不同项目的消息可以并行处理

### 决策 2：输出策略
- **前台项目**（is_active=1）：所有输出直接发送到聊天窗口
- **后台项目**（is_active=0 但任务执行中）：
  - 中间过程输出：丢弃（不缓存、不发送）
  - 关键事件（完成、错误）：缓存 + 发送简短通知
- **切换回项目时**：显示缓存的关键事件

### 决策 3：关键事件定义
- **任务完成**：SDK 返回 `event.type === 'result' && event.subtype === 'success'`
- **任务出错**：SDK 返回 `event.type === 'result' && event.is_error === true`
- **无需用户确认**：当前代码的 `canUseTool` 只返回 allow/deny，不需要用户介入

### 决策 4：会话状态管理
- **保持 is_active 机制**：每个 channelId 仍然只有一个活跃会话
- **后台任务继续执行**：切换项目时不中断旧任务，只是改变输出方式
- **不引入新的状态字段**：避免数据库结构变更

## 四、核心组件改造

### 组件 1：MessageCache（新建）

**职责**：
- 缓存后台任务的关键事件（完成、错误）
- 提供查询、清理接口

**数据结构**：
- `Map<sessionId, CachedEvent[]>`
- `CachedEvent`: `{ type: 'completed' | 'error', message: string, timestamp: number, metadata?: {...} }`

**关键方法**：
- `addEvent(sessionId, event)` - 添加事件
- `getEvents(sessionId)` - 获取事件列表
- `getCount(sessionId)` - 获取事件数量
- `hasMessages(sessionId)` - 是否有缓存事件
- `clearEvents(sessionId)` - 清空事件
- `cleanupExpired(maxAge)` - 清理过期事件（默认 72 小时）

**持久化**：
- 初期：内存存储（重启丢失）
- 后续：可扩展为 SQLite 存储

### 组件 2：MessageQueue（改造）

**改动点**：
- `enqueue` 方法增加 `projectPath` 参数
- 内部队列 key 从 `sessionKey` 改为 `${sessionKey}-${projectPathHash}`
- 添加 `getProcessingProject(sessionKey)` 方法，返回正在处理的项目路径

**队列隔离**：
- 同一聊天会话的不同项目，使用不同的队列
- 不同队列可以并行处理

**中断逻辑**：
- 只中断同一项目队列的任务
- 不影响其他项目的任务

### 组件 3：MessageProcessor（改造）

**核心改动**：`processMessage` 方法

**流程**：
1. 解析会话（获取 session）
2. 判断是否是后台任务：
   - 查询当前活跃会话 `getActiveSession(channel, channelId)`
   - 如果 `session.id !== activeSession.id`，则为后台任务
3. 创建 StreamFlusher，根据前台/后台模式初始化
4. 处理事件流：
   - 前台：所有事件正常处理（工具调用、文本输出等）
   - 后台：只处理 `result` 事件，其余忽略
5. 后台任务的 result 事件处理：
   - 成功：缓存最终结果 + 发送通知
   - 失败：缓存错误信息 + 发送通知

**关键点**：
- 前台/后台判断在每次 `processMessage` 时动态进行
- 不需要在切换项目时修改已运行任务的状态

### 组件 4：StreamFlusher（改造）

**改动方式**：在 MessageProcessor 中控制
- StreamFlusher 本身不变
- MessageProcessor 在后台模式下不调用 `flusher.addText()` 和 `flusher.addActivity()`

### 组件 5：SessionManager（小改）

**改动点**：
- 添加 `getActiveSession(channel, channelId)` 方法
- 返回当前活跃会话（`is_active=1`）

**不改动**：
- `switchProject` 逻辑保持不变
- `is_active` 机制保持不变

### 组件 6：消息入队逻辑（改造）

**位置**：`src/index.ts` 的 `feishu.onMessage` 和 `aun.onMessage`

**改动**：
- `messageQueue.enqueue` 调用时传入 `session.projectPath`

**注意**：
- 命令处理仍然立即执行，不进入队列
- 只有普通消息进入队列

## 五、用户交互流程

### 场景 1：切换项目，原任务继续

```
1. 用户在 projectA 发送消息 "帮我分析代码"
   → 消息进入队列 `feishu-chat123-projectA`
   → MessageProcessor 判断：projectA 是活跃会话，前台模式
   → 正常输出到聊天窗口

2. 用户执行 `/switch projectB`
   → SessionManager 将 projectA 设为 is_active=0
   → SessionManager 将 projectB 设为 is_active=1
   → 返回切换成功消息

3. projectA 的任务继续执行
   → MessageProcessor 判断：projectA 不是活跃会话，后台模式
   → 中间输出丢弃
   → 任务完成时：缓存结果 + 发送通知 "[后台-projectA] ✓ 任务完成"

4. 用户执行 `/plist`
   → 显示：projectA 有 1 条新消息

5. 用户执行 `/switch projectA`
   → 切换回 projectA
   → 读取 MessageCache，显示缓存的完成事件
   → 清空缓存
```

### 场景 2：多项目并行执行

```
1. 用户在 projectA 发送消息 "重构代码"
   → 队列 `feishu-chat123-projectA` 开始处理

2. 用户切换到 projectB，发送消息 "显示配置"
   → 队列 `feishu-chat123-projectB` 开始处理
   → 两个队列并行执行

3. projectA 在后台继续执行
   → 完成时发送通知

4. projectB 在前台正常输出
   → 用户看到配置内容

5. 用户执行 `/plist`
   → 显示两个项目的状态
```

## 六、关键技术点

### 1. 前台/后台判断时机

**时机**：每次 `processMessage` 开始时

**逻辑**：
```
activeSession = sessionManager.getActiveSession(channel, channelId)
isBackground = (session.id !== activeSession?.id)
```

**为什么不在切换时标记**：
- 任务可能在切换前就已经在队列中
- 任务执行时才知道当前是前台还是后台
- 动态判断更灵活

### 2. 队列 Key 的生成

**projectPathHash 计算**：
- 简单方案：使用 projectPath 的最后一段（basename）
- 严格方案：使用 crypto.createHash('md5').update(projectPath).digest('hex')

**推荐**：简单方案（假设项目名称不重复）

### 3. 后台任务的输出处理

**方式**：在 `processEventStream` 中，后台模式下：
- 遇到非 `result` 事件：直接 `continue`，不处理
- 遇到 `result` 事件：缓存 + 通知

**不需要**：
- 修改 StreamFlusher 的内部逻辑
- 在事件流中过滤输出

### 4. MessageCache 的生命周期

**创建**：在 `main()` 函数中，与其他组件一起初始化

**清理**：
- 定期清理：每小时调用 `cleanupExpired()`
- 手动清理：切换回项目时，显示后调用 `clearEvents()`

**过期时间**：72 小时（可配置）

## 七、边界情况处理

### 1. 后台任务出错

- 缓存错误信息
- 发送通知
- 不影响前台任务

### 2. 切换回项目时没有缓存事件

- 正常切换，不显示额外信息
- 用户可以继续发送消息

### 3. 后台任务执行时间很长

- 不影响前台任务
- 用户可以随时切换查看状态
- 通过 `/plist` 查看处理状态

### 4. 服务重启

- 内存中的 MessageCache 丢失
- 后台任务中断（SDK 连接断开）
- 用户需要重新发送消息

### 5. 同一项目的多条消息

- 仍然串行处理（同一队列）
- 后续消息会触发中断前一条消息
- 符合现有逻辑

## 八、实施步骤

### 阶段 1：基础设施
1. 创建 MessageCache 类
2. 修改 MessageQueue，支持 projectPath 参数
3. 添加 SessionManager.getActiveSession 方法

### 阶段 2：核心逻辑
4. 修改 MessageProcessor.processMessage，添加前台/后台判断
5. 修改 MessageProcessor.processEventStream，后台模式只处理 result 事件
6. 修改消息入队逻辑，传入 projectPath

### 阶段 3：用户界面
7. 修改 `/switch` 命令，显示缓存事件
8. 修改 `/plist` 命令，显示项目状态（已有 getProcessingProject）
9. 确保 `/status` 等命令正常工作

### 阶段 4：测试
10. 单元测试
11. 集成测试
12. 边界情况测试

## 九、风险评估

**低风险**：
- MessageCache 是新组件，不影响现有功能
- MessageQueue 改动小，向后兼容
- SessionManager 只增加方法，不修改现有逻辑

**中风险**：
- MessageProcessor 改动较大，需要仔细测试
- 前台/后台判断逻辑需要准确

**高风险**：
- 无

## 十、验证检查点

**检查点 1**：队列隔离
- ✅ 不同项目使用不同队列 key
- ✅ 队列可以并行处理

**检查点 2**：输出隔离
- ✅ 前台任务正常输出
- ✅ 后台任务只通知关键事件
- ✅ 不会混淆

**检查点 3**：状态一致性
- ✅ 前台/后台判断基于实时查询
- ✅ 不依赖切换时的标记
- ✅ 动态判断，不会出现不一致

**检查点 4**：用户体验
- ✅ 切换项目不中断任务
- ✅ 后台任务完成有通知
- ✅ 可以查看项目状态
- ✅ 切换回来可以看到结果

## 十一、预估代码量

| 组件 | 代码量 |
|------|--------|
| MessageCache（新建） | ~80 行 |
| MessageQueue（改造） | ~50 行 |
| MessageProcessor（改造） | ~100 行 |
| SessionManager（改造） | ~20 行 |
| 消息入队逻辑（改造） | ~20 行 |
| /switch 命令（改造） | ~30 行 |
| 单元测试 | ~150 行 |
| **总计** | **~450 行** |
