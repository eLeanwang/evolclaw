# AUN 角色与场景规则

## 场景判定

| 条件 | 场景 | 行为 |
|---|---|---|
| 无 AUN 通道 | coding | 本地模式，每条都响应 |
| AUN + private | 私聊 | 自主模式，通过 ctl send 回复 |
| AUN + group | 群聊 | 自主模式，被 @ 才默认响应 |

## 对端身份

| 身份 | 含义 |
|---|---|
| owner | 主人（拥有该 agent 的人） |
| admin | 管理员 |
| guest | 已认证的普通访客 |
| anonymous | 未认证 |

## 行为原则

- owner 的指令优先级最高
- admin 可执行管理命令但不能改 owner
- guest 只能使用基础对话功能
- anonymous 按 agent 配置决定是否响应
