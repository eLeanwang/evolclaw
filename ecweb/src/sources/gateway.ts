/**
 * gateway.ts — 网关（baseagent 后端）配置数据源（只读代理）。
 *
 * ECWeb 不直接读写配置文件。snapshot 通过 daemon 的 menu.exec IPC 调
 * menu.query name=gateway，由 daemon 端的 command-handler-gateway-control 统一
 * 出数据（apiKey 已掩码）。写操作（update/test/delete）走前端 menuSend → menu IPC，
 * 不经过本 source。
 *
 * 连不上 daemon 时返回 { gateways: [], error } 让前端提示。
 */

import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc-client.js';
import type { WatchSource } from './types.js';

interface MenuResponse {
  ok: boolean;
  response?: { type: string; data?: any; error?: { code: string; message: string } };
  error?: string;
}

async function getSnapshot(): Promise<any> {
  const sock = resolvePaths().socket;
  const resp = await ipcQuery<MenuResponse>(
    sock,
    { type: 'menu.exec', payload: { type: 'menu.query', name: 'gateway', id: 'ecw-gateway-snap' } },
    5000,
  );

  if (!resp) {
    return { gateways: [], scopes: [], types: [], error: 'evolclaw 未运行或 socket 不可达' };
  }
  if (!resp.ok) {
    return { gateways: [], scopes: [], types: [], error: resp.error || 'daemon 返回失败' };
  }
  const inner = resp.response;
  if (inner?.error) {
    return { gateways: [], scopes: [], types: [], error: inner.error.message };
  }
  const data = inner?.data ?? {};
  return {
    gateways: Array.isArray(data.gateways) ? data.gateways : [],
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    types: Array.isArray(data.types) ? data.types : [],
  };
}

export const gatewaySource: WatchSource = {
  kind: 'gateway',

  async snapshot() {
    return getSnapshot();
  },

  subscribe(_params, _push) {
    // 网关配置变更不频繁，无文件监听；前端通过操作后主动 re-subscribe 刷新。
    return () => {};
  },
};
