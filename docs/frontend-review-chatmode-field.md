# 前端审查：message.send 和 thought.put 的 chatmode 字段使用情况

## 文档信息

| 项目 | 内容 |
|------|------|
| 审查目标 | 确认前端是否依赖 payload.chatmode 字段 |
| 创建日期 | 2026-06-25 |
| 审查人 | [待填写：前端负责人] |
| 审查状态 | 待审查 |

---

## 背景

evolclaw 后端在发送消息时，`chatmode` 字段的位置存在不一致：

| 协议方法 | chatmode 位置 | 当前状态 |
|---------|--------------|---------|
| **message.send** | `payload.chatmode`（顶层） | ✅ 有 |
| **group.send** | `payload.chatmode`（顶层） | ✅ 有 |
| **thought.put** | **无**（不写入 payload） | ❌ 缺失 |
| **status** | `payload.chatmode`（顶层） | ✅ 有 |

**关键事实**：
1. Gateway 无法查看 payload 内容（加密），不需要 chatmode
2. 只有**前端**会解开并查看 payload
3. 需要前端确认是否实际使用了这个字段

---

## 需要审查的问题

### 问题 1：前端是否读取 payload.chatmode？

**审查位置**：
- 消息渲染逻辑（message.send / group.send 的处理）
- 思考过程渲染逻辑（thought.put 的处理）
- 任何读取 `payload.chatmode` 或 `message.chatmode` 的代码

**问题**：
- [ ] 前端是否从 `payload.chatmode` 读取数据？
- [ ] 如果读取了，用于什么目的？（渲染样式/分流/统计/其他）
- [ ] 缺失 chatmode 是否会导致 bug 或降级体验？

---

### 问题 2：message.send 的 chatmode 如何使用？

**后端发送示例**（evolclaw）：
```json
// message.send 的 payload
{
  "type": "text",
  "text": "这是回复内容",
  "chatmode": "proactive",  // ✅ 有这个字段
  "thread_id": "...",
  "task_id": "..."
}
```

**前端审查点**：
- [ ] 前端解析 message.send 时，是否访问 `payload.chatmode`？
- [ ] 如果访问了，代码位置在哪里？
- [ ] 用途是什么？（例如：根据 chatmode 决定消息样式、图标、分组等）

---

### 问题 3：thought.put 的 chatmode 如何处理？

**后端发送示例**（evolclaw）：
```json
// thought.put 的 payload（当前实现）
{
  "items": [
    {
      "kind": "text",
      "text": "我正在思考..."
    }
  ]
  // ❌ 没有 chatmode 字段
}
```

**前端审查点**：
- [ ] 前端解析 thought.put 时，是否尝试访问 `payload.chatmode`？
- [ ] 如果尝试访问但字段不存在，是否：
  - 有兜底默认值（如默认为 'proactive'）？
  - 会导致 undefined / null 的错误？
  - 会影响渲染效果？
- [ ] 前端是否通过其他方式推断 chatmode（如：thought 必然是 proactive）？

---

### 问题 4：不一致是否造成实际问题？

**场景对比**：

| 场景 | message.send | thought.put |
|------|-------------|-------------|
| 字段存在 | ✅ `payload.chatmode` | ❌ 无 |
| 前端读取 | `const mode = payload.chatmode` | `const mode = payload.chatmode` ← undefined |
| 潜在影响 | 正常 | 可能降级/报错？ |

**审查问题**：
- [ ] 实际使用中，thought.put 的渲染是否正常？
- [ ] 是否观察到与 message.send 渲染不一致的问题？
- [ ] 前端日志中是否有 undefined chatmode 的警告？

---

## 可能的使用场景（假设）

### 场景 A：根据 chatmode 决定消息样式

```typescript
// 伪代码示例
function renderMessage(payload) {
  const mode = payload.chatmode; // 'interactive' | 'proactive'
  
  if (mode === 'interactive') {
    // 交互模式：显示为正式对话气泡
    return <MessageBubble>{payload.text}</MessageBubble>;
  } else {
    // 主动模式：显示为思考过程（轻量化样式）
    return <ThoughtBubble>{payload.text}</ThoughtBubble>;
  }
}
```

**影响**：如果 thought.put 没有 chatmode，mode 是 undefined → 可能渲染错误或回退到默认样式。

---

### 场景 B：消息分组/统计

```typescript
// 伪代码示例
function categorizeMessages(messages) {
  const interactive = messages.filter(m => m.payload.chatmode === 'interactive');
  const proactive = messages.filter(m => m.payload.chatmode === 'proactive');
  
  return { interactive, proactive };
}
```

**影响**：thought.put 会被漏掉（chatmode 是 undefined）。

---

### 场景 C：不使用 chatmode

```typescript
// 伪代码示例
function renderMessage(payload, messageType) {
  // 前端通过 messageType 区分，不依赖 chatmode
  if (messageType === 'thought') {
    return <ThoughtBubble>{payload.text}</ThoughtBubble>;
  } else {
    return <MessageBubble>{payload.text}</MessageBubble>;
  }
}
```

**影响**：无，chatmode 字段是冗余的，不一致不会造成问题。

---

## 审查结论（待前端填写）

### 1. 前端是否使用 payload.chatmode？

- [ ] **是** - 使用了，用途：_______________
- [ ] **否** - 不使用，通过其他方式区分消息类型
- [ ] **部分使用** - 在某些场景使用，详见：_______________

### 2. 如果使用，thought.put 缺失 chatmode 是否有影响？

- [ ] **有影响** - 导致问题：_______________
- [ ] **无影响** - 因为：_______________（如：thought 必然是 proactive，可推断）
- [ ] **不确定** - 需要进一步测试

### 3. 建议后端如何处理？

- [ ] **补齐** - 建议 thought.put 也写入 payload.chatmode，保持一致
- [ ] **保持现状** - 前端不依赖此字段，不一致不影响
- [ ] **前端兜底** - 后端保持现状，前端在 chatmode 缺失时使用默认值

### 4. 其他发现或建议

（待填写）

---

## 后端补齐方案（如果需要）

如果前端确认需要 chatmode 字段，后端可以快速补齐：

**改动位置**：`src/channels/aun.ts` 的 `sendThought` 方法

**改动内容**（约 5 行）：
```typescript
// 在构造 params 后，补齐 chatmode（与 deliverTextEntry 对齐）
if (context?.metadata?.chatmode && !params.payload.chatmode) {
  params.payload.chatmode = context.metadata.chatmode;
}
```

**测试验证**：
- 发送一条 thought.put，前端确认 payload.chatmode 存在
- 验证不影响现有功能

---

## 审查流程

1. **后端提供本文档** → 前端团队
2. **前端审查代码** → 填写上方"审查结论"
3. **前端反馈结果** → 后端
4. **后端决策**：
   - 如果前端需要 → 补齐 chatmode
   - 如果前端不需要 → 关闭 issue，文档化差异
5. **验证并关闭**

---

## 附录：相关代码位置

### 后端（evolclaw）

| 位置 | 说明 |
|------|------|
| `src/channels/aun.ts:2767` | deliverTextEntry 写入 payload.chatmode |
| `src/channels/aun.ts:2374` | applyReplyContextToPayload 写入 payload.chatmode |
| `src/channels/aun.ts:2935-2991` | sendThought 不写入 payload.chatmode |

### 前端（待填写）

| 位置 | 说明 |
|------|------|
| （待前端填写） | 读取 payload.chatmode 的代码位置 |
| （待前端填写） | 渲染 message.send 的逻辑 |
| （待前端填写） | 渲染 thought.put 的逻辑 |

---

## 文档历史

| 日期 | 修改 | 作者 |
|------|------|------|
| 2026-06-25 | 初始版本，提交前端审查 | Claude Code (evolclaw 后端) |
