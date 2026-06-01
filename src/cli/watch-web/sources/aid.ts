/**
 * AID 数据源 — 复用 daemon 的 IPC socket（与 `watch aid` 同源）。
 *
 * daemon 运行时：拉 aun-aids / aun-aid-stats / status。
 * daemon 未运行时：降级到 instance-registry 的 scanInstances()。
 * IPC 无推送能力，故用 1s 轮询 + JSON diff，仅在变化时 push。
 */

import { resolvePaths } from '../../../paths.js';
import { ipcQuery } from '../../../ipc.js';
import { scanInstances } from '../../../utils/instance-registry.js';
import type { WatchSource } from './types.js';

async function buildSnapshot(): Promise<any> {
  const p = resolvePaths();
  const [aidsResp, statsResp, statusResp, agentsResp] = await Promise.all([
    ipcQuery<{ ok: boolean; aids: any[] }>(p.socket, { type: 'aun-aids' }),
    ipcQuery<{ ok: boolean; stats: any[] }>(p.socket, { type: 'aun-aid-stats' }),
    ipcQuery<any>(p.socket, { type: 'status' }),
    ipcQuery<{ ok: boolean; agents: any[] }>(p.socket, { type: 'evolagent.list' }),
  ]);

  const daemonRunning = aidsResp !== null || statusResp !== null;

  if (!daemonRunning) {
    // 降级：读 instance-registry，标注 daemon 未运行
    const inst = scanInstances();
    const aids = Array.from(inst.aidLastActivity.entries()).map(([aid, info]) => ({
      aid,
      status: info.event === 'disconnected' ? 'disconnected' : 'offline',
      lastActivity: info.ts,
      lastEvent: info.event,
    }));
    return { daemonRunning: false, aids, stats: [], agents: [] };
  }

  return {
    daemonRunning: true,
    aids: aidsResp?.aids ?? [],
    stats: statsResp?.stats ?? [],
    status: statusResp ?? null,
    agents: agentsResp?.agents ?? [],
  };
}

export const aidSource: WatchSource = {
  kind: 'aid',

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
        if (json !== lastJson) {
          lastJson = json;
          push(snap);
        }
      } catch { /* ignore transient IPC errors */ }
    };

    const timer = setInterval(tick, 1000);
    return () => { stopped = true; clearInterval(timer); };
  },
};
