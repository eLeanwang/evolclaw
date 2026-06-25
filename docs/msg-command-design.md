# 消息命令集设计文档

## 一、命令总览

两个顶级命令：`evolclaw msg`（P2P 消息）和 `evolclaw group`（群组操作），底层模块在同一文件夹。

---

## 二、通用选项

所有 msg/group 子命令均支持：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--format json` | 否 | 输出 JSON 格式 |
| `--app <name>` | 空字符串 | SDK connect 的 `slot_id`，隔离外部应用的 ack 游标 |

JSON 输出约定：
- 成功：`{ "ok": true, ...data }`
- 失败：`{ "ok": false, "error": "<message>" }`

### 连接模式

CLI 命令**永远短连接**。短连接下网关不主动推送 event，不会抢走 daemon 的消息推送序列。

无 `--long-connection` 选项——CLI 是一次性命令，不需要长连。

### `--app` 与 ack 安全

| 命令类型 | 不传 `--app` | 行为 |
|---|---|---|
| `msg send` / `recall` / `online` | 允许 | slot 不参与发送逻辑 |
| `msg pull` | 允许 + 警告 | 提示"建议传 --app 避免与 daemon 游标耦合" |
| `msg ack` | **拒绝** | 报错"ack 必须传 --app，否则会污染 daemon 游标" |
| `group send` / `pull` / `ack` | 同上规则 | 群消息同理 |

理由：daemon 当前用空 slot。CLI 默认也是空 slot → 共享 ack 游标。`ack` 推进游标会导致 daemon 丢消息。

如需操作 daemon 游标，提供 `--as-daemon` 显式开关（高危标记）。

---

## 三、P2P 消息命令（`evolclaw msg`）

参数位置约定：`<动词> <发送者-aid> <接收者/对象> [载荷] [选项]`

### 命令列表

| 命令 | 说明 | 状态 |
|---|---|---|
| `msg send <aid> <to> <text>` | 发送文本消息 | ❌ 缺 |
| `msg send <aid> <to> --file <path> [--as <type>]` | 发送文件消息 | ❌ 缺 |
| `msg send <aid> <to> --payload <json>` | 发送自定义 payload | ❌ 缺 |
| `msg send <aid> <to> --link <url> [--title T]` | 发送链接卡片 | ❌ 缺 |
| `msg pull <aid> [--after-seq N] [--limit N]` | 拉取收件箱消息 | ❌ 缺 |
| `msg ack <aid> <seq> --app <name>` | 确认消息已读 | ❌ 缺 |
| `msg recall <aid> <message-id...>` | 撤回消息 | ❌ 缺 |
| `msg online <aid> <target-aid...>` | 查询在线状态 | ❌ 缺 |

### 命令示例

```bash
# 发送文本
evolclaw msg send alice.agentid.pub bob.agentid.pub "hello bob"

# 发送图片（显式标记渲染类型）
evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./screenshot.png --as image

# 发送图片（自动推断：.png → image）
evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./screenshot.png

# 发送视频
evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./demo.mp4 --as video

# 发送语音（带转写）
evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./msg.opus --as voice --transcript "下午好"

# 发送通用文件（带说明）
evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./report.pdf --text "请查收附件"

# 发送链接卡片
evolclaw msg send alice.agentid.pub bob.agentid.pub --link https://example.com --title "AUN 设计"

# 发送自定义 payload
evolclaw msg send alice.agentid.pub bob.agentid.pub --payload '{"type":"json","kind":"task.assign","data":{"task_id":"t-001"}}'

# 拉取消息（从头）
evolclaw msg pull alice.agentid.pub --app my-bot

# 拉取消息（增量，从 seq=42 之后）
evolclaw msg pull alice.agentid.pub --after-seq 42 --limit 50 --app my-bot

# 确认到 seq=50
evolclaw msg ack alice.agentid.pub 50 --app my-bot

# 撤回消息
evolclaw msg recall alice.agentid.pub msg-uuid-1 msg-uuid-2

# 查询在线状态
evolclaw msg online alice.agentid.pub bob.agentid.pub charlie.agentid.pub
```

### `msg send --file` 渲染类型

`--as <type>` 标记 payload.type，决定接收端渲染方式：

| `--as` 值 | payload.type | 额外可选参数 |
|---|---|---|
| `image` | `image` | `--text`（说明） |
| `video` | `video` | `--text` |
| `voice` | `voice` | `--transcript <text>` |
| `file`（默认） | `file` | `--text` |

**自动推断规则**（不传 `--as` 时按扩展名）：
- `.png/.jpg/.jpeg/.gif/.webp/.svg` → `image`
- `.mp4/.mov/.webm/.avi` → `video`
- `.opus/.mp3/.aac/.m4a/.wav` → `voice`
- 其他 → `file`

可用 `--content-type <mime>` 显式覆盖 MIME（默认从扩展名推断）。

### `msg send --file` 流程

1. 调用 `storage.upload` 上传文件到发送者的 storage
2. 根据 `--as` 或自动推断确定 payload.type
3. 构造 payload（含 attachments 引用）
4. 调用 `message.send` 发送

### `msg pull` 游标策略

CLI **不维护本地游标**。每次 `msg pull` 默认 `after_seq=0`，用户显式传 `--after-seq`。

输出含 `latest_seq`，用户自己记下传给下次调用。JSON 输出可直接 `jq .latest_seq` 取值。

理由：
- AUN 协议明确"客户端自管游标"
- daemon 的游标在服务端，CLI 维护本地游标会不一致
- 简单、无隐式状、符合 Unix CLI 管道习惯

---

## 四、群组命令（`evolclaw group`）

参数位置约定：`<动词> <发送者-aid> <group-id> [载荷] [选项]`

### 命令列表

#### 消息

| 命令 | 说明 | 状态 |
|---|---|---|
| `group send <aid> <group-id> <text>` | 发送群文本 | ❌ 缺 |
| `group send <aid> <group-id> --file <path> [--as <type>]` | 发送群文件 | ❌ 缺 |
| `group send <aid> <group-id> --payload <json>` | 发送自定义 payload | ❌ 缺 |
| `group pull <aid> <group-id> [--after-seq N]` | 拉取群消息 | ❌ 缺 |
| `group ack <aid> <group-id> <seq> --app <name>` | 确认群消息已读 | ❌ 缺 |

#### 群生命周期

| 命令 | 说明 | 状态 |
|---|---|---|
| `group create <aid> <name> [--visibility public\|private]` | 创建群 | ❌ 缺 |
| `group list <aid>` | 列出我的群 | ❌ 缺 |
| `group info <aid> <group-id>` | 查看群详情 | ❌ 缺 |
| `group update <aid> <group-id> --name <n> \| --desc <d>` | 修改群信息 | ❌ 缺 |
| `group dissolve <aid> <group-id>` | 解散群 | ❌ 缺 |

#### 成员管理

| 命令 | 说明 | 状态 |
|---|---|---|
| `group join <aid> <group-id>` | 申请加入 | ❌ 缺 |
| `group leave <aid> <group-id>` | 退出群 | ❌ 缺 |
| `group invite <aid> <group-id> <member-aid...>` | 邀请成员 | ❌ 缺 |
| `group kick <aid> <group-id> <member-aid>` | 踢出成员 | ❌ 缺 |
| `group members <aid> <group-id>` | 列出群成员 | ❌ 缺 |
| `group online <aid> <group-id>` | 查看群在线成员 | ❌ 缺 |

### 命令示例

```bash
# 发送群文本
evolclaw group send alice.agentid.pub g-dev.agentid.pub "晚上 8 点开会"

# 发送群文本（带 @mention）
evolclaw group send alice.agentid.pub g-dev.agentid.pub "@bob 看下 PR" \
  --mention bob.agentid.pub

# 发送群文件
evolclaw group send alice.agentid.pub g-dev.agentid.pub --file ./arch.png --as image

# 拉取群消息
evolclaw group pull alice.agentid.pub g-dev.agentid.pub --after-seq 0 --app my-bot

# 确认群消息
evolclaw group ack alice.agentid.pub g-dev.agentid.pub 120 --app my-bot

# 创建群
evolclaw group create alice.agentid.pub "Dev Team" --visibility private

# 列出我的群
evolclaw group list alice.agentid.pub

# 群详情
evolclaw group info alice.agentid.pub g-dev.agentid.pub

# 群成员
evolclaw group members alice.agentid.pub g-dev.agentid.pub

# 邀请
evolclaw group invite alice.agentid.pub g-dev.agentid.pub bob.agentid.pub carol.agentid.pub

# 踢人
evolclaw group kick alice.agentid.pub g-dev.agentid.pub bob.agentid.pub

# 退群
evolclaw group leave alice.agentid.pub g-dev.agentid.pub

# 解散群
evolclaw group dissolve alice.agentid.pub g-dev.agentid.pub
```

---

## 五、代码目录结构

### 目标结构

```
src/
├── msg/
│   ├── index.ts       # 统一 re-export
│   ├── p2p.ts         # msgSend / msgPull / msgAck / msgRecall / msgOnline
│   └── group.ts       # groupSend / groupPull / groupAck / groupCreate / groupList / ...
└── cli.ts             # cmdMsg() + cmdGroup() 两个薄壳
```

### 与 aid/storage/rpc 对齐的机制约定

#### 模块层（`src/msg/p2p.ts`、`src/msg/group.ts`）

| 约定 | 说明 |
|---|---|
| 纯业务逻辑 | 不做 `console.log`、不调 `process.exit` |
| 结构化入参 | 函数接收具名参数对象，不接收 raw `args: string[]` |
| 结构化返回 | 返回 typed 数据对象，成功 `{ ok: true, ...data }`，失败 `{ ok: false, error }` |
| 类型导出 | 在模块文件顶部定义并 export 所有返回类型接口 |
| 短连接 | 所有操作通过 `createShortConnection` 完成，connect 时传入 `slot_id`（即 `--app` 值） |

#### cli 薄壳层

| 约定 | 说明 |
|---|---|
| 两个入口 | `cmdMsg(args: string[])` 和 `cmdGroup(args: string[])` |
| 通用选项解析 | 开头统一解析 `--format json`、`--app` |
| help 子命令 | `sub === 'help'` 打印完整用法 |
| 动态导入 | `await import('./msg/index.js')` |
| 参数校验 | cli 层做基本校验（缺参数、无效 AID），失败 `process.exit(1)` |
| ack 安全检查 | `msg ack` / `group ack` 不传 `--app` 时拒绝执行 |
| 输出分支 | `if (formatJson) { JSON } else { 人类友好 }` |

#### 对比参照

```typescript
// storage 模块模式（已有）
const { storageUpload } = await import('./storage/index.js');
const result = await storageUpload(aid, localFile, remotePath, { isPublic, aunPath });

// msg 模块模式（目标，完全一致）
const { msgSend } = await import('./msg/index.js');
const result = await msgSend({
  from: aid,
  to: targetAid,
  payload: { type: 'text', text },
  app: appSlot,
});
```

---

## 六、类型定义

```typescript
// --- P2P ---

export interface MsgSendResult {
  ok: true;
  message_id: string;
  seq: number;
  timestamp: number;
}

export interface MsgPullResult {
  ok: true;
  messages: MsgItem[];
  count: number;
  latest_seq: number;
  ephemeral_earliest_available_seq: number | null;
  ephemeral_dropped_count: number;
}

export interface MsgItem {
  message_id: string;
  seq: number;
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, unknown>;
  delivery_mode: string;
}

export interface MsgAckResult {
  ok: true;
  ack_seq: number;
}

export interface MsgRecallResult {
  ok: true;
  accepted: number;
  recalled: number;
  errors: Array<{ message_id: string; error: string }> | null;
}

export interface MsgOnlineResult {
  ok: true;
  online: Record<string, boolean>;
}

// --- Group ---

export interface GroupSendResult {
  ok: true;
  message_id: string;
  seq: number;
}

export interface GroupPullResult {
  ok: true;
  messages: GroupMsgItem[];
  count: number;
  latest_seq: number;
}

export interface GroupMsgItem {
  message_id: string;
  seq: number;
  sender_aid: string;
  group_id: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface GroupCreateResult {
  ok: true;
  group_id: string;
  name: string;
}

export interface GroupInfoResult {
  ok: true;
  group_id: string;
  name: string;
  owner_aid: string;
  visibility: string;
  status: string;
  member_count: number;
  message_seq: number;
  created_at: number;
}

export interface GroupListResult {
  ok: true;
  groups: GroupInfoResult[];
}

export interface GroupMembersResult {
  ok: true;
  members: Array<{ aid: string; role: string; joined_at: number }>;
}

export interface MsgError {
  ok: false;
  error: string;
}
```

---

## 七、实现状态评估（代码审查结果）

审查 `src/channels/aun.ts`、`src/aun-rpc/`、`src/storage/` 后，整理各命令的实现状态。

### 7.1 命令实现状态总表

| 命令 | 底层 RPC | 现有实现位置 | 状态 | 备注 |
|---|---|---|---|---|
| **P2P 消息** | | | | |
| `msg send <text>` | `message.send` | `channels/aun.ts:1567` (sendText) + `aun-rpc/caller.ts` (rpcCall) | 🟡 可迁移 | daemon 长连接里有完整实现；`rpcCall` 已能发任意 RPC，只需封装参数 |
| `msg send --file` | `storage.upload` + `message.send` | `channels/aun.ts:1653-1810` (sendFile + deliverFileEntry) + `storage/upload.ts` | 🟡 可迁移 | 文件上传（小文件 put_object / 大文件 create_upload_session）+ 构造 file payload + message.send 全流程已有；需从 channel 类解耦 |
| `msg send --payload` | `message.send` | `aun-rpc/caller.ts` (rpcCall) | 🟢 直接用 | 只需 `rpcCall(aid, 'message.send', { to, payload })` |
| `msg send --link` | `message.send` | 无 | ❌ 新写 | 构造 `{type:"link", url, title}` payload，发送逻辑同上 |
| `msg pull` | `message.pull` | 无 | ❌ 新写 | `rpcCall(aid, 'message.pull', { after_seq, limit })` |
| `msg ack` | `message.ack` | `channels/aun.ts:286`（仅 daemon 自动 ack） | ❌ 新写 | daemon 的 ack 是自动的，CLI 需独立实现 + `--app` 强制检查 |
| `msg recall` | `message.recall` | 无 | ❌ 新写 | `rpcCall(aid, 'message.recall', { message_ids })` |
| `msg online` | `message.query_online` | 无 | ❌ 新写 | `rpcCall(aid, 'message.query_online', { aids })` |
| **群组消息** | | | | |
| `group send <text>` | `group.send` | `channels/aun.ts:1552` (sendText 群分支) | 🟡 可迁移 | daemon 里有完整实现，需解耦 |
| `group send --file` | `storage.upload` + `group.send` | `channels/aun.ts:1767` (deliverFileEntry 群分支) | 🟡 可迁移 | 同 P2P 文件，最后调 `group.send` |
| `group pull` | `group.pull` | 无 | ❌ 新写 | `rpcCall(aid, 'group.pull', { group_id, after_seq, limit })` |
| `group ack` | `group.ack` | 无 | ❌ 新写 | `rpcCall(aid, 'group.ack', { group_id, seq })` |
| **群生命周期** | | | | |
| `group create` | `group.create` | 无 | ❌ 新写 | 直通 RPC |
| `group list` | `group.list_my` | 无 | ❌ 新写 | 直通 RPC |
| `group info` | `group.get` | 无 | ❌ 新写 | 直通 RPC |
| `group update` | `group.update` | 无 | ❌ 新写 | 直通 RPC |
| `group dissolve` | `group.dissolve` | 无 | ❌ 新写 | 直通 RPC |
| **群成员管理** | | | | |
| `group join` | `group.request_join` | 无 | ❌ 新写 | 直通 RPC |
| `group leave` | `group.leave` | 无 | ❌ 新写 | 直通 RPC |
| `group invite` | `group.add_member` | 无 | ❌ 新写 | 直通 RPC |
| `group kick` | `group.kick` | 无 | ❌ 新写 | 直通 RPC |
| `group members` | `group.get_members` | 无 | ❌ 新写 | 直通 RPC |
| `group online` | `group.get_online_members` | 无 | ❌ 新写 | 直通 RPC |

### 7.2 基础设施改造清单

| 组件 | 现状 | 需要做的 |
|---|---|---|
| `createShortConnection`（`aun-rpc/connection.ts`） | 不传 `slot_id`，无 delivery_mode 控制 | 加 `opts.slotId` 参数，connect 时透传 `slot_id`；CLI 短连接默认不接收推送 |
| `rpcCall`（`aun-rpc/caller.ts`） | 透传 `aunPath`，不传 slot | 加 `opts.slotId` 透传给 `createShortConnection` |
| `guessMime`（`channels/aun.ts:18`） | channel 私有函数 | 提取到公共 utils（`src/msg/mime.ts` 或 `src/utils/mime.ts`），msg 模块也需要 |
| 文件上传逻辑（`channels/aun.ts:1692` deliverFileEntry） | 耦合 channel 实例（依赖 this.client、outbox、E2EE fallback 等） | 提取为独立函数（接收 connection + filePath + 渲染类型，返回 attachment 对象）放到 `src/msg/upload.ts` |
| payload 类型推断 | 无 | 新写（`src/msg/payload-type.ts`）：扩展名 → payload.type 映射 |

### 7.3 工作量统计

| 分类 | 🟢 直接可用 | 🟡 可迁移/解耦 | ❌ 新写 |
|---|---|---|---|
| P2P 消息（8 命令） | 1 | 2 | 5 |
| 群消息（4 命令） | 0 | 2 | 2 |
| 群生命周期（5 命令） | 0 | 0 | 5 |
| 群成员（6 命令） | 0 | 0 | 6 |
| 基础设施（5 项） | 0 | 2 | 3 |
| **合计** | **1** | **6** | **21** |

"可迁移"意味着核心逻辑在 `channels/aun.ts` 跑通了——主要工作是解耦。"新写"绝大多数是直通 RPC（一行 `rpcCall` + 参数/结果类型定义），模式统一，工作量不大。

---

## 八、实现路线图

### Phase 0：基础设施改造（前置）

实现 P2P/Group 命令前必须完成的底层改造：

1. `createShortConnection` 支持 `slotId` 参数
2. `rpcCall` 透传 `slotId`
3. 提取 `guessMime` 到公共 utils
4. 提取文件上传流程到 `src/msg/upload.ts`（输入：connection + filePath + 渲染类型；输出：attachment 对象）
5. 新写 `src/msg/payload-type.ts`：扩展名 → payload.type 推断

### Phase 1：P2P 基础命令

1. 创建 `src/msg/` 目录 + `index.ts` + `p2p.ts`
2. 实现 `msgSend`（文本 + 文件 + payload + link）
3. 实现 `msgPull` + `msgAck`
4. 实现 `msgRecall` + `msgOnline`
5. cli.ts 加 `cmdMsg` 薄壳 + 注册顶级命令

### Phase 2：Group 基础命令

1. 创建 `src/msg/group.ts`
2. 实现 `groupSend` + `groupPull` + `groupAck`
3. 实现 `groupCreate` + `groupList` + `groupInfo`
4. 实现 `groupJoin` + `groupLeave` + `groupInvite` + `groupKick` + `groupMembers`
5. cli.ts 加 `cmdGroup` 薄壳 + 注册顶级命令

### Phase 3：文件发送增强

1. `--file` 自动推断渲染类型（扩展名 → payload.type）
2. `--as` 显式覆盖
3. `--content-type` 覆盖 MIME
4. `--text` / `--transcript` 附加字段
5. 自动 `storage.upload` + 构造 attachments 引用

---

## 九、cli-reference.md 更新内容

将以下内容追加到 cli-reference.md：

```
## P2P 消息

通用选项: `--format json` 输出 JSON | `--app <name>` 指定应用 slot

evolclaw msg send <aid> <to> <text>                     发送文本
evolclaw msg send <aid> <to> --file <path> [--as <type>] [--text <说明>]  发送文件
evolclaw msg send <aid> <to> --link <url> [--title T]   发送链接卡片
evolclaw msg send <aid> <to> --payload <json>           发送自定义 payload
evolclaw msg pull <aid> [--after-seq N] [--limit N]     拉取收件箱
evolclaw msg ack <aid> <seq> --app <name>               确认已读（必须传 --app）
evolclaw msg recall <aid> <message-id...>               撤回消息
evolclaw msg online <aid> <target-aid...>               查询在线状态

--as 可选值: image | video | voice | file（默认按扩展名推断）
--content-type <mime>  显式覆盖 MIME 类型

## 群组

通用选项: `--format json` 输出 JSON | `--app <name>` 指定应用 slot

### 消息
evolclaw group send <aid> <group-id> <text>             发送群文本
evolclaw group send <aid> <group-id> --file <path> [--as <type>]  发送群文件
evolclaw group send <aid> <group-id> --payload <json>   发送自定义 payload
evolclaw group pull <aid> <group-id> [--after-seq N]    拉取群消息
evolclaw group ack <aid> <group-id> <seq> --app <name>  确认群消息已读

### 群管理
evolclaw group create <aid> <name> [--visibility public|private]  创建群
evolclaw group list <aid>                               列出我的群
evolclaw group info <aid> <group-id>                    查看群详情
evolclaw group update <aid> <group-id> --name <n>       修改群信息
evolclaw group dissolve <aid> <group-id>                解散群

### 成员
evolclaw group join <aid> <group-id>                    申请加入
evolclaw group leave <aid> <group-id>                   退出群
evolclaw group invite <aid> <group-id> <member-aid...>  邀请成员
evolclaw group kick <aid> <group-id> <member-aid>       踢出成员
evolclaw group members <aid> <group-id>                 列出群成员
evolclaw group online <aid> <group-id>                  查看在线成员
```
