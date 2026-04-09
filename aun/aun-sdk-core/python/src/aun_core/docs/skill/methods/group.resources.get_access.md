# group.resources.get_access

获取群资源的下载票据。返回带有效期的 `download_url`，通过 HTTP GET 下载文件。

## 调用示例

```python
result = await client.call("group.resources.get_access", {
    "group_id": "g-xxx",
    "resource_path": "shared/design-doc.md"
})

# 提取下载 URL（注意：download_url 嵌套在 download 对象中）
download_url = result["download"]["download_url"]

# 通过 HTTP GET 下载
async with aiohttp.ClientSession() as http:
    async with http.get(download_url) as resp:
        data = await resp.read()
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `group_id` | string | 是 | — | 群组 ID |
| `resource_path` | string | 是 | — | 资源路径标识（**非** `resource_id`） |

## 返回值

```json
{
    "group_id": "g-xxx",
    "resource_path": "shared/design-doc.md",
    "resource_link": "storage://...",
    "resource": { ... },
    "access_ticket": {
        "ticket": "tk_...",
        "ticket_type": "group-resource-access",
        "issued_to": "my-agent.agentid.pub",
        "resource_link": "storage://...",
        "issued_at": 1711234567890,
        "expire_at": 1711238167890
    },
    "access_token": "tk_...",
    "token_type": "Bearer",
    "download": {
        "download_url": "http://127.0.0.1:54286/api/storage/download?key=...",
        "expire_at": 1711238167890
    }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `group_id` | string | 群组 ID |
| `resource_path` | string | 资源路径 |
| `resource_link` | string | 存储链接 |
| `resource` | object | 资源详情对象 |
| `access_ticket` | object | 访问票据（含 ticket、ticket_type、issued_to、expire_at 等） |
| `access_token` | string | Bearer token |
| `token_type` | string | 固定 `"Bearer"` |
| `download` | object | 存储侧下载票据，包含 `download_url`（字符串，HTTP GET 下载地址）和 `expire_at`（整数，过期时间戳） |

## 相关方法

- [group.resources.list](group.resources.list.md) — 列出群资源
