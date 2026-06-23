# EvolClaw AUN Channel 实现方案

**编写日期**: 2026-03-16
**目标**: 将 `src/channels/aun.ts` 从占位符升级为完整的 ACP 协议实现，使第三方 IDE（Zed、JetBrains、Neovim 等）能够通过标准化协议调用 EvolClaw

---

## 1. 现状分析

### 1.1 当前代码状态

`src/channels/aun.ts` 是一个占位符实现（~40 行），仅定义了接口骨架：

```typescript
// 当前状态：TODO 占位符
export class AUNChannel {
  async connect(): Promise<void> { /* TODO */ }
  onMessage(handler: MessageHandler): void { /* 存储回调 */ }
  async sendMessage(sessionId: string, content: string): Promise<void> { /* TODO */ }
  async disconnect(): Promise<void> { /* 标记断开 */ }
}
```

### 1.2 EvolClaw 已有的架构优势

EvolClaw 的 Channel Adapter 模式已经为 AUN 接入做好了准备：

- `types.ts` 中 `ChannelAdapter` 接口已包含 `'aun'` 类型
- `index.ts` 中 AUN 的消息处理、队列接入、适配器注册代码已就绪（L1034-1169）
- `MessageProcessor` 统一处理所有渠道的事件，AUN 只需做 I/O 翻译
- `Session` 类型已支持 `channel: 'feishu' | 'aun'`

### 1.3 依赖现状

`package.json` 中已有 `"aun-ts": "latest"`，需替换为官方 SDK `@agentclientprotocol/sdk`。

---

## 2. 架构设计

### 2.1 整体数据流

```
┌─────────────────────────────────────────────────────────────┐
│  IDE (Zed / JetBrains / Neovim)                             │
│  AUN Client                                                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdio (JSON-RPC 2.0, newline-delimited)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  evolclaw aun  (AUN 模式入口)                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  AUNChannel (重写后)                                    │  │
│  │  - AgentSideConnection (官方 SDK)                      │  │
│  │  - AUN ↔ EvolClaw Message 双向翻译                     │  │
│  └───────────────────┬───────────────────────────────────┘  │
│                      │ onMessage / sendMessage               │
│                      ▼                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  EvolClaw Core (不变)                                   │  │
│  │  MessageQueue → MessageProcessor → AgentRunner         │  │
│  │  → Claude Agent SDK → Claude API                       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 运行模式

EvolClaw 需要支持两种启动模式：

| 模式 | 命令 | 通信方式 | 场景 |
|------|------|----------|------|
| 常驻服务模式 | `evolclaw` | Feishu WebSocket + AUN 占位 | 当前默认，飞书机器人 |
| AUN stdio 模式 | `evolclaw aun` | stdin/stdout JSON-RPC | IDE 调用，按需启动 |

AUN 模式下，IDE spawn 一个 `evolclaw aun` 进程，通过 stdio 通信，进程生命周期由 IDE 管理。

---

## 3. 实现步骤

### 3.1 依赖变更

```diff
// package.json
"dependencies": {
-  "aun-ts": "latest",
+  "@agentclientprotocol/sdk": "^0.16.1",
}
```

### 3.2 新增 AUN 入口点

新增 `src/aun-entry.ts` 作为 AUN 模式的独立入口：

```typescript
// src/aun-entry.ts
// AUN stdio 模式入口，由 IDE spawn 调用
// 与 src/index.ts 共享 core 层，但 I/O 走 stdio 而非 Feishu WebSocket

import { AUNChannel } from './channels/aun.js';
import { SessionManager } from './core/session-manager.js';
import { AgentRunner } from './core/agent-runner.js';
import { MessageProcessor } from './core/message-processor.js';
import { MessageQueue } from './core/message-queue.js';
import { MessageCache } from './core/message-cache.js';
import { loadConfig } from './config.js';

async function main() {
  const config = await loadConfig();
  const sessionManager = new SessionManager(/* ... */);
  const agentRunner = new AgentRunner(config);
  const messageCache = new MessageCache();

  const aun = new AUNChannel({
    domain: config.aun.domain,
    agentName: config.aun.agentName,
  });

  const messageQueue = new MessageQueue(async (message) => {
    await processor.processMessage(message);
  });

  const processor = new MessageProcessor(
    agentRunner, sessionManager, config, messageCache,
    /* commandHandler */
  );

  // 注册 AUN 适配器
  processor.registerChannel({
    name: 'aun',
    sendText: (channelId, text) => aun.sendMessage(channelId, text),
  });

  // AUN 消息 → MessageQueue
  aun.onMessage(async (sessionId, content) => {
    const session = await sessionManager.getOrCreateSession(
      'aun', sessionId, config.projects?.defaultPath || process.cwd()
    );
    await messageQueue.enqueue(
      `aun-${sessionId}`,
      { channel: 'aun', channelId: sessionId, content, timestamp: Date.now() },
      session.projectPath
    );
  });

  await aun.connect(); // 启动 stdio 监听
}

main().catch(console.error);
```

修改 `package.json` 添加 bin 入口：

```diff
"bin": {
-  "evolclaw": "./bin/evolclaw"
+  "evolclaw": "./bin/evolclaw",
+  "evolclaw-aun": "./bin/evolclaw-aun"
},
```

新增 `bin/evolclaw-aun`：

```bash
#!/usr/bin/env node
import('../dist/aun-entry.js');
```

或者更简洁的方式——在现有 `bin/evolclaw` 中检测子命令：

```bash
#!/usr/bin/env node
if (process.argv[2] === 'aun') {
  import('../dist/aun-entry.js');
} else {
  import('../dist/index.js');
}
```

### 3.3 重写 `src/channels/aun.ts`（核心）

完整替换当前占位符实现：

```typescript
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
} from '@agentclientprotocol/sdk';
import { logger } from '../utils/logger.js';

export interface AUNConfig {
  domain: string;
  agentName: string;
}

export interface MessageHandler {
  (sessionId: string, content: string): Promise<void>;
}

/**
 * AUN Channel - 实现 Agent Client Protocol
 *
 * 职责：
 * 1. 通过 stdio 接收 IDE 的 JSON-RPC 消息
 * 2. 将 AUN 协议消息翻译为 EvolClaw 内部 Message 格式
 * 3. 将 EvolClaw 的输出通过 AUN session/update 通知推回 IDE
 */
export class AUNChannel {
  private connection!: AgentSideConnection;
  private messageHandler?: MessageHandler;
  private connected = false;

  // AUN sessionId → 内部状态
  private sessions = new Map<string, {
    cwd?: string;
    abortController?: AbortController;
  }>();

  // 当前正在处理 prompt 的 session，用于路由 sendMessage
  private activePromptSession: string | null = null;

  constructor(private config: AUNConfig) {}

  /**
   * 启动 AUN stdio 连接
   * IDE spawn 进程后，通过 stdin/stdout 通信
   */
  async connect(): Promise<void> {
    this.connection = new AgentSideConnection((conn) => ({

      // ── 1. 协议握手 ──
      initialize: async (req: InitializeRequest): Promise<InitializeResponse> => {
        logger.info('[AUN] Initialize request received');
        return {
          name: this.config.agentName || 'EvolClaw',
          protocolVersion: '1.0.0',
          capabilities: {
            modes: {
              currentModeId: 'code',
              availableModes: [
                {
                  id: 'code',
                  name: 'Code',
                  description: 'Full coding mode with file editing',
                },
                {
                  id: 'architect',
                  name: 'Architect',
                  description: 'Planning and design only',
                },
              ],
            },
            // 按需启用更多能力
            // sessionList: true,
            // slashCommands: true,
          },
        };
      },

      // ── 2. 创建会话 ──
      newSession: async (req: NewSessionRequest): Promise<NewSessionResponse> => {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, {
          cwd: req.cwd,
        });
        logger.info(`[AUN] New session: ${sessionId}, cwd: ${req.cwd}`);

        return {
          sessionId,
          modes: {
            currentModeId: 'code',
            availableModes: [
              { id: 'code', name: 'Code' },
              { id: 'architect', name: 'Architect' },
            ],
          },
        };
      },

      // ── 3. 处理 Prompt（核心） ──
      prompt: async (req: PromptRequest): Promise<PromptResponse> => {
        const { sessionId, prompt } = req;
        logger.info(`[AUN] Prompt received for session: ${sessionId}`);

        // 提取文本内容
        const textContent = this.extractPromptText(prompt);
        if (!textContent) {
          return { stopReason: 'endTurn' };
        }

        // 设置 abort controller
        const abortController = new AbortController();
        const sessionState = this.sessions.get(sessionId);
        if (sessionState) {
          sessionState.abortController = abortController;
        }

        // 标记当前活跃 session
        this.activePromptSession = sessionId;

        try {
          // 触发 EvolClaw 的消息处理流程
          // messageHandler 会将消息送入 MessageQueue → MessageProcessor → AgentRunner
          if (this.messageHandler) {
            await this.messageHandler(sessionId, textContent);
          }
        } finally {
          this.activePromptSession = null;
          if (sessionState) {
            sessionState.abortController = undefined;
          }
        }

        return { stopReason: 'endTurn' };
      },

      // ── 4. 取消任务 ──
      cancel: async (params: CancelNotification): Promise<void> => {
        const { sessionId } = params;
        logger.info(`[AUN] Cancel request for session: ${sessionId}`);
        const sessionState = this.sessions.get(sessionId);
        if (sessionState?.abortController) {
          sessionState.abortController.abort();
        }
      },

    }));

    this.connected = true;
    logger.info(`[AUN] stdio connection established as ${this.config.agentName}`);
  }

  /**
   * 注册消息回调
   * 由 index.ts / aun-entry.ts 调用，将消息路由到 MessageQueue
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * 发送消息给 IDE
   * 由 ChannelAdapter.sendText 调用，将 EvolClaw 输出转为 AUN 通知
   */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    if (!this.connected) throw new Error('AUN not connected');

    const targetSession = sessionId || this.activePromptSession;
    if (!targetSession) {
      logger.warn('[AUN] No active session for sendMessage');
      return;
    }

    // 通过 AUN session/update 通知推送文本给 IDE
    this.connection.notify('session/update', {
      sessionId: targetSession,
      update: {
        type: 'text_delta',
        delta: content,
      },
    });

    logger.debug(`[AUN] Sent to ${targetSession}: ${content.slice(0, 80)}...`);
  }

  /**
   * 发送工具调用状态给 IDE（可选增强）
   */
  async sendToolCallUpdate(
    sessionId: string,
    toolCallId: string,
    name: string,
    status: 'in_progress' | 'completed' | 'failed'
  ): Promise<void> {
    if (!this.connected) return;

    this.connection.notify('session/update', {
      sessionId,
      update: {
        type: 'tool_call',
        toolCallId,
        name,
        status,
      },
    });
  }

  /**
   * 发送 thinking 状态给 IDE（可选增强）
   */
  async sendThinking(sessionId: string, content: string): Promise<void> {
    if (!this.connected) return;

    this.connection.notify('session/update', {
      sessionId,
      update: {
        type: 'thinking_delta',
        delta: content,
      },
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessions.clear();
    logger.info('[AUN] Disconnected');
  }

  // ── 辅助方法 ──

  /**
   * 从 AUN prompt 结构中提取纯文本
   * AUN prompt 可能包含 text、resource、image 等多种内容类型
   */
  private extractPromptText(prompt: any): string {
    if (typeof prompt === 'string') return prompt;

    if (Array.isArray(prompt)) {
      return prompt
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n');
    }

    if (prompt?.content) {
      return this.extractPromptText(prompt.content);
    }

    return String(prompt || '');
  }
}
```

### 3.4 适配 `src/types.ts`（可选增强）

当前 `ChannelAdapter` 的 `sendText` 是批量发送模式（配合 StreamFlusher 3 秒窗口）。对 AUN 场景，IDE 期望更细粒度的流式输出。可以添加可选的流式方法：

```diff
// src/types.ts
export interface ChannelAdapter {
  readonly name: 'feishu' | 'aun';
  sendText(channelId: string, text: string, options?: { title?: string }): Promise<void>;
  sendFile?(channelId: string, filePath: string): Promise<void>;
+ sendDelta?(channelId: string, delta: string): Promise<void>;  // AUN 流式增量
+ sendToolStatus?(channelId: string, toolCallId: string, name: string, status: string): Promise<void>;
}
```

`MessageProcessor` 中检测到 `sendDelta` 存在时，跳过 StreamFlusher 的 3 秒批量窗口，直接推送增量文本。这样 Feishu 渠道保持现有的批量发送体验，AUN 渠道获得实时流式输出。

### 3.5 适配 `src/index.ts` 中的 AUN 接线

当前 `index.ts` 中 AUN 相关代码（L1034-1169）基本可以复用，只需少量调整：

```diff
// L1110-1116: AUN 适配器注册
const aunAdapter: ChannelAdapter = {
  name: 'aun',
  sendText: (channelId, text) => aun.sendMessage(channelId, text),
+ sendDelta: (channelId, delta) => aun.sendMessage(channelId, delta),
+ sendToolStatus: (channelId, toolCallId, name, status) =>
+   aun.sendToolCallUpdate(channelId, toolCallId, name, status as any),
};
```

消息处理回调（L1148-1169）不需要改动，`aun.onMessage` 的签名保持一致。

---

## 4. ACP 协议方法实现优先级

### P0 — 必须实现（MVP）

| 方法 | 方向 | 说明 |
|------|------|------|
| `initialize` | Client → Agent | 协议握手，声明 EvolClaw 能力 |
| `session/new` | Client → Agent | 创建会话，映射到 EvolClaw Session |
| `session/prompt` | Client → Agent | 接收 prompt，送入 MessageQueue |
| `session/cancel` | Client → Agent | 取消任务，触发 AgentRunner.interrupt |
| `session/update` | Agent → Client | 流式推送 text_delta、thinking_delta |

实现 P0 后，EvolClaw 即可在 Zed / JetBrains 中作为 coding agent 使用。

### P1 — 重要增强

| 方法 | 说明 |
|------|------|
| `session/list` | 列出所有活跃会话（对应 SessionManager） |
| `session/load` | 恢复已有会话（对应 SessionManager.getActiveSession） |
| `session/set_mode` | 切换 code/architect 模式 |
| `tool_call` / `tool_call_update` 通知 | 在 IDE 中展示工具执行状态 |
| `diff` 通知 | 文件变更以 diff 形式展示在 IDE 中 |
| `usage_update` 通知 | Token 用量统计 |

### P2 — 深度集成

| 方法 | 说明 |
|------|------|
| `fs/read_text_file` | IDE 请求 agent 读取文件 |
| `fs/write_text_file` | IDE 请求 agent 写入文件 |
| `session/request_permission` | 敏感操作前请求用户授权 |
| `slash_commands` | 暴露 EvolClaw 的 /project、/session 等命令 |
| `mcpServers` | 接收 IDE 配置的 MCP 服务器列表 |

### P3 — 可选

| 方法 | 说明 |
|------|------|
| `terminal/*` | 终端生命周期管理（create/output/kill/release） |
| `authenticate` | API Key 认证流程 |
| `agent_plan` | 展示 agent 的执行计划 |

---

## 5. IDE 接入配置

### 5.1 Zed 编辑器

```json
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "EvolClaw": {
      "type": "custom",
      "command": "evolclaw",
      "args": ["aun"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### 5.2 JetBrains IDE（2025.3+）

```json
// ~/.jetbrains/aun.json
{
  "agent_servers": {
    "EvolClaw": {
      "command": "evolclaw",
      "args": ["aun"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### 5.3 任意 AUN 兼容编辑器

通用配置模式：启动 `evolclaw aun` 进程，通过 stdio 传输 JSON-RPC 2.0 消息。

---

## 6. 与 Feishu Channel 的对比

| 维度 | Feishu Channel | AUN Channel |
|------|---------------|-------------|
| 通信方式 | WebSocket（飞书 SDK） | stdio（JSON-RPC 2.0） |
| 进程模型 | 常驻服务，长期运行 | 按需启动，IDE 管理生命周期 |
| 消息格式 | 飞书消息卡片 / 富文本 | AUN 结构化通知（text_delta, diff, tool_call） |
| 流式输出 | StreamFlusher 3秒批量 | 实时增量推送（text_delta） |
| 文件发送 | 飞书文件上传 API | diff 通知 / fs 操作 |
| 图片支持 | 支持（飞书图片消息） | 支持（AUN resource 类型） |
| 认证方式 | 飞书 App ID/Secret | 可选 authenticate 方法 |
| 代码量 | ~500 行 | 预计 ~200 行 |

---

## 7. 测试策略

### 7.1 单元测试

```typescript
// tests/channels/aun.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AUNChannel } from '../../src/channels/aun.js';

describe('AUNChannel', () => {
  it('should extract text from string prompt', () => {
    const channel = new AUNChannel({ domain: 'test', agentName: 'test' });
    // 测试 extractPromptText 的各种输入格式
  });

  it('should create session with UUID', async () => {
    // 测试 newSession 返回有效 sessionId
  });

  it('should route prompt to messageHandler', async () => {
    const handler = vi.fn();
    const channel = new AUNChannel({ domain: 'test', agentName: 'test' });
    channel.onMessage(handler);
    // 模拟 prompt 调用，验证 handler 被触发
  });
});
```

### 7.2 协议合规性测试

使用 `aun-harness` 工具验证：

```bash
# 安装测试工具
npm install -g @plaited/aun-adapters

# 验证协议合规性
aun-harness adapter:check evolclaw aun

# 使用示例 prompts 进行端到端测试
aun-harness capture prompts.jsonl evolclaw aun -o results.jsonl
```

### 7.3 IDE 集成测试

1. 在 Zed 中配置 EvolClaw 为 custom agent
2. 发送简单 prompt（如 "list files in current directory"）
3. 验证流式输出正常显示
4. 验证工具调用状态更新
5. 测试取消操作

---

## 8. 注册到 ACP Registry（可选）

发布后可提交到官方 ACP Agent Registry，让 JetBrains 用户一键安装：

```json
// 提交到 github.com/agentclientprotocol/registry
// evolclaw/agent.json
{
  "id": "evolclaw",
  "name": "EvolClaw",
  "version": "1.0.0",
  "description": "Lightweight AI Agent gateway with multi-channel support",
  "repository": "https://github.com/evolclaw/evolclaw",
  "authors": ["EvolClaw Team"],
  "license": "MIT",
  "icon": "icon.svg",
  "distribution": {
    "npm": {
      "package": "evolclaw",
      "cmd": "evolclaw",
      "args": ["aun"]
    }
  }
}
```

---

## 9. 开发路线图

### Phase 1 — MVP（可用）

- [ ] 替换 `aun-ts` 为 `@agentclientprotocol/sdk`
- [ ] 重写 `src/channels/aun.ts`，实现 P0 方法
- [ ] 新增 `src/aun-entry.ts` 入口
- [ ] 新增 `bin/evolclaw-aun` 或 `evolclaw aun` 子命令
- [ ] 在 Zed 中完成端到端验证

### Phase 2 — 增强（好用）

- [ ] 实现 P1 方法（session/list、session/load、tool_call 通知）
- [ ] 适配 `MessageProcessor` 支持 `sendDelta` 流式输出
- [ ] 添加 diff 通知，文件变更在 IDE 中可视化
- [ ] 添加 slash_commands 支持（/project、/session 等）
- [ ] 编写单元测试和协议合规性测试

### Phase 3 — 生态（完善）

- [ ] 实现 P2 方法（fs 操作、权限请求、MCP 服务器）
- [ ] 注册到 ACP Registry
- [ ] 发布 npm 包
- [ ] 编写 IDE 配置文档

---

## 10. 参考资料

### 官方资源
- [ACP 协议规范](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP Agent 列表](https://agentclientprotocol.com/get-started/agents)
- [ACP Registry 规范](https://agentclientprotocol.com/rfds/acp-agent-registry)

### 参考实现
- [Gemini CLI ACP 实现](https://github.com/google-gemini/gemini-cli)（官方推荐的 production-ready 范例）
- [Cursor Agent ACP Adapter](https://github.com/blowmage/cursor-agent-acp-npm)（TypeScript 适配器参考）
- [OpenClaw ACP Bridge](https://docs.openclaw.ai/cli/acp)（桥接模式参考，架构最接近 EvolClaw）
- [Amp ACP Agent](https://ampcode.com/)（AmpAgent 实现参考）

### 工具
- [@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk) — 官方 TypeScript SDK (v0.16.1)
- [@plaited/aun-adapters](https://agentskills.in/marketplace/%40plaited/aun-adapters) — 适配器脚手架和合规性测试工具

---

**文档版本**: v1.0
**编写日期**: 2026-03-16
**适用项目**: EvolClaw (`/home/evolclaw/`)

