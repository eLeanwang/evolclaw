# storage.list_objects

列出对象元数据。适合做文件浏览、前缀扫描和下载前检查。

## 调用示例

```python
result = await client.call("storage.list_objects", {
    "prefix": "demo/",
    "size": 20,
})

for obj in result["items"]:
    print(obj["object_key"], obj["size_bytes"])
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prefix` | string | 否 | `""` | 路径前缀过滤 |
| `bucket` | string | 否 | `"default"` | 存储桶名称 |
| `owner_aid` | string | 否 | 当前用户 | 所有者 AID |
| `page` | integer | 否 | `1` | 页码 |
| `size` | integer | 否 | `50` | 每页条数，最大 200 |

## 返回值

```json
{
    "items": [
        {
            "object_key": "demo/readme.txt",
            "size_bytes": 16,
            "content_type": "text/plain",
            "sha256": "e3b0c44298fc1c149afbf4c8996fb924...",
            "version": 1,
            "is_private": false,
            "updated_at": 1711234567890
        }
    ],
    "total": 1,
    "page": 1,
    "size": 50
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | array | 对象元数据列表 |
| `items[].object_key` | string | 对象路径 |
| `items[].size_bytes` | integer | 对象大小（字节） |
| `items[].content_type` | string | MIME 类型 |
| `items[].sha256` | string | SHA-256 校验值 |
| `items[].version` | integer | 版本号 |
| `items[].is_private` | boolean | 是否私有 |
| `items[].updated_at` | integer | 更新时间戳 |
| `total` | integer | 总条数 |
| `page` | integer | 当前页码 |
| `size` | integer | 每页条数 |

## 相关方法

- [storage.get_object](storage.get_object.md) — 读取小对象
- [storage.create_download_ticket](storage.create_download_ticket.md) — 获取下载 URL
- [storage.put_object](storage.put_object.md) — 上传小对象
