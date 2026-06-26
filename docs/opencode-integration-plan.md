# OpenCode 集成方案

**编写日期**：2026-06-26  
**状态**：方案设计阶段，待讨论确认

---

## 一、集成方式选择

### 1.1 最终方案：SDK 全栈模式

**OpenCode SDK 提供两种模式**：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **全栈模式** | `createOpencode({ port })` — SDK 启动 server + 返回 client | 本地开发，单机部署 |
| **Client-only** | `createOpencodeClient({ baseUrl })` — 连接外部 server | 远程部署，多实例 |

**推荐方案：全栈模式**

**理由**（基于官方文档调研 + 用户需求，2026-06-26）：
1. **用户不需要支持远程 OpenCode 服务器** — 全栈模式完全满足需求
2. **进程管理交给 SDK** — evolclaw 不需要自己启停 `opencode serve`
3. **配置更简单** — 不需要 `baseUrl`、`username`、`password`
4. **用户体验更好** — 一键启动，无需额外配置外部服务

**依赖要求**：
- 用户需全局安装 OpenCode CLI：`npm install -g opencode`
- SDK 内部调用 `opencode` 命令启动 server

**实施细节**：
- 使用 `createOpencode({ port: 4096, config: { model: ... } })`
- SDK 返回 `{ client, server }`，`server` 对象可用于生命周期管理
- evolclaw 退出时调用 `server.close()` 清理 server 进程

---

## 二、核心技术映射

### 2.1 接口映射表

| EvolClaw 接口 | OpenCode SDK 实现 | 备注 |
|--------------|------------------|------|
| `runQuery(prompt, options)` | `client.session.prompt({ path, body })` | 返回 `AsyncIterable` 流式响应 |
| `interrupt()` | `client.session.abort({ path })` | OpenCode 原生支持 |
| `clearSession()` | `client.session.delete({ path })` + 重新创建 | session 无法真正"清空"，只能删除重建 |
| `switchModel(model)` | `prompt()` 请求时传 `model` 参数 | 格式：`{ providerID, modelID }` |
| `session_id` | OpenCode session ID | 首次 `runQuery` 时调用 `client.session.create()` 创建 |
| 事件流 | `for await (const event of response.stream)` | SDK 原生 `AsyncIterable` |

### 2.2 Session 管理策略

**OpenCode 的 session 持久化机制**（官方文档已确认）：
- ✅ **Session 历史保存到磁盘**
- ✅ **进程重启后可以直接复用 session ID**
- ✅ **支持跨项目 session 列表**（`opencode session list`）

**EvolClaw 对接策略**：
- 每个 EvolClaw session 对应一个 OpenCode session ID
- 首次 `runQuery` 时调用 `client.session.create({ body: { title } })` 创建，返回的 `id` 存入 `session.metadata.opencodeSessionId`
- 后续 `runQuery` 复用该 session ID
- **进程重启后直接复用旧 session ID**（OpenCode 已持久化）
- `/restart` 或 `/new` 命令触发 `clearSession()` 时调用 `client.session.delete({ path: { id } })` 删除旧 session、创建新 session

**简化点**（相比其他 runner）：
- 不需要"尝试复用，失败后重建"的兜底逻辑
- 不需要检测 session 是否有效（OpenCode 保证持久化）

---

## 三、事件流处理

### 3.1 OpenCode SDK 事件流架构

**SDK 提供原生 AsyncIterable 流式响应**：

```typescript
const response = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: 'text', text: 'Hello' }],
    model: { providerID: 'anthropic', modelID: 'claude-opus-4' }
  }
})

// response.stream 是 AsyncIterable，直接 for await 消费
for await (const event of response.stream) {
  // event 类型由 SDK TypeScript 定义保证
}
```

**优势**：
- 无需手动解析 SSE 格式（SDK 内部已处理）
- TypeScript 类型完整（`Part[]` 类型定义）
- 自动处理连接错误和重试

### 3.2 SDK 事件 → AgentEvent 转换

**OpenCode SDK 事件格式**（基于官方文档）：

```typescript
// response.data 结构
{
  info: AssistantMessage,  // 元信息
  parts: Part[]            // 内容块数组
}

// Part 类型（从 SDK 导入）
type Part = 
  | { type: 'text', text: string }
  | { type: 'tool_use', ... }
  | { type: 'tool_result', ... }
  | ...
```

**转换目标**（EvolClaw `AgentEvent` 类型）：
- `{ type: 'text', text }` → `{ type: 'text', text }`
- `{ type: 'tool_use', ... }` → `{ type: 'tool_use', name, input }`
- `response.data.info` → `{ type: 'session_id', sessionId }` 或 `{ type: 'complete', ... }`

**关键问题**（需实测验证）：
1. SDK 流式响应的 `event` 具体类型是什么？（`Part` 还是其他？）
2. 是否有 `session_id` 事件（用于提取 session ID）？
3. 错误事件的格式？（SDK 抛异常还是返回错误事件？）
4. 完成事件如何标识？（`response.data.info` 的哪个字段？）

---

## 四、配置设计

### 4.1 evolclaw.json 配置段

```json
{
  "agents": {
    "opencode": {
      "model": "anthropic/claude-opus-4",
      "port": 4096,
      "enabled": true
    }
  }
}
```

**字段说明**：
- `model`：默认模型（简化字符串格式 `provider/model`，内部转换为 `{ providerID, modelID }`）
- `port`：OpenCode server 端口（默认 `4096`，SDK 全栈模式使用）
- `enabled`：是否启用 OpenCode runner（默认 `true`）

**移除字段**（全栈模式不需要）：
- ~~`baseUrl`~~：SDK 自己管 server，不需要外部地址
- ~~`username` / `password`~~：SDK 全栈模式不需要认证

### 4.2 配置解析（resolveOpenCodeConfig）

**解析优先级**（参考 `resolveOpenaiConfig` / `resolveGoogleConfig`）：
- `model`：config → `'anthropic/claude-opus-4'`
- `port`：config → 环境变量 `OPENCODE_PORT` → `4096`

**模型格式转换**：
```typescript
// 配置：'anthropic/claude-opus-4'
// 转换为：{ providerID: 'anthropic', modelID: 'claude-opus-4' }
const [providerID, modelID] = model.split('/');
```

**凭证验证**：
- 不需要凭证验证（SDK 全栈模式）
- 在 `OpencodeRunner` 构造时测试连接（`client.global.health()` 验证可达性）

---

## 五、Plugin 架构集成

### 5.1 文件结构

```
src/agents/
├── opencode-runner.ts           # OpencodeRunner 类 + OpencodeAgentPlugin（参考 claude-runner.ts 模式）
└── baseagent.ts                 # 新增 resolveOpenCodeConfig() 导出
```

**架构对齐**：与现有 runner 保持一致，plugin 类写在 runner 文件末尾，不单独拆分文件。

### 5.2 OpencodeRunner 类

**实现接口**：
- `AgentRunnerFull`：`runQuery()` / `interrupt()` / `clearSession()` / `getCapabilities()`
- `ModelSwitcher`：`switchModel()` / `listAvailableModels()` / `getCurrentModel()`

**内部状态**：
- `client: OpencodeClient` — SDK 客户端实例
- `server: OpencodeServer` — SDK server 实例（用于生命周期管理）
- `sessionId: string | null` — 当前 OpenCode session ID
- `currentModel: { providerID: string, modelID: string }` — 当前模型
- `abortController: AbortController | null` — 中断控制器

**核心方法**：
- `constructor(config)`：
  1. 调用 `createOpencode({ port, config: { model } })`
  2. 保存 `client` 和 `server` 实例
  3. 测试连接（`client.global.health()`）
- `runQuery(prompt, options)`：
  1. 确保 session 存在（首次调用时调用 `client.session.create()`）
  2. 调用 `client.session.prompt({ path: { id: sessionId }, body: { parts, model } })`
  3. `for await (const event of response.stream)` 消费流式响应
  4. 转换每个 `Part` 为 `AgentEvent` 并 yield
  5. 捕获 SDK 异常，转换为 `{ type: 'error', error }`
- `interrupt()`：
  1. 调用 `abortController.abort()` 取消 fetch 请求
  2. 调用 `client.session.abort({ path: { id: sessionId } })`
- `clearSession()`：
  1. 调用 `client.session.delete({ path: { id: sessionId } })`
  2. 重置 `sessionId = null`（下次 `runQuery` 时重建）
- `destroy()`（新增）：
  1. 调用 `server.close()` 关闭 OpenCode server
  2. 清理资源

**生命周期管理**：
- evolclaw 退出时调用 `runner.destroy()` 清理 server 进程

### 5.3 OpencodeAgentPlugin 类

**插件注册**（参考 `GeminiAgentPlugin` / `CodexAgentPlugin`）：
- `name = 'opencode'`
- `isEnabled(agent)`：检查 `agent.config.baseagents?.opencode` 是否存在
- `createAgent(agent, callbacks)`：
  1. 解析配置（`resolveOpenCodeConfig`）
  2. 创建 `OpencodeRunner` 实例（内部调用 `createOpencode()`）
  3. 测试连接（`client.global.health()`）
  4. 返回 `AgentInstance`

**在 `src/index.ts` 注册**：
```typescript
import { OpencodeAgentPlugin } from './agents/opencode-plugin.js';
agentLoader.register(new OpencodeAgentPlugin());

// 退出时清理（新增）
process.on('exit', () => {
  // 遍历所有 opencode runner 实例，调用 destroy()
});
```

### 5.4 依赖管理

**package.json 新增**：
```json
{
  "dependencies": {
    "@opencode-ai/sdk": "^1.0.0"
  }
}
```

**全局依赖**（用户需安装）：
```bash
npm install -g opencode
```

**TypeScript 类型导入**：
```typescript
import type { 
  OpencodeClient, 
  OpencodeServer,
  Session, 
  Part, 
  AssistantMessage 
} from '@opencode-ai/sdk';
```

---

## 六、实施步骤

### 第一阶段：基础集成（1-2 天）
1. ✅ 安装依赖：`npm install @opencode-ai/sdk`
2. ✅ 实现 `OpencodeRunner`（`runQuery` / `interrupt` / `clearSession`）
3. ✅ 实现 `OpencodeAgentPlugin`（插件注册）
4. ✅ 添加配置解析（`resolveOpenCodeConfig`）
5. ✅ 在 `src/index.ts` 注册插件

### 第二阶段：功能完善（1 天）
1. ✅ 实现 `ModelSwitcher` 接口（`switchModel` / `listAvailableModels`）
2. ✅ 添加错误处理（SDK 异常转 `AgentEvent`）
3. ✅ Session 状态持久化（`session.metadata.opencodeSessionId`）
4. ✅ 验证 session resume 机制（进程重启后是否有效）

### 第三阶段：测试验证（1 天）
1. ✅ 本地启动 `opencode serve --port 4096`
2. ✅ 配置 `evolclaw.json` → `agents.opencode`
3. ✅ 测试基础对话（`/baseagent opencode` → 发消息验证应答）
4. ✅ 测试 session resume（重启 evolclaw 后继续对话）
5. ✅ 测试 interrupt（发消息时立即发送新消息，验证中断）
6. ✅ 测试 model switch（`/model anthropic/claude-opus-4` → `openai/gpt-4.1`）

### 第四阶段：文档和发布（0.5 天）
1. ✅ 更新 `CLAUDE.md`（OpenCode runner 说明）
2. ✅ 更新 `README.md`（配置示例）
3. ✅ 提交代码 + 发布版本

**总预计工作量**：3-4 天（比 HTTP Client 方案减少 1-2 天）

---

## 七、风险点与待确认项

### 7.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| **SDK 流式事件格式不明确** | 中 | 实测 SDK `response.stream` 的事件类型，调整转换逻辑 |
| **全局依赖要求** | 中 | 文档明确说明用户需安装 `npm install -g opencode` |
| **SDK 版本变化** | 低 | 锁定 SDK 版本号（建议 `^1.0.0`），定期跟进 CHANGELOG |
| **Server 进程清理** | 低 | evolclaw 退出时调用 `server.close()`，确保无僵尸进程 |

### 7.2 待确认项

**需要实测验证**：
1. ✅ SDK `response.stream` 的 `for await` 迭代得到的 `event` 类型是什么？（`Part` 还是其他？）
2. ✅ 如何从响应中提取 session ID？（`response.data.info` 还是创建时返回？）
3. ✅ `createOpencode()` 的 server 启动时间有多长？（影响首次启动体验）
4. ✅ `client.config.providers()` 返回的模型列表格式？（影响 `listAvailableModels` 实现）
5. ✅ 中断机制的响应速度？（`session.abort()` + `abortController.abort()` 是否立即生效）
6. ✅ `server.close()` 是否会阻塞？需要 graceful shutdown 吗？

**已确认**（无需实测）：
- ✅ Session ID 持久化：官方文档已明确支持，进程重启后直接复用
- ✅ Session 删除后重建开销：创建 session 是异步操作，开销可接受

**需要与用户讨论**：
1. ~~是否要求用户自行管理 `opencode serve` 进程？~~（已确定：SDK 全栈模式自己管）
2. ~~是否需要支持远程 OpenCode 服务器？~~（已确定：不需要）
3. ~~配置中的 `username` / `password` 是必填还是可选？~~（已确定：SDK 全栈模式不需要）
4. ✅ 是否需要支持 OpenCode 的 provider 配置？（如配置 Anthropic API Key 到 OpenCode 端）

---

## 八、与现有 Runner 的差异

### 8.1 架构对比

| 维度 | Claude Runner | Codex Runner | Gemini Runner | **OpenCode Runner** |
|------|--------------|-------------|--------------|-------------------|
| **集成方式** | SDK 直连 | HTTP Client | CLI 子进程 | **SDK 直连** |
| **Session 管理** | SDK 内置 | HTTP API | CLI 参数 | **SDK API** |
| **中断机制** | `stream.interrupt()` | `abortController` | 杀进程 | **`session.abort()` + abort** |
| **模型切换** | `query()` 参数 | `prompt()` 参数 | 不支持 | **`prompt()` 参数** |
| **进程管理** | 无 | 需 app-server | 需 gemini CLI | **需 opencode serve** |
| **类型安全** | ✅ 完整 | ⚠️ 部分 | ❌ 无 | **✅ 完整** |
| **错误处理** | SDK 封装 | 手动处理 | 手动处理 | **SDK 封装** |

### 8.2 相似度排序

1. **最接近 Claude Runner**（都是 SDK 直连，类型安全，错误封装）
2. 次接近 Codex Runner（都需要外部进程，HTTP 通信）
3. 与 Gemini Runner 差异较大（SDK vs CLI 子进程）

---

## 九、OpenCode 服务部署建议

### 9.1 本地开发模式

```bash
# 1. 安装 OpenCode
npm install -g opencode

# 2. 配置认证
export OPENCODE_SERVER_USERNAME=admin
export OPENCODE_SERVER_PASSWORD=secret

# 3. 启动服务
opencode serve --port 4096

# 4. 配置 evolclaw.json
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

# 5. 启动 evolclaw
evolclaw start
```

### 9.2 生产部署模式

**方案 A：Systemd 托管**（推荐，Linux）
- 创建 `/etc/systemd/system/opencode.service`
- 配置自动重启、日志管理
- evolclaw 和 opencode 同机部署

**方案 B：Docker Compose**（推荐，跨平台）
- evolclaw 和 opencode 各一个容器
- 通过 Docker 网络通信（`http://opencode:4096`）
- 统一管理依赖和版本

**方案 C：Kubernetes**（推荐，多租户）
- 使用 OpenCode 官方 K8s Operator（KubeOpenCode）
- evolclaw 和 opencode 独立 Pod
- 支持多副本、负载均衡

---

## 十、讨论议题

在开始实施前，需要确认以下几点：

### 议题 1：模型配置格式
**问题**：evolclaw.json 中模型配置用什么格式？

**选项**：
- **A**：完整对象格式（`{ providerID: 'anthropic', modelID: 'claude-opus-4' }`）
  - 优势：与 OpenCode SDK 原生格式一致
  - 劣势：配置冗长
- **B**：简化字符串格式（`'anthropic/claude-opus-4'`），内部转换为对象
  - 优势：配置简洁，与其他 runner 风格一致
  - 劣势：需要字符串解析逻辑

**建议**：选 B（简化字符串格式），理由：
1. 与其他 runner 的配置风格一致（`model: 'sonnet'` / `model: 'gpt-4.1'`）
2. 用户体验更好（配置更直观）
3. 解析逻辑简单（`split('/')`）

### 议题 2：全局依赖要求
**问题**：是否要求用户全局安装 OpenCode？

**背景**：SDK 全栈模式需要全局安装 `opencode` CLI

**选项**：
- **A**：要求用户全局安装（`npm install -g opencode`）
  - 优势：SDK 全栈模式工作正常
  - 劣势：增加部署复杂度，用户可能不愿意全局安装
- **B**：改用 client-only 模式，用户自己启动 `opencode serve`
  - 优势：不需要全局依赖
  - 劣势：回到"用户管理进程"模式，体验变差

**建议**：选 A（要求全局安装），理由：
1. 全栈模式用户体验更好（一键启动）
2. OpenCode 本身就是开发工具，全局安装很常见
3. 文档明确说明安装步骤即可

### 议题 3：实施优先级
**问题**：先做 OpenCode 还是 Qoder？

**更新后的对比**：

| 维度 | OpenCode（全栈模式） | Qoder |
|------|---------------------|-------|
| **集成成本** | 2-3 天 | 2-3 天 |
| **全局依赖** | 需要 `npm install -g opencode` | 不需要 |
| **进程管理** | SDK 自动管理 | 不需要外部进程 |
| **Provider 支持** | 75+ LLM 提供商 | 主要 Anthropic/OpenAI/Google |
| **自托管** | 支持（K8s Operator） | 支持（云端 agent） |

**建议**：根据实际需求决定：
- 如果需要 **provider-agnostic**（支持多种 LLM）→ OpenCode 优先
- 如果只用 Anthropic/OpenAI/Gemini → Qoder 优先（无全局依赖）
- 如果不想要求用户全局安装 → Qoder 优先

### 议题 4：Provider 配置
**问题**：是否需要支持在 evolclaw.json 中配置 Anthropic API Key？

**背景**：OpenCode 可以配置 provider 凭证，也可以用用户自己的配置

**选项**：
- **A**：不支持，让 OpenCode 使用用户自己的配置（`~/.opencode/config.json`）
  - 优势：简单，不涉及凭证管理
  - 劣势：用户需要单独配置 OpenCode
- **B**：支持在 evolclaw.json 中配置，传给 OpenCode SDK
  - 优势：统一配置入口
  - 劣势：需要处理敏感信息

**建议**：选 A（不支持），理由：
1. OpenCode 本身已有配置机制
2. evolclaw 不应管理其他工具的凭证
3. 用户可以用 OpenCode CLI 配置（`opencode auth set anthropic`）

---

## 结语

本方案基于 OpenCode **官方 JavaScript SDK 全栈模式**（`createOpencode()`）设计，相比最初方案经过两次重大调整：

**核心改进**：
1. **从 HTTP Client → SDK client-only → SDK 全栈模式**
   - 最终选择全栈模式：SDK 自己管理 server，evolclaw 无需管理外部进程
2. **Session 持久化已确认**
   - 官方文档明确：session 历史保存到磁盘，进程重启后直接复用
   - 不需要"尝试复用，失败后重建"的兜底逻辑
3. **配置大幅简化**
   - 移除 `baseUrl`、`username`、`password`
   - 仅需 `model`（字符串）+ `port`（可选）
4. **工作量进一步减少**
   - 预计 2-3 天（比最初方案减少 2-3 天）

**方案调整理由**：
- **用户明确需求**：不需要支持远程 OpenCode 服务器
- **官方文档确认**：session ID 持久化机制完善
- **SDK 全栈模式优势**：进程管理交给 SDK，evolclaw 代码更简洁

**关键待确认项**（优先级排序）：
1. **实施优先级**：OpenCode vs Qoder？（取决于 provider 需求 + 全局依赖接受度）
2. **全局依赖接受度**：是否接受要求用户 `npm install -g opencode`？
3. 模型配置格式：字符串 vs 对象？（建议：字符串）
4. Provider 配置：是否支持在 evolclaw.json 中配置 API Key？（建议：不支持）

**四个待讨论议题**：
- 议题 1：模型配置格式（建议：简化字符串 `'anthropic/claude-opus-4'`）
- 议题 2：全局依赖要求（建议：要求用户全局安装 OpenCode）
- 议题 3：实施优先级（OpenCode vs Qoder，取决于需求）
- 议题 4：Provider 配置（建议：不支持，让用户用 OpenCode CLI 配置）

请审阅调整后的方案，就四个议题做出决策。确认后我将按新方案（SDK 全栈模式）实施。
