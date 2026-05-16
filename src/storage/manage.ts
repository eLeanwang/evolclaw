import { rpcCall, type RpcResult } from '../aun-rpc/caller.js';

export async function storageLs(aid: string, prefix?: string, opts?: { aunPath?: string }): Promise<RpcResult> {
  return rpcCall(aid, 'storage.list_objects', { prefix: prefix || '' }, { aunPath: opts?.aunPath });
}

export async function storageRm(aid: string, remotePath: string, opts?: { aunPath?: string }): Promise<RpcResult> {
  return rpcCall(aid, 'storage.delete_object', { object_key: remotePath }, { aunPath: opts?.aunPath });
}

export async function storageQuota(aid: string, opts?: { aunPath?: string }): Promise<RpcResult> {
  return rpcCall(aid, 'storage.get_quota', {}, { aunPath: opts?.aunPath });
}
