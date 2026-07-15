# 双会话响应模式 - 通用参数

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 设计定稿

---

## 一、概述

通用参数是**所有响应模式都支持的配置参数**。双会话响应模式作为响应模式体系的一部分，完整支持所有通用参数。

---

## 二、通用参数清单

通用参数全部在**配置顶层**（与 responseMode 平级），不包在某个 config 对象里：

```typescript
// 顶层字段（非嵌套在 config 内）
{
  // 1. 交互方式：场景表字典，按对端类型（private/nothuman/group）取键
  chatmode?: { private?: ChatMode; nothuman?: ChatMode; group?: ChatMode };
  //   ChatMode = 'interactive' | 'proactive'；出厂默认来自 schema

  // 2. Mention 处理策略（标量）
  mentionMode?: 'disabled' | 'mention-only';

  // 3. 模型选择（标量）
  model?: string;
}
```

> 完整语义/解析优先级/层级合并以 [config-reference.md](../../config-reference.md) 为准。

---

## 三、chatMode（交互方式）

### 3.1 定义

**语义**：决定主会话如何投递回复。存放为顶层**场景表字典** `chatmode`，
实际生效值由对端类型选键（私聊人→`private`，私聊 agent→`nothuman`，群聊→`group`）。
每个键的值是标量 `interactive` | `proactive`。

| 值 | 说明 | 典型场景 |
|---|------|---------|
| `interactive` | 输出即回复 | coding 模式（无渠道，对端 system → 硬约束） |
| `proactive` | CLI 回复 | 单聊/群聊（有渠道） |

### 3.2 在双会话中的实现

**架构位置**：主会话（MainSession）

**实现方式**：

```typescript
class MainSession {
  private chatMode: 'interactive' | 'proactive';
  
  constructor(config: DualSessionConfig) {
    this.chatMode = config.chatMode;
  }
  
  async process(batch: Message[]): Promise<void> {
    // 调用模型
    const response = await this.callModel(batch);
    
    // 根据 chatMode 处理回复
    if (this.chatMode === 'interactive') {
      // 输出已经是回复，无需额外处理
      // 系统提示词：直接输出即回复
    } else if (this.chatMode === 'proactive') {
      // 主会话在 turn 内通过 CLI 发送回复
      // 系统提示词：使用 CLI 命令发送回复
    }
  }
}
```

### 3.3 系统提示词集成

**ECK Fragment**（`when: { "var": "chatMode", "eq": "proactive" }`）：

```markdown
## 回复方式

当前模式：`proactive`（主动模式）

使用 CLI 命令发送回复：
- 私聊：`ec msg send "<content>"`
- 群聊：`ec group send "<content>"`

**不要直接输出文本**，必须通过 CLI 发送。
```

**ECK Fragment**（`when: { "var": "chatMode", "eq": "interactive" }`）：

```markdown
## 回复方式

当前模式：`interactive`（交互模式）

直接输出即回复，无需使用 CLI 命令。
```

### 3.4 配置示例

```json
// coding 模式（对端 system → 硬约束 interactive，通常无需配 chatmode）
{ "responseMode": "dual-session" }

// 单聊/群聊：chatmode 场景表在顶层，按对端类型取键
{
  "responseMode": "dual-session",
  "chatmode": { "private": "interactive", "group": "proactive" }
}
```

---

## 四、mentionMode（Mention 处理策略）

### 4.1 定义

**语义**：决定如何处理被 @ 的消息

| 值 | 说明 | 通用语义 |
|---|------|---------|
| `disabled` | 所有消息都处理 | 默认值 |
| `mention-only` | 仅处理被 @ 的消息 | 未 @ 消息入队作引用上下文，不触发处理 |

**详细机制**：请参见 [MENTION-MODE-MECHANISM.md](../MENTION-MODE-MECHANISM.md)

### 4.2 在双会话中的实现

**架构位置**：辅助队列入队逻辑

**实现方式**：

> 详细实现见 [MENTION-MODE-MECHANISM.md](../MENTION-MODE-MECHANISM.md)。
> 下方仅列出入队与触发逻辑的简化示意。

```typescript
// mention-only 模式：所有消息一律入队，只有 @ / 活跃发言人才触发处理
if (config.mentionMode === 'mention-only') {
  await auxiliaryQueue.enqueue(message);  // 所有消息都入队（不过滤）
  
  if (message.isMentioned) {
    // 被 @ 消息：立即触发处理（提取 primary + references，锚点清理）
    await handleMentionTrigger(message);
  } else if (isActiveSpeaker(message.peerId)) {
    // 活跃发言人后续消息：走正常流程（防抖触发）
  }
  // else：纯未 @ 消息，不触发处理，留在队列作引用上下文
  return;
}

// disabled 模式：所有消息进入辅助队列，防抖触发
await auxiliaryQueue.enqueue(message);
```

### 4.3 行为对比

| mentionMode | 被 @ 的消息 | 未被 @ 的消息 | 响应延迟 |
|-------------|-----------|-------------|---------|
| `disabled` | 进入辅助队列 → 辅助会话判断 | 进入辅助队列 → 辅助会话判断 | 3-63秒 |
| `mention-only` | 进入辅助队列 → 辅助会话判断 | 进入辅助队列（**作引用上下文，不触发处理**） | 3-63秒 |

**注意**：
- 被 @ 的消息会触发辅助会话判断（可能立即投递或延迟）
- 未被 @ 的消息在 `mention-only` 模式下**进入辅助队列**作为引用上下文，不触发处理（靠锚点清理 / 滚动淘汰离开队列）
- 活跃发言人的后续消息（5 分钟内）走正常流程，会被触发、投递、回复

### 4.4 适用场景

| mentionMode | 适用场景 |
|-------------|---------|
| `disabled` | 多 agent 群聊，需要智能判断消息相关性 |
| `mention-only` | Agent 只响应明确的召唤（@） |

### 4.5 配置示例

```json
// 默认配置（所有消息都处理）
{
  "responseMode": "dual-session",
  "mentionMode": "disabled"
}

// 只响应 @（未 @ 消息作引用上下文）
{
  "responseMode": "dual-session",
  "mentionMode": "mention-only"
}
```

### 4.6 与辅助会话的协同

**isMentioned 标记**：

即使 `mentionMode === 'disabled'`，消息仍然携带 `isMentioned` 标记，辅助会话可以将其作为相关性判断的依据：

```typescript
interface Message {
  // ... 其他字段
  isMentioned?: boolean;  // 是否 @ 本 agent
}
```

**辅助会话提示词**：

```markdown
**消息相关性提示**：
- 如果消息被标记为 `isMentioned: true`，说明 Owner 或其他人 @ 了本 agent
- 被 @ 的消息通常相关性较高，应优先考虑 transfer
```

---

## 五、model（模型选择）

### 5.1 定义

**语义**：主会话使用的模型

- 可选参数，默认由响应模式决定
- 双会话默认：`claude-opus`

### 5.2 在双会话中的实现

**架构位置**：主会话（MainSession）

**实现方式**：

```typescript
class MainSession {
  private model: string;
  
  constructor(config: DualSessionConfig) {
    // 优先使用用户配置，否则使用默认值
    this.model = config.model || 'claude-opus';
  }
  
  async callModel(batch: Message[]): Promise<Response> {
    return await claudeAPI.call({
      model: this.model,  // 使用配置的模型
      messages: this.buildMessages(batch),
      system: await this.loadSystemPrompt(),
    });
  }
}
```

### 5.3 与辅助模型的区别

| 模型 | 配置参数 | 用途 | 默认值 |
|------|---------|------|--------|
| **主会话模型** | `model` | 主会话处理消息、生成回复 | `claude-opus` |
| **辅助会话模型** | `auxiliaryModel` | 辅助会话判断投递时机 | `deepseek-v4-flash` |

**注意**：`auxiliaryModel` 是 dual-session 的**特有参数**，不是通用参数。

### 5.4 配置示例

```json
// 使用默认模型
{ "responseMode": "dual-session" }

// 自定义主会话模型（model 是顶层通用参数）
{
  "responseMode": "dual-session",
  "model": "claude-sonnet"
}

// 同时自定义主会话和辅助会话模型
// model 顶层；auxiliaryModel 是 dual-session 特有参数，放 responseModeParams 桶
{
  "responseMode": "dual-session",
  "model": "claude-sonnet",
  "responseModeParams": {
    "dual-session": { "auxiliaryModel": "claude-haiku" }
  }
}
```

---

## 六、通用参数的配置层级

通用参数可以在多个层级配置，优先级从高到低：

1. **关系级配置**（`$RELATIONS_DIR/<peerKey>/config.json`）
2. **环境级配置**（预留，存储路径待环境层定型）
3. **Agent 级配置**（`$AGENT_DIR/config.json`）
4. **出厂默认值**（`chatmode` 出厂表来自 schema；`mentionMode` schema default）

**示例**（通用参数均在顶层；`mentionMode` 标量整体覆盖，`chatmode` 字典逐键覆盖）：

```json
// Agent 级配置（$AGENT_DIR/config.json）
{
  "responseMode": "dual-session",
  "chatmode": { "private": "interactive", "group": "proactive" },
  "mentionMode": "disabled"
}

// 关系级覆盖（$RELATIONS_DIR/aun#alice.aid.pub/config.json）
{
  "mentionMode": "mention-only"  // 只覆盖 mentionMode（标量）
}

// 最终生效配置
{
  "responseMode": "dual-session",
  "chatmode": { "private": "interactive", "group": "proactive" },  // 继承 Agent 级
  "mentionMode": "mention-only"                                      // 关系级覆盖
}
```

---

## 七、ECK Vars 集成

通用参数会提取到 ECK Vars 中，供 Context Assembly 使用：

```typescript
interface ECKVars {
  // 响应模式
  responseMode: 'dual-session';

  // 通用参数（chatMode 是宿主按对端类型从顶层 chatmode 字典解析出的标量）
  chatMode: 'interactive' | 'proactive';
  mentionMode: 'disabled' | 'mention-only';
  model: string;

  // dual-session 会话原型（系统级；取代旧的 sessionType）
  sessionPrototype?: 'auxiliary' | 'main';

  // 其他参数
  chatType: 'private' | 'group' | null;
  channel: string;
  // ...
}
```

**Context Assembly Manifest**：

```jsonc
{
  "sections": [
    // chatMode 说明（所有模式通用）
    {
      "id": "chat-mode-guide-proactive",
      "type": "file",
      "file": "$KITS_DOCS/response-system/prompts/chat-mode-proactive.md",
      "order": 56,
      "needsInjection": false,
      "when": { "var": "chatMode", "eq": "proactive" }
    },
    {
      "id": "chat-mode-guide-interactive",
      "type": "file",
      "file": "$KITS_DOCS/response-system/prompts/chat-mode-interactive.md",
      "order": 56,
      "needsInjection": false,
      "when": { "var": "chatMode", "eq": "interactive" }
    },
    // mentionMode 说明（所有模式通用）
    {
      "id": "mention-mode-guide",
      "type": "file",
      "file": "$KITS_DOCS/response-system/prompts/mention-only-guide.md",
      "order": 57,
      "needsInjection": false,
      "when": { "var": "mentionMode", "eq": "mention-only" }
    }
  ]
}
```

---

## 八、总结

### 通用参数的特点

✅ **所有响应模式都支持**：single-session / dual-session / workflow  
✅ **职责明确**：chatMode（如何回复）/ mentionMode（是否触发处理）/ model（用什么模型）  
✅ **配置灵活**：支持多层级配置和覆盖  
✅ **ECK 集成**：自动提取到 ECK Vars，供 Context Assembly 使用  

### 双会话的实现要点

- **chatMode**：主会话根据参数决定回复方式
- **mentionMode**：消息入队后根据参数决定是否触发处理/路由策略
- **model**：主会话使用该模型（辅助会话有独立配置 `auxiliaryModel`）

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 设计定稿
