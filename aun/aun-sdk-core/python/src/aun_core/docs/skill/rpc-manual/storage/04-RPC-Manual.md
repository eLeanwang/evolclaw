# 存储 — RPC Manual

## 方法索引

### 控制面方法

| 方法 | 说明 |
|------|------|
| [storage.put_object](#storageput_object) | Inline 写入小对象 |
| [storage.get_object](#storageget_object) | Inline 读取小对象 |
| [storage.head_object](#storagehead_object) | 查询元数据 |
| [storage.delete_object](#storagedelete_object) | 删除对象 |
| [storage.list_objects](#storagelist_objects) | 列举对象 |
| [storage.list_prefixes](#storagelist_prefixes) | 列举子目录 |
| [storage.get_quota](#storageget_quota) | 查询配额 |

### 批量 / 扩展方法

| 方法 | 说明 |
|------|------|
| [storage.copy_object](#storagecopy_object) | 复制对象 |
| [storage.append_object](#storageappend_object) | 追加写入 |
| [storage.batch_delete](#storagebatch_delete) | 批量删除 |

### 数据面协调方法

| 方法 | 说明 |
|------|------|
| [storage.create_upload_session](#storagecreate_upload_session) | 申请上传 URL |
| [storage.complete_upload](#storagecomplete_upload) | 确认上传完成 |
| [storage.create_download_ticket](#storagecreate_download_ticket) | 申请下载 URL |

---

## storage.put_object

上传小对象（内容 base64 编码通过 RPC 传输）。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `content` | string | 是 | base64 编码内容 |
| `content_type` | string | 否 | MIME 类型，默认 `"application/octet-stream"` |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |
| `is_private` | boolean | 否 | 是否私有，默认 `true` |
| `overwrite` | boolean | 否 | 是否覆盖已有对象，默认 `true` |
| `expected_version` | integer | 否 | 乐观并发控制版本号 |
| `expire_in_seconds` | integer | 否 | 过期时间（秒），0 表示不过期 |
| `metadata` | object | 否 | 自定义元数据 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象路径 |
| `size_bytes` | integer | 对象大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |
| `updated_at` | integer | 更新时间戳 |

### 示例

```python
import base64

content = base64.b64encode(b"Hello World").decode()
result = await client.call("storage.put_object", {
    "object_key": "notes/hello.txt",
    "content": content,
    "content_type": "text/plain",
})
```

---

## storage.get_object

读取小对象，返回 base64 编码内容。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象路径 |
| `content` | string | base64 编码内容 |
| `content_type` | string | MIME 类型 |
| `size_bytes` | integer | 对象大小（字节） |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `updated_at` | integer | 更新时间戳 |

> **注意**：实现不返回 `etag`（与 put_object/head_object 不同）。

### 示例

```python
result = await client.call("storage.get_object", {
    "object_key": "notes/hello.txt",
})
content = base64.b64decode(result["content"])
```

---

## storage.head_object

查询对象元数据，不返回内容。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象路径 |
| `content_type` | string | MIME 类型 |
| `size_bytes` | integer | 对象大小（字节） |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |
| `is_private` | boolean | 是否私有 |
| `expire_at` | integer | 过期时间戳（0 表示不过期） |
| `created_at` | integer | 创建时间戳 |
| `updated_at` | integer | 更新时间戳 |

---

## storage.delete_object

删除对象。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `deleted` | boolean | 是否成功删除（`false` 表示对象不存在） |
| `owner_aid` | string | 所有者 AID |
| `object_key` | string | 对象路径 |

---

## storage.list_objects

列出对象。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prefix` | string | 否 | 路径前缀过滤 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |
| `page` | integer | 否 | 页码，默认 1 |
| `size` | integer | 否 | 每页条数，默认 50（最大 200） |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `items` | array | 对象元数据列表 |
| `total` | integer | 总条数 |
| `page` | integer | 当前页码 |
| `size` | integer | 每页条数 |

每个 item 包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `object_key` | string | 对象路径 |
| `size_bytes` | integer | 对象大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `is_private` | boolean | 是否私有 |
| `updated_at` | integer | 更新时间戳 |

### 示例

```python
result = await client.call("storage.list_objects", {
    "prefix": "notes/",
    "size": 20,
})
for obj in result["items"]:
    print(f"{obj['object_key']} ({obj['size_bytes']} bytes)")
```

---

## storage.list_prefixes

列出直接子目录（前缀）。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prefix` | string | 否 | 路径前缀过滤 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `prefixes` | string[] | 直接子目录列表 |
| `count` | integer | 子目录数量 |

---

## storage.get_quota

查询存储配额。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `owner_aid` | string | 否 | 查询指定 AID 的配额（默认为当前用户，仅允许查询自己的配额） |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `used_bytes` | integer | 已使用空间（字节） |
| `object_count` | integer | 对象数量 |
| `quota_bytes` | integer | 配额上限（字节），0 表示无限制 |

---

## storage.create_upload_session

获取上传用 presigned URL。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `size_bytes` | integer | 是 | 文件大小（字节） |
| `content_type` | string | 否 | MIME 类型，默认 `"application/octet-stream"` |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |
| `expected_version` | integer | 否 | 乐观并发控制版本号 |
| `expire_in_seconds` | integer | 否 | URL 有效期（秒），默认 3600 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `upload_url` | string | 上传用 presigned URL |
| `blob_key` | string | Blob 存储 key |
| `expire_at` | integer | URL 过期时间戳 |
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象路径 |
| `content_type` | string | MIME 类型 |
| `size_bytes` | integer | 声明的文件大小 |

客户端获得 `upload_url` 后，通过 HTTP PUT 上传文件数据。

---

## storage.complete_upload

完成上传，提交校验信息。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `sha256` | string | 是 | 文件 SHA-256 哈希 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户 |
| `content_type` | string | 否 | MIME 类型，默认 `"application/octet-stream"` |
| `is_private` | boolean | 否 | 是否私有，默认 `true` |
| `size_bytes` | integer | 否 | 预期文件大小（用于校验） |
| `expected_version` | integer | 否 | 乐观并发控制版本号 |
| `expire_in_seconds` | integer | 否 | 过期时间（秒） |
| `metadata` | object | 否 | 自定义元数据 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象路径 |
| `size_bytes` | integer | 对象大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |
| `updated_at` | integer | 更新时间戳 |

---

## storage.create_download_ticket

获取下载 URL。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者 AID，默认当前用户（公开对象可指定其他 AID） |
| `expire_in_seconds` | integer | 否 | URL 有效期（秒），默认 3600 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `download_url` | string | 下载用 presigned URL |
| `expire_at` | integer | URL 过期时间戳 |
| `file_name` | string | 文件名（从 object_key 提取） |
| `size_bytes` | integer | 文件大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |

客户端获得 `download_url` 后，通过 HTTP GET 下载文件。

---

## storage.copy_object

复制对象到新位置。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `src_object_key` | string | 是 | 源对象路径 |
| `dst_object_key` | string | 是 | 目标对象路径 |
| `src_bucket` | string | 否 | 源存储桶，默认 `"default"` |
| `dst_bucket` | string | 否 | 目标存储桶，默认同 `src_bucket` |
| `src_owner_aid` | string | 否 | 源 owner，默认同目标 owner |
| `owner_aid` | string | 否 | 目标 owner，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 目标 owner AID |
| `bucket` | string | 目标存储桶 |
| `object_key` | string | 目标对象路径 |
| `size_bytes` | integer | 对象大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |
| `updated_at` | integer | 更新时间戳 |

---

## storage.append_object

向已有对象追加内容。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_key` | string | 是 | 对象路径 |
| `content` | string | 是 | base64 编码的追加内容 |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `content_type` | string | 否 | MIME 类型，默认 `"application/octet-stream"` |
| `owner_aid` | string | 否 | 所有者，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `owner_aid` | string | 所有者 AID |
| `bucket` | string | 存储桶 |
| `object_key` | string | 对象路径 |
| `size_bytes` | integer | 追加后总大小（字节） |
| `content_type` | string | MIME 类型 |
| `sha256` | string | SHA-256 哈希 |
| `version` | integer | 版本号 |
| `etag` | string | 实体标签 |
| `updated_at` | integer | 更新时间戳 |

---

## storage.batch_delete

批量删除对象。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `object_keys` | array | 是 | 要删除的对象路径列表（最多 100 个） |
| `bucket` | string | 否 | 存储桶，默认 `"default"` |
| `owner_aid` | string | 否 | 所有者，默认当前用户 |

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `deleted` | array | 成功删除的对象路径列表 |
| `deleted_count` | integer | 删除数量 |
| `not_found` | array | 不存在的对象路径列表 |
| `not_found_count` | integer | 不存在数量 |
| `failed` | array | 失败项 `[{"object_key": "...", "error": "..."}]` |
| `failed_count` | integer | 失败数量 |

---

## 事件

### event/storage.object_changed

对象变更时推送。

**Payload**：

```json
{
    "module_id": "storage",
    "action": "put",
    "owner_aid": "alice.agentid.pub",
    "object_key": "notes/hello.txt"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `module_id` | string | 固定 `"storage"` |
| `action` | string | `"put"` 或 `"delete"` |
| `owner_aid` | string | 对象所有者 AID |
| `object_key` | string | 对象路径 |
