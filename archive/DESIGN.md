# EvolClaw 完整方案设计

## 一、项目定位

### 1.1 什么是 EvolClaw

EvolClaw 是一个**轻量化的 AI Agent 网关系统**，定位于比 HappyClaw 更简洁、更专注的单用户场景。

**核心特点**：
- **轻量化**：进程模式运行，无容器依赖，代码量控制在 ~300 行
- **单用户**：专注个人使用场景，无需复杂的多用户管理
- **双渠道**：支持飞书和 ACP 两个消息渠道
- **Agent 友好**：基于 Claude Code SDK，会话日志对 Agent 透明可读

### 1.2 设计目标

**主要目标**：
1. 提供生产级可靠的消息接入能力
2. 保证消息处理的顺序性和一致性
3. 支持个人助手和团队协作两种使用模式
4. 实现 Agent 友好的会话日志存储

**设计原则**：
- **简单优于复杂**：只实现必要功能，避免过度设计
- **复用优于重造**：优先使用成熟组件（如 HappyClaw 的 Feishu 连接）
- **解耦优于耦合**：通过 Hook 机制实现模块间松耦合

### 1.3 与其他项目的关系

| 特性 | EvolClaw | HappyClaw | OpenClaw |
|------|----------|-----------|----------|
| **定位** | 轻量化网关 | 自托管 AI Agent | 多渠道 AI 网关 |
| **用户模式** | 单用户 | 多用户 RBAC | 单用户/多账号 |
| **运行模式** | 进程 | Docker 容器 | 单容器 |
| **消息渠道** | 2 个（飞书、ACP） | 3 个（飞书、Telegram、Web） | 8+ 个 |
| **代码规模** | ~300 行 | 完整系统 | 完整系统 |
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
│  │ Feishu       │              │ ACP          │         │
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
│              │  (Claude Code 实例)  │                     │
│              └──────────┬──────────┘                     │
└─────────────────────────┼───────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                      存储层                               │
│  ┌──────────────┐              ┌──────────────┐         │
│  │ JSONL 文件   │◄─────Hook────│ 数据库元数据  │         │
│  │ (Agent 友好) │              │ (快速搜索)    │         │
│  └──────────────┘              └──────────────┘         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心模块

**消息渠道层**：
- `FeishuChannel`：复用 HappyClaw 的生产级 Feishu 连接，提供健康检查、自动重连、消息去重、Backfill 机制
- `ACPChannel`：简化的 ACP 客户端，接收来自 ACP 网络的消息

**消息队列层**：
- `MessageQueue`：会话级消息队列，保证同一会话的消息串行处理，避免并发导致的乱序

**会话管理层**：
- `SessionManager`：管理会话映射关系，支持 shared（个人助手）和 isolated（团队协作）两种模式

**实例管理层**：
- `InstanceManager`：管理 Claude Code 实例的生命周期，包括创建、复用、销毁

**存储层**：
- JSONL 文件：由 Claude Code SDK 自动管理，Agent 可直接读取
- 数据库元数据：通过 Hook 机制自动同步，支持快速搜索和统计

### 2.3 技术栈

**运行时**：
- Node.js 22+
- TypeScript

**核心依赖**：
- `@anthropic-ai/claude-agent-sdk`：Claude Code SDK
- `@larksuiteoapi/node-sdk`：飞书 SDK（通过 HappyClaw）
- `@agentclientprotocol/sdk`：ACP 协议
- `better-sqlite3`：轻量级数据库

**项目结构**：
```
evolclaw/
├── src/
│   ├── channels/
│   │   ├── feishu.ts          # 飞书渠道（复用 HappyClaw）
│   │   └── acp.ts             # ACP 渠道
│   ├── core/
│   │   ├── session-manager.ts # 会话管理
│   │   ├── message-queue.ts   # 消息队列
│   │   ├── message-sync.ts    # Hook 驱动同步
│   │   ├── claude-instance.ts # Claude 实例
│   │   └── instance-manager.ts# 实例管理
│   └── index.ts               # 入口
├── config.json                # 配置文件
├── data/
│   └── sessions.db            # 会话数据库
└── package.json
```

---

## 三、核心设计

### 3.1 生产级 Feishu 连接

**设计决策**：复用 HappyClaw 的 `createFeishuConnection()` 工厂函数，而不是自己实现。

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

### 3.2 会话级消息队列

**设计目标**：保证同一会话的消息按顺序处理，避免并发导致的上下文混乱。

**核心机制**：
- 每个会话维护独立的消息队列
- 会话空闲时立即处理新消息
- 会话忙碌时消息入队等待
- 处理完成后自动处理队列中的下一条消息

**特点**：
- 简单实现（~50 行代码）
- 无全局并发限制（保持轻量）
- 会话间可并发处理

### 3.3 会话模式切换

**设计目标**：支持个人助手和团队协作两种使用场景。

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

### 3.4 Hook 驱动的混合式会话日志

**设计目标**：平衡 Agent 友好性和功能完整性。

**存储策略**：
- **JSONL 文件**：Claude Code SDK 自动管理，存储完整消息内容，Agent 可直接读取
- **数据库元数据**：存储消息摘要和索引，支持快速搜索和统计

**同步机制**：
- **PostToolUse Hook**：每次工具使用后触发，增量同步最新消息
- **PreCompact Hook**：上下文压缩前触发，全量同步确保一致性
- **SessionEnd Hook**：会话结束时触发，最终同步

**核心优势**：
- **解耦**：EvolClaw 不需要主动双写，由 SDK Hook 触发同步
- **接近实时**：PostToolUse 后立即同步
- **可靠性**：PreCompact 兜底机制
- **Agent 友好**：JSONL 文件可用 Read/Grep 工具直接访问
- **快速搜索**：数据库索引支持关键词搜索

### 3.5 渠道能力与限制

**认证机制**：

**飞书（Feishu）**：
- 认证方式：App ID + App Secret
- 实现：通过 `@larksuiteoapi/node-sdk` 建立 WebSocket 长连接
- SDK 自动处理：token 获取、刷新、WebSocket 认证
- 配置：`{ "appId": "cli_xxx", "appSecret": "xxx" }`

**ACP**：
- 认证方式：AID（Agent Identity）基于 X.509 数字证书
- 实现：通过 `@agentclientprotocol/sdk` 处理
- 证书管理：从 CA 服务器获取，存储在 `.acp-storage/AIDs/{aid}/`
- 配置：`{ "domain": "aid.pub", "agentName": "evolclaw" }`

**流式返回支持**：

**关键限制**：飞书和 ACP 都**不支持流式消息**。

**处理策略**：
```
Claude SDK 流式输出 → 累积完整响应 → 一次性发送到渠道
```

**实现方式**：
1. 监听 Claude SDK 的 StreamEvent（text_delta、thinking_delta）
2. 累积所有输出到缓冲区
3. 等待响应完成
4. 调用渠道的 `sendMessage()` 一次性发送

**代价**：
- 用户无法看到实时输出
- 需要等待完整响应
- 但保持了轻量化（无需实现流式协议）

**多媒体支持**：

**飞书支持的消息类型**：
- `text`：纯文本
- `post`：富文本（支持格式化）
- `image`：图片（通过 `image_key`）
- `file`：文件（通过 `file_key`）

**MVP 阶段策略**：
- ✅ 支持：纯文本消息
- ⏸️ 暂不支持：图片和文件（需要下载/上传逻辑，增加 ~100 行代码）
- 📋 后续扩展：根据实际需求决定是否实现

**如需支持图片/文件**：

输入侧：
1. 接收飞书的 `image_key` 或 `file_key`
2. 调用飞书 API 下载内容
3. 保存到临时文件
4. 传递给 Claude Code SDK

输出侧：
1. Claude 生成图片/文件
2. 上传到飞书服务器
3. 获取 `file_key`
4. 在消息中引用

**ACP 的多媒体能力**：
- 支持 FileSync（文件同步）
- 可传输 `agent.md` 和公共文件
- 消息中的图片/文件支持需进一步调研

---

## 四、数据流设计

### 4.1 消息处理流程

```
1. 飞书/ACP 消息到达
   ↓
2. MessageQueue 入队（会话级）
   ↓
3. SessionManager 获取/创建会话
   ↓
4. InstanceManager 获取/创建 Claude Code 实例
   ↓
5. Claude Code SDK 处理消息
   ↓
6. SDK 自动写入 JSONL 文件
   ↓
7. PostToolUse Hook 触发
   ↓
8. MessageSync 增量同步到数据库
   ↓
9. 返回结果到消息渠道
```

### 4.2 会话映射策略

**Shared 模式映射**：
```
飞书群 A → feishu-shared → /project/default + session-001
飞书群 B → feishu-shared → /project/default + session-001
飞书群 C → feishu-shared → /project/default + session-001
ACP 会话 → acp-shared   → /project/default + session-002
```

**Isolated 模式映射**：
```
飞书群 A → feishu-chatA-xxx → /project/default + session-001
飞书群 B → feishu-chatB-xxx → /project/default + session-002
飞书群 C → feishu-chatC-xxx → /project/default + session-003
ACP 会话 → acp-chatX-xxx   → /project/default + session-004
```

### 4.3 Hook 同步流程

```
Claude Code 处理消息
   ↓
写入 JSONL 文件
   ↓
触发 PostToolUse Hook
   ↓
MessageSync.syncLatest()
   ├─ 读取 JSONL 文件
   ├─ 获取 last_synced_line
   ├─ 只同步新增的行
   ├─ 写入数据库元数据
   └─ 更新 last_synced_line
   ↓
（上下文压缩时）
   ↓
触发 PreCompact Hook
   ↓
MessageSync.syncAll()
   ├─ 重置 last_synced_line = 0
   └─ 全量同步（兜底）
```

---

## 五、实施路径

### 5.1 开发阶段

**阶段 1：核心功能（1-2 天）**

任务：
1. 引入 HappyClaw 的 Feishu 连接
2. 实现会话级消息队列
3. 实现会话管理（支持 shared/isolated）
4. 实现 Hook 驱动的消息同步

验收标准：
- Feishu 连接稳定，支持自动重连
- 消息顺序正确，无乱序现象
- 可通过配置切换会话模式
- Agent 可直接读取 JSONL 会话历史
- 数据库支持快速搜索

**阶段 2：测试与优化（1 天）**

任务：
1. 测试 Feishu 连接稳定性（模拟网络断线）
2. 测试消息队列正确性（高并发场景）
3. 测试会话模式切换
4. 测试 Hook 同步机制（验证数据一致性）

验收标准：
- 网络断线后能自动重连并恢复
- 高并发下消息不乱序
- shared/isolated 模式正常工作
- JSONL 与数据库保持一致

### 5.2 代码量估算

- Feishu 连接：~50 行（复用 HappyClaw）
- 消息队列：~50 行
- 会话管理：~100 行
- 消息同步：~80 行
- **总计**：~280 行

### 5.3 配置管理

通过 `config.json` 管理核心配置：
- 飞书应用凭据（appId、appSecret）
- ACP 域名和 Agent 名称
- 会话模式（shared/isolated）
- 项目路径
- 实例管理参数（最大实例数、空闲超时）

---

## 六、总结

### 6.1 核心价值

**轻量化 + 生产级**：
- 保持极简架构（~280 行代码）
- 获得生产级可靠性（复用成熟组件）
- 支持多种使用场景（个人 + 团队）

**Agent 友好**：
- JSONL 文件可直接读取
- 数据库支持快速搜索
- 两者通过 Hook 自动同步

**技术创新**：
- Hook 驱动的混合存储（解耦 + 实时）
- 会话模式切换（灵活适配场景）
- 会话级消息队列（简单 + 有效）

### 6.2 适用场景

**推荐使用 EvolClaw**：
- 个人轻量化部署
- 不需要多用户管理
- 主要使用飞书或 ACP 渠道
- 追求简洁和高效

**推荐使用 HappyClaw**：
- 需要多用户 RBAC
- 需要 Web 界面
- 需要容器隔离
- 需要更多渠道（Telegram、Web）

**推荐使用 OpenClaw**：
- 需要完整的 ACP 协议
- 需要 Agent 间协作（P2P、群组）
- 需要 60+ 内置 Skills
- 需要多平台客户端（iOS、Android）

### 6.3 未来扩展

**可选扩展方向**（保持轻量化原则）：
- 增加更多消息渠道（Telegram、Discord）
- 支持自定义 Hook（用户可扩展）
- 增加简单的 Web 监控界面
- 支持会话导出和备份

**不建议扩展**（违背轻量化原则）：
- 多用户管理
- 容器化部署
- 完整的 ACP 协议
- 复杂的权限系统
