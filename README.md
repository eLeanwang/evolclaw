# EvolClaw

> AI Agent 统一网关 —— 连接 IM、终端、Agent 网络

EvolClaw 是一个轻量级 AI Agent 网关系统。它为 Claude Code / Codex 等 Coding Agent 提供统一接入层，使其作为通用基座 Agent，接入到飞书、微信、钉钉、QQ频道、企业微信等多种 IM 通道，以及 AUN 多智能体网络。人类可以通过手机 IM 随时接力开发，其他 Agent 也可以通过 AUN 网络直接调用你的 Agent —— 不只是人机交互，也是 Agent 间协作的基础设施。

## 核心特性

- 🔄 **多端会话接力**：跨终端共享会话、环境、项目，无缝切换开发体验
- ♻️ **配置自动继承**：复用 CLI 环境的 API Key/URL、记忆文件、MCP/Skills 插件，零额外配置
- 🚀 **轻量化设计**：进程模式运行，CLI 命令行管理，无端口开放，无容器依赖，无 UI 界面
- 📁 **多项目支持**：每个项目独立会话，支持动态切换
- 👥 **双模式会话**：多用户私聊会话隔离，群聊会话共享，满足不同协作场景
- 🌐 **多渠道接入**：Channel Adapter 模式，飞书 + 微信 + 钉钉 + QQ频道 + 企业微信 + AUN 网络
- 🤖 **Agent 间互联**：通过 AUN 网络，你的 Agent 可被其他 Agent 发现和调用
- 🔐 **分层权限**：三级权限体系（user/admin/owner），多用户安全隔离
- 🛠️ **Agent 自管理**：Agent 可通过 CLI 命令自主管理运行时（查看状态、切换模型、调整配置等）
- 📦 **项目搬家**：`evolclaw mv` 一键迁移项目目录，保留 Claude/Codex/EvolClaw 全部会话历史
- 💾 **会话持久化**：会话数据与 CLI 工具共享，不额外存储，服务重启不丢失
- ⚡ **执行中插入**：任务执行中可发送新消息，自动中断当前任务并处理新请求
- 🔕 **消息智能发送**：前台任务动态聚合批量发送，后台任务静默完成后通知
- 🧩 **EvolAgent 多实例**：一个 JSON 文件定义一个 Agent（channels + baseagent + project），多 Agent 并发运行，Agent 运行时隔离 + 热重载无需重启
- 🔔 **AI 自主触发器**：Agent 可设置延迟 / 定时 / 周期任务，cron 表达式支持，独立 silent session 执行
- 🎴 **交互卡片体系**：CommandCard（按钮直接触发 slash 命令）+ ActionInteraction（按钮回写交互），Feishu 与 AUN 统一支持
- 🤖 **健壮性保障**：任务超时提醒、会话异常安全模式修复、重启失败自动自愈

## 适合场景

- **通勤路上**：手机打开飞书，继续昨晚的代码 review，到公司无缝切回终端
- **会议间隙**：微信快速问一句「这个接口的返回格式是什么」，Agent 直接查代码回复
- **Agent 协作**：通过 AUN 网络，让你的 Agent 被其他 Agent 调用，组成分布式协作
- **外出离开工位**：不带电脑也能通过 IM 给 Agent 下达任务，回来看结果
- **团队协作**：拉个飞书群，成员共享同一个 Agent 会话，一起讨论和调试

## 系统架构

```
消息渠道层 → 消息队列层 → 命令处理层 → 消息处理层 → 会话管理层 → 存储层
```

### 核心组件

1. **消息渠道层** (`src/channels/`) - Feishu + WeChat + DingTalk + QQBot + WeCom + AUN 网络
2. **消息队列层** (`src/core/message/message-queue.ts`) - 会话级串行处理 + 中断支持
3. **命令处理层** (`src/core/command/`) - 斜杠命令处理（slash-handler / menu-handler / command-handler）
4. **消息处理层** (`src/core/message/message-processor.ts`) - 统一事件处理引擎
5. **会话管理层** (`src/core/session/session-manager.ts`) - 多项目会话管理
6. **交互路由层** (`src/core/interaction-router.ts`) - 卡片交互回调注册与路由
7. **会话存储层** - JSONL 文件（CLI 共用）+ 文件系统（每 chat 一个目录，含 active.json / meta_*.jsonl / messages.jsonl / health.jsonl）

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

- **操作系统**：macOS / Linux / Windows
- **Node.js** >= 18
- **Claude Code** >= 2.1.32（`npm install -g @anthropic-ai/claude-code`）

### 1. 安装

**npm 全局安装**（推荐）：

```bash
npm install -g evolclaw
```

> **Windows 用户**：首次运行前可能需要执行 `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`

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

# 单独配置钉钉（扫码登录）
evolclaw init dingtalk

# 单独配置 QQ 频道（扫码登录）
evolclaw init qqbot

# 单独配置企业微信（手动输入 Bot ID + Secret）
evolclaw init wecom

# 单独配置 AUN（Mesh 网络通道）
evolclaw init aun
```

交互式引导完成以下配置：
- 环境检查（Node.js >= 22、claude CLI、SDK 版本）
- 渠道选择（飞书/微信）并扫码登录
- 默认项目路径
- 模型选择（sonnet/opus/haiku）
- 自动写入 `EVOLCLAW_HOME` 到 shell profile（Unix）或用户环境变量（Windows）

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
    "timeout": 120,                             // 超时阈值（秒），默认 120 秒
    "safeModeThreshold": 3                      // 连续超时 N 次后进入安全模式（设为 0 禁用安全模式）
  },
  "flushDelay": 4                               // 工具活动消息聚合发送间隔（秒），默认 4 秒
}
```

**API 继承机制**：`agents.claude` 整个 section 可省略，系统自动按以下优先级继承：
- `apiKey`：配置文件 → `ANTHROPIC_AUTH_TOKEN` 环境变量 → `~/.claude/settings.json`
- `baseUrl`：配置文件 → `ANTHROPIC_BASE_URL` 环境变量 → `~/.claude/settings.json`
- `model`：配置文件 → `~/.claude/settings.json` → 默认 `sonnet`
- `effort`：配置文件 → `~/.claude/settings.json` → SDK 默认值（`auto`）

### 3. 运行

```bash
# 服务管理
evolclaw start      # 启动服务
evolclaw stop       # 停止服务
evolclaw restart    # 重启服务
evolclaw status     # 查看状态
evolclaw logs       # 查看日志（tail -f）
evolclaw agent      # 管理 EvolAgent（list / show / new / reload）
evolclaw mv <old> <new>  # 项目搬家（保留全部会话）
evolclaw diagnose   # 诊断启动环境

# 开发模式（热重载）
npm run dev

# 运行测试
npm test
```

## 项目结构

```
evolclaw/
├── src/
│   ├── agents/
│   │   ├── claude-runner.ts        # Claude Agent SDK 封装
│   │   ├── codex-runner.ts         # Codex Agent 封装
│   │   └── gemini-runner.ts        # Gemini CLI 封装
│   ├── aun/                        # AUN 协议工具
│   ├── core/
│   │   ├── command/
│   │   │   ├── command-handler.ts  # 命令派发入口
│   │   │   ├── slash-handler.ts    # 斜杠命令实现
│   │   │   ├── menu-handler.ts     # Menu 协议处理
│   │   │   └── slash-gate.ts       # 权限前置拦截
│   │   ├── message/
│   │   │   ├── message-bridge.ts   # 渠道 ↔ 核心消息桥
│   │   │   ├── message-processor.ts # 统一消息处理引擎
│   │   │   ├── message-queue.ts    # 消息队列（串行+中断）
│   │   │   ├── message-cache.ts    # 消息缓存
│   │   │   ├── message-log.ts      # 每 chat 的 messages.jsonl
│   │   │   └── im-renderer.ts      # IM 渲染 + 批量发送
│   │   ├── session/
│   │   │   ├── adapters/           # 各后端会话文件适配器
│   │   │   ├── session-fs-store.ts # 文件系统存储原语
│   │   │   └── session-manager.ts  # 会话管理（多项目支持）
│   │   ├── trigger/                # 触发器引擎
│   │   ├── evolagent.ts            # EvolAgent 实体
│   │   ├── evolagent-registry.ts   # Agent 注册表（扫描/路由/热重载）
│   │   ├── interaction-router.ts   # 卡片交互回调路由
│   │   └── permission.ts           # 权限网关
│   ├── channels/
│   │   ├── feishu.ts               # 飞书 WebSocket 渠道
│   │   ├── wechat.ts               # 微信 ClawBot 渠道
│   │   ├── dingtalk.ts             # 钉钉 Stream 渠道
│   │   ├── qqbot.ts                # QQ 频道渠道
│   │   ├── wecom.ts                # 企业微信 AI Bot 渠道
│   │   └── aun.ts                  # AUN Mesh 网络渠道
│   ├── cli/                        # CLI 命令
│   ├── utils/                      # 工具函数
│   ├── types.ts                    # 类型定义
│   ├── config-store.ts             # 配置加载
│   ├── paths.ts                    # 路径解析
│   └── index.ts                    # 主入口
└── kits/                           # 共享上下文模板
```

## 斜杠命令

### 用户级命令（所有用户可用）

**会话管理**：
- `/new [名称]` - 创建新会话
- `/slist` - 列出当前项目的所有会话
- `/slist cli` - 列出未导入的 CLI 会话
- `/s <名称|序号|uuid>` - 切换到指定会话
- `/name <新名称>` - 重命名当前会话
- `/del <名称>` - 删除指定会话（仅解绑，不删除文件）
- `/status` - 显示会话状态
- `/check` - 系统健康检查（摘要）
- `/help` - 显示所有命令

### 管理员级命令（Admin+ 可用）

**项目**：
- `/pwd` - 显示当前项目路径

**Agent 与模型**：
- `/baseagent [name]` - 查看或切换 Agent 后端（claude / codex / gemini）（别名 `/base`）
- `/model [model]` - 查看或切换模型
- `/effort [level]` - 查看或切换推理强度（low / medium / high / max / auto）
- `/perm [mode]` - 查看或切换权限模式（auto / edit / default / readonly）

**系统管理**：
- `/compact` - 压缩会话上下文
- `/rewind <turn>` - 回退会话到指定轮次
- `/stop` - 中断当前任务
- `/check` - 系统健康检查（详情）
- `/activity [all|dm|owner|none]` - 查看/控制中间输出显示模式
- `/chatmode [interactive|proactive]` - 查看/切换会话模式
- `/dispatch [mention|broadcast]` - 群聊分发模式（仅 @ 响应或广播）
- `/trigger <动作> ...` - 设置/查看 AI 自主触发器（延迟/定时/周期）
- `/restart <channel>` - 重连指定渠道

### Owner 专属命令

- `/file <文件路径>` - 发送文件给用户
- `/restart` - 重启服务（自愈机制）
- `/repair` - 检查并修复会话

### ⚠️ 进程级 menu 操作鉴权（v3.2 Breaking）

进程级 menu 操作（`/system restart/upgrade`、`/agent` agent 生命周期管理）的鉴权已迁移到
`evolclaw.json` 顶层 `owners` 字段（v3.2 起，不再读 `agents/defaults.json`）。
升级后**必须**在 `evolclaw.json` 配置 `owners`，否则这些操作一律返回 `FORBIDDEN`（daemon 启动时也会 warn 提示）。

```json
{
  "owners": ["eleans-2022.agentid.pub"]
}
```

`evolclaw init` 交互流程会在生成控制 AID 后提示录入 owners（可跳过后手动编辑）。

- **`owners`**：进程级管理者 AID 名单。可执行 `/system`（重启/升级）与 `/agent`
  （create / delete / enable / disable / list / show）。
- 关系级的 `/trigger`（set / cancel / update / list）仍走 channel 角色（owner/admin）+ scoped 鉴权，**不**受 `owners` 影响。
- `/agent create` 为「受理即返回」：立即回 `{ accepted: true, aid }`，后台跑完整创建流程并把各
  环节写入 `agents/<aid>/create-status.json`；客户端用 `menu.query name=agent args={aid}` 轮询
  `createProgress.status` 直到 `ready` / `failed`。

### 控制 AID（control AID）

v3.2 新增进程级身份标识。启动时自动生成 `ec+5位数字.agentid.pub` 格式的控制 AID，以
`pureIdentity` 模式接入 AUN 网络（跳过 evolagent onboarding）。`evolclaw status` 可查看控制 AID 连接状态。

## 技术栈

- **运行时**：Node.js >= 22 + TypeScript（ES modules）
- **AI 后端**：@anthropic-ai/claude-agent-sdk >= 0.3.170、Codex CLI app-server、Gemini CLI
- **消息渠道**：飞书（@larksuiteoapi/node-sdk）、微信（ClawBot ilink API）、钉钉（dingtalk-stream）、QQ频道（pure-qqbot）、企业微信（AI Bot API）、AUN 网络
- **数据存储**：文件系统（per-chat 目录） + JSONL（CLI 共用）
- **测试框架**：Vitest

## TODO

- [x] AUN Mesh 网络通道接入
- [x] 项目搬家工具（`evolclaw mv`）
- [x] 手动授权支持（文本回复 + 飞书卡片）
- [x] 自动授权可配置（自动放行/自动拒绝）
- [x] 触发器支持
- [ ] AUN 群组扩展功能支持
- [ ] 统计/状态监控 WebHook


## 许可证

MIT — 详见 [LICENSE](LICENSE) 声明

## 交流群

EvolClaw 正在内测中，欢迎加入微信群交流使用体验、反馈问题或参与讨论：

<img src="assets/wechat-group-qr.jpeg" width="300" alt="EvolClaw 内测群二维码" />

> 二维码过期后可在 [Issues](https://github.com/eLeanwang/evolclaw/issues) 中留言，我会更新邀请链接。
