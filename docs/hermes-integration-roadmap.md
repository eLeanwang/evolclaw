# Hermes 接入 EvolClaw 分层改造清单

**目标**：把 Hermes 作为 EvolClaw 的第三个 agent backend（与 Claude/Codex 并列），通过 `/agent hermes` 切换使用。

**当前状态**：
- Hermes 源码已克隆到 `/home/evolclaw/projects/hermes-agent`
- Python venv 已创建，核心依赖已安装
- ModelGate custom endpoint 已配置并验证通过
- EvolClaw 项目列表已添加 `hermes` 项目

---

## 第一层：必做（MVP 接入）

### 1.1 创建 Python bridge 脚本

**文件**：`/home/evolclaw/projects/hermes-agent/evolclaw_bridge.py`

**职责**：
- 读取 stdin JSON 指令
- 调用 `AIAgent.run_conversation()`
- 通过 callbacks 将事件流式输出到 stdout（JSON 格式）
- 处理 interrupt 信号

**参考**：`/home/evolclaw/src/channels/aun_bridge.py`（已删除，但可从 git 恢复）

**关键点**：
```python
# 方法表
- query: 调用 run_conversation，emit text/tool_use/tool_result/complete
- interrupt: 调用 Hermes interrupt 机制
- set_model: 切换 provider/model（可选）
```

**事件映射**：
```
Hermes callbacks → EvolClaw AgentEvent
─────────────────────────────────────
stream_delta_callback → {type: 'text', text}
tool_start_callback → {type: 'tool_use', name, input}
tool_complete_callback → {type: 'tool_result', result, isError}
status_callback → {type: 'system', message}（可选）
完成后 → {type: 'complete', result, duration, cost}
```

---

### 1.2 创建 TypeScript runner

**文件**：`/home/evolclaw/src/agents/hermes-runner.ts`

**职责**：
- 实现 `AgentRunnerFull` 接口
- spawn Python bridge 子进程
- 读取 stdout 事件流，映射到 `AgentEvent`
- 管理子进程生命周期
- 处理 interrupt

**参考**：
- `/home/evolclaw/src/agents/codex-runner.ts`（已有 subprocess 模式）
- `/home/evolclaw/src/agents/claude-runner.ts`（事件映射参考）

**关键实现**：
```typescript
export class HermesRunner implements AgentRunnerFull {
  private process: ChildProcess | null = null;

  async *runQuery(params: AgentQueryParams): AsyncGenerator<AgentEvent> {
    // 1. spawn bridge.py
    // 2. 发送 query 指令到 stdin
    // 3. 读取 stdout 逐行解析 JSON
    // 4. yield AgentEvent
  }

  async interrupt(): Promise<void> {
    // SIGINT 或通过 stdin 发送 interrupt 指令
  }
}
```

---

### 1.3 创建 Hermes plugin

**文件**：`/home/evolclaw/src/agents/hermes-plugin.ts`

**职责**：
- 实现 `AgentPlugin` 接口
- 创建 `HermesRunner` 实例
- 提供 capabilities 声明

**参考**：`/home/evolclaw/src/agents/codex-plugin.ts`

```typescript
export const hermesPlugin: AgentPlugin = {
  id: 'hermes',
  name: 'Hermes',
  createRunner: (config) => new HermesRunner(config),
  capabilities: {
    // 暂不支持 clear/compact/fork
  }
};
```

---

### 1.4 注册到 agent loader

**文件**：`/home/evolclaw/src/index.ts`

**修改位置**：`~87-97`（plugin 注册区）

```typescript
import { hermesPlugin } from './agents/hermes-plugin.js';

// 注册 plugins
agentLoader.registerPlugin(claudePlugin);
agentLoader.registerPlugin(codexPlugin);
agentLoader.registerPlugin(hermesPlugin);  // 新增
```

---

### 1.5 添加配置支持

**文件**：`/home/evolclaw/src/types.ts`

**修改**：`AgentConfig` 类型添加 `hermes` 字段

```typescript
export interface AgentConfig {
  anthropic?: {
    model?: string;
    effort?: string;
    // ...
  };
  openai?: {
    model?: string;
    effort?: string;
  };
  hermes?: {
    pythonPath?: string;      // Python 解释器路径
    bridgePath?: string;       // bridge.py 路径
    model?: string;            // 默认模型
    provider?: string;         // custom/openrouter/anthropic
    baseUrl?: string;          // API endpoint
    apiKey?: string;           // API key（可选，优先用 env）
  };
  defaultAgent?: 'claude' | 'codex' | 'hermes';
}
```

**配置示例**（`data/evolclaw.json`）：
```json
{
  "agents": {
    "hermes": {
      "pythonPath": "/home/evolclaw/projects/hermes-agent/.venv/bin/python",
      "bridgePath": "/home/evolclaw/projects/hermes-agent/evolclaw_bridge.py",
      "model": "Claude-Sonnet-4.6",
      "provider": "custom",
      "baseUrl": "https://mg.aid.pub/v1"
    },
    "defaultAgent": "claude"
  }
}
```

---

### 1.6 Session file adapter（可选）

**文件**：`/home/evolclaw/src/core/adapters/hermes-session-file-adapter.ts`

**职责**：
- 如果 Hermes 有本地 session 文件需要管理，实现 `SessionFileAdapter`
- 如果 Hermes 完全自己管 session（通过 `session_id` + `hermes_state.py`），可以是 no-op adapter

**参考**：`/home/evolclaw/src/core/adapters/claude-session-file-adapter.ts`

---

### 1.7 验证测试

**步骤**：
1. `/agent hermes` 切换到 Hermes backend
2. 发送简单 query："Reply with OK"
3. 验证：
   - 事件流正常
   - 文本输出正确
   - session 持续性（第二轮对话能记住上下文）
4. `/agent claude` 切回 Claude，验证切换无问题

---

## 第二层：建议做（体验优化）

### 2.1 Tool boundary segmentation

**问题**：当前 `StreamFlusher` 只做时间批处理，工具调用和文本混在一起体验差。

**改进**：
- 在 `MessageProcessor` 里检测 `tool_use` / `tool_result` 事件
- 遇到工具边界时，调用 `flusher.flush()` 强制结束当前段
- 后续文本重新起一段

**参考**：`projects/hermes-agent/gateway/stream_consumer.py:31-33`（`_NEW_SEGMENT` sentinel）

**修改位置**：`/home/evolclaw/src/core/message-processor.ts:741-775`

```typescript
// tool_use 事件
if (event.type === 'tool_use') {
  flusher.flush();  // 强制结束上一段文本
  flusher.addActivity(`🔧 ${event.name}: ${desc}`);
}

// tool_result 事件
if (event.type === 'tool_result') {
  // ... 现有逻辑
  flusher.flush();  // 工具完成后也结束一段
}
```

---

### 2.2 Approval UI capability

**问题**：危险操作审批只能靠文本 `/approve` / `/deny`，体验不如原生 UI。

**改进**：
- 在 `ChannelAdapter` 接口添加 `sendApprovalUI?()` 方法
- Feishu 实现：发送 interactive card
- WeChat 实现：发送 button payload（如果支持）
- 其他平台 fallback 到文本

**参考**：
- `projects/hermes-agent/gateway/platforms/feishu.py:1401`（`send_exec_approval`）
- `projects/hermes-agent/gateway/platforms/telegram.py:1015`（inline buttons）

**修改位置**：
- `/home/evolclaw/src/core/message-processor.ts`（检测需要审批的场景）
- `/home/evolclaw/src/channels/feishu.ts`（实现 `sendApprovalUI`）

---

### 2.3 长驻 agent 实例优化

**问题**：Hermes 设计上会复用 `AIAgent` 实例以保持 prompt cache，但 EvolClaw 当前每轮都重建 runner。

**改进方案 A（轻量）**：
- 在 `HermesRunner` 内部维护子进程不退出
- 每次 `runQuery` 复用同一个 bridge 进程
- session 切换时才重启

**改进方案 B（重量）**：
- 在 `MessageProcessor` 层面缓存 runner 实例（按 session key）
- 参考 Hermes 的 `gateway/run.py:6697-6743`

**建议**：先做方案 A，验证效果后再考虑 B。

---

### 2.4 Richer session context prompt

**问题**：当前 session 主要用于 routing，没有显式告诉 agent 当前在哪个平台、什么类型的 chat。

**改进**：
- 在 system prompt 里注入 session context
- 告诉 agent：
  - 当前平台（Feishu/WeChat/AUN）
  - chat 类型（dm/group）
  - 当前项目路径
  - 可用的其他平台

**参考**：`projects/hermes-agent/gateway/session.py:203`（`build_session_context_prompt`）

**修改位置**：`/home/evolclaw/src/core/message-processor.ts:408-416`（构建 system prompt 时）

---

### 2.5 Media cache normalization

**问题**：Feishu 文件接收已有，但不是框架级能力，其他平台要重复实现。

**改进**：
- 抽象 `MediaCache` 工具类
- 统一处理：
  - 下载
  - SSRF 防护
  - retry/backoff
  - 本地缓存
  - 清理策略

**参考**：`projects/hermes-agent/gateway/platforms/base.py:76-258`

**新增文件**：`/home/evolclaw/src/utils/media-cache.ts`

---

## 第三层：可选优化（长期增强）

### 3.1 Pairing onboarding

**场景**：陌生用户私聊 bot，不需要管理员提前知道 user ID。

**流程**：
1. 未授权用户发消息
2. 系统生成 8 位 code，发给用户
3. 用户把 code 告诉 owner
4. Owner 在 CLI 执行 `/pairing approve <platform> <code>`
5. 用户自动获得授权

**参考**：`projects/hermes-agent/gateway/pairing.py:1-260`

**新增文件**：
- `/home/evolclaw/src/core/pairing-store.ts`
- `/home/evolclaw/src/core/command-handler.ts`（添加 `/pairing` 命令）

---

### 3.2 PII-safe session context

**场景**：某些平台（Telegram/Signal/WhatsApp）的 user/chat ID 是敏感信息。

**改进**：
- 在注入 system prompt 前，对 PII 做 hash
- 但保留 routing 层的真实 ID
- Discord 等需要 mention 的平台不脱敏

**参考**：`projects/hermes-agent/gateway/session.py:192-223`

---

### 3.3 Platform fault recovery

**场景**：平台连接掉线后，adapter 自己决定是"自救重连"还是"上报 fatal"。

**改进**：
- 在 `ChannelAdapter` 添加 `onFatalError` callback
- Adapter 内部实现 retry/backoff
- 超次数后调用 callback，交给 supervisor（restart-monitor）

**参考**：`projects/hermes-agent/gateway/platforms/telegram.py:189-255`

---

### 3.4 Webhook anomaly tracking

**场景**：Feishu webhook 被恶意请求刷爆。

**改进**：
- 在 `FeishuChannel` 添加 anomaly tracker
- 连续错误超阈值时 WARNING log
- 可选：自动切换到 WebSocket 模式

**参考**：`projects/hermes-agent/gateway/platforms/feishu.py:1-16`（注释里提到）

---

### 3.5 Interactive card routing

**场景**：Feishu card button click 应该路由成命令，而不是普通文本。

**改进**：
- 在 `FeishuChannel` 检测 card action event
- 提取 action value，转成 synthetic command
- 路由到 `CommandHandler`

**参考**：`projects/hermes-agent/gateway/platforms/feishu.py:1906`（`_handle_card_action_event`）

---

## 实施顺序建议

### Phase 1: MVP（1-2 天）
1. 写 `evolclaw_bridge.py`
2. 写 `hermes-runner.ts`
3. 写 `hermes-plugin.ts`
4. 注册到 `index.ts`
5. 添加配置支持
6. 端到端测试

**验收标准**：`/agent hermes` 能切换，能正常对话，session 能持续。

---

### Phase 2: 体验优化（2-3 天）
1. Tool boundary segmentation
2. 长驻 agent 实例优化
3. Richer session context prompt

**验收标准**：工具调用体验流畅，长对话 prompt cache 生效。

---

### Phase 3: 增强特性（按需）
1. Approval UI capability
2. Media cache normalization
3. Pairing onboarding
4. 其他可选优化

**验收标准**：按实际需求逐步验收。

---

## 关键风险点

### 风险 1：Hermes session 管理冲突
**问题**：Hermes 自己有 `hermes_state.py` 管 session，EvolClaw 也有 `session-manager.ts`。

**缓解**：
- EvolClaw 的 `agentSessionId` 直接用 Hermes 返回的 `session_id`
- 不要在 EvolClaw 层面重复管理 Hermes 内部状态
- 让 Hermes 完全自己管 memory/skills/state

---

### 风险 2：事件流映射不完整
**问题**：Hermes 的 callback 可能比 EvolClaw `AgentEvent` 更丰富。

**缓解**：
- 先映射核心事件（text/tool_use/tool_result/complete）
- 其他事件（thinking/reasoning/clarify）可选映射或忽略
- 在 bridge 里做好 fallback 处理

---

### 风险 3：子进程管理复杂
**问题**：Python bridge 可能 hang/crash/zombie。

**缓解**：
- 设置合理的 timeout
- 监听 `exit` / `error` 事件
- 实现 graceful shutdown
- 参考 `codex-runner.ts` 的进程管理逻辑

---

## 成功标准

### 最小可用（Phase 1）
- [ ] `/agent hermes` 切换成功
- [ ] 简单对话正常
- [ ] Session 持续性正常
- [ ] 切回 Claude/Codex 无问题

### 体验良好（Phase 2）
- [ ] 工具调用不混在文本里
- [ ] 长对话 prompt cache 生效
- [ ] Session context 注入正确

### 功能完整（Phase 3）
- [ ] 审批 UI 原生化
- [ ] 媒体处理统一
- [ ] Pairing onboarding 可用

---

## 参考文件清单

### EvolClaw 现有
- `/home/evolclaw/src/agents/claude-runner.ts`
- `/home/evolclaw/src/agents/codex-runner.ts`
- `/home/evolclaw/src/core/agent-loader.ts`
- `/home/evolclaw/src/core/message-processor.ts`
- `/home/evolclaw/src/channels/feishu.ts`
- Git history: `13734c1^:src/channels/aun_bridge.py`

### Hermes 参考
- `/home/evolclaw/projects/hermes-agent/run_agent.py`
- `/home/evolclaw/projects/hermes-agent/gateway/run.py`
- `/home/evolclaw/projects/hermes-agent/gateway/stream_consumer.py`
- `/home/evolclaw/projects/hermes-agent/gateway/platforms/base.py`
- `/home/evolclaw/projects/hermes-agent/gateway/platforms/feishu.py`
- `/home/evolclaw/projects/hermes-agent/gateway/session.py`
- `/home/evolclaw/projects/hermes-agent/gateway/pairing.py`

---

## 下一步行动

如果你同意这个路线图，我建议：

1. **立即开始 Phase 1**，先把 MVP 跑通
2. 我可以直接帮你写 `evolclaw_bridge.py` 和 `hermes-runner.ts`
3. 或者你可以先自己试试，遇到问题再找我

你要现在开始吗？
