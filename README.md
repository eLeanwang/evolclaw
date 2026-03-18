# EvolClaw

轻量级多终端接力开发工具，支持飞书和 AUN 双渠道接入，基于 Claude Agent SDK 构建。

## 核心特性

- 🔄 **多终端接力**：跨终端共享会话、环境、工具、skills，无缝切换开发体验
- 🚀 **轻量化设计**：进程模式运行，无容器依赖
- 🎯 **直接集成**：基于 Claude Agent SDK，无需协议转换层
- 📊 **统一消息处理**：Channel Adapter 模式，新增渠道只需 ~15 行代码
- 🌐 **双渠道接入**：飞书 WebSocket + AUN 协议
- 📁 **多项目支持**：每个项目独立会话，支持动态切换
- 💾 **会话持久化**：SQLite + JSONL 双重保障，服务重启不丢失会话
- ⚡ **任务中断**：新消息立即中断当前任务，响应更快
- 📦 **批量发送**：工具调用活动 3 秒批量发送，减少消息数量
- 🤖 **动态模型管理**：启动时自动获取可用模型列表，支持运行时切换
- 🔕 **后台任务静默**：切换项目后，后台任务输出自动静默，不干扰当前工作
- 📬 **消息缓存**：后台任务完成后缓存通知，切换回项目时统一展示

## 快速开始

### 1. 安装

```bash
npm install
npm run build
npm link
```

### 2. 初始化

```bash
evolclaw init
```

交互式引导完成以下配置：
- 环境检查（Node.js >= 22、claude CLI、SDK 版本）
- 飞书 App ID / App Secret
- 默认项目路径
- 模型选择（sonnet/opus/haiku）
- 自动写入 `EVOLCLAW_HOME` 到 shell profile

配置文件生成在 `{EVOLCLAW_HOME}/data/evolclaw.json`（默认 `~/.evolclaw/data/evolclaw.json`）。

### 3. 运行

```bash
# 服务管理
evolclaw start      # 启动服务
evolclaw stop       # 停止服务
evolclaw restart    # 重启服务
evolclaw status     # 查看状态
evolclaw logs       # 查看日志（tail -f）

# 开发模式（热重载）
npm run dev

# 运行测试
npm test
```

## 系统架构

```
消息渠道层 → 消息队列层 → 命令处理层 → 消息处理层 → 会话管理层 → 存储层
```

### 核心组件

1. **消息渠道层** (`src/channels/`) - Feishu WebSocket + AUN 协议
2. **消息队列层** (`src/core/message-queue.ts`) - 会话级串行处理 + 中断支持
3. **命令处理层** (`src/core/command-handler.ts`) - 斜杠命令处理（CommandHandler 类）
4. **消息处理层** (`src/core/message-processor.ts`) - 统一事件处理引擎
5. **会话管理层** (`src/core/session-manager.ts`) - 多项目会话管理
6. **存储层** - JSONL 文件（SDK 管理）+ SQLite 元数据

### 数据目录

```
{EVOLCLAW_HOME}/                # 默认: ~/.evolclaw
├── data/
│   ├── evolclaw.json           # 配置文件（含密钥，不在 git）
│   ├── evolclaw.sample.json    # 配置模板
│   └── sessions.db             # 会话数据库
└── logs/
    ├── evolclaw.pid            # PID 文件
    ├── evolclaw.log            # 主日志
    ├── stdout.log              # 标准输出
    └── messages.log            # 消息日志
```

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
├─ 处理事件（tool_use / text / result）
├─ 提取文件标记（Feishu）
└─ 发送最终响应
```

## 项目结构

```
evolclaw/
├── bin/
│   └── evolclaw                    # CLI 入口（npm link）
├── src/
│   ├── core/
│   │   ├── command-handler.ts       # 斜杠命令处理
│   │   ├── session-manager.ts       # 会话管理（多项目支持）
│   │   ├── message-queue.ts         # 消息队列（串行+中断）
│   │   ├── message-processor.ts     # 统一消息处理引擎
│   │   ├── stream-flusher.ts        # 批量发送（3秒窗口）
│   │   ├── agent-runner.ts          # Claude Agent SDK 封装
│   │   └── message-cache.ts         # 消息缓存
│   ├── channels/
│   │   ├── feishu.ts               # 飞书 WebSocket 渠道
│   │   └── aun.ts                  # AUN 协议渠道
│   ├── utils/                      # 工具函数
│   ├── types.ts                    # 类型定义
│   ├── config.ts                   # 配置加载
│   ├── paths.ts                    # 路径解析
│   ├── cli.ts                      # CLI 命令（init/start/stop/...）
│   └── index.ts                    # 主入口
└── data/
    └── evolclaw.sample.json        # 配置模板
```

## 斜杠命令

**项目管理**：
- `/pwd` - 显示当前项目路径
- `/plist` - 列出所有项目（显示会话空闲时间）
- `/p <name|path>` - 切换项目（保留会话历史）
- `/bind <path>` - 绑定新项目目录

**会话管理**：
- `/new [名称]` - 创建新会话
- `/slist` - 列出当前项目的所有会话
- `/s <名称>` - 切换到指定会话
- `/name <新名称>` - 重命名当前会话
- `/status` - 显示会话状态
- `/clear` - 清空对话历史
- `/compact` - 压缩会话上下文
- `/stop` - 中断当前任务
- `/restart` - 重启服务

**模型管理**：
- `/model` - 显示当前模型和可用列表
- `/model <model-id>` - 切换模型

**其他**：
- `/repair` - 检查并修复会话
- `/safe` - 进入安全模式
- `/help` - 显示所有命令

## 技术栈

- **运行时**：Node.js >= 22 + TypeScript（ES modules）
- **AI SDK**：@anthropic-ai/claude-agent-sdk >= 0.2.75
- **消息渠道**：飞书（@larksuiteoapi/node-sdk）
- **数据存储**：node:sqlite（内置模块）
- **测试框架**：Vitest

## 文档

- [CLAUDE.md](./CLAUDE.md) - 开发指南
- [架构设计](./docs/architecture.md) - 系统架构和技术实现
- [多项目支持](./docs/multi-project-and-commands.md) - 多项目管理和命令
- [多会话设计](./docs/multi-session-design.md) - 多会话管理设计
- [设计文档 v2](./docs/DESIGN-v2.md) - 完整设计文档

## 许可证

MIT
