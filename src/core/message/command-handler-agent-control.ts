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
import { resolvePaths, resolveRoot } from '../../paths.js';
import path from 'path';
import { loadAgent, saveAgent } from '../../config-store.js';
import { CreateStatusWriter, readCreateStatus, type CreatePhase } from './create-status.js';
import { deriveAgentProjectPath } from '../../utils/project-path.js';
import type { EventBus } from '../event-bus.js';
import { uploadAvatar } from '../../utils/avatar-upload.js';
import { agentmdGet, agentmdPut, updateAgentMdFrontmatterName } from '../../aun/aid/agentmd.js';

export type ExecResult = { data: any } | { error: string; code: string };

const SUPPORTED_AGENT_PATCH_FIELDS = new Set(['aid', 'name', 'avatar', 'baseagents', 'projects', 'owners', 'chatmode', 'channels']);

/** 把 cli/agent.ts 的 error 字符串映射为结构化错误码 */
function classifyError(error: string): string {
  if (/already exists/i.test(error)) return 'CONFLICT';
  if (/not found/i.test(error)) return 'NOT_FOUND';
  if (/invalid|must be|required|缺少/i.test(error)) return 'INVALID_ARGS';
  return 'INTERNAL';
}

function classifyAgentMdError(error: string): string {
  if (/not found|404|不存在/i.test(error)) return 'NOT_FOUND';
  if (/invalid|must be|required|缺少|frontmatter|empty|为空/i.test(error)) return 'INVALID_ARGS';
  return 'UPLOAD_FAILED';
}

async function updateAgentMdName(aid: string, value: unknown): Promise<{ ok: true; name: string } | { ok: false; error: string; code: string }> {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { ok: false, error: 'name 不能为空', code: 'INVALID_ARGS' };
  try {
    const content = await agentmdGet(aid, { aunPath: resolveRoot() });
    const updated = updateAgentMdFrontmatterName(content, name);
    await agentmdPut(updated.content, { aid, aunPath: resolveRoot() });
    return { ok: true, name };
  } catch (e: any) {
    const message = e?.message || String(e);
    return { ok: false, error: `更新 agent.md name 失败: ${message}`, code: classifyAgentMdError(message) };
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function buildCreateProgressOnlyAgent(aid: string, progress: any): Record<string, any> {
  const agentDir = path.join(resolvePaths().agentsDir, aid);
  return {
    aid,
    status: progress?.status === 'failed' ? 'error' : 'stopped',
    identity: { name: null, description: null },
    config: {
      baseagent: null,
      model: null,
      effort: null,
      chatmode: null,
      owners: [],
      channels: [],
    },
    connection: null,
    sessions: { active: 0, last_activity: null },
    paths: {
      config: toPosix(path.join(agentDir, 'config.json')),
      agent_md: null,
      project: null,
      data: toPosix(path.join(agentDir, 'data')),
    },
    createProgress: progress,
  };
}

/** 后台异步：实际创建 agent + 落 model/chatmode，全程写构建进度（D3）。
 *  失败仅写日志 + create-status，不回传（受理即返回）。
 *  agentSet key 对照 cli/agent.ts 的 setNestedValue：
 *  model → 'models.default'（ModelsBlock.default）；chatmode → 'chatmode'（ChatmodeBlock 对象）。 */
async function runCreateInBackground(opts: {
  aid: string; name: string; baseagent: string; project: string; owner: string;
  model?: string; chatmode?: any;
  eventBus?: EventBus;
}, w: CreateStatusWriter): Promise<void> {
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
    // D3: accepted=true 必须意味着后续 query 能查到该 AID 的创建状态。
    let progressWriter: CreateStatusWriter;
    try {
      progressWriter = new CreateStatusWriter(path.join(resolvePaths().agentsDir, a.aid), a.aid);
    } catch (e: any) {
      return { error: `创建进度状态初始化失败: ${e?.message || e}`, code: 'INTERNAL' };
    }
    // 重副作用转后台，后台内部有 try/catch；这里 catch 只兜底未预期拒绝。
    void runCreateInBackground({
      aid: a.aid, name: a.name, baseagent: a.baseagent,
      project: a.project, owner: peerId,
      model: a.model, chatmode: a.chatmode,
      eventBus,
    }, progressWriter).catch(e => logger.error(`[agent-control] runCreateInBackground unhandled ${a.aid}: ${e?.message || e}`));
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
      if ((result.data as any)?.avatar) {
        eventBus?.publish({
          type: 'agent:avatar_updated',
          aid: a.aid,
          avatar: (result.data as any).avatar,
          timestamp: Date.now(),
        });
      }
      eventBus?.publish({
        type: 'agent:updated',
        aid: a.aid,
        nameChanged: Boolean((result.data as any)?.name),
        timestamp: Date.now(),
      });
    }
    return result;
  }

  return { error: `不支持的 action: ${action}`, code: 'INVALID_ARGS' };
}

/** name=agent 的 menu.action=update：落盘 config patch / agent.md patch，不触发 reload。
 *  直接 loadAgent + saveAgent（不走 agentSet，避免其内部自动 evolagent.reload）——
 *  重载由用户在 Agents 页操作列手动触发（带任务执行检查）。
 *  AUN 渠道绑定 agent 顶层 aid，不可通过 patch 编辑：拒绝改 aid、拒绝 channels 数组里出现 aun 条目。
 *  可写字段：name / baseagents / projects / owners / chatmode / channels（非 aun）。 */
export async function execAgentUpdate(args: Record<string, any> | undefined): Promise<ExecResult> {
  const a = args ?? {};
  if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
  const p = a.patch ?? {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { error: 'patch 必须是对象', code: 'INVALID_ARGS' };
  }
  const unsupported = Object.keys(p).filter(k => !SUPPORTED_AGENT_PATCH_FIELDS.has(k));
  if (unsupported.length > 0) {
    return { error: `不支持的 patch 字段: ${unsupported.join(', ')}`, code: 'UNSUPPORTED_FIELD' };
  }
  if (p.aid !== undefined) {
    return { error: 'aid 不可修改（AUN 身份绑定，如需换 AID 请删除后重建）', code: 'INVALID_ARGS' };
  }
  if (p.avatar !== undefined) {
    const otherKeys = Object.keys(p).filter(k => k !== 'avatar');
    if (otherKeys.length > 0) {
      return { error: 'avatar 不能与其他 patch 字段同时提交，请拆分为两次 update', code: 'INVALID_ARGS' };
    }
  }
  if (p.name !== undefined) {
    const otherKeys = Object.keys(p).filter(k => k !== 'name');
    if (otherKeys.length > 0) {
      return { error: 'name 不能与其他 patch 字段同时提交，请拆分为两次 update', code: 'INVALID_ARGS' };
    }
  }
  if (Array.isArray(p.channels) && p.channels.some((c: any) => c?.type === 'aun')) {
    return { error: 'AUN 渠道不可通过 patch 编辑（由 agent aid 隐式管理）', code: 'INVALID_ARGS' };
  }
  const config = loadAgent(a.aid);
  if (!config) return { error: `Agent "${a.aid}" not found`, code: 'NOT_FOUND' };

  if (p.avatar !== undefined) {
    const result = await uploadAvatar(a.aid, p.avatar, { aunPath: resolveRoot() });
    if (!result.ok) {
      return { error: `头像上传失败: ${result.error}`, code: result.code ?? 'UPLOAD_FAILED' };
    }
    return { data: { aid: a.aid, avatar: result.publicUrl, saved: true } };
  }

  let touched = false;
  const data: Record<string, any> = { aid: a.aid };
  const hasConfigPatch = p.baseagents !== undefined || p.projects !== undefined || p.owners !== undefined || p.chatmode !== undefined || p.channels !== undefined;
  if (p.baseagents !== undefined) { (config as any).baseagents = p.baseagents; touched = true; }
  if (p.projects !== undefined)   { (config as any).projects = p.projects; touched = true; }
  if (p.owners !== undefined)     { (config as any).owners = p.owners; touched = true; }
  if (p.chatmode !== undefined)   { (config as any).chatmode = p.chatmode; touched = true; }
  if (p.channels !== undefined)   { (config as any).channels = p.channels; touched = true; }

  if (p.name !== undefined) {
    const result = await updateAgentMdName(a.aid, p.name);
    if (!result.ok) return { error: result.error, code: result.code };
    data.name = result.name;
    touched = true;
  }

  if (!touched) return { error: 'patch 为空，无可写字段', code: 'INVALID_ARGS' };

  if (hasConfigPatch) {
    try {
      saveAgent(config);
    } catch (e: any) {
      return { error: e?.message || String(e), code: classifyError(e?.message || String(e)) };
    }
  }
  return { data: { ...data, saved: true } };
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
  const agentDir = path.join(resolvePaths().agentsDir, aid);
  const progress = readCreateStatus(agentDir);
  const res = await agentShow(aid);
  if (!('ok' in res) || res.ok !== true) {
    const code = classifyError((res as any).error);
    if (code === 'NOT_FOUND' && progress) return { data: buildCreateProgressOnlyAgent(aid, progress) };
    return { error: (res as any).error, code };
  }
  // 叠加构建进度（create 受理后、ready 前可见；ready 后文件仍在，可反映软失败 warn）
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
