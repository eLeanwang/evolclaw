/**
 * AID 数据源 — 复用 daemon 的 IPC socket（与 evolclaw `watch aid` 同源）。
 *
 * daemon 运行时：拉 aun-aids / aun-aid-stats / status / evolagent.list。
 * daemon 未运行时：降级到读 instance/ 目录的 aid-*.jsonl（精简版 scanInstances）。
 * IPC 无推送能力，故 1s 轮询 + JSON diff，仅在变化时 push。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc-client.js';
import type { WatchSource } from './types.js';

/** 精简版实例扫描：仅在 daemon 离线时降级用，读各 alive main 进程的 aid 活动日志 */
function scanAidActivity(): Map<string, { ts: number; event: string }> {
  const result = new Map<string, { ts: number; event: string }>();
  const dir = resolvePaths().instanceDir;
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return result; }

  for (const file of files) {
    if (!file.startsWith('main-') || !file.endsWith('.json')) continue;
    let rec: any;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')); } catch { continue; }
    if (!rec?.pid) continue;
    // 进程存活检测（轻量：signal 0）
    try { process.kill(rec.pid, 0); } catch { continue; }

    // 读该 pid 的 aid-<pid>.jsonl，按 aid 取最后活动
    const aidLog = path.join(dir, `aid-${rec.pid}.jsonl`);
    let content: string;
    try { content = fs.readFileSync(aidLog, 'utf-8'); } catch { continue; }
    for (const line of content.trim().split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.aid && ev.ts) {
          const prev = result.get(ev.aid);
          if (!prev || ev.ts > prev.ts) result.set(ev.aid, { ts: ev.ts, event: ev.event });
        }
      } catch { /* skip */ }
    }
  }
  return result;
}

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
    const activity = scanAidActivity();
    const aids = Array.from(activity.entries()).map(([aid, info]) => ({
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
        if (json !== lastJson) { lastJson = json; push(snap); }
      } catch { /* ignore transient IPC errors */ }
    };

    const timer = setInterval(tick, 1000);
    return () => { stopped = true; clearInterval(timer); };
  },
};
