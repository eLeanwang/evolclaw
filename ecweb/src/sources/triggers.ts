/**
 * Triggers 数据源 — 按 agent 钻取触发器。
 *
 * snapshot:
 *   - agents: menu.options name=agent（agent 列表，同 Agents 页数据源）
 *   - triggers: 选中 agent 时 menu.options name=trigger（带 options=all），并带 agent 参数解析其 triggerManager
 *
 * subscribe: 2s 轮询 + JSON diff，仅变化时 push。
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

async function buildSnapshot(params: Record<string, any>): Promise<any> {
  const agent = params?.agent ?? null;
  const [agentsResp, triggersResp] = await Promise.all([
    menuExec({ type: 'menu.options', id: 'tr-agents', name: 'agent' }),
    agent
      ? menuExec({ type: 'menu.options', id: 'tr-list', name: 'trigger', args: { options: 'all' }, agent })
      : Promise.resolve(null),
  ]);
  // menu.options 响应形如 { type:'menu.response', id, name, data: MenuItem[] }
  const agents = Array.isArray(agentsResp?.data) ? agentsResp.data : [];
  const triggers = Array.isArray(triggersResp?.data) ? triggersResp.data : [];
  return { agents, triggers, selectedAgent: agent };
}

export const triggersSource: WatchSource = {
  kind: 'triggers',

  async snapshot(params?: Record<string, any>): Promise<any> {
    return buildSnapshot(params ?? {});
  },

  subscribe(params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await buildSnapshot(params);
        const json = JSON.stringify(snap);
        if (json !== lastJson) { lastJson = json; push(snap); }
      } catch { /* ignore transient IPC errors */ }
    };

    const timer = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(timer); };
  },
};
