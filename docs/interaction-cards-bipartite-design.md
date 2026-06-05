# 交互卡片二分体系设计方案

**Status**: Draft
**Date**: 2026-05-15
**Scope**: 重构 EvolClaw 的交互卡片协议与降级机制，拆分两类卡片用法，消除重复样板代码

---

## 1. 背景与问题

### 1.1 现状

EvolClaw 当前所有交互卡片都使用同一个协议（`InteractionRequest` + `ActionInteraction`），通过同一个 `InteractionRouter` 做请求-响应关联。但实际使用上，交互卡片承担了**两种职责完全不同的角色**：

#### 用法 A：用户驱动 — 命令切换型卡片

用户主动发命令（如 `/plist` / `/agent` / `/model` / `/effort` / `/session`），gateway 用卡片回应，每个按钮对应一条等价命令。

调用点（5 处，均在 `command-handler.ts`）：

| 命令 | 卡片用途 | 按钮等价命令 |
|---|---|---|
| `/plist` | 项目列表切换 | `/project <name>` |
| `/agent` | Agent 后端切换 | `/agent <name>` |
| `/model` | 模型切换 | `/model <name>` |
| `/effort` | 推理强度切换 | `/effort <level>` |
| `/slist` | 会话切换 | `/session <index>` |
| (含)`/perm` 模式选择 | 权限模式切换 | `/perm <mode>` |

每处都是固定模式：
```
用户发 /plist
  → 构造 ActionInteraction（每个项目一个按钮）
  → sendInteractionCard 注册 InteractionRouter callback
  → 用户点按钮触发 callback
  → callback 内部调 this.handle('/project xxx')
  → 把结果 sendText 回去
```

每处约 20 行 callback 闭包，**5 处共约 100+ 行重复**。

#### 用法 B：系统驱动 — 应答询问型卡片

系统在任务执行中向用户提问，等待应答（含 pending 状态）。调用点（3 处）：

| 来源 | 用途 | 应答命令 |
|---|---|---|
| `permission.ts` | 工具权限审批 | `/perm allow\|always\|deny` |
| `claude-runner.ts` AskUserQuestion | Agent 主动询问 | `/ask <选项>` |
| `claude-runner.ts` ExitPlanMode | 计划审批 | `/ask 1\|2` |

降级到文本时，每处都手写文案如 "回复 /perm allow ..."，由 `command-handler.ts` 的 `/perm` `/ask` 分支特判处理。

### 1.2 核心问题

**问题 1：两类卡片混用同一协议，但语义完全不同**

| 维度 | 用法 A（命令切换） | 用法 B（应答询问） |
|---|---|---|
| 触发方 | 用户主动 | 系统主动 |
| pending 状态 | 无 | 有 |
| 按钮含义 | 等价于一条独立命令 | 应答某个 pending 请求 |
| 卡片不可用降级 | 直接发文本列表+命令提示 | 必须走 InteractionRouter pending 路由 |
| 是否需要 timeout | 不需要 | 需要 |
| 是否需要 callback 闭包 | 不需要（按钮即命令） | 需要（callback 关联业务逻辑） |

混用导致：
- 用法 A 的卡片为"按钮触发命令"绕一圈 InteractionRouter，多注册一个 callback、多一份 timeout、多一份业务闭包
- 用法 B 的降级文案散落在多处，每处自己拼字符串

**问题 2：降级路径校验不一致**

卡片点击有 `if (operatorId !== userId) return` 的发起者校验，但降级到文本（用户发 `/perm allow`）时**没有任何校验**——任何能发命令的用户都能应答别人触发的审批请求。这是隐性安全 bug。

**问题 3：用法 A 在非 Feishu 通道完全不可达**

CommandCard 类卡片当前只在 Feishu 实现，其它通道（WeChat / AUN / DingTalk / QQBot / WeCom）不发卡片，所以这些通道的用户**只能用纯命令操作**。但这是合理的——因为 CommandCard 的降级形态本来就是"文本列表+命令提示"，已经是命令操作。问题是这个降级没被显式协议化，依赖每个调用点自己写 fallback 文本。

### 1.3 重构目标

1. **协议二分**：CommandCard / ActionInteraction 两类卡片显式区分
2. **消除样板**：5 处命令切换卡片简化为声明式（取消 callback 闭包）
3. **降级统一**：CommandCard 自带文本降级；ActionInteraction 用 fallback 字段自描述降级方式
4. **校验一致**：卡片点击 + 降级文本应答都做 initiator 校验
5. **InteractionRouter 减负**：只服务 ActionInteraction（B 类），3 个 pending 客户

### 1.4 非目标

- **不**重构整个斜杠指令体系（命令注册中心是独立后续工作）
- **不**改 channel 现有 sendInteraction 实现（飞书的卡片渲染逻辑不变）
- **不**强制其它通道实现 sendInteraction（可保持文本降级）

---

## 2. 协议设计

### 2.1 InteractionKind 二分

```typescript
// src/types.ts

// ── A. 命令型卡片：按钮直接对应一条命令，无 pending、无 callback ──
export interface CommandCard {
  kind: 'command-card';
  title: string;
  body?: string;
  buttons: Array<{
    label: string;
    command: string;          // 完整命令含参数，如 '/p myproject'
    style?: 'primary' | 'danger' | 'default';
    disabled?: boolean;       // 当前已选中可标 disabled
    confirm?: { title: string; body: string };
  }>;
}

// ── B. 应答型卡片：保留现有 ActionInteraction 形态 ──
export interface ActionInteraction {
  kind: 'action';
  title: string;
  body?: string;
  buttons: Array<{
    key: string;
    label: string;
    style?: 'primary' | 'danger' | 'default';
    confirm?: { title: string; body: string };
  }>;
}

export type InteractionKind = CommandCard | ActionInteraction;
```

### 2.2 InteractionRequest 扩展

```typescript
export interface InteractionRequest {
  type: 'interaction';
  id: string;
  channelId: string;
  sessionId: string;
  initiatorId?: string;           // ← 新增：发起者 userId（用于点击校验）
  expiresAt?: number;
  kind: InteractionKind;

  // ── 仅 ActionInteraction 用：降级回复协议 ──
  fallback?: {
    /** 降级回复使用的命令名（不带斜杠），如 'perm' / 'ask' */
    command: string;

    /**
     * 按钮 key 到命令参数的映射。缺省时直接用按钮 key 作参数。
     * 例：{ approve: '1', reject: '2' } → /ask 1 / /ask 2
     */
    buttonArgMap?: Record<string, string>;

    /** 是否接受自由文本输入（默认 false） */
    acceptFreeText?: boolean;

    /** 自由文本提示语，如 "或回复 /ask <自定义内容>" */
    freeTextHint?: string;
  };
}
```

### 2.3 InteractionResponse 不变

```typescript
export interface InteractionResponse {
  type: 'interaction.response';
  id: string;
  action: string;
  values?: Record<string, unknown>;
  operatorId?: string;
}
```

InteractionResponse 仍只用于 ActionInteraction（B 类）。CommandCard（A 类）不产生 InteractionResponse，按钮点击直接转为伪命令入站消息。

---

## 3. 运行时路径

### 3.1 CommandCard 路径（用户驱动）

```
CommandHandler 构造 CommandCard ─→ adapter.sendInteraction
                                       ↓
                              channel 发出卡片
                              按钮 value: { _command, _initiator, _card_title, _btn_label }
                                       ↓
用户点按钮 → channel 收到 card.action.trigger
            ↓
       校验 operatorId === _initiator？
            ├── 否 → 返回 toast "仅卡片发起者可操作"，不更新卡片，不进 CommandHandler
            └── 是 → 构造伪命令入站消息 { content: _command, source: 'card-trigger' }
                     ↓
                送入 messageHandler（同正常用户输入路径）
                     ↓
                CommandHandler 正常分发处理
                     ↓
                结果通过 sendText 返回
                     ↓
                channel 同时把卡片更新为 resolved 状态（显示已选）
```

**关键不变量**：
- CommandCard **不进 InteractionRouter**，不注册 callback，不设 timeout
- 按钮点击的处理路径与"用户主动输入命令"完全一致，只是 `Message.source` 标记为 `'card-trigger'`
- channel 的 ack 逻辑（飞书 ✓ reaction、AUN message.ack）跳过 `card-trigger` 源消息

### 3.2 ActionInteraction 路径（系统驱动）

```
permission.ts / claude-runner.ts 构造 ActionInteraction（含 fallback + initiatorId）
                                       ↓
                              CommandHandler.sendInteractionCard
                                       ↓
                          adapter.sendInteraction 成功？
                              ├── 是 → 注册到 InteractionRouter（带 initiatorId / fallbackCommand）
                              │        ↓
                              │   用户点按钮 → 校验 operatorId === initiatorId
                              │                ├── 否 → toast 拒绝
                              │                └── 是 → InteractionResponse → router.handle → 业务 callback
                              │
                              └── 否（不支持卡片）→ renderInteractionAsText 生成文本提示
                                       ↓
                                  注册到 InteractionRouter（同样带 initiatorId / fallbackCommand）
                                       ↓
                                  用户回 /<fallback.command> args
                                       ↓
                                  CommandHandler.handleInteractionFallback
                                       ↓
                                  按 (sessionId, fallback.command) 查 pending
                                       ↓
                                  校验 userId === initiatorId
                                       ├── 否 → 返回 "仅卡片发起者可应答"
                                       └── 是 → router.handle → 业务 callback
```

### 3.3 校验一致性矩阵

| 场景 | 校验点 | 校验逻辑 |
|---|---|---|
| CommandCard 卡片点击 | channel 层 | `operator !== _initiator` 时拒绝（toast，不更新卡片） |
| ActionInteraction 卡片点击 | channel 层 | 同上（保持现状） |
| ActionInteraction 文本应答 | CommandHandler.handleInteractionFallback | `userId !== initiatorId` 时返回 "仅卡片发起者可应答" |
| `initiatorId` 缺失（兜底） | 全部 | 放行（向后兼容） |

---

## 4. 文本降级渲染

### 4.1 CommandCard 降级（默认渲染）

CommandCard 不需要协议字段描述降级——按钮的 `command` 已经是"如何应答"的描述：

```typescript
// src/core/interaction-fallback.ts
export function renderCommandCardAsText(card: CommandCard): string {
  const lines = [card.title];
  if (card.body) lines.push(card.body);
  lines.push('', '可用命令:');
  for (const btn of card.buttons) {
    const marker = btn.disabled ? '✓' : ' ';
    lines.push(`  ${marker} ${btn.command}    ← ${btn.label}`);
  }
  return lines.join('\n');
}
```

调用方在 `sendInteraction` 失败或 channel 不支持时，自动降级为 `adapter.sendText(renderCommandCardAsText(card))`。**不需要 InteractionRouter**——用户回 `/p projectname` 走的是普通命令分发路径。

### 4.2 ActionInteraction 降级（fallback 字段驱动）

```typescript
// src/core/interaction-fallback.ts
export function renderActionAsText(req: InteractionRequest): string {
  const action = req.kind as ActionInteraction;
  const fb = req.fallback;
  const lines = [action.title];
  if (action.body) lines.push(action.body);
  lines.push('');

  if (!fb) {
    return lines.join('\n');  // 没声明降级协议，仅展示
  }

  lines.push('回复:');
  for (const btn of action.buttons) {
    const arg = fb.buttonArgMap?.[btn.key] ?? btn.key;
    lines.push(`  /${fb.command} ${arg}    ← ${btn.label}`);
  }
  if (fb.acceptFreeText && fb.freeTextHint) {
    lines.push(`  ${fb.freeTextHint}`);
  }
  return lines.join('\n');
}
```

业务方需要的"自定义文案"通过 `customRenderer` 字段覆盖（极少数场景）：

```typescript
// 留口子：极个别需要特殊文案的业务可绕过标准渲染
export function renderActionAsText(
  req: InteractionRequest,
  customRenderer?: (req: InteractionRequest) => string,
): string {
  if (customRenderer) return customRenderer(req);
  // ... 标准渲染逻辑
}
```

---

## 5. CommandHandler 改造

### 5.1 命令切换型卡片简化（5 处）

**改前**（以 `/plist` 为例，约 30 行）：

```typescript
const interaction: InteractionRequest = {
  type: 'interaction', id: requestId, channelId, sessionId: ...,
  kind: {
    kind: 'action',
    title: '📂 项目列表',
    body: bodyLines.join('\n'),
    buttons: entries.map(e => ({ key: e.name, label: ..., style: ... })),
  },
};

const cardSent = await this.sendInteractionCard({
  channel, channelId, sessionId, requestId, interaction, replyCtx,
  canWrite: isAdmin,
  callback: async (action, _values, operatorId) => {
    if (userId && operatorId && operatorId !== userId) return;
    const selectedEntry = entries.find(e => e.name === action);
    if (selectedEntry && !selectedEntry.isCurrent) {
      const result = await this.handle(`/project ${action}`, ...);
      if (result) adapter?.sendText(channelId, result, replyCtx);
    }
  },
});
if (cardSent) return null;

// 降级文本列表（手写，约 10 行）
const lines = ['可用项目:'];
for (const entry of entries) {
  lines.push(`${entry.isCurrent ? '✓' : ' '} ${entry.name} (${entry.projectPath})`);
}
return lines.join('\n');
```

**改后**（约 15 行）：

```typescript
const interaction: InteractionRequest = {
  type: 'interaction',
  id: `plist-${Date.now()}`,
  channelId,
  sessionId: activeSession?.id || '',
  initiatorId: userId,
  kind: {
    kind: 'command-card',
    title: '📂 项目列表',
    body: bodyLines.join('\n'),
    buttons: entries.map(e => ({
      label: e.isCurrent ? `✓ ${e.name}` : e.name,
      command: `/project ${e.name}`,
      style: e.isCurrent ? 'primary' : 'default',
      disabled: e.isCurrent,
    })),
  },
};

return await this.sendCommandCard({ channel, channelId, interaction, replyCtx });
// sendCommandCard 内部：卡片成功 → 返回 null；卡片不可用 → 调用 renderCommandCardAsText 返回文本
```

**净减少**：每处约 15 行，5 处共约 75 行。

### 5.2 新增辅助函数

```typescript
// CommandHandler 内部
private async sendCommandCard(opts: {
  channel: string;
  channelId: string;
  interaction: InteractionRequest;
  replyCtx?: ReplyContext;
}): Promise<string | null> {
  const adapter = this.adapters.get(opts.channel);
  const card = opts.interaction.kind as CommandCard;

  if (adapter?.sendInteraction) {
    try {
      const messageId = await adapter.sendInteraction(opts.channelId, opts.interaction, opts.replyCtx);
      if (messageId) return null;  // 卡片发送成功，无需返回文本
    } catch (e) {
      logger.warn(`[CommandHandler] sendCommandCard failed: ${e}`);
    }
  }

  // 降级：文本列表
  return renderCommandCardAsText(card);
}
```

### 5.3 ActionInteraction fallback 入口

```typescript
private async handleInteractionFallback(
  command: string,        // 'perm' / 'ask'
  args: string,
  sessionId: string,
  userId?: string,
): Promise<{ matched: boolean; result?: string }> {
  if (!this.interactionRouter) return { matched: false };

  const pendingId = this.interactionRouter.findPendingByCommand(sessionId, command);
  if (!pendingId) return { matched: false };

  // initiator 校验
  const initiatorId = this.interactionRouter.getInitiator(pendingId);
  if (initiatorId && userId && initiatorId !== userId) {
    return { matched: true, result: '⚠️ 仅卡片发起者可应答' };
  }

  this.interactionRouter.handle({
    type: 'interaction.response',
    id: pendingId,
    action: args,
    operatorId: userId,
  });
  return { matched: true, result: '✓ 已回答' };
}
```

### 5.4 `/perm` `/ask` 命令改造

```typescript
// /perm 处理（保留双语义）
if (cmdBase === '/perm') {
  const args = ...;

  // 1. 优先尝试匹配 pending interaction（降级应答）
  const fb = await this.handleInteractionFallback('perm', args, sessionId, userId);
  if (fb.matched) return fb.result;

  // 2. 否则按"切换权限模式 / 查询"语义处理（保留现有逻辑）
  // ... 现有 mode 切换分支
}

// /ask 处理（仅应答语义）
if (normalizedContent.startsWith('/ask')) {
  const args = normalizedContent.slice(4).trim();
  const sessionId = (await this.ensureSession(channel, channelId, threadId))?.session?.id;
  if (!sessionId) return '❌ 无法定位会话';

  const fb = await this.handleInteractionFallback('ask', args, sessionId, userId);
  if (fb.matched) return fb.result;
  return '❌ 当前没有待回答的问题';
}
```

---

## 6. InteractionRouter 改造

### 6.1 新增字段与方法

```typescript
interface PendingInteraction {
  callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>;
  timer?: NodeJS.Timeout;
  sessionId: string;
  messageId?: string;
  initiatorId?: string;       // ← 新增
  fallbackCommand?: string;   // ← 新增
}

export class InteractionRouter {
  // 注册时记录 initiator + fallbackCommand
  register(
    id: string,
    sessionId: string,
    callback: ...,
    opts?: {
      timeoutMs?: number;
      onTimeout?: () => void;
      messageId?: string;
      initiatorId?: string;       // ← 新增
      fallbackCommand?: string;   // ← 新增
    },
  ): void;

  // 按 (sessionId, command) 查找最早 pending
  findPendingByCommand(sessionId: string, command: string): string | undefined;

  // 查询 initiator
  getInitiator(id: string): string | undefined;
}
```

### 6.2 客户端收敛

CommandCard 改造后，InteractionRouter 的客户端**只剩 3 处**（之前是 8+ 处）：
- `permission.ts` — 工具权限审批
- `claude-runner.ts` — AskUserQuestion
- `claude-runner.ts` — ExitPlanMode

router 注册压力大幅下降。

---

## 7. 业务方接入示例

### 7.1 权限审批（permission.ts）

```typescript
const interaction: InteractionRequest = {
  type: 'interaction',
  id: requestId,
  channelId: context?.channelId || '',
  sessionId,
  initiatorId: context?.userId,        // ← 新增：发起者
  kind: {
    kind: 'action',
    title: '🔐 权限请求',
    body: `工具：${toolName}\n操作：${displaySummary}${reasonLine}`,
    buttons: [
      { key: 'allow',  label: '✅ 允许',     style: 'primary' },
      { key: 'always', label: '🔓 始终允许',  style: 'default' },
      { key: 'deny',   label: '❌ 拒绝',     style: 'danger' },
    ],
  },
  fallback: { command: 'perm' },         // ← 新增：降级用 /perm
};

// 发卡片或降级文本由统一函数处理，业务方不再手写 "回复 /perm allow ..."
```

### 7.2 AskUserQuestion（claude-runner.ts）

```typescript
const interaction: InteractionRequest = {
  type: 'interaction',
  id: requestId,
  channelId: permCtx.channelId,
  sessionId,
  initiatorId: permCtx.userId,
  kind: {
    kind: 'action',
    title: `💬 ${q.question}`,
    body: q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n'),
    buttons: q.options.map((o, i) => ({ key: `opt-${i}`, label: o.label })),
  },
  fallback: {
    command: 'ask',
    buttonArgMap: Object.fromEntries(q.options.map((_, i) => [`opt-${i}`, String(i + 1)])),
    acceptFreeText: true,
    freeTextHint: '或回复 /ask <自定义内容>',
  },
};
```

### 7.3 ExitPlanMode（claude-runner.ts）

```typescript
const interaction: InteractionRequest = {
  type: 'interaction',
  id: requestId,
  channelId: permCtx.channelId,
  sessionId,
  initiatorId: permCtx.userId,
  kind: {
    kind: 'action',
    title: '📋 计划审批',
    body: 'AI 已完成规划，等待审批。\n请查看以上计划内容后决定。',
    buttons: [
      { key: 'approve', label: '✅ 批准执行', style: 'primary' },
      { key: 'reject',  label: '❌ 拒绝',     style: 'danger' },
    ],
  },
  fallback: {
    command: 'ask',
    buttonArgMap: { approve: '1', reject: '2' },  // 兼容现有用户习惯
  },
};
```

---

## 8. Channel 实现差异

### 8.1 Feishu

`card.action.trigger` 事件分流处理：

```typescript
'card.action.trigger': async (data: any) => {
  const action = data?.action;
  if (!action?.value) return;
  const value = action.value;
  const operatorId = data.operator?.open_id;

  // ── CommandCard 分支 ──
  if (value._command) {
    if (value._initiator && operatorId && operatorId !== value._initiator) {
      return {
        toast: { type: 'warning', content: '⚠️ 仅卡片发起者可操作' },
        // 不更新卡片
      };
    }

    // 构造伪命令入站消息
    await this.messageHandler({
      channelId: data.context?.open_chat_id,
      content: value._command,
      peerId: operatorId,
      messageId: `card-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // 注：source 标记由上游 InboundMessage 字段表达，避免 channel 直接构造
    });

    // 卡片更新为 resolved 状态
    return this.buildResolvedCommandCard(value._card_title, value._btn_label);
  }

  // ── ActionInteraction 分支（保持现状）──
  if (value._request_id) {
    if (value._initiator && operatorId && operatorId !== value._initiator) {
      return {
        toast: { type: 'warning', content: '⚠️ 仅卡片发起者可操作' },
      };
    }

    const response: InteractionResponse = {
      type: 'interaction.response',
      id: value._request_id,
      action: value._action || 'submit',
      values: { ...action.form_value, ...value },
      operatorId,
    };
    this.interactionCallback?.(response);
    return this.buildResolvedCard(...);
  }
}
```

### 8.2 buildInteractionCard 区分两类

```typescript
export function buildInteractionCard(interaction: InteractionRequest): object | null {
  const { kind } = interaction;

  if (kind.kind === 'command-card') {
    return buildCommandCard(interaction.id, kind, interaction.initiatorId);
  }
  if (kind.kind === 'action') {
    return buildActionCard(interaction.id, kind, interaction.initiatorId);
  }
  return null;
}

// CommandCard 按钮 value 结构
function buildCommandButton(btn: CommandCard['buttons'][0], initiatorId?: string): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: btn.label },
    type: btn.style === 'danger' ? 'danger' : btn.style === 'primary' ? 'primary' : 'default',
    value: {
      _command: btn.command,
      _initiator: initiatorId,
      _card_title: '...',
      _btn_label: btn.label,
    },
    confirm: btn.confirm ? { ... } : undefined,
  };
}

// ActionInteraction 按钮 value 结构（保持现状 + initiator）
function buildActionButton(btn: ActionInteraction['buttons'][0], requestId: string, initiatorId?: string): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: btn.label },
    value: {
      _request_id: requestId,
      _action: btn.key,
      _initiator: initiatorId,
      _card_title: '...',
      _card_body: '...',
      _btn_label: btn.label,
    },
  };
}
```

### 8.3 其它 Channel

WeChat / AUN / DingTalk / QQBot / WeCom 当前**不实现 sendInteraction**——这些通道收到 InteractionRequest 后由调用方降级到文本（`renderCommandCardAsText` 或 `renderActionAsText`）。无需改动 channel 实现。

---

## 9. 伪命令消息边界处理

CommandCard 按钮触发的"伪命令入站消息"需要与真实用户输入区分，避免影响：

| 副作用 | 应对 |
|---|---|
| 撤回机制 | 伪消息 `messageId` 形如 `card-trigger-{ts}-{rand}`，不在用户撤回的目标范围内 |
| 调试日志 | InboundMessage 增加可选 `source` 字段标识来源（默认 `'user'`，伪命令为 `'card-trigger'`） |
| Channel ack 反馈 | 飞书 `addAckReaction` / WeChat `sendTyping` / AUN `message.ack` 跳过 `source === 'card-trigger'` 的消息 |
| 消息缓存 | MessageCache 不记录伪命令消息（避免历史中出现"用户输入 /p xxx"的虚假记录） |

### InboundMessage 字段扩展

```typescript
// src/types.ts
export interface InboundMessage {
  channel: string;
  channelId: string;
  // ... 现有字段
  source?: 'user' | 'card-trigger';   // ← 新增（默认 'user'）
}
```

---

## 10. 改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/types.ts` | 加 `CommandCard`，`InteractionKind` 改联合，`InteractionRequest.initiatorId/fallback`，`InboundMessage.source` | +50 行 |
| `src/core/interaction-fallback.ts` | **新增**：`renderCommandCardAsText` / `renderActionAsText` | +80 行 |
| `src/core/interaction-router.ts` | 加 `findPendingByCommand` / `getInitiator`，注册支持 initiator/fallbackCommand | +30 行 |
| `src/core/command-handler.ts` | 5 处命令切换卡片改 CommandCard，新增 `sendCommandCard`，`/perm` `/ask` 接 `handleInteractionFallback` | -100 行 / +60 行 |
| `src/core/permission.ts` | InteractionRequest 加 `fallback: { command: 'perm' }` + initiatorId，删除手写降级文案 | +10 行 / -20 行 |
| `src/agents/claude-runner.ts` | AskUserQuestion / ExitPlanMode 同上加 fallback + initiatorId | +20 行 / -30 行 |
| `src/channels/feishu.ts` | `card.action.trigger` 分流（`_command` vs `_request_id`），`buildInteractionCard` 区分两类，伪命令入站构造 | +80 行 |
| **净改动** | | **约 +0 行（重构性质，不增不减）** |

---

## 11. 迁移路径

每一步独立可回滚，**不破坏现有功能**。

### Step 1：协议扩展（零破坏）

- 加 `CommandCard` 类型、`InteractionRequest.initiatorId` / `fallback` / `InboundMessage.source` 字段
- 加 `interaction-fallback.ts` 渲染函数
- InteractionRouter 加 `findPendingByCommand` / `getInitiator` 方法
- 现有代码不动，旧 InteractionRequest 不填 fallback / initiatorId 时行为完全等同当前

**验证**：`npm test` 通过。

### Step 2：ActionInteraction fallback 接入（3 处）

- `permission.ts` 加 `fallback: { command: 'perm' }` + initiatorId
- `claude-runner.ts` AskUserQuestion / ExitPlanMode 加 fallback + initiatorId
- `command-handler.ts` `/perm` `/ask` 加 `handleInteractionFallback` 优先匹配
- 现有手写文案逐步替换为 `renderActionAsText`

**验证**：手动测试 3 个降级场景文案正确，文本应答路径走通；initiator 校验在群聊生效。

### Step 3：CommandCard 类型 + Feishu 分流

- Feishu `card.action.trigger` 加 `_command` 分支
- Feishu `buildInteractionCard` 区分两类卡片
- `command-handler.ts` 加 `sendCommandCard` 辅助函数
- 现有 5 处仍用 ActionInteraction（不动）

**验证**：发一个 CommandCard 测试卡片，按钮点击触发伪命令路径走通，卡片更新为 resolved 状态。

### Step 4：5 处命令切换卡片迁移（逐个切）

按风险从低到高：`/effort` → `/model` → `/agent` → `/slist` → `/plist`

每处迁移完后单独验证。

**验证**：每处迁移后手动跑一次切换流程，确认按钮点击触发命令、结果回显、卡片更新正常。

### Step 5：InteractionRouter 收尾

- 验证只剩 3 个客户使用 InteractionRouter
- 观察一段时间无问题后，可视情况精简 router 接口（移除 CommandCard 时代遗留的兼容字段）

---

## 12. 复盘：合理性 / 可行性 / 致命缺陷

### 12.1 合理性

- 协议二分反映两类用法的本质差异（pending vs 无 pending），不是为分而分
- 消除 5 处 ~100 行重复样板，收益直接
- ActionInteraction fallback 字段把"如何降级"从隐式约定提升为显式声明，业务自描述
- initiator 校验补齐文本应答路径的安全漏洞

### 12.2 可行性

- 总改动量约 8-10 个文件，工期 4-5 天 + 1 周灰度观察
- 每个 Step 独立可回滚，无不可逆操作
- 测试影响：3 个降级场景 + 5 处命令切换的端到端测试

### 12.3 已知边界与对策

| 边界 | 对策 |
|---|---|
| 伪命令消息混入消息流 | InboundMessage.source 标记，channel ack / messageCache 跳过 |
| fallback 多 pending 同 command 冲突 | 取最早 pending（业务方保证不重叠，理论上单线程串行不会发生） |
| `/perm allow` 误伤 mode 切换语义 | 应答优先 → 不命中再走 mode 切换分支 |
| ActionInteraction 渲染标准化灵活度不足 | 留 customRenderer 口子 |
| CommandCard 在不支持卡片的通道 | renderCommandCardAsText 默认降级，调用方无需手写 |
| initiator 校验在群聊协作场景偏严 | **决策保留**——CommandCard 双重保护（命令权限 + 卡片层校验） |
| 群聊里 CommandCard 触发命令的结果归属 | **决策保留**——裸结果发到群，不加前缀 |

### 12.4 致命缺陷判定

经过逐项审视，方案在技术层面**没有致命缺陷**：

- 无循环依赖
- 无破坏现有功能（每步可灰度可回滚）
- 无不可回滚操作
- 无性能瓶颈风险（事件量级未变）
- 无数据不一致风险（无持久化数据变更）
- 安全增强（initiator 校验补齐降级路径）

### 12.5 ROI 评估

| 维度 | 评分 |
|---|---|
| 解决真痛点 | 🟢 高（5 处 100+ 行重复代码 + 隐性安全 bug + 协议混乱） |
| 实施成本 | 🟢 中（4-5 天开发，6 个 channel 中只动 Feishu） |
| 长期收益 | 🟢 高（加新交互类型边际成本极低） |
| 风险等级 | 🟢 低（灰度可回滚，无不可逆操作） |

---

## 13. 验证清单

实施完成后必须通过以下验证：

### 协议层

- [ ] InteractionRequest 不填 fallback / initiatorId 时，行为完全等同当前（向后兼容）
- [ ] CommandCard / ActionInteraction 类型联合可正确分发
- [ ] InboundMessage.source 默认 'user'，伪命令消息为 'card-trigger'

### CommandCard 路径

- [ ] Feishu `/plist` 发卡片，每个项目一个按钮
- [ ] 按钮点击触发对应 `/p projectname`，结果裸发到当前会话
- [ ] 卡片更新为 resolved 状态，按钮显示已选
- [ ] 群聊里发起者 A 点按钮成功；非发起者 B 点按钮收到 toast "仅卡片发起者可操作"，卡片不更新
- [ ] WeChat / AUN 等通道收到 `/plist`，降级为文本列表（含 `/p projectname` 提示）
- [ ] 伪命令消息不触发 ack reaction，不计入 messageCache

### ActionInteraction 路径

- [ ] 权限审批卡片在 Feishu 正常显示（保持现状）
- [ ] 卡片不可用通道收到 "🔐 权限请求 ... 回复 /perm allow ..." 文本
- [ ] 用户回 `/perm allow` 正确路由到 pending callback
- [ ] AskUserQuestion 文本降级显示 "💬 ... 回复 /ask 1 / /ask 2 / 或回复 /ask <自定义>"
- [ ] ExitPlanMode 文本降级显示 "📋 计划审批 ... 回复 /ask 1 批准 / /ask 2 拒绝"
- [ ] 群聊里非发起者发 `/perm allow` / `/ask 1` 收到 "仅卡片发起者可应答"

### 安全 / 边界

- [ ] `/perm` 双语义：有 pending 时优先应答，无 pending 时走 mode 切换
- [ ] 多个 pending 时 `/ask 1` 路由到最早 pending
- [ ] InteractionRouter 客户收敛到 3 处（permission / AskQuestion / ExitPlanMode）
- [ ] 5 处命令切换卡片全部迁移到 CommandCard，对应 callback 闭包删除

---

## 14. 关键文件路径

### 新增

- `src/core/interaction-fallback.ts` — `renderCommandCardAsText` / `renderActionAsText`

### 修改

- `src/types.ts` — 类型协议扩展
- `src/core/interaction-router.ts` — 增加 initiatorId / fallbackCommand 索引
- `src/core/command-handler.ts` — 5 处迁移 + sendCommandCard + handleInteractionFallback
- `src/core/permission.ts` — fallback + initiatorId 接入
- `src/agents/claude-runner.ts` — AskQuestion / ExitPlanMode 接入
- `src/channels/feishu.ts` — card.action.trigger 分流 + buildInteractionCard 区分

### 不动

- `src/channels/wechat.ts` / `aun.ts` / `dingtalk.ts` / `qqbot.ts` / `wecom.ts` — 这些通道仍走文本降级路径
- `src/core/interaction-router.ts` 的核心逻辑保持不变（仅扩展）

---

## 15. 后续工作（不在本次范围）

- **命令注册中心**：command-handler.ts 几千行 if/else 是另一个独立工程，应做成统一的 CommandRegistry（命令 + 权限 + 卡片化定义集中注册）
- **更多 channel 实现 sendInteraction**：WeChat / DingTalk 如果未来支持卡片，可补齐 buildInteractionCard 实现
- **Interaction 类型扩展**：未来如果需要表单（form）、选择器（picker）等更复杂的交互形态，再加新的 `InteractionKind` 子类型
