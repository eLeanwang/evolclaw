# 实施计划：Trigger 专属会话迭代

## Context

移除 `silent` 策略，新增 `current`（绑定创建时会话）和 `thread`（专属话题会话）。不考虑向下兼容，`latest` 不变。

Spec：`docs/superpowers/specs/2026-06-01-trigger-dedicated-session-design.md`

## 已验证的关键已知量

| 方法/位置 | 签名/行为 | 来源行 |
|---|---|---|
| `getSessionById` | `async (sessionId): Promise<Session\|undefined>` | `session-manager.ts:879` |
| `switchToSession` | `async (channel, channelId, targetSessionId): Promise<Session\|null>`，写 active.json | `session-manager.ts:952` |
| `isProcessing` | `(sessionKey): boolean`，前缀匹配 `${sessionKey}::` | `message-queue.ts:277` |
| 队列 key | `${sessionKey}::${path.resolve(projectPath)}` | `message-queue.ts:85` |
| 用户消息入队 | `enqueue(session.id, msg, session.projectPath, ...)` | `message-bridge.ts:207` |
| 触发器入队调用点 | `index.ts:513` fireCallback，闭包可访问 `sessionManager`/`eventBus` | `index.ts:334,320` |
| `task:completed` 事件 | 带 `sessionId: string` | `event-bus.ts:46` |
| `eventBus.unsubscribe` | 存在，可手动退订防泄漏 | `event-bus.ts:133` |
| `isBackgroundSession` | `threadId` 非空 → `return false`（豁免）；主会话 `id !== active.id` → `return true`（静默） | `message-processor.ts:117` |
| 输出门控 | `if (isCurrentlyBackground) return;` | `message-processor.ts:514` |
| `Trigger.targetChannelType` | 已存在字段，注册时需填 | `types.ts:834` |
| `triggerMeta.silent` | 须从 `buildSyntheticMessage` 移除 | `scheduler.ts:249` |

---

## Task 1 — 类型变更（`src/types.ts`）

1. `TriggerSessionStrategy`：`'latest' | 'current' | 'thread'`（移除 `'silent'`）。
2. `Trigger` 接口新增：
   ```typescript
   boundSessionId?: string;       // current：注册时绑定的 sessionId
   threadKind?: 'aun' | 'feishu'; // thread：实现路径
   rootMessageId?: string;        // thread(feishu)：注册时命令消息的 messageId
   pendingThread?: boolean;       // thread(feishu)：首次触发待建话题
   ```
3. `Message.triggerMeta` 调整：
   ```typescript
   triggerMeta?: {
     triggerId: string;
     // 移除 silent
     boundSessionId?: string;
     pendingThread?: boolean;
     rootMessageId?: string;
   };
   ```
4. `ChannelCapabilities` 新增 `thread: boolean`（TS 编译会自动提示所有需要补字段的字面量）。

---

## Task 2 — Parser（`src/core/trigger/parser.ts`）

1. `--session` 接受值改为 `latest | current | thread`，拒绝 `silent`（更新报错文案）。
2. 互斥规则不变（`--session` 与 `--thread <id>` 互斥）。
3. `ParsedTriggerSet.targetSessionStrategy` 类型跟随 Task 1。

---

## Task 3 — ChannelCapabilities 补字段

- `feishu.ts:1606`、`aun.ts:2583`：`capabilities` 加 `thread: true`。
- 其余渠道：`thread: false`。
- Task 1 加字段后 TS 编译报错会自动指出所有需补的地方。

---

## Task 4 — CommandHandler：messageId 透传 + handleTrigger 分流

**messageId 透传**（`src/core/command-handler.ts` + `src/core/message/message-bridge.ts`）：
1. `handle()` / `_handleInternal()` 签名末位加 `messageId?: string`。
2. `handleTrigger(...)` 签名加 `messageId?: string`。
3. 分发处（`:3465`）透传：`this.handleTrigger(content, channel, channelId, userId, isAdmin, messageId)`。
4. `message-bridge.ts:438` 调用 `handle(...)` 时加 `msg.messageId`。

**handleTrigger set 分支**（`:3592`）按策略分流：
```typescript
if (parsed.session === 'current') {
  const active = await this.sessionManager.getActiveSession(channel, channelId);
  if (!active) return '❌ 当前没有活跃会话，改用 --session latest 或 thread';
  trigger.boundSessionId = active.id;
}
else if (parsed.session === 'thread') {
  const adapter = this.adapters.get(trigger.targetChannel);
  if (!adapter?.capabilities.thread) return '❌ 目标渠道不支持 thread 会话';
  const { type: channelType } = parseChannelKey(adapter.channelKey);  // channel-loader.ts:234
  trigger.targetChannelType = channelType;
  if (channelType === 'aun') {
    trigger.threadKind = 'aun';
    trigger.targetThreadId = `trigger-${trigger.id}`;
  } else {  // feishu
    if (!messageId) return '❌ 飞书 thread 模式需要消息 ID，请重新发送命令';
    trigger.threadKind = 'feishu';
    trigger.rootMessageId = messageId;
    trigger.pendingThread = true;
  }
}
```

---

## Task 5 — Scheduler buildSyntheticMessage（`src/core/trigger/scheduler.ts:237`）

```typescript
if (trigger.targetSessionStrategy === 'current') {
  base.triggerMeta = { triggerId: trigger.id, boundSessionId: trigger.boundSessionId };
} else if (trigger.targetSessionStrategy === 'thread') {
  if (trigger.threadKind === 'feishu' && trigger.pendingThread) {
    base.triggerMeta = { triggerId: trigger.id, pendingThread: true, rootMessageId: trigger.rootMessageId };
  } else {
    base.threadId = trigger.targetThreadId ?? '';
    base.triggerMeta = { triggerId: trigger.id };
  }
} else {
  // latest
  base.triggerMeta = { triggerId: trigger.id };
}
// 移除旧的 silent: trigger.targetSessionStrategy === 'silent'
```

---

## Task 4b — Fire 阶段：current 忙检查 + 延迟补发（`src/index.ts:513`）

替换现有 `:513-518`：

```typescript
scheduler.setFireCallback((msg, trigger) => {
  if (trigger.targetSessionStrategy === 'current' && trigger.boundSessionId) {
    const boundId = trigger.boundSessionId;
    if (messageQueue.isProcessing(boundId)) {
      scheduleRetryWhenIdle(boundId, msg, trigger);
      return;
    }
    // 用 bound 会话的 projectPath 入队（确保与用户消息同队列，防并发）
    sessionManager.getSessionById(boundId).then(bound => {
      if (!bound) { logger.warn(`[Trigger] Bound session ${boundId} not found`); return; }
      messageQueue.enqueue(boundId, msg, bound.projectPath, { interruptible: false })
        .catch(err => logger.error(`[Trigger] Enqueue failed ${trigger.id}: ${err}`));
    });
    return;
  }
  // latest / thread
  messageQueue.enqueue(`${msg.channel}:${msg.channelId}`, msg, primaryProjectPath, { interruptible: false })
    .catch(err => logger.error(`[Trigger] Enqueue failed ${trigger.id}: ${err}`));
});
```

**`scheduleRetryWhenIdle`**（定义在 index.ts 的 setup 闭包内）：
```typescript
function scheduleRetryWhenIdle(boundId: string, msg: Message, trigger: Trigger) {
  let done = false;
  const handler = (ev: GatewayEvent) => {
    if ((ev as any).sessionId !== boundId || done) return;
    done = true;
    clearTimeout(timer);
    eventBus.unsubscribe('task:completed', handler);
    retry();
  };
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    eventBus.unsubscribe('task:completed', handler);
    retry();
  }, 30_000);
  eventBus.subscribe('task:completed', handler);

  function retry() {
    if (messageQueue.isProcessing(boundId)) { scheduleRetryWhenIdle(boundId, msg, trigger); return; }
    sessionManager.getSessionById(boundId).then(bound => {
      if (!bound) { logger.warn(`[Trigger] Bound session ${boundId} deleted, aborting`); return; }
      messageQueue.enqueue(boundId, msg, bound.projectPath, { interruptible: false })
        .catch(err => logger.error(`[Trigger] Retry failed ${trigger.id}: ${err}`));
    });
  }
}
```

`done` flag 确保事件与 timeout 两路只有一路触发。`unsubscribe` 防事件监听泄漏（cron 触发器会反复调用）。

---

## Task 6 — MessageProcessor resolveSession（`src/core/message/message-processor.ts:1140`）

1. **移除** silent 分支（`:1154-1172`）。
2. **移除** `isAutonomous` 里的 `message.triggerMeta?.silent === true` 条件（`:425`）。
3. **移除** 触发完成时对 `autonomous` 会话的 `unbindSession` 清理段（`:1010-1020` 附近）。
4. **新增 current 分支**（主流程最前面）：
   ```typescript
   if (message.triggerMeta?.boundSessionId) {
     const bound = await this.sessionManager.getSessionById(message.triggerMeta.boundSessionId);
     if (bound) {
       // 切成 active，使 isBackgroundSession 返回 false（输出才发得出）
       // 用 bound 自己的 channel/channelId，不是 message.channel/channelId
       await this.sessionManager.switchToSession(bound.channel, bound.channelId, bound.id);
       const absoluteProjectPath = path.isAbsolute(bound.projectPath)
         ? bound.projectPath : path.resolve(process.cwd(), bound.projectPath);
       return { session: bound, absoluteProjectPath };
     }
     logger.warn(`[MessageProcessor] Bound session ${message.triggerMeta.boundSessionId} not found, falling back to latest`);
   }
   ```
5. **thread(AUN / feishu 已回填)**：`message.threadId` 非空 → 现有 `getOrCreateSession(threadId)` 链路（`:1174`）处理，**零新代码**。
6. **thread(feishu) 首次（`pendingThread`）**：
   - 走主会话路径（`getOrCreateSession` 不传 threadId）。
   - 在 IMRenderer send 回调里注入 `replyContext = { replyToMessageId: rootMessageId, replyInThread: true, metadata: { onThreadCreated } }`。
   - `onThreadCreated(threadId)` → `triggerManager.update(triggerId, { targetThreadId: threadId, pendingThread: false })`（`trigger/manager.ts:136` 已支持此 patch）。

---

## Task 7 — Feishu sendMessage 回传 thread_id（`src/channels/feishu.ts:475`）

1. options 新增 `onThreadCreated?: (threadId: string) => void`。
2. reply 后接收返回值：
   ```typescript
   const res = await this.client.im.message.reply({ path: { message_id: options.replyToMessageId }, data: replyData });
   if (options.replyInThread && options.onThreadCreated) {
     const newThreadId = (res as any).data?.thread_id;
     if (newThreadId) options.onThreadCreated(newThreadId);
   }
   ```
3. Feishu adapter `send`（`:1607`）在 `result.text` case 从 `ctx.metadata?.onThreadCreated` 透传此回调。
4. 兜底：reply 降级（230011）→ `onThreadCreated` 不被调用 → 在 `task:completed` 处检查 `pendingThread` 仍为 true 时调 `triggerManager.update(triggerId, { pendingThread: false })` 标记失败，避免下次仍重试。

---

## Task 8 — /slist 过滤（`src/core/command-handler.ts:2946`）

```typescript
.filter(s => !s.threadId?.startsWith('trigger-'))
```
飞书真话题（已回填真实 thread_id，不以 `trigger-` 开头）正常显示。

---

## Task 9 — System Prompt 文案

更新触发器引导（grep `--session silent`）：
```
--session latest     （默认）触发时续接当前活跃会话
--session current    绑定到现在这个会话，定时接着干（切过去不切回）
--session thread     开一条独立话题线，多次触发累积上下文（AUN/飞书）
```

---

## Task 10 — 测试

1. **parser**：`current`/`thread` 解析；`silent` 报错；`--session` 与 `--thread` 互斥。
2. **handleTrigger**：`current` 无活跃会话报错；记 `boundSessionId`；`thread` 不支持渠道报错；`thread+aun` 合成 threadId；`thread+feishu` 无 messageId 报错；记 `rootMessageId+pendingThread`。
3. **buildSyntheticMessage**：三策略字段；`triggerMeta.silent` 已移除。
4. **Task 4b**：忙时不入队调 `scheduleRetryWhenIdle`；`task:completed` 触发补发；30s 兜底；用 `bound.projectPath` 入队；bound 被删取消补发；`done` flag 防重复。
5. **resolveSession current**：调 `switchToSession`（用 `bound.channel/channelId`）；bound 被删降级 latest；切 active 后 `isBackgroundSession` 返回 false。
6. **feishu 回填**：mock reply 返回 thread_id → `triggerManager.update` 调用；mock 230011 → `pendingThread` 清 false。
7. **并发安全**：current 触发器与同会话用户消息落同一队列（相同 sessionId + projectPath）。

---

## 构建顺序

```
Task 1 (types)
  ↓
Task 2 (parser) + Task 3 (capabilities)
  ↓
Task 4 (command-handler + message-bridge) + Task 5 (scheduler)
  ↓
Task 4b (fire 阶段 index.ts)
  ↓
Task 6 (message-processor) + Task 7 (feishu.sendMessage)
  ↓
Task 8 (/slist) + Task 9 (system prompt) + Task 10 (tests)
```

---

## 验证

```bash
npm run build   # 零错误（TS 类型改动会暴露漏填的 capabilities.thread）
npm test

# 端到端（手动）
# current: /trigger set --delay 1m --session current --prompt "报 sessionId"
#   → 触发后输出可见，active.json 指向 bound 会话；bound 会话忙时等完再执行
# thread+AUN: /trigger set --delay 1m --session thread --name t1 --prompt "报时"
#   → 两次触发同一 thread 会话
# thread+feishu: /trigger set --delay 1m --session thread --name t2 --prompt "话题报时"
#   → 首次建话题；第二次落进同一话题；root 消息撤回后降级普通消息
# silent 报错: /trigger set --delay 1m --session silent --prompt "x"  → ❌
```
