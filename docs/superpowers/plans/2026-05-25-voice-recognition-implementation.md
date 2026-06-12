# 语音识别集成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 evolclaw 添加自动语音识别功能，用户发送语音消息时自动转写为文本传给 Agent。

**Architecture:** 创建 `src/utils/asr.ts` 作为通用 ASR 服务（Provider 模式），首个实现为火山引擎豆包录音文件识别。各渠道自行下载音频到临时文件后调用 `recognizeAudio(filePath)` 获取文本。配置存储在进程级 `config.json` 的 `asr` 字段。

**Tech Stack:** TypeScript, Node.js HTTP server (临时音频服务), 火山引擎 ASR API (HTTP POST + 轮询)

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/utils/asr.ts` | 核心 ASR 服务：Provider 接口 + 火山引擎实现 + 配置加载 |
| 修改 | `src/config-store.ts` | `ProcessConfig` 添加 `asr` 字段 |
| 修改 | `src/channels/feishu.ts` | 添加 `audio` 消息类型处理 |
| 修改 | `src/channels/wechat.ts` | `voice_item.text` 为空时调用 ASR |
| 修改 | `src/channels/wecom.ts` | `voice.content` 为空时调用 ASR |
| 创建 | `tests/unit/asr.test.ts` | ASR 模块单元测试 |

---

### Task 1: 核心 ASR 模块

**Files:**
- Create: `src/utils/asr.ts`
- Modify: `src/config-store.ts:149-162`
- Test: `tests/unit/asr.test.ts`

- [ ] **Step 1: 在 ProcessConfig 中添加 asr 字段**

修改 `src/config-store.ts`，在 `ProcessConfig` 接口中添加 `asr` 字段：

```typescript
export interface ProcessConfig {
  $schema_version?: number;
  log?: {
    level?: string;
    retention_hours?: number;
    message_log?: boolean;
    event_log?: boolean;
  };
  aun?: {
    gateway?: string;
    keystorePath?: string;
    encryptionSeed?: string;
  };
  asr?: {
    provider?: string;
    apiKey?: string;
    resourceId?: string;
    baseUrl?: string;
  };
}
```

- [ ] **Step 2: 创建 ASR 模块骨架和测试**

创建 `tests/unit/asr.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recognizeAudio, isAsrConfigured, AsrError } from '../../src/utils/asr.js';

// Mock config-store
vi.mock('../../src/config-store.js', () => ({
  loadProcessConfig: vi.fn(() => ({})),
}));

describe('asr', () => {
  beforeEach(() => {
    // 清除环境变量
    delete process.env.ASR_PROVIDER;
    delete process.env.ASR_API_KEY;
    delete process.env.ASR_RESOURCE_ID;
    delete process.env.ASR_BASE_URL;
  });

  describe('isAsrConfigured', () => {
    it('returns false when no config', () => {
      expect(isAsrConfigured()).toBe(false);
    });

    it('returns true when ASR_API_KEY env is set', () => {
      process.env.ASR_API_KEY = 'test-key';
      expect(isAsrConfigured()).toBe(true);
    });
  });

  describe('recognizeAudio', () => {
    it('throws CONFIG_MISSING when not configured', async () => {
      await expect(recognizeAudio('/tmp/test.mp3'))
        .rejects.toThrow(AsrError);
      await expect(recognizeAudio('/tmp/test.mp3'))
        .rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    });

    it('throws FILE_NOT_FOUND for non-existent file', async () => {
      process.env.ASR_API_KEY = 'test-key';
      await expect(recognizeAudio('/tmp/nonexistent-audio-file.mp3'))
        .rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- --run tests/unit/asr.test.ts`
Expected: FAIL — module `../../src/utils/asr.js` not found

- [ ] **Step 4: 实现 ASR 模块**

创建 `src/utils/asr.ts`：

```typescript
import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { loadProcessConfig } from '../config-store.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface AsrOptions {
  language?: string;
  enablePunc?: boolean;
  timeoutMs?: number;
}

export interface AsrResult {
  text: string;
  duration?: number;
}

export class AsrError extends Error {
  code: string;
  statusCode?: number;
  constructor(code: string, message: string, statusCode?: number) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface AsrConfig {
  provider: string;
  apiKey: string;
  resourceId: string;
  baseUrl: string;
}

// ── Config Loading ─────────────────────────────────────────────────────────

function loadAsrConfig(): AsrConfig | null {
  const processConfig = loadProcessConfig();
  const cfg = processConfig.asr;

  const apiKey = process.env.ASR_API_KEY || cfg?.apiKey;
  if (!apiKey) return null;

  return {
    provider: process.env.ASR_PROVIDER || cfg?.provider || 'volcengine',
    apiKey,
    resourceId: process.env.ASR_RESOURCE_ID || cfg?.resourceId || 'volc.seedasr.auc',
    baseUrl: process.env.ASR_BASE_URL || cfg?.baseUrl || 'https://openspeech.bytedance.com',
  };
}

export function isAsrConfigured(): boolean {
  return loadAsrConfig() !== null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function recognizeAudio(
  filePath: string,
  options?: AsrOptions,
): Promise<AsrResult> {
  const config = loadAsrConfig();
  if (!config) {
    throw new AsrError('CONFIG_MISSING', 'ASR 未配置：请在 config.json 中设置 asr.apiKey 或设置环境变量 ASR_API_KEY');
  }

  if (!fs.existsSync(filePath)) {
    throw new AsrError('FILE_NOT_FOUND', `音频文件不存在: ${filePath}`);
  }

  if (config.provider === 'volcengine') {
    return volcengineRecognize(filePath, config, options);
  }

  throw new AsrError('API_ERROR', `不支持的 ASR provider: ${config.provider}`);
}

// ── Volcengine Provider ────────────────────────────────────────────────────

async function volcengineRecognize(
  filePath: string,
  config: AsrConfig,
  options?: AsrOptions,
): Promise<AsrResult> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const taskId = crypto.randomUUID();

  // 启动临时 HTTP 服务器提供音频文件
  const { url, close } = await startTempServer(filePath);

  try {
    // 1. 提交任务
    await submitTask(config, taskId, url, options);

    // 2. 轮询结果
    const result = await pollResult(config, taskId, timeoutMs);
    return result;
  } finally {
    close();
  }
}

// ── Temp HTTP Server ───────────────────────────────────────────────────────

function startTempServer(filePath: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const stream = fs.createReadStream(filePath);
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
      });
      stream.pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new AsrError('API_ERROR', '临时服务器启动失败'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}/audio`;
      resolve({
        url,
        close: () => server.close(),
      });
    });

    server.on('error', (err) => {
      reject(new AsrError('API_ERROR', `临时服务器错误: ${err.message}`));
    });
  });
}

// ── Volcengine API Calls ───────────────────────────────────────────────────

async function submitTask(
  config: AsrConfig,
  taskId: string,
  audioUrl: string,
  options?: AsrOptions,
): Promise<void> {
  const ext = path.extname(audioUrl).replace('.', '') || 'mp3';
  const body = JSON.stringify({
    user: { uid: 'evolclaw' },
    audio: {
      format: guessFormat(ext),
      url: audioUrl,
      language: options?.language || '',
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: options?.enablePunc ?? true,
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': config.apiKey,
    'X-Api-Resource-Id': config.resourceId,
    'X-Api-Request-Id': taskId,
    'X-Api-Sequence': '-1',
  };

  const resp = await fetch(`${config.baseUrl}/api/v3/auc/bigmodel/submit`, {
    method: 'POST',
    headers,
    body,
  });

  const statusCode = resp.headers.get('x-api-status-code');
  if (statusCode && statusCode !== '20000000') {
    const message = resp.headers.get('x-api-message') || 'Unknown error';
    throw new AsrError('API_ERROR', `提交任务失败: ${message} (code: ${statusCode})`, parseInt(statusCode));
  }
}

async function pollResult(
  config: AsrConfig,
  taskId: string,
  timeoutMs: number,
): Promise<AsrResult> {
  const pollInterval = 2000;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': config.apiKey,
    'X-Api-Resource-Id': config.resourceId,
    'X-Api-Request-Id': taskId,
  };

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollInterval);

    const resp = await fetch(`${config.baseUrl}/api/v3/auc/bigmodel/query`, {
      method: 'POST',
      headers,
      body: '{}',
    });

    const statusCode = resp.headers.get('x-api-status-code');

    // 处理中 / 排队中
    if (statusCode === '20000001' || statusCode === '20000002') {
      continue;
    }

    // 成功
    if (statusCode === '20000000') {
      const data = await resp.json() as any;
      const text = data?.result?.text || '';
      const duration = data?.audio_info?.duration;
      return { text, duration };
    }

    // 静音
    if (statusCode === '20000003') {
      return { text: '', duration: undefined };
    }

    // 错误
    const message = resp.headers.get('x-api-message') || 'Unknown error';
    throw new AsrError('API_ERROR', `识别失败: ${message} (code: ${statusCode})`, statusCode ? parseInt(statusCode) : undefined);
  }

  throw new AsrError('TIMEOUT', `识别超时: ${timeoutMs}ms`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function guessFormat(ext: string): string {
  const map: Record<string, string> = {
    mp3: 'mp3', wav: 'wav', ogg: 'ogg', opus: 'ogg',
    pcm: 'raw', raw: 'raw', m4a: 'mp3', amr: 'mp3',
  };
  return map[ext.toLowerCase()] || 'mp3';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- --run tests/unit/asr.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/utils/asr.ts src/config-store.ts tests/unit/asr.test.ts
git commit -m "feat(asr): add voice recognition module with Volcengine provider"
```

---

### Task 2: 飞书渠道语音识别集成

**Files:**
- Modify: `src/channels/feishu.ts:342-347`

- [ ] **Step 1: 在飞书消息处理中添加 audio 类型**

在 `src/channels/feishu.ts` 中，找到 `else` 分支（处理不支持的消息类型，约第 342 行），在它之前插入 `audio` 消息处理：

```typescript
            // 处理语音消息
            else if (msg.message_type === 'audio') {
              const audioContent = JSON.parse(msg.content);
              const fileKey = audioContent.file_key;
              logger.debug('[Feishu] Received audio message, file_key:', fileKey, 'message_id:', msg.message_id);

              const projectPath = this.projectPathProvider
                ? await this.projectPathProvider(msg.chat_id)
                : process.cwd();

              const text = await this.handleAudioMessage(fileKey, msg.message_id, projectPath);
              if (text) {
                const finalContent = quotedText + text;
                await this.messageHandler({ channelId: msg.chat_id, content: finalContent, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              } else {
                const prompt = quotedText + '[语音识别失败或未配置]';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              }
            }
            // 处理其他类型消息
            else {
```

- [ ] **Step 2: 实现 handleAudioMessage 方法**

在 `FeishuChannel` 类中（`downloadFile` 方法附近）添加：

```typescript
  private async handleAudioMessage(fileKey: string, messageId: string, projectPath: string): Promise<string | null> {
    const { isAsrConfigured, recognizeAudio } = await import('../utils/asr.js');
    if (!isAsrConfigured()) {
      logger.debug('[Feishu] ASR not configured, skipping audio message');
      return null;
    }

    // 下载音频到临时文件
    const tempDir = path.join(projectPath, '.evolclaw', 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `audio-${Date.now()}-${messageId}.opus`);

    try {
      const response = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (!response || typeof response.getReadableStream !== 'function') {
        logger.error('[Feishu] Audio download failed: no valid method');
        return null;
      }

      const stream = response.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        logger.warn('[Feishu] Empty audio response');
        return null;
      }

      fs.writeFileSync(tempFile, buffer);
      logger.debug(`[Feishu] Audio saved to temp: ${tempFile} (${buffer.length} bytes)`);

      // 调用 ASR
      const result = await recognizeAudio(tempFile, { enablePunc: true });
      if (result.text) {
        logger.info(`[Feishu] Audio recognized: "${result.text.substring(0, 50)}..." (${result.duration}ms)`);
      }
      return result.text || null;
    } catch (error) {
      logger.error('[Feishu] Audio recognition failed:', error);
      return null;
    } finally {
      // 清理临时文件
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 编译成功，无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/channels/feishu.ts
git commit -m "feat(feishu): add voice message recognition via ASR"
```

---

### Task 3: 微信渠道语音识别兜底

**Files:**
- Modify: `src/channels/wechat.ts:157-159`

- [ ] **Step 1: 修改微信 voice_item 处理逻辑**

当前代码（约第 157 行）：

```typescript
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
```

修改为：当平台识别文本为空时，下载音频并调用 ASR：

首先需要把 `extractTextFromItems` 改为 async 或者在调用处处理。由于 `extractTextFromItems` 是同步函数且被多处调用，更好的方式是在 `WechatChannel` 的消息处理流程中单独处理语音消息。

找到 `WechatChannel` 中处理消息的位置，在 `extractTextFromItems` 返回空字符串且消息包含 voice_item 时，调用 ASR。

查看消息处理流程中调用 `extractTextFromItems` 的位置：

```typescript
// 在 WechatChannel 的消息处理方法中，extractTextFromItems 返回空时检查是否有语音
// 如果有语音且无平台识别文本，调用 ASR
```

- [ ] **Step 2: 查找并修改消息处理逻辑**

在 `WechatChannel` 中处理 `getUpdates` 响应的位置，找到调用 `extractTextFromItems` 的地方，添加语音兜底逻辑：

```typescript
    // 在 extractTextFromItems 返回空字符串后，检查是否有语音消息需要 ASR
    if (!text && msg.item_list?.some(i => i.type === MSG_ITEM_VOICE && i.voice_item?.media)) {
      text = await this.handleVoiceAsr(msg, channelId, projectPath);
    }
```

在 `WechatChannel` 类中添加方法：

```typescript
  private async handleVoiceAsr(msg: WeixinMessage, channelId: string, projectPath: string): Promise<string> {
    const { isAsrConfigured, recognizeAudio } = await import('../utils/asr.js');
    if (!isAsrConfigured()) return '';

    const voiceItem = msg.item_list?.find(i => i.type === MSG_ITEM_VOICE);
    if (!voiceItem?.voice_item?.media?.encrypt_query_param) return '';

    const tempDir = path.join(projectPath, '.evolclaw', 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `voice-${Date.now()}.amr`);

    try {
      // 使用现有的 CDN 下载 + AES 解密逻辑
      const buffer = await this.downloadCdnMedia(voiceItem.voice_item.media);
      if (!buffer || buffer.length === 0) return '';

      fs.writeFileSync(tempFile, buffer);
      const result = await recognizeAudio(tempFile, { enablePunc: true });
      return result.text || '';
    } catch (error) {
      logger.error('[WeChat] Voice ASR failed:', error);
      return '';
    } finally {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/channels/wechat.ts
git commit -m "feat(wechat): add ASR fallback for voice messages without platform text"
```

---

### Task 4: 企微渠道语音识别兜底

**Files:**
- Modify: `src/channels/wecom.ts:196-203`

- [ ] **Step 1: 修改企微 voice 处理逻辑**

当前代码（约第 196 行）：

```typescript
    } else if (msgtype === 'voice') {
      const voiceText = body.voice?.content?.trim();
      if (voiceText) {
        await this.messageHandler({
          channelId, content: voiceText, chatType: chatTypeNorm,
          peerId: userid, messageId: msgId,
        });
      }
    }
```

修改为：当 `voiceText` 为空时调用 ASR：

```typescript
    } else if (msgtype === 'voice') {
      const voiceText = body.voice?.content?.trim();
      if (voiceText) {
        await this.messageHandler({
          channelId, content: voiceText, chatType: chatTypeNorm,
          peerId: userid, messageId: msgId,
        });
      } else {
        // 平台未提供识别文本，尝试 ASR
        const asrText = await this.handleVoiceAsr(body, channelId);
        if (asrText) {
          await this.messageHandler({
            channelId, content: asrText, chatType: chatTypeNorm,
            peerId: userid, messageId: msgId,
          });
        }
      }
    }
```

- [ ] **Step 2: 添加 handleVoiceAsr 方法**

在 `WecomChannel` 类中添加：

```typescript
  private async handleVoiceAsr(body: any, channelId: string): Promise<string | null> {
    const { isAsrConfigured, recognizeAudio } = await import('../utils/asr.js');
    if (!isAsrConfigured()) return null;

    const mediaUrl = body.voice?.media_url;
    if (!mediaUrl) return null;

    const tempDir = path.join(process.cwd(), '.evolclaw', 'temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `wecom-voice-${Date.now()}.amr`);

    try {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) return null;
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length === 0) return null;

      fs.writeFileSync(tempFile, buffer);
      const result = await recognizeAudio(tempFile, { enablePunc: true });
      return result.text || null;
    } catch (error) {
      logger.error('[WeCom] Voice ASR failed:', error);
      return null;
    } finally {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/channels/wecom.ts
git commit -m "feat(wecom): add ASR fallback for voice messages without platform text"
```

---

### Task 5: 全量测试和最终验证

**Files:**
- All modified files

- [ ] **Step 1: 运行全量测试**

Run: `npm test`
Expected: 所有测试通过（包括新增的 asr.test.ts）

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功，无错误

- [ ] **Step 3: 验证 ASR 配置加载**

手动验证：在 `config.json` 中添加 asr 配置后，`isAsrConfigured()` 返回 true：

```bash
node -e "
  process.env.EVOLCLAW_HOME = '/home/evolclaw';
  const { isAsrConfigured } = await import('./dist/utils/asr.js');
  console.log('ASR configured:', isAsrConfigured());
"
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: voice recognition integration complete

- Add src/utils/asr.ts with Provider pattern and Volcengine implementation
- Add ASR config to ProcessConfig (config.json asr field)
- Feishu: handle audio message type with ASR
- WeChat: ASR fallback when platform text is empty
- WeCom: ASR fallback when platform text is empty
- Unit tests for ASR module"
```
