# 权限控制、动态输出与执行中交互设计方案

**版本**: v1.1
**日期**: 2026-03-10
**状态**: 待实现

---

## 背景

EvolClaw 作为轻量级 AI Agent 网关，需要在保持简洁架构的前提下增强三个核心能力：

1. **权限控制**：拦截危险命令（如 `rm -rf /`、`sudo` 等），保护系统安全
2. **动态输出**：将 Agent 执行过程中的工具调用和文本输出实时推送给用户，提升交互体验
3. **执行中交互**：支持用户在 Agent 执行过程中发送新消息或中断任务（类似 Claude Code CLI）

---

## 方案一：权限控制（极简版）

### 设计原则

- **零配置**：硬编码黑名单，无需配置文件
- **最小侵入**：仅在 `query()` 调用时增加一个参数
- **精准拦截**：只拦截 Bash 工具的危险命令，其余工具全部放行

### 实现方案

#### 1. 新增文件：`src/core/permission.ts`

```typescript
// 危险命令黑名单（正则表达式）
const DANGEROUS_PATTERNS = [
  /\brm\s+-\w*r\w*f/,        // rm -rf
  /\bsudo\b/,                 // sudo
  /\bmkfs\b/,                 // mkfs (格式化文件系统)
  /\bdd\s+if=/,               // dd (磁盘操作)
  /\bchmod\s+777/,            // chmod 777 (危险权限)
  />\s*\/dev\//,              // 重定向到设备文件
  /\bshutdown\b/,             // 关机
  /\breboot\b/,               // 重启
];

/**
 * 权限检查回调函数
 * 符合 Claude Agent SDK 的 can_use_tool 接口
 */
export async function canUseTool(
  tool: string,
  input: Record<string, any>,
): Promise<{ type: 'allow' } | { type: 'deny'; message: string }> {

  // 只检查 Bash 工具，其余工具全部放行
  if (tool === 'Bash') {
    const cmd = input.command || '';

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          type: 'deny',
          message: `⛔ 危险命令被拦截: ${cmd.substring(0, 80)}`
        };
      }
    }
  }

  // 默认允许
  return { type: 'allow' };
}
```

#### 2. 集成到 `src/agent-runner.ts`

```typescript
import { canUseTool } from './core/permission.js';

// 在 query() 调用中增加 can_use_tool 参数
return query({
  prompt: prompt,
  options: {
    cwd: projectPath,
    can_use_tool: canUseTool,  // 新增这一行
    ...(claudeSessionId ? { resume: claudeSessionId } : {}),
    env: { /* ... */ }
  }
});
```

### 扩展方式

后续需要增加拦截规则时，直接在 `DANGEROUS_PATTERNS` 数组中添加正则表达式即可：

```typescript
const DANGEROUS_PATTERNS = [
  // ... 现有规则
  /\bnpm\s+install\s+-g/,    // 禁止全局安装 npm 包
  /\bpip\s+install.*--break-system-packages/,  // 禁止破坏系统包
];
```

### 代码量

- 新增文件：1 个（`src/core/permission.ts`）
- 新增代码：约 30 行
- 修改代码：1 行（`agent-runner.ts` 的 `query()` 调用）

---

## 方案二：动态输出（事件流 + 文本内容合并）

### 问题分析

当前实现存在两个问题：

1. **文本延迟**：所有 `text_delta` 事件累积完成后才一次性发送，用户等待时间长
2. **过程不可见**：工具调用（Read、Bash、Grep 等）和子代理活动完全不输出，用户无法感知进度

### 设计目标

在 `for await (const event of stream)` 循环中，将文本片段和工具活动按时间窗口批量推送，用户看到的效果：

```
🔧 Read: src/index.ts
🔧 Bash: npm test
测试全部通过，以下是结果摘要：
  ✓ 12 个测试通过
  ✓ 覆盖率 85%

[3 秒后]

🔧 Write: src/new-feature.ts
已创建新文件，包含以下功能...
```

### 实现方案

#### 1. 新增文件：`src/core/stream-flusher.ts`

```typescript
/**
 * 流式输出缓冲器
 * 按时间窗口批量推送文本和活动事件
 */
export class StreamFlusher {
  private buffer = '';
  private activities: string[] = [];
  private timer?: NodeJS.Timeout;
  private lastFlush = Date.now();

  constructor(
    private send: (text: string) => Promise<void>,
    private interval = 3000  // 3 秒一次
  ) {}

  /** 追加文本片段 */
  addText(text: string) {
    this.buffer += text;
    this.scheduleFlush();
  }

  /** 追加活动事件（工具调用等） */
  addActivity(desc: string) {
    this.activities.push(desc);
    this.scheduleFlush();
  }

  /** 检查是否有待发送内容 */
  hasContent(): boolean {
    return this.buffer.length > 0 || this.activities.length > 0;
  }

  private scheduleFlush() {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastFlush;
    const delay = Math.max(0, this.interval - elapsed);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  /** 立即刷出缓冲内容 */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // 组合活动 + 文本
    let output = '';
    if (this.activities.length > 0) {
      output += this.activities.join('\n') + '\n\n';
      this.activities = [];
    }
    if (this.buffer) {
      output += this.buffer;
      this.buffer = '';
    }

    if (output) {
      await this.send(output);
      this.lastFlush = Date.now();
    }
  }
}
```

#### 2. 集成到 `src/index.ts` 的事件循环

```typescript
import { StreamFlusher } from './core/stream-flusher.js';

// 在 for await 循环前创建 flusher
const flusher = new StreamFlusher(
  (text) => feishu.sendMessage(chatId, text),
  3000  // 3 秒间隔
);

for await (const event of stream) {
  // 提取 session ID（保持不变）
  if (event.session_id) {
    agentRunner.updateSessionId(session.id, event.session_id);
  }

  // 系统事件（保持不变）
  if (event.type === 'system' && event.subtype === 'compact_boundary') {
    await flusher.flush();  // 先刷出缓冲
    await feishu.sendMessage(chatId, `💡 会话已自动压缩...`);
  }

  // 文本事件 → 缓冲
  if (event.type === 'text_delta') {
    flusher.addText(event.text);
  } else if (event.type === 'assistant' && event.message?.content) {
    for (const content of event.message.content) {
      if (content.type === 'text' && content.text) {
        flusher.addText(content.text);
      }
    }
  }

  // 工具调用事件 → 活动提示
  else if (event.type === 'tool_use') {
    const toolName = event.name || event.tool_name || 'Unknown';
    const desc = event.input?.description || '';
    flusher.addActivity(`🔧 ${toolName}${desc ? ': ' + desc : ''}`);
  }

  // 子代理事件
  else if (event.type === 'subagent_start') {
    const agentType = event.agent_type || 'subagent';
    flusher.addActivity(`🤖 启动子代理: ${agentType}`);
  }

  // result 兜底（同现有逻辑）
  else if (event.type === 'result' && event.result) {
    if (!flusher.hasContent()) {
      flusher.addText(event.result);
    }
  }
}

// 最后刷出剩余内容
await flusher.flush();

// 后续的文件发送逻辑保持不变
// （从 flusher.buffer 中提取 [SEND_FILE:] 标记需要调整）
```

#### 3. 文件发送标记处理调整

由于文本现在是分批发送的，需要在最后一次 flush 后统一处理 `[SEND_FILE:]` 标记。可以在 `StreamFlusher` 中增加一个 `getFinalText()` 方法来获取完整文本用于文件标记提取。

### 用户体验对比

**改进前**：
- 用户发送消息后等待 30 秒
- 收到一条完整的长消息
- 无法感知 Agent 在做什么

**改进后**：
- 每 3 秒收到一条进度更新
- 看到工具调用活动（"正在读取文件..."、"正在执行测试..."）
- 文本内容逐步呈现
- 整体感知更流畅

### 代码量

- 新增文件：1 个（`src/core/stream-flusher.ts`）
- 新增代码：约 60 行
- 修改代码：约 30 行（`src/index.ts` 的事件循环）

---

## 方案三：执行中交互（SDK interrupt 方法）

### 问题分析

**当前限制**：
- 用户发送消息后，必须等待 Agent 完成整个任务才能发送下一条
- 无法中途取消长时间运行的任务
- 无法在执行过程中补充信息或改变方向

**目标**：
- 用户可以在 Agent 执行过程中发送新消息
- 支持立即中断当前任务
- 新消息可以是补充信息、方向调整或取消指令

### 技术选型

经过评估，选择 **SDK interrupt() 方法**而非 AbortController，原因：

**AbortController 的隐患**：
- ❌ 无法立即中断（SDK 不接受 signal 参数，只能在事件循环中手动检测）
- ❌ 中断延迟取决于工具调用耗时（如 Bash 命令运行 30 秒，必须等待完成）
- ❌ 资源清理不确定（AsyncIterable 可能未正确关闭）
- ❌ 会话状态可能不一致
- ❌ 非官方支持的方式

**SDK interrupt() 的优势**：
- ✅ 立即停止生成（SDK 内部处理）
- ✅ 正确清理资源（SDK 保证）
- ✅ 处理会话状态（SDK 知道如何恢复）
- ✅ 官方支持的标准方式

**改动成本**：
- 总代码量：2677 行
- 预计改动：150-200 行
- 改动比例：5.6-7.5%（可接受）

### 实现方案

#### 1. 重构 `src/agent-runner.ts` 为 Client 模式

```typescript
import { ClaudeSDKClient, ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from './config.js';
import path from 'path';
import { MessageStream, ImageData } from './message-stream.js';
import { logger } from './utils/logger.js';

export class AgentRunner {
  private apiKey: string;
  private clients = new Map<string, ClaudeSDKClient>();
  private onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void;

  constructor(apiKey: string, onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void) {
    this.apiKey = apiKey;
    this.onSessionIdUpdate = onSessionIdUpdate;
  }

  async runQuery(
    sessionId: string,
    prompt: string,
    projectPath: string,
    initialClaudeSessionId?: string,
    images?: ImageData[]
  ): Promise<AsyncIterable<any>> {
    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    let client = this.clients.get(sessionId);

    if (!client) {
      const options: ClaudeAgentOptions = {
        cwd: projectPath,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.apiKey,
          PATH: process.env.PATH,
          ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {})
        }
      };
      client = new ClaudeSDKClient(options);
      this.clients.set(sessionId, client);
    }

    // 构造 prompt（文本或 MessageStream）
    const finalPrompt = images && images.length > 0
      ? (() => {
          const stream = new MessageStream();
          stream.push(prompt, images);
          stream.end();
          return stream;
        })()
      : prompt;

    await client.query(finalPrompt);
    return client.receive_response();
  }

  // 新增：中断方法
  async interrupt(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (client) {
      await client.interrupt();
      logger.info(`[AgentRunner] Interrupted session: ${sessionId}`);
    }
  }

  updateSessionId(sessionId: string, claudeSessionId: string): void {
    if (this.onSessionIdUpdate) {
      this.onSessionIdUpdate(sessionId, claudeSessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (client) {
      await client.close();
      this.clients.delete(sessionId);
    }
  }
}
```

#### 2. 修改 `src/core/message-queue.ts` 支持中断

```typescript
// 在 MessageQueue 类中新增字段和方法

class MessageQueue {
  private currentSessionId?: string;
  private interruptCallback?: (sessionId: string) => Promise<void>;

  // 设置中断回调
  setInterruptCallback(callback: (sessionId: string) => Promise<void>) {
    this.interruptCallback = callback;
  }

  async process(handler: (msg: QueuedMessage) => Promise<void>) {
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      this.currentSessionId = msg.sessionId;

      // 检查队列中是否有新消息（表示用户想中断）
      if (this.queue.length > 0 && this.interruptCallback) {
        logger.info('[MessageQueue] New message detected, interrupting current task');
        await this.interruptCallback(msg.sessionId);
      }

      try {
        await handler(msg);
      } finally {
        this.currentSessionId = undefined;
      }
    }
  }
}
```

#### 3. 修改 `src/index.ts` 集成中断逻辑

```typescript
// 在 main() 函数中设置中断回调
messageQueue.setInterruptCallback(async (sessionId) => {
  await agentRunner.interrupt(sessionId);
});

// 在事件循环中处理中断
let interrupted = false;

for await (const event of stream) {
  // 提取 session ID
  if (event.session_id) {
    agentRunner.updateSessionId(session.id, event.session_id);
  }

  // 检查是否被中断（SDK interrupt 会让流提前结束）
  if (event.type === 'interrupted' || event.type === 'error') {
    interrupted = true;
    await flusher.flush();
    await feishu.sendMessage(chatId, '⚠️ 任务已中断，正在处理新消息...');
    break;
  }

  // ... 原有的事件处理逻辑
}

if (!interrupted) {
  // 正常完成
  await flusher.flush();
  // ... 文件发送逻辑
}
```

### 关键实现细节

1. **Client 生命周期管理**
   - 每个 session 对应一个 ClaudeSDKClient 实例
   - Client 实例缓存在 Map 中，避免重复创建
   - 调用 `closeSession()` 时正确清理 Client

2. **中断触发时机**
   - MessageQueue 在 `process()` 循环中检测队列长度
   - 如果 `queue.length > 0`，说明有新消息到达
   - 立即调用 `interruptCallback` 触发中断

3. **中断后的处理**
   - SDK interrupt() 会让 `receive_response()` 流提前结束
   - 事件循环检测到中断事件后 break
   - 发送中断提示消息给用户
   - MessageQueue 继续处理下一条消息

### 用户体验示例

**场景 1：中途取消任务**
```
用户: 帮我分析整个项目的代码结构
[Agent 开始执行，读取文件...]
🔧 Read: src/index.ts
🔧 Read: src/agent-runner.ts
用户: 停止，我只需要分析 src 目录
→ 系统立即调用 interrupt()
→ SDK 停止当前生成
⚠️ 任务已中断，正在处理新消息...
→ Agent 处理新消息："只分析 src 目录"
```

**场景 2：补充信息**
```
用户: 帮我写一个登录功能
[Agent 开始执行...]
🔧 Write: src/auth/login.ts
用户: 使用 JWT 认证
→ 系统中断当前任务
→ Agent 收到补充信息，调整实现方案
```

### 代码量

- 重构文件：1 个（`agent-runner.ts`）
- 修改文件：2 个（`message-queue.ts`, `index.ts`）
- 新增代码：约 80 行
- 修改代码：约 100 行
- 总改动：约 180 行（6.7%）

---

## 技术依赖

- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk`
- SDK 版本要求：支持 `can_use_tool` 回调（已验证）
- SDK 事件类型：`text_delta`, `tool_use`, `subagent_start`, `result`

---

## 测试计划

### 方案一测试

1. 发送包含 `rm -rf /` 的命令，验证被拦截
2. 发送包含 `sudo apt install` 的命令，验证被拦截
3. 发送正常命令（如 `ls`, `npm test`），验证正常执行
4. 验证拦截消息正确返回给用户

### 方案二测试

1. 发送需要多次工具调用的任务（如"分析项目结构并生成报告"）
2. 验证每 3 秒收到一次进度更新
3. 验证工具调用活动正确显示
4. 验证文本内容完整性（与改进前对比）
5. 验证 `[SEND_FILE:]` 标记仍然正常工作

### 方案三测试

1. 发送长时间任务（如"分析所有文件"），在执行过程中发送新消息
2. 验证任务被正确中断
3. 验证新消息被处理
4. 验证中断提示消息正确显示
5. 测试快速连续发送多条消息的场景

---

## 实现优先级

1. **方案一（权限控制）**：优先级高，安全性关键
2. **方案二（动态输出）**：优先级中，用户体验优化
3. **方案三（执行中交互）**：优先级中，高级交互能力

**建议实施顺序**：
- 第一阶段：方案一 + 方案二（可并行开发，2-4 小时）
- 第二阶段：方案三（依赖方案二的 StreamFlusher，3-4 小时）

**总代码量**：
- 方案一：约 30 行
- 方案二：约 90 行
- 方案三：约 180 行
- 合计：约 300 行（占总代码 11.2%）

---

## 后续优化方向

1. **权限控制**：支持白名单模式（仅允许特定命令）
2. **动态输出**：支持可配置的时间间隔（通过 config.json）
3. **活动提示**：更丰富的 emoji 和描述（如 Read 用 📖，Write 用 ✍️）
4. **进度条**：对于长时间运行的任务显示进度百分比

---

## 附录：事件类型参考

根据 Claude Agent SDK 文档和代码分析，以下事件类型可用于动态输出：

| 事件类型 | 字段 | 用途 |
|---------|------|------|
| `text_delta` | `event.text` | 流式文本片段 |
| `assistant` | `event.message.content[]` | 完整消息格式 |
| `tool_use` | `event.name`, `event.input` | 工具调用开始 |
| `subagent_start` | `event.agent_type` | 子代理启动 |
| `subagent_stop` | `event.agent_id` | 子代理结束 |
| `result` | `event.result` | 最终结果 |
| `system` | `event.subtype` | 系统事件（如压缩） |
