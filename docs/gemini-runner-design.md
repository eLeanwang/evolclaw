# Gemini Runner 实现方案

## 概述

通过 Gemini CLI 子进程 bridge 集成 Google Gemini 作为 EvolClaw 的第四个 agent backend。

**核心思路**：调用 `gemini -p "prompt" --output-format stream-json` 获取 JSONL 事件流，映射到 EvolClaw 的 `AgentEvent` 类型。每次 `runQuery` 启动一个子进程，通过 stdout readline 消费事件流。

**参考模板**：`codex-runner.ts`（AbortController 中断）+ `hermes-runner.ts`（子进程管理）

## 1. stream-json 事件格式（实测验证）

### init 事件（首个事件，包含 session ID）
```json
{"type":"init","timestamp":"2026-04-11T06:14:49.728Z","session_id":"29c73cf4-...","model":"gemini-2.5-flash"}
```

### message 事件（用户消息 + 助手流式文本）
```json
{"type":"message","timestamp":"...","role":"user","content":"读取文件"}
{"type":"message","timestamp":"...","role":"assistant","content":"文件内容如下","delta":true}
```
- `delta:true` 表示流式增量文本，需要累积
- `role:"user"` 是回显，可跳过

### tool_use 事件
```json
{"type":"tool_use","timestamp":"...","tool_name":"read_file","tool_id":"hjscmj88","parameters":{"file_path":"/tmp/file.txt"}}
```

### tool_result 事件
```json
{"type":"tool_result","timestamp":"...","tool_id":"hjscmj88","status":"success","output":"..."}
```

### result 事件（最终事件，包含统计）
```json
{"type":"result","timestamp":"...","status":"success","stats":{"total_tokens":26288,"input_tokens":25640,"output_tokens":364,"cached":0,"duration_ms":13143,"tool_calls":1,"models":{...}}}
```

### error 事件
```json
{"type":"error","timestamp":"...","message":"...","fatal":true}
```

## 2. 事件映射表

| Gemini stream-json | EvolClaw AgentEvent | 说明 |
|---|---|---|
| `init` | `{ type: 'session_id', sessionId }` | 提取 session_id |
| `message` role=assistant delta=true | `{ type: 'text', text: content }` | 流式文本 |
| `message` role=user | (跳过) | 用户消息回显 |
| `tool_use` | `{ type: 'tool_use', name: tool_name, input: parameters }` | |
| `tool_result` status=success | `{ type: 'tool_result', name: tool_name, result: output }` | |
| `tool_result` status!=success | `{ type: 'tool_result', name: tool_name, result: output, isError: true }` | |
| `result` status=success | `{ type: 'complete', durationMs, costUsd }` | |
| `result` status!=success | `{ type: 'complete', isError: true, errors: [...] }` | |
| `error` | `{ type: 'error', error: message, errorType }` | |

## 3. 文件变更清单

### 3.1 新建 `src/agents/gemini-runner.ts`（~280 行）

```typescript
/**
 * Gemini Agent Runner
 *
 * Integrates Google Gemini CLI as a backend via subprocess.
 * 每次 runQuery 启动 `gemini -p` 子进程，解析 stream-json JSONL 事件流。
 *
 * Architecture:
 *   GeminiRunner  →  spawn `gemini -p ...`  →  stdout JSONL stream
 */

export class GeminiRunner implements AgentRunnerFull, ModelSwitcher {
  readonly name = 'gemini';
  readonly capabilities = { clear: true, compact: false, fork: false };
  // ...
}

export class GeminiAgentPlugin implements AgentPlugin {
  readonly name = 'gemini';
  isEnabled(config: Config): boolean;
  createAgent(config: Config, callbacks: AgentCallbacks): AgentInstance;
}
```

**关键实现细节**：

#### 3.1.1 runQuery() 流程
1. 解析 sessionId → 查找 `activeSessions` map 获取 gemini sessionId
2. 检查 safeMode → 跳过 resume
3. 构建 CLI 参数：
   ```
   gemini -p "prompt"
     --output-format stream-json
     -m {model}
     --yolo                          # auto 模式
     --approval-mode=plan            # plan 模式
     -r {geminiSessionId}            # resume（如果有）
   ```
4. 图片处理：写临时文件，通过系统提示告知路径（Gemini CLI 支持 `@file` 引用）
5. `systemPromptAppend`：追加到 prompt 前面作为上下文
6. spawn 子进程，cwd 设为 projectPath
7. 返回 `transformStream()` AsyncGenerator

#### 3.1.2 transformStream() 流程
1. 对 stdout 逐行 readline
2. JSON.parse 每行 → switch(event.type) → yield AgentEvent
3. 维护 `pendingToolNames: Map<toolId, toolName>` 用于 tool_result 关联
4. finally 块：清理 AbortController、临时文件

#### 3.1.3 interrupt() 实现
- 发送 SIGTERM 给子进程（`childProcess.kill('SIGTERM')`）
- 清理 activeStreams + activeProcesses

#### 3.1.4 clearSession()
- 从 `activeSessions` map 删除 sessionId
- 通知 onSessionIdUpdate 清空
- 返回 true（下次不传 -r 即为新会话）

#### 3.1.5 Model 列表
```typescript
const GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro',
  'gemini-3-flash',
];
```

### 3.2 修改 `src/types.ts`

在 `Config.agents` 中添加 `google` section：
```typescript
google?: {
  apiKey?: string;      // GEMINI_API_KEY（可选，CLI 有自己的 OAuth）
  model?: string;       // 默认 'gemini-2.5-flash'
  cliPath?: string;     // gemini CLI 路径（可选，默认 PATH 查找）
};
```

`agentSessions.gemini` 已存在，无需修改。

### 3.3 修改 `src/config.ts`

添加 `resolveGoogleConfig()` 函数（~30 行）：
```typescript
export interface GoogleResolved {
  cliPath: string;    // gemini CLI 可执行文件路径
  model: string;
  apiKey?: string;
}

export function resolveGoogleConfig(config: Config): GoogleResolved {
  // cliPath: config → which gemini
  // model: config → 'gemini-2.5-flash'
  // apiKey: config → env.GEMINI_API_KEY → env.GOOGLE_API_KEY → undefined
}
```

修改 `agentKeyMap` 添加 `gemini: 'google'`。

### 3.4 修改 `src/index.ts`

添加 import 和注册（2 行）：
```typescript
import { GeminiAgentPlugin } from './agents/gemini-runner.js';
// ...
agentLoader.register(new GeminiAgentPlugin());
```

### 3.5 修改 CLAUDE.md

在 Agent Backend Layer 部分添加 Gemini 说明。

## 4. 功能对照

### 完全支持（CLI 内置）
- 流式文本输出
- 工具执行（shell, read_file, write_file, grep, glob, web_fetch）
- MCP 集成
- GEMINI.md 上下文加载
- Session 持久化和恢复（`-r sessionId`）
- 沙箱安全
- Model routing / fallback
- Context window 压缩（CLI 自管理）

### 有限支持
| 功能 | 状态 | 说明 |
|------|------|------|
| 图片输入 | 有限 | 写临时文件 + `@file` 传入 |
| 权限控制 | 映射 | `--yolo` / `--approval-mode` |
| Model switching | 支持 | 下次 runQuery 使用新 model |
| Session clear | 支持 | 不传 `-r` 即新会话 |

### 不支持
| 功能 | 原因 |
|------|------|
| compact | CLI 自管理，不暴露 API |
| fork | CLI 不支持 |
| 权限审批交互 | headless 模式无交互，用 `--yolo` |

## 5. isEnabled() 检查逻辑

```typescript
isEnabled(config: Config): boolean {
  try {
    const resolved = resolveGoogleConfig(config);
    // 只需 CLI 可执行即可（不要求 apiKey，CLI 有 OAuth 认证）
    return !!resolved.cliPath;
  } catch { return false; }
}
```

使用 `commandExists('gemini')` 检测 CLI 是否在 PATH 中。

## 6. 环境变量传递

子进程环境变量：
```typescript
const env = {
  ...process.env,
  // 如果配置了 apiKey，传递给 CLI
  ...(resolved.apiKey ? { GOOGLE_API_KEY: resolved.apiKey } : {}),
};
```

## 7. 实现步骤

1. **Step 1**: `src/config.ts` — 添加 `GoogleResolved` + `resolveGoogleConfig()` + `agentKeyMap`
2. **Step 2**: `src/types.ts` — 添加 `Config.agents.google` 类型
3. **Step 3**: `src/agents/gemini-runner.ts` — 核心实现
   - GeminiRunner class（AgentRunnerFull + ModelSwitcher）
   - GeminiAgentPlugin class
4. **Step 4**: `src/index.ts` — 注册 plugin
5. **Step 5**: 编译验证 `npm run build`
6. **Step 6**: 手动测试 `/agent gemini` 切换 + 发送消息
7. **Step 7**: 更新 CLAUDE.md 文档

## 8. 预估工作量

| 文件 | 新增/修改 | 行数 |
|------|----------|------|
| `src/agents/gemini-runner.ts` | 新建 | ~280 |
| `src/config.ts` | 修改 | ~35 |
| `src/types.ts` | 修改 | ~6 |
| `src/index.ts` | 修改 | ~2 |
| `CLAUDE.md` | 修改 | ~15 |
| **合计** | | **~340** |
