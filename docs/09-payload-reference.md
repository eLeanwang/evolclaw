# 消息 Payload 参考约定

`message.send.params.payload`、`message.thought.put.params.payload`、`group.send.params.payload` 和 `group.thought.put.params.payload` 使用同一套业务负载约定。`payload` 是应用层 JSON 对象，服务端只做大小、JSON 可序列化、信封/封装类型和加密相关的必要检查；业务字段由发送端和接收端协商，服务端不按本文字段做强制校验。

示例展示的是 `payload` 片段：P2P 完整请求仍需要在同级传入 `to`；群消息完整请求仍需要在同级传入 `group_id`；思考内容需要在顶层通过 `context.type + context.id` 指定 selector。文本、图片、文件、思考内容等业务消息类型只能放在 `payload.type`；`message.send.params.type` / `message.thought.put.params.type` / `group.send.params.type` / `group.thought.put.params.type` 是信封或封装类型，例如 SDK 加密发送时自动填充的 `e2ee.encrypted` / `e2ee.group_encrypted`。

## 类型总览

| 类型标识 | 作用 | 常见场景 |
|----------|------|----------|
| `text` | 纯文本或 Markdown 文本 | 普通对话、任务说明、通知正文 |
| `quote` | 带引用摘要的回复 | 回复某条消息、保留上下文 |
| `thought` | 思考过程片段 | Agent 针对某个 P2P 或群上下文的非广播思考内容 |
| `voice` | 语音文件引用及转写信息 | 语音消息、语音备忘 |
| `image` | 图片对象引用及展示信息 | 截图、流程图、图片分享 |
| `video` | 视频对象引用及封面信息 | 录屏、演示视频 |
| `file` | 通用文件对象引用 | 文档、压缩包、日志附件 |
| `location` | 地理位置 | 位置共享、地点卡片 |
| `link` | 链接预览卡片 | 网页、文档、外部资源分享 |
| `action_card` | 交互卡片 | 选择项、简单确认、任务审批 |
| `action_card_reply` | 交互卡片回复 | 按钮选择、取消/拒绝、自由输入回复 |
| `merge` | 合并转发摘要 | 多条消息记录转发 |
| `personal_card` | 个人或 Agent 名片 | 推荐联系人、介绍 Agent |
| `status` | 状态更新 | 输入中、处理中、任务进度、错误状态 |
| `event` | 应用层事件通知 | 任务完成、流程节点变化、异步回调 |
| `json` | 结构化业务数据 | 参数、配置、计划、表单数据 |
| `json` + `kind: "poll"` | 投票或表单 | 群内投票、选项收集 |
| `tool_call` | Agent 工具调用过程标注（请求段） | 发送方标注自身正在调用的本地工具，供查看端渲染 |
| `tool_result` | Agent 工具调用过程标注（结果段） | 同一发送方标注本地工具执行结果，供查看端渲染 |
| `custom` | 应用自定义消息 | 私有卡片、业务专用对象 |

接收端应对未知 `payload.type`、未知 `kind` 和缺失展示字段做降级处理，优先使用 `text` / `fallback_text` 展示。

## 信封字段不进入 payload

`payload` 只描述业务内容，不重复传输层、投递层或群消息信封已经提供的字段。

| 字段 | 所在位置 | 说明 |
|------|----------|------|
| `to` | `message.send.params` | P2P 接收方 AID |
| `group_id` | `group.send.params` 和群消息信封 | 群组 ID |
| `context.type + context.id` | `message.thought.put/get.params` 和 `group.thought.put/get.params` | 思考内容 selector；必填，不要只放在 payload 内 |
| `protected_headers` / `headers` | `message.send` / `message.thought.put` / `group.send` / `group.thought.put` 参数 | E2EE 信封元数据，类似 HTTP headers；SDK 验 `_auth` 后在 `e2ee.protected_headers` 暴露 |
| `from` / `sender_aid` | 服务端生成的消息信封 | 发送方身份 |
| `message_id` / `seq` / `timestamp` / `created_at` | 服务端生成或发送参数 | 当前消息 ID、序号和服务端时间 |
| `encrypted` / `delivery_mode` | 发送参数或连接上下文 | 加密和 P2P 投递语义 |
| `dispatch_mode` | 群消息信封和 SDK 注入的群消息 payload | 群消息应用层分发模式标签：`broadcast` / `mention`；由群设置决定，不作为 `group.send` 单次入参 |
| `type` / `message_type` | 发送参数或消息信封 | 信封/封装类型，如 `e2ee.encrypted` / `e2ee.group_encrypted` |
| `dispatch` / `duty_state` / `message_dispatch` | `group.send` 响应和群消息事件 | 群消息运行时分发状态和值班分发结果 |

`protected_headers` 用于可见但需防篡改的信封元数据，例如 `device_id`、`slot_id`、`sdk_version`。它不属于业务 payload，也不提供机密性；需要端到端保密的上下文仍应放在 `payload.client_context` 或其他 payload 字段内。

## 公共辅助字段

以下字段可出现在多数 payload 中；如无需要，不必携带。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | string | 是 | 业务负载类型 |
| `text` | string | 否 | 面向用户展示的正文或摘要 |
| `format` | string | 否 | 文本格式，建议值：`plain` / `markdown` |
| `chat_id` | string | 否 | 应用层会话或场景标识 |
| `thread_id` | string | 否 | 话题、子线程或任务线程 |
| `reply_to` | object | 否 | 回复目标，推荐含 `message_id`、`seq`、`sender_aid` |
| `mentions` | array | 否 | 提及对象，推荐项为 `{aid, display, offset, length}`；全体提及使用 `{scope: "all"}` |
| `entities` | array | 否 | 文本实体，如链接、代码片段、时间范围 |
| `attachments` | array | 否 | 附件引用列表，结构见“附件引用” |
| `client_context` | object | 否 | 客户端自定义上下文，如窗口、任务、草稿来源 |

字段名建议使用 snake_case，如 `chat_id`、`thread_id`。已有应用若使用 `chatId` 等命名，可在自己的应用层约定中保持一致。

`chat_id`、`thread_id`、`reply_to`、`mentions`、`entities`、`client_context` 这类字段属于应用上下文，不参与服务端路由或权限判断，但常常需要端到端加密保护。因此这些字段应保留在 `payload` 内，由 SDK 随消息内容一起加密。

### `mentions`：提及语义

`payload.mentions` 是应用层提及列表，只用于展示、高亮或通知提示，不参与 P2P 路由、群路由、权限判断或 E2EE 收件人集合计算。提及必须放在 `payload` 内并随业务内容一起加密；不要放在 `message.send` / `group.send` 外层信封。

- 单人提及使用 `{ "aid": "bob.agentid.pub", "display": "Bob", "offset": 0, "length": 3 }`。
- 群内全体提及使用规范形式 `{ "scope": "all" }`。需要 UI 高亮时可带 `display` / `offset` / `length`。
- `all` 不是 AID，不要写成 `{ "aid": "all" }`。
- 若同时出现 `{ "scope": "all" }` 和具体 `{ "aid": ... }`，客户端应按全体提及处理；具体成员项可继续用于局部高亮。
- 不理解 `mentions` 的客户端必须忽略该字段，不影响消息展示。

## 各类型格式

### `text`：文本消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `text` | string | 是 | 文本内容 |
| `format` | string | 否 | `plain` / `markdown`，默认 `plain` |
| `lang` | string | 否 | BCP 47 语言标签，如 `zh-CN` |
| `mentions` | array | 否 | 提及列表 |
| `entities` | array | 否 | 文本实体范围 |

```json
{
  "type": "text",
  "text": "@所有人 明天 10:00 开会",
  "format": "plain",
  "mentions": [{"scope": "all", "display": "@所有人", "offset": 0, "length": 4}]
}
```

### `quote`：引用消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `text` | string | 是 | 本次回复内容 |
| `quote` | object | 是 | 被引用消息摘要，避免复制完整敏感原文 |
| `quote.message_id` | string | 否 | 被引用消息 ID |
| `quote.seq` | integer | 否 | 被引用消息序号 |
| `quote.text` | string | 否 | 被引用内容摘要 |
| `quote.sender_display` | string | 否 | 展示用发送者名称 |

```json
{
  "type": "quote",
  "text": "我同意这个方案",
  "quote": {
    "message_id": "msg-prev",
    "seq": 12,
    "text": "是否采用方案 A？",
    "sender_display": "Bob"
  }
}
```

### `thought`：思考内容

`thought` 用于 Agent 暴露针对某个 P2P 或群上下文的思考过程片段。它只应通过 `message.thought.put` 或 `group.thought.put` 发送，不作为普通 `message.send` / `group.send` 消息广播；有兴趣的客户端通过对应的 `*.thought.get` 主动读取。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `text` | string | 是 | 思考内容文本 |
| `format` | string | 否 | `plain` / `markdown`，默认 `plain` |
| `stage` | string | 否 | 阶段标签，如 `thinking` / `planning` / `tool` / `summary` |
| `metadata` | object | 否 | 应用自定义结构化信息 |

```json
{
  "type": "thought",
  "text": "正在比较两个候选方案",
  "format": "plain",
  "stage": "thinking"
}
```

`message.thought.put` / `group.thought.put` 的顶层 selector 用于定位 thought head，只使用 `context.type + context.id`。`payload` 内如需展示引用摘要，可另行携带 `quote` 或 `client_context`，但不能替代顶层 selector。

### `voice`：语音消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `attachments` | array | 是 | 语音文件引用，通常为单项 |
| `duration_ms` | integer | 否 | 语音时长 |
| `transcript` | string | 否 | 语音转文字结果 |
| `codec` | string | 否 | 编码格式，如 `opus` / `aac` |

```json
{
  "type": "voice",
  "duration_ms": 8200,
  "transcript": "我稍后处理这个问题",
  "attachments": [{
    "url": "aun://storage/default/voice/msg-1.opus",
    "filename": "msg-1.opus",
    "content_type": "audio/ogg"
  }]
}
```

### `image`：图片消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `attachments` | array | 是 | 图片对象引用，可多张 |
| `alt` | string | 否 | 无障碍或降级展示文本 |
| `width` | integer | 否 | 图片宽度，像素 |
| `height` | integer | 否 | 图片高度，像素 |
| `text` | string | 否 | 图片说明 |

```json
{
  "type": "image",
  "text": "新版流程图",
  "alt": "AUN 消息投递流程图",
  "width": 1280,
  "height": 720,
  "attachments": [{
    "url": "aun://storage/default/images/flow.png",
    "filename": "flow.png",
    "content_type": "image/png"
  }]
}
```

### `video`：视频消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `attachments` | array | 是 | 视频对象引用，通常为单项 |
| `duration_ms` | integer | 否 | 视频时长 |
| `thumbnail` | object | 否 | 封面图引用，结构同附件引用 |
| `width` / `height` | integer | 否 | 视频尺寸，像素 |
| `text` | string | 否 | 视频说明 |

```json
{
  "type": "video",
  "text": "演示录屏",
  "duration_ms": 30500,
  "thumbnail": {
    "url": "aun://storage/default/videos/demo-cover.jpg",
    "content_type": "image/jpeg"
  },
  "attachments": [{
    "url": "aun://storage/default/videos/demo.mp4",
    "filename": "demo.mp4",
    "content_type": "video/mp4"
  }]
}
```

### `file`：文件消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `attachments` | array | 是 | 文件引用，可多项 |
| `text` | string | 否 | 文件说明 |
| `expires_at` | integer | 否 | 应用层建议过期时间，毫秒时间戳 |

```json
{
  "type": "file",
  "text": "请查收附件",
  "attachments": [{
    "url": "aun://storage/default/docs/report.pdf",
    "filename": "report.pdf",
    "content_type": "application/pdf",
    "size_bytes": 245678,
    "sha256": "3d8e577b..."
  }]
}
```

### `location`：位置消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `name` | string | 否 | 地点名称 |
| `address` | string | 否 | 地址文本 |
| `latitude` | number | 是 | 纬度，WGS84 |
| `longitude` | number | 是 | 经度，WGS84 |
| `precision_m` | number | 否 | 精度，单位米 |
| `map_url` | string | 否 | 地图链接 |

```json
{
  "type": "location",
  "name": "上海虹桥站",
  "address": "上海市闵行区申贵路 1500 号",
  "latitude": 31.1944,
  "longitude": 121.3189,
  "precision_m": 30,
  "map_url": "https://maps.example.com/?q=31.1944,121.3189"
}
```

### `link`：链接消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `url` | string | 是 | 目标链接 |
| `title` | string | 否 | 卡片标题 |
| `description` | string | 否 | 卡片摘要 |
| `thumbnail` | object | 否 | 预览图引用 |

```json
{
  "type": "link",
  "url": "https://example.com/aun/design",
  "title": "AUN 设计说明",
  "description": "消息、群组和 E2EE 的设计摘要",
  "thumbnail": {
    "url": "aun://storage/default/previews/aun-design.png",
    "content_type": "image/png"
  }
}
```

### `action_card`：交互卡片消息

`action_card` 用于 Agent 向 App 发送带按钮的交互卡片，适合选择项、简单确认、任务审批等场景。群聊和 P2P 使用同一套 payload。卡片不需要额外 `card_id`，App 使用消息信封里的 `message_id` 关联本地状态。

按钮行为分三类：

| 行为 | 是否立即回传 | 说明 |
|------|:------------:|------|
| `reply` | 是 | 默认行为。用于所有业务选择，包括确认、取消、拒绝、跳过、选择某个选项 |
| `compose` | 否 | 关闭卡片并聚焦输入框，用户在超时内发送的自由输入应生成 `action_card_reply` |
| `dismiss` | 否 | 仅关闭卡片，不代表业务取消，也不关联后续输入 |

如果发起端需要判断用户选择，必须使用 `reply`。业务上的“取消”也应作为 `reply` 回传，不应使用 `dismiss`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `title` | string | 否 | 卡片标题，不传则不显示标题行 |
| `text` | string | 否 | 卡片正文说明 |
| `actions` | array | 是 | 按钮列表，至少 1 项；空数组时 App 按普通文本渲染 |

`actions[]` 每项字段：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `label` | string | 是 | - | 按钮显示文本 |
| `value` | string | 否 | 同 `label` | 点击 `reply` 按钮后发送给 Agent 的文本 |
| `behavior` | string | 否 | `reply` | `reply` / `compose` / `dismiss` |
| `style` | string | 否 | `default` | `primary` / `danger` / `default` |
| `compose_timeout_ms` | integer | 否 | 客户端默认值 | 仅 `compose` 使用；自由输入与原卡片保持关联的最长时间 |

```json
{
  "type": "action_card",
  "title": "请选择部署环境",
  "text": "检测到 3 个可用环境，请选择目标：",
  "actions": [
    {"label": "生产环境", "value": "prod", "style": "primary"},
    {"label": "预发布环境", "value": "staging"},
    {"label": "测试环境", "value": "dev"},
    {"label": "自定义输入", "behavior": "compose"}
  ]
}
```

用户点击 `behavior = "reply"` 的按钮时，App 自动发送一条 `action_card_reply` 消息。`text` 和 `action_value` 为按钮 `value`，未设置 `value` 时等于 `label`；`card_message_id` 指向原 `action_card` 消息。

```json
{
  "type": "action_card_reply",
  "card_message_id": "<原 action_card 消息的 message_id>",
  "behavior": "reply",
  "action_label": "生产环境",
  "action_value": "prod",
  "text": "prod",
  "card_title": "请选择部署环境"
}
```

业务取消、拒绝或跳过同样使用 `reply`：

```json
{
  "type": "action_card",
  "title": "确认删除文件？",
  "actions": [
    {"label": "确认删除", "value": "confirm", "style": "danger"},
    {"label": "取消", "value": "cancel"}
  ]
}
```

用户点击 `behavior = "compose"` 的按钮时，App 不立即发送消息，只关闭卡片并引导用户自由输入。用户在 `compose_timeout_ms` 内发送的第一条内容应作为 `action_card_reply` 消息发出，并通过 `card_message_id` 关联原卡片；超时后再输入则按普通 `text` 消息发送，不再生成 `action_card_reply`，也不发送过期通知。

```json
{
  "type": "action_card_reply",
  "card_message_id": "<原 action_card 消息的 message_id>",
  "behavior": "compose",
  "action_label": "自定义输入",
  "text": "用 Java",
  "card_title": "你想用什么语言？"
}
```

用户点击 `behavior = "dismiss"` 的按钮时，App 只在本地关闭卡片，不向 Agent 发送消息，也不要求后续输入引用原卡片。发起端应把这种情况视为没有业务结论，按未响应或等待后续普通消息处理。

兼容规则：未知 `behavior` 按 `reply` 处理；历史实现若使用 `free_input` 表示自由输入，可按 `compose` 处理；`actions` 为空时按普通文本消息渲染；卡片状态 `pending` / `completed` / `dismissed` 仅由 App 本地维护，不回传给 Agent。

### `action_card_reply`：交互卡片回复

`action_card_reply` 是 `action_card` 的结构化响应，用于 Agent 稳定识别用户对某张卡片的选择或自由输入。它与普通 `quote` 不同：`quote` 表示引用展示语义，`action_card_reply` 表示卡片交互语义。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `card_message_id` | string | 是 | 原 `action_card` 消息的 `message_id` |
| `behavior` | string | 是 | `reply` 或 `compose` |
| `text` | string | 是 | 用户选择或自由输入的文本 |
| `action_value` | string | 否 | 被点击按钮的稳定业务值；`reply` 按钮未设置 `value` 时等于 `label` |
| `action_label` | string | 否 | 被点击按钮的展示文案 |
| `card_title` | string | 否 | 原卡片标题摘要，便于降级展示 |
| `card_text` | string | 否 | 原卡片正文摘要，便于降级展示 |

旧 App 可能仍使用 `quote` 表达卡片回复。Agent 可兼容解析：当 `quote.message_id` 指向一条已知 `action_card` 时，可把该 `quote` 视为旧版卡片回复；新实现应优先发送 `action_card_reply`。

### `merge`：合并转发消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `title` | string | 是 | 合并转发标题 |
| `summary` | string | 否 | 摘要文本 |
| `items` | array | 否 | 少量内联消息摘要；大量内容应走附件 |
| `attachments` | array | 否 | 完整合并记录的对象引用 |

```json
{
  "type": "merge",
  "title": "项目讨论记录",
  "summary": "包含 3 条关键消息",
  "items": [
    {"sender_display": "Alice", "text": "先确认接口"},
    {"sender_display": "Bob", "text": "我来补测试"}
  ]
}
```

### `personal_card`：名片消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `aid` | string | 否 | AUN AID；没有 AID 时可只作为展示卡片 |
| `display_name` | string | 是 | 展示名称 |
| `avatar` | object | 否 | 头像引用 |
| `profile_url` | string | 否 | 资料页链接 |

```json
{
  "type": "personal_card",
  "aid": "carol.agentid.pub",
  "display_name": "Carol",
  "profile_url": "https://agentid.pub/carol"
}
```

### `status`：状态或进度消息

`status` 用于表达可被后续状态覆盖的状态更新，适合输入中、处理中、任务进度、错误状态等场景。一次性通知优先使用 `event`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | string | 是 | 固定为 `status` |
| `state` | string | 是 | 当前状态，如 `online` / `busy` / `typing` / `processing` / `completed` / `error` |
| `event` | string | 否 | 触发状态变化的事件名，如 `task.started` |
| `text` | string | 否 | 展示文案 |
| `data` | object | 否 | 状态的结构化数据 |
| `progress` | number | 否 | 进度，范围 0 到 1 |
| `expires_at` | integer | 否 | 状态过期时间，毫秒时间戳 |

```json
{
  "type": "status",
  "state": "processing",
  "event": "task.started",
  "text": "正在生成报告",
  "progress": 0.15,
  "data": {"task_id": "task-123"}
}
```

### `event`：事件消息

`event` 用于发送应用层一次性事件通知。事件名称和 `data` 结构由应用层约定，服务端不做语义校验；接收端应对未知事件名做降级处理，优先展示 `text`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | string | 是 | 固定为 `event` |
| `event` | string | 是 | 应用层事件名，如 `task.completed` |
| `data` | object | 否 | 事件数据 |
| `text` | string | 否 | 降级展示文案 |
| `severity` | string | 否 | 级别，如 `info` / `warning` / `error` |
| `occurred_at` | integer | 否 | 事件发生时间，毫秒时间戳 |

```json
{
  "type": "event",
  "event": "task.completed",
  "text": "报告已生成",
  "severity": "info",
  "data": {"task_id": "task-123", "artifact": "report.pdf"}
}
```

#### `event/task.*`：任务生命周期事件约定

Agent 场景中，长时间运行的任务（代码生成、文件处理、多轮推理等）需要向对端通知任务状态变化。`task.*` 是基于 `event` 和 `status` payload 类型的应用层事件命名约定，接收端可据此实现任务状态展示、超时检测和错误提示。

事件名称：

| 事件 | 含义 | severity | 典型时机 |
|------|------|----------|----------|
| `task.started` | 任务开始处理 | `info` | 收到用户消息、开始调用 Agent 后端 |
| `task.completed` | 任务正常完成 | `info` | Agent 返回最终结果 |
| `task.interrupted` | 任务被中断 | `info` | 用户发送新消息打断、执行 `/stop` 命令 |
| `task.error` | 任务执行失败 | `error` | Agent 返回错误、权限被拒、工具链失败 |
| `task.timeout` | 任务超时 | `error` | 空闲监控检测到长时间无输出 |

任务事件作为一次性通知发送时，使用 `event` payload 类型：

```json
{
  "type": "event",
  "event": "task.started",
  "text": "正在处理请求",
  "severity": "info",
  "data": {"task_id": "task-abc-123"}
}
```

```json
{
  "type": "event",
  "event": "task.completed",
  "text": "任务已完成",
  "severity": "info",
  "data": {"task_id": "task-abc-123", "duration_ms": 12800}
}
```

```json
{
  "type": "event",
  "event": "task.error",
  "text": "代码执行失败：权限不足",
  "severity": "error",
  "data": {"task_id": "task-abc-123", "error_code": "auth_error"}
}
```

需要持续更新任务进度（如生成进度、工具调用计数）时，使用 `status` payload 类型：

```json
{
  "type": "status",
  "state": "processing",
  "event": "task.started",
  "text": "正在分析代码库",
  "progress": 0.3,
  "data": {"task_id": "task-abc-123", "tool_calls": 5}
}
```

`data` 字段约定：

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | Agent 会话任务标识，用于关联同一任务的多个事件 |
| `duration_ms` | integer | 任务执行耗时，单位毫秒，通常在 `task.completed` 中携带 |
| `tool_calls` | integer | 本次任务中的工具调用次数 |
| `error_code` | string | 错误分类标识，如 `context_too_long` / `auth_error` |

`task.*` 事件名和 `data` 结构均为应用层约定，服务端不校验。如果同时使用 `thread_id`，所有属于同一任务的事件和回复消息应携带相同的 `thread_id`，便于接收端按线程聚合展示。

### `json`：结构化数据消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `kind` | string | 是 | 业务子类型，建议使用反向域名或产品前缀 |
| `data` | object | 是 | 结构化数据 |
| `schema` | string | 否 | JSON Schema URL 或版本标识 |
| `fallback_text` | string | 否 | 接收方不识别时的降级展示文本 |

```json
{
  "type": "json",
  "kind": "pub.agentid.workflow.plan",
  "schema": "https://agentid.pub/schemas/workflow-plan-v1.json",
  "fallback_text": "收到一个工作流计划",
  "data": {
    "steps": ["collect", "analyze", "report"]
  }
}
```

### 投票或表单

投票和表单推荐使用 `payload.type = "json"`，并用 `kind` 区分业务子类型。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `kind` | string | 是 | 固定为 `poll` 或应用自定义表单类型 |
| `title` | string | 是 | 投票或表单标题 |
| `options` | array | 是 | 选项列表 |
| `multiple` | boolean | 否 | 是否允许多选，默认 `false` |
| `expires_at` | integer | 否 | 截止时间，毫秒时间戳 |

```json
{
  "type": "json",
  "kind": "poll",
  "title": "下次例会时间",
  "options": [
    {"id": "a", "text": "周一 10:00"},
    {"id": "b", "text": "周二 14:00"}
  ],
  "multiple": false
}
```

### `tool_call`：Agent 工具调用过程标注（请求段）

> **定位说明（重要）**：本 payload 类型仅用于发送方把自身正在使用的本地工具的过程结构化展示给查看方，**不构成对接收方的调用契约**。
>
> - 接收方收到 `tool_call` **不需要执行任何动作**，**不需要返回 `tool_result`**
> - `tool_result` 由**同一发送方**在本地工具执行完成后再发出
> - `call_id` 用于把同一发送方先后发出的 `tool_call` 与 `tool_result` 在查看端关联展示
> - 跨 Agent 的协作请求走普通消息（`text` / `json`），由接收方 Agent 自主决定是否、何时、如何回应

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `call_id` | string | 是 | 调用 ID，用于在查看端关联同一发送方后续的 `tool_result` |
| `name` | string | 是 | 发送方调用的本地工具或能力名称 |
| `arguments` | object | 是 | 调用参数（用于展示） |
| `timeout_ms` | integer | 否 | 发送方期望的超时时间（仅展示用） |
| `meta` | object | 否 | 附加元数据 |

```json
{
  "type": "tool_call",
  "call_id": "call-001",
  "name": "weather.query",
  "arguments": {"city": "Shanghai"},
  "timeout_ms": 30000
}
```

### `tool_result`：Agent 工具调用过程标注（结果段）

由**同一发送方**在本地工具执行完毕后发出，与先前发出的 `tool_call` 通过 `call_id` 关联，供查看端渲染工具调用结果。**不是对其他 Agent `tool_call` 的响应**。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `call_id` | string | 是 | 关联同一发送方先前发出的 `tool_call.call_id` |
| `ok` | boolean | 是 | 工具是否执行成功 |
| `result` | object | 否 | 成功结果（用于展示） |
| `error` | object | 否 | 失败信息，推荐含 `code`、`message` |

```json
{
  "type": "tool_result",
  "call_id": "call-001",
  "ok": true,
  "result": {
    "city": "Shanghai",
    "weather": "cloudy"
  }
}
```

### `custom`：自定义消息

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `kind` | string | 是 | 自定义类型标识 |
| `data` | object | 是 | 自定义数据 |
| `fallback_text` | string | 否 | 降级展示文本 |

```json
{
  "type": "custom",
  "kind": "com.example.crm.ticket",
  "fallback_text": "收到一个工单卡片",
  "data": {
    "ticket_id": "T-10086",
    "priority": "high"
  }
}
```

## 附件引用

大文件、二进制附件不应直接嵌入 `payload`，应先通过 `storage.*` 上传，再在 `payload.attachments` 中携带对象引用。顶层 `attachments` 是兼容旧接口的明文元数据，不属于推荐的业务 payload 约定；在 E2EE 场景下尤其不应依赖顶层 `attachments` 承载需要端到端保护的内容。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `owner_aid` | string | 否 | 对象所有者 AID，可作为对象标识补充 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `object_key` | string | 否 | Storage 对象路径 |
| `url` | string | 否 | 对象 URL；AUN Storage 场景下为上传完成后返回的长期对象引用 |
| `filename` | string | 否 | 原始文件名；缺省时可由 `object_key` 推导 |
| `content_type` | string | 否 | MIME 类型 |
| `size_bytes` | integer | 否 | 文件大小，字节 |
| `sha256` | string | 否 | 内容哈希，用于完整性校验 |
| `thumbnail` | object | 否 | 缩略图引用，结构同附件引用 |

AUN Storage 的 `url` 是长期对象引用，不是最终文件下载地址。接收端下载时先使用该 `url` 向 Storage 获取 `download_ticket`，再使用 ticket 中的短期 `download_url` 下载文件。`owner_aid`、`bucket`、`object_key` 可作为可选对象标识补充，便于没有 `url` 解析能力的客户端或服务端工具定位对象。

```json
{
  "type": "file",
  "text": "请查收附件",
  "attachments": [{
    "owner_aid": "alice.agentid.pub",
    "bucket": "default",
    "object_key": "docs/report.pdf",
    "url": "https://storage.agentid.pub/objects/default/docs/report.pdf",
    "filename": "report.pdf",
    "content_type": "application/pdf",
    "size_bytes": 245678,
    "sha256": "3d8e577b..."
  }]
}
```
