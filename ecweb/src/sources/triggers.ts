/**
 * Triggers 数据源 — 默认聚合全部 agent，也可按 agent 钻取触发器。
 *
 * snapshot:
 *   - agents: menu.options name=agent（agent 列表，同 Agents 页数据源）
 *   - triggers: 未选 agent 时遍历所有 agent 聚合；选中 agent 时只查该 agent
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

function normalizeAgent(item: any): { aid: string; label: string } | null {
  const aid = String(item?.value || item?.aid || '').trim();
  if (!aid) return null;
  const label = String(item?.label || item?.name || aid).trim() || aid;
  return { aid, label };
}

async function listTriggersForAgent(agentAid: string, agentLabel: string): Promise<any[]> {
  const p = resolvePaths();
  const resp = await menuExec({
    type: 'menu.options',
    id: `tr-list-${agentAid}`,
    name: 'trigger',
    args: { options: 'all' },
    agent: agentAid,
  });
  const items = Array.isArray(resp?.data) ? resp.data : [];
  return Promise.all(items.map(async (trigger: any) => {
    const effectiveAgentAid = trigger.agentAid || trigger.schedulerAid || agentAid;
    let definition: any = null;
    let scriptPreview: any = null;
    try {
      const shown = await ipcQuery<any>(
        p.socket,
        { type: 'trigger.show', agentAid: effectiveAgentAid, triggerId: trigger.id ?? trigger.value },
        5000,
      );
      if (shown?.ok) {
        definition = shown.definition ?? null;
        scriptPreview = shown.scriptPreview ?? null;
      }
    } catch { /* detail is best-effort; menu data remains usable */ }
    return {
      ...trigger,
      agentAid: effectiveAgentAid,
      agentLabel: trigger.agentLabel || agentLabel,
      definition,
      scriptPreview,
    };
  }));
}

async function buildSnapshot(params: Record<string, any>): Promise<any> {
  const agent = typeof params?.agent === 'string' && params.agent ? params.agent : null;
  const agentsResp = await menuExec({ type: 'menu.options', id: 'tr-agents', name: 'agent' });
  // menu.options 响应形如 { type:'menu.response', id, name, data: MenuItem[] }
  const agents: any[] = Array.isArray(agentsResp?.data) ? agentsResp.data : [];
  const agentInfos: Array<{ aid: string; label: string }> = agents
    .map(normalizeAgent)
    .filter((x: { aid: string; label: string } | null): x is { aid: string; label: string } => !!x);

  if (agent) {
    const found = agentInfos.find((x: { aid: string; label: string }) => x.aid === agent);
    const triggers = await listTriggersForAgent(agent, found?.label || agent);
    return { agents, triggers, selectedAgent: agent };
  }

  const batches = await Promise.all(agentInfos.map((x: { aid: string; label: string }) => listTriggersForAgent(x.aid, x.label)));
  const triggers = batches.flat();
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
