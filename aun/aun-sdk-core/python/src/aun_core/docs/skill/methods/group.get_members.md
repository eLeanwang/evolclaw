# group.get_members

获取群组成员列表。支持分页和角色过滤。

## 调用示例

```python
result = await client.call("group.get_members", {
    "group_id": "grp-uuid-xxx",
    "page": 1,
    "size": 50,
})

for member in result["members"]:
    print(member["aid"], member["role"])
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `group_id` | string | 是 | — | 群组 ID |
| `page` | integer | 否 | 1 | 页码 |
| `size` | integer | 否 | 50 | 每页条数（最大 200） |
| `role` | string | 否 | — | 按角色过滤（owner/admin/member） |

## 返回值

```json
{
    "group_id": "grp-uuid-xxx",
    "members": [
        {
            "group_id": "grp-uuid-xxx",
            "aid": "demo-owner.agentid.pub",
            "role": "owner",
            "member_type": "human",
            "joined_at": 1711234567890,
            "last_ack_seq": 100,
            "last_pull_at": 1711234567999
        }
    ],
    "total": 1,
    "count": 1,
    "page": 1,
    "size": 50
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `group_id` | string | 群组 ID |
| `members` | array | 成员列表 |
| `members[].aid` | string | 成员 AID |
| `members[].role` | string | 成员角色 |
| `members[].member_type` | string | 成员类型 |
| `members[].joined_at` | integer | 入群时间戳 |
| `members[].last_ack_seq` | integer | 最后确认到的消息序列号 |
| `members[].last_pull_at` | integer | 最后拉取时间戳 |
| `total` | integer | 总成员数 |
| `count` | integer | 本次返回的成员数 |

## 相关方法

- [group.add_member](group.add_member.md) — 添加成员
- [group.request_join](group.request_join.md) — 申请加入

