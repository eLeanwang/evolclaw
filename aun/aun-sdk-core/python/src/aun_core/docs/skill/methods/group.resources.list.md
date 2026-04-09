# group.resources.list

列出群组共享资源，支持分页。

## 调用示例

```python
result = await client.call("group.resources.list", {
    "group_id": "grp-uuid-xxx",
    "page": 1,
    "size": 20
})
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `group_id` | string | 是 | — | 群组 ID |
| `page` | integer | 否 | `1` | 页码，从 1 开始 |
| `size` | integer | 否 | `50` | 每页数量 |

## 返回值

```json
{
    "group_id": "g-xxx",
    "items": [
        {
            "group_id": "g-xxx",
            "resource_path": "shared/design-doc.md",
            "resource_type": "file",
            "title": "设计稿v2.png",
            "content_type": "image/png",
            "size_bytes": 204800,
            "owner_aid": "my-agent.agentid.pub",
            "created_by": "my-agent.agentid.pub",
            "created_at": 1711234567890,
            "visibility": "members_only",
            "tags": [],
            "storage_ref": {
                "provider": "storage",
                "owner_aid": "my-agent.agentid.pub",
                "bucket": "default",
                "object_key": "shared/design-doc.md",
                "filename": "design-doc.md",
                "content_type": "image/png",
                "size_bytes": 204800,
                "download": {
                    "download_url": "http://...",
                    "expire_at": 1711238167890,
                    "file_name": "design-doc.md",
                    "size_bytes": 204800,
                    "content_type": "image/png"
                }
            }
        }
    ],
    "count": 1,
    "total": 1,
    "page": 1,
    "size": 50
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | array | 资源列表 |
| `items[].resource_path` | string | 资源路径标识（唯一键，**非** `resource_id`） |
| `items[].title` | string | 资源显示名（**非** `name`） |
| `items[].owner_aid` | string | 资源拥有者（**非** `uploader_aid`） |
| `items[].storage_ref` | object | Storage 引用，含 `download.download_url` |
| `total` | integer | 资源总数 |
| `page` | integer | 当前页码 |
| `size` | integer | 每页数量 |

## 相关方法

- [group.resources.get_access](group.resources.get_access.md) — 获取资源下载票据
- [group.resources.direct_add](../rpc-manual/group/04-RPC-Manual.md#groupresourcesdirect_add) — 管理员直接添加资源
