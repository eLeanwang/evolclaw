# storage.create_download_ticket

获取对象的预签名下载 URL。获得 `download_url` 后通过 HTTP GET 下载文件。

**访问控制：**
- 公开对象（`is_private=false`）：任意 AID 可获取下载票据
- 私有对象（`is_private=true`）：仅对象所有者可获取，其他 AID 调用将返回权限错误

## 调用示例

```python
# 下载自己的文件
result = await client.call("storage.create_download_ticket", {
    "object_key": "attachments/report.pdf",
})

# 下载其他用户的公开文件
result = await client.call("storage.create_download_ticket", {
    "owner_aid": "demo-msg-sender.agentid.pub",
    "object_key": "shared/data.json",
})

download_url = result["download_url"]
# 通过 HTTP GET 下载文件
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `object_key` | string | 是 | — | 对象路径标识 |
| `owner_aid` | string | 否 | 调用者自身 AID | 对象所有者 AID，下载他人的公开文件时指定 |
| `bucket` | string | 否 | `"default"` | 存储桶名称 |
| `expire_in_seconds` | integer | 否 | `3600` | URL 有效期（秒） |

## 返回值

```json
{
    "download_url": "https://storage.example.com/download?key=...&expire=...&sig=...",
    "expire_at": 1711238167,
    "file_name": "report.pdf",
    "size_bytes": 5242880,
    "content_type": "application/pdf",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb924...",
    "version": 3,
    "etag": "e3b0c44298fc1c149afbf4c8996fb924"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `download_url` | string | 预签名下载 URL（HMAC-SHA256 签名） |
| `expire_at` | integer | URL 过期时间戳（Unix 秒） |
| `file_name` | string | 文件名（从 object_key 提取） |
| `size_bytes` | integer | 文件大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | 文件 SHA-256 校验值 |
| `version` | integer | 对象版本号 |
| `etag` | string | 实体标签（用于缓存校验） |

## 相关方法

- [storage.get_object](storage.get_object.md) — 直接读取小对象内容（≤64KB）
