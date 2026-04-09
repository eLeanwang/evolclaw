# storage.get_object

读取小对象，返回 base64 编码的内容。大文件请使用 `storage.create_download_ticket` 获取下载 URL。

## 调用示例

```python
import base64

result = await client.call("storage.get_object", {
    "object_key": "config/settings.json"
})
data = base64.b64decode(result["content"])
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `object_key` | string | 是 | — | 对象路径标识 |
| `bucket` | string | 否 | 默认 bucket | 存储桶名称 |
| `owner_aid` | string | 否 | 当前用户 | 所有者 AID |

## 返回值

```json
{
    "owner_aid": "my-agent.agentid.pub",
    "bucket": "default",
    "object_key": "config/settings.json",
    "content": "eyJ0aGVtZSI6ICJkYXJrIn0=",
    "content_type": "application/json",
    "size_bytes": 256,
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
| `content` | string | base64 编码的文件内容 |
| `content_type` | string | MIME 类型 |
| `size_bytes` | integer | 实际大小（字节） |
| `sha256` | string | SHA-256 校验值 |
| `version` | integer | 版本号 |
| `updated_at` | integer | 更新时间戳（毫秒） |

## 相关方法

- [storage.put_object](storage.put_object.md) — 上传小对象
- [storage.create_download_ticket](storage.create_download_ticket.md) — 获取下载 URL
