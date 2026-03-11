# EvolClaw

轻量化 AI Agent 网关系统，支持飞书和 ACP 双渠道接入，基于 Claude Agent SDK 构建。

## 核心特性

- 🚀 **轻量化设计**：进程模式运行，无容器依赖，代码量 ~1000 行
- 🔄 **统一消息处理**：Channel Adapter 模式，新增渠道只需 ~15 行代码
- 📊 **Hook 驱动监控**：基于 SDK Hook 的状态监控和超时检测
- 🌐 **双渠道接入**：飞书 WebSocket + ACP 协议
- 📁 **多项目支持**：每个项目独立会话，支持动态切换
- 💾 **会话持久化**：SQLite + JSONL 双重保障，服务重启不丢失会话
- ⚡ **任务中断**：新消息立即中断当前任务，响应更快
- 📦 **批量发送**：工具调用活动 3 秒批量发送，减少消息数量
- 🤖 **动态模型管理**：启动时自动获取可用模型列表，支持运行时切换

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

创建 `data/config.json`：

```json
{
  "anthropic": {
    "apiKey": "your-anthropic-api-key",
    "baseUrl": "https://mg.aid.pub/claude-proxy"
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
    "list": {}
  },
  "session": {
    "mode": "isolated"
  }
}
```

### 3. 运行

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build
npm start

# 服务管理（推荐）
bash evolclaw.sh start    # 启动服务
bash evolclaw.sh stop     # 停止服务
bash evolclaw.sh restart  # 重启服务
bash evolclaw.sh status   # 查看状态

# 查看日志
tail -f logs/service.log

# 运行测试
npm test

# 测试监听模式
npm run test:watch
```

## 项目定位

EvolClaw 是一个**轻量化的 AI Agent 网关系统**，定位于比 HappyClaw 更简洁、更专注的单用户场景。

### 与其他项目对比

| 特性 | EvolClaw | HappyClaw | OpenClaw |
|------|----------|-----------|----------|
| **定位** | 轻量化网关 | 自托管 AI Agent | 多渠道 AI 网关 |
| **用户模式** | 单用户 | 多用户 RBAC | 单用户/多账号 |
| **运行模式** | 进程 | Docker 容器 | 单容器 |
| **消息渠道** | 2 个（飞书、ACP） | 3 个（飞书、Telegram、Web） | 8+ 个 |
| **代码规模** | ~1000 行 | 完整系统 | 完整系统 |
| **适用场景** | 个人轻量部署 | 个人/团队协作 | Agent 网络 |

## 系统架构

七层架构设计：

```
消息渠道层 → 消息队列层 → 消息处理层 → 监控层 → 会话管理层 → 实例管理层 → 存储层
```

### 核心组件

1. **消息渠道层** (`src/channels/`) - Feishu WebSocket + ACP 协议
2. **消息队列层** (`src/core/message-queue.ts`) - 会话级串行处理 + 中断支持
3. **消息处理层** (`src/core/message-processor.ts`) - 统一事件处理引擎
4. **监控层** (`src/monitor/`) - Hook 驱动的状态监控（实验性，未启用）
5. **会话管理层** (`src/session-manager.ts`) - 多项目会话管理
6. **实例管理层** (`src/gateway/`) - 实例池管理（实验性，未启用，保留作参考）
7. **存储层** - JSONL 文件（SDK 管理）+ SQLite 元数据

**注**：监控层和实例管理层为实验性功能，当前未在主入口使用。保留目的：
- 实例池管理：未来高并发场景的参考实现
- Hook 监控：完整的 Hook 事件追踪机制（Stop、PostToolUse、SubagentStart/Stop、Notification）
- 故障恢复：重试、重启、熔断机制

### 消息流转

```
用户发送消息
    ↓
Channel.onMessage
    ↓
检查命令 → 是 → 立即响应（绕过队列）
    ↓ 否
MessageQueue.enqueue(streamKey, message)
    ↓
检测正在处理 → 是 → 触发中断 → AgentRunner.interrupt()
    ↓ 否                                    ↓
MessageQueue.processNext()  ←──────────────┘
    ↓
MessageProcessor.processMessage()
    ↓
├─ 解析会话和项目路径
├─ 创建 StreamFlusher（3 秒批量发送）
├─ AgentRunner.runQuery() → 事件流
├─ 注册 stream（用于中断）
│   ↓
├─ 处理事件流：
│   ├─ PreCompact Hook → ⏳ 会话压缩中...
│   ├─ system/compact_boundary → 💡 会话压缩完成，继续执行...
│   ├─ assistant/tool_use → flusher.addActivity()
│   └─ result → flusher.addText()
│   ↓
├─ 提取文件标记（Feishu）
├─ flusher.flush() → 自动移除标记
├─ 发送文件（Feishu）
└─ 清理 stream
```

### 关键特性

- **Channel Adapter 模式**：渠道只负责收发消息，不处理事件
- **中断机制**：新消息到达时立即中断当前任务
- **批量发送**：工具调用活动在 3 秒窗口内批量发送
- **命令优先**：命令不进队列，立即响应
- **会话持久化**：数据库 + JSONL 文件，服务重启自动恢复

详见 [架构设计文档](./docs/architecture.md)

## 项目结构

```
evolclaw/
├── src/
│   ├── gateway/
│   │   ├── claude-instance.ts      # Claude Agent SDK 实例封装
│   │   ├── instance-manager.ts     # 实例池管理（最多20个实例）
│   │   └── failure-handler.ts      # 故障恢复（重试+重启）
│   ├── core/
│   │   ├── session-manager.ts      # 会话管理（多项目支持）
│   │   ├── message-queue.ts        # 消息队列（会话级串行+中断）
│   │   ├── message-processor.ts    # 统一消息处理引擎
│   │   ├── stream-flusher.ts       # 批量发送（3秒窗口）
│   │   ├── database.ts             # SQLite 数据库
│   │   └── message-sync.ts         # 消息同步
│   ├── monitor/
│   │   ├── hook-collector.ts       # Hook 事件收集
│   │   ├── hook-monitor.ts         # 超时检测
│   │   ├── circuit-breaker.ts      # 熔断保护
│   │   ├── state-recovery.ts       # 状态恢复
│   │   └── notification.ts         # 通知处理
│   ├── channels/
│   │   ├── feishu.ts               # 飞书 WebSocket 渠道
│   │   └── acp.ts                  # ACP 协议渠道
│   ├── agent-runner.ts             # Claude Agent SDK 调用封装
│   ├── types.ts                    # 类型定义
│   ├── config.ts                   # 配置加载
│   ├── index.ts                    # 主入口（完整功能）
│   └── index-gateway.ts            # Gateway 模式入口
├── tests/
│   ├── unit/                       # 单元测试
│   └── integration/                # 集成测试
├── data/
│   ├── config.json                 # 配置文件（不在 git）
│   ├── config.json.template        # 配置模板
│   ├── sessions.db                 # 会话数据库
│   └── README.md                   # 配置管理说明
├── docs/                           # 文档目录
├── logs/                           # 日志目录
└── projects/                       # 项目工作目录
    └── default/
        └── .claude/                # Claude 会话数据
```

## 核心功能

### 多项目支持

每个项目独立会话，支持动态切换：

- **项目绑定**：每个聊天会话可绑定到不同项目目录
- **会话隔离**：每个项目有独立的 `.claude/` 目录和会话历史
- **会话保留**：切换项目时保留各项目的会话历史
- **动态切换**：通过命令随时切换工作项目

### 斜杠命令

支持项目和会话管理命令：

**项目管理**：
- `/pwd` 或 `/project current` - 显示当前项目路径
- `/plist` 或 `/project list` - 列出所有项目（显示会话空闲时间）
- `/switch <name|path>` 或 `/project switch <name>` - 切换项目（保留会话历史）
- `/bind <path>` 或 `/project bind <path>` - 绑定新项目目录

**会话管理**：
- `/new` - 清除当前项目的会话（其他项目不受影响）
- `/status` - 显示会话状态（渠道、ID、项目、时间戳）

**模型管理**：
- `/model` - 显示当前模型和可用模型列表
- `/model <model-id>` - 切换到指定模型（如 `/model claude-opus-4-6`）

**帮助**：
- `/help` - 显示所有可用命令

**特点**：
- 命令不进队列，立即响应
- 任务执行中也能立即查看状态
- 支持简化命令（如 `/switch`）和完整命令（如 `/project switch`）
- 模型列表启动时自动从 API 获取，失败时使用默认列表

详见 [多项目支持文档](./docs/multi-project-and-commands.md)

### 会话持久化

三层持久化机制：

1. **数据库持久化**（SQLite）
   - 位置：`./data/sessions.db`
   - 存储：会话 ID、项目路径、活跃状态、时间戳
   - 字段：`claude_session_id` 用于恢复会话

2. **会话文件持久化**（JSONL）
   - 位置：`{projectPath}/.claude/*.jsonl`
   - 存储：完整对话历史、工具调用记录、上下文信息
   - 管理：由 Claude Agent SDK 自动管理

3. **自动恢复**
   - 服务重启后从数据库读取 `claudeSessionId`
   - 通过 `resume` 参数恢复会话
   - 用户无感知，就像没有重启过一样

**验证方法**：
```bash
# 检查数据库
sqlite3 data/sessions.db "SELECT channel, channel_id, claude_session_id FROM sessions;"

# 检查会话文件
ls -lh {projectPath}/.claude/*.jsonl

# 测试重启恢复
bash evolclaw.sh restart
# 发送消息验证会话继续
```

详见 [会话持久化文档](./docs/session-persistence.md)

### 消息处理架构

**Channel Adapter 模式**：
- 渠道只负责收发消息，不处理事件
- 统一的 `MessageProcessor` 处理所有渠道消息
- 新增渠道只需 ~15 行代码

**中断机制**：
- 新消息到达时立即中断当前任务
- 使用统一的 streamKey 格式：`${channel}-${channelId}`
- 中断延迟 <1 秒

**批量发送**：
- 工具调用活动在 3 秒窗口内批量发送
- 减少消息数量，提升用户体验
- Compact 通知等系统消息立即发送（绕过批量）

**文件处理**（Feishu）：
- 接收文件：自动下载到 `{projectPath}/.claude/uploads/`
- 发送文件：使用 `[SEND_FILE:路径]` 标记
- 标记自动隐藏：系统自动移除标记，用户看不到

### 实例管理
- 实例池：最多 20 个并发实例
- 自动清理：空闲 30 分钟回收
- 状态流转：IDLE → BUSY → IDLE

### 消息队列
- 会话级串行：保证消息顺序
- 跨会话并发：提高处理效率
- 去重机制：防止重复处理
- 中断支持：新消息立即中断当前任务

### Hook 驱动监控

基于 Claude Agent SDK 的 Hook 机制：
- **Stop Hook**：对话结束同步点（100% 可靠）
- **PostToolUse Hook**：工具调用监控
- **SubagentStart/Stop Hook**：子 Agent 生命周期
- **Notification Hook**：系统通知处理
- **Compact Hook**：会话压缩通知

**关键发现**：Stop Hook 是唯一 100% 可靠的同步点，覆盖所有场景（纯文本 + 工具调用）。

详见 [架构设计文档](./docs/architecture.md)

## 测试

```bash
# 运行所有测试
npm test

# 监听模式
npm run test:watch

# 测试覆盖率
npm test -- --coverage

# Hook 测试
npm run test:hooks
```

测试结构：
- `tests/unit/` - 单元测试（消息队列、会话管理、数据库）
- `tests/integration/` - 集成测试（Feishu、ACP、端到端）
- `tests/test-sdk-hooks.ts` - SDK Hook 验证测试
- `tests/test-multi-session.ts` - 多会话管理测试

**重要**：测试必须使用独立目录（如 `./data/test-db/`），不能使用 `./data/` 以避免删除生产配置。

## 监控与指标

查看实例状态：
```bash
curl http://localhost:3000/metrics
```

系统自动收集 Hook 事件（Stop、PostToolUse、SubagentStart/Stop、Notification），基于 Hook 活动时间进行超时检测和状态恢复。

详见 [架构设计文档](./docs/architecture.md)

## 故障恢复机制

### 自动重试
- 最多 3 次重试
- 指数退避策略（1s, 2s, 4s）
- 适用于临时性错误

### 实例重启
- 进程崩溃自动重启
- 最多 5 次重启尝试
- 冷却时间 60 秒

### 熔断保护
- 连续失败达到阈值时触发熔断
- 半开状态定期尝试恢复
- 避免资源浪费和级联故障

### 资源清理
- 空闲超时：30 分钟
- 自动清理空闲实例
- 释放系统资源

## 技术栈

- **运行时**：Node.js + TypeScript
- **AI SDK**：@anthropic-ai/claude-agent-sdk
- **消息渠道**：
  - 飞书：@larksuiteoapi/node-sdk
  - ACP：acp-ts
- **数据存储**：better-sqlite3
- **测试框架**：Vitest

## 文档

- [CLAUDE.md](./CLAUDE.md) - 开发指南（给 Claude Code 使用）
- [架构设计文档](./docs/architecture.md) - 详细的系统架构和技术实现
- [多项目支持](./docs/multi-project-and-commands.md) - 多项目管理和斜杠命令
- [会话持久化](./docs/session-persistence.md) - 会话持久化机制说明
- [多会话设计](./docs/multi-session-design.md) - 多会话管理设计文档
- [完整设计文档](./DESIGN-v2.md) - 设计文档 v2.0
- [Bug 修复总结](./BUG_FIXES_2026-03-10.md) - 2026-03-10 修复的 Bug
- [Git 提交总结](./GIT_SUMMARY_2026-03-10.md) - 2026-03-10 提交记录

## 开发状态

### ✅ 已完成（2026-03-11）

**模型管理**：
- 动态获取可用模型列表（启动时从 Anthropic API 获取）
- `/model` 命令支持查看和切换模型
- API 失败时使用默认模型列表作为后备

**Bug 修复**：
- 修复 `/switch` 重复切换提示问题（路径规范化比较）
- 修复命令处理前导空格问题（trim 处理）

### ✅ 已完成（2026-03-10）

**架构重构**：
- 统一消息处理架构（MessageProcessor + Channel Adapter）
- 消除 ~250 行重复代码
- 新增渠道只需 ~15 行代码

**关键 Bug 修复**：
- 测试删除生产数据（使用独立测试目录）
- 消息重复发送（统一 flush 逻辑）
- 工具调用后文本消失（移除条件检查）
- 中断机制失效（统一 streamKey 格式）
- 命令延迟响应（命令绕过队列）
- 文件标记可见（自动过滤）

**功能改进**：
- 会话持久化验证（SQLite + JSONL）
- 命令立即响应
- 任务中断支持
- 批量发送（3 秒窗口）

**测试**：
- 所有 107 个测试通过
- 测试隔离（独立目录）
- Hook 验证测试
- 多会话管理测试

### 🚧 开发中

- ACP 协议完整集成
- 监控面板
- 更多测试用例

## 许可证

MIT
