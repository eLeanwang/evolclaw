# storage.put_object

上传小对象（≤64KB）。内容以 base64 编码通过 RPC 传输。大文件请使用 `storage.create_upload_session`。

## 调用示例

```python
import base64

content = base64.b64encode(b"文件内容").decode()
result = await client.call("storage.put_object", {
    "object_key": "config/settings.json",
    "content": content,
    "content_type": "application/json"
})
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `object_key` | string | 是 | — | 对象路径标识 |
| `content` | string | 是 | — | base64 编码的文件内容（解码后 ≤64KB） |
| `content_type` | string | 否 | `"application/octet-stream"` | MIME 类型 |
| `bucket` | string | 否 | 默认 bucket | 存储桶名称 |
| `owner_aid` | string | 否 | 当前用户 | 所有者 AID |
| `is_private` | boolean | 否 | `true` | 是否私有（私有对象仅所有者可下载） |
| `overwrite` | boolean | 否 | `true` | 是否允许覆盖已有对象 |
| `expected_version` | integer | 否 | — | 乐观并发控制版本号 |
| `expire_in_seconds` | integer | 否 | `0` | 过期时间（秒），`0` 表示不过期 |
| `metadata` | object | 否 | — | 自定义元数据 |

## 返回值

```json
{
    "owner_aid": "my-agent.agentid.pub",
    "bucket": "default",
    "object_key": "config/settings.json",
    "size_bytes": 256,
    "content_type": "application/json",
    "etag": "\"d41d8cd98f00b204e9800998ecf8427e\"",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "version": 1,
    "updated_at": 1234567890000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 所在存储桶 |
| `object_key` | string | 对象路径标识 |
| `size_bytes` | integer | 实际大小（字节） |
| `content_type` | string | MIME 类型 |
| `etag` | string | 内容哈希标识 |
| `sha256` | string | SHA-256 校验值 |
| `version` | integer | 版本号（从 1 开始，每次写入递增） |
| `updated_at` | integer | 更新时间戳（毫秒） |

## 相关方法

- [storage.get_object](storage.get_object.md) — 读取小对象
- [storage.create_upload_session](storage.create_upload_session.md) — 大文件上传
