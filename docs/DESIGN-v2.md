# EvolClaw 完整方案设计 v2.0

> 基于技术验证结果更新（2026-03-07）

## 一、项目定位

### 1.1 什么是 EvolClaw

EvolClaw 是一个**轻量化的 AI Agent 网关系统**，定位于比 HappyClaw 更简洁、更专注的单用户场景。

**核心特点**：
- **轻量化**：进程模式运行，无容器依赖，代码量控制在 ~1000 行
- **单用户**：专注个人使用场景，无需复杂的多用户管理
- **双渠道**：支持飞书和 AUN 两个消息渠道
- **Agent 友好**：基于 Claude Agent SDK，会话日志对 Agent 透明可读
- **生产级可靠**：复用 HappyClaw 的成熟组件，完整的状态监控机制

### 1.2 设计目标

**主要目标**：
1. 提供生产级可靠的消息接入能力
2. 保证消息处理的顺序性和一致性
3. 支持个人助手和团队协作两种使用模式
4. 实现 Agent 友好的会话日志存储

**设计原则**：
- **简单优于复杂**：只实现必要功能，避免过度设计
- **复用优于重造**：优先使用成熟组件（如 HappyClaw 的 Feishu 连接）
- **验证优于假设**：所有核心技术点已通过实际验证

### 1.3 与其他项目的关系

| 特性 | EvolClaw | HappyClaw | OpenClaw |
|------|----------|-----------|----------|
| **定位** | 轻量化网关 | 自托管 AI Agent | 多渠道 AI 网关 |
| **用户模式** | 单用户 | 多用户 RBAC | 单用户/多账号 |
| **运行模式** | 进程 | Docker 容器 | 单容器 |
| **消息渠道** | 2 个（飞书、AUN） | 3 个（飞书、Telegram、Web） | 8+ 个 |
| **代码规模** | ~500 行 | 完整系统 | 完整系统 |
| **适用场景** | 个人轻量部署 | 个人/团队协作 | Agent 网络 |

**技术借鉴**：
- **从 HappyClaw 借鉴**：生产级 Feishu 连接、消息队列思想
- **从 OpenClaw 借鉴**：ACP 协议集成、文件化会话日志
- **独特设计**：Hook 驱动的混合存储、会话模式切换

---

## 二、系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      消息渠道层                           │
│  ┌──────────────┐              ┌──────────────┐         │
│  │ Feishu       │              │ AUN          │         │
│  │ (HappyClaw)  │              │ (简化客户端)  │         │
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
│  ┌──────────┐  ┌──────────┐                            │
│  │状态恢复  │  │通知处理  │                            │
│  └──────────┘  └──────────┘                            │
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
│              ┌─────────────────────┐                     │
│              │  InstanceManager    │                     │
│              │  (Claude Agent SDK)  │                    │
│              └──────────┬──────────┘                     │
└─────────────────────────┼───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                      存储层                               │
│  ┌──────────────┐              ┌──────────────┐         │
│  │ JSONL 文件   │◄───Stop Hook──│ 数据库元数据  │         │
│  │ (SDK 管理)   │   + 定期同步  │ (快速搜索)    │         │
│  └──────────────┘              └──────────────┘         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心模块

**消息渠道层**：
- `FeishuChannel`：复用 HappyClaw 的生产级 Feishu 连接
  - 健康检查（15s 轮询）
  - 自动重连
  - 消息去重（LRU 1000 条，30min TTL）
  - Backfill 机制（重连后回填 5 分钟消息）
- `AUNChannel`：简化的 AUN 客户端
  - 基于 `agentcp_node` 库
  - 接收来自 AUN 网络的消息

**消息队列层**：
- `MessageQueue`：会话级消息队列
  - 保证同一会话的消息串行处理
  - 避免并发导致的上下文混乱
  - 会话间可并发处理

**状态监控层（Hook 驱动）**：
- `HookCollector`：统一 Hook 事件收集器
  - 收集所有监控相关的 Hook 事件（SessionStart、Stop、PostToolUse、PostToolUseFailure、SubagentStart/Stop、Notification）
  - 存储事件到统一的 session_events 表
  - 通过 WebSocket 推送实时通知到前端
- `HookBasedMonitor`：基于 Hook 活动时间的超时检测
  - 监控特定 Hook 的最后触发时间（Stop、PostToolUse、SubagentStart/Stop）
  - 默认 30 分钟无活动视为超时
  - 每 30 秒检查一次，超时时触发紧急同步和清理
- `CircuitBreaker`：熔断保护
  - 5 分钟内连续 3 次失败触发熔断
  - 熔断后 5 分钟自动尝试恢复（half-open 状态）
  - 通过数据库查询实现，无需复杂状态管理
- `StateRecovery`：启动恢复
  - 启动时检查未正常结束的会话（无 end/timeout/crashed 事件）
  - 紧急同步 JSONL 文件到数据库
  - 标记为 crashed 状态并通知用户
- `NotificationHandler`：Notification Hook 处理器
  - 接收 Agent 发送的通知消息（进度、警告、状态变更）
  - 通过 WebSocket 实时推送到前端
  - 存储到 session_events 表

**会话管理层**：
- `SessionManager`：管理会话映射关系
  - Shared 模式：同一渠道所有会话共享一个 Claude 会话
  - Isolated 模式：每个渠道会话独立的 Claude 会话
  - 运行时动态切换

**实例管理层**：
- `InstanceManager`：管理 Claude Agent SDK 实例
  - 创建、复用、销毁实例
  - 配置 Hook 回调
  - 管理实例生命周期

**存储层**：
- JSONL 文件：由 Claude Agent SDK 自动管理
  - 位置：`~/.claude/projects/{project}/{session_id}.jsonl`
  - Agent 可直接读取
- 数据库元数据：通过 Hook 机制自动同步
  - 支持快速搜索和统计
  - 存储消息摘要和索引

### 2.3 技术栈

**运行时**：
- Node.js 22+
- TypeScript

**核心依赖**：
- `@anthropic-ai/claude-agent-sdk` - Claude Agent SDK（已验证）
- `@larksuiteoapi/node-sdk` - 飞书 SDK（通过 HappyClaw）
- `agentcp_node` - ACP 协议客户端
- `better-sqlite3` - 轻量级数据库

**项目结构**：
```
evolclaw/
├── src/
│   ├── channels/
│   │   ├── feishu.ts          # 飞书渠道（复用 HappyClaw）
│   │   └── aun.ts             # AUN 渠道
│   ├── core/
│   │   ├── session-manager.ts # 会话管理
│   │   ├── message-queue.ts   # 消息队列
│   │   ├── message-sync.ts    # Hook 驱动同步
│   │   └── instance-manager.ts# 实例管理
│   ├── monitor/               # 状态监控模块（Hook 驱动）
│   │   ├── hook-collector.ts  # Hook 事件收集器
│   │   ├── hook-monitor.ts    # 基于 Hook 的超时检测
│   │   ├── circuit-breaker.ts # 熔断保护
│   │   ├── state-recovery.ts  # 启动恢复
│   │   └── notification.ts    # Notification Hook 处理
│   ├── types.ts               # 类型定义
│   └── index.ts               # 入口
├── config.json                # 配置文件
├── data/
│   └── sessions.db            # 会话数据库
└── package.json
```

---

## 三、核心设计（已验证）

### 3.1 生产级 Feishu 连接 ✅

**设计决策**：复用 HappyClaw 的 `createFeishuConnection()` 工厂函数。

**核心能力**：
- **健康检查**：15 秒轮询检测连接状态
- **自动重连**：网络断线后自动恢复
- **消息去重**：LRU 缓存（1000 条，30 分钟 TTL）
- **Backfill 机制**：重连后回填 5 分钟内的消息
- **热重连**：支持 `ignoreMessagesBefore` 参数过滤堆积消息

**收益**：
- 获得生产级可靠性
- 零额外开发成本
- 持续维护保障

### 3.2 会话级消息队列 ✅

**设计目标**：保证同一会话的消息按顺序处理。

**核心机制**：
- 每个会话维护独立的消息队列
- 会话空闲时立即处理新消息
- 会话忙碌时消息入队等待
- 处理完成后自动处理队列中的下一条消息

**特点**：
- 简单实现（~50 行代码）
- 无全局并发限制（保持轻量）
- 会话间可并发处理

### 3.3 会话模式切换 ✅

**两种模式**：

**Shared 模式（个人助手）**：
- 同一渠道的所有会话映射到同一个 Claude 会话
- 跨群组共享上下文和记忆
- 适合个人使用，Agent 可以记住跨群组的对话

**Isolated 模式（团队协作）**：
- 每个渠道会话独立的 Claude 会话
- 完全隔离的上下文
- 适合多群组场景，避免上下文泄露

**实现方式**：
- 通过配置文件的 `session.mode` 字段控制
- 运行时动态切换
- 默认使用 isolated 模式


### 3.4 Hook 驱动的混合式会话日志 ✅

**设计目标**：平衡 Agent 友好性和功能完整性。

**存储策略**：
- **JSONL 文件**：Claude Agent SDK 自动管理，存储完整消息内容，Agent 可直接读取
- **数据库元数据**：存储消息摘要和索引，支持快速搜索和统计

**同步机制（已验证）**：

| Hook | 触发条件 | 纯文本回复 | 使用工具 | 可靠性 | 用途 |
|------|---------|-----------|---------|--------|------|
| **Stop** | 每次响应完成后 | ✅ 触发 | ✅ 触发 | ✅ 100% | 主要同步机制 |
| PostToolUse | 每次工具使用后 | ❌ 不触发 | ✅ 触发 | ⚠️ 不完整 | 已弃用 |
| PreCompact | 手动 `/compact` 或达到 token 阈值 | - | - | ⚠️ 不可靠 | 已移除 |
| SessionEnd | 手动 `/clear` 或登出 | - | - | ⚠️ 不适用 | 已移除 |

**最终同步策略**：
1. **Stop Hook**：每次响应完成后触发，增量同步最新消息（覆盖所有场景）
2. **定期全量同步**：每 5 分钟执行一次，作为兜底机制

**核心优势**：
- **完整覆盖**：Stop Hook 覆盖所有对话场景（纯文本 + 工具使用）
- **解耦**：EvolClaw 不需要主动双写，由 SDK Hook 触发同步
- **实时性**：响应完成后立即同步
- **可靠性**：定期全量同步兜底
- **简单性**：只需一个 Hook，避免重复同步
- **Agent 友好**：JSONL 文件可用 Read/Grep 工具直接访问
- **快速搜索**：数据库索引支持关键词搜索

**Hook 提供的数据**：
```typescript
interface StopHookInput {
  session_id: string;
  transcript_path: string;  // JSONL 文件路径
  cwd: string;
  permission_mode: string;
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
}
```

### 3.5 渠道能力与限制

**认证机制**：

**飞书（Feishu）**：
- 认证方式：App ID + App Secret
- 实现：通过 `@larksuiteoapi/node-sdk` 建立 WebSocket 长连接
- SDK 自动处理：token 获取、刷新、WebSocket 认证
- 配置：`{ "appId": "cli_xxx", "appSecret": "xxx" }`

**AUN**：
- 认证方式：AID（Agent Identity）基于 X.509 数字证书
- 实现：通过 `agentcp_node` 处理
- 证书管理：从 CA 服务器获取，存储在 `.aun-storage/AIDs/{aid}/`
- 配置：`{ "domain": "aid.pub", "agentName": "evolclaw" }`

**流式返回支持**：

**协议能力**：
- **ACP 协议**：✅ 支持流式输出（delta events、异步流式传输）
- **飞书协议**：❌ 不支持流式消息

**处理策略**：
```
Claude SDK 流式输出 → 累积完整响应 → 一次性发送到渠道
```

**实现方式**：
1. 监听 Claude SDK 的 StreamEvent（text_delta、thinking_delta）
2. 累积所有输出到缓冲区
3. 等待响应完成
4. 调用渠道的 `sendMessage()` 一次性发送

**限制原因**：
- 飞书不支持流式消息，必须累积完整响应
- 为保持双渠道一致性，AUN 也采用相同策略
- 保持轻量化实现（无需实现复杂的流式协议适配）

**代价**：
- 用户无法看到实时输出
- 需要等待完整响应

**多媒体支持**：

**MVP 阶段策略**：
- ✅ 支持：纯文本消息
- ⏸️ 暂不支持：图片和文件（需要下载/上传逻辑，增加 ~100 行代码）
- 📋 后续扩展：根据实际需求决定是否实现


---

## 四、数据流设计

### 4.1 消息处理流程（Hook 驱动监控）

```
1. 飞书/AUN 消息到达
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

### 4.2 会话映射策略

**Shared 模式映射**：
```
飞书群 A → feishu-shared → Claude Session 001
飞书群 B → feishu-shared → Claude Session 001
飞书群 C → feishu-shared → Claude Session 001
AUN 会话 → aun-shared   → Claude Session 002
```

**Isolated 模式映射**：
```
飞书群 A → feishu-chatA-xxx → Claude Session 001
飞书群 B → feishu-chatB-xxx → Claude Session 002
飞书群 C → feishu-chatC-xxx → Claude Session 003
AUN 会话 → aun-chatX-xxx   → Claude Session 004
```

### 4.3 Hook 同步流程（已验证）

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
   ↓
（定期触发，每 5 分钟）
   ↓
MessageSync.syncAllIfNeeded()
   ├─ 检查上次全量同步时间
   ├─ 如果超过 5 分钟
   ├─ 重置 last_synced_line = 0
   └─ 执行全量同步（兜底）
```


---

## 五、实施路径

### 6.1 开发阶段

**阶段 1：核心功能（3-5 天）**

任务：
1. 引入 HappyClaw 的 Feishu 连接
2. 实现会话级消息队列
3. 实现会话管理（支持 shared/isolated）
4. 实现 Hook 驱动的消息同步
5. 实现定期全量同步

验收标准：
- Feishu 连接稳定，支持自动重连
- 消息顺序正确，无乱序现象
- 可通过配置切换会话模式
- Stop Hook 正常触发并同步
- Agent 可直接读取 JSONL 会话历史
- 数据库支持快速搜索

**阶段 2：状态监控模块（2-3 天）**

任务：
1. 实现 HookCollector（统一 Hook 事件收集）
2. 实现 HookBasedMonitor（基于 Hook 活动时间的超时检测）
3. 实现 CircuitBreaker（数据库查询实现）
4. 实现 StateRecovery（启动恢复）
5. 实现 NotificationHandler（Notification Hook 处理）
6. 集成到 InstanceManager

验收标准：
- 所有 Hook 事件正确收集并存储到 session_events 表
- Hook 活动超时能正确检测并处理（30 分钟无活动）
- 熔断机制正常工作（5 分钟内 3 次失败触发）
- 启动时能恢复异常退出的会话（查询无 end/timeout/crashed 事件）
- Notification Hook 能推送通知到前端
- 所有异常场景有完整覆盖

**阶段 3：AUN 集成（2-3 天）**

任务：
1. 集成 `agentcp_node` 库
2. 实现 AUN 消息接收
3. 测试 AUN 连接稳定性

验收标准：
- AUN 连接正常建立
- 可以接收 AUN 消息
- 消息正确路由到 Claude Agent

**阶段 4：测试与优化（3-4 天）**

任务：
1. 测试 Feishu 连接稳定性（模拟网络断线）
2. 测试消息队列正确性（高并发场景）
3. 测试会话模式切换
4. 测试 Hook 同步机制（验证数据一致性）
5. 测试监控模块（Hook 活动超时、熔断机制、Notification 推送）
6. 测试状态恢复（模拟进程崩溃）
7. 性能优化

验收标准：
- 网络断线后能自动重连并恢复
- 高并发下消息不乱序
- shared/isolated 模式正常工作
- JSONL 与数据库保持一致
- 定期同步正常工作
- Hook 活动超时能正确检测和处理（30 分钟无活动）
- 熔断机制正常工作（5 分钟内 3 次失败触发）
- 启动时能恢复异常退出的会话
- Notification Hook 能实时推送到前端
- 熔断机制正常工作
- 启动时能恢复异常退出的会话

### 6.2 代码量估算（Hook 驱动监控）

**核心功能**：
- Feishu 连接：~50 行（复用 HappyClaw）
- 消息队列：~50 行
- 会话管理：~100 行
- 消息同步：~120 行（增加定期同步）
- 实例管理：~80 行
- AUN 集成：~100 行
- **小计**：~500 行

**状态监控模块（Hook 驱动）**：
- HookCollector：~120 行（收集所有 Hook 事件）
- HookBasedMonitor：~100 行（基于 Hook 活动时间的超时检测）
- CircuitBreaker：~80 行（数据库查询实现）
- StateRecovery：~60 行（启动恢复）
- NotificationHandler：~80 行（Notification Hook 处理）
- **小计**：~440 行

**总计**：~940 行（比原设计减少 90 行）

### 6.3 配置管理

通过 `config.json` 管理核心配置：

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  },
  "aun": {
    "domain": "aid.pub",
    "agentName": "evolclaw"
  },
  "session": {
    "mode": "isolated",
    "projectPath": "/path/to/project"
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


---

## 六、总结

### 9.1 设计完整性

本设计文档基于完整的技术验证，所有核心技术点已通过实际测试确认可行。

**验证文档**：
- [完整验证报告](./VALIDATION-REPORT.md)
- [Hook 触发条件](./HOOK-TRIGGER-CONDITIONS.md)
- [验证总结](./VALIDATION-SUMMARY.md)

### 9.2 可以开始实施 🚀

- ✅ 核心技术风险已消除
- ✅ 架构设计清晰合理（六层：渠道、队列、监控、会话、实例、存储）
- ✅ 实施路径明确（4个阶段）
- ✅ 代码量可控（~940 行）
- ✅ 开发周期可预期（10-15 天）
- ✅ 异常场景有完整覆盖（Hook 驱动监控：超时、熔断、恢复、通知）

### 9.3 关键成功因素

1. **复用成熟组件**：HappyClaw 的 Feishu 连接
2. **验证驱动设计**：基于实际测试调整方案
3. **Stop Hook 机制**：覆盖所有对话场景的可靠同步点
4. **Agent 友好**：JSONL + 数据库混合存储
5. **Hook 驱动监控**：基于 Hook 活动时间的超时检测，简化架构，降低复杂度

---

**文档版本**：v2.0  
**更新日期**：2026-03-07  
**验证状态**：✅ 已完成技术验证  
**可行性评分**：9/10

