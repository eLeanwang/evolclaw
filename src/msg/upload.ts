import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { guessMime, formatSize } from '../utils/mime.js';
import type { ShortConnection } from '../aun-rpc/index.js';
import { inferPayloadType, isValidPayloadType, type PayloadFileType } from './payload-type.js';

/** 小文件阈值：≤64KB 走 storage.put_object 内联 base64；>64KB 走 create_upload_session + HTTP PUT。 */
const INLINE_UPLOAD_LIMIT = 64 * 1024;

/** 单次上传最大大小（与 daemon sendFile 一致）。 */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
 * 流程：
 * 1. 读文件、算 sha256、推断 content_type
 * 2. 小文件 storage.put_object，大文件 storage.create_upload_session + HTTP PUT + storage.complete_upload
 * 3. 按 as / 扩展名 确定 payload.type
 * 4. 构造 payload（含 attachments 引用）
 *
 * 不做 outbox 持久化、不做 E2EE 加密兜底——这些是 daemon 的职责。
 * CLI 短连接场景假定网络稳定，失败抛异常给调用方处理。
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
    throw new Error(`文件过大 (${formatSize(stat.size)}, 上 ${formatSize(MAX_FILE_SIZE)}): ${absPath}`);
  }

  const filename = path.basename(absPath);
  const fileData = fs.readFileSync(absPath);
  const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');
  const contentType = opts?.contentType ?? guessMime(filename);
  const objectKey = `shared/${crypto.randomUUID()}/${filename}`;

  if (stat.size <= INLINE_UPLOAD_LIMIT) {
    await conn.call('storage.put_object', {
      object_key: objectKey,
      content: fileData.toString('base64'),
      content_type: contentType,
      is_private: false,
      overwrite: true,
    });
  } else {
    const session = await conn.call('storage.create_upload_session', {
      object_key: objectKey,
      size_bytes: stat.size,
      content_type: contentType,
    });
    const uploadUrl = session?.upload_url as string | undefined;
    if (!uploadUrl) throw new Error('storage.create_upload_session 未返回 upload_url');
    const uploadResp = await fetch(uploadUrl, { method: 'PUT', body: fileData });
    if (!uploadResp.ok) throw new Error(`HTTP 上传失败: ${uploadResp.status}`);
    await conn.call('storage.complete_upload', {
      object_key: objectKey,
      sha256,
      content_type: contentType,
      is_private: false,
      size_bytes: stat.size,
    });
  }

  const attachment: Attachment = {
    owner_aid: ownerAid,
    object_key: objectKey,
    filename,
    size_bytes: stat.size,
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
  else if (type === 'file') payload.text = `📎 ${filename} (${formatSize(stat.size)})`;
  if (type === 'voice' && opts?.transcript) payload.transcript = opts.transcript;

  return { payload, type, attachment };
}
