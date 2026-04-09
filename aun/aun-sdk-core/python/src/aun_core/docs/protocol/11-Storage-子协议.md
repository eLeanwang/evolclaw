# 11. Storage 子协议

> **适用版本**：AUN 1.0 | **状态**：Draft

Storage 服务是 AUN 协议的应用层扩展，提供对象存储能力。负责大文件、附件、二进制数据的上传、下载与持久保存。客户端通过 `storage.*` 命名空间方法访问，小对象（≤64KB）通过 RPC 内联传输，大对象通过预签名 URL 直接 HTTP 传输。

---

## 11.1 设计原则

- **控制面与数据面分离**：小对象内联 RPC；大对象通过 `create_upload_session` / `create_download_ticket` 获取预签名 URL，走 HTTP 数据面
- **per-AID 隔离**：每个 AID 拥有独立的存储命名空间和配额，跨 AID 访问受 `is_private` 控制
- **对象键路径化**：`object_key` 支持 `/` 分隔的层级路径，便于组织和前缀查询
- **版本化**：每次写入递增 `version`，支持 `expected_version` 做 CAS（Compare-And-Swap）并发控制

---

## 11.2 约束与限制

| 约束 | 默认值 | 说明 |
|------|--------|------|
| 内联内容上限 | 64 KB | `put_object` / `get_object` 的 base64 内容上限 |
| 单对象上限 | 10 MB | 含数据面上传 |
| 对象键长度 | ≤ 1024 字节 | 不含 `..`，不含前导/尾随/连续 `/` |
| 列表分页上限 | 200 条/页 | `list_objects` 单次最大返回 |
| 批量删除上限 | 100 个/次 | `batch_delete` |
| 预签名 URL 有效期 | 3600 秒 | upload / download ticket |

对象键合法字符：字母、数字、`.`、`_`、`/`、`-`。

---

## 11.3 控制面方法

### `storage.put_object`

内联写入小对象（≤ 内联上限）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_key` | string | ✅ | 对象路径 |
| `content` | string | ✅ | base64 编码的内容 |
| `content_type` | string | ❌ | MIME 类型，默认 `application/octet-stream` |
| `is_private` | boolean | ❌ | 默认 `true`，公开对象可被其他 AID 读取 |
| `overwrite` | boolean | ❌ | 默认 `true`，`false` 时对象已存在则拒绝 |
| `expected_version` | integer | ❌ | CAS 并发控制，版本不匹配则拒绝 |
| `expire_in_seconds` | integer | ❌ | 过期时间，`0` 表示永不过期 |
| `metadata` | object | ❌ | 用户自定义元数据 |

**响应**：`{ owner_aid, bucket, object_key, size_bytes, content_type, sha256, version, etag, updated_at }`

**权限**：仅对象所有者可写（`requester_aid == owner_aid`）。

**副作用**：成功后发布 `event/storage.object_changed`（`action: "put"`）。

### `storage.get_object`

内联读取小对象。对象超过内联上限时须使用 `create_download_ticket`。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_key` | string | ✅ | 对象路径 |

**响应**：`{ owner_aid, bucket, object_key, content (base64), content_type, size_bytes, sha256, version, updated_at }`

**权限**：私有对象仅所有者可读；公开对象（`is_private=false`）任何 AID 可读。

### `storage.head_object`

查询对象元数据，不返回内容。

**参数**：同 `get_object`。

**响应**：`{ owner_aid, bucket, object_key, content_type, size_bytes, sha256, version, etag, is_private, expire_at, created_at, updated_at }`

**权限**：同 `get_object`。

### `storage.delete_object`

删除单个对象。

**参数**：同 `get_object`。

**响应**：`{ deleted (bool), owner_aid, object_key }`

**权限**：仅所有者可删。

**副作用**：成功后发布 `event/storage.object_changed`（`action: "delete"`）。

### `storage.list_objects`

列出对象，支持前缀过滤和分页。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `prefix` | string | ❌ | 路径前缀过滤 |
| `page` | integer | ❌ | 页码，默认 1 |
| `size` | integer | ❌ | 每页条数，默认 50，最大 200 |

**响应**：`{ items: [{ object_key, size_bytes, content_type, sha256, version, is_private, updated_at }...], total, page, size }`

**权限**：仅所有者可列。

### `storage.list_prefixes`

列出指定前缀下的子目录（类似 S3 CommonPrefixes）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `prefix` | string | ❌ | 路径前缀 |

**响应**：`{ prefixes: [string...], count }`

**权限**：仅所有者可列。

### `storage.get_quota`

查询存储配额使用情况。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |

**响应**：`{ owner_aid, used_bytes, object_count, quota_bytes }`

**权限**：仅所有者可查。

---

## 11.4 批量与扩展方法

### `storage.copy_object`

复制对象。支持同 AID 内复制和跨 AID 复制（源对象须为公开）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 目标所有者，默认调用者 AID |
| `src_owner_aid` | string | ❌ | 源所有者，默认同 `owner_aid` |
| `src_bucket` | string | ❌ | 源 bucket，默认 `"default"` |
| `src_object_key` | string | ✅ | 源对象路径 |
| `dst_bucket` | string | ❌ | 目标 bucket，默认同源 |
| `dst_object_key` | string | ✅ | 目标对象路径 |

**响应**：`{ owner_aid, bucket, object_key, size_bytes, content_type, sha256, version, etag, updated_at }`

**权限**：目标所有者必须是调用者；跨 AID 复制时源对象必须为公开。

### `storage.append_object`

追加写入。对象不存在时创建。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_key` | string | ✅ | 对象路径 |
| `content` | string | ✅ | base64 编码的追加内容 |
| `content_type` | string | ❌ | 默认 `application/octet-stream` |

**响应**：`{ owner_aid, bucket, object_key, size_bytes, content_type, sha256, version, etag, updated_at }`

**权限**：仅所有者可写。

### `storage.batch_delete`

批量删除对象（best-effort，单个失败不影响其余）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_keys` | array | ✅ | 对象路径列表（最多 100 个） |

**响应**：`{ deleted: [keys...], deleted_count, not_found: [keys...], not_found_count, failed: [{ object_key, error }...], failed_count }`

**权限**：仅所有者可删。

---

## 11.5 数据面方法

用于超过内联上限的大对象传输。客户端通过 RPC 获取预签名 URL，然后直接 HTTP PUT/GET。

### `storage.create_upload_session`

申请上传预签名 URL。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_key` | string | ✅ | 对象路径 |
| `size_bytes` | integer | ❌ | 预期大小（客户端追踪用） |
| `content_type` | string | ❌ | 默认 `application/octet-stream` |
| `expected_version` | integer | ❌ | CAS 版本检查（签 URL 前校验） |
| `expire_in_seconds` | integer | ❌ | URL 有效期，默认 3600 秒 |

**响应**：`{ upload_url, blob_key, expire_at, owner_aid, bucket, object_key, content_type, size_bytes }`

**权限**：仅所有者可申请。

**流程**：客户端获取 `upload_url` 后，直接 HTTP PUT 上传文件内容，完成后调用 `complete_upload` 确认。

### `storage.complete_upload`

确认上传完成，将 blob 关联为正式对象。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_key` | string | ✅ | 对象路径 |
| `content_type` | string | ❌ | 默认 `application/octet-stream` |
| `is_private` | boolean | ❌ | 默认 `true` |
| `sha256` | string | ❌ | 期望哈希，服务端校验 |
| `size_bytes` | integer | ❌ | 期望大小，服务端校验 |
| `expire_in_seconds` | integer | ❌ | 过期时间，默认永不过期 |
| `metadata` | object | ❌ | 用户自定义元数据 |
| `expected_version` | integer | ❌ | CAS 并发控制 |

**响应**：`{ owner_aid, bucket, object_key, size_bytes, content_type, sha256, version, etag, updated_at }`

**权限**：仅所有者可确认。

### `storage.create_download_ticket`

申请下载预签名 URL。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `owner_aid` | string | ❌ | 默认调用者 AID |
| `bucket` | string | ❌ | 默认 `"default"` |
| `object_key` | string | ✅ | 对象路径 |
| `expire_in_seconds` | integer | ❌ | URL 有效期，默认 3600 秒 |

**响应**：`{ download_url, expire_at, file_name, size_bytes, content_type, sha256, version, etag }`

**权限**：私有对象仅所有者；公开对象任何 AID 可申请。

---

## 11.6 事件

### `event/storage.object_changed`

对象变更时推送给所有者。

```json
{
  "jsonrpc": "2.0",
  "method": "event/storage.object_changed",
  "params": {
    "module_id": "storage",
    "action": "put",
    "owner_aid": "alice.aid.pub",
    "object_key": "docs/report.pdf"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | string | `"put"` 或 `"delete"` |
| `owner_aid` | string | 对象所有者 AID |
| `object_key` | string | 变更的对象路径 |

---

## 11.7 错误码

| 错误码 | 含义 | 说明 |
|--------|------|------|
| -32008 | Object not found | 对象不存在 |
| -32009 | Version conflict | CAS 版本不匹配 |
| -32004 | Permission denied | 非所有者访问私有对象 |

---

## 11.8 大对象上传流程

```
客户端                          Storage 服务                    HTTP 数据面
  │                                │                              │
  │─ storage.create_upload_session ►│                              │
  │◄─ { upload_url, blob_key }  ───│                              │
  │                                │                              │
  │─────────── HTTP PUT upload_url ─────────────────────────────► │
  │◄──────────────── 200 OK ─────────────────────────────────────│
  │                                │                              │
  │─ storage.complete_upload ─────►│                              │
  │◄─ { object_key, sha256, ... } ─│                              │
```

大对象下载流程类似：`create_download_ticket` 获取 `download_url`，客户端直接 HTTP GET。
