# EvolClaw 架构设计

> 基于 DESIGN-v2.md 的架构实现文档

## 系统架构

### 六层架构设计

```
┌─────────────────────────────────────────────────────────┐
│                      消息渠道层                           │
│  ┌──────────────┐              ┌──────────────┐         │
│  │ Feishu       │              │ ACP          │         │
│  │ (WebSocket)  │              │ (协议客户端)  │         │
│  └──────┬───────┘              └──────┬───────┘         │
└─────────┼──────────────────────────────┼─────────────────┘
          │                              │
          └──────────────┬───────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                      消息队列层                           │
│              ┌─────────────────────┐                     │
│              │  MessageQueue       │                     │
│              │  (会话级串行)        │                     │
│              └──────────┬──────────┘                     │
└─────────────────────────┼───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   状态监控层（Hook 驱动）                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │Hook收集  │  │超时检测  │  │熔断保护  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────┼───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                      会话管理层                           │
│              ┌─────────────────────┐                     │
│              │  SessionManager     │                     │
│              │  (shared/isolated)  │                     │
│              └──────────┬──────────┘                     │
└─────────────────────────┼───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                      实例管理层                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Instance 1   │  │ Instance 2   │  │ Instance 3   │  │
│  │ (SDK 实例)   │  │ (SDK 实例)   │  │ (SDK 实例)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 核心模块

### 1. 消息渠道层

#### Feishu Channel
- **实现**：基于 `@larksuiteoapi/node-sdk`
- **连接方式**：WebSocket 长连接
- **核心功能**：
  - 消息去重（LRU 缓存，1000 条，30 分钟 TTL）
  - 自动重连
  - 消息解析和发送

**代码位置**：`src/channels/feishu.ts`

#### ACP Channel
- **实现**：基于 `acp-ts`
- **连接方式**：ACP 协议客户端
- **认证**：AID（Agent Identity）基于 X.509 数字证书
- **状态**：当前为占位符实现，待完整集成

**代码位置**：`src/channels/acp.ts`

### 2. 消息队列层

#### MessageQueue
- **设计目标**：保证同一会话的消息按顺序处理
- **核心机制**：
  - 每个会话维护独立的消息队列
  - 会话空闲时立即处理新消息
  - 会话忙碌时消息入队等待
  - 处理完成后自动处理队列中的下一条消息
- **特点**：
  - 会话级串行（同一会话消息顺序处理）
  - 跨会话并发（不同会话可并发处理）
  - 无全局并发限制（保持轻量）

**代码位置**：`src/core/message-queue.ts`

### 3. 状态监控层（Hook 驱动）

#### HookCollector
- **功能**：统一 Hook 事件收集器
- **收集的 Hook**：
  - SessionStart/Stop
  - PostToolUse/PostToolUseFailure
  - SubagentStart/Stop
  - Notification
- **存储**：存储事件到 `session_events` 表
- **通知**：通过 WebSocket 推送实时通知到前端

**代码位置**：`src/monitor/hook-collector.ts`

#### HookBasedMonitor
- **功能**：基于 Hook 活动时间的超时检测
- **监控机制**：
  - 监控特定 Hook 的最后触发时间
  - 默认 30 分钟无活动视为超时
  - 每 30 秒检查一次
- **超时处理**：触发紧急同步和清理

**代码位置**：`src/monitor/hook-monitor.ts`

#### CircuitBreaker
- **功能**：熔断保护
- **触发条件**：5 分钟内连续 3 次失败
- **恢复机制**：熔断后 5 分钟自动尝试恢复（half-open 状态）
- **实现方式**：通过数据库查询实现，无需复杂状态管理

**代码位置**：`src/monitor/circuit-breaker.ts`

#### StateRecovery
- **功能**：启动恢复
- **检查机制**：启动时检查未正常结束的会话（无 end/timeout/crashed 事件）
- **恢复操作**：
  - 紧急同步 JSONL 文件到数据库
  - 标记为 crashed 状态
  - 通知用户

**代码位置**：`src/monitor/state-recovery.ts`

#### NotificationHandler
- **功能**：Notification Hook 处理器
- **处理内容**：
  - 接收 Agent 发送的通知消息（进度、警告、状态变更）
  - 通过 WebSocket 实时推送到前端
  - 存储到 session_events 表

**代码位置**：`src/monitor/notification.ts`

### 4. 会话管理层

#### SessionManager
- **功能**：管理会话映射关系
- **两种模式**：
  - **Shared 模式**：同一渠道所有会话共享一个 Claude 会话
  - **Isolated 模式**：每个渠道会话独立的 Claude 会话
- **特点**：
  - 运行时动态切换
  - 默认使用 isolated 模式

**代码位置**：`src/core/session-manager.ts`

**Shared 模式映射**：
```
飞书群 A → feishu-shared → Claude Session 001
飞书群 B → feishu-shared → Claude Session 001
飞书群 C → feishu-shared → Claude Session 001
ACP 会话 → acp-shared   → Claude Session 002
```

**Isolated 模式映射**：
```
飞书群 A → feishu-chatA-xxx → Claude Session 001
飞书群 B → feishu-chatB-xxx → Claude Session 002
飞书群 C → feishu-chatC-xxx → Claude Session 003
ACP 会话 → acp-chatX-xxx   → Claude Session 004
```

### 5. 实例管理层

#### InstanceManager
- **功能**：管理 Claude Agent SDK 实例池
- **配置**：
  - 最多 20 个并发实例
  - 空闲超时 30 分钟
- **核心操作**：
  - 创建、复用、销毁实例
  - 配置 Hook 回调
  - 管理实例生命周期
  - 自动清理空闲实例

**代码位置**：`src/gateway/instance-manager.ts`

#### ClaudeInstance
- **功能**：Claude Agent SDK 实例封装
- **状态管理**：IDLE → BUSY → IDLE
- **Hook 配置**：
  - Stop Hook
  - PostToolUse Hook
  - SubagentStart/Stop Hook
  - Notification Hook
- **指标收集**：
  - 查询次数
  - 最后查询时间
  - 空闲时间

**代码位置**：`src/gateway/claude-instance.ts`

### 6. 存储层

#### JSONL 文件
- **管理方式**：由 Claude Agent SDK 自动管理
- **位置**：`~/.claude/projects/{project}/{session_id}.jsonl`
- **特点**：
  - 存储完整消息内容
  - Agent 可直接读取
  - 对 Agent 透明可读

#### 数据库元数据
- **实现**：SQLite (better-sqlite3)
- **同步机制**：通过 Hook 机制自动同步
- **功能**：
  - 支持快速搜索和统计
  - 存储消息摘要和索引
  - 会话状态管理

**代码位置**：`src/core/database.ts`

## 消息处理流程

```
1. 飞书/ACP 消息到达
   ↓
2. MessageQueue 入队（会话级）
   ↓
3. CircuitBreaker 检查熔断状态
   ↓
4. SessionManager 获取/创建会话映射
   ↓
5. HookCollector 记录 SessionStart 事件
   ↓
6. HookBasedMonitor 启动超时监控（基于 Hook 活动时间）
   ↓
7. InstanceManager 获取/创建 Claude Agent SDK 实例
   ↓
8. Claude Agent SDK 处理消息（query()）
   ├─ SDK 自动写入 JSONL 文件
   ├─ PostToolUse Hook → HookCollector 记录 + 更新活动时间
   ├─ PostToolUseFailure Hook → HookCollector 记录错误
   ├─ SubagentStart/Stop Hook → HookCollector 记录 + 更新活动时间
   ├─ Notification Hook → 推送通知到前端
   └─ Stop Hook 触发（响应完成后）
   ↓
9. MessageSync 增量同步到数据库
   ↓
10. HookCollector 记录 SessionEnd 事件
   ↓
11. HookBasedMonitor 停止监控
   ↓
12. CircuitBreaker 记录成功
   ↓
13. 累积完整响应
   ↓
14. 返回结果到消息渠道

异常分支：
- Hook 活动超时（30分钟无活动）→ 紧急同步 → 清理资源 → 通知用户
- 工具失败 → PostToolUseFailure Hook 记录 → Stop Hook 仍触发 → 正常同步
- 进程崩溃 → 启动时 StateRecovery 恢复（查询无 end/timeout/crashed 事件的会话）
- 连续失败 → CircuitBreaker 熔断（数据库查询最近失败次数）→ 暂停执行
```

## Hook 同步机制

### Stop Hook 同步流程

```
Claude Agent SDK 处理消息
   ↓
SDK 自动写入 JSONL 文件
   ↓
触发 Stop Hook（响应完成后）
   ↓
MessageSync.syncLatest()
   ├─ 读取 JSONL 文件
   ├─ 获取 last_synced_line
   ├─ 只同步新增的行
   ├─ 写入数据库元数据
   └─ 更新 last_synced_line
```

### 定期全量同步

```
（定期触发，每 5 分钟）
   ↓
MessageSync.syncAllIfNeeded()
   ├─ 检查上次全量同步时间
   ├─ 如果超过 5 分钟
   ├─ 重置 last_synced_line = 0
   └─ 执行全量同步（兜底）
```

### Hook 触发条件

| Hook | 触发条件 | 纯文本回复 | 使用工具 | 可靠性 | 用途 |
|------|---------|-----------|---------|--------|------|
| **Stop** | 每次响应完成后 | ✅ 触发 | ✅ 触发 | ✅ 100% | 主要同步机制 |
| PostToolUse | 每次工具使用后 | ❌ 不触发 | ✅ 触发 | ⚠️ 不完整 | 活动监控 |
| SubagentStart/Stop | 子 Agent 生命周期 | - | ✅ 触发 | ✅ 可靠 | 活动监控 |
| Notification | Agent 发送通知 | - | ✅ 触发 | ✅ 可靠 | 通知推送 |

## 故障恢复机制

### 1. 自动重试
- **最多重试次数**：3 次
- **退避策略**：指数退避（1s, 2s, 4s）
- **适用场景**：临时性错误（网络抖动、API 限流等）

### 2. 实例重启
- **触发条件**：进程崩溃
- **最多重启次数**：5 次
- **冷却时间**：60 秒
- **实现位置**：`src/gateway/failure-handler.ts`

### 3. 熔断保护
- **触发条件**：5 分钟内连续 3 次失败
- **熔断时长**：5 分钟
- **恢复机制**：半开状态定期尝试恢复
- **目的**：避免资源浪费和级联故障

### 4. 资源清理
- **空闲超时**：30 分钟
- **清理机制**：定时检查（每 60 秒）
- **清理操作**：停止实例、释放资源

## 技术特点

### 1. 轻量化设计
- 代码量：~1000 行
- 无容器依赖
- 进程模式运行
- 快速启动（毫秒级）

### 2. Hook 驱动
- 基于 Claude Agent SDK 的 Hook 机制
- 无需主动轮询
- 事件驱动架构
- 实时状态监控

### 3. 会话隔离
- 支持 shared 和 isolated 两种模式
- 运行时动态切换
- 灵活适配不同场景

### 4. Agent 友好
- JSONL 文件对 Agent 透明可读
- Agent 可使用 Read/Grep 工具直接访问会话历史
- 数据库提供快速搜索能力

## 配置管理

### 配置文件结构

```json
{
  "anthropic": {
    "apiKey": "sk-ant-xxx"
  },
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  },
  "acp": {
    "domain": "aid.pub",
    "agentName": "evolclaw"
  },
  "projects": {
    "defaultPath": "./projects/default",
    "autoCreate": true,
    "list": {
      "default": "./projects/default",
      "evolclaw": "/path/to/evolclaw",
      "my-app": "/path/to/my-app"
    }
  },
  "session": {
    "mode": "isolated"
  },
  "sync": {
    "fullSyncInterval": 300000
  },
  "monitor": {
    "timeout": {
      "limit": 1800000,
      "checkInterval": 30000
    },
    "circuitBreaker": {
      "failureThreshold": 3,
      "resetTimeout": 300000
    },
    "recovery": {
      "enableStartupRecovery": true,
      "emergencySyncOnError": true
    }
  }
}
```

## 性能指标

### 实例管理
- 最大并发实例：20
- 实例启动时间：< 100ms
- 空闲超时：30 分钟

### 消息处理
- 会话级串行处理
- 跨会话并发处理
- 消息去重：LRU 1000 条

### 监控检查
- 超时检查间隔：30 秒
- 全量同步间隔：5 分钟
- Hook 活动超时：30 分钟

---

*文档版本：v1.0*
*更新日期：2026-03-08*
*基于：DESIGN-v2.md*
