# Menu Protocol scope 参数客户端改造说明

面向：ECWeb、控制面、移动端/桌面端菜单 UI、Bot 卡片客户端。

更新时间：2026-07-09

## 1. 背景

`menu.query` / `menu.options` / `menu.update` 的配置类 menu name 统一支持 `args.scope`，用于明确本次操作读取或写入的是 **agent 级默认配置** 还是 **relation 级覆盖配置**。

当前已经取消 session 级参数绑定。客户端不应再把 `model`、`effort`、`chatmode`、`dispatch`、`permission` 当成“当前 session 参数”来展示或写入。

本次 scope 口径：

| scope | 含义 | 落盘位置 | 适用 UI |
|---|---|---|---|
| `agent` | 当前/指定 agent 的默认行为配置 | `agents/<aid>/config.json` | 控制面、ECWeb、Agent 设置页 |
| `relation` | 指定对端/群关系覆盖配置 | `agents/<aid>/relations/<peerKey>/config.json` | 对话详情页、群详情页、关系覆盖高级设置 |

默认值：`args.scope` 省略时等价于 `agent`。

## 2. 支持 scope 的 menu name

当前支持：

| name | query | options | update | scope 默认值 | 支持 scope |
|---|---:|---:|---:|---|---|
| `model` | 是 | 是 | 是 | `agent` | `agent` / `relation` |
| `effort` | 是 | 是 | 是 | `agent` | `agent` / `relation` |
| `chatmode` | 是 | 是 | 是 | `agent` | `agent` / `relation` |
| `dispatch` | 是 | 是 | 是 | `agent` | `agent` / `relation` |
| `permission` | 是 | 是 | 是 | `agent` | `agent` / `relation` |

注意：

- `capability.args.scope="project"` 是另一个业务字段，不属于本说明的 agent/relation scope。
- `role` 是服务端权限解析和约束上下文，不是客户端可选 scope。
- `model` / `effort` 可额外传 `args.baseagent` 指定 baseagent；省略时使用当前会话或 agent 当前 baseagent。

## 3. 客户端调整原则

### 3.1 控制面 / ECWeb

控制面和 ECWeb 通常只需要设置 agent 级参数。

推荐：

- 不展示 scope 选择器。
- 请求中可以省略 `args.scope`。
- 指定 agent 时传 `args.aid` 或 `args.self`。
- 不要传 `scope=relation`，除非后续明确做“某个联系人/群的覆盖配置”页面。

示例：

```json
{
  "type": "menu.update",
  "id": "u-chatmode-agent",
  "name": "chatmode",
  "value": "proactive",
  "args": {
    "aid": "bot.agentid.pub",
    "field": "private"
  }
}
```

等价于：

```json
{
  "type": "menu.update",
  "id": "u-chatmode-agent",
  "name": "chatmode",
  "value": "proactive",
  "args": {
    "aid": "bot.agentid.pub",
    "scope": "agent",
    "field": "private"
  }
}
```

### 3.2 普通会话内菜单

普通会话内如果只是切换 agent 默认行为，也不需要传 scope。

如果客户端要做“仅当前联系人/群覆盖”，必须显式传：

```json
{
  "scope": "relation"
}
```

并确保服务端能推导或客户端显式传入 `peer` / `peerKey`。

### 3.3 移除 session 级 UI 文案

请把以下文案或状态改掉：

| 旧文案/概念 | 新文案/概念 |
|---|---|
| 当前会话模型 | Agent 默认模型 / 关系覆盖模型 |
| 当前 session 推理强度 | Agent 默认推理强度 / 关系覆盖推理强度 |
| 当前会话模式 | Agent 默认响应模式 / 关系覆盖响应模式 |
| 当前 session 分发模式 | Agent 默认群分发 / 群关系覆盖分发 |
| 当前 session 权限模式 | Agent 默认权限模式 / 关系覆盖权限模式 |
| 仅本会话生效 | 关系覆盖生效 / Agent 默认生效 |

## 4. agent/relation scope 与 role 的关系

`agent` / `relation` 是配置落盘层级：

| scope | 问题 | 示例 |
|---|---|---|
| `agent` | 写到哪个 agent 的默认行为配置？ | `agents/bot.agentid.pub/config.json` |
| `relation` | 写到这个 agent 与哪个对端/群的覆盖配置？ | `agents/bot.agentid.pub/relations/aun#group-1/config.json` |

`关系/角色` 是权限解析上下文：

| 维度 | 问题 | 示例 |
|---|---|---|
| 关系 | 当前消息来自哪个 peer/group？ | `peerKey=aun#user.agentid.pub` |
| 角色 | 这个 peer 在该 agent 下是什么身份？ | `owner` / `admin` / `member` / `guest` |

因此它们不是同一套概念。客户端只提供 `scope=agent|relation`；`role` 由服务端用于鉴权和 effective 值约束，不要做成第三种 scope UI。

## 5. model / effort 协议

通用参数：

| 参数 | 含义 | 默认值 |
|---|---|---|
| `args.aid` / `args.self` | 目标 agent | 当前 channel 绑定的 agent |
| `args.scope` | 写入层级 | `agent` |
| `args.peerKey` / `args.peer` | relation 覆盖目标 | 当前会话可推导；控制面需显式传 |
| `args.baseagent` | 目标 baseagent，如 `claude` / `codex` | 当前会话或 agent 当前 baseagent |

Agent 级 model 更新：

```json
{
  "type": "menu.update",
  "id": "u-model-agent",
  "name": "model",
  "value": "sonnet",
  "args": {
    "aid": "bot.agentid.pub",
    "baseagent": "claude"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-model-agent",
  "name": "model",
  "data": {
    "model": "sonnet",
    "baseagent": "claude",
    "scope": "agent",
    "field": "baseagents.claude.model",
    "self": "bot.agentid.pub"
  }
}
```

Relation 级 model 更新：

```json
{
  "type": "menu.update",
  "id": "u-model-relation",
  "name": "model",
  "value": "sonnet",
  "args": {
    "aid": "bot.agentid.pub",
    "scope": "relation",
    "peerKey": "aun#user.agentid.pub",
    "baseagent": "claude"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-model-relation",
  "name": "model",
  "data": {
    "model": "sonnet",
    "baseagent": "claude",
    "scope": "relation",
    "field": "baseagents.claude.model",
    "self": "bot.agentid.pub",
    "peerKey": "aun#user.agentid.pub"
  }
}
```

`effort` 的 `value` 使用当前 baseagent 支持的 effort 值；`auto` 表示清除当前 scope 的本地配置，回到上层/SDK 默认。

```json
{
  "type": "menu.update",
  "id": "u-effort-agent",
  "name": "effort",
  "value": "high",
  "args": {
    "aid": "bot.agentid.pub",
    "baseagent": "claude"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-effort-agent",
  "name": "effort",
  "data": {
    "effort": "high",
    "baseagent": "claude",
    "scope": "agent",
    "field": "baseagents.claude.effort",
    "self": "bot.agentid.pub"
  }
}
```

`menu.query name=model` / `menu.query name=effort` 返回 effective 值，并带上 `source`：

```json
{
  "type": "menu.response",
  "id": "q-model",
  "name": "model",
  "data": {
    "model": "sonnet",
    "baseagent": "claude",
    "source": "agent",
    "scope": "agent",
    "field": "baseagents.claude.model",
    "self": "bot.agentid.pub"
  }
}
```

`source` 可能是 `agent` / `relation` / `null`。`null` 表示没有命中本地配置，展示值来自 runner 当前值或 SDK 默认。

## 6. chatmode 协议

`value` 只允许：

| value | 含义 |
|---|---|
| `interactive` | 交互模式 |
| `proactive` | 主动模式 |

`args.field` 可选：

| field | 含义 | 默认值 |
|---|---|---|
| `private` | 私聊 human 对端 | `interactive` |
| `group` | 群聊 | `proactive` |
| `nothuman` | system / agent 等非 human 对端 | `proactive` |

`args.field` 省略时，服务端按当前上下文推导目标字段：

| 当前上下文 | 默认字段 |
|---|---|
| 群聊 `chatType=group` | `chatmode.group` |
| 私聊且 `peerType` 存在并且不是 `human` | `chatmode.nothuman` |
| 其它私聊或无会话上下文 | `chatmode.private` |

控制面 / ECWeb 没有稳定会话上下文时，建议显式传 `args.field`，尤其是要编辑非 human 对端默认值时传 `field="nothuman"`。

Agent 级更新：

```json
{
  "type": "menu.update",
  "id": "u-chatmode-agent",
  "name": "chatmode",
  "value": "proactive",
  "args": {
    "aid": "bot.agentid.pub",
    "field": "private"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-chatmode-agent",
  "name": "chatmode",
  "data": {
    "mode": "proactive",
    "scope": "agent",
    "field": "chatmode.private",
    "self": "bot.agentid.pub"
  }
}
```

Relation 级更新：

```json
{
  "type": "menu.update",
  "id": "u-chatmode-relation",
  "name": "chatmode",
  "value": "proactive",
  "args": {
    "aid": "bot.agentid.pub",
    "scope": "relation",
    "peerKey": "aun#user.agentid.pub",
    "field": "private"
  }
}
```

## 7. dispatch 协议

`dispatch` 只适用于群聊。

| value | 含义 |
|---|---|
| `mention` | 仅 @ / @all 时响应 |
| `broadcast` | 群内所有消息都触发响应 |
| `clear` | 清除当前 scope 的本地配置 |

Agent 级更新：

```json
{
  "type": "menu.update",
  "id": "u-dispatch-agent",
  "name": "dispatch",
  "value": "broadcast",
  "args": {
    "aid": "bot.agentid.pub"
  }
}
```

Relation 级更新：

```json
{
  "type": "menu.update",
  "id": "u-dispatch-relation",
  "name": "dispatch",
  "value": "mention",
  "args": {
    "aid": "bot.agentid.pub",
    "scope": "relation",
    "peerKey": "aun#group-1"
  }
}
```

`clear` 删除当前 scope 的配置值；客户端收到 `mode: null` 时，应重新 `menu.query name=dispatch` 获取 effective 展示值，或展示“跟随上层/服务器默认”。

## 8. permission 协议

`permission` 用于设置工具调用审批策略。

| value | 含义 |
|---|---|
| `auto` | 按运行时策略自动处理 |
| `bypass` | 免审批 |
| `readonly` | 只读 |
| `plan` | 计划模式 |
| `edit` | 编辑模式 |
| `request` | 请求审批 |
| `noask` | 静默执行 |

Agent 级更新：

```json
{
  "type": "menu.update",
  "id": "u-permission-agent",
  "name": "permission",
  "value": "readonly",
  "args": {
    "aid": "bot.agentid.pub"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-permission-agent",
  "name": "permission",
  "data": {
    "mode": "readonly",
    "scope": "agent",
    "field": "permissionMode",
    "self": "bot.agentid.pub"
  }
}
```

Relation 级更新：

```json
{
  "type": "menu.update",
  "id": "u-permission-relation",
  "name": "permission",
  "value": "readonly",
  "args": {
    "aid": "bot.agentid.pub",
    "scope": "relation",
    "peerKey": "aun#user.agentid.pub"
  }
}
```

## 9. menu.options

`menu.options` 可以带相同的 `args.scope`，用于让服务端按目标层级计算 selected。

示例：

```json
{
  "type": "menu.options",
  "id": "o-model-relation",
  "name": "model",
  "args": {
    "aid": "bot.agentid.pub",
    "scope": "relation",
    "peerKey": "aun#user.agentid.pub",
    "baseagent": "claude"
  }
}
```

options 响应仍是 `MenuItem[]`，不会额外返回 `scope/self/peerKey`。客户端需要自己保留当前编辑上下文。

## 10. peerKey 规则

relation scope 需要 `peerKey`。

推荐格式：

```text
<channelType>#<peerIdOrGroupId>
```

示例：

```text
aun#user.agentid.pub
aun#group-1
feishu#oc_xxx
```

在普通会话内，服务端通常能从当前会话推导 peerKey；但控制面 / ECWeb 没有稳定会话上下文，若要做 relation 配置，必须显式传 `peerKey`。

## 11. 错误码

| code | 场景 | 客户端建议 |
|---|---|---|
| `INVALID_SCOPE` | `args.scope` 不是 `agent` / `relation` | 修正请求，不要透传未知 scope |
| `MISSING_AID` | 无法确定目标 agent | 控制面请求补 `args.aid` 或 `args.self` |
| `MISSING_BASEAGENT` | 无法确定目标 baseagent | 控制面请求补 `args.baseagent` |
| `FORBIDDEN` | 非控制面试图跨 agent 写配置 | 只允许当前 agent，或改走控制面入口 |
| `MISSING_PEER` | `scope=relation` 但无法确定 peerKey | 补 `args.peerKey` |
| `INVALID_FIELD` | chatmode field 非法 | 使用 `private` / `group` / `nothuman` |
| `INVALID_VALUE` | value 非法 | 重新拉 `menu.options` |
| `NOT_APPLICABLE` | 当前上下文不适用，如私聊 dispatch | 灰显或隐藏入口 |
| `NO_PERMISSION` | 角色无写权限 | 降级为只读 UI |

## 12. UI 建议

Agent 设置页：

- 模型默认值：`baseagents.<baseagent>.model`
- 推理强度默认值：`baseagents.<baseagent>.effort`
- 私聊响应模式：`chatmode.private`
- 群聊响应模式：`chatmode.group`
- 非 human 对端响应模式：`chatmode.nothuman`
- 群分发默认值：`dispatch`
- 权限模式默认值：`permissionMode`

关系详情页：

- 展示“使用 Agent 默认值”和“为此联系人/群单独覆盖”。
- 覆盖：`args.scope="relation"` + `args.peerKey`。
- `effort` 使用 `value="auto"` 清除当前 scope 的本地 effort 配置。
- `dispatch` 使用 `value="clear"` 清除当前 scope 的本地 dispatch 配置。

会话页快捷菜单：

- 如果只是快速改 agent 默认，保持无 scope。
- 如果产品语义是“只对当前联系人/群生效”，必须显式传 `scope=relation`，并在 UI 文案中说明“关系覆盖”。
