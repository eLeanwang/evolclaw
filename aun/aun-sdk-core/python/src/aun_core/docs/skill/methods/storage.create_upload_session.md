# storage.create_upload_session

获取大文件上传用的 presigned URL。这是三步上传流程的第一步：

1. **调用本方法**获取 `upload_url`
2. 通过 **HTTP PUT** 将文件上传到 `upload_url`
3. 调用 **storage.complete_upload** 确认上传完成

## 调用示例

```python
result = await client.call("storage.create_upload_session", {
    "object_key": "attachments/report.pdf",
    "size_bytes": 5242880,
    "content_type": "application/pdf"
})
upload_url = result["upload_url"]
# 接下来通过 HTTP PUT 上传文件到 upload_url
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `object_key` | string | 是 | — | 对象路径标识 |
| `size_bytes` | integer | 是 | — | 文件大小（字节） |
| `content_type` | string | 否 | `"application/octet-stream"` | MIME 类型 |
| `bucket` | string | 否 | `"default"` | 存储桶名称 |
| `owner_aid` | string | 否 | 当前用户 | 所有者 AID |
| `expected_version` | integer | 否 | — | CAS 版本校验（0=必须不存在，>0=必须匹配） |
| `expire_in_seconds` | integer | 否 | `3600` | URL 有效期（秒） |

## 返回值

```json
{
    "upload_url": "https://storage.example.com/upload?key=...&expire=...&sig=...",
    "expire_at": 1711238167,
    "blob_key": "owner_aid_com/default/attachments/report.pdf",
    "owner_aid": "my-agent.agentid.pub",
    "bucket": "default",
    "object_key": "attachments/report.pdf",
    "content_type": "application/pdf",
    "size_bytes": 5242880
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `upload_url` | string | 预签名上传 URL（HMAC-SHA256 签名），通过 HTTP PUT 上传 |
| `expire_at` | integer | URL 过期时间戳（Unix 秒） |
| `blob_key` | string | 存储后端的对象键 |
| `owner_aid` | string | 对象所有者 AID |
| `bucket` | string | 存储桶名称 |
| `object_key` | string | 对象路径标识 |
| `content_type` | string | MIME 类型 |
| `size_bytes` | integer | 文件大小（字节） |

## 相关方法

- [storage.complete_upload](storage.complete_upload.md) — 确认上传完成（第三步）
- [storage.put_object](storage.put_object.md) — 小文件直接上传（≤64KB）
