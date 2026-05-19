import fs from 'fs';
import crypto from 'crypto';
import { rpcCall } from '../rpc/index.js';

export interface UploadResult {
  ok: boolean;
  objectKey: string;
  error?: string;
}

export async function storageUpload(aid: string, localFile: string, remotePath: string, opts?: { isPublic?: boolean; aunPath?: string }): Promise<UploadResult> {
  const fileBuffer = fs.readFileSync(localFile);
  const contentType = 'application/octet-stream';
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  const createResult = await rpcCall(aid, 'storage.create_upload_session', {
    object_key: remotePath,
    content_type: contentType,
    content_length: fileBuffer.length,
    is_private: !(opts?.isPublic),
  }, { aunPath: opts?.aunPath });

  if (!createResult.ok) {
    return { ok: false, objectKey: remotePath, error: JSON.stringify(createResult.error) };
  }

  const uploadUrl = createResult.result.upload_url;
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Blob([fileBuffer]),
    redirect: 'follow',
  });
  if (!putResp.ok) {
    return { ok: false, objectKey: remotePath, error: `HTTP PUT failed: ${putResp.status}` };
  }

  const completeResult = await rpcCall(aid, 'storage.complete_upload', {
    object_key: remotePath,
    sha256,
  }, { aunPath: opts?.aunPath });

  if (!completeResult.ok) {
    return { ok: false, objectKey: remotePath, error: JSON.stringify(completeResult.error) };
  }

  return { ok: true, objectKey: remotePath };
}
