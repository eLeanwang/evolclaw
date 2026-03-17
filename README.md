# EvolClaw

轻量级多终端接力开发工具，支持飞书和 ACP 双渠道接入，基于 Claude Agent SDK 构建。

## 核心特性

- 🔄 **多终端接力**：跨终端共享会话、环境、工具、skills，无缝切换开发体验
- 🚀 **轻量化设计**：进程模式运行，无容器依赖
- 🎯 **直接集成**：基于 Claude Agent SDK，无需 ACP 协议转换层
- 📊 **统一消息处理**：Channel Adapter 模式，新增渠道只需 ~15 行代码
- 🌐 **双渠道接入**：飞书 WebSocket + ACP 协议
- 📁 **多项目支持**：每个项目独立会话，支持动态切换
- 💾 **会话持久化**：SQLite + JSONL 双重保障，服务重启不丢失会话
- ⚡ **任务中断**：新消息立即中断当前任务，响应更快
- 📦 **批量发送**：工具调用活动 3 秒批量发送，减少消息数量
- 🤖 **动态模型管理**：启动时自动获取可用模型列表，支持运行时切换
- 🔕 **后台任务静默**：切换项目后，后台任务输出自动静默，不干扰当前工作
- 📬 **消息缓存**：后台任务完成后缓存通知，切换回项目时统一展示

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

EvolClaw 是一个**轻量级多终端接力开发工具**，基于 Claude Agent SDK 实现。

### 核心价值

**多终端接力开发**：支持在不同终端（飞书、命令行、Web 等）间无缝切换，共享会话、环境、工具、skills 等一切资源，最大化还原不同终端的开发体验。

**技术架构**：
```
evolclaw → Claude Agent SDK → Claude API
```

与 ACPX 等基于 ACP 协议的工具不同，evolclaw 直接使用 Claude Agent SDK，架构更简洁：
- **无协议转换**：直接调用 Claude API，无需 ACP 协议层
- **无外部依赖**：不依赖其他 CLI 工具的 ACP 支持
- **完全自主**：可自定义所有功能、工具和会话管理
- **专注场景**：针对多终端接力开发优化

### 与其他项目对比

| 特性 | EvolClaw | ACPX | HappyClaw |
|------|----------|------|-----------|
| **定位** | 多终端接力开发 | 代理编排工具 | 自托管 AI Agent |
| **技术栈** | Claude Agent SDK | ACP 协议客户端 | 完整系统 |
| **架构** | SDK → API | 管道 → CLI → API | Docker 容器 |
| **依赖** | 无外部依赖 | 需 CLI 支持 ACP | 容器环境 |
| **消息渠道** | 2 个（飞书、ACP） | 编排多个 Agent | 3 个（飞书、Telegram、Web） |
| **代码规模** | ~1500 行 | 协议客户端 | 完整系统 |
| **适用场景** | 个人多终端开发 | Agent 间通信 | 个人/团队协作 |

## 系统架构

```
消息渠道层 → 消息队列层 → 命令处理层 → 消息处理层 → 会话管理层 → 存储层
```

### 核心组件

1. **消息渠道层** (`src/channels/`) - Feishu WebSocket + ACP 协议
2. **消息队列层** (`src/core/message-queue.ts`) - 会话级串行处理 + 中断支持
3. **命令处理层** (`src/core/command-handler.ts`) - 斜杠命令处理（CommandHandler 类）
4. **消息处理层** (`src/core/message-processor.ts`) - 统一事件处理引擎
5. **会话管理层** (`src/core/session-manager.ts`) - 多项目会话管理
6. **存储层** - JSONL 文件（SDK 管理）+ SQLite 元数据

### 消息流转

```
用户发送消息
    ↓
Channel.onMessage
    ↓
检查命令 → 是 → CommandHandler.handle() → 立即响应（绕过队列）
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
│   ├── core/
│   │   ├── command-handler.ts       # 斜杠命令处理（CommandHandler 类）
│   │   ├── session-manager.ts       # 会话管理（多项目支持）
│   │   ├── message-queue.ts         # 消息队列（会话级串行+中断）
│   │   ├── message-processor.ts     # 统一消息处理引擎
│   │   ├── stream-flusher.ts        # 批量发送（3秒窗口）
│   │   ├── agent-runner.ts          # Claude Agent SDK 调用封装
│   │   └── message-cache.ts         # 消息缓存
│   ├── channels/
│   │   ├── feishu.ts               # 飞书 WebSocket 渠道
│   │   └── acp.ts                  # ACP 协议渠道
│   ├── utils/                      # 工具函数
│   ├── types.ts                    # 类型定义
│   ├── config.ts                   # 配置加载
│   └── index.ts                    # 主入口（~320行，初始化+接线）
├── tests/
│   ├── unit/                       # 单元测试
│   └── integration/                # 集成测试
├── data/
│   ├── config.json                 # 配置文件（不在 git）
│   ├── config.sample.json          # 配置模板
│   └── sessions.db                 # 会话数据库
├── docs/                           # 文档目录
└── logs/                           # 日志目录
```

## 核心功能

### 多项目支持

每个项目独立会话，支持动态切换：

- **项目绑定**：每个聊天会话可绑定到不同项目目录
- **会话隔离**：每个项目有独立的 `.claude/` 目录和会话历史
- **会话保留**：切换项目时保留各项目的会话历史
- **动态切换**：通过命令随时切换工作项目
- **后台任务静默**：切换项目后，原项目的任务输出自动静默，不干扰当前工作
- **消息缓存通知**：后台任务完成后，切换回项目时会显示缓存的完成通知

#### 后台任务处理

当用户在项目 A 执行任务时切换到项目 B：

1. **输出静默**：项目 A 的工具调用和中间输出不再显示
2. **任务继续**：项目 A 的任务在后台继续执行
3. **完成通知**：任务完成后，通知会缓存起来
4. **切换回显**：切换回项目 A 时，显示缓存的通知消息

**示例**：
```
用户: [在 projectA] 帮我分析代码
系统: 正在读取文件...
用户: /switch projectB
系统: ✓ 已切换到项目: projectB
[projectA 的输出被静默]
用户: /switch projectA
系统: ✓ 已切换到项目: projectA
系统: 📬 有 1 条新消息
系统: [后台-projectA] ✓ 任务完成
```

详见 [后台任务输出修复文档](./docs/BACKGROUND_TASK_OUTPUT_FIX.md) 和 [消息缓存需求文档](./docs/REQUIREMENT_1_MESSAGE_CACHE.md)

### 斜杠命令

支持项目和会话管理命令：

**项目管理**：
- `/pwd` - 显示当前项目路径
- `/plist` - 列出所有项目（显示会话空闲时间）
- `/p <name|path>`, `/project <name|path>` - 切换项目（保留会话历史）
- `/bind <path>` - 绑定新项目目录

**会话管理**：
- `/new [名称]` - 创建新会话（可选命名）
- `/slist` - 列出当前项目的所有会话
- `/s <名称>`, `/session <名称>` - 切换到指定会话
- `/name <新名称>`, `/rename <新名称>` - 重命名当前会话
- `/status` - 显示会话状态（渠道、ID、项目、时间戳）
- `/clear` - 清空当前会话的对话历史
- `/compact` - 压缩会话上下文（减少 token 用量）
- `/stop` - 中断当前任务
- `/restart` - 重启服务

**会话修复**：
- `/repair` - 检查并修复会话
- `/safe` - 进入安全模式

**模型管理**：
- `/model` - 显示当前模型和可用模型列表
- `/model <model-id>` - 切换到指定模型（如 `/model claude-opus-4-6`）

**帮助**：
- `/help` - 显示所有可用命令

**特点**：
- 命令不进队列，立即响应（由 `CommandHandler` 处理）
- 任务执行中也能立即查看状态
- 支持命令别名（`/p` = `/project`，`/s` = `/session`，`/name` = `/rename`）

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

### 消息队列
- 会话级串行：保证消息顺序
- 跨会话并发：提高处理效率
- 去重机制：防止重复处理
- 中断支持：新消息立即中断当前任务

详见 [架构设计文档](./docs/architecture.md)

## 测试

```bash
npm test              # 运行所有测试
npm run test:watch    # 监听模式
npm test -- --coverage  # 覆盖率
```

## 技术栈

- **运行时**：Node.js + TypeScript
- **AI SDK**：@anthropic-ai/claude-agent-sdk
- **消息渠道**：飞书（@larksuiteoapi/node-sdk）
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

**后台任务与消息缓存**：
- 后台任务输出静默（切换项目后自动停止输出）
- 消息缓存机制（后台任务完成通知缓存）
- 切换回项目时显示缓存消息数量和内容
- 动态判断任务前后台状态（实时感知项目切换）

**Bug 修复**：
- 修复后台任务输出泄漏问题（动态判断 isBackground）
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

- 更多测试用例

## 许可证

MIT
