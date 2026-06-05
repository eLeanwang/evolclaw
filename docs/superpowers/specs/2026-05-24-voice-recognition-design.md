# 语音识别集成设计

**日期**：2026-05-24  
**状态**：草稿  
**作者**：Claude Opus 4.6

## 概述

为 evolclaw 所有消息渠道添加自动语音识别功能。用户发送语音消息时，系统自动转写为文本并传给 Agent 处理，对用户透明。

## 目标

1. **全渠道支持**：飞书、微信、企微、钉钉、AUN、QQ 均支持语音消息
2. **透明处理**：用户发语音，Agent 收文本，无需手动干预
3. **平台优先**：有平台识别结果时（微信、企微）优先使用
4. **可扩展架构**：Provider 模式，支持未来接入其他 ASR 服务或本地模型
5. **优雅降级**：未配置 ASR 时不影响现有功能

## 非目标

- 实时流式识别（仅支持异步批量处理）
- 语音合成/TTS
- 多说话人分离
- 语音消息发送（仅处理入站）

## 架构

### 组件概览

```
┌─────────────────────────────────────────────────────────────┐
│                         渠道层                               │
│  （飞书、微信、企微、钉钉、AUN、QQ）                          │
│                                                              │
│  1. 接收语音消息                                             │
│  2. 检查平台识别结果（仅微信/企微）                           │
│  3. 下载音频到临时文件                                        │
│  4. 调用 recognizeAudio(filePath)                           │
│  5. 将文本传给 Agent                                         │
│  6. 清理临时文件                                             │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │   src/utils/asr.ts   │
         │                      │
         │  recognizeAudio()    │
         │  ├─ 加载配置          │
         │  ├─ 选择 Provider     │
         │  └─ 返回文本          │
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │    Provider 接口      │
         │                       │
         │  VolcengineProvider   │
         │  （未来：其他服务商）   │
         └───────────────────────┘
```

### 模块设计

#### `src/utils/asr.ts` — 核心 ASR 服务

**职责**：
- 提供统一的 `recognizeAudio()` 接口
- 从 `config.json` 和环境变量加载配置
- 管理 Provider 生命周期
- 错误处理和超时管理

**接口**：

```typescript
// ── 公开 API ──

interface AsrOptions {
  language?: string;      // 语言代码，默认 'zh-CN'
  enablePunc?: boolean;   // 标点符号，默认 true
  timeoutMs?: number;     // 超时时间（毫秒），默认 60000
}

interface AsrResult {
  text: string;           // 识别文本
  duration?: number;      // 音频时长（毫秒，可选）
}

/**
 * 识别本地音频文件
 * @param filePath - 本地音频文件的绝对路径
 * @param options - 识别选项
 * @returns 识别结果
 * @throws AsrError 识别失败时抛出
 */
export async function recognizeAudio(
  filePath: string,
  options?: AsrOptions
): Promise<AsrResult>

// ── Provider 接口（内部）──

interface AsrProvider {
  readonly name: string;
  recognize(filePath: string, options: AsrOptions): Promise<AsrResult>;
}

// ── 配置 ──

interface AsrConfig {
  provider?: string;      // 服务商名称，默认 'volcengine'
  apiKey?: string;        // API Key（火山引擎必填）
  resourceId?: string;    // 模型资源 ID，默认 'volc.seedasr.auc'
  baseUrl?: string;       // API 地址（可选，用于自定义端点）
}
```

**配置加载优先级**：

环境变量 → `config.json` → 默认值

```typescript
// 环境变量
ASR_PROVIDER         // 覆盖 config.asr.provider
ASR_API_KEY          // 覆盖 config.asr.apiKey
ASR_RESOURCE_ID      // 覆盖 config.asr.resourceId
ASR_BASE_URL         // 覆盖 config.asr.baseUrl

// config.json 结构
{
  "asr": {
    "provider": "volcengine",
    "apiKey": "your-api-key",
    "resourceId": "volc.seedasr.auc"
  }
}
```

**错误处理**：

```typescript
class AsrError extends Error {
  code: string;          // 错误码
  statusCode?: number;   // HTTP 状态码（如适用）
}

// 错误码：
// - CONFIG_MISSING：未配置 ASR
// - FILE_NOT_FOUND：音频文件不存在
// - TIMEOUT：识别超时
// - API_ERROR：服务商 API 错误
// - INVALID_AUDIO：不支持的音频格式
```

#### 火山引擎 Provider 实现

**API 流程**：

1. **提交任务**：POST `/api/v3/auc/bigmodel/submit`，携带音频 URL
2. **轮询结果**：POST `/api/v3/auc/bigmodel/query`，携带任务 ID
3. **解析响应**：从结果中提取文本

**关键实现细节**：

- 火山引擎需要 HTTP URL，本地文件需通过临时 HTTP 服务器暴露
- 任务 ID：每次请求生成 UUID
- 轮询：每 2 秒查询一次，最多 30 次（60 秒超时）
- 认证：支持新版控制台（`X-Api-Key`）和旧版控制台（`X-Api-App-Key` + `X-Api-Access-Key`）
- 状态码：
  - `20000000`：成功
  - `20000001`：处理中
  - `20000002`：排队中
  - `45000xxx`：客户端错误
  - `550xxxxx`：服务端错误

**音频 URL 策略**：

火山引擎需要 HTTP URL，但我们有本地文件，解决方案：

启动临时本地 HTTP 服务器（绑定 `127.0.0.1`，随机端口），提供文件访问，识别完成后立即关闭。

### 渠道集成

#### 集成模式

各渠道接收语音消息时遵循以下模式：

```typescript
// 伪代码

async function handleVoiceMessage(voiceData) {
  // 1. 优先使用平台识别结果（微信/企微）
  if (voiceData.platformText) {
    await this.messageHandler({ content: voiceData.platformText, ... });
    return;
  }

  // 2. 检查 ASR 是否已配置
  if (!isAsrConfigured()) {
    logger.debug('[Channel] ASR 未配置，忽略语音消息');
    return;
  }

  let tempFile: string | undefined;
  try {
    // 3. 下载音频到临时文件（各渠道自行实现）
    tempFile = await this.downloadVoiceToTemp(voiceData);

    // 4. 识别音频
    const result = await recognizeAudio(tempFile, {
      language: 'zh-CN',
      enablePunc: true,
    });

    // 5. 将文本传给 Agent
    await this.messageHandler({ content: result.text, ... });

  } catch (error) {
    logger.error('[Channel] 语音识别失败:', error);
  } finally {
    // 6. 清理临时文件
    if (tempFile) fs.unlinkSync(tempFile);
  }
}
```

#### 各渠道详情

| 渠道 | 语音消息类型 | 平台识别 | 音频下载方式 |
|------|------------|---------|------------|
| **飞书** | `message_type: 'audio'` | 无 | 飞书 API：`im/v1/messages/{id}/resources/{file_key}` |
| **微信** | `voice_item` | 有（`voice_item.text`） | CDN URL + AES 解密（现有 `safeFetch`） |
| **企微** | `msgtype: 'voice'` | 有（`voice.content`） | 企微 API 下载 |
| **钉钉** | `msgtype: 'audio'` | 无 | 钉钉 API 下载 |
| **AUN** | `type: 'voice'` | 无 | `storage.*` API 或直接 URL |
| **QQ** | 待确认 | 无 | QQ API 下载 |

**临时文件管理**：

- 路径：`{projectPath}/.evolclaw/temp/audio-{timestamp}-{uuid}.{ext}`
- 清理：识别完成后立即删除（`finally` 块）
- 兜底清理：定期清理超过 1 小时的文件

### 配置

#### 进程级配置（`{EVOLCLAW_HOME}/config.json`）

```json
{
  "asr": {
    "provider": "volcengine",
    "apiKey": "your-volcengine-api-key",
    "resourceId": "volc.seedasr.auc"
  }
}
```

#### 环境变量

```bash
ASR_PROVIDER=volcengine
ASR_API_KEY=your-volcengine-api-key
ASR_RESOURCE_ID=volc.seedasr.auc
```

#### 初始化检查

```typescript
export function isAsrConfigured(): boolean {
  const config = loadAsrConfig();
  return !!config.apiKey;
}
```

渠道在尝试识别前调用 `isAsrConfigured()`，返回 false 时静默忽略语音消息。

## 实现计划

### 阶段一：核心 ASR 模块

1. 创建 `src/utils/asr.ts`：
   - Provider 接口
   - 火山引擎 Provider 实现
   - 配置加载
   - 临时 HTTP 服务器（用于音频 URL）
   - 错误处理

2. 在 `src/types.ts` 添加 ASR 配置类型：
   - `AsrConfig` 接口
   - 更新 `ProcessConfig` 包含 `asr?: AsrConfig`

3. ASR 模块单元测试

### 阶段二：渠道集成

按优先级依次集成：

1. **飞书**（`src/channels/feishu.ts`）
2. **微信**（`src/channels/wechat.ts`）— 平台识别兜底
3. **企微**（`src/channels/wecom.ts`）— 平台识别兜底
4. **AUN**（`src/channels/aun.ts`）
5. **钉钉**（`src/channels/dingtalk.ts`）
6. **QQ**（`src/channels/qqbot.ts`）

### 阶段三：测试与文档

1. 各渠道端到端集成测试
2. 更新 README 和 CLAUDE.md
3. 错误监控和日志

## 安全考虑

1. **API Key 保护**：存储在 `config.json`（不入 git），支持环境变量覆盖，不记录日志
2. **临时文件安全**：存储在项目专属目录，识别后立即清理
3. **SSRF 防护**：临时 HTTP 服务器仅绑定 `127.0.0.1`，随机端口，用完即关

## 未来扩展

- 其他服务商：阿里云 ASR、腾讯云 ASR、OpenAI Whisper
- 本地模型：Whisper 本地部署
- 高级功能：说话人分离、情绪检测、语种自动识别、自定义热词

## 附录

### 火山引擎 API 参考

- 提交：`POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit`
- 查询：`POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/query`
- 认证：`X-Api-Key`（新版控制台）或 `X-Api-App-Key` + `X-Api-Access-Key`（旧版）
- 资源 ID：`volc.seedasr.auc`（模型 2.0）或 `volc.bigasr.auc`（模型 1.0）

### 使用示例

```typescript
import { recognizeAudio } from './utils/asr.js';

const result = await recognizeAudio('/tmp/audio.mp3', {
  language: 'zh-CN',
  enablePunc: true,
  timeoutMs: 60000,
});

console.log(result.text); // "这是识别出的文本"
```
