# 飞书渠道

> 知识性文档：飞书渠道的配置、参数与特有机制。**不依赖当前会话渠道**——任意会话都可按需 Read（在 aun 会话里也可查飞书）。
> 运行时"怎么发消息"由注入的 `[channel]` 段决定（飞书是 evolclaw 自动回复，agent 不调 CLI），不在本文。

## 概述

飞书渠道通过 evolclaw 的 feishu channel 插件接入，对端以飞书 `user_id`（如 `ou_xxx`）为身份标识。支持单聊/群聊收发、合并转发解析、富文本卡片、文件/图片/视频消息。

## 配置

飞书渠道按 **per-agent** 配置，写在 `agents/<aid>/config.json` 的 `channels` 数组里。每个元素是一个独立实例，靠 `name` 区分；同一 agent 可配多个飞书实例。

```json
{
  "aid": "myagent.aid.pub",
  "channels": [
    {
      "type": "feishu",
      "name": "main",
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "<app-secret>",
      "owners": ["ou_owner_user_id"],
      "admins": ["ou_admin_user_id"]
    }
  ]
}
```

### 实例字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 固定 `"feishu"` |
| `name` | 是（数组形式） | 该 agent 内飞书实例的本地标识，不含 `#` |
| `enabled` | 否 | 默认启用；`false` 关闭该实例 |
| `appId` | 是 | 飞书自建应用 App ID |
| `appSecret` | 是 | 飞书自建应用 App Secret |
| `owners` | 否 | owner 的飞书 `user_id` 列表（最高权限） |
| `admins` | 否 | admin 的飞书 `user_id` 列表 |
| `flushDelay` | 否 | flush 间隔（秒），覆盖全局值 |
| `debounce` | 否 | 入站消息去抖间隔（秒），覆盖全局值 |
| `showActivities` | 否 | 思考过程展示范围：`all` / `dm-only` / `owner-dm-only` / `none` |

> `owners`/`admins` 用飞书原生 `user_id`，**不是 AID**。

agent 级（config.json 顶层）相关开关：
- `enable_rich_content`：启用富文本卡片渲染，默认关闭。

## 特有机制

- **合并转发解析**：飞书的 `merge_forward` 消息会被自动展开为文本注入上下文（含"以下是引用的原消息"包裹）。
- **交互卡片**：富内容开启时，部分回复以飞书卡片形式发送；卡片按钮**仅发起者可操作**，他人点击返回提示。
- **身份体系**：对端以 `user_id` 标识，关系层 peerKey 形如 `feishu#ou_xxx`。
- **自动回复**：飞书是非 aun 渠道，回复由 evolclaw 自动完成，agent 无需调用 `ec msg send`。
