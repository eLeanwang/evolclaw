# PeerType、ChatMode 与 Show Activities 改进方案

> 日期：2026-07-09  
> 状态：Implemented  
> 背景：daily-morning-check trigger 在 daemon 执行时被错误判为 proactive，最终输出未进入 trigger reply，导致反馈被判为 noop。

## 目标

统一 peerType、chatMode 和中间输出控制的语义：

- `trigger` / `daemon` 不是 peerType，它们是触发器执行机制和本地通道。
- peerType 固定为 6 类：`human` / `agent` / `group` / `system` / `service` / `unknown`。
- `system` / `service` 表示本地系统任务或服务调用，应使用 `interactive` 并只交付最终结果。
- `agent` 对话继续使用 `proactive`，避免 agent-to-agent 普通文本互相唤醒。
- `show_activities` 只影响 `interactive` 下的中间输出，不影响 `proactive` 下的 `thought.put`。

## PeerType 定义

| peerType | 含义 | 默认 chatMode |
| --- | --- | --- |
| `human` | 人类对端 | `interactive` |
| `agent` | AUN agent 或其它可自主响应的 agent 对端 | `proactive` |
| `group` | 群聊场所或群聚合主体 | `proactive` |
| `system` | 系统内部事件、trigger 执行入口、调度器等 | `interactive` |
| `service` | 服务型对端、daemon 控制面、工具服务调用等 | `interactive` |
| `unknown` | 未能识别类型的对端 | 保守按 `proactive` 或按现有 nothuman 配置 |

`trigger_session` 运行在 daemon channel 内，但其 peerType 应是 `system` 或 `service`，不是 `trigger` 或 `daemon`。

## ChatMode 规则

chatMode 决策应先按 peerType 分类，再读取配置。推荐规则：

```ts
if (chatType === 'group') return 'proactive';
if (peerType === 'system' || peerType === 'service') return 'interactive';
if (peerType === 'agent') return configured.nothuman ?? 'proactive';
if (peerType === 'unknown') return configured.nothuman ?? 'proactive';
return configured.private ?? 'interactive';
```

需要把该规则抽成统一 helper，避免 `SessionManager` 和 `ResponseEngine` 各自实现后再次漂移。

## Show Activities 语义

将 `show_activities` 从二态扩展为三态：

```ts
type ShowActivitiesMode = 'all' | 'text' | 'none';
```

该配置只在 `interactive` 下生效。

| mode | 中间 `result.text(isFinal:false)` | `activity.batch` / AUN `type:"activity"` | 说明 |
| --- | --- | --- | --- |
| `all` | 发送 | 发送 | 当前完整中间输出体验 |
| `text` | 发送 | 不发送 | 只显示模型文字进展，不显示工具/进度/activity |
| `none` | 不发送 | 不发送 | 只显示最终结果 |

`proactive` 下忽略 `show_activities`。proactive 的 `activity.batch` 是 thought 投影主通道，应继续发送 `message.thought.put` / `group.thought.put`。

## System / Service 强制策略

对 `peerType=system` 或 `peerType=service`：

```ts
chatMode = 'interactive';
effectiveShowActivities = 'none';
```

这不是用户配置覆盖，而是运行时语义约束。原因：

- system/service 不是对话主体，不需要中间过程可见。
- trigger/daemon 需要可稳定收集最终结果，不能依赖 proactive thought。
- 中间 tool/activity/text 不应成为 trigger feedback 的内容。

## 出站协议规则

`result.text` 必须按 `isFinal` 区分：

| payload | 含义 |
| --- | --- |
| `result.text(isFinal:false)` | interactive 中间文本块 |
| `result.text(isFinal:true)` | 最终文本块 |
| `activity.batch` | 工具调用、工具结果、notice、progress 等中间活动 |
| `status.completed` | 任务完成状态，不承载正文 |

`show_activities=none` 下应压住所有中间 `result.text(isFinal:false)` 和 `activity.batch`，但保留最终 `result.text(isFinal:true)`、错误和终态 status。

## Final Text 兜底

运行时类型要求 `isFinal` 必填，但实际 payload 可能通过 `any` 或旧路径漏标。因此需要兜底：

- 记录最后一条被压住的中间 `result.text`。
- 记录是否已经发送过 `result.text(isFinal:true)`。
- 在任务完成时，如果 `show_activities=none` 且没有 final text，但存在最后一条 suppressed text，则将最后一条 suppressed text 补发为 final，并记录 warn。

伪代码：

```ts
if (payload.kind === 'result.text') {
  if (payload.isFinal === true) {
    hasFinalResultText = true;
    send(payload);
  } else if (middleOutputMode === 'none') {
    lastSuppressedResultText = payload.text;
    suppress(payload);
  } else {
    send(payload);
  }
}

onCompleted(() => {
  if (middleOutputMode === 'none' && !hasFinalResultText && lastSuppressedResultText?.trim()) {
    warn('missing final result.text; promoting last suppressed text to final');
    send({ kind: 'result.text', text: lastSuppressedResultText, isFinal: true });
  }
});
```

该兜底只应用于 `none`，避免 `all` / `text` 下重复发送用户已经看到过的中间文本。

## 实现计划

### 1. 类型与配置

- `ShowActivitiesMode` 增加 `text`。
- schema / validator / docs / CLI 帮助同步支持 `all|text|none`。
- 保持旧配置兼容：缺省仍为 `all`。

### 2. peerType 分类 helper

新增统一 helper：

```ts
type PeerKind = 'human' | 'agent' | 'group' | 'system' | 'service' | 'unknown';

function normalizePeerType(value: unknown): PeerKind;
function resolveChatModeForPeer(args): 'interactive' | 'proactive';
```

替换以下位置的重复逻辑：

- `SessionManager.resolveDefaultChatMode`
- `ResponseEngine` chatMode fallback
- `ResponseEngine.resolveEffectiveChatmodeForSession`
- slash/menu 中展示当前 chatmode 字段的逻辑

### 3. ChannelPolicy 三态化

当前 `showMiddleResult()` 是 boolean，不足以表达 `text`。新增可选接口：

```ts
middleOutputMode(chatType: string, identity: string, peerType?: string): ShowActivitiesMode;
```

兼容规则：

- 若 channel 实现 `middleOutputMode`，优先使用。
- 否则使用旧 `showMiddleResult()`：`true -> all`，`false -> none`。

### 4. ResponseEngine 输出开关

在 `ResponseEngine` 统一计算：

```ts
const middleOutputMode =
  chatMode === 'proactive'
    ? 'all' // proactive 不读取 show_activities，保留 thought
    : peerType === 'system' || peerType === 'service'
      ? 'none'
      : policy.middleOutputMode?.(...) ?? legacyMode;

const showIntermediateText = chatMode === 'interactive' && (middleOutputMode === 'all' || middleOutputMode === 'text');
const showActivityItems = chatMode === 'interactive' && middleOutputMode === 'all';
```

### 5. IMRenderer 拆分控制

把现有 `suppressActivities` 拆为：

```ts
suppressActivityItems: boolean;
suppressIntermediateText: boolean;
```

行为：

- `suppressActivityItems=true`：不发送 interactive `activity.batch`。
- `suppressIntermediateText=true`：不发送 `result.text(isFinal:false)`。
- `proactive` 路径不使用这两个开关，继续 `activity.batch -> thought.put`。

### 6. Daemon / trigger 验证

确保 `trigger_session` 创建 message 时 peerType 为 `system` 或 `service`，并走：

```ts
chatMode = interactive
middleOutputMode = none
```

daemon channel 不应再依赖 proactive thought 或用户发送命令来形成 trigger reply。

## 测试计划

| 测试 | 预期 |
| --- | --- |
| `peerType=system` 且 agent 配置 `nothuman=proactive` | 实际 chatMode 为 `interactive` |
| `peerType=service` 且 agent 配置 `nothuman=proactive` | 实际 chatMode 为 `interactive` |
| `peerType=agent` | 保持 `proactive` |
| `show_activities=all` interactive | 发送中间 text 和 activity |
| `show_activities=text` interactive | 发送中间 text，不发送 activity |
| `show_activities=none` interactive | 不发送中间 text 和 activity，只发送 final |
| proactive + `show_activities=none` | thought.put 不受影响 |
| final text 缺失兜底 | `none` 下将最后一条 suppressed text 提升为 final |
| daily-morning-check trigger | run status 为 success，feedback 包含早报正文，不再 noop |

## 风险与边界

- 不应把 `nothuman` 全部改为 interactive，否则 agent-to-agent 循环风险会回来。
- `unknown` 默认建议仍走 nothuman/proactive，除非后续有更强身份发现能力。
- `show_activities` 名称保留以兼容历史，但文档需说明它现在表示 interactive 中间输出可见性。
- final 兜底只能用于 `none`，否则会造成重复发送。

## 结论

该方案把三个概念拆清楚：

- peerType 描述对端类型。
- chatMode 描述响应通道模型。
- show_activities 描述 interactive 下的中间输出可见性。

`system/service -> interactive + none` 能解决 trigger/daemon 的最终结果收集问题；`agent/group -> proactive` 保留 thought 防循环能力；`show_activities=text` 提供只看文字进展、不看工具活动的中间层体验。
