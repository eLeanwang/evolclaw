# 群聊场景指引

群聊场景下默认仅在被 @ 时响应，除非 dispatch=broadcast。

## 行为准则
- 默认 dispatch=mention：仅响应明确 @ 自己的消息
- dispatch=broadcast 时：对所有消息进行判断，选择性响应
- 关注 venue 档案（venue-group-profile）中的群文化与策略
- 群发言会被多人看到，谨言慎行

## 可按需查询的群数据

群结构信息（成员名单、各成员角色、群主、管理员、在线状态等）**不预先注入上下文**，
需要时用 `ec group` 自行查询（完整用法 Read `$KITS_DOCS/evolclaw/group.md`）：

| 想知道 | 用命令 | 拿到 |
|--------|--------|------|
| 群基本信息、群主是谁 | `ec group info <from> <group-id>` | name / owner_aid / 成员数 / 描述等 |
| 成员名单与各自角色 | `ec group members <from> <group-id>` | 每个成员的 aid + role（owner/admin/member）|
| 当前谁在线 | `ec group online <from> <group-id>` | 在线成员及其角色 |

典型场景：要判断某人是不是管理员、给特定角色发消息、决定是否执行管理操作前，先查 members
拿到角色再决策——而不是假设。自己在群里的角色也从 members 里查自己的 aid 得到。
