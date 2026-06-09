/**
 * System 数据源 — 纯进程级看板。
 *
 * snapshot: menu.list（探活）+ menu.query name=system（version/fastaunVersion/uptime/pid/node）。
 * 另注入 ecwebVersion（ECWeb 进程自身 package.json 版本，由 server.ts 合并，不走 daemon IPC）。
 * check / upgrade 结果不在快照里——由前端按钮触发 menu.action 后写入 state。
 *
 * subscribe: 3s 轮询 + JSON diff，仅变化时 push。
 */

import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc-client.js';
import type { WatchSource } from './types.js';

async function menuExec(payload: any): Promise<any> {
  const p = resolvePaths();
  const r = await ipcQuery<{ ok: boolean; response?: any }>(
    p.socket, { type: 'menu.exec', payload }, 5000,
  );
  return r?.ok ? r.response : null;
}

async function buildSnapshot(): Promise<any> {
  const [listResp, sysResp] = await Promise.all([
    menuExec({ type: 'menu.list', id: 'sys-list' }),
    menuExec({ type: 'menu.query', id: 'sys-q', name: 'system' }),
  ]);
  const daemonRunning = listResp !== null;
  // sysResp 形如 { type:'menu.response', id, name, data | error }
  const system = sysResp?.data ?? null;
  return { daemonRunning, system, upgrade: null, check: null };
}

export const systemSource: WatchSource = {
  kind: 'system',

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

    const timer = setInterval(tick, 3000);
    return () => { stopped = true; clearInterval(timer); };
  },
};
