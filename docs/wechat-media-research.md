# WeChat ilink 媒体收发 API 研究

> 基于官方 SDK `@tencent-weixin/openclaw-weixin@2.0.1` 源码验证

## 1. 支持的媒体类型

| type | 类型 | 上传枚举 (UploadMediaType) | 消息枚举 (MessageItemType) |
|------|------|---------------------------|--------------------------|
| 文本 | TEXT | - | 1 |
| 图片 | IMAGE | 1 | 2 |
| 语音 | VOICE | 4 | 3 |
| 文件 | FILE | 3 | 4 |
| 视频 | VIDEO | 2 | 5 |

**注意**：上传枚举和消息枚举的编号不一致（视频/文件/语音的值不同）。

## 2. CDN 地址

```typescript
// src/auth/accounts.ts
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
```

SDK v2.0.1 使用 `novac2c.cdn.weixin.qq.com/c2c`，非 `cdn.weixinbridge.com`。

## 3. TypeScript 接口（SDK 源码）

### CDNMedia

```typescript
interface CDNMedia {
  encrypt_query_param?: string;  // CDN 下载/上传凭证
  aes_key?: string;              // Base64 编码的 AES key
  encrypt_type?: number;         // 0=只加密fileid, 1=打包缩略图等信息
}
```

### ImageItem

```typescript
interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;        // hex 字符串 (32字符)，优先于 media.aes_key
  url?: string;
  mid_size?: number;      // 中图密文大小
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}
```

### FileItem

```typescript
interface FileItem {
  media?: CDNMedia;
  file_name?: string;     // 原始文件名
  md5?: string;
  len?: string;           // 明文大小（字符串类型）
}
```

### VideoItem

```typescript
interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}
```

### VoiceItem

```typescript
interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;   // 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;      // 播放时长 (ms)
  text?: string;          // 语音转文字
}
```

### GetUploadUrlReq / GetUploadUrlResp

```typescript
interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;         // UploadMediaType: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE
  to_user_id?: string;
  rawsize?: number;            // 明文大小
  rawfilemd5?: string;         // 明文 MD5
  filesize?: number;           // 密文大小 (PKCS7 padded)
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;     // SDK 默认 true
  aeskey?: string;             // hex 编码（32字符）
}

interface GetUploadUrlResp {
  upload_param?: string;       // 上传凭证
  thumb_upload_param?: string;
}
```

## 4. 接收媒体（CDN 下载流程）

### 4.1 URL 构造

```typescript
function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
```

CDN 下载是纯 `fetch(url)` GET 请求，**不需要 Bearer token 或特殊 header**。

### 4.2 AES Key 解析

SDK 的 `parseAesKey` 支持两种编码格式：

```typescript
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;           // Case 1: base64(原始 16 字节)
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii")))
    return Buffer.from(decoded.toString("ascii"), "hex"); // Case 2: base64(hex 字符串)
  throw new Error(`Invalid aes_key: expected 16 bytes or 32 hex chars, got ${decoded.length}`);
}
```

### 4.3 图片 Key 优先级

图片的 AES key 有特殊处理：

```typescript
const aesKeyBase64 = img.aeskey
  ? Buffer.from(img.aeskey, "hex").toString("base64")  // ImageItem.aeskey (hex) 优先
  : img.media.aes_key;                                  // CDNMedia.aes_key 兜底
```

如果两者都没有 → 明文下载（不加密）。

### 4.4 AES-128-ECB 解密

所有媒体使用 AES-128-ECB + PKCS7 padding：

```typescript
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

### 4.5 各媒体类型下载逻辑

| 类型 | AES Key 来源 | 备注 |
|------|-------------|------|
| 图片 | `image_item.aeskey` (hex) > `media.aes_key` | 无 key 时明文下载 |
| 语音 | `voice_item.media.aes_key` | 有 `text` 字段时跳过下载（用转写文本） |
| 文件 | `file_item.media.aes_key` | MIME 从 `file_name` 推断 |
| 视频 | `video_item.media.aes_key` | 保存为 `video/mp4` |

### 4.6 媒体优先级

SDK 处理入站消息时，按以下优先级选取第一个媒体：IMAGE > VIDEO > FILE > VOICE。

## 5. 发送媒体（CDN 上传流程）

### 5.1 完整流程

```
1. 读取文件 → 计算 MD5 + 大小
2. 生成随机 AES key (16字节) + filekey (16字节 hex)
3. POST /ilink/bot/getuploadurl → 获取 upload_param
4. AES-128-ECB 加密文件
5. POST CDN/upload → 获取 x-encrypted-param 响应头
6. POST /ilink/bot/sendmessage → 带 CDNMedia 引用
```

### 5.2 getuploadurl 请求

```
POST {baseUrl}/ilink/bot/getuploadurl
Authorization: Bearer {token}

{
  "filekey": "<随机 32 字符 hex>",
  "media_type": 1,              // UploadMediaType
  "to_user_id": "<收件人>",
  "rawsize": 248731,            // 明文字节数
  "rawfilemd5": "<明文 MD5 hex>",
  "filesize": 248736,           // 密文字节数
  "no_need_thumb": true,
  "aeskey": "<16字节 key 的 hex 编码>",
  "base_info": { "channel_version": "2.0.1" }
}
```

密文大小计算：`Math.ceil((rawsize + 1) / 16) * 16`

### 5.3 CDN 上传

```
POST {CDN_BASE_URL}/upload?encrypted_query_param={upload_param}&filekey={filekey}
Content-Type: application/octet-stream
Body: <AES-128-ECB 加密后的字节流>

响应头: x-encrypted-param → 用于后续下载的凭证
```

CDN 上传**不需要 Bearer token**，通过 `encrypted_query_param` 鉴权。

重试策略：最多 3 次，4xx 立即失败，5xx/网络错误重试。

### 5.4 sendmessage 构造

每个媒体 item 单独一个 `sendmessage` 请求（SDK 确认行为）。

**图片**：
```json
{
  "type": 2,
  "image_item": {
    "media": {
      "encrypt_query_param": "<x-encrypted-param>",
      "aes_key": "<base64(hex string)>",
      "encrypt_type": 1
    },
    "mid_size": 248736
  }
}
```

**文件**：
```json
{
  "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "<x-encrypted-param>",
      "aes_key": "<base64(hex string)>",
      "encrypt_type": 1
    },
    "file_name": "report.pdf",
    "len": "12345"
  }
}
```

**视频**：
```json
{
  "type": 5,
  "video_item": {
    "media": {
      "encrypt_query_param": "<x-encrypted-param>",
      "aes_key": "<base64(hex string)>",
      "encrypt_type": 1
    },
    "video_size": 248736
  }
}
```

### 5.5 AES Key 编码汇总

| 场景 | 字段名 | 格式 |
|------|--------|------|
| `getuploadurl` 请求 | `aeskey` | hex 字符串 (32 字符) |
| `sendmessage` CDNMedia | `aes_key` | `base64(hex string UTF-8 bytes)` |
| 图片接收 `image_item` | `aeskey` | hex 字符串 (32 字符) |
| 其他接收 CDNMedia | `aes_key` | base64 编码（两种格式都可能出现） |

SDK 发送时的编码：`Buffer.from(aeskey_hex_string).toString("base64")` — 即 base64 of hex string (Case 2)。

## 6. MIME 路由

SDK 根据文件 MIME 类型决定上传类型：

```typescript
if (mime.startsWith("video/"))  → UploadMediaType.VIDEO (2)
if (mime.startsWith("image/"))  → UploadMediaType.IMAGE (1)
else                            → UploadMediaType.FILE  (3)
```

## 7. 其他要点

- **认证**：ilink API 用 `Authorization: Bearer {token}` + `X-WECHAT-UIN`；CDN 调用不需要
- **context_token**：发送媒体消息时仍然必需
- **媒体大小限制**：100MB (`WEIXIN_MEDIA_MAX_BYTES`)
- **缩略图**：`no_need_thumb: true` 跳过缩略图上传（SDK 默认行为）
- **远程 URL**：SDK 支持 HTTP URL → 先下载到临时目录再走 CDN 上传
- **零外部依赖**：仅需 `node:crypto` + `fetch()`
- **Session expired (errcode -14)**：SDK 暂停所有 API 调用 1 小时

## 8. 参考来源

- **官方 SDK**：`@tencent-weixin/openclaw-weixin@2.0.1` (MIT)
  - `src/cdn/aes-ecb.ts` — AES 加解密
  - `src/cdn/cdn-url.ts` — CDN URL 构造
  - `src/cdn/cdn-upload.ts` — CDN 上传 + 重试
  - `src/cdn/upload.ts` — 完整上传流水线
  - `src/cdn/pic-decrypt.ts` — CDN 下载 + AES 解密 + key 解析
  - `src/media/media-download.ts` — 按类型分派下载
  - `src/messaging/send.ts` — 构造发送消息
  - `src/messaging/send-media.ts` — MIME 路由 + 上传 + 发送
  - `src/api/types.ts` — 协议类型定义
