# BaseAgent 集成研究：OpenCode / WorkBuddy / Qoder / Kimi Code / ZCode

研究日期：2026-06-23（OpenCode/WorkBuddy）、2026-06-24（Qoder 增补）、2026-06-25（Kimi/ZCode 增补）  
研究目的：评估 OpenCode、WorkBuddy、Qoder、Kimi Code、ZCode 作为 EvolClaw baseagent 的可行性

---

## 研究结论

| 产品 | 集成可行性 | 推荐优先级 | 理由 |
|------|-----------|----------|------|
| **Qoder** | ✅✅ **极高** | 🔥🔥 **最高** | SDK 接口与 Claude Agent SDK 几乎同构，可直接复用 claude-runner 模式；原生 session/resume/abort |
| **OpenCode** | ✅ **高度可行** | 🔥 **高优先级** | 完整的 headless HTTP API + 多语言 SDK + 成熟的 session 管理 |
| **Kimi Code** | ❌ **不可集成** | — | GUI 桌面工具，无 CLI/API/headless 模式 |
| **ZCode** | ❌ **不可集成** | — | GUI 桌面工具，自研 Agent 内核不开放 |
| **WorkBuddy** | ⚠️ **部分可行** | ⏸️ **暂缓** | Node.js SDK 不够成熟，缺少 HTTP API 文档，集成成本高 |

> **2026-06-25 更新**：Kimi Code 和 ZCode 确认为 GUI 桌面产品，无编程接口，无法作为 baseagent 集成。实际可集成的只有 Qoder 和 OpenCode 两个。

---

## 一、OpenCode 集成评估

### 1.1 核心架构

OpenCode 是一个 **provider-agnostic** 的 AI coding agent 平台（MIT 开源），支持 75+ LLM 提供商。

**关键特性**：
- **Headless HTTP Server** - `opencode serve` 启动可编程的 API 服务
- **多语言 SDK** - 官方支持 JavaScript/Python/Go/Rust
- **Session 管理** - 原生支持多会话、会话导入导出、自定义元数据
- **事件流** - SSE（Server-Sent Events）实时流式返回

### 1.2 集成接口

#### HTTP API（核心）
```bash
opencode serve --port 4096
```

**端点清单**：
- `GET /event` - SSE 事件流（`server.connected` → 后续事件）
- `POST /session` - 创建会话
- `POST /session/:id/command` - 执行命令
- `POST /session/:id/shell` - Shell 执行
- `PUT /auth/:id` - 设置凭证
- `GET /doc` - OpenAPI 3.1 规范

**认证**：Basic Auth（环境变量 `OPENCODE_SERVER_PASSWORD`/`USERNAME`）

#### SDK 示例（推荐集成路径）

**JavaScript SDK**（官方）：
```javascript
import { OpencodeClient } from 'opencode-sdk';

const client = new OpencodeClient({ baseUrl: 'http://localhost:4096' });
const session = await client.session.create({ title: 'evolclaw-session' });
const res = await client.session.prompt(session.id, {
  parts: [{ content: 'Fix this bug...' }],
  model: 'openai/gpt-4.1'
});
// res 是流式或完整响应
```

**Python SDK**（官方）：
```python
from opencode_sdk import Client

client = Client(base_url='http://localhost:4096')
session = client.session.create({'title': 'evolclaw'})
client.session.prompt(session['id'], {
  'parts': [{'content': 'Generate handler'}],
  'model': 'anthropic/claude-opus-4'
})
```

### 1.3 与 EvolClaw 当前架构的映射

| EvolClaw 接口 | OpenCode 实现 |
|--------------|--------------|
| `AgentRunnerFull.runQuery()` | `client.session.prompt()` |
| `interrupt()` | HTTP API `/session/:id/interrupt` |
| `clearSession()` | `client.session.delete()` + 新建 |
| `switchModel()` | `client.session.prompt()` 的 `model` 参数 |
| `session_id` | OpenCode 原生 session ID |
| 事件流 | SSE `/event` 或 SDK 流式响应 |

### 1.4 集成实现方案

**推荐方案：HTTP Client 模式**（类似 Codex runner）

```typescript
// src/agents/opencode-runner.ts
export class OpencodeRunner implements AgentRunnerFull {
  private baseUrl: string;
  private sessionId: string | null = null;

  async runQuery(prompt: string, options: AgentOptions): AsyncIterable<AgentEvent> {
    // 1. 确保 session 存在
    if (!this.sessionId) {
      const res = await fetch(`${this.baseUrl}/session`, { method: 'POST', ... });
      this.sessionId = (await res.json()).id;
    }

    // 2. 发送 prompt 并读取 SSE 事件流
    const res = await fetch(`${this.baseUrl}/session/${this.sessionId}/command`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ content: prompt }], model: options.model }),
      headers: { 'Accept': 'text/event-stream', ... }
    });

    // 3. 解析 SSE 流 → 转换为 AgentEvent
    for await (const event of parseSSE(res.body)) {
      yield this.transformEvent(event);
    }
  }

  async interrupt(): Promise<void> {
    await fetch(`${this.baseUrl}/session/${this.sessionId}/interrupt`, { method: 'POST' });
  }
}
```

**配置**（`evolclaw.json`）：
```json
{
  "agents": {
    "opencode": {
      "baseUrl": "http://localhost:4096",
      "username": "admin",
      "password": "secret",
      "model": "anthropic/claude-opus-4"
    }
  }
}
```

### 1.5 部署模式

| 模式 | 适用场景 | 命令 |
|------|---------|------|
| **Sidecar**（推荐） | 生产环境，与 evolclaw 同机 | `opencode serve --port 4096` |
| **Kubernetes** | 企业多租户 | KubeOpenCode（官方 K8s Operator） |
| **Serverless** | CI/CD 短时任务 | 容器启动 + 临时 session |

### 1.6 优势与风险

**✅ 优势**：
- **成熟度高** - MIT 开源，社区活跃，已有生产案例（DigitalOcean/Render）
- **接口完整** - HTTP API + 多语言 SDK，集成路径清晰
- **Provider 无关** - 支持所有主流 LLM 提供商（包括 Claude）
- **Session 管理** - 原生多会话、元数据、导入导出
- **可观测性** - OpenTelemetry 集成，SigNoz/Dynatrace 支持

**⚠️ 风险**：
- **额外进程** - 需要运行 `opencode serve`（但可以 systemd/supervisor 托管）
- **网络开销** - HTTP 调用比 SDK 直连慢（但 localhost 可忽略）
- **依赖版本** - OpenCode 仍在快速迭代，API 可能变化

---

## 二、WorkBuddy 集成评估

### 2.1 核心架构

WorkBuddy 是腾讯云的企业级 AI Agent 产品，有两个版本：
- **Tencent WorkBuddy**（闭源，商业产品）
- **work-buddy.ai**（MIT 开源，社区项目）

**关键特性**：
- **双模运行** - 本地沙箱 + 云沙箱
- **技能市场** - 100+ 技能包（HTTP/Script/Python）
- **企业集成** - 飞书/钉钉/微信接入

### 2.2 集成接口

#### Node.js SDK（唯一官方接口）
```javascript
import { query } from "@tencent-ai/agent-sdk";

const resp = await query({
  prompt: "Summarize Q2 sales",
  model: "deepseek-v4-pro",
  permissionMode: "default",
});

for (const msg of resp.messages || []) {
  if (msg.type === "assistant") {
    for (const block of msg.blocks || []) {
      if (block.type === "text") console.log(block.text);
    }
  }
}
```

**问题**：
- ❌ **没有 HTTP API 文档** - 无法像 OpenCode 那样通过 HTTP 控制
- ❌ **没有 Python/Go SDK** - 只有 Node.js SDK
- ❌ **没有 CLI 文档** - 启动/停止/配置的命令行不明确
- ❌ **没有 Session 管理 API** - 不清楚如何创建/切换/清除会话

### 2.3 集成可行性分析

| 需求 | OpenCode | WorkBuddy | 评估 |
|------|---------|-----------|------|
| HTTP API | ✅ 完整 OpenAPI | ❌ 未公开 | WorkBuddy 需要自行封装 |
| 多语言 SDK | ✅ JS/Python/Go/Rust | ❌ 仅 Node.js | WorkBuddy 锁定 Node.js |
| Session 管理 | ✅ 原生支持 | ❓ 文档缺失 | WorkBuddy 机制不明 |
| 事件流 | ✅ SSE | ❓ 未说明 | WorkBuddy 可能是批量返回 |
| 中断机制 | ✅ `/interrupt` 端点 | ❌ 未提及 | WorkBuddy 可能不支持 |
| 开源/社区 | ✅ MIT，活跃社区 | ⚠️ 商业闭源 | WorkBuddy 依赖腾讯 |

### 2.4 集成方案（如果强行实现）

**方案：Node.js Child Process + IPC**

```typescript
// src/agents/workbuddy-runner.ts
export class WorkbuddyRunner implements AgentRunnerFull {
  private bridgeProcess: ChildProcess;

  async runQuery(prompt: string, options: AgentOptions): AsyncIterable<AgentEvent> {
    // 1. 启动 Node.js bridge 进程（类似 Hermes 的 Python bridge）
    if (!this.bridgeProcess) {
      this.bridgeProcess = spawn('node', ['workbuddy-bridge.js']);
    }

    // 2. 通过 stdin/stdout 发送 JSON RPC 请求
    this.bridgeProcess.stdin.write(JSON.stringify({
      method: 'query',
      params: { prompt, model: options.model }
    }));

    // 3. 读取 stdout 并转换为 AgentEvent
    for await (const line of readline.createInterface({ input: this.bridgeProcess.stdout })) {
      const event = JSON.parse(line);
      yield this.transformEvent(event);
    }
  }
}
```

**workbuddy-bridge.js**（Node.js IPC 桥）：
```javascript
import { query } from "@tencent-ai/agent-sdk";
import readline from "readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const req = JSON.parse(line);
  if (req.method === 'query') {
    const resp = await query(req.params);
    console.log(JSON.stringify(resp)); // stdout 返回
  }
});
```

**问题**：
- 复杂度高（类似已废弃的 Hermes bridge）
- 没有 interrupt/clearSession 机制
- 腾讯 SDK 可能不支持长会话
- 商业依赖（需要腾讯云账号、配额）

---

## 三、集成建议

### 3.1 短期（1-2 周）

**✅ 优先集成 OpenCode**

**理由**：
1. **接口成熟** - HTTP API + SDK，开箱即用
2. **集成简单** - 参考 Codex runner 的 HTTP Client 模式
3. **Provider 兼容** - 支持 Claude/OpenAI/Gemini 等所有 LLM
4. **社区验证** - 已有 DigitalOcean/Render 等生产案例

**实施步骤**：
1. 本地运行 `opencode serve --port 4096` 验证 API
2. 实现 `src/agents/opencode-runner.ts`（HTTP Client 模式）
3. 添加 `OpencodeAgentPlugin` 到 `src/core/baseagent-loader.ts`
4. 配置 `evolclaw.json` → `agents.opencode` 字段
5. 测试 `/baseagent opencode` 命令切换

**预计工作量**：3-5 天（参考 Gemini runner 实现）

### 3.2 中期（1-2 月）

**⏸️ WorkBuddy 暂缓，等待官方 API 成熟**

**条件**（满足任一即可重新评估）：
1. 腾讯发布 HTTP/gRPC API 文档
2. WorkBuddy 提供 Python/Go SDK
3. 社区出现成熟的桥接方案
4. 有明确的企业客户需求（腾讯云生态）

**当前不推荐原因**：
- 集成成本高（需要自建 IPC bridge）
- 维护成本高（腾讯 SDK 快速迭代）
- 收益不明确（OpenCode 已覆盖主流场景）

### 3.3 长期架构建议

**保持 baseagent 抽象的纯净性**：

```typescript
// 当前设计（好）
interface AgentRunnerFull {
  runQuery(prompt: string, options: AgentOptions): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  clearSession(): Promise<void>;
}

// 未来扩展（如果需要）
interface AgentRunnerWithSkills extends AgentRunnerFull {
  registerSkill(skill: SkillDefinition): Promise<void>; // WorkBuddy 特有
  listSkills(): Promise<string[]>;
}
```

**原则**：
- 核心接口（runQuery/interrupt/clearSession）保持不变
- 特定 runner 的特性通过子接口扩展
- 不要为单个 runner 破坏抽象

---

## 四、技术细节对比

### 4.1 事件流格式

**OpenCode SSE**（推断自文档）：
```
event: server.connected
data: {"status":"ok"}

event: assistant.text
data: {"delta":"Hello"}

event: assistant.tool_use
data: {"tool":"read_file","params":{"path":"..."}}
```

**WorkBuddy SDK**（实际格式）：
```javascript
{
  messages: [
    { type: "assistant", blocks: [{ type: "text", text: "Hello" }] }
  ]
}
```

**映射到 EvolClaw AgentEvent**：
```typescript
// OpenCode → AgentEvent
{ type: 'text', text: 'Hello' }
{ type: 'tool_use', name: 'read_file', input: { path: '...' } }

// WorkBuddy → AgentEvent（需要解析 blocks）
{ type: 'text', text: 'Hello' }
```

### 4.2 模型配置

**OpenCode**（Provider 字符串）：
```json
{
  "model": "anthropic/claude-opus-4",
  "model": "openai/gpt-4.1",
  "model": "deepseek/v3"
}
```

**WorkBuddy**（简单字符串）：
```json
{
  "model": "deepseek-v4-pro"
}
```

### 4.3 Session 管理

**OpenCode**：
```javascript
// 创建会话
const session = await client.session.create({ title: 'evolclaw' });

// 恢复会话
const session = await client.session.get(sessionId);

// 清除会话
await client.session.delete(sessionId);
```

**WorkBuddy**：
```javascript
// ❓ 文档未说明 session 管理机制
// 可能每次 query() 都是新会话
```

---

## 五、风险评估

### OpenCode 风险矩阵

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| API 版本变化 | 🟡 中 | 锁定 OpenCode 版本，定期跟进 changelog |
| 额外进程管理 | 🟢 低 | systemd/supervisor 托管，health check |
| 网络延迟 | 🟢 低 | localhost 部署，HTTP/2 优化 |
| 依赖复杂度 | 🟢 低 | OpenCode 本身无额外依赖 |

### WorkBuddy 风险矩阵

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| API 不稳定 | 🔴 高 | **暂缓集成** |
| 文档缺失 | 🔴 高 | 等待官方完善 |
| 商业依赖 | 🟡 中 | 需要腾讯云账号 + 配额 |
| IPC 桥复杂度 | 🔴 高 | 类似 Hermes，已证明维护成本高 |

---

## 六、参考资料

### OpenCode
- 官网：https://opencode.ai
- GitHub：https://github.com/opencode-ai/opencode
- 文档：https://opencode.ai/docs
- HTTP API：https://opencode.ai/docs/server
- JavaScript SDK：https://opencode.ai/docs/sdk
- Python SDK：https://github.com/anomalyco/opencode-sdk-python

### WorkBuddy
- Tencent 官网：https://workbuddy.ai
- Tencent Cloud 文档：https://tencentcloud.com/ind/document/product/1300/80640
- Node.js SDK：https://npmjs.com/package/@tencent-ai/agent-sdk
- 开源版本：https://work-buddy.ai（注意：这是社区版，不是腾讯产品）

---

## 附录：快速验证脚本

### OpenCode 本地测试

```bash
# 1. 安装 OpenCode
npm install -g opencode

# 2. 启动 HTTP 服务
opencode serve --port 4096

# 3. 测试 API（另一个终端）
curl http://localhost:4096/doc  # 查看 OpenAPI 规范

# 4. 创建会话并查询（使用 JavaScript SDK）
node -e "
import('opencode-sdk').then(async ({OpencodeClient}) => {
  const c = new OpencodeClient({baseUrl:'http://localhost:4096'});
  const s = await c.session.create({title:'test'});
  console.log('Session ID:', s.id);
});
"
```

### WorkBuddy 本地测试

```bash
# 1. 安装 SDK
npm install @tencent-ai/agent-sdk

# 2. 测试查询
node -e "
import('@tencent-ai/agent-sdk').then(async ({query}) => {
  const r = await query({prompt:'Hello', model:'deepseek-v4-pro'});
  console.log(JSON.stringify(r, null, 2));
});
"
```

---

# 四、Qoder 集成评估（2026-06-24 增补）

## 4.1 产品背景

**Qoder** 是阿里巴巴推出的 agentic coding 平台（2025 公开预览），定位类似 Cursor/Claude Code。
提供桌面 IDE、JetBrains 插件、CLI、Cloud Agents（云端 agent）和 SDK 全套能力。

**关键事实**（已验证 npm 包真实存在）：
- TypeScript SDK：`@qoder-ai/qoder-agent-sdk` **v1.0.7**
- CLI：`@qoder-ai/qodercli` **v1.0.26**（bin: `qodercli`）
- Python SDK：存在（PAT 认证）
- Cloud Agents REST API + SSE（Beta）
- 认证：Personal Access Token（`QODER_PERSONAL_ACCESS_TOKEN`）

## 4.2 ⭐ 核心发现：SDK 与 Claude Agent SDK 几乎同构

这是 Qoder 最大的集成优势。对比三者的 `query()` 接口：

```javascript
// Claude Agent SDK（EvolClaw 当前 claude-runner 使用）
import { query } from '@anthropic-ai/claude-agent-sdk';
for await (const message of query({ prompt, options: { model, permissionMode, ... } })) {
  if (message.type === 'assistant') { /* message.message.content blocks */ }
  else if (message.type === 'result') { /* message.subtype */ }
}

// Qoder Agent SDK ← 几乎一模一样！
import { accessTokenFromEnv, query } from '@qoder-ai/qoder-agent-sdk';
for await (const message of query({ prompt, options: { auth: accessTokenFromEnv(), allowedTools, permissionMode } })) {
  if (message.type === 'assistant') { /* message.message.content blocks */ }
  else if (message.type === 'result') { /* message.subtype */ }
}
```

**结论**：Qoder SDK 很可能 fork 自 Claude Agent SDK（或刻意保持兼容）——包括底层走 CLI 子进程、`SDKMessage` 类型、stream_event 机制都一致。

## 4.3 Options 字段对照表

| 字段 | Claude SDK | Qoder SDK | 说明 |
|------|:---:|:---:|------|
| `prompt` | ✅ | ✅ | 同构 |
| `model` | ✅ | ✅ | Qoder 用语义档位：`auto`/`ultimate`/`performance`/`efficient`/`lite` |
| `systemPrompt` | ✅ | ✅ | 支持 string 或 `{type:'preset', preset:'qodercli', append}` |
| `permissionMode` | ✅ | ✅ | `acceptEdits`/`bypassPermissions` 等 |
| `allowedTools` | ✅ | ✅ | `['Read','Write','Edit','Glob','Grep','Bash']` |
| `maxTurns` | ✅ | ✅ | 同构 |
| `resume` | ✅ | ✅ | Session ID 恢复 |
| `sessionId` | ✅ | ✅ | 指定 session UUID |
| `forkSession` | ✅ | ✅ | resume 时 fork 新 session |
| `continue` | ✅ | ✅ | 继续最近 session |
| `cwd` | ✅ | ✅ | 工作目录 |
| `abortController` | ✅ | ✅ | **中断机制** |
| `includePartialMessages` | ✅ | ✅ | 流式 stream_event |
| `env` | ✅ | ✅ | 环境变量注入 |
| `fallbackModel` | ✅ | ✅ | 主模型失败时回退 |
| `auth` | ❌ | ✅ | Qoder 特有：`accessTokenFromEnv()` |

**字段重合度 >95%**。唯一差异是 Qoder 用 `auth` 显式传 token，而 Claude 走 env。

## 4.4 三大核心能力齐备（OpenCode/WorkBuddy 对比）

| 能力 | Qoder | OpenCode | WorkBuddy |
|------|:---:|:---:|:---:|
| **Session 管理** | ✅ `resume`/`sessionId`/`forkSession`/`continue` | ✅ HTTP API | ❌ 无 |
| **中断机制** | ✅ `abortController.abort()` | ✅ `/interrupt` | ❌ 仅 HTTP abort |
| **流式输出** | ✅ `includePartialMessages` + stream_event | ✅ SSE | ✅ stream_event |
| **多模态** | ✅（Anthropic content blocks） | ✅ | ✅ |
| **集成方式** | npm 包直接调用 | HTTP Client | npm 包直接调用 |

Qoder 是**唯一三大核心能力全部原生支持、且接口与现有 claude-runner 同构**的候选。

## 4.5 集成实现方案

**方案：直接复制 claude-runner，改 import + auth**（最省力）

```typescript
// src/agents/qoder-runner.ts
import { accessTokenFromEnv, query } from '@qoder-ai/qoder-agent-sdk';
import type { AgentRunnerFull, ModelSwitcher, AgentEvent } from './runner-types.js';

export class QoderRunner implements AgentRunnerFull, ModelSwitcher {
  private currentSessionId: string | null = null;
  private abortController: AbortController | null = null;

  async *runQuery(prompt: string, options: AgentOptions): AsyncIterable<AgentEvent> {
    this.abortController = new AbortController();

    const q = query({
      prompt,
      options: {
        auth: accessTokenFromEnv(),       // 读 QODER_PERSONAL_ACCESS_TOKEN
        model: options.model || 'auto',
        permissionMode: options.permissionMode || 'acceptEdits',
        cwd: options.projectPath,
        resume: this.currentSessionId || undefined,   // session 续接
        abortController: this.abortController,
        includePartialMessages: true,
        env: { QODER_PERSONAL_ACCESS_TOKEN: this.config.apiKey },
      },
    });

    // ↓ 这段几乎可以直接抄 claude-runner 的 transformStream()
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        this.currentSessionId = message.session_id;
        yield { type: 'session_id', sessionId: message.session_id };
      } else if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') yield { type: 'text', text: block.text };
          else if (block.type === 'tool_use') yield { type: 'tool_use', name: block.name, input: block.input };
        }
      } else if (message.type === 'stream_event') {
        // 同 claude-runner 的部分流式处理
      } else if (message.type === 'result') {
        yield { type: 'complete', isError: message.subtype !== 'success', subtype: message.subtype, durationMs: message.duration_ms };
      }
    }
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  async clearSession(): Promise<void> {
    this.currentSessionId = null;
  }

  switchModel(model: string): void { this.config.model = model; }
}
```

**插件注册**（`src/core/baseagent-loader.ts` 风格）：
```typescript
export class QoderAgentPlugin implements AgentPlugin {
  readonly name = 'qoder';
  isEnabled(agent: EvolAgent): boolean {
    return !!agent.config.baseagents?.qoder;
  }
  createAgent(agent, callbacks): AgentInstance | null {
    const apiKey = resolveQoderConfig(agent).apiKey;
    if (!apiKey) return null;  // 无凭证则跳过
    return { evolagentName: agent.name, baseagent: 'qoder', agent: new QoderRunner(...) };
  }
}
```

**配置**（`evolclaw.json`）：
```json
{
  "agents": {
    "qoder": {
      "apiKey": "qoder-pat-...",
      "model": "auto"
    }
  }
}
```

## 4.6 工作量评估

| 任务 | 工作量 | 说明 |
|------|-------|------|
| `qoder-runner.ts` | 1-2 天 | 复制 claude-runner，改 import/auth/事件映射 |
| `QoderAgentPlugin` + 配置解析 | 0.5 天 | 参考 gemini plugin |
| 验证 SDKMessage 实际类型 | 0.5 天 | 跑通 demo，确认 init 事件携带 session_id |
| 测试 + 文档 | 1 天 | `/baseagent qoder` 切换 + CLAUDE.md |
| **合计** | **3-4 天** | 比 OpenCode 更省（无需起 HTTP 服务） |

**风险**：
- 🟡 SDK 仍在迭代（v1.0.x），需锁版本
- 🟡 `SDKMessage` 完整类型未在文档列全，需跑 demo 实测（尤其 `system/init` 是否携带 `session_id`）
- 🟢 需要 Qoder PAT（注册阿里云/Qoder 账号）
- 🟢 商业服务，可能有配额/计费（credit-based）

## 4.7 与现有 runner 的关系

```
claude-runner.ts  ← @anthropic-ai/claude-agent-sdk
qoder-runner.ts   ← @qoder-ai/qoder-agent-sdk    （结构同构，~90% 代码可复用）
codex-runner.ts   ← OpenAI Responses API          （HTTP）
gemini-runner.ts  ← gemini CLI subprocess         （子进程 JSONL）
```

Qoder runner 在架构上与 claude-runner 是「兄弟」关系，可考虑抽出共享的 `transformAgentSdkStream()` 工具函数供两者复用。

## 4.8 推荐

**✅ 强烈推荐集成 Qoder，优先级高于 OpenCode。**

理由：
1. **集成成本最低** - SDK 与现有 claude-runner 同构，~90% 代码可复用
2. **能力最完整** - session/中断/流式/多模态全部原生支持
3. **无额外进程** - npm 包直接调用，不像 OpenCode 需起 HTTP 服务
4. **接口稳定** - 走 Agent SDK 标准模式，比 WorkBuddy 的不确定性低得多

**建议实施顺序**：先做 Qoder（复用度最高，快速验证 SDK 同构假设）→ 再做 OpenCode（HTTP 模式，覆盖自托管场景）→ WorkBuddy 继续暂缓。

## 4.9 验证脚本

```bash
# 1. 安装 SDK
npm install @qoder-ai/qoder-agent-sdk

# 2. 设置 PAT（需先在 qoder.com 注册并创建 PAT）
export QODER_PERSONAL_ACCESS_TOKEN="qoder-pat-..."

# 3. 跑通 demo，确认消息类型（重点看 system/init 是否带 session_id）
node --input-type=module -e "
import { accessTokenFromEnv, query } from '@qoder-ai/qoder-agent-sdk';
for await (const m of query({ prompt: 'say hi', options: { auth: accessTokenFromEnv(), allowedTools: [], maxTurns: 1 } })) {
  console.log(JSON.stringify({ type: m.type, subtype: m.subtype, session_id: m.session_id }, null, 2));
}
"
```

## 4.10 参考资料

- 官网：https://qoder.com
- 文档：https://docs.qoder.com
- SDK 快速开始：https://docs.qoder.com/en/cli/sdk/quick-start
- SDK 参考：https://docs.qoder.com/en/cli/sdk/references
- CLI：https://qoder.com/en/cli
- Cloud Agents API：https://docs.qoder.com/cloud-agents/overview
- GitHub Action：https://github.com/QoderAI/qoder-action
- npm SDK：https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk
- npm CLI：https://www.npmjs.com/package/@qoder-ai/qodercli

---

## 五、Kimi Code 与 ZCode 集成评估（2026-06-25 增补）

### 5.1 研究结论：两者均为 GUI 工具，无法集成

| 产品 | 形态 | 集成可行性 | 理由 |
|------|------|:---:|------|
| **Kimi Code** | GUI 桌面工具 | ❌ | 月之暗面出品的 Agentic IDE，无 CLI/API/headless 模式 |
| **ZCode** | GUI 桌面工具 | ❌ | 智谱 GLM 的 Agentic Development Environment，自研 Agent 内核不开放 |

### 5.2 Kimi Code

**产品定位**：月之暗面推出的 AI 编程 GUI 工具，类似 Cursor/Windsurf。

**关键事实**：
- **没有 CLI 版本** — 纯桌面应用，无命令行接口
- **没有编程 SDK** — 无法通过代码驱动
- **没有 headless 模式** — 无法在服务器环境运行

**集成障碍**：和 QoderWork 同类——GUI 产品没有编程入口，无法作为 EvolClaw 的 baseagent。

**注意**：Kimi Code **不是** Moonshot API（后者提供 Anthropic 兼容端点，可以通过配置 `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic` 接入）。如果目标是使用 Kimi 模型能力，应该走 API 端点而不是集成 GUI 工具。

### 5.3 ZCode

**产品定位**：智谱 GLM 的 Agentic Development Environment，对标 Cursor/Qoder Work。

**演进历史**：
- **1.0**（2025-12）— 多 CLI Agent 的命令行壳子（集成 Claude Code/Codex/Gemini）
- **3.0**（2026-06-13）— 完全重写，切换到 **自研 ZCode Agent 内核** + 桌面 GUI

**关键事实**（官方声明，2026-06-13）：
- "全面切换自研 ZCode Agent 内核"
- "针对满血 GLM-5.2 深度优化"
- "**后续版本将聚焦自研 Agent 体验，不再内置或维护其他 Agent 适配**"

**集成障碍**：
- ZCode Agent 内核 **只在 ZCode GUI 内部使用**，不对外提供 SDK/API
- 官方明确放弃了对外部 Agent 的适配支持
- 无独立 CLI 工具、无编程接口、无 headless 模式

**注意**：ZCode 不是 GLM API。如果目标是使用 GLM 模型能力，应该：
1. 使用 GLM Coding Plan API（提供 Anthropic 兼容端点）
2. 或者等待官方 MIT 协议的开源 API 版本（计划 2026-06 下旬上线）

### 5.4 与 Qoder/OpenCode 的本质区别

| 维度 | Qoder / OpenCode | Kimi Code / ZCode |
|------|-----------------|-------------------|
| **产品形态** | CLI Agent + SDK/API | GUI Agentic IDE |
| **编程入口** | ✅ TypeScript SDK / HTTP API | ❌ 无 |
| **Headless 运行** | ✅ 支持 | ❌ 必须 GUI |
| **集成方式** | 新 runner（3-5 天） | 不可集成 |

**结论**：Qoder 和 OpenCode 的"可集成性"来自它们提供了**编程驱动的后端服务**（SDK 或 HTTP API），而 Kimi Code 和 ZCode 是**桌面产品**——两者根本不在同一层。

### 5.5 如果想用 Kimi/GLM 模型怎么办？

**正确路径**：使用 API 端点，而不是集成 GUI 工具。

```json
// Kimi 模型（通过 Moonshot API）
{
  "agents": {
    "claude": {
      "baseUrl": "https://api.moonshot.ai/anthropic",
      "model": "moonshot-v1-32k",
      "apiKey": "<moonshot-key>"
    }
  }
}

// GLM 模型（通过智谱 API）
{
  "agents": {
    "claude": {
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4/",  // 待验证 Anthropic 兼容性
      "model": "glm-5.2",
      "apiKey": "<zhipu-key>"
    }
  }
}
```

**集成成本**：~0 行代码（复用现有 `claude-runner`，仅需填配置）。

**注意**：Anthropic 兼容端点的兼容度需要实测验证（thinking、prompt caching、tool behavior、session resume 等）。

---

## 六、最终集成优先级（5 个产品修正版）

| 排序 | 产品 | 集成方式 | 成本 | 推荐理由 |
|:---:|------|---------|:---:|----------|
| 1 | **Qoder** | 新 runner（SDK 同构） | 3-4 天 | SDK 与 claude-runner 同构，session/中断/流式全支持 |
| 2 | **OpenCode** | 新 runner（HTTP） | 3-5 天 | HTTP API 成熟，provider 无关，社区验证 |
| — | **Kimi Code** | ❌ 不可集成 | N/A | GUI 工具，无编程接口；想用 Kimi 模型走 Moonshot API |
| — | **ZCode** | ❌ 不可集成 | N/A | GUI 工具，自研内核不开放；想用 GLM 模型走智谱 API |
| — | **WorkBuddy** | 暂缓 | 高 | Node.js SDK 受限，无 HTTP API，集成成本高 |

---

**总研究结论**（2026-06-25 修正）：
- **Qoder** — 集成成本最低（SDK 同构 claude-runner），能力最完整，**最高优先级**
- **OpenCode** — 接口成熟，HTTP 模式适合自托管，**次优先级**
- **Kimi Code / ZCode** — GUI 桌面产品，无编程接口，**不可集成**
- **WorkBuddy** — SDK 受限（无 session/中断），**继续暂缓**
