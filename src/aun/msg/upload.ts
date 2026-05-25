import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { guessMime, formatSize } from '../../utils/media-cache.js';
import type { ShortConnection } from '../rpc/index.js';
import { inferPayloadType, isValidPayloadType, type PayloadFileType } from './payload-type.js';

/** 单次上传最大大小（与 daemon sendFile 一致）。 */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** server 端 inline 上限错误的识别特征。优先匹配错误消息里的“inline 上限”字样。 */
function isInlineLimitError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  return /inline\s*上限|inline limit|create_upload_session/i.test(msg);
}

export interface Attachment {
  owner_aid: string;
  object_key: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  content_type: string;
}

export interface UploadAndBuildOpts {
  /** 显式覆盖 payload.type（image/video/voice/file）。不传则按扩展名推断。 */
  as?: string;
  /** 显式覆盖 content_type / MIME。不传则按扩展名推断。 */
  contentType?: string;
  /** 附件说明文字（payload.text）。 */
  text?: string;
  /** voice 类型的转写文本。 */
  transcript?: string;
  /** 上传进度回调：phase 标识阶段，bytes/total 为已传/总字节。 */
  onProgress?: (info: UploadProgress) => void;
}

export type UploadPhase = 'inline' | 'session-create' | 'http-put' | 'session-complete' | 'done';

export interface UploadProgress {
  phase: UploadPhase;
  bytes: number;
  total: number;
}

export interface UploadAndBuildResult {
  /** 完整的 payload（含 type、attachments、text 等）。 */
  payload: Record<string, unknown>;
  /** 实际使用的渲染类型。 */
  type: PayloadFileType;
  /** 上传后的 attachment 对象（已嵌入 payload.attachments）。 */
  attachment: Attachment;
}

/**
 * 上传本地文件并构造发送用的 payload。
 *
 * 策略：先无脑 storage.put_object（内联 base64）。server 报“超过 inline 上限”
 * 时降级到 storage.create_upload_session + HTTP PUT + storage.complete_upload，
 * 此时通过 onProgress 上报字节级进度。
 */
export async function uploadFileAndBuildPayload(
  conn: ShortConnection,
  ownerAid: string,
  filePath: string,
  opts?: UploadAndBuildOpts,
): Promise<UploadAndBuildResult> {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`文件不存在: ${absPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size === 0) {
    throw new Error(`文件为空: ${absPath}`);
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大 (${formatSize(stat.size)}, 上限 ${formatSize(MAX_FILE_SIZE)}): ${absPath}`);
  }

  const filename = path.basename(absPath);
  const fileData = fs.readFileSync(absPath);
  const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');
  const contentType = opts?.contentType ?? guessMime(filename);
  const objectKey = `shared/${crypto.randomUUID()}/${filename}`;
  const total = stat.size;
  const report = (phase: UploadPhase, bytes: number) => opts?.onProgress?.({ phase, bytes, total });

  // 1. 先按 inline 走
  let inlineRejected = false;
  try {
    report('inline', 0);
    await conn.call('storage.put_object', {
      object_key: objectKey,
      content: fileData.toString('base64'),
      content_type: contentType,
      is_private: false,
      overwrite: true,
    });
    report('inline', total);
  } catch (e) {
    if (!isInlineLimitError(e)) throw e;
    inlineRejected = true;
  }

  // 2. inline 被拒：降级到 session + HTTP PUT
  if (inlineRejected) {
    report('session-create', 0);
    const session = await conn.call('storage.create_upload_session', {
      object_key: objectKey,
      size_bytes: total,
      content_type: contentType,
    });
    const uploadUrl = session?.upload_url as string | undefined;
    if (!uploadUrl) throw new Error('storage.create_upload_session 未返回 upload_url');

    // 简单 Buffer 上传 + 周期性进度（不用流，避免某些 storage 网关对 chunked / duplex 不友好）
    report('http-put', 0);
    const PROGRESS_TICK_MS = 250;
    let lastBytes = 0;
    const tickerStart = Date.now();
    // 简单的“估算”进度：实际上一次性发，但在等待响应期间按 elapsed 模拟字节数，让用户看到在跑
    const ticker = setInterval(() => {
      const elapsed = Date.now() - tickerStart;
      // 假设 2MB/s 估算；不超过 99%
      const estimated = Math.min(total - 1, Math.floor((elapsed / 1000) * 2 * 1024 * 1024));
      if (estimated > lastBytes) {
        lastBytes = estimated;
        report('http-put', estimated);
      }
    }, PROGRESS_TICK_MS);

    let uploadResp: Response;
    try {
      uploadResp = await fetch(uploadUrl, {
        method: 'PUT',
        body: new Blob([new Uint8Array(fileData)], { type: contentType }),
        headers: { 'Content-Type': contentType },
      });
    } finally {
      clearInterval(ticker);
    }
    if (!uploadResp.ok) throw new Error(`HTTP 上传失败: ${uploadResp.status}`);
    report('http-put', total);

    report('session-complete', total);
    await conn.call('storage.complete_upload', {
      object_key: objectKey,
      sha256,
      content_type: contentType,
      is_private: false,
      size_bytes: total,
    });
  }

  report('done', total);

  const attachment: Attachment = {
    owner_aid: ownerAid,
    object_key: objectKey,
    filename,
    size_bytes: total,
    sha256,
    content_type: contentType,
  };

  // 确定渲染类型
  let type: PayloadFileType;
  if (opts?.as) {
    if (!isValidPayloadType(opts.as)) {
      throw new Error(`--as 必须是 image|video|voice|file，收到: ${opts.as}`);
    }
    type = opts.as;
  } else {
    type = inferPayloadType(filename);
  }

  const payload: Record<string, unknown> = {
    type,
    attachments: [attachment],
  };
  if (opts?.text) payload.text = opts.text;
  else if (type === 'file') payload.text = `📎 ${filename} (${formatSize(total)})`;
  if (type === 'voice' && opts?.transcript) payload.transcript = opts.transcript;

  return { payload, type, attachment };
}
