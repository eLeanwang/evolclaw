import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { agentmdGet, agentmdPut, updateAgentMdFrontmatterAvatar } from '../aun/aid/agentmd.js';
import { storageRm, storageUpload } from '../aun/storage/index.js';
import { logger } from './logger.js';
import { validateImage } from './media-cache.js';

export type UploadAvatarErrorCode = 'INVALID_ARGS' | 'NOT_FOUND' | 'UPLOAD_FAILED';

export interface UploadAvatarResult {
  ok: boolean;
  publicUrl?: string;
  objectKey?: string;
  error?: string;
  code?: UploadAvatarErrorCode;
}

const MAX_AVATAR_BYTES = 500 * 1024;
const ALLOWED_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function fail(error: string, code: UploadAvatarErrorCode): UploadAvatarResult {
  return { ok: false, error, code };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function classifyAgentMdReadError(e: unknown): UploadAvatarErrorCode {
  return /not found|404|不存在/i.test(messageOf(e)) ? 'NOT_FOUND' : 'UPLOAD_FAILED';
}

function estimateDecodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function formatKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)}KB`;
}

function parseAvatarDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | UploadAvatarResult {
  if (typeof dataUrl !== 'string') {
    return fail('avatar 必须是 data URL 字符串', 'INVALID_ARGS');
  }

  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/);
  if (!match) {
    return fail('avatar 格式错误：必须是 data:image/(png|jpeg|webp);base64,', 'INVALID_ARGS');
  }

  const declaredMime = match[1];
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    return fail('avatar base64 编码无效', 'INVALID_ARGS');
  }

  const estimatedSize = estimateDecodedBytes(base64);
  if (estimatedSize > MAX_AVATAR_BYTES) {
    return fail(`头像大小超过 500KB 限制（当前: ${formatKb(estimatedSize)}）`, 'INVALID_ARGS');
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_AVATAR_BYTES) {
    return fail(`头像大小超过 500KB 限制（当前: ${formatKb(buffer.length)}）`, 'INVALID_ARGS');
  }

  return { mime: declaredMime, buffer };
}

async function cleanupUploadedAvatar(aid: string, objectKey: string, aunPath: string | undefined): Promise<void> {
  try {
    await storageRm(aid, objectKey, { aunPath });
  } catch (e) {
    logger.warn(`[avatar-upload] cleanup failed for ${aid}/${objectKey}: ${messageOf(e)}`);
  }
}

export async function uploadAvatar(
  aid: string,
  dataUrl: string,
  opts?: { aunPath?: string },
): Promise<UploadAvatarResult> {
  const parsed = parseAvatarDataUrl(dataUrl);
  if ('ok' in parsed) return parsed;

  const validated = await validateImage(parsed.buffer, {
    maxSize: MAX_AVATAR_BYTES,
    allowedMimes: ALLOWED_AVATAR_MIMES,
  });
  if (validated.mime === null) {
    return fail(`头像格式验证失败：${validated.reason}`, 'INVALID_ARGS');
  }
  if (validated.mime !== parsed.mime) {
    return fail(`头像格式验证失败：声明 ${parsed.mime}，实际 ${validated.mime}`, 'INVALID_ARGS');
  }

  let agentMd: string;
  try {
    agentMd = await agentmdGet(aid, { aunPath: opts?.aunPath });
  } catch (e) {
    return fail(`agent.md 不存在或无法读取: ${messageOf(e)}`, classifyAgentMdReadError(e));
  }

  const ext = MIME_EXT[validated.mime] ?? 'img';
  const objectKey = `shared/avatars/${crypto.randomUUID()}.${ext}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-avatar-'));
  const tmpPath = path.join(tmpDir, `avatar.${ext}`);
  let uploaded = false;

  try {
    fs.writeFileSync(tmpPath, parsed.buffer);
    const uploadedAvatar = await storageUpload(aid, tmpPath, objectKey, {
      isPublic: true,
      contentType: validated.mime,
      aunPath: opts?.aunPath,
    });
    if (!uploadedAvatar.ok) {
      return fail(`上传到 AUN storage 失败: ${uploadedAvatar.error || 'unknown error'}`, 'UPLOAD_FAILED');
    }
    uploaded = true;

    const publicUrl = uploadedAvatar.publicUrl ?? `https://${aid}/${uploadedAvatar.objectKey}`;
    const updated = updateAgentMdFrontmatterAvatar(agentMd, publicUrl);
    try {
      await agentmdPut(updated.content, { aid, aunPath: opts?.aunPath });
    } catch (e) {
      await cleanupUploadedAvatar(aid, uploadedAvatar.objectKey, opts?.aunPath);
      return fail(`更新 agent.md 失败: ${messageOf(e)}`, 'UPLOAD_FAILED');
    }

    logger.info(`[avatar-upload] uploaded ${uploadedAvatar.objectKey} -> ${publicUrl}`);
    return { ok: true, publicUrl, objectKey: uploadedAvatar.objectKey };
  } catch (e) {
    if (uploaded) await cleanupUploadedAvatar(aid, objectKey, opts?.aunPath);
    return fail(messageOf(e), 'UPLOAD_FAILED');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
