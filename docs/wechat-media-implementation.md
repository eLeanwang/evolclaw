# WeChat 渠道图片/文件收发实现方案

> 基于 `wechat-media-research.md` 研究结论

## 设计原则

- **复用现有架构**：ChannelAdapter 模式、`[SEND_FILE:]` marker 机制、`Message.images` 字段均已就绪
- **改动集中在 wechat.ts**：核心层（message-processor、session-manager）无需改动
- **与飞书一致的用户体验**：图片走多模态、文件存 uploads 目录

## 一、接收媒体（用户 → Agent）

### 1.1 当前问题

`extractTextFromMessage()` 只处理 TEXT (1) 和 VOICE (3)，遇到 IMAGE/FILE/VIDEO 返回空字符串，消息被丢弃。

### 1.2 扩展 MessageItem 类型

```typescript
// wechat.ts 内部类型

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; media?: CDNMedia };
  image_item?: { media?: CDNMedia; aeskey?: string; mid_size?: number };
  file_item?:  { media?: CDNMedia; file_name?: string; len?: string };
  video_item?: { media?: CDNMedia; video_size?: number };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_FILE  = 4;
const MSG_ITEM_VIDEO = 5;
```

### 1.3 CDN 下载 + AES 解密

新增模块级工具函数（wechat.ts 内部）：

```typescript
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii')))
    return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new Error(`Invalid aes_key length: ${decoded.length}`);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function downloadMedia(cdnMedia: CDNMedia, hexKey?: string): Promise<Buffer> {
  const aesKeyBase64 = hexKey
    ? Buffer.from(hexKey, 'hex').toString('base64')
    : cdnMedia.aes_key;

  if (!cdnMedia.encrypt_query_param) throw new Error('No encrypt_query_param');

  const url = `${CDN_BASE_URL}/download?encrypted_query_param=${
    encodeURIComponent(cdnMedia.encrypt_query_param)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());

  if (!aesKeyBase64) return encrypted;  // 无 key = 明文
  return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
}
```

### 1.4 改造 handleInboundMessage

```typescript
private async handleInboundMessage(msg: WeixinMessage): Promise<void> {
  if (msg.message_type !== MSG_TYPE_USER) return;
  const fromUserId = msg.from_user_id ?? '';

  // 缓存 context_token
  if (msg.context_token) {
    this.contextTokenCache.set(fromUserId, msg.context_token);
    this.persistContextTokens();
  }

  // 提取文本（原有逻辑）
  const text = extractTextFromMessage(msg);

  // 提取媒体 → 下载
  const media = await this.extractMedia(msg);

  // 合成最终内容
  const finalContent = media.prompt
    ? (text ? `${text}\n\n${media.prompt}` : media.prompt)
    : text;
  if (!finalContent && !media.images.length) return;

  logger.info(`[WeChat] Received: from=${fromUserId} text=${(finalContent || '').slice(0, 50)} images=${media.images.length}...`);

  // typing
  this.acknowledgeMessage(fromUserId, msg.context_token).catch(() => {});

  // 回调主流程
  if (this.messageHandler) {
    await this.messageHandler(fromUserId, finalContent || '', fromUserId, media.images);
  }
}
```

### 1.5 媒体提取方法

```typescript
private async extractMedia(msg: WeixinMessage): Promise<{
  prompt: string;
  images: Array<{ data: string; mimeType: string }>;
}> {
  const images: Array<{ data: string; mimeType: string }> = [];
  const prompts: string[] = [];

  for (const item of msg.item_list ?? []) {
    try {
      if (item.type === MSG_ITEM_IMAGE && item.image_item?.media) {
        const buf = await downloadMedia(item.image_item.media, item.image_item.aeskey);
        images.push({ data: buf.toString('base64'), mimeType: 'image/jpeg' });
      }

      if (item.type === MSG_ITEM_FILE && item.file_item?.media) {
        const buf = await downloadMedia(item.file_item.media);
        const fileName = item.file_item.file_name || `file_${Date.now()}`;
        const savePath = await this.saveToUploads(buf, fileName);
        prompts.push(`用户发送了文件：${fileName}\n文件已保存到：${savePath}\n请使用 Read 工具读取并分析文件内容。`);
      }

      if (item.type === MSG_ITEM_VIDEO && item.video_item?.media) {
        const buf = await downloadMedia(item.video_item.media);
        const fileName = `video_${Date.now()}.mp4`;
        const savePath = await this.saveToUploads(buf, fileName);
        prompts.push(`用户发送了视频：${fileName}\n文件已保存到：${savePath}`);
      }
    } catch (err) {
      logger.error(`[WeChat] Failed to download media type=${item.type}:`, err);
    }
  }

  return { prompt: prompts.join('\n\n'), images };
}
```

### 1.6 保存到 uploads 目录

需要知道当前 projectPath，通过回调获取（与飞书的 `onProjectPathRequest` 模式一致）：

```typescript
private projectPathResolver?: (channelId: string) => Promise<string>;

onProjectPathRequest(resolver: (channelId: string) => Promise<string>): void {
  this.projectPathResolver = resolver;
}

private async saveToUploads(buf: Buffer, fileName: string): Promise<string> {
  // projectPath 通过回调获取，fallback 到 process.cwd()
  const projectPath = this.projectPathResolver
    ? await this.projectPathResolver(/* channelId from context */)
    : process.cwd();
  const uploadsDir = path.join(projectPath, '.claude', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const savePath = path.join(uploadsDir, fileName);
  fs.writeFileSync(savePath, buf);
  return savePath;
}
```

### 1.7 扩展回调签名

```typescript
export interface WechatMessageHandler {
  (channelId: string, content: string, userId?: string,
   images?: Array<{ data: string; mimeType: string }>): Promise<void>;
}
```

## 二、发送媒体（Agent → 用户）

### 2.1 架构复用

现有 `[SEND_FILE:]` marker 机制在 `message-processor.ts` 中已完备：
- 检测 marker → 调用 `adapter.sendFile()` → 移除 marker → 发送剩余文本
- 只需给 wechatAdapter 加上 `sendFile`，配上 `fileMarkerPattern` 即可

### 2.2 WechatChannel.sendFile 方法

```typescript
async sendFile(to: string, filePath: string): Promise<void> {
  const contextToken = this.contextTokenCache.get(to);
  if (!contextToken) {
    logger.error(`[WeChat] No context_token for ${to}, cannot send file`);
    return;
  }

  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const aeskey = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString('hex');
  const filesize = Math.ceil((rawsize + 1) / 16) * 16;

  // MIME → UploadMediaType
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const uploadMediaType = mime.startsWith('image/') ? 1
    : mime.startsWith('video/') ? 2 : 3;

  // Step 1: getuploadurl
  const uploadResp = await this.getUploadUrl({
    filekey, media_type: uploadMediaType, to_user_id: to,
    rawsize, rawfilemd5, filesize,
    aeskey: aeskey.toString('hex'),
    no_need_thumb: true,
  });

  // Step 2: encrypt + upload to CDN
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const downloadParam = await this.cdnUpload(uploadResp.upload_param!, filekey, ciphertext);

  // Step 3: sendmessage with CDN reference
  const cdnMedia: CDNMedia = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
    encrypt_type: 1,
  };

  // MessageItemType 映射
  const itemType = mime.startsWith('image/') ? MSG_ITEM_IMAGE
    : mime.startsWith('video/') ? MSG_ITEM_VIDEO : MSG_ITEM_FILE;

  const item = this.buildMediaItem(itemType, cdnMedia, filePath, filesize, rawsize);
  await this.sendMediaMessage(to, item, contextToken);
}
```

### 2.3 CDN 上传方法

```typescript
private async cdnUpload(uploadParam: string, filekey: string, ciphertext: Buffer): Promise<string> {
  const url = `${CDN_BASE_URL}/upload?encrypted_query_param=${
    encodeURIComponent(uploadParam)}&filekey=${filekey}`;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN upload client error: ${res.status}`);
      }
      if (!res.ok) throw new Error(`CDN upload failed: ${res.status}`);

      const downloadParam = res.headers.get('x-encrypted-param');
      if (!downloadParam) throw new Error('Missing x-encrypted-param header');
      return downloadParam;
    } catch (err) {
      lastError = err as Error;
      if ((err as any).message?.includes('client error')) throw err; // 4xx 不重试
    }
  }
  throw lastError;
}
```

### 2.4 getUploadUrl API

```typescript
private async getUploadUrl(params: {
  filekey: string; media_type: number; to_user_id: string;
  rawsize: number; rawfilemd5: string; filesize: number;
  aeskey: string; no_need_thumb: boolean;
}): Promise<{ upload_param?: string; thumb_upload_param?: string }> {
  const body = JSON.stringify({
    ...params,
    base_info: { channel_version: CHANNEL_VERSION },
  });
  const raw = await this.apiFetch('ilink/bot/getuploadurl', body, DEFAULT_API_TIMEOUT_MS);
  const resp = JSON.parse(raw);
  if (!resp.upload_param) throw new Error('getuploadurl: no upload_param');
  return resp;
}
```

### 2.5 构造媒体消息 Item

```typescript
private buildMediaItem(
  itemType: number, cdnMedia: CDNMedia, filePath: string,
  ciphertextSize: number, plaintextSize: number
): MessageItem {
  if (itemType === MSG_ITEM_IMAGE) {
    return { type: MSG_ITEM_IMAGE, image_item: { media: cdnMedia, mid_size: ciphertextSize } };
  }
  if (itemType === MSG_ITEM_VIDEO) {
    return { type: MSG_ITEM_VIDEO, video_item: { media: cdnMedia, video_size: ciphertextSize } };
  }
  // FILE
  return {
    type: MSG_ITEM_FILE,
    file_item: {
      media: cdnMedia,
      file_name: path.basename(filePath),
      len: String(plaintextSize),
    },
  };
}

private async sendMediaMessage(to: string, item: MessageItem, contextToken: string): Promise<void> {
  const clientId = `evolclaw-wechat:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [item],
      context_token: contextToken,
    },
    base_info: { channel_version: CHANNEL_VERSION },
  };
  await this.apiFetch('ilink/bot/sendmessage', JSON.stringify(body), DEFAULT_API_TIMEOUT_MS);
  logger.info(`[WeChat] Sent media to ${to}, type=${item.type}`);
}
```

## 三、index.ts 接线（极少量改动）

```typescript
// 1. adapter 加 sendFile
const wechatAdapter: ChannelAdapter = {
  name: 'wechat',
  sendText: (channelId, text) => wechat!.sendMessage(channelId, text),
  sendFile: (channelId, filePath) => wechat!.sendFile(channelId, filePath),  // +1 行
};

// 2. options 配置 marker
const wechatOptions: ChannelOptions = {
  systemPromptAppend: '[系统功能] 你可以发送文件给用户。方法：在响应中使用 [SEND_FILE:文件路径] 标记。',
  fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g,
};
processor.registerChannel(wechatAdapter, wechatOptions);

// 3. projectPath 回调
wechat.onProjectPathRequest(async (channelId) => {
  const session = await sessionManager.getOrCreateSession('wechat', channelId, config.projects?.defaultPath || process.cwd());
  return path.isAbsolute(session.projectPath) ? session.projectPath : path.resolve(process.cwd(), session.projectPath);
});

// 4. onMessage 回调传递 images
wechat.onMessage(async (channelId, content, userId, images) => {
  // ... 现有逻辑不变 ...
  await messageQueue.enqueue(
    `wechat-${channelId}`,
    { channel: 'wechat', channelId, content, images, timestamp: Date.now(), userId },
    session.projectPath
  );
});
```

## 四、MIME 类型映射

```typescript
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
  '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
};
```

## 五、改动文件清单

| 文件 | 改动内容 | 量级 |
|------|----------|------|
| `src/channels/wechat.ts` | 类型扩展、CDN 下载/上传、AES 加解密、`sendFile`、`extractMedia`、`saveToUploads`、回调签名扩展 | **主要** |
| `src/index.ts` | adapter 加 `sendFile`、options 加 marker、`onProjectPathRequest`、回调传 images | 几行接线 |

**核心层无改动**：`message-processor.ts`、`session-manager.ts`、`command-handler.ts`、`types.ts` 均不需要修改。

## 六、限制与约束

- **文件大小**：单文件 100MB 上限
- **Session 暂停期间**：不处理媒体上传（与文本一致）
- **语音**：仅用文字转写，不下载音频（当前行为保持不变）
- **缩略图**：跳过（`no_need_thumb: true`），简化实现
