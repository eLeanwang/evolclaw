import {
  agentCreateNonInteractive,
  agentDelete,
  agentEnable,
  agentDisable,
  agentList,
  agentShow,
  agentSet,
  agentReload,
} from '../../cli/agent.js';
import type { DefaultsConfig } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { resolvePaths } from '../../paths.js';
import path from 'path';
import { loadAgent, saveAgent } from '../../config-store.js';
import { CreateStatusWriter, readCreateStatus, type CreatePhase } from './create-status.js';
import { deriveAgentProjectPath } from '../../utils/project-path.js';
import type { EventBus } from '../event-bus.js';

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
  eventBus?: EventBus;
}): Promise<void> {
  const agentDir = path.join(resolvePaths().agentsDir, opts.aid);
  const w = new CreateStatusWriter(agentDir, opts.aid);
  let curPhase: CreatePhase = 'validating';   // 跟踪当前环节，供 catch 兜底时标注正确 phase
  try {
    // onPhase 把 agentCreateNonInteractive 内部环节（0-3、5）映射到进度文件
    const res = await agentCreateNonInteractive({
      aid: opts.aid, name: opts.name, baseagent: opts.baseagent,
      project: opts.project, owner: opts.owner,
      onPhase: (phase, state, detail) => {
        if (state === 'begin') { curPhase = phase as CreatePhase; w.begin(phase as any); }
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
      curPhase = 'applying_config';
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
    opts.eventBus?.publish({
      type: 'agent:created',
      aid: opts.aid,
      name: opts.name,
      baseagent: opts.baseagent,
      projectPath: opts.project,
      owner: opts.owner,
      timestamp: Date.now(),
    });
    logger.info(`[agent-control] create ${opts.aid} ready`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    logger.warn(`[agent-control] create ${opts.aid} threw at ${curPhase}: ${msg}`);
    w.finishFailed(curPhase, msg);   // 兜底终态，标注真实失败环节
    opts.eventBus?.publish({ type: 'agent:error', aid: opts.aid, action: 'create', error: msg, timestamp: Date.now() });
  }
}

/** name=agent 的 menu.action 执行。peerId 自动填为新 agent 的 owner。
 *  create 受理即返回（D3）；delete/enable/disable 同步等结果。
 *  调用方负责传入已兜底的 args.project（见 command-handler 装配）。 */
export async function execAgentAction(
  action: string,
  args: Record<string, any> | undefined,
  peerId: string,
  eventBus?: EventBus,
): Promise<ExecResult> {
  const a = args ?? {};

  if (action === 'create') {
    if (!peerId) return { error: '缺少发起者 AID（无法绑定 owner）', code: 'INVALID_ARGS' };
    if (!a.aid || !a.name || !a.baseagent) {
      return { error: '缺少必填参数：aid / name / baseagent', code: 'INVALID_ARGS' };
    }
    if (!a.project || typeof a.project !== 'string') {
      return { error: 'project 缺失且无法兜底（需 defaults.projects.rootPath/defaultPath）', code: 'INVALID_ARGS' };
    }
    // D3: 受理即返回，重副作用转后台
    // 受理即返回；后台 promise fire-and-forget。runCreateInBackground 内部有 try/catch，
    // 但 CreateStatusWriter 构造（mkdir/写盘）在 try 之前，故再加一层兜底防未处理拒绝。
    void runCreateInBackground({
      aid: a.aid, name: a.name, baseagent: a.baseagent,
      project: a.project, owner: peerId,
      model: a.model, chatmode: a.chatmode,
      eventBus,
    }).catch(e => logger.error(`[agent-control] runCreateInBackground unhandled ${a.aid}: ${e?.message || e}`));
    return { data: { accepted: true, aid: a.aid } };
  }

  if (action === 'delete') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = await agentDelete(a.aid, false);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    eventBus?.publish({ type: 'agent:deleted', aid: res.aid, purged: res.purged, timestamp: Date.now() });
    return { data: { aid: res.aid, purged: res.purged } };
  }

  if (action === 'enable' || action === 'disable') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = action === 'enable' ? await agentEnable(a.aid) : await agentDisable(a.aid);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    eventBus?.publish({
      type: action === 'enable' ? 'agent:enabled' : 'agent:disabled',
      aid: res.aid,
      reloaded: res.reloaded,
      timestamp: Date.now(),
    });
    return { data: { aid: res.aid, enabled: res.enabled, reloaded: res.reloaded } };
  }

  if (action === 'reload') {
    if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
    const res = await agentReload(a.aid);
    if (!('ok' in res) || res.ok !== true) return { error: (res as any).error, code: classifyError((res as any).error) };
    eventBus?.publish({ type: 'agent:reloaded', aid: a.aid, timestamp: Date.now() });
    return { data: { aid: a.aid, reloaded: true } };
  }

  if (action === 'update') {
    const result = await execAgentUpdate(a);
    if (!('error' in result)) {
      eventBus?.publish({ type: 'agent:updated', aid: a.aid, timestamp: Date.now() });
    }
    return result;
  }

  return { error: `不支持的 action: ${action}`, code: 'INVALID_ARGS' };
}

/** name=agent 的 menu.action=update：仅落盘 config patch，不触发 reload。
 *  直接 loadAgent + saveAgent（不走 agentSet，避免其内部自动 evolagent.reload）——
 *  重载由用户在 Agents 页操作列手动触发（带任务执行检查）。
 *  AUN 渠道绑定 agent 顶层 aid，不可通过 patch 编辑：拒绝改 aid、拒绝 channels 数组里出现 aun 条目。
 *  可写字段：baseagents / projects / owners / chatmode / channels（非 aun）。 */
export async function execAgentUpdate(args: Record<string, any> | undefined): Promise<ExecResult> {
  const a = args ?? {};
  if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
  const p = a.patch ?? {};
  if (p.aid !== undefined) {
    return { error: 'aid 不可修改（AUN 身份绑定，如需换 AID 请删除后重建）', code: 'INVALID_ARGS' };
  }
  if (Array.isArray(p.channels) && p.channels.some((c: any) => c?.type === 'aun')) {
    return { error: 'AUN 渠道不可通过 patch 编辑（由 agent aid 隐式管理）', code: 'INVALID_ARGS' };
  }
  const config = loadAgent(a.aid);
  if (!config) return { error: `Agent "${a.aid}" not found`, code: 'NOT_FOUND' };

  let touched = false;
  if (p.baseagents !== undefined) { (config as any).baseagents = p.baseagents; touched = true; }
  if (p.projects !== undefined)   { (config as any).projects = p.projects; touched = true; }
  if (p.owners !== undefined)     { (config as any).owners = p.owners; touched = true; }
  if (p.chatmode !== undefined)   { (config as any).chatmode = p.chatmode; touched = true; }
  if (p.channels !== undefined)   { (config as any).channels = p.channels; touched = true; }
  if (!touched) return { error: 'patch 为空，无可写字段', code: 'INVALID_ARGS' };

  try {
    saveAgent(config);
  } catch (e: any) {
    return { error: e?.message || String(e), code: classifyError(e?.message || String(e)) };
  }
  return { data: { aid: a.aid, saved: true } };
}

/** project 兜底：显式值 > rootPath 合成 > defaultPath > undefined */
export function resolveProjectPath(
  explicit: string | undefined,
  aid: string,
  defaults: DefaultsConfig | null,
): string | undefined {
  if (explicit && explicit.trim()) return explicit;
  const root = defaults?.projects?.rootPath;
  if (root) return deriveAgentProjectPath(root, aid);
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
