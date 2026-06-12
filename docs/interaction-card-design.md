# 飞书卡片交互 — 渠道无关交互协议设计

> 版本: v1.0  
> 日期: 2026-04-12  
> 状态: 设计完成，待实现

## 一、背景与目标

### 现状痛点

EvolClaw 当前所有交互依赖纯文本：

1. **权限审批**：Agent 发文本提示 → 用户手动输入 `/perm allow`，容易拼错、体验差
2. **命令操作**：用户需要记住斜杠命令 (`/model`, `/project`, `/perm` 等)
3. **危险操作**：`/restart`, `/stop`, `/clear` 无二次确认，直接执行
4. **超时问题**：权限请求 5 分钟超时自动 deny，用户可能没看到

### 目标

引入渠道无关的交互协议（InteractionRequest/Response），让核心层描述「需要什么交互」，渠道层决定「怎么渲染」：

- **飞书**：Message Card（按钮、下拉、表单）
- **AUN**：JSON 交互协议（CLI 渲染为 prompt_toolkit 组件）— 本次不改造 AUN 客户端，仅确保协议向后兼容
- **WeChat**：纯文本 fallback（不变）

### 技术可行性

- 飞书 `card.action.trigger` 事件可通过已有的 WSClient 长连接接收，无需额外 HTTP webhook
- 飞书卡片回调 3 秒内响应，EvolClaw 的 `resolvePermission` 是同步操作，满足要求
- AUN 已有 `menu.query/response` JSON 协议，与交互协议天然对齐

---

## 二、交互协议

### 2.1 字段类型（InteractionField）

所有字段共享基础属性：

```typescript
interface FieldBase {
  type: string;
  key: string;                // 回调时的字段名
  label: string;              // 显示标签
  hint?: string;              // 字段下方说明文字
}
```

#### TextField — 字符/数字输入

```typescript
interface TextField extends FieldBase {
  type: 'text';
  placeholder?: string;       // 输入框内灰色提示
  defaultValue?: string;      // 预填值
  validation?: 'text' | 'number' | 'path';  // 输入约束提示
  required?: boolean;         // 默认 false
}
```

#### SelectField — 单选列表

```typescript
interface SelectField extends FieldBase {
  type: 'select';
  placeholder?: string;       // 未选择时的提示文字
  options: Array<{
    value: string;            // 回传值
    label: string;            // 显示文字
    description?: string;     // 副标题/说明
    selected?: boolean;       // 默认选中
  }>;
  required?: boolean;
}
```

#### MultiSelectField — 多选列表

```typescript
interface MultiSelectField extends FieldBase {
  type: 'multi-select';
  options: Array<{
    value: string;
    label: string;
    selected?: boolean;       // 默认勾选
  }>;
  minSelect?: number;         // 最少选几项，0 = 不限
  maxSelect?: number;         // 最多选几项，不填 = 不限
}
```

#### ToggleField — 布尔开关

```typescript
interface ToggleField extends FieldBase {
  type: 'toggle';
  defaultValue?: boolean;     // 默认 false
}
```

#### 类型联合

```typescript
type InteractionField = TextField | SelectField | MultiSelectField | ToggleField;
```

### 2.2 交互请求（InteractionRequest）

```typescript
interface InteractionRequest {
  type: 'interaction';
  id: string;                 // 唯一 ID，用于回调匹配
  channelId: string;
  sessionId: string;
  expiresAt?: number;         // Unix ms，超时后自动关闭/取消
  kind: InteractionKind;
}

type InteractionKind = ActionInteraction | FormInteraction | MenuInteraction;
```

#### ActionInteraction — 纯按钮

用于权限审批、危险操作确认等无输入字段的场景。

```typescript
interface ActionInteraction {
  kind: 'action';
  title: string;
  body?: string;              // Markdown 格式描述
  buttons: Array<{
    key: string;              // 回调值: 'allow', 'deny', 'restart'
    label: string;            // 显示文字
    style?: 'primary' | 'danger' | 'default';
    confirm?: {               // 可选二次确认弹窗
      title: string;
      body: string;
    };
  }>;
}
```

#### FormInteraction — 多字段表单

用于模型切换、权限模式设置等需要多参数输入的场景。

```typescript
interface FormInteraction {
  kind: 'form';
  title: string;
  body?: string;
  fields: InteractionField[];  // 一个或多个字段
  submitLabel?: string;        // 提交按钮文字，默认 "确认"
  submitStyle?: 'primary' | 'danger';
  submitConfirm?: {            // 表单提交前的可选二次确认
    title: string;
    body: string;
  };
  cancelable?: boolean;        // 是否显示取消按钮，默认 true
}
```

#### MenuInteraction — 命令菜单

用于 AUN 远端菜单查询，与现有 `menu.response` 协议对齐。

```typescript
interface MenuInteraction {
  kind: 'menu';
  groups: Array<{
    group: string;
    items: Array<{
      key: string;             // 命令: '/pwd', '/restart'
      label: string;
      args?: string;
      interaction?: 'form' | 'confirm';  // 选中后触发的交互类型
    }>;
  }>;
}
```

### 2.3 交互响应（InteractionResponse）

```typescript
interface InteractionResponse {
  type: 'interaction.response';
  id: string;                          // 对应 request.id
  action: string;                      // 按钮 key 或 'submit' / 'cancel'
  values?: Record<string, unknown>;    // 表单字段值（FormInteraction 时）
  operatorId?: string;                 // 操作者身份 ID
}
```

### 2.4 ChannelAdapter 扩展

```typescript
interface ChannelAdapter {
  // ... 现有方法不变

  /**
   * 发送交互请求。
   * - 返回 true: 渠道已渲染交互 UI，Core 等待 onInteraction 回调
   * - 返回 false: 渠道不支持，Core 自行 fallback 到文本
   * - 未实现: 同 false
   */
  sendInteraction?(
    channelId: string,
    interaction: InteractionRequest,
    context?: ReplyContext
  ): Promise<boolean>;

  /**
   * 注册交互回调。渠道收到用户操作后调用 callback。
   * - Feishu: card.action.trigger 事件
   * - AUN: interaction.response JSON 消息
   */
  onInteraction?(callback: (response: InteractionResponse) => void): void;
}
```

---

## 三、场景适配

### 3.1 权限审批（P0 — 最高优先级）

**触发**：Agent PreToolUse hook 需要用户审批

**当前流程**：
```
Gateway 发文本: "🔐 权限请求\n工具：Bash\n操作：npm install\n\n回复 /perm allow | always | deny"
  → 用户手动输入 /perm allow
  → CommandHandler → PermissionGateway.resolvePermission()
```

**新流程**：
```
PermissionGateway.requestPermission()
  → 构造 ActionInteraction
  → adapter.sendInteraction?()
    ├─ Feishu: 渲染 Message Card → 用户点按钮 → card.action.trigger → onInteraction callback
    ├─ AUN: sendCustomPayload JSON → CLI 渲染 prompt → interaction.response JSON
    └─ WeChat/不支持: 返回 false → fallback 到文本 /perm 流程
  → InteractionRouter.handle() → PermissionGateway.resolvePermission()
```

**InteractionRequest 示例**：
```typescript
{
  type: 'interaction',
  id: 'perm-1718000000-a1b2c3',
  kind: {
    kind: 'action',
    title: '🔐 权限请求',
    body: '工具：Bash\n操作：npm install lodash\n原因：安装依赖',
    buttons: [
      { key: 'allow',  label: '✅ 允许',     style: 'primary' },
      { key: 'always', label: '🔓 始终允许',  style: 'default' },
      { key: 'deny',   label: '❌ 拒绝',     style: 'danger' },
    ],
  },
  channelId: 'oc_xxx',
  sessionId: 'sess-001',
  expiresAt: 1718000300000,  // 5分钟超时
}
```

**飞书卡片渲染**：
```
┌─────────────────────────────────┐
│ 🔐 权限请求                      │
│ 工具: Bash                       │
│ 操作: npm install lodash         │
│ 原因: 安装依赖                    │
│                                   │
│ [✅ 允许] [🔓 始终允许] [❌ 拒绝]  │
└─────────────────────────────────┘
```

**点击后卡片更新为**：
```
┌─────────────────────────────────┐
│ 🔐 权限请求 — ✅ 已允许           │
│ 工具: Bash                       │
│ 操作: npm install lodash         │
│ 审批人: 轮子 | 10:32             │
└─────────────────────────────────┘
```

**InteractionResponse**：
```typescript
{ type: 'interaction.response', id: 'perm-1718000000-a1b2c3', action: 'allow', operatorId: 'ou_xxx' }
```

### 3.2 危险命令确认（P1）

**涉及命令**：`/restart`, `/stop`, `/clear`

**InteractionRequest 示例**（`/restart`）：
```typescript
{
  kind: {
    kind: 'action',
    title: '重启服务',
    body: '当前活跃会话: 3',
    buttons: [
      {
        key: 'restart', label: '确认重启', style: 'danger',
        confirm: { title: '确认重启？', body: '这将中断所有活跃会话' },
      },
      { key: 'cancel', label: '取消', style: 'default' },
    ],
  },
}
```

**`/stop`（无需二次确认）**：
```typescript
{
  kind: {
    kind: 'action',
    title: '中断任务',
    buttons: [
      { key: 'stop', label: '确认中断', style: 'danger' },
      // 无 confirm 字段 → 直接执行
    ],
  },
}
```

### 3.3 模型切换（P2）

**触发**：用户输入 `/model`（无参数时）

**InteractionRequest 示例**：
```typescript
{
  kind: {
    kind: 'form',
    title: '模型设置',
    fields: [
      {
        type: 'select', key: 'model', label: '模型',
        hint: '切换后对当前会话立即生效',
        options: [
          { value: 'opus',   label: 'Claude Opus 4',   description: '最强推理', selected: true },
          { value: 'sonnet', label: 'Claude Sonnet 4',  description: '平衡速度与质量' },
          { value: 'haiku',  label: 'Claude Haiku 3.5', description: '最快响应' },
        ],
        required: true,
      },
      {
        type: 'select', key: 'effort', label: '推理力度',
        options: [
          { value: 'high',   label: '高', selected: true },
          { value: 'medium', label: '中' },
          { value: 'low',    label: '低' },
        ],
      },
    ],
    submitLabel: '应用',
  },
}
```

**InteractionResponse**：
```typescript
{ id: 'form-model-xxx', action: 'submit', values: { model: 'sonnet', effort: 'medium' } }
```

### 3.4 项目切换（P2）

**触发**：用户输入 `/p`（无参数时）

```typescript
{
  kind: {
    kind: 'form',
    title: '切换项目',
    fields: [{
      type: 'select', key: 'project', label: '项目',
      options: [
        { value: '/home/evolclaw',     label: 'evolclaw',     description: '30分钟前', selected: true },
        { value: '/home/hermes-agent', label: 'hermes-agent', description: '2小时前' },
        { value: '/home/frontend',     label: 'frontend',     description: '空' },
      ],
      required: true,
    }],
    submitLabel: '切换',
  },
}
```

### 3.5 会话切换（P2）

**触发**：用户输入 `/s`（无参数时）

```typescript
{
  kind: {
    kind: 'form',
    title: '切换会话',
    fields: [{
      type: 'select', key: 'session', label: '会话',
      options: [
        { value: 'sess-001', label: '默认会话',    description: '刚刚', selected: true },
        { value: 'sess-002', label: 'CLI开发',     description: '1小时前' },
        { value: 'sess-003', label: '前端重构',     description: '3小时前' },
      ],
      required: true,
    }],
    submitLabel: '切换',
  },
}
```

### 3.6 权限模式设置（P2）

**触发**：用户输入 `/perm`（无参数时）

```typescript
{
  kind: {
    kind: 'form',
    title: '权限模式设置',
    fields: [
      {
        type: 'select', key: 'mode', label: '审批模式',
        hint: '控制 Agent 使用工具时的审批行为',
        options: [
          { value: 'auto',    label: '自动',   description: '大多数操作自动允许', selected: true },
          { value: 'request', label: '审批',   description: '敏感操作需确认' },
          { value: 'bypass',  label: '免审',   description: '全部放行' },
        ],
      },
      {
        type: 'toggle', key: 'clearCache', label: '清除已授权缓存',
        hint: '重置所有"始终允许"的工具',
        defaultValue: false,
      },
    ],
  },
}
```

### 3.7 Agent 切换（P2）

**触发**：用户输入 `/agent`（无参数时）

```typescript
{
  kind: {
    kind: 'form',
    title: '切换 Agent 后端',
    fields: [{
      type: 'select', key: 'agent', label: 'Agent',
      options: [
        { value: 'claude',  label: 'Claude',  description: 'Claude Agent SDK', selected: true },
        { value: 'codex',   label: 'Codex',   description: 'OpenAI Responses API' },
        { value: 'hermes',  label: 'Hermes',  description: 'Python AIAgent 桥接' },
        { value: 'gemini',  label: 'Gemini',  description: 'Gemini CLI 子进程' },
      ],
      required: true,
    }],
    submitLabel: '切换',
  },
}
```

---

## 四、架构设计

### 4.1 交互路由器（InteractionRouter）

```
src/core/interaction-router.ts  (新文件)
```

负责匹配 InteractionResponse 到对应的等待方：

```typescript
export class InteractionRouter {
  private handlers = new Map<string, {
    callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void;
    timer?: NodeJS.Timeout;
    sessionId: string;
  }>();

  /**
   * 注册等待交互响应。
   * @param id         InteractionRequest.id
   * @param sessionId  所属会话（用于 cancelAll）
   * @param callback   收到响应时调用
   * @param timeoutMs  超时后自动取消
   * @param onTimeout  超时回调（如自动 deny）
   */
  register(
    id: string,
    sessionId: string,
    callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void,
    timeoutMs?: number,
    onTimeout?: () => void,
  ): void;

  /**
   * 路由交互响应到已注册的 handler。
   * @returns true 如果找到并处理
   */
  handle(response: InteractionResponse): boolean;

  /** 取消指定会话的所有待处理交互 */
  cancelAll(sessionId: string): void;

  /** 获取指定会话的待处理交互 ID 列表 */
  getPending(sessionId: string): string[];
}
```

### 4.2 PermissionGateway 改造

`requestPermission` 增加 adapter 参数，优先尝试交互卡片：

```typescript
// permission.ts

async requestPermission(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sendPrompt: (text: string) => Promise<void>,
  context?: {                         // 新增可选上下文
    adapter?: ChannelAdapter;
    channelId?: string;
    replyContext?: ReplyContext;
    interactionRouter?: InteractionRouter;
  },
  summary?: string,
  reason?: string,
): Promise<PermissionDecision> {

  // 1. always-allow 缓存检查（不变）
  if (this.isAlwaysAllowed(toolName)) return 'always';

  const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const displaySummary = summary || summarizeToolInput(toolName, toolInput);

  // 2. 构造 ActionInteraction
  const interaction: InteractionRequest = {
    type: 'interaction',
    id: requestId,
    kind: {
      kind: 'action',
      title: '🔐 权限请求',
      body: `工具：${toolName}\n操作：${displaySummary}${reason ? '\n原因：' + reason : ''}`,
      buttons: [
        { key: 'allow',  label: '✅ 允许',     style: 'primary' },
        { key: 'always', label: '🔓 始终允许',  style: 'default' },
        { key: 'deny',   label: '❌ 拒绝',     style: 'danger' },
      ],
    },
    channelId: context?.channelId || '',
    sessionId,
    expiresAt: Date.now() + this.timeout,
  };

  // 3. 尝试富交互
  let interactionSent = false;
  if (context?.adapter?.sendInteraction && context.channelId) {
    interactionSent = await context.adapter.sendInteraction(
      context.channelId, interaction, context.replyContext
    );
  }

  // 4. fallback 到文本
  if (!interactionSent) {
    const reasonLine = reason ? `\n原因：${reason}` : '';
    await sendPrompt(
      `🔐 权限请求\n工具：${toolName}\n操作：${displaySummary}${reasonLine}\n\n回复 /perm allow 本次允许 | always 始终允许 | deny 拒绝`
    );
  }

  // 5. 等待响应（Promise + timeout）
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      context?.interactionRouter?.handle({  // 清理 router 注册
        type: 'interaction.response', id: requestId, action: 'deny',
      });
      resolve('deny');
    }, this.timeout);

    this.pending.set(requestId, { sessionId, toolName, resolve, timer });

    // 如果发了交互卡片，同时注册到 InteractionRouter
    if (interactionSent && context?.interactionRouter) {
      context.interactionRouter.register(requestId, sessionId, (action) => {
        this.resolvePermission(sessionId, requestId, action as PermissionDecision);
      });
    }
  });
}
```

**文本 `/perm allow` 路径不变** — `CommandHandler` 照旧调用 `resolvePermission()`，两条路径汇聚。

### 4.3 CommandHandler 改造

需要交互卡片的命令，在无参数时发 InteractionRequest：

```typescript
// command-handler.ts — 以 /model 为例

case '/model': {
  if (!args) {
    // 无参数 → 发交互表单
    const sent = await this.sendInteraction(channel, channelId, {
      type: 'interaction',
      id: `form-model-${Date.now()}`,
      kind: {
        kind: 'form',
        title: '模型设置',
        fields: [
          { type: 'select', key: 'model', label: '模型', ... },
          { type: 'select', key: 'effort', label: '推理力度', ... },
        ],
        submitLabel: '应用',
      },
      channelId, sessionId,
    });
    if (sent) return '';  // 交互卡片已发送，等待回调
    // fallback: 显示当前模型信息（文本模式，与当前行为一致）
    return `当前模型: ${agent.getModel()}\n可用: ${agent.listModels().join(', ')}`;
  }
  // 有参数 → 直接执行（当前逻辑不变）
  agent.setModel(args);
  return `模型已切换为 ${args}`;
}
```

**危险命令 `/restart`**：

```typescript
case '/restart': {
  const sent = await this.sendInteraction(channel, channelId, {
    type: 'interaction',
    id: `confirm-restart-${Date.now()}`,
    kind: {
      kind: 'action',
      title: '重启服务',
      body: `当前活跃会话: ${activeCount}`,
      buttons: [
        {
          key: 'restart', label: '确认重启', style: 'danger',
          confirm: { title: '确认重启？', body: '这将中断所有活跃会话' },
        },
        { key: 'cancel', label: '取消', style: 'default' },
      ],
    },
    channelId, sessionId,
  });
  if (sent) return '';  // 等待回调执行实际重启
  // fallback: 直接执行（当前行为不变）
  return this.doRestart();
}
```

### 4.4 飞书渠道实现

#### sendInteraction — 卡片构建

```typescript
// feishu.ts

async sendInteraction(
  channelId: string,
  interaction: InteractionRequest,
  context?: ReplyContext
): Promise<boolean> {
  const card = this.buildInteractionCard(interaction);
  if (!card) return false;

  await this.client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: channelId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return true;
}
```

**卡片构建映射**：

| InteractionField | 飞书 Card 组件 |
|-----------------|---------------|
| `text` | `input` 组件 (tag: "input") |
| `select` | `select_static` 组件 |
| `multi-select` | `checker` 组件 (multi-select checkbox) |
| `toggle` | `checker` 组件 (单个 checkbox) |
| `action.buttons` | `button` 组件行 |
| `confirm` | 按钮的 `confirm` 属性（飞书原生弹窗） |

#### onInteraction — 事件注册

```typescript
// feishu.ts — connect() 中

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => { /* 现有逻辑 */ },

  'card.action.trigger': async (data) => {
    const actionValue = data.action?.value;
    if (!actionValue?.id) return;

    const response: InteractionResponse = {
      type: 'interaction.response',
      id: actionValue.id,
      action: actionValue.action || 'submit',
      values: actionValue.values,
      operatorId: data.operator?.open_id,
    };

    // 调用注册的回调
    this.interactionCallback?.(response);

    // 3秒内返回更新后的卡片（禁用按钮 + 显示结果）
    return this.buildResolvedCard(response);
  },
});
```

### 4.5 AUN 兼容策略

**本次不改造 AUN**。确保向后兼容：

1. `menu.query` → Gateway 仍返回 `menu.response` 格式（不发新协议的 `interaction`）
2. 权限审批不走 `sendInteraction`（AUN adapter 不实现该方法）→ 自动 fallback 到文本 `/perm`
3. 未来 AUN CLI 升级时，可选实现：
   - 识别 `type: 'interaction'` 消息
   - `kind: 'action'` → prompt_toolkit RadioList/ButtonDialog
   - `kind: 'form'` → 逐字段 prompt 输入
   - 发 `interaction.response` JSON 回传

**MenuInteraction 中的 `interaction` 字段**为未来 AUN 衔接预留：

```typescript
// menu item 示例
{ key: '/model', label: '查看或切换模型', args: '[model] [effort]',
  interaction: 'form' }   // ← 提示 CLI：选中后 Gateway 会返回 FormInteraction
```

老版 CLI 忽略不认识的字段，不影响现有行为。

### 4.6 WeChat

**无变更**。`sendInteraction` 方法不存在 → Core 自动 fallback 到文本。

---

## 五、渠道渲染降级策略

| Field / 属性 | Feishu Card | AUN CLI (future) | WeChat fallback |
|-------------|-------------|-------------------|-----------------|
| `text` | `input` 组件 | `prompt()` | 文本提示用户输入 |
| `select` | `select_static` 组件 | RadioList / 补全 | 文本列表 + 回复序号 |
| `multi-select` | `checker` 多选 | CheckboxList | 文本列表 + 回复多个序号 |
| `toggle` | `checker` 单选 | `[Y/n]` prompt | "回复 Y/N" |
| `buttons` | `button` 组件 | ButtonDialog | "回复 allow/deny" |
| `required` | 前端校验 | prompt 循环直到非空 | 文本标注 `(必填)` |
| `hint` | 字段下方灰色文字 | 括号说明 | 并入提示文本 |
| `placeholder` | 组件内提示 | prompt 默认文字 | 忽略 |
| `confirm` | 飞书原生弹窗 | `[Y/n]` 二次确认 | 忽略 |
| `minSelect/maxSelect` | 前端校验 | 数量检查 | 文本标注 `(至少选N项)` |
| `defaultValue/selected` | 预填充 | 默认选中 | 文本标注 `(当前)` |

---

## 六、执行流图

### 交互卡片完整流程

```
场景: Agent 请求权限审批

PermissionGateway.requestPermission()
  │
  ├─ 构造 InteractionRequest { kind: 'action', buttons: [allow, always, deny] }
  │
  ├─ adapter.sendInteraction?  ──── 存在且返回 true ────→ 等待 InteractionRouter 回调
  │                                                       │
  │                                                   [Feishu] card.action.trigger
  │                                                   [AUN]   interaction.response JSON
  │                                                       │
  │                                                   InteractionRouter.handle()
  │                                                       │
  │                                                   gateway.resolvePermission() ← 复用现有逻辑
  │
  └─ 不存在或返回 false ────→ fallback: sendPrompt(文本)
                              │
                              用户手动输入 /perm allow
                              │
                              CommandHandler.handle() → gateway.resolvePermission()
```

### 命令交互流程

```
用户输入 /model (无参数)
  │
  CommandHandler.handle()
  │
  ├─ adapter.sendInteraction? ──── 存在且返回 true ────→ FormInteraction 卡片
  │                                                       │
  │                                                   用户选择模型 + 力度，点击「应用」
  │                                                       │
  │                                                   InteractionResponse { action: 'submit', values: { model, effort } }
  │                                                       │
  │                                                   InteractionRouter.handle()
  │                                                       │
  │                                                   CommandHandler.executeInteraction()
  │                                                       │
  │                                                   agent.setModel(values.model)
  │                                                   agent.setEffort(values.effort)
  │
  └─ 不存在或返回 false ────→ 显示文本: "当前模型: opus\n可用: opus, sonnet, haiku"
                              用户手动输入 /model sonnet medium
```

### AUN menu 衔接流程（未来）

```
AUN CLI 用户按 / 触发补全
  │
  CLI 发 menu.query → Gateway 返 menu.response
  │
  CLI 渲染补全菜单，用户选中 /model
  │
  ├─ item.interaction === undefined → 直接发 "/model" 文本（当前行为不变）
  │
  └─ item.interaction === 'form'   → 直接发 "/model" 文本
                                       ↓
                                   Gateway CommandHandler 处理
                                       ↓
                                   检测到 AUN adapter 实现了 sendInteraction
                                       ↓
                                   发 FormInteraction JSON 到 CLI
                                       ↓
                                   CLI 渲染为 prompt 交互
                                       ↓
                                   用户填写 → 发 interaction.response JSON
                                       ↓
                                   InteractionRouter.handle() → 执行命令
```

---

## 七、实现计划

### 阶段划分

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **P0** | 协议类型定义 + InteractionRouter + PermissionGateway 改造 + 飞书权限审批卡片 | 最高 |
| **P1** | 飞书危险命令确认卡片 (`/restart`, `/clear`) | 高 |
| **P2** | 飞书表单卡片 (`/model`, `/p`, `/s`, `/agent`, `/perm`) | 中 |
| **P3** | AUN 客户端交互实现（独立迭代） | 低 |

### P0 详细步骤

#### Step 1: 类型定义

**文件**: `src/types.ts`

新增：
- `InteractionField` 类型联合 (`TextField | SelectField | MultiSelectField | ToggleField`)
- `InteractionKind` 类型联合 (`ActionInteraction | FormInteraction | MenuInteraction`)
- `InteractionRequest` 接口
- `InteractionResponse` 接口
- `ChannelAdapter` 新增 `sendInteraction?` 和 `onInteraction?` 方法

#### Step 2: InteractionRouter

**文件**: `src/core/interaction-router.ts` (新建)

实现：
- `register()` — 注册等待回调 + 超时处理
- `handle()` — 路由响应到 handler
- `cancelAll()` — 按 sessionId 批量取消
- `getPending()` — 查询待处理列表

约 50 行。

#### Step 3: PermissionGateway 改造

**文件**: `src/core/permission.ts`

改动：
- `requestPermission()` 签名增加可选 `context` 参数
- 内部逻辑：先尝试 `adapter.sendInteraction()`，失败 fallback 到 `sendPrompt()`
- 交互成功时注册到 `InteractionRouter`

约 20 行改动。向后兼容：不传 context 时行为完全不变。

#### Step 4: 飞书卡片构建

**文件**: `src/channels/feishu.ts`

新增：
- `buildInteractionCard(interaction)` — InteractionRequest → Feishu Card JSON
  - `action` → 按钮行
  - `form` → 字段组件 + 提交按钮
- `buildResolvedCard(response)` — 回调后的更新卡片（禁用按钮 + 显示结果）
- `sendInteraction()` 方法实现
- `onInteraction()` 方法实现

约 150 行。

#### Step 5: card.action.trigger 事件注册

**文件**: `src/channels/feishu.ts`

改动：
- `EventDispatcher.register()` 新增 `'card.action.trigger'` 处理
- 解析 `data.action.value` → 构造 `InteractionResponse` → 调用回调
- 返回更新后的卡片 JSON

约 30 行。

**前置条件**：飞书开发者后台需配置「通过长连接接收回调」并订阅 `card.action.trigger` 事件。

#### Step 6: 连接层集成

**文件**: `src/index.ts`

改动：
- 创建 `InteractionRouter` 实例
- 遍历渠道：对实现了 `onInteraction` 的 adapter 注册回调 → 路由到 router
- 将 router 传递给 PermissionGateway（通过 MessageProcessor 透传）

约 15 行。

**文件**: `src/core/message/message-processor.ts`

改动：
- `processMessage()` 中调用 `agent.setSendPrompt()` 时，同时传递 adapter + router 信息
- 约 5 行。

#### Step 7: 测试

- 单元测试：InteractionRouter 的注册/路由/超时/取消
- 单元测试：PermissionGateway 新流程（有 adapter vs 无 adapter）
- 集成测试：飞书卡片构建的 JSON 结构验证
- 手动测试：飞书端实际交互验证

### 改造文件总览

| 文件 | 变更类型 | 行数估算 |
|------|---------|---------|
| `src/types.ts` | 新增类型定义 | +80 |
| `src/core/interaction-router.ts` | **新文件** | +50 |
| `src/core/permission.ts` | 改造 `requestPermission` | ~+20, ~5 改 |
| `src/channels/feishu.ts` | 实现 `sendInteraction` + `onInteraction` + 卡片构建 | +150 |
| `src/core/command-handler.ts` | 命令交互化（P1/P2 阶段） | +60 |
| `src/core/message/message-processor.ts` | 透传 adapter + router | ~5 改 |
| `src/core/message/message-bridge.ts` | menu.query 兼容 | ~5 改 |
| `src/index.ts` | 创建 router, 注册回调 | +15 |
| `src/channels/aun.ts` | **无变更** | 0 |
| `src/channels/wechat.ts` | **无变更** | 0 |

---

## 八、设计约束与注意事项

### 飞书限制

1. **3 秒响应**：`card.action.trigger` 回调必须 3 秒内返回。EvolClaw 的 `resolvePermission` 是同步操作（清 timer + resolve Promise），满足要求
2. **开发者后台配置**：必须启用「通过长连接接收回调」并订阅 `card.action.trigger` 事件
3. **卡片状态管理**：已审批的卡片需更新（禁用按钮 + 显示结果），避免重复点击
4. **幂等性**：同一个 requestId 只处理第一次回调，后续调用 `router.handle()` 返回 false

### 向后兼容

1. **文本 `/perm` 命令继续工作**：卡片只是额外的输入方式，`CommandHandler` 中的 `/perm allow` 处理不变
2. **AUN menu.query/response 不变**：Gateway 继续返回旧格式
3. **ChannelAdapter 接口扩展**：`sendInteraction` 和 `onInteraction` 均为 optional 方法，不实现的渠道零影响
4. **PermissionGateway.requestPermission 签名**：新参数为可选的 `context` 对象，不传时行为完全不变

### 扩展性验证

- **新增 Telegram 通道**：实现 `sendInteraction`（InlineKeyboard）+ `onInteraction`（callback_query），核心层零改动
- **新增交互类型**（如文件审批）：在 `InteractionKind` 联合中新增，不支持的渠道自动 fallback
- **AUN Web 客户端**：同一 JSON 协议，Web 端渲染为 HTML 组件，Gateway 零改动
