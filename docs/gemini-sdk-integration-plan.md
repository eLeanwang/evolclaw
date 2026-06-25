# Gemini Agent SDK 集成方案

**状态**：⏳ 规划中
**日期**：2026-04-11

## 概述

目前 `GeminiRunner` 通过 `spawn` 子进程调用 `gemini` CLI。虽然简单，但在多轮对话管理、流式处理控制和错误恢复方面灵活性不足。本方案提议切换到原生 `@google/genai` SDK 集成。

---

## 功能 1：基于 @google/genai 的原生 Runner

### 设计细节

1. **核心库**：安装并使用 `@google/genai`。
2. **架构变化**：从 `Subprocess Runner` 变为 `Native SDK Runner`。
3. **认证**：支持 `API Key` (AI Studio) 和 `Service Account` (Vertex AI) 两种模式。

### 代码示意 (GeminiRunner.ts)

```typescript
import { GoogleGenAI } from '@google/genai';

async function* runQuery(...) {
  const ai = new GoogleGenAI({ apiKey: this.apiKey });
  const model = ai.models.get(this.model);
  
  const stream = await model.generateContentStream({
    contents: this.history,
    tools: this.tools,
  });

  for await (const chunk of stream) {
    if (chunk.text()) yield { type: 'text', text: chunk.text() };
    if (chunk.functionCalls) {
       // 处理工具调用...
    }
  }
}
```

---

## 功能 2：会话持久化与恢复

### 挑战

Gemini CLI 的会话存储在本地 `.jsonl` 文件中。原生 SDK 需要手动维护 `contents` 数组。

### 方案

1. **格式适配**：在 `GeminiRunner` 中维护一个 `Content[]` 数组。
2. **持久化**：每次对话结束，将 `contents` 序列化并存入 EvolClaw 的会话目录。
3. **加载**：重启或切换会话时，从文件反序列化恢复 `history`。

---

## 功能 3：工具调用 (Function Calling) 循环

### 流程

1. 模型返回 `functionCalls`。
2. `GeminiRunner` 通过 `MessageProcessor` 或直接执行本地工具。
3. 将工具执行结果以 `functionResponse` 身份追加到 `contents`。
4. 再次调用 `generateContentStream` 获取最终回复。

---

## 功能 4：权限模式适配

1. **`auto` / `bypass`**：对应 SDK 的默认行为（自动执行工具后返回结果给模型）。
2. **`plan`**：在执行工具前，将 `tool_use` 事件抛给 EvolClaw，等待用户 `/perm allow`。

---

## 实施计划

### Phase 1: 环境准备
1. `npm install @google/genai`
2. 更新 `src/types.ts` 中的 Gemini 配置结构。

### Phase 2: 开发 GeminiRunner SDK 版本
1. 实现 `Native SDK` 通信逻辑。
2. 实现流式解析（Mapping `GoogleGenAI` events to `AgentEvent`）。
3. 实现工具调用循环。

### Phase 3: 集成与测试
1. 验证多轮对话一致性。
2. 验证图片/文件输入支持。
3. 验证权限审批流程。

### Phase 4: 迁移
1. 默认启用 SDK 模式。
2. 提供降级开关回到 CLI 模式（保留 `GeminiCLIRunner`）。

---

## 改动文件列表

- `package.json`
- `src/agents/gemini-runner.ts` (核心改动)
- `src/config.ts` (配置解析)
- `src/types.ts` (类型定义)
- `src/core/session-manager.ts` (会话加载逻辑适配)
