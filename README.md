# EvolClaw

> 把 Claude Code 装进飞书和微信 —— 随时随地，接力开发

EvolClaw 是一个轻量级 AI Agent 网关，基于 Claude Agent SDK 构建。它将终端中的 Claude Code 能力延伸到飞书、微信等即时通讯工具，让你在手机上也能review 代码、调试问题、管理项目，真正实现多终端无缝接力开发。

## 核心特性

- **多端会话接力**：跨终端共享会话、环境、项目，无缝切换开发体验
- **配置自动继承**：复用 CLI 环境的 API Key/URL、记忆文件、MCP/Skills 插件，零额外配置
- **轻量化设计**：进程模式运行，CLI 命令行管理，无端口开放，无容器依赖，无 UI 界面
- **多项目支持**：每个项目独立会话，支持动态切换
- **双模式会话**：私聊会话隔离互不干扰，群聊会话共享协同协作
- **多渠道接入**：Channel Adapter 模式，飞书 + 微信扫码一键接入
- **分层权限**：用户级/管理员级命令分离，多用户安全隔离
- **统一消息处理**：消息处理与渠道解耦，新增渠道仅需 ~15 行代码
- **会话持久化**：会话数据与 CLI 工具共享，不额外存储，服务重启不丢失
- **执行中插入**：任务执行中可发送新消息，自动中断当前任务并处理新请求
- **消息智能发送**：前台任务动态聚合批量发送，后台任务静默完成后通知
- **健壮性保障**：任务超时提醒、会话异常安全模式修复、重启失败自动自愈

## 适合场景

- **通勤路上**：手机打开飞书，继续昨晚的代码 review，到公司无缝切回终端
- **会议间隙**：微信快速问一句「这个接口的返回格式是什么」，Agent 直接查代码回复
- **下班之后**：躺在沙发上用手机跟进 CI 报错，让 Agent 定位问题并修复
- **外出离开工位**：不带电脑也能通过 IM 给 Agent 下达任务，回来看结果
- **团队协作**：拉个飞书群，成员共享同一个 Agent 会话，一起讨论和调试

## 系统架构

```
消息渠道层 → 消息队列层 → 命令处理层 → 消息处理层 → 会话管理层 → 存储层
```

### 核心组件

1. **消息渠道层** (`src/channels/`) - Feishu WebSocket + WeChat HTTP 长轮询
2. **消息队列层** (`src/core/message-queue.ts`) - 会话级串行处理 + 中断支持
3. **命令处理层** (`src/core/command-handler.ts`) - 斜杠命令处理（CommandHandler 类）
4. **消息处理层** (`src/core/message-processor.ts`) - 统一事件处理引擎
5. **会话管理层** (`src/core/session-manager.ts`) - 多项目会话管理
6. **会话存储层** - JSONL 文件（CLI 共用）+ SQLite 元数据

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

## 快速开始

### 环境要求

- **操作系统**：macOS / Linux（Windows 暂不支持，见 TODO）
- **Node.js** >= 22（需要 node:sqlite 内置模块支持）
- **Claude Code** >= 2.1.32（`npm install -g @anthropic-ai/claude-code`）

### 1. 安装

**npm 全局安装**（推荐）：

```bash
npm install -g evolclaw
```

**从源码安装**：

```bash
git clone https://github.com/eLeanwang/evolclaw.git
cd evolclaw
npm install
npm run build
npm link
```

### 2. 初始化

```bash
# 完整初始化（选择飞书或微信）
evolclaw init

# 单独配置飞书（扫码登录）
evolclaw init feishu

# 单独配置微信（扫码登录）
evolclaw init wechat
```

交互式引导完成以下配置：
- 环境检查（Node.js >= 22、claude CLI、SDK 版本）
- 渠道选择（飞书/微信）并扫码登录
- 默认项目路径
- 模型选择（sonnet/opus/haiku）
- 自动写入 `EVOLCLAW_HOME` 到 shell profile

配置文件生成在 `{EVOLCLAW_HOME}/data/evolclaw.json`（默认 `~/.evolclaw/data/evolclaw.json`）。

### 补充配置（可选）

以下参数不包含在 `evolclaw init` 交互流程中，需要手动编辑 `evolclaw.json`：

```jsonc
{
  "projects": {
    "autoCreate": true                          // 绑定不存在的项目路径时自动创建目录
  },
  "idleMonitor": {
    "enabled": true,                            // 任务超时监控开关
    "timeout": 120000,                          // 超时阈值（ms），默认 2 分钟
    "safeModeThreshold": 3                      // 连续超时 N 次后进入安全模式（设为 0 禁用安全模式）
  },
  "flushDelay": 4000                            // 工具活动消息聚合发送间隔（ms），默认 4 秒
}
```

**API 继承机制**：`agents.anthropic` 整个 section 可省略，系统自动按以下优先级继承：
- `apiKey`：配置文件 → `ANTHROPIC_AUTH_TOKEN` 环境变量 → `~/.claude/settings.json`
- `baseUrl`：配置文件 → `ANTHROPIC_BASE_URL` 环境变量 → `~/.claude/settings.json`
- `model`：配置文件 → `~/.claude/settings.json` → 默认 `sonnet`

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
│   │   └── wechat.ts               # 微信 ClawBot 渠道
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

### 用户级命令（所有用户可用）

**会话管理**：
- `/new [名称]` - 创建新会话
- `/slist` - 列出当前项目的所有会话
- `/s <名称>` - 切换到指定会话
- `/name <新名称>` - 重命名当前会话
- `/status` - 显示会话状态
- `/help` - 显示所有命令

### 管理员级命令（仅 Owner 可用）

**项目管理**：
- `/pwd` - 显示当前项目路径
- `/plist` - 列出所有项目（显示会话空闲时间）
- `/p <name|path>` - 切换项目（保留会话历史）
- `/bind <path>` - 绑定新项目目录

**系统管理**：
- `/clear` - 清空对话历史
- `/compact` - 压缩会话上下文
- `/stop` - 中断当前任务
- `/restart` - 重启服务（自愈机制）
- `/repair` - 检查并修复会话
- `/safe` - 进入安全模式

**模型管理**：
- `/model` - 显示当前模型和可用列表
- `/model <model-id>` - 切换模型

## TODO

- [ ] Windows 系统 CLI 命令支持
- [ ] 微信插件支持图片/文件的收发
- [ ] 自动授权可配置（自动放行/自动拒绝）
- [ ] 手动授权支持（飞书卡片/文本回复）
- [ ] ACP 协议支持（接入 Codex / Gemini CLI）

## 技术栈

- **运行时**：Node.js >= 22 + TypeScript（ES modules）
- **AI SDK**：@anthropic-ai/claude-agent-sdk >= 0.2.75
- **消息渠道**：飞书（@larksuiteoapi/node-sdk）、微信（ClawBot ilink API）
- **数据存储**：node:sqlite（内置模块）+ JSONL（CLI 共用）
- **测试框架**：Vitest


## 许可证

[MIT](LICENSE)
