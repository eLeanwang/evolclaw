import { createShortConnection } from './connection.js';

export interface RpcResult {
  ok: boolean;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export async function rpcCall(aid: string, method: string, params: any, opts?: { aunPath?: string }): Promise<RpcResult> {
  const conn = await createShortConnection(aid, opts);
  try {
    const result = await conn.call(method, params);
    return { ok: true, result };
  } catch (e: any) {
    if (e.code !== undefined && e.message !== undefined) {
      return { ok: false, error: { code: e.code, message: e.message, data: e.data } };
    }
    return { ok: false, error: { code: -1, message: String(e.message || e) } };
  } finally {
    await conn.close();
  }
}

export async function rpcBatch(aid: string, calls: Array<{ method: string; params: any }>, opts?: { aunPath?: string }): Promise<RpcResult[]> {
  const conn = await createShortConnection(aid, opts);
  const results: RpcResult[] = [];
  try {
    for (const { method, params } of calls) {
      try {
        const result = await conn.call(method, params);
        results.push({ ok: true, result });
      } catch (e: any) {
        if (e.code !== undefined && e.message !== undefined) {
          results.push({ ok: false, error: { code: e.code, message: e.message, data: e.data } });
        } else {
          results.push({ ok: false, error: { code: -1, message: String(e.message || e) } });
        }
        break; // stop on first failure
      }
    }
  } finally {
    await conn.close();
  }
  return results;
}
