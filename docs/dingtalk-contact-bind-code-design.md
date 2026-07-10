# 钉钉渠道身份绑定码设计

## 1. 背景

钉钉一键创建应用使用 Device Flow。应用注册成功后，`poll` 响应只返回
`client_id` 和 `client_secret`，不返回扫码用户身份，因此不能在扫码完成时直接写入
Agent 的 `contact.json`。

钉钉机器人收到用户消息时，会返回发送者身份字段。EvolClaw 当前将
`senderStaffId || senderId` 作为钉钉入站消息的 `peerId`，可以在应用创建完成后，
通过一次显式消息确认把钉钉身份绑定到已有 owner/admin AID。

## 2. 目标

- `owners` 和 `admins` 继续只保存 AID。
- 身份映射继续保存到 `agents/<agent-aid>/contact.json`。
- 不恢复“任意首条消息自动成为 owner”的 `autoBindOwner`。
- 在 `ec init dingtalk` 中选择已有 owner/admin AID，再用一次性绑定码确认钉钉账号。
- 绑定消息必须在权限判断前处理，未绑定用户也能完成身份确认。

## 3. 用户流程

```text
1. ec init dingtalk
2. 选择目标 agent
3. 选择渠道实例
4. 选择需要绑定的已有 owner/admin AID
5. 扫码创建钉钉应用
6. 写入 channel config 并热重载
7. 生成 6 位数字绑定码
8. 用户在 10 分钟内私聊钉钉机器人，直接发送绑定码
9. 成功后写入 contact.json，并在钉钉中回复绑定成功
```

如果 daemon 未运行或渠道热重载失败，无法注册临时绑定请求。本次 init 不建立身份映射，
用户需要启动 daemon 后重新执行 `ec init dingtalk` 并再次扫码。

## 4. 绑定码规则

- 格式：6 位数字，例如 `483921`。
- 有效期：10 分钟。
- 最大错误次数：5 次。
- 输入处理：先对整条消息执行 `trim()`，因此前后空格不影响匹配。
- 只有“恰好 6 位数字但与绑定码不一致”才计为一次错误。
- 非纯数字或数字位数不是 6 位时，回复格式提醒，不计入错误次数。
- 绑定成功后立即删除 pending bind。
- 连续错误达到 5 次后立即删除 pending bind，并回复绑定失败。
- 超时后 pending bind 失效；用户之后发送消息时回复绑定失败，并提示重新执行 `ec init dingtalk`。
- 失败或超时后必须重新执行 `ec init dingtalk`，重新扫码并生成新绑定码。

## 5. 安全约束

- init 开始时必须选择目标 agent 已存在的 owner/admin AID。
- 绑定流程只接受私聊消息，群聊中的数字消息不参与绑定。
- pending bind 按 `agent AID + channel instance` 隔离。
- 同一实例同时只允许一个 pending bind；重新注册会替换旧请求。
- 绑定码只保存在 daemon 内存中，不写入 config、contact 或索引文件。
- daemon 重启后 pending bind 丢失，用户需要重新执行 init。
- 消息发送者 ID 为空时不得建立映射。
- `bindContactAlias()` 继续负责 alias 冲突校验和 `contact.json` 写入。

## 6. 内存状态

```ts
interface PendingDingtalkContactBind {
  selfAid: string;
  channelName: string;
  primaryId: string;
  code: string;
  expiresAt: number;
  failedAttempts: number;
  maxFailedAttempts: 5;
}
```

内存管理器提供：

- `register()`：注册或替换 pending bind。
- `handleMessage()`：处理钉钉私聊消息。
- `cancel()`：显式取消。
- `getStatus()`：供测试或后续 CLI 状态查询使用。

## 7. 消息处理顺序

钉钉入站消息进入 `MessageBridge` 后：

```text
1. trim 消息内容
2. 检查当前 agent + channel instance 是否存在 pending bind
3. 若存在，按绑定码规则处理
4. 已处理的绑定消息直接回复并终止普通息管线
5. 没有 pending bind，或消息不属于绑定流程时，继续正常权限解析
```

绑定处理必须发生在 `authorizeAccess()` 之前，否则尚未映射的钉钉账号会先被权限系统拒绝。

## 8. contact.json 结果

```json
{
  "$schema_version": 1,
  "contacts": {
    "elean.agentid.pub": {
      "aliases": [
        "dingtalk:0147xxxx8602"
      ]
    }
  }
}
```

运行时后续收到该钉钉用户消息时：

```text
dingtalk:0147xxxx8602
  -> elean.agentid.pub
  -> owners/admins 角色判断
```

## 9. 测试范围

- 正确绑定码成功写入 alias。
- 前后空格被忽略。
- 错误的 6 位数字累计错误次数。
- 第 5 次错误后绑定失败并清除状态。
- 非数字输入回复提醒且不计错。
- 不足或超过 6 位的数字回复提醒且不计错。
- 群聊消息不参与绑定。
- 10 分钟超时后不能绑定。
- 同一实例重新注册会替换旧绑定码。
- alias 冲突时不清除 pending，返回写入失败，避免误判绑定成功。
