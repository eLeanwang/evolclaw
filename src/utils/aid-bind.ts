import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getPackageRoot } from '../paths.js';
import { loadAgent, loadEvolclawConfig, saveAgent, saveEvolclawConfig } from '../config-store.js';
import { resolveEffective } from '../config/config-manager.js';
import { readEvolclawVersion } from '../index.js';
import type { BaseagentsBlock, AgentConfig, ChannelInstance } from '../types.js';
import { setPrivateRoleAssignment } from '../config/role-assignments.js';

export type BindType = 'daemon' | 'agent';
export type BindStatus = 'pending' | 'bound' | 'expired' | 'cancelled';
export type BindOwnerMode = 'append' | 'replace';

export interface BindBeginRequest {
  bindType: BindType;
  targetAid?: string;
  agentName?: string;
  ownerMode?: BindOwnerMode;
  ttlMs?: number;
}

export interface BindBeginResponse {
  ok: true;
  taskId: string;
  qrData: Record<string, unknown>;
  expiresAt: number;
}

export interface BindStatusResponse {
  ok: true;
  taskId: string;
  status: BindStatus;
  boundAid?: string;
  boundName?: string;
  error?: string;
}

export interface BindErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

export interface BindRequestPayload {
  type?: string;
  bindType?: BindType;
  token?: string;
  clientName?: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  timestamp?: number;
}

export interface BindBaseagentInfo {
  active_baseagent: string;
  model?: string;
  effort?: string;
}

export interface BindChannelInfo {
  type: string;
  name: string;
  enabled: boolean;
}

export interface BindResponsePayload {
  type: 'bind.response';
  bindType: BindType;
  success: boolean;
  error?: {
    code:
      | 'INVALID_TOKEN'
      | 'TASK_EXPIRED'
      | 'TASK_NOT_FOUND'
      | 'ALREADY_BOUND'
      | 'BIND_TYPE_MISMATCH'
      | 'TARGET_NOT_FOUND'
      | 'INTERNAL_ERROR';
    message: string;
  };
  daemonInfo?: {
    daemonAid: string;
    agentAid?: string;
    bindType: BindType;
    baseagents?: string[];
    active_baseagent?: string;
    model?: string;
    effort?: string;
    channels?: BindChannelInfo[];
    version?: string;
    platform?: 'windows' | 'macos' | 'linux';
    uptime?: number;
    agentName?: string;
  };
}

interface BindTask {
  taskId: string;
  bindType: BindType;
  receiverAid: string;
  targetAid: string;
  agentName?: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  status: BindStatus;
  boundAid?: string;
  boundName?: string;
  ownerMode: BindOwnerMode;
  finishedAt?: number;
}

export class BindService {
  private readonly tasks = new Map<string, BindTask>();
  private readonly taskIdsByTokenHash = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      receiverAid: string;
      getAvailableBaseagents: () => string[];
      getUptimeSeconds: () => number;
      onDaemonOwnersUpdated?: (owners: string[]) => void;
    }
  ) {}

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  begin(req: BindBeginRequest): BindBeginResponse | BindErrorResponse {
    if (req.bindType !== 'daemon' && req.bindType !== 'agent') {
      return { ok: false, code: 'INVALID_BIND_TYPE', error: 'invalid bindType' };
    }
    const targetAid = req.bindType === 'daemon' ? (req.targetAid ?? this.opts.receiverAid) : req.targetAid;
    if (!targetAid || typeof targetAid !== 'string') {
      return { ok: false, code: 'MISSING_TARGET', error: 'missing targetAid' };
    }
    if (req.bindType === 'daemon' && targetAid !== this.opts.receiverAid) {
      return { ok: false, code: 'TARGET_MISMATCH', error: 'daemon targetAid must equal control AID' };
    }
    if (req.bindType === 'agent' && !loadAgent(targetAid)) {
      return { ok: false, code: 'TARGET_NOT_FOUND', error: `agent not found: ${targetAid}` };
    }

    const taskId = crypto.randomUUID();
    let token = generatePublicToken();
    let tokenHash = hashToken(token);
    while (this.taskIdsByTokenHash.has(tokenHash)) {
      token = generatePublicToken();
      tokenHash = hashToken(token);
    }
    const ttlMs = clampTtl(req.ttlMs);
    const expiresAt = Date.now() + ttlMs;
    const ownerMode: BindOwnerMode = req.ownerMode === 'replace' ? 'replace' : 'append';

    const task: BindTask = {
      taskId,
      bindType: req.bindType,
      receiverAid: this.opts.receiverAid,
      targetAid,
      agentName: req.agentName,
      tokenHash,
      createdAt: Date.now(),
      expiresAt,
      status: 'pending',
      ownerMode,
    };
    this.tasks.set(taskId, task);
    this.taskIdsByTokenHash.set(tokenHash, taskId);
    this.cleanup();

    return {
      ok: true,
      taskId,
      expiresAt,
      qrData: {
        type: 'evolclaw.bind',
        version: readEvolclawVersion(),
        bindType: req.bindType,
        daemonAid: this.opts.receiverAid,
        ...(req.bindType === 'daemon' ? { platform: getPlatform() } : {}),
        ...(req.bindType === 'agent' ? { agentAid: targetAid, agentName: req.agentName ?? null } : {}),
        token,
        expiresAt,
      },
    };
  }

  status(taskId: string): BindStatusResponse | BindErrorResponse {
    if (!taskId) return { ok: false, code: 'MISSING_TASK', error: 'missing taskId' };
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: 'binding task not found' };
    if (task.status === 'pending' && Date.now() > task.expiresAt) {
      task.status = 'expired';
      task.finishedAt ??= task.expiresAt;
    }
    return {
      ok: true,
      taskId: task.taskId,
      status: task.status,
      boundAid: task.boundAid,
      boundName: task.boundName,
    };
  }

  cancel(taskId: string): BindStatusResponse | BindErrorResponse {
    if (!taskId) return { ok: false, code: 'MISSING_TASK', error: 'missing taskId' };
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: 'binding task not found' };
    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.finishedAt = Date.now();
    }
    return {
      ok: true,
      taskId: task.taskId,
      status: task.status,
      boundAid: task.boundAid,
      boundName: task.boundName,
    };
  }

  async handleRequest(payload: BindRequestPayload, fromAid: string): Promise<BindResponsePayload | null> {
    if (payload?.type !== 'bind.request') return null;
    const bindType = payload.bindType === 'agent' ? 'agent' : 'daemon';

    const fail = (code: NonNullable<BindResponsePayload['error']>['code'], message: string): BindResponsePayload => ({
      type: 'bind.response',
      bindType,
      success: false,
      error: { code, message },
    });

    if (!payload.token) return fail('INVALID_TOKEN', 'invalid token');
    const taskId = this.taskIdsByTokenHash.get(hashToken(payload.token));
    if (!taskId) return fail('TASK_NOT_FOUND', 'binding task not found');

    const task = this.tasks.get(taskId);
    if (!task) return fail('TASK_NOT_FOUND', 'binding task not found');
    if (payload.bindType !== task.bindType) return fail('BIND_TYPE_MISMATCH', 'bindType mismatch');
    if (Date.now() > task.expiresAt) {
      task.status = 'expired';
      task.finishedAt ??= task.expiresAt;
      return fail('TASK_EXPIRED', 'binding task expired');
    }
    if (task.status === 'bound') return fail('ALREADY_BOUND', 'binding task already completed');
    if (task.status !== 'pending') return fail('TASK_NOT_FOUND', 'binding task is not pending');
    if (!timingSafeTokenEqual(payload.token, task.tokenHash)) {
      return fail('INVALID_TOKEN', 'invalid token');
    }
    if (!fromAid) return fail('INTERNAL_ERROR', 'missing AUN sender');

    try {
      this.applyOwnerBinding(task, fromAid);
      task.status = 'bound';
      task.boundAid = fromAid;
      task.boundName = payload.clientName;
      task.finishedAt = Date.now();
      const details = task.bindType === 'agent' ? this.buildAgentBindDetails(task) : null;
      return {
        type: 'bind.response',
        bindType: task.bindType,
        success: true,
        daemonInfo: {
          daemonAid: task.receiverAid,
          ...(task.bindType === 'agent' ? { agentAid: task.targetAid } : {}),
          bindType: task.bindType,
          ...(task.bindType === 'daemon'
            ? {
                version: readEvolclawVersion(),
                platform: getPlatform(),
                uptime: this.opts.getUptimeSeconds(),
                baseagents: this.opts.getAvailableBaseagents(),
              }
            : {
                active_baseagent: details!.baseagent.active_baseagent,
                model: details!.baseagent.model,
                effort: details!.baseagent.effort,
                channels: details!.channels,
                agentName: task.agentName,
              }),
        },
      };
    } catch (e: any) {
      return fail('INTERNAL_ERROR', e?.message || String(e));
    }
  }

  private buildAgentBindDetails(task: BindTask): { baseagent: BindBaseagentInfo; channels: BindChannelInfo[] } {
    const agent = loadAgent(task.targetAid);
    const config = resolveEffective({ self: task.targetAid }, { expand: true });
    return {
      baseagent: resolveBaseagentInfo(config),
      channels: summarizeChannels(agent?.channels ?? []),
    };
  }

  private applyOwnerBinding(task: BindTask, ownerAid: string): void {
    if (task.bindType === 'daemon') {
      const cfg = loadEvolclawConfig();
      const current = cfg.owners ?? [];
      const owners = task.ownerMode === 'replace'
        ? [ownerAid]
        : [ownerAid, ...current.filter(o => o !== ownerAid)];
      saveEvolclawConfig({ ...cfg, $schema_version: cfg.$schema_version ?? 1, owners });
      this.opts.onDaemonOwnersUpdated?.(owners);
      return;
    }

    const agent = loadAgent(task.targetAid);
    if (!agent) throw new Error(`agent not found: ${task.targetAid}`);
    setPrivateRoleAssignment(task.targetAid, ownerAid, 'owner', { note: `bind:${task.ownerMode}` });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.status === 'pending' && now > task.expiresAt) {
        task.status = 'expired';
        task.finishedAt ??= task.expiresAt;
      }
      if (task.status === 'cancelled') {
        this.deleteTask(id);
      } else if (task.status === 'expired' && now - (task.finishedAt ?? task.expiresAt) > 10 * 60_000) {
        this.deleteTask(id);
      } else if (task.status === 'bound' && task.finishedAt && now - task.finishedAt > 10 * 60_000) {
        this.deleteTask(id);
      }
    }

    if (this.tasks.size <= 128) return;
    const sorted = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const task of sorted) {
      if (this.tasks.size <= 128) break;
      if (task.status !== 'pending') this.deleteTask(task.taskId);
    }
  }

  private deleteTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.tasks.delete(taskId);
    this.taskIdsByTokenHash.delete(task.tokenHash);
  }
}

function clampTtl(ttlMs: number | undefined): number {
  if (!ttlMs || !Number.isFinite(ttlMs)) return 10 * 60_000;
  return Math.max(60_000, Math.min(ttlMs, 10 * 60_000));
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generatePublicToken(): string {
  return crypto.randomBytes(16).toString('base64url'); // 128 bits for stronger security
}

function timingSafeTokenEqual(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function resolveBaseagentInfo(config: Pick<AgentConfig, 'active_baseagent' | 'baseagents'> | null): BindBaseagentInfo {
  const baseagents = (config?.baseagents ?? {}) as BaseagentsBlock;
  const active_baseagent = ('active_baseagent' in (config ?? {}) && typeof config?.active_baseagent === 'string')
    ? config.active_baseagent!
    : pickFirstBaseagent(baseagents);
  const block = active_baseagent ? (baseagents as any)[active_baseagent] : undefined;
  const model = typeof block?.model === 'string' ? block.model : undefined;
  const effort = typeof block?.effort === 'string'
    ? block.effort
    : (typeof block?.reasoning === 'string' ? block.reasoning : undefined);
  return { active_baseagent, model, effort };
}

function pickFirstBaseagent(baseagents: BaseagentsBlock): string {
  for (const name of ['claude', 'codex', 'gemini']) {
    if ((baseagents as any)[name] !== undefined) return name;
  }
  return 'claude';
}

function summarizeChannels(channels: ChannelInstance[]): BindChannelInfo[] {
  return channels.map(ch => ({
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled !== false,
  }));
}

function getPlatform(): 'windows' | 'macos' | 'linux' {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}
