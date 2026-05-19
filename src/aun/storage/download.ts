import fs from 'fs';
import path from 'path';
import { rpcCall } from '../rpc/index.js';

export interface DownloadResult {
  ok: boolean;
  localPath: string;
  size: number;
  error?: string;
}

export async function storageDownload(aid: string, url: string, localPath?: string, opts?: { aunPath?: string }): Promise<DownloadResult> {
  // Parse URL: strip https:// prefix, split into owner + path
  const cleaned = url.replace(/^https?:\/\//, '');
  const slashIdx = cleaned.indexOf('/');
  if (slashIdx === -1) {
    return { ok: false, localPath: '', size: 0, error: 'URL 格式错误，需要 <owner-aid>/<path>' };
  }
  const ownerAid = cleaned.slice(0, slashIdx);
  const objectKey = cleaned.slice(slashIdx + 1);

  const ticketResult = await rpcCall(aid, 'storage.create_download_ticket', {
    owner: ownerAid,
    object_key: objectKey,
  }, { aunPath: opts?.aunPath });

  if (!ticketResult.ok) {
    return { ok: false, localPath: '', size: 0, error: JSON.stringify(ticketResult.error) };
  }

  const downloadUrl = ticketResult.result.download_url;
  const resp = await fetch(downloadUrl);
  if (!resp.ok) {
    return { ok: false, localPath: '', size: 0, error: `HTTP GET failed: ${resp.status}` };
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const outPath = localPath ?? path.basename(objectKey);
  fs.writeFileSync(outPath, buffer);

  return { ok: true, localPath: outPath, size: buffer.length };
}
