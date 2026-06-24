/**
 * Monitor 数据源 — 复用 daemon 的 IPC socket（`monitor-snapshot` 命令）。
 *
 * 拉进程级 + 系统级运行指标（CPU/内存/uptime/loadAvg）+ 全局 stats（含最近错误）
 * + per-agent 汇总。IPC 无推送能力，故 2s 轮询 + JSON diff，仅在变化时 push。
 *
 * 时序数据在源侧维护「三档分辨率」滚动缓冲区，随快照一并下发，前端按所选周期切换：
 *   - fine   : 2s  桶 × 60  ≈ 近 2 分钟
 *   - mid    : 10s 桶 × 60  ≈ 近 10 分钟
 *   - coarse : 60s 桶 × 60  ≈ 近 1 小时
 * 每个桶内对 CPU/内存做均值聚合，避免长周期下点数爆炸。
 */

import { resolvePaths } from '../paths.js';
import { ipcQuery } from '../ipc-client.js';
import type { WatchSource } from './types.js';

interface TimePoint {
  ts: number;        // 桶起始时间
  procCpu: number;   // 进程 CPU %
  sysCpu: number;    // 系统 CPU %
  procRss: number;   // 进程 RSS bytes
  sysMemUsed: number; // 系统已用内存 bytes
}

interface Bucket extends TimePoint {
  _n: number;        // 桶内累计样本数（用于增量均值）
}

interface Resolution {
  bucketMs: number;
  cap: number;
  buf: Bucket[];
}

// 模块级缓冲区——所有订阅者共享同一份累积时序（单一事实源）。
const resolutions: Record<'fine' | 'mid' | 'coarse', Resolution> = {
  fine:   { bucketMs: 2_000,  cap: 60, buf: [] },
  mid:    { bucketMs: 10_000, cap: 60, buf: [] },
  coarse: { bucketMs: 60_000, cap: 60, buf: [] },
};

/** 把一个原始样本并入指定分辨率的桶（同桶内做增量均值，跨桶则新建）。 */
function ingest(res: Resolution, sample: Omit<TimePoint, 'ts'> & { ts: number }): void {
  const bucketTs = Math.floor(sample.ts / res.bucketMs) * res.bucketMs;
  const last = res.buf[res.buf.length - 1];
  if (last && last.ts === bucketTs) {
    const n = last._n + 1;
    last.procCpu    = last.procCpu    + (sample.procCpu    - last.procCpu)    / n;
    last.sysCpu     = last.sysCpu     + (sample.sysCpu     - last.sysCpu)     / n;
    last.procRss    = last.procRss    + (sample.procRss    - last.procRss)    / n;
    last.sysMemUsed = last.sysMemUsed + (sample.sysMemUsed - last.sysMemUsed) / n;
    last._n = n;
  } else {
    res.buf.push({ ts: bucketTs, procCpu: sample.procCpu, sysCpu: sample.sysCpu, procRss: sample.procRss, sysMemUsed: sample.sysMemUsed, _n: 1 });
    if (res.buf.length > res.cap) res.buf.shift();
  }
}

/** 导出某分辨率的纯数据点（剥掉内部 _n 字段）。 */
function exportBuf(res: Resolution): TimePoint[] {
  return res.buf.map((b) => ({ ts: b.ts, procCpu: round1(b.procCpu), sysCpu: round1(b.sysCpu), procRss: Math.round(b.procRss), sysMemUsed: Math.round(b.sysMemUsed) }));
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

async function fetchSnapshot(): Promise<any> {
  const p = resolvePaths();
  const resp = await ipcQuery<{ ok: boolean; snapshot: any }>(
    p.socket, { type: 'monitor-snapshot' }, 3000,
  );
  // resp === null → daemon 离线或 socket 不可达；resp.ok === false → 命令不受支持（旧 daemon）
  if (!resp?.ok) {
    return { daemonRunning: resp !== null, snapshot: null, history: { fine: [], mid: [], coarse: [] } };
  }
  const s = resp.snapshot;
  const sample = {
    ts: s.ts,
    procCpu: s.cpuPercent ?? 0,
    sysCpu: s.system?.cpuPercent ?? 0,
    procRss: s.memory?.rss ?? 0,
    sysMemUsed: s.system?.memUsed ?? 0,
  };
  ingest(resolutions.fine, sample);
  ingest(resolutions.mid, sample);
  ingest(resolutions.coarse, sample);

  return {
    daemonRunning: true,
    snapshot: s,
    history: {
      fine: exportBuf(resolutions.fine),
      mid: exportBuf(resolutions.mid),
      coarse: exportBuf(resolutions.coarse),
    },
  };
}

export const monitorSource: WatchSource = {
  kind: 'monitor',

  async snapshot(): Promise<any> {
    return fetchSnapshot();
  },

  subscribe(_params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await fetchSnapshot();
        const json = JSON.stringify(snap);
        if (json !== lastJson) { lastJson = json; push(snap); }
      } catch { /* ignore transient IPC errors */ }
    };

    const timer = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(timer); };
  },
};
