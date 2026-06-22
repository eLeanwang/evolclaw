# Echo 链路追踪机制

## 概述

Echo 是 AUN 网络的链路追踪机制。当消息第一行包含 `echo`（不区分大小写）时,消息经过的每个节点都在消息明文末尾追加自己的 trace 行。消息到达终端后原路返回,返回路径上的节点同样追加。最终用户看到的是一条完整的链路追踪记录。

**仅明文消息支持 echo。** 加密消息中间节点无法读取/修改内容,因此不参与 echo。

## Trace 行格式

每个节点追加的行格式统一为:

```
HH:MM:SS.mmm [节点名称] 描述信息
```

- `HH:MM:SS.mmm` — 本地时间,毫秒精度
- `[节点名称]` — 标识当前节点身份,如 `[Evol-App]`、`[AUN-SDK]`、`[AUN-Gateway]`、`[EvolClaw]`
- `描述信息` — 当前环节的动作或状态

多行附加信息（如元数据）缩进 2 空格:

```
HH:MM:SS.mmm [EvolClaw] 收到消息
  from: alice.agentid.pub
  mid: gm-xxx
```

## 完整链路示例

用户在 Evol App 输入 "echo 测试" 并发送:

```
echo 测试
16:38:42.100 [Evol-App] 用户发送
  device: iPhone 15 / Evol 2.1.0
16:38:42.105 [AUN-SDK-Sender] 调用 message.send
  aid: toleiliang.agentid.pub
  encrypt: false
16:38:42.350 [AUN-Gateway] 路由转发
  from: toleiliang.agentid.pub
  to: toleiliang5.agentid.pub
  latency: 2ms
16:38:42.960 [AUN-SDK-Receiver] 事件回调触发
  aid: toleiliang5.agentid.pub
16:38:42.962 [EvolClaw] 收到消息
  self: toleiliang5.agentid.pub
  chat: group (group.agentid.pub/11117)
  connected: true
16:38:42.963 [EvolClaw] Echo 识别，准备回声
16:38:43.100 [EvolClaw] 回声发送完成 (outbox→send: 137ms)
16:38:43.105 [AUN-SDK-Sender] 调用 group.send
  aid: toleiliang5.agentid.pub
16:38:43.350 [AUN-Gateway] 路由转发
  from: toleiliang5.agentid.pub
  to: group.agentid.pub/11117
16:38:43.800 [AUN-SDK-Receiver] 事件回调触发
  aid: toleiliang.agentid.pub
16:38:43.802 [Evol-App] 收到回声
  total_rtt: 1702ms
```

## 各节点职责

### 1. 前端 App（Evol-App / Web）

**发送时：**
- 检测第一行是否包含 `echo`
- 如果是明文消息,在消息末尾追加:
  ```
  HH:MM:SS.mmm [Evol-App] 用户发送
    device: {设备信息} / {App版本}
  ```

**接收时：**
- 检测收到的消息第一行是否包含 `echo`
- 如果是,追加:
  ```
  HH:MM:SS.mmm [Evol-App] 收到声
    total_rtt: {从第一行时间戳到现在的耗时}ms
  ```
- 正常展示消息（不做特殊 UI 处理）

### 2. AUN SDK（发送端 & 接收端）

**发送时（调用 send 前）：**
- 检测消息第一行是否包含 `echo` 且为明文
- 追加:
  ```
  HH:MM:SS.mmm [AUN-SDK.send] aid={self_aid} conn_uptime={连接持续时间}s
  ```

**接收时（事件回调触发时）：**
- 检测消息第一行是否包含 `echo`
- 追加:
  ```
  HH:MM:SS.mmm [AUN-SDK.receive] aid={self_aid} conn_uptime={连接持续时间}s
  ```

### 3. AUN Gateway

**转发时：**
- 检测消息 payload 第一行是否包含 `echo` 且为明文
- 追加:
  ```
  HH:MM:SS.mmm [AUN-Gateway.route] from={sender_aid} to={target_aid_or_group} conn_uptime={连接持续时间}s
  ```

### 4. EvolClaw（Channel 层）

**收到消息时：**
- 在 mention 过滤之前检测第一行是否包含 `echo`
- 在收到的消息文本末尾追加两条 trace（代表两个不同代码位置）:
  ```
  HH:MM:SS.mmm [EvolClaw.receive] from={sender_aid}({displayName}) mid={messageId} chat={chatType} self={self_aid} conn_uptime={连接持续时间}s
  HH:MM:SS.mmm [EvolClaw.reply] echo回声发出 conn_uptime={连接持续时间}s
  ```
- 调用 sendMessage 将追加后的消息发回（不加 @peer 前缀）

**节点子环节说明：**
- `EvolClaw.receive` — SDK 事件回调进入 echo 处理函数的时刻
- `EvolClaw.reply` — trace 构建完毕,准备调用 sendMessage 的时刻

**注意：** EvolClaw 是终端节点,收到 echo 后不交给 Agent 处理,直接回声。

## 实现约束

1. **仅明文** — `encrypt: false` 的消息才参与 echo。加密消息各中间节点无法读取 payload,跳过。
2. **第一行检测** — 只看消息文本的第一行是否包含 `echo`（不区分大小写）。后续行是 trace 追加内容。
3. **短 echo 直接回声** — 第一行 ≤10 字符时,EvolClaw 直接回声,不经过 Agent 处理。
4. **长 echo 经过 Agent** — 第一行 >10 字符时,跳过 mention 过滤,正常交给 Agent 处理。Agent 的回复会带着各节点追加的 trace 行。
5. **追加而非替换** — 每个节点只在消息末尾追加 `\n` + trace 行,不修改原有内容。
6. **时间格式统一** — `HH:MM:SS.mmm`,本地时间,不含日期（消息收发是毫秒级的）。
7. **节点名称统一** — 方括号包裹,层级用 `.` 分隔:
   - `[Evol-App.send]` / `[Evol-App.receive]` — 前端
   - `[AUN-SDK.send]` / `[AUN-SDK.receive]` — SDK 层
   - `[AUN-Gateway.route]` — 网关服务
   - `[EvolClaw.receive]` / `[EvolClaw.reply]` — Agent 网关
8. **不循环** — EvolClaw 回声的消息本身也包含 `echo`,但因为 sender_aid === self_aid,会被 "own message" 过滤器拦截,不会无限循环。
9. **消息体大小** — trace 行会增加消息体积。如果消息超过 4KB,停止追加并标注 `[TRUNCATED]`。
10. **一个环节一条记录** — 每个节点子环节只追加一条 trace 行,格式为 `HH:MM:SS.mmm [节点.子环节] 关键信息`。

## 当前实现状态

| 节点 | 状态 | 备注 |
|------|------|------|
| Evol-App (iOS/Android) | ❌ 未实现 | 需前端配合 |
| Evol-Web | ❌ 未实现 | 需前端配合 |
| AUN SDK (JS) | ❌ 未实现 | 需 SDK 层 hook |
| AUN Gateway | ❌ 未实现 | 需服务端配合 |
| EvolClaw | ✅ 已实现 | `src/channels/aun.ts` handleEcho |

## EvolClaw 实现位置

- 检测点: `handleIncomingGroupMessage` / `handleIncomingPrivateMessage` 中,mention 过滤之前
- 处理函数: `AUNChannel.handleEcho()`
- 文件: `src/channels/aun.ts`
