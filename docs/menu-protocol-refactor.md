# menu.query / menu.update 协议重构 + 附带改进

**状态：✅ 已实现**

> 📜 **变更记录文档**：本文记录的是从 v1 (`type: 'menu.query'` + `mode` 字段) 到 v2 (`menu.query` / `menu.update` 双类型 + `id` + `name`) 的重构过程。
> 当前协议规范见 [`aun-menu-protocol-dev-guide-v2.md`](./aun-menu-protocol-dev-guide-v2.md)。
> 注意：响应中的 `cmd` 字段已于 2026-05-26 移除，本文示例保留以反映重构当时的格式。

## Context

当前 `handleCustomPayload` 中的 `menu.query` 协议存在四个问题：
1. **无请求 ID**：并发场景下前端无法配对请求和响应
2. **cmd 字段语义重载**：有时是命令名 `/chatmode`，有时带参数 `/chatmode proactive`
3. **错误格式不统一**：有时返回 `{ error: "..." }`，有时返回 `{ data: {...} }`，外层无统一 `ok` 字段
4. **cmd 过于定制化**：`/chatmode`、`/perm` 是 evolclaw 内部命令，外部系统无法通用

目标：拆分为 `menu.query`（只读）和 `menu.update`（写入），新增 `name` 字段作为跨系统通用操作标识，不考虑向后兼容。

## 协议定义

### 字段说明

| 字段 | 定位 | 说明 |
|------|------|------|
| `id` | 请求关联 | 前端生成，响应回显 |
| `name` | **通用操作标识** | 跨系统通用（如 `chatmode`、`permission`、`dispatch`），不带 `/`，不依赖 evolclaw 命令体系 |
| `cmd` | evolclaw 内部路由 | 可选，evolclaw 用于定位具体 handler（如 `/chatmode`）。缺省时按 `name` 查找 |
| `value` | 写入值 | `menu.update` 时必填 |

### menu.query — 只读查询

```typescript
// 全量菜单
{ type: 'menu.query', id: string, name: 'list' }

// 获取指定操作的选项
{ type: 'menu.query', id: string, name: 'chatmode' | 'permission' | ... , cmd?: string }

// 查询指定操作的当前状态
{ type: 'menu.query', id: string, name: 'chatmode' | ... , cmd?: string, state: true }
```

简化为两种模式：
- **无 `state` 字段**（或 `state: false`）：返回该操作的可选项列表
- **`state: true`**：返回该操作的当前值

### menu.update — 写入操作

```typescript
{ type: 'menu.update', id: string, name: string, value: string, cmd?: string }
```

### 统一响应（JSON-RPC 风格：data/error 互斥）

```typescript
// 成功
{ type: 'menu.response', id: string, name: string, cmd?: string, data: any }

// 失败
{ type: 'menu.response', id: string, name: string, cmd?: string, error: { code: string, message: string } }
```

通过 `data` 和 `error` 字段互斥判断成功/失败，不需要额外的 `ok` 布尔字段。与 AUN 底层 JSON-RPC 2.0 风格一致。

### 示例

```json
// 获取全量菜单树
→ { "type": "menu.query", "id": "q1", "name": "list" }
← { "type": "menu.response", "id": "q1", "name": "list", "data": [...] }

// 获取 chatmode 的可选项
→ { "type": "menu.query", "id": "q2", "name": "chatmode", "cmd": "/chatmode" }
← { "type": "menu.response", "id": "q2", "name": "chatmode", "cmd": "/chatmode", "data": [{ "value": "interactive", "label": "交互模式" }, ...] }

// 查询 chatmode 当前值
→ { "type": "menu.query", "id": "q3", "name": "chatmode", "cmd": "/chatmode", "state": true }
← { "type": "menu.response", "id": "q3", "name": "chatmode", "cmd": "/chatmode", "data": { "mode": "interactive" } }

// 设置 chatmode
→ { "type": "menu.update", "id": "u1", "name": "chatmode", "cmd": "/chatmode", "value": "proactive" }
← { "type": "menu.response", "id": "u1", "name": "chatmode", "cmd": "/chatmode", "data": { "mode": "proactive" } }

// 错误示例
→ { "type": "menu.update", "id": "u2", "name": "chatmode", "cmd": "/chatmode", "value": "invalid" }
← { "type": "menu.response", "id": "u2", "name": "chatmode", "cmd": "/chatmode", "error": { "code": "EXEC_FAILED", "message": "无效模式: invalid" } }
```

### name 注册表

| name | 对应 cmd | 说明 |
|------|----------|------|
| `list` | — | 特殊：返回全量菜单树 |
| `chatmode` | `/chatmode` | 会话模式 |
| `permission` | `/perm` | 权限模式 |
| `dispatch` | `/dispatch` | 分发模式 |
| `project` | `/p` | 项目切换 |
| `session` | `/s` | 会话切换 |
| `agent` | `/agent` | Agent 后端 |
| `model` | `/model` | 模型切换 |
| `effort` | `/effort` | 推理强度 |
| `restart` | `/restart` | 重启/重连 |

后端维护 `name → cmd` 映射表。前端只需知道 `name`，无需了解 evolclaw 的 `/cmd` 体系。

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/message/message-bridge.ts` | 重写 `handleCustomPayload`，拆为 `handleMenuQuery` + `handleMenuUpdate` |
| `src/types.ts` | 新增协议接口类型 |

## 实施步骤

### Step 1：在 `src/types.ts` 新增协议类型

```typescript
export interface MenuQueryRequest {
  type: 'menu.query';
  id: string;
  name: string;          // 通用操作标识（如 'list', 'chatmode', 'permission'）
  cmd?: string;          // evolclaw 内部路由（如 '/chatmode'）
  state?: boolean;       // true = 查询当前值，false/缺省 = 查询可选项
}

export interface MenuUpdateRequest {
  type: 'menu.update';
  id: string;
  name: string;          // 通用操作标识
  cmd?: string;          // evolclaw 内部路由
  value: string;         // 目标值
}

export interface MenuResponse {
  type: 'menu.response';
  id: string;
  name: string;          // 回显 name
  cmd?: string;          // 回显 cmd（如有）
  data?: any;            // 成功时的结果（与 error 互斥）
  error?: { code: string; message: string };  // 失败时的错误（与 data 互斥）
}
```

### Step 2：在 `message-bridge.ts` 新增 name → cmd 映射表

```typescript
private static readonly MENU_NAME_MAP: Record<string, string> = {
  chatmode: '/chatmode',
  permission: '/perm',
  dispatch: '/dispatch',
  project: '/p',
  session: '/s',
  agent: '/agent',
  model: '/model',
  effort: '/effort',
  restart: '/restart',
};

private resolveCmd(name: string, cmd?: string): string {
  if (cmd) return cmd;
  const mapped = MessageBridge.MENU_NAME_MAP[name];
  if (!mapped) throw { code: 'UNKNOWN_NAME', message: `未知操作: ${name}` };
  return mapped;
}
```

### Step 3：重写 `handleCustomPayload`（替换 message-bridge.ts:232-264）

```typescript
private async handleCustomPayload(
  content: string, channel: string, msg: InboundMessage,
  sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>,
  adapter?: ChannelAdapter
): Promise<boolean> {
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || !parsed.type) return false;

  switch (parsed.type) {
    case 'menu.query':
      await this.handleMenuQuery(parsed, channel, msg, adapter, sendReply);
      return true;
    case 'menu.update':
      await this.handleMenuUpdate(parsed, channel, msg, adapter, sendReply);
      return true;
    default:
      return false;
  }
}
```

### Step 4：实现 `handleMenuQuery`

```typescript
private async handleMenuQuery(
  req: MenuQueryRequest, channel: string, msg: InboundMessage,
  adapter: ChannelAdapter | undefined,
  sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
): Promise<void> {
  const { id, name, cmd } = req;
  try {
    let data: any;
    let resolvedCmd: string | undefined;

    if (name === 'list') {
      // 特殊：全量菜单
      const identity = this.sessionManager.resolveIdentity(channel, msg.peerId);
      data = this.cmdHandler.getMenuItems(identity.role, msg.chatType || 'private');
    } else if (req.state) {
      // 查询当前状态
      resolvedCmd = this.resolveCmd(name, cmd);
      const result = await this.cmdHandler.execMenu(resolvedCmd, 'query', channel, msg.channelId, msg.peerId);
      if ('error' in result) throw { code: 'EXEC_FAILED', message: result.error };
      data = result.data;
    } else {
      // 查询可选项
      resolvedCmd = this.resolveCmd(name, cmd);
      data = await this.cmdHandler.getSubMenuItems(resolvedCmd, channel, msg.channelId, msg.peerId) ?? [];
    }

    await this.sendMenuResponse(adapter, channel, msg.channelId,
      { type: 'menu.response', id, name, cmd: resolvedCmd, data }, sendReply);
  } catch (err: any) {
    await this.sendMenuResponse(adapter, channel, msg.channelId, {
      type: 'menu.response', id, name, cmd,
      error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
    }, sendReply);
  }
}
```

### Step 5：实现 `handleMenuUpdate`

```typescript
private async handleMenuUpdate(
  req: MenuUpdateRequest, channel: string, msg: InboundMessage,
  adapter: ChannelAdapter | undefined,
  sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
): Promise<void> {
  const { id, name, cmd, value } = req;
  try {
    if (!value) throw { code: 'MISSING_VALUE', message: '缺少 value 参数' };
    const resolvedCmd = this.resolveCmd(name, cmd);
    const fullCmd = `${resolvedCmd} ${value}`;
    const result = await this.cmdHandler.execMenu(fullCmd, 'update', channel, msg.channelId, msg.peerId);
    if ('error' in result) throw { code: 'EXEC_FAILED', message: result.error };
    await this.sendMenuResponse(adapter, channel, msg.channelId,
      { type: 'menu.response', id, name, cmd: resolvedCmd, data: result.data }, sendReply);
  } catch (err: any) {
    await this.sendMenuResponse(adapter, channel, msg.channelId, {
      type: 'menu.response', id, name, cmd,
      error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
    }, sendReply);
  }
}
```

### Step 6：抽取 `sendMenuResponse`

```typescript
private async sendMenuResponse(
  adapter: ChannelAdapter | undefined, channel: string, channelId: string,
  response: MenuResponse,
  sendReply: (channelId: string, text: string) => Promise<void>
): Promise<void> {
  await this.sendCustomResponse(adapter, channel, channelId, JSON.stringify(response), sendReply);
}
```

## 验证方式

1. **构建**：`npm run build` 通过
2. **单元测试**：新增测试覆盖 `menu.query`（list / options / state）和 `menu.update` 的正常 + 错误路径
3. **集成验证**：启动 evolclaw，通过 AUN 客户端发送新协议格式，确认响应正确
4. **前端同步**：前端需同步升级为新协议格式（旧格式不再支持）

---

## 附带改进（同批次实现）

### 1. Codex 动态模型目录

**文件**：`src/agents/codex-runner.ts`

**问题**：模型列表硬编码，新模型发布后需手动更新代码。

**方案**：
- 启动时调用 `codex debug models` 获取模型目录（含 `supported_reasoning_levels`）
- 结果缓存在 `codexCatalogCache`，进程生命周期内只查一次
- 失败时降级到 `CODEX_CATALOG_FALLBACK` 硬编码列表
- 导出 `getCodexEfforts(model)` 供 `command-handler.ts` 按模型返回可用 effort 列表
- effort 新增 `xhigh` 级别（Codex 模型支持）

**影响**：
- `listModels()` 返回动态列表
- `/effort` 菜单按当前模型动态展示可用级别
- `command-handler.ts` 中 `allEfforts` 新增 `'xhigh'`，`nonMaxEfforts` 排除 `max` 和 `xhigh`

### 2. 多 Agent 插件启用逻辑解耦

**文件**：`src/agents/claude-runner.ts`、`src/agents/codex-runner.ts`、`src/agents/gemini-runner.ts`

**问题**：`isEnabled()` 同时检查 `agent.baseagent === 'xxx'` 和配置存在性，导致一个 EvolAgent 只能启用一个后端插件，无法支持 `/agent` 运行时切换。

**方案**：移除 `agent.baseagent` 检查，仅依据 `agent.config.baseagents?.xxx` 配置是否存在来决定插件是否启用。这样一个 EvolAgent 可以同时加载多个后端插件，运行时通过 `/agent` 命令切换。

**影响**：
- `ClaudeAgentPlugin.isEnabled()` → `!!agent.config.baseagents?.claude`
- `CodexAgentPlugin.isEnabled()` → `!!agent.config.baseagents?.codex`（移除 baseagent 检查）
- `GeminiAgentPlugin.isEnabled()` → 仅检查 gemini 配置存在性（移除 baseagent 检查）

### 3. EvolAgent `/agent` 切换解锁

**文件**：`src/core/command-handler.ts`

**问题**：EvolAgent 管理的通道上 `/agent xxx` 命令被拦截，返回"baseagent 已锁定"错误。

**方案**：移除 `normalizedContent.startsWith('/agent ')` 的拦截逻辑。配合上面的多插件启用，EvolAgent 通道上可以自由切换后端。

### 4. Context-too-long 重试后友好提示

**文件**：`src/core/message/message-processor.ts`、`src/core/message/im-renderer.ts`

**问题**：上下文过长触发 compact 重试后仍然失败时，renderer 中混入了 SDK 的原始错误文本，用户看到不友好的技术信息。

**方案**：
- `IMRenderer` 新增 `stripContextError(pattern)` 方法，从 buffer/allText/itemsQueue 中清除匹配文本
- `message-processor.ts` 在 compact 重试后检测是否仍为 `prompt_too_long`，若是则：
  1. 调用 `renderer.stripContextError(contextTooLongPattern)` 清理错误文本
  2. 调用 `renderer.addNotice(...)` 显示友好提示："上下文过长，请精简提问或使用 /compact 压缩上下文"
