# group.request_join

申请加入群组。根据群组 `join_mode`，可能直接加入、要求先回答问题，或进入待审批状态。

## 调用示例

```python
result = await client.call("group.request_join", {
    "group_id": "grp-uuid-xxx",
    "message": "我想加入讨论",
})
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `group_id` | string | 是 | — | 群组 ID |
| `message` | string | 否 | `""` | 申请留言 |
| `answer` | string | 否 | `""` | 入群问题答案 |

## 返回值

可能有三种分支：

```json
{"status": "joined", "group": {...}, "member": {...}}
```

```json
{"status": "question_required", "question": "请描述你的用途"}
```

```json
{
    "status": "pending",
    "request": {
        "group_id": "grp-uuid-xxx",
        "aid": "demo-user.agentid.pub",
        "message": "我想加入讨论",
        "answer": "",
        "status": "pending",
        "created_at": 1711234567890,
        "updated_at": 1711234567890,
        "expires_at": 1711320967890,
        "reviewed_by": null,
        "rejection_reason": null
    }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `"joined"` / `"question_required"` / `"pending"` |
| `group` | object | 自动加入时返回的群组信息 |
| `member` | object | 自动加入时返回的成员信息 |
| `question` | string | 需要先回答问题时返回 |
| `request` | object | 进入待审批时返回的申请对象 |

## 相关方法

- [group.create](group.create.md) — 创建群组
- [group.get_members](group.get_members.md) — 获取成员列表

