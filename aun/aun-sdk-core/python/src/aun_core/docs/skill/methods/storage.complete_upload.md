# storage.complete_upload

完成大文件上传流程的第三步。调用方在获得 `upload_url` 并通过 HTTP PUT 上传文件后，必须调用本方法提交校验信息并落库元数据。

## 调用示例

```python
import hashlib

data = b"binary-data"
sha = hashlib.sha256(data).hexdigest()

result = await client.call("storage.complete_upload", {
    "object_key": "attachments/report.pdf",
    "sha256": sha,
    "size_bytes": len(data),
    "content_type": "application/pdf",
    "is_private": False,
})
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `object_key` | string | 是 | — | 对象路径标识 |
| `sha256` | string | 是 | — | 文件 SHA-256 哈希 |
| `bucket` | string | 否 | `"default"` | 存储桶名称 |
| `owner_aid` | string | 否 | 当前用户 | 所有者 AID |
| `content_type` | string | 否 | `"application/octet-stream"` | MIME 类型 |
| `is_private` | boolean | 否 | `true` | 是否私有 |
| `size_bytes` | integer | 否 | — | 预期文件大小（用于校验） |
| `expected_version` | integer | 否 | — | 乐观并发控制版本号 |
| `expire_in_seconds` | integer | 否 | `0` | 对象过期时间（秒），`0` 表示不过期 |
| `metadata` | object | 否 | — | 自定义元数据 |

## 返回值

```json
{
    "owner_aid": "my-agent.agentid.pub",
    "bucket": "default",
    "object_key": "attachments/report.pdf",
    "size_bytes": 5242880,
    "content_type": "application/pdf",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb924...",
    "version": 1,
    "etag": "\"abc123\"",
    "updated_at": 1711234567890
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶名称 |
| `object_key` | string | 对象路径标识 |
| `size_bytes` | integer | 对象大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 校验值 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |
| `updated_at` | integer | 更新时间戳（毫秒） |

## 相关方法

- [storage.create_upload_session](storage.create_upload_session.md) — 获取上传 URL（第一步）
- [storage.put_object](storage.put_object.md) — 小文件直接上传（≤64KB）
