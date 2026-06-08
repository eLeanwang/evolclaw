/**
 * Control 数据源 — 通过 daemon IPC 的 menu.exec 代理拉取 menu.* 当前状态。
 *
 * snapshot: 一批 menu.list + menu.query（各 name 当前值）+ menu.options（列表类）。
 * subscribe: 1s 轮询 + JSON diff，仅变化时 push（IPC 无推送，与 aid.ts 同款）。
 *
 * 写操作（update/action）不走这里——浏览器经 WS `menu` 消息直发，requestId 配对响应。
 */

import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc-client.js';
import type { WatchSource } from './types.js';

// 支持 query 当前值的 name
const QUERY_NAMES = ['system', 'pwd', 'baseagent', 'model', 'effort',
                     'chatmode', 'permission', 'activity', 'dispatch', 'session'];
// 列表类（options）
const OPTIONS_NAMES = ['session', 'agent', 'trigger'];

async function menuExec(payload: any): Promise<any> {
  const p = resolvePaths();
  const r = await ipcQuery<{ ok: boolean; response?: any }>(
    p.socket, { type: 'menu.exec', payload }, 5000,
  );
  return r?.ok ? r.response : null;
}

async function buildSnapshot(): Promise<any> {
  const [listResp, ...queryResps] = await Promise.all([
    menuExec({ type: 'menu.list', id: 'ctrl-list' }),
    ...QUERY_NAMES.map((name, i) => menuExec({ type: 'menu.query', id: `ctrl-q-${i}`, name })),
  ]);
  const optResps = await Promise.all(
    OPTIONS_NAMES.map((name, i) => menuExec({ type: 'menu.options', id: `ctrl-o-${i}`, name })),
  );

  const daemonRunning = listResp !== null;

  const queries: Record<string, any> = {};
  QUERY_NAMES.forEach((name, i) => { queries[name] = queryResps[i]; });
  const options: Record<string, any> = {};
  OPTIONS_NAMES.forEach((name, i) => { options[name] = optResps[i]; });

  return { daemonRunning, list: listResp, queries, options };
}

export const controlSource: WatchSource = {
  kind: 'control',

  async snapshot(): Promise<any> {
    return buildSnapshot();
  },

  subscribe(_params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await buildSnapshot();
        const json = JSON.stringify(snap);
        if (json !== lastJson) { lastJson = json; push(snap); }
      } catch { /* ignore transient IPC errors */ }
    };

    const timer = setInterval(tick, 1000);
    return () => { stopped = true; clearInterval(timer); };
  },
};
