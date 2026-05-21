# EvolClaw 运行时系统提示模板

# 本文件定义 LLM 每次收到消息时注入到 system prompt 尾部的三段内容。
# 修改后执行 `evolclaw restart` 生效。
# 放在 {EVOLCLAW_HOME}/data/prompts.md 会覆盖内置默认。

## runtime

[当前环境] 会话通道: {{channel}} | 当前项目: {{project}}{{?sessionName}} | 会话名称: {{sessionName}}{{/}}{{?selfIdentity}} | 当前名称: {{selfIdentity}}{{/}} | 对端身份: {{peerRole}}{{?peerIdentity}} | 对端名称: {{peerIdentity}}{{/}}{{?peerType}} | 对端类型: {{peerType}}{{/}}{{?chatType}} | 聊天类型: {{chatType}}{{/}}{{?agent}} | 当前Agent: {{agent}}{{/}}
{{?readonly}}[只读模式] 禁止修改项目文件。如需生成文件供用户下载，请写入 .evolclaw/tmp/ 目录后{{readonlySendHint}}{{/}}
{{?fileSendCurrent}}[SEND_FILE:路径] 发送文件到当前通道{{/}}
{{?fileSendCross}}[SEND_FILE:{{crossPrimary}}:路径] 发送文件到指定通道（可用: {{crossTypes}}）{{/}}
{{?capability}}[通道能力] {{capabilities}}{{/}}

## group

[群聊回复规则] 回复时必须在开头添加 @{{peerId}} 来通知对方

## proactive

[Proactive 模式] 你的所有文本输出都会被静默丢弃，用户永远看不到。唯一能让用户收到消息的方式：
调用 Bash 工具执行命令 ：evolclaw ctl send "<消息内容>"
发送文件： evolclaw ctl file <路径>
可多次调用发送多条消息 ，如果不想回复停止调用即可。
禁止使用 AskUserQuestion 和 ExitPlanMode 工具——proactive 模式下应由你主动用 ctl send 与用户沟通。

---

## 格式说明

模板由多个以 `## 段名` 分隔的段组成，加载器只识别 `runtime`、`group`、`proactive` 三段，其它段（包括本说明）会被忽略，可以随意增删。

**占位符语法：**

| 语法 | 作用 | 示例 |
|---|---|---|
| `{{var}}` | 变量替换。值为空串/undefined/null/false 时替换为空 | `{{project}}` → `evolclaw` |
| `{{?var}}...{{/}}` | 条件段。var 为真值时保留整段（含字面量），否则整段删除。段内可嵌套 `{{var}}` | `{{?peerId}} | @{{peerId}}{{/}}` |
| 空行 | 渲染后若某行只剩空白，整行自动删除 | 条件段删完后的空行会消失 |

**注入时机：**

| 段 | 触发条件 | 说明 |
|---|---|---|
| `runtime` | 每次消息 | 每条用户消息都会注入 |
| `group` | `chatType === 'group' && peerId` | 仅群聊消息注入 |
| `proactive` | `sessionMode === 'proactive'` | 仅 proactive 会话注入 |
三段以换行拼接，追加到该消息的 system prompt 末尾。

---

## 参数说明

### runtime 段

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| `channel` | string | 当前通道类型 | `feishu` / `wechat` / `aun` |
| `project` | string | 当前项目目录名（非完整路径） | `evolclaw` |
| `sessionName` | string? | 会话名（用户通过 `/name` 设置） | `CLI开发` |
| `selfIdentity` | string? | 机器人自身标识「名称 (ID)」 | `Evol (evolai.xxx.pub)` |
| `peerRole` | string | 对端角色 | `owner` / `admin` / `guest` / `unknown` |
| `peerIdentity` | string? | 对端标识「名称 (ID)」 | `张三 (u_abc)` |
| `peerType` | string? | 对端类型（`unknown` 时为空） | `user` / `group` |
| `chatType` | string? | 聊天类型 | `private` / `group` |
| `agent` | string? | 当前 agent（`claude` 时为空不显示） | `hermes` / `gemini` |
| `readonly` | bool | 是否只读模式（触发只读行） | `true` / `false` |
| `readonlySendHint` | string | 只读模式下提示使用的发送方式 | `使用 [SEND_FILE:] 发送` |
| `fileSendCurrent` | bool | 当前通道是否支持发文件（触发该行） | `true` / `false` |
| `fileSendCross` | bool | 是否存在可跨通道发文件的其它通道 | `true` / `false` |
| `crossPrimary` | string | 跨通道发送示例用的首选通道 | `wechat` |
| `crossTypes` | string | 所有支持跨通道发送的通道列表 | `wechat/aun` |
| `capability` | bool | 是否有任何通道能力要展示（触发通道能力行） | `true` / `false` |
| `capabilities` | string | 通道能力清单 | `图片输入、图片输出、文件发送` |

### group 段

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| `peerId` | string | 对端用户 ID（@ 所需） | `ou_xxx` / `wxid_xxx` |

### proactive 段

无参数。

---

## 修改示例

**只改文案，不改结构：**

```
## runtime
当前项目 {{project}}，你正在和 {{peerIdentity}} 对话。
{{?readonly}}⚠ 只读模式，不要修改代码{{/}}
```

**关闭某一行：** 模板里删掉那一行即可。内置条件段（如只读提示）删了之后，只读模式就不再在 system prompt 里出现（但权限拦截依然生效）。

**追加自定义规则：** 直接在对应段里加行文本，不需要占位符。

**用英文：** 所有文案重写成英文即可，字段含义不变。
