import fs from 'fs';
import crypto from 'crypto';
import { rpcCall } from '../rpc/index.js';

export interface UploadResult {
  ok: boolean;
  objectKey: string;
  publicUrl?: string;
  error?: string;
}

function rpcErrorToString(error: unknown): string {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function pickUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export async function storageUpload(
  aid: string,
  localFile: string,
  remotePath: string,
  opts?: { isPublic?: boolean; aunPath?: string; contentType?: string },
): Promise<UploadResult> {
  const fileBuffer = fs.readFileSync(localFile);
  const contentType = opts?.contentType ?? 'application/octet-stream';
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  const createResult = await rpcCall(aid, 'storage.create_upload_session', {
    object_key: remotePath,
    content_type: contentType,
    size_bytes: fileBuffer.length,
  }, { aunPath: opts?.aunPath });

  if (!createResult.ok) {
    return { ok: false, objectKey: remotePath, error: rpcErrorToString(createResult.error) };
  }

  const uploadUrl = createResult.result.upload_url;
  if (!uploadUrl) {
    return { ok: false, objectKey: remotePath, error: 'storage.create_upload_session did not return upload_url' };
  }
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Blob([new Uint8Array(fileBuffer)], { type: contentType }),
    redirect: 'follow',
  });
  if (!putResp.ok) {
    return { ok: false, objectKey: remotePath, error: `HTTP PUT failed: ${putResp.status}` };
  }

  const completeResult = await rpcCall(aid, 'storage.complete_upload', {
    object_key: remotePath,
    sha256,
    content_type: contentType,
    size_bytes: fileBuffer.length,
    is_private: !(opts?.isPublic),
  }, { aunPath: opts?.aunPath });

  if (!completeResult.ok) {
    return { ok: false, objectKey: remotePath, error: rpcErrorToString(completeResult.error) };
  }

  let publicUrl = pickUrl(completeResult.result?.url);
  if (opts?.isPublic) {
    if (!publicUrl) {
      const ticketResult = await rpcCall(aid, 'storage.create_download_ticket', {
        object_key: remotePath,
        expire_in_seconds: 86400 * 30, // 30天
      }, { aunPath: opts?.aunPath });
      if (ticketResult.ok) {
        publicUrl = pickUrl(ticketResult.result?.url) ?? pickUrl(ticketResult.result?.download_url);
      }
    }
    publicUrl ??= `https://${aid}/${remotePath}`;
  }

  return { ok: true, objectKey: remotePath, publicUrl };
}
