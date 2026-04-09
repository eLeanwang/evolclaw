# AUN Group vs ACP Group 功能对比

> 本文档对照 `D:/apserver/au_server/group`（ACP Group，Go 实现）与
> `D:/modelunion/kite/extensions/services/group`（AUN Group，Python 实现）的功能差异。
> AUN Group 是参考 ACP Group 设计的，但部分功能尚未实现。

---

## 一、核心消息机制差异

| 维度 | ACP Group | AUN Group |
|---|---|---|
| 消息路由方式 | 客户端向 `group.{issuer}` AID 发 ACP 消息，Group 服务作为 AID 接收处理 | 客户端直接 RPC 调用 `group.send`，Group 服务直接处理 |
| 在线成员实时推送 | `forwardMessageToOnlineMembers` — 遍历在线成员逐一推送，支持 BatchPusher + Redis | `_flush_push_queue` — 有推送队列，通过 Kernel 事件系统推送 |
| 批量推送 | `BatchMessagePusher`，可配置批量大小和延迟 | 无独立批量推送器 |
| 事件流 | `pull_events` + `ack_events`（独立事件流，与消息流分离，双游标） | 无独立事件流，事件通过 Kernel 事件系统推送 |

---

## 二、AUN Group 缺失或未接入的功能

### 1. 事件游标接口缺失

ACP Group 有独立的事件流增量拉取接口：

| ACP 方法 | 说明 | AUN 状态 |
|---|---|---|
| `pull_events` | 增量拉取群事件流 | ❌ 缺失 |
| `ack_events` | 确认事件游标 | ❌ 缺失 |
| `get_cursor` | 查询消息/事件双游标 | ❌ 缺失 |

AUN Group 只有 `pull`（返回消息+事件混合）和 `ack`（只确认消息游标），没有独立事件确认接口。
参考：`entry.py:977`、`service.py:1284`

### 2. 在线状态写接口未接入

`module.md:63` 已文档化，但主路由未挂载：

| ACP 方法 | 说明 | AUN 状态 |
|---|---|---|
| `register_online` | 注册在线状态 | ⚠️ 文档有，代码未接入路由 |
| `heartbeat` | 在线心跳 | ⚠️ 文档有，代码未接入路由 |
| `unregister_online` | 注销在线状态 | ⚠️ 文档有，代码未接入路由 |
| `get_online_members` | 查询在线成员 | ✅ 已实现（`entry.py:1015`） |

### 3. 管理辅助查询接口缺失

| ACP 方法 | 说明 | AUN 状态 |
|---|---|---|
| `get_admins` | 独立查询管理员列表 | ❌ 缺失（可通过 `get_members` 过滤替代） |
| `get_master` | 独立查询群主 | ❌ 缺失（可通过 `get` 获取群信息替代） |

### 4. 摘要/统计类接口缺失

| ACP 方法 | 说明 | AUN 状态 |
|---|---|---|
| `generate_digest` | 生成消息摘要（AI 总结） | ❌ 缺失 |
| `get_digest` | 获取已生成的摘要 | ❌ 缺失 |
| `get_summary` | 群组综合统计摘要 | ❌ 缺失 |
| `get_metrics` | 群组性能指标 | ❌ 缺失 |

AUN Group 只有 `get_stats`、`get_checksum`、`get_message_checksum`，见 `entry.py:1029`。

### 5. 值班辅助快捷接口缺失

| ACP 方法 | 说明 | AUN 状态 |
|---|---|---|
| `set_fixed_agents` | 设置固定值班 Agent | ❌ 缺失 |
| `refresh_member_types` | 刷新成员类型分类 | ❌ 缺失 |

AUN Group 有通用的 `update_duty_config`、`transfer_duty`、`get_duty_status`，但缺少这两个快捷动作，见 `entry.py:1032`。

---

## 三、命名差异（非缺失，已有等价实现）

| ACP 方法 | AUN 等价方法 | 说明 |
|---|---|---|
| `remove_member` | `kick` | 踢出成员 |
| `change_member_role` | `set_role` | 修改成员角色 |
| `transfer_master` | `transfer_owner` | 转让群主 |
| `get_pending_requests` | `list_join_requests`（默认 pending） | 待审核入群申请 |
| `search_groups` | `search` | 群组搜索 |
| `dissolve_group` | `dissolve` | 解散群组 |
| `leave_group` | `leave` | 退出群组 |

---

## 四、AUN Group 新增（ACP 没有的）

| AUN 方法 | 说明 |
|---|---|
| `resources.*`（get_access、list、upload、download 等） | 群组资源管理（文件/链接），ACP 无此功能 |
| `e2ee_rotate_epoch` / `e2ee_get_epoch` | Group E2EE 加密 epoch 管理 |
| `update_announcement` | 群公告更新 |
| `get_join_requirements` / `update_join_requirements` | 入群条件管理 |
| `batch_review_join_request` | 批量审核入群申请 |
| `create_invite_code` / `use_invite_code` / `list_invite_codes` / `revoke_invite_code` | 邀请码管理（ACP 也有，AUN 更完整） |

---

## 五、优先级建议

| 优先级 | 功能 | 原因 |
|---|---|---|
| 高 | 在线状态写接口（register_online / heartbeat / unregister_online）接入路由 | 文档已有，只差代码挂载，影响在线推送准确性 |
| 中 | 独立事件游标（pull_events / ack_events / get_cursor） | 多设备场景下事件与消息分离拉取的需求 |
| 低 | 摘要/统计接口（generate_digest / get_summary） | AI 辅助功能，可后续迭代 |
| 低 | 值班快捷接口（set_fixed_agents / refresh_member_types） | 特定场景需求 |
| 可选 | get_admins / get_master 独立接口 | 现有接口可替代，优先级最低 |
