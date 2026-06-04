import {
  agentCreateNonInteractive,
  agentDelete,
  agentEnable,
  agentDisable,
  agentList,
  agentShow,
  agentSet,
} from '../../cli/agent.js';
import type { DefaultsConfig } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { resolvePaths } from '../../paths.js';
import path from 'path';
import { CreateStatusWriter, readCreateStatus } from './create-status.js';

export type ExecResult = { data: any } | { error: string; code: string };

/** 把 cli/agent.ts 的 error 字符串映射为结构化错误码 */
function classifyError(error: string): string {
  if (/already exists/i.test(error)) return 'CONFLICT';
  if (/not found/i.test(error)) return 'NOT_FOUND';
  if (/invalid|must be|required|缺少/i.test(error)) return 'INVALID_ARGS';
  return 'INTERNAL';
}

/** 后台异步：实际创建 agent + 落 model/chatmode，全程写构建进度（D3）。
 *  失败仅写日志 + create-status，不回传（受理即返回）。
 *  agentSet key 对照 cli/agent.ts 的 setNestedValue：
 *  model → 'models.default'（ModelsBlock.default）；chatmode → 'chatmode'（ChatmodeBlock 对象）。 */
async function runCreateInBackground(opts: {
  aid: string; name: string; baseagent: string; project: string; owner: string;
  model?: string; chatmode?: any;
}): Promise<void> {
  const agentDir = path.join(resolvePaths().agentsDir, opts.aid);
  const w = new CreateStatusWriter(agentDir, opts.aid);
  try {
    // onPhase 把 agentCreateNonInteractive 内部环节（0-3、5）映射到进度文件
    const res = await agentCreateNonInteractive({
      aid: opts.aid, name: opts.name, baseagent: opts.baseagent,
      project: opts.project, owner: opts.owner,
      onPhase: (phase, state, detail) => {
        if (state === 'begin') w.begin(phase as any);
        else if (state === 'done') w.done(phase as any, detail);
        else if (state === 'warn') w.warn(phase as any, detail);
        else if (state === 'failed') w.finishFailed(phase as any, detail ?? 'failed');
      },
    });
    if (!('ok' in res) || res.ok !== true) {
      // 硬失败：onPhase('failed') 已写终态；这里仅兜底日志（防回调未覆盖的 return 路径）
      const err = (res as any).error;
      logger.warn(`[agent-control] create ${opts.aid} failed: ${err}`);
      return;
    }
    // 环节 4：applying_config（model/chatmode，agentCreateNonInteractive 之外）
    if (opts.model || opts.chatmode) {
      w.begin('applying_config');
      let warned: string | undefined;
      if (opts.model) {
        const r = await agentSet(opts.aid, 'models.default', opts.model);
        if (!('ok' in r) || !r.ok) warned = `model: ${(r as any).error}`;
      }
      if (opts.chatmode) {
        const r = await agentSet(opts.aid, 'chatmode', JSON.stringify(opts.chatmode));
        if (!('ok' in r) || !r.ok) warned = `${warned ? warned + '; ' : ''}chatmode: ${(r as any).error}`;
      }
      if (warned) { logger.warn(`[agent-control] applying_config ${opts.aid}: ${warned}`); w.warn('applying_config', warned); }
      else w.done('applying_config');
    }
    w.finishReady();
    logger.info(`[agent-control] create ${opts.aid} ready`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    logger.warn(`[agent-control] create ${opts.aid} threw: ${msg}`);
    w.finishFailed('validating', msg);   // 兜底终态
  }
}

/** name=agent 的 menu.action 执行。peerId 自动填为新 agent 的 owner。
 *  create 受理即返回（D3）；delete/enable/disable 同步等结果。
 *  调用方负责传入已兜底的 args.project（见 command-handler 装配）。 */
export async function execAgentAction(
  action: string,
  args: Record<string, any> | undefined,
  peerId: string,
): Promise<ExecResult> {
  const a = args ?? {};

  if (action === 'create') {
    if (!a.aid || !a.name || !a.baseagent) {
      return { error: '缺少必填参数：aid / name / baseagent', code: 'INVALID_ARGS' };
    }
    if (!a.project || typeof a.project !== 'string') {
      return { error: 'project 缺失且无法兜底（需 defaults.projects.rootPath/defaultPath）', code: 'INVALID_ARGS' };
    }
    // D3: 受理即返回，重副作用转后台
    void runCreateInBackground({
      aid: a.aid, name: a.name, baseagent: a.baseagent,
      project: a.project, owner: peerId,
      model: a.model, chatmode: a.chatmode,
    });
    return { data: { accepted: true, aid: a.aid } };
  }

  if (action === 'delete') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = await agentDelete(a.aid, false);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    return { data: { aid: res.aid, purged: res.purged } };
  }

  if (action === 'enable' || action === 'disable') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = action === 'enable' ? await agentEnable(a.aid) : await agentDisable(a.aid);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    return { data: { aid: res.aid, enabled: res.enabled, reloaded: res.reloaded } };
  }

  return { error: `不支持的 action: ${action}`, code: 'INVALID_ARGS' };
}

/** project 兜底：显式值 > rootPath 合成 > defaultPath > undefined */
export function resolveProjectPath(
  explicit: string | undefined,
  aid: string,
  defaults: DefaultsConfig | null,
): string | undefined {
  if (explicit && explicit.trim()) return explicit;
  const root = defaults?.projects?.rootPath;
  if (root) return path.join(root, aid.split('.')[0]);
  return defaults?.projects?.defaultPath;
}

/** name=agent 的 menu.query：查单个 agent 详情，附构建进度（D3）。 */
export async function execAgentQuery(args: Record<string, any> | undefined): Promise<ExecResult> {
  const aid = args?.aid;
  if (!aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
  const res = await agentShow(aid);
  if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
  // 叠加构建进度（create 受理后、ready 前可见；ready 后文件仍在，可反映软失败 warn）
  const agentDir = path.join(resolvePaths().agentsDir, aid);
  const progress = readCreateStatus(agentDir);
  return { data: progress ? { ...res, createProgress: progress } : res };
}

/** name=agent 的 menu.options：列出 agent（enabled 默认 / all） */
export async function execAgentOptions(args: Record<string, any> | undefined): Promise<ExecResult> {
  const scope = args?.options === 'all' ? 'all' : 'enabled';
  const res = await agentList();
  if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
  const agents = scope === 'all'
    ? res.agents
    : res.agents.filter((x: any) => x.status !== 'disabled');
  return { data: { agents, scope } };
}
