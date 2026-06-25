# Evol App 二维码绑定对接文档

## 1. 目标

Evol App 扫描 EvolClaw CLI 展示的二维码后，通过 AUN 向 EvolClaw daemon 发送一次性 `bind.request`。daemon 校验二维码中的 `token` 后，将扫码用户的 AID 写入对应 owner 列表。

支持两类绑定：

| `bindType` | 说明 | App 保存对象 |
| --- | --- | --- |
| `daemon` | 绑定 EvolClaw daemon owner | daemon / control endpoint |
| `agent` | 绑定指定 EvolClaw agent owner | agent |

App 不能仅凭二维码保存绑定结果。必须收到 daemon 返回的成功 `bind.response` 后再保存。

## 2. 字段命名

外部协议只使用以下 AID 字段：

| 字段 | 含义 |
| --- | --- |
| `daemonAid` | EvolClaw control daemon AID，也是 AUN 消息发送目标。必填。 |
| `agentAid` | agent 绑定目标 AID。仅 `bindType === "agent"` 时出现。 |

## 3. 二维码内容

二维码内容是 JSON 字符串，MVP 不使用 URL wrapper。

daemon 绑定示例：

```json
{
  "type": "evolclaw.bind",
  "version": "3.4.0",
  "platform": "linux",
  "bindType": "daemon",
  "daemonAid": "ec42857.agentid.pub",
  "token": "Lx7q8LR3mV3DRXoR",
  "expiresAt": 1781720000000
}
```

agent 绑定示例：

```json
{
  "type": "evolclaw.bind",
  "version": "3.4.0",
  "bindType": "agent",
  "daemonAid": "ec42857.agentid.pub",
  "agentAid": "mybot.agentid.pub",
  "agentName": "mybot",
  "token": "QtxC5x1RKoW3oW51",
  "expiresAt": 1781720000000
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 固定为 `evolclaw.bind` |
| `version` | 是 | EvolClaw 软件版本，仅用于展示、兼容提示和问题排查 |
| `platform` | 否 | EvolClaw daemon 所在主机 OS：`windows` / `macos` / `linux`；当前只在 daemon 绑定 QR 中出现 |
| `bindType` | 是 | `daemon` / `agent` |
| `daemonAid` | 是 | App 要发送 AUN 消息的目标 AID |
| `agentAid` | agent 必填 | agent 绑定目标 AID；daemon 绑定不需要该字段 |
| `agentName` | 否 | agent 绑定时用于 UI 展示 |
| `token` | 是 | 一次性授权 token，敏感，不落盘、不打日志 |
| `expiresAt` | 是 | 过期时间，Unix epoch milliseconds |

当前 token 格式：

- `crypto.randomBytes(12).toString('base64url')`
- 16 个 URL-safe 字符
- 96 bit 随机熵
- 默认 10 分钟有效
- 使用一次后失效

## 4. App 扫码流程

1. 扫描二维码，得到文本。
2. `JSON.parse`。
3. 校验 `type === "evolclaw.bind"`。
4. 校验必填字段：`bindType`、`daemonAid`、`token`、`expiresAt`。
5. 如果 `bindType === "agent"`，额外校验 `agentAid` 存在。
6. 校验 `Date.now() <= expiresAt`。
7. 按 `bindType` 展示确认 UI：
   - `daemon`：展示 `daemonAid`
   - `agent`：展示 `agentName || agentAid`
8. 检查 App 本地是否已有同一目标记录：
   - daemon：用 `bindType + daemonAid` 查重
   - agent：用 `bindType + agentAid` 查重
9. 用户确认后，向 `daemonAid` 发送 AUN `bind.request`。
10. 等待来自 `daemonAid` 的 `bind.response`。
11. 只有 `success === true` 时保存绑定结果。
12. 最终保存字段以 `bind.response.daemonInfo` 为准，不以 QR 字段为准。

## 5. bind.request

App 通过 AUN 私聊消息向 `daemonAid` 发送 JSON payload。

示例：

```json
{
  "type": "bind.request",
  "bindType": "agent",
  "token": "QtxC5x1RKoW3oW51",
  "clientName": "Alice",
  "deviceName": "Alice iPhone",
  "platform": "ios",
  "appVersion": "1.0.0",
  "timestamp": 1781719700000
}
```

要求：

- 不发送 `taskId`。
- 不发送 `agentAid`；daemon 通过 token 对应的任务知道目标 agent。
- 不发送 `clientAid`；daemon 从 AUN envelope `from` 获取 owner AID。
- 不发送 `ownerMode`；append/replace 只允许本地 CLI 决定。
- 可选发送 `deviceName`，表示扫码 App 设备名称；daemon 当前仅接收，不存储、不返回。
- 可选发送 `platform`，表示扫码 App 设备操作系统；daemon 当前仅接收，不存储、不返回。
- `token` 不保存到本地数据库。
- `token` 不进入埋点和错误上报。
- 推荐 `encrypt: true`。
- 推荐 `persist: false`，避免绑定 token 进入聊天历史。

## 6. bind.response

daemon 成功或失败都会向 App 返回 `bind.response`。

成功响应字段：

| 字段 | daemon | agent | 说明 |
| --- | --- | --- | --- |
| `type` | 是 | 是 | 固定为 `bind.response` |
| `bindType` | 是 | 是 | `daemon` / `agent` |
| `success` | 是 | 是 | 成功时为 `true` |
| `daemonInfo.daemonAid` | 是 | 是 | control daemon AID |
| `daemonInfo.agentAid` | 否 | 是 | agent 绑定目标 AID |
| `daemonInfo.bindType` | 是 | 是 | 与顶层 `bindType` 一致 |
| `daemonInfo.version` | 是 | 否 | EvolClaw 软件版本 |
| `daemonInfo.platform` | 是 | 否 | EvolClaw daemon 所在主机 OS，不是 App 设备 OS |
| `daemonInfo.uptime` | 是 | 否 | daemon uptime 秒数 |
| `daemonInfo.baseagents` | 是 | 否 | daemon 主机当前扫描到的可用 baseagent CLI 列表 |
| `daemonInfo.active_baseagent` | 否 | 是 | agent 当前 active baseagent；无配置时回退为 `claude` |
| `daemonInfo.model` | 否 | 否 | agent 当前 baseagent 的 model，未配置时省略 |
| `daemonInfo.effort` | 否 | 否 | agent 当前 baseagent 的 effort/reasoning，未配置时省略 |
| `daemonInfo.channels` | 否 | 是 | agent 显式配置渠道的脱敏摘要；不含 AUN 隐式渠道，不含凭据 |
| `daemonInfo.agentName` | 否 | 否 | agent 绑定时可返回，用于 UI 展示 |

`channels` 仅包含 `{ type, name, enabled }`，不会返回 `appSecret`、`token`、`clientSecret` 等渠道凭据。

daemon 绑定成功示例：

```json
{
  "type": "bind.response",
  "bindType": "daemon",
  "success": true,
  "daemonInfo": {
    "daemonAid": "ec42857.agentid.pub",
    "bindType": "daemon",
    "version": "3.4.0",
    "platform": "linux",
    "uptime": 42,
    "baseagents": ["codex"]
  }
}
```

`baseagents` 是 daemon 运行环境扫描结果：当前检查主机 `PATH` 中是否存在 `claude`、`codex`、`gemini` 命令。它不是 EvolClaw 配置里的启用列表，也不表示对应账号、模型或 API 一定已经完成登录和可调用。

agent 绑定成功示例：

```json
{
  "type": "bind.response",
  "bindType": "agent",
  "success": true,
  "daemonInfo": {
    "daemonAid": "ec42857.agentid.pub",
    "agentAid": "mybot.agentid.pub",
    "bindType": "agent",
    "active_baseagent": "codex",
    "model": "gpt-5.4",
    "effort": "medium",
    "channels": [
      { "type": "feishu", "name": "work", "enabled": true },
      { "type": "wechat", "name": "wx", "enabled": false }
    ],
    "agentName": "mybot"
  }
}
```

失败示例：

```json
{
  "type": "bind.response",
  "bindType": "daemon",
  "success": false,
  "error": {
    "code": "TASK_EXPIRED",
    "message": "binding task expired"
  }
}
```

## 7. App 本地保存

保存时以 `bind.response.daemonInfo` 为准。

保存规则：

- `daemon`：保存 `daemonAid`，主键建议 `daemon:${daemonAid}`。
- `agent`：保存 `daemonAid` + `agentAid`，主键建议 `agent:${agentAid}`。
- agent 绑定可保存 `active_baseagent`、`model`、`effort` 和 `channels` 作为展示信息。
- 同一主键已存在时，提示用户是否覆盖 App 本地记录。
- 覆盖 App 本地记录不等于替换 daemon 侧 owner。

## 8. 去重逻辑

建议本地主键：

| `bindType` | 主键 |
| --- | --- |
| `daemon` | `daemon:<daemonAid>` |
| `agent` | `agent:<agentAid>` |

二维码字段只用于扫码前确认和临时去重。最终保存必须以成功 response 为准。

## 9. 错误提示建议

| 错误码 / 场景 | App 提示 |
| --- | --- |
| 二维码不是 JSON | 不是有效的 EvolClaw 绑定二维码 |
| `type` 不匹配 | 不是 EvolClaw 绑定二维码 |
| 必填字段缺失 | 二维码信息不完整，请重新生成 |
| `agent` 绑定缺少 `agentAid` | 二维码信息不完整，请重新生成 |
| `expiresAt` 已过期 | 二维码已过期，请在电脑端重新生成 |
| AUN 发送失败 | 网络错误，请检查连接后重试 |
| 等待 response 超时 | 未收到 EvolClaw 响应，请确认电脑端 daemon 在线 |
| `INVALID_TOKEN` | 绑定凭据无效，请重新生成二维码 |
| `TASK_EXPIRED` | 二维码已过期，请重新生成 |
| `TASK_NOT_FOUND` | 绑定任务不存在，daemon 可能已重启，请重新生成二维码 |
| `ALREADY_BOUND` | 该二维码已使用，请重新生成 |
| `BIND_TYPE_MISMATCH` | 绑定类型不匹配，请重新生成二维码 |
| `TARGET_NOT_FOUND` | 目标 agent 不存在，请在电脑端重新生成 |
| `INTERNAL_ERROR` | EvolClaw 绑定失败，请稍后重试 |

## 10. 安全要求

- 不把 `token` 放入错误上报、分析埋点、剪贴板历史。
- 不把 `token` 保存到本地数据库。
- 不信任二维码中的 `agentAid` 作为最终成功依据。
- response 必须来自 `daemonAid`。
- 绑定请求推荐加密发送。
- 绑定请求推荐不进入聊天历史。
- 用户重试时必须重新扫描新二维码，不复用旧 token。

## 11. 兼容性

App 判断方式：

- `type === "evolclaw.bind"`
- 必填字段完整
- `version` 仅用于展示、提示升级和问题排查

新 App 行为：

- 忽略未知字段。
- 缺少 `daemonAid` 必须报错。
- 缺少 `token` 必须报错。
- `bindType === "agent"` 且缺少 `agentAid` 必须报错。
- `bindType === "daemon"` 且没有 `agentAid` 是正常情况。

## 12. 对接检查清单

- [ ] 能解析 QR JSON
- [ ] 校验 `type === "evolclaw.bind"`
- [ ] 校验 `bindType` / `daemonAid` / `token` / `expiresAt`
- [ ] agent 绑定校验 `agentAid`
- [ ] 本地检查二维码过期
- [ ] 通过 AUN 向 `daemonAid` 发送 `bind.request`
- [ ] `bind.request` 不包含 `taskId` / `agentAid` / `clientAid`
- [ ] 等待并解析 `bind.response`
- [ ] 仅 `success === true` 时保存
- [ ] 保存以 `daemonInfo` 为准
- [ ] token 不落盘、不埋点
