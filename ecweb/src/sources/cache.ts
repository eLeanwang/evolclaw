/**
 * Cache 数据源 — daemon 统一 FileCache 的运行统计（命中率/读盘/驱逐/失效）。
 *
 * 复用 daemon 的 IPC socket：拉 `cache-stats`（只读）。IPC 无推送，
 * 故 1s 轮询 + JSON diff，仅在变化时 push（与 aidSource 同款）。
 * daemon 未运行（ipcQuery 返回 null）→ { daemonRunning:false, stats:null }。
 */

import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc-client.js';
import type { WatchSource } from './types.js';

async function buildSnapshot(): Promise<any> {
  const p = resolvePaths();
  const resp = await ipcQuery<{ ok: boolean; stats: any }>(p.socket, { type: 'cache-stats' });
  if (resp === null || !resp.ok) {
    // daemon 离线，或旧 daemon 不认识 cache-stats（回 {error:...}，ok 为 undefined）
    return { daemonRunning: resp !== null, supported: !!resp?.ok, stats: null };
  }
  return { daemonRunning: true, supported: true, stats: resp.stats };
}

export const cacheSource: WatchSource = {
  kind: 'cache',

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
