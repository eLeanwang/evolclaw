import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { resolvePaths, agentMdPath as getAgentMdPathFromPaths, aunPath as defaultAunPath } from '../paths.js';
import { loadDefaults, loadAllAgents, loadAgent, saveAgent, ensureAgentDirSkeleton } from '../config-store.js';
import { ipcQuery } from '../ipc.js';
import { CONFIG_SCHEMA_VERSION } from '../types.js';
import type { AgentConfig, ChannelInstance } from '../types.js';
import { isValidChannelName } from '../core/channel-loader.js';
import { commandExists } from '../utils/cross-platform.js';
import { getCodexAppServerAvailability, isCodexAppServerAvailable } from '../agents/codex-runner.js';

// ==================== Types ====================

export interface AgentListItem {
  aid: string;
  name: string;
  status: string;
  channels: string[];
  projectPath: string | null;
  baseagent: string | null;
  lastActivity: number | null;
}

export interface AgentConnectionInfo {
  status: string;
  uptime_ms: number | null;
  reconnect_count: number;
  messages_received: number;
  messages_sent: number;
  bytes_received: number;
  bytes_sent: number;
  last_received_at: string | null;
  last_sent_at: string | null;
  unique_peer_count: number;
}

export interface AgentShowResult {
  ok: true;
  aid: string;
  status: string;
  identity: { name: string | null; description: string | null };
  config: {
    baseagent: string | null;
    model: string | null;
    effort: string | null;
    chatmode: { private: string; group: string } | null;
    owners: string[];
    channels: string[];
  };
  connection: AgentConnectionInfo | null;
  sessions: { active: number; last_activity: string | null };
  paths: {
    config: string;
    agent_md: string;
    project: string | null;
    data: string;
  };
}
export interface AgentListResult {
  ok: true;
  agents: AgentListItem[];
}

export interface AgentCreateResult {
  ok: true;
  aid: string;
  configPath: string;
  aidCreated: boolean;
  agentmdUploaded?: boolean;
  hotLoaded?: boolean;
  hotLoadError?: string;
}

export interface AgentSyncResult {
  ok: true;
  created: string[];
  template: string | null;
  hotReloaded: boolean;
}

export interface AgentReloadResult {
  ok: true;
  results?: string[];
}

export interface AgentEnableDisableResult {
  ok: true;
  aid: string;
  enabled: boolean;
  reloaded: boolean;
}

export interface AgentGetResult {
  ok: true;
  aid: string;
  key: string;
  value: unknown;
}

export interface AgentSetResult {
  ok: true;
  aid: string;
  key: string;
  value: unknown;
  reloaded: boolean;
}

export interface AgentDeleteResult {
  ok: true;
  aid: string;
  purged: boolean;
  stopped: boolean;
}

export interface AgentRenameResult {
  ok: true;
  aid: string;
  name: string;
  uploaded: boolean;
}

export interface AgentError {
  ok: false;
  error: string;
}

export type AgentResult<T> = T | AgentError;

// ==================== Helpers ====================

const BASEAGENT_CANDIDATES = ['claude', 'codex', 'gemini'] as const;
type Baseagent = typeof BASEAGENT_CANDIDATES[number];

function isBaseagentAvailable(baseagent: Baseagent): boolean {
  if (baseagent === 'codex') return isCodexAppServerAvailable();
  return commandExists(baseagent);
}

function detectAvailableBaseagents(): Baseagent[] {
  return BASEAGENT_CANDIDATES.filter(isBaseagentAvailable);
}

function pickDefaultBaseagent(available: Baseagent[]): Baseagent | null {
  if (available.length === 0) return null;
  return available.includes('claude') ? 'claude' : available[0];
}

function buildBaseagentsBlock(chosen: Baseagent): Record<string, any> {
  return { [chosen]: {} };
}

const DEFAULT_CHATMODE = { private: 'interactive', group: 'proactive', nothuman: 'proactive' } as const;
const DEFAULT_DISPATCH = 'mention' as const;

function deriveAgentProjectPath(rootPath: string, aid: string): string {
  const baseName = aid.split('.')[0];
  let candidate = path.join(rootPath, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  let i = 1;
  while (fs.existsSync(`${candidate}~${i}`)) i++;
  return `${candidate}~${i}`;
}

function readAgentMdIdentity(aid: string): { name: string | null; description: string | null } {
  const agentMdFilePath = getAgentMdPathFromPaths(aid);
  try {
    if (!fs.existsSync(agentMdFilePath)) return { name: null, description: null };
    const content = fs.readFileSync(agentMdFilePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { name: null, description: null };
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return {
      name: nameMatch?.[1]?.trim() || null,
      description: descMatch?.[1]?.trim() || null,
    };
  } catch { return { name: null, description: null }; }
}

function getAgentMdPath(aid: string): string {
  return getAgentMdPathFromPaths(aid);
}

function getNestedValue(obj: any, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setNestedValue(obj: any, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
function parseJsonValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  try { return JSON.parse(raw); } catch {}
  return raw;
}

/** Normalize path separators to forward slashes for cross-platform consistent display. */
function toPosix(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.replace(/\\/g, '/');
}

// ==================== agentList ====================

export async function agentList(): Promise<AgentResult<AgentListResult>> {
  const p = resolvePaths();

  // Try IPC first (running process has real status)
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.list' }) as any;
    if (result && result.ok && result.agents) {
      const agents: AgentListItem[] = result.agents.map((info: any) => ({
        aid: info.aid || info.name,
        name: info.name,
        status: info.status || 'stopped',
        channels: info.channels || [],
        projectPath: toPosix(info.projectPath || null),
        baseagent: info.baseagent || null,
        lastActivity: info.lastActivity || null,
      }));
      return { ok: true, agents };
    }
  } catch {}

  // Cold mode: read from disk
  const { EvolAgentRegistry } = await import('../core/evolagent-registry.js');
  const registry = new EvolAgentRegistry(p.agentsDir);
  registry.loadAll();
  const agents: AgentListItem[] = registry.list().map((info: any) => ({
    aid: info.aid || info.name,
    name: info.name,
    status: info.status || 'stopped',
    channels: info.channels || [],
    projectPath: toPosix(info.projectPath || null),
    baseagent: info.baseagent || null,
    lastActivity: info.lastActivity || null,
  }));
  return { ok: true, agents };
}

// ==================== agentShow ====================

export async function agentShow(aid: string): Promise<AgentResult<AgentShowResult>> {
  const p = resolvePaths();

  let agentInfo: any = null;
  let connectionInfo: AgentConnectionInfo | null = null;

  // Try IPC for live data
  try {
    const [showResp, aidsResp, statsResp] = await Promise.all([
      ipcQuery<any>(p.socket, { type: 'evolagent.show', name: aid }),
      ipcQuery<any>(p.socket, { type: 'aun-aids' }),
      ipcQuery<any>(p.socket, { type: 'aun-aid-stats' }),
    ]);

    if (showResp?.ok && showResp.agent) {
      agentInfo = showResp.agent;
    }

    // Build connection info from aun-aids + aun-aid-stats (same source as watch aid)
    if (aidsResp?.ok && aidsResp.aids) {
      const aidEntry = aidsResp.aids.find((a: any) => a.aid === aid);
      if (aidEntry) {
        const stats = statsResp?.ok && statsResp.stats
          ? statsResp.stats.find((s: any) => s.aid === aid)
          : null;
        const now = Date.now();
        connectionInfo = {
          status: aidEntry.status || 'unknown',
          uptime_ms: (aidEntry.status === 'connected' && aidEntry.lastConnectedAt)
            ? now - aidEntry.lastConnectedAt : null,
          reconnect_count: aidEntry.reconnectCount ?? 0,
          messages_received: stats?.messagesReceived ?? 0,
          messages_sent: stats?.messagesSent ?? 0,
          bytes_received: stats?.bytesReceived ?? 0,
          bytes_sent: stats?.bytesSent ?? 0,
          last_received_at: stats?.lastReceivedAt ? new Date(stats.lastReceivedAt).toISOString() : null,
          last_sent_at: stats?.lastSentAt ? new Date(stats.lastSentAt).toISOString() : null,
          unique_peer_count: stats?.uniquePeerCount ?? 0,
        };
      }
    }
  } catch {}

  // Cold mode fallback for agent info
  if (!agentInfo) {
    const { EvolAgentRegistry } = await import('../core/evolagent-registry.js');
    const registry = new EvolAgentRegistry(p.agentsDir);
    registry.loadAll();
    const agent = registry.get(aid);
    if (!agent) {
      const allList = registry.list();
      const available = allList.map((i: any) => i.name).join(', ');
      return { ok: false, error: `Agent "${aid}" not found.${available ? ` Available: ${available}` : ''}` };
    }
    agentInfo = {
      name: agent.name,
      aid: agent.aid || agent.name,
      status: agent.status,
      baseagent: agent.baseagent,
      model: agent.model,
      effort: agent.effort,
      projectPath: agent.projectPath,
      channels: agent.channelInstanceNames?.() || [],
      activeSessions: agent.activeSessions || 0,
      lastActivity: agent.lastActivity || null,
      error: agent.error,
      chatmode: agent.config?.chatmode || null,
      owners: agent.config?.owners || [],
    };
  }
  const identity = readAgentMdIdentity(aid);
  const agentMdPath = getAgentMdPath(aid);

  return {
    ok: true,
    aid,
    status: agentInfo.status || 'stopped',
    identity,
    config: {
      baseagent: agentInfo.baseagent || null,
      model: agentInfo.model || null,
      effort: agentInfo.effort || null,
      chatmode: agentInfo.chatmode || null,
      owners: agentInfo.owners || [],
      channels: agentInfo.channels || [],
    },
    connection: connectionInfo,
    sessions: {
      active: agentInfo.activeSessions || 0,
      last_activity: agentInfo.lastActivity ? new Date(agentInfo.lastActivity).toISOString() : null,
    },
    paths: {
      config: toPosix(path.join(p.agentsDir, aid, 'config.json'))!,
      agent_md: toPosix(agentMdPath)!,
      project: toPosix(agentInfo.projectPath || null),
      data: toPosix(path.join(p.agentsDir, aid, 'data'))!,
    },
  };
}

// ==================== agentCreate (interactive) ====================

export interface AgentCreateInteractiveOpts {
  suggestedName?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  rl?: readline.Interface;
}

export async function agentCreateInteractive(opts: AgentCreateInteractiveOpts = {}): Promise<AgentResult<AgentCreateResult>> {
  const p = resolvePaths();
  const ownRl = !opts.rl;
  const rl = opts.rl ?? readline.createInterface({
    input: opts.stdin || process.stdin,
    output: opts.stdout || process.stdout,
  });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  try {
    const { isValidAid, aidCreate } = await import('../aun/aid/index.js');

    const aidPrompt = opts.suggestedName
      ? `AID [${opts.suggestedName}]: `
      : 'AID (e.g. mybot.agentid.pub): ';
    let aid = '';
    while (!aid) {
      const aidInput = (await ask(aidPrompt)).trim();
      const candidate = aidInput || opts.suggestedName;
      if (!candidate) {
        console.log('  ⚠ AID is required.');
        continue;
      }
      if (!isValidAid(candidate)) {
        console.log(`  ⚠ Invalid AID "${candidate}": must be a valid multi-level domain (e.g. mybot.agentid.pub)`);
        continue;
      }
      aid = candidate;
    }

    const agentDirPath = path.join(p.agentsDir, aid);
    const configExists = fs.existsSync(path.join(agentDirPath, 'config.json'));
    if (configExists) {
      const ans = (await ask(`Agent "${aid}" already exists. Overwrite config.json? (AID 与 agent.md 保留) [y/N]: `)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        return { ok: false, error: 'Aborted.' };
      }
    }

    console.log(`\nCreating agent: ${aid}\n`);

    let aidCreated = false;
    try {
      const result = await aidCreate(aid);
      try { await result.client.close(); } catch { /* ignore */ }
      aidCreated = !result.alreadyExisted;
      console.log(`  ✓ AID ${result.alreadyExisted ? 'reused' : 'created'}: ${aid}`);
    } catch (e: any) {
      return { ok: false, error: `AID creation failed: ${e?.message || e}` };
    }

    // Project path
    let suggestedProjectPath = '';
    try {
      const defaults = loadDefaults();
      const rootPath = defaults?.projects?.rootPath
        || (defaults?.projects?.defaultPath && path.dirname(defaults.projects.defaultPath))
        || resolvePaths().root + '/projects';
      suggestedProjectPath = deriveAgentProjectPath(rootPath, aid);
    } catch {
      suggestedProjectPath = deriveAgentProjectPath(resolvePaths().root + '/projects', aid);
    }
    const projectInput = (await ask(`Project path [${suggestedProjectPath}]: `)).trim();
    const projectPath = projectInput || suggestedProjectPath;
    if (!path.isAbsolute(projectPath)) {
      return { ok: false, error: 'Project path must be an absolute path.' };
    }
    if (!fs.existsSync(projectPath)) {
      const create = (await ask(`Project path does not exist. Create? [Y/n]: `)).trim().toLowerCase();
      if (create === '' || create === 'y' || create === 'yes') {
        fs.mkdirSync(projectPath, { recursive: true });
        console.log(`  ✓ Created ${projectPath}`);
      } else {
        return { ok: false, error: 'Aborted.' };
      }
    }

    // Baseagent
    const available = detectAvailableBaseagents();
    if (available.length === 0) {
      return { ok: false, error: `No usable baseagent detected. Install claude/gemini CLI or codex CLI with app-server.` };
    }
    const defaultBa = pickDefaultBaseagent(available)!;
    let baseagent: Baseagent;
    if (available.length === 1) {
      console.log(`  Baseagent: ${defaultBa}`);
      baseagent = defaultBa;
    } else {
      let chosen: Baseagent | null = null;
      while (chosen === null) {
        const input = (await ask(`Baseagent (${available.join('/')}) [${defaultBa}]: `)).trim() || defaultBa;
        if (!BASEAGENT_CANDIDATES.includes(input as Baseagent)) {
          console.log(`  Invalid choice. Options: ${BASEAGENT_CANDIDATES.join('/')}`);
          continue;
        }
        if (!available.includes(input as Baseagent)) {
          console.log(`  ${input} is not available in the current environment. Available: ${available.join('/')}`);
          continue;
        }
        chosen = input as Baseagent;
      }
      baseagent = chosen;
    }

    // Owner
    let owner: string | undefined;
    while (true) {
      const ownerInput = (await ask('Owner AID (leave empty for auto-bind on first message): ')).trim();
      if (!ownerInput) { owner = undefined; break; }
      if (!isValidAid(ownerInput)) {
        console.log(`  ⚠ Invalid Owner AID "${ownerInput}": must be a valid multi-level domain (e.g. alice.agentid.pub)`);
        continue;
      }
      owner = ownerInput;
      break;
    }

    // Name + description for agent.md
    const defaultName = aid.split('.')[0];
    const agentName = (await ask(`Display name [${defaultName}]: `)).trim() || defaultName;
    const agentDescription = (await ask('Description (optional): ')).trim() || '';

    if (ownRl) rl.close();

    const agentConfig: AgentConfig = {
      $schema_version: CONFIG_SCHEMA_VERSION,
      aid,
      enabled: true,
      initialized: false,
      owners: owner ? [owner] : [],
      channels: [],
      active_baseagent: baseagent,
      baseagents: buildBaseagentsBlock(baseagent),
      projects: { defaultPath: projectPath },
      chatmode: { ...DEFAULT_CHATMODE },
      dispatch: DEFAULT_DISPATCH,
    };

    saveAgent(agentConfig);
    ensureAgentDirSkeleton(aid);

    // Generate and upload agent.md
    let agentmdUploaded = false;
    try {
      const { buildInitialAgentMd, agentmdPut } = await import('../aun/aid/index.js');
      let content = buildInitialAgentMd({ aid });
      content = content.replace(/^name:\s*".*?"$/m, `name: "${agentName}"`);
      if (agentDescription) {
        content = content.replace(/^description:\s*".*?"$/m, `description: "${agentDescription}"`);
      }
      const aunPath = process.env.AUN_HOME || defaultAunPath();
      // agentmdPut 会写本地文件到 agentMdPath(aid) 并调用 publishAgentMd
      // Upload with retry (3 attempts, 2s delay between retries)
      const MAX_ATTEMPTS = 3;
      const RETRY_DELAY_MS = 2000;
      let lastError: any;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt > 1) {
            process.stdout.write(`  ↻ agent.md 上传重试 (${attempt}/${MAX_ATTEMPTS})...\n`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          }
          await agentmdPut(content, { aid, aunPath });
          agentmdUploaded = true;
          break;
        } catch (e: any) {
          lastError = e;
        }
      }
      if (!agentmdUploaded) {
        console.warn(`  ⚠ agent.md upload failed: ${lastError?.message || lastError}`);
        console.warn(`  → Retry later with: evolclaw aid agentmd put ${aid}`);
      }
      // Yield to allow the SDK WebSocket to fully close before IPC
      await new Promise(r => setTimeout(r, 0));
    } catch (e: any) {
      console.warn(`  ⚠ agent.md generation failed: ${e?.message || e}`);
    }

    // Attempt hot-load via IPC (if daemon is running).
    // Cold-starting a new agent (connecting AUN WebSocket) routinely takes
    // >3s, so use a generous timeout to avoid a false "service not running"
    // report while the daemon actually finishes bringing the agent online.
    let hotLoaded = false;
    let hotLoadError: string | undefined;
    try {
      const ipcResult = await ipcQuery(p.socket, { type: 'evolagent.load', aid }, 30_000) as any;
      if (ipcResult?.ok) {
        hotLoaded = true;
      } else if (ipcResult) {
        hotLoadError = ipcResult.error;
      }
    } catch { /* daemon not running */ }

    return {
      ok: true,
      aid,
      configPath: toPosix(path.join(agentDirPath, 'config.json'))!,
      aidCreated,
      agentmdUploaded,
      hotLoaded,
      hotLoadError,
    };
  } finally {
    if (ownRl) { try { rl.close(); } catch { /* ignore */ } }
  }
}

// ==================== agentCreate (non-interactive) ====================

export interface AgentCreateNonInteractiveOpts {
  aid: string;
  baseagent?: string;
  project: string;
  owner?: string;
  name?: string;
  description?: string;
  force?: boolean;
  /** 环节进度回调（可选）。CLI 不传 → 零行为变化；后台 runner 传入以驱动 create-status。
   *  state='begin' 进入环节，'done'/'warn' 结束环节，'failed' 硬失败。 */
  onPhase?: (phase: string, state: 'begin' | 'done' | 'warn' | 'failed', detail?: string) => void;
}

export async function agentCreateNonInteractive(opts: AgentCreateNonInteractiveOpts): Promise<AgentResult<AgentCreateResult>> {
  const p = resolvePaths();
  const { isValidAid, aidCreate } = await import('../aun/aid/index.js');

  opts.onPhase?.('validating', 'begin');
  /** 校验失败：透出 failed 进度并返回原结构（控制流不变）。 */
  const failValidating = (error: string): AgentResult<AgentCreateResult> => {
    opts.onPhase?.('validating', 'failed', error);
    return { ok: false, error };
  };

  if (!isValidAid(opts.aid)) {
    return failValidating(`Invalid AID "${opts.aid}": must be a valid multi-level domain (e.g. mybot.agentid.pub)`);
  }

  const agentDirPath = path.join(p.agentsDir, opts.aid);
  const configExists = fs.existsSync(path.join(agentDirPath, 'config.json'));
  if (configExists && !opts.force) {
    return failValidating(`Agent "${opts.aid}" already exists: ${agentDirPath}/config.json (use --force to overwrite)`);
  }

  // Baseagent
  const available = detectAvailableBaseagents();
  if (available.length === 0) {
    return failValidating(`No usable baseagent detected. Install claude/gemini CLI or codex CLI with app-server.`);
  }
  let baseagent: Baseagent;
  if (opts.baseagent) {
    if (!BASEAGENT_CANDIDATES.includes(opts.baseagent as Baseagent)) {
      return failValidating(`Invalid baseagent: ${opts.baseagent} (options: ${BASEAGENT_CANDIDATES.join('/')})`);
    }
    if (!available.includes(opts.baseagent as Baseagent)) {
      const reason = opts.baseagent === 'codex'
        ? getCodexAppServerAvailability().reason
        : undefined;
      return failValidating(reason || `${opts.baseagent} is not available in the current environment (available: ${available.join('/')})`);
    }
    baseagent = opts.baseagent as Baseagent;
  } else {
    baseagent = pickDefaultBaseagent(available)!;
  }

  if (!path.isAbsolute(opts.project)) {
    return failValidating(`--project must be absolute: ${opts.project}`);
  }
  if (!fs.existsSync(opts.project)) {
    try {
      fs.mkdirSync(opts.project, { recursive: true });
    } catch (e: any) {
      return failValidating(`Failed to create ${opts.project}: ${e?.message || e}`);
    }
  }

  if (opts.owner && !isValidAid(opts.owner)) {
    return failValidating(`Invalid owner: ${opts.owner}`);
  }
  opts.onPhase?.('validating', 'done');

  // Register AID
  opts.onPhase?.('registering_aid', 'begin');
  let aidCreated = false;
  try {
    const result = await aidCreate(opts.aid);
    try { await result.client.close(); } catch { /* ignore */ }
    aidCreated = !result.alreadyExisted;
    opts.onPhase?.('registering_aid', 'done', aidCreated ? 'created' : 'existed');
  } catch (e: any) {
    const error = `AID creation failed: ${e?.message || e}`;
    opts.onPhase?.('registering_aid', 'failed', error);
    return { ok: false, error };
  }

  // Force 模式下若 agent 已存在且已 initialized，保留该状态（避免重复发欢迎）
  let preservedInitialized = false;
  if (configExists) {
    try {
      const existing = loadAgent(opts.aid);
      if (existing?.initialized === true) preservedInitialized = true;
    } catch { /* ignore */ }
  }

  const agentConfig: AgentConfig = {
    $schema_version: CONFIG_SCHEMA_VERSION,
    aid: opts.aid,
    enabled: true,
    initialized: preservedInitialized,
    owners: opts.owner ? [opts.owner] : [],
    channels: [],
    active_baseagent: baseagent,
    baseagents: buildBaseagentsBlock(baseagent),
    projects: { defaultPath: opts.project },
    chatmode: { ...DEFAULT_CHATMODE },
    dispatch: DEFAULT_DISPATCH,
  };

  opts.onPhase?.('config_saved', 'begin');
  saveAgent(agentConfig);
  ensureAgentDirSkeleton(opts.aid);
  opts.onPhase?.('config_saved', 'done');

  // Generate and upload agent.md
  opts.onPhase?.('uploading_agentmd', 'begin');
  let agentmdUploaded = false;
  try {
    const { buildInitialAgentMd, agentmdPut } = await import('../aun/aid/index.js');
    const agentName = opts.name || opts.aid.split('.')[0];
    const agentDescription = opts.description || '';
    let content = buildInitialAgentMd({ aid: opts.aid });
    content = content.replace(/^name:\s*".*?"$/m, `name: "${agentName}"`);
    if (agentDescription) {
      content = content.replace(/^description:\s*".*?"$/m, `description: "${agentDescription}"`);
    }
    const aunPath = process.env.AUN_HOME || defaultAunPath();
    // agentmdPut 会写本地文件到 agentMdPath(aid) 并调用 publishAgentMd
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 2000;
    let lastError: any;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        await agentmdPut(content, { aid: opts.aid, aunPath });
        agentmdUploaded = true;
        opts.onPhase?.('uploading_agentmd', 'done');
        break;
      } catch (e: any) {
        lastError = e;
      }
    }
    if (!agentmdUploaded) {
      console.warn(`⚠ agent.md upload failed: ${lastError?.message || lastError}`);
      console.warn(`  Retry later with: evolclaw aid agentmd put ${opts.aid}`);
      opts.onPhase?.('uploading_agentmd', 'warn', `upload failed: ${lastError?.message || lastError}`);
    }
    await new Promise(r => setTimeout(r, 0));
  } catch (e: any) {
    console.warn(`⚠ agent.md generation failed: ${e?.message || e}`);
    opts.onPhase?.('uploading_agentmd', 'warn', `generation failed: ${e?.message || e}`);
  }

  // Attempt hot-load via IPC (if daemon is running).
  // Cold-starting a new agent (connecting AUN WebSocket) routinely takes
  // >3s, so use a generous timeout to avoid a false "service not running"
  // report while the daemon actually finishes bringing the agent online.
  let hotLoaded = false;
  let hotLoadError: string | undefined;
  opts.onPhase?.('hot_loading', 'begin');
  try {
    const ipcResult = await ipcQuery(p.socket, { type: 'evolagent.load', aid: opts.aid }, 30_000) as any;
    if (ipcResult?.ok) {
      hotLoaded = true;
      opts.onPhase?.('hot_loading', 'done');
    } else if (ipcResult) {
      hotLoadError = ipcResult.error;
      opts.onPhase?.('hot_loading', 'warn', hotLoadError);
    } else {
      opts.onPhase?.('hot_loading', 'warn', 'daemon not running');
    }
  } catch { opts.onPhase?.('hot_loading', 'warn', 'daemon not running'); /* daemon not running */ }

  return {
    ok: true,
    aid: opts.aid,
    configPath: toPosix(path.join(agentDirPath, 'config.json'))!,
    aidCreated,
    agentmdUploaded,
    hotLoaded,
    hotLoadError,
  };
}

// ==================== agentSyncAids (deprecated) ====================

/** @deprecated sync-aids 已废弃，不再从 CLI 调用 */
export async function agentSyncAids(): Promise<AgentResult<AgentSyncResult>> {
  const p = resolvePaths();
  const { aidList } = await import('../aun/aid/index.js');

  const aunPath = process.env.AUN_HOME || defaultAunPath();
  const allAids = aidList(aunPath);
  const localAids = allAids.filter(a => a.hasPrivateKey).map(a => a.aid);

  if (localAids.length === 0) {
    return { ok: true, created: [], template: null, hotReloaded: false };
  }

  const { agents } = loadAllAgents();
  const existingAids = new Set(agents.map(a => a.aid));

  // Find template (earliest mtime)
  let templateAgent = agents[0] || null;
  if (agents.length > 1) {
    let earliestMtime = Infinity;
    for (const a of agents) {
      const configPath = path.join(p.agentsDir, a.aid, 'config.json');
      try {
        const stat = fs.statSync(configPath);
        if (stat.mtimeMs < earliestMtime) {
          earliestMtime = stat.mtimeMs;
          templateAgent = a;
        }
      } catch {}
    }
  }

  if (!templateAgent) {
    return { ok: false, error: '没有可用的模板 agent。请先创建第一个 agent：evolclaw agent new <aid>' };
  }

  const defaults = loadDefaults();
  const rootPath = defaults?.projects?.rootPath
    || (defaults?.projects?.defaultPath && path.dirname(defaults.projects.defaultPath))
    || resolvePaths().root + '/projects';

  const created: string[] = [];
  for (const aid of localAids) {
    if (existingAids.has(aid)) continue;
    const projectPath = deriveAgentProjectPath(rootPath, aid);
    const newConfig = {
      ...JSON.parse(JSON.stringify(templateAgent)),
      aid,
      channels: [],
      projects: { defaultPath: projectPath },
      $schema_version: CONFIG_SCHEMA_VERSION,
    };
    try {
      saveAgent(newConfig);
      ensureAgentDirSkeleton(aid);
      created.push(aid);
    } catch {}
  }

  // Hot-reload if running
  let hotReloaded = false;
  if (created.length > 0) {
    try {
      const result = await ipcQuery(p.socket, { type: 'evolagent.resync' }) as any;
      hotReloaded = !!result?.ok;
    } catch {}
  }

  return { ok: true, created, template: templateAgent.aid, hotReloaded };
}
// ==================== agentReload ====================

export async function agentReload(aid?: string): Promise<AgentResult<AgentReloadResult>> {
  const p = resolvePaths();

  if (!aid) {
    // Full resync
    try {
      const result = await ipcQuery(p.socket, { type: 'evolagent.resync' }) as any;
      if (result === null) {
        return { ok: false, error: 'evolclaw 未运行，请先 evolclaw start' };
      }
      if (result?.ok) {
        return { ok: true, results: result.results || [] };
      }
      return { ok: false, error: result?.error || 'unknown error' };
    } catch {
      return { ok: false, error: 'evolclaw 未运行，请先 evolclaw start' };
    }
  }

  // Single agent reload
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name: aid }) as any;
    if (result === null) {
      return { ok: false, error: 'evolclaw 未运行，请先 evolclaw start 后再 reload' };
    }
    if (result?.ok) {
      return { ok: true };
    }
    return { ok: false, error: result?.error || 'unknown error' };
  } catch {
    return { ok: false, error: 'evolclaw 未运行，请先 evolclaw start 后再 reload' };
  }
}

// ==================== agentEnable / agentDisable ====================

export async function agentEnable(aid: string): Promise<AgentResult<AgentEnableDisableResult>> {
  return agentSetEnabled(aid, true);
}

export async function agentDisable(aid: string): Promise<AgentResult<AgentEnableDisableResult>> {
  return agentSetEnabled(aid, false);
}

async function agentSetEnabled(aid: string, enabled: boolean): Promise<AgentResult<AgentEnableDisableResult>> {
  const p = resolvePaths();
  const configPath = path.join(p.agentsDir, aid, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ok: false, error: `Agent "${aid}" not found` };
  }

  let config: AgentConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e: any) {
    return { ok: false, error: `Failed to read config: ${e?.message || e}` };
  }

  const prevEnabled = config.enabled;
  config.enabled = enabled;
  saveAgent(config);

  // Sync in-memory registry; roll back disk on failure to keep disk/memory consistent
  let reloaded = false;
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name: aid }) as any;
    if (!result?.ok) {
      // Reload rejected by daemon — roll back disk
      config.enabled = prevEnabled;
      saveAgent(config);
      return { ok: false, error: result?.error || 'reload failed' };
    }
    reloaded = true;
  } catch (e: any) {
    // IPC unreachable (daemon not running) — roll back disk
    config.enabled = prevEnabled;
    saveAgent(config);
    return { ok: false, error: `IPC error: ${e?.message || e}` };
  }

  return { ok: true, aid, enabled, reloaded };
}

// ==================== agentGet ====================

export async function agentGet(aid: string, key: string): Promise<AgentResult<AgentGetResult>> {
  const p = resolvePaths();
  const configPath = path.join(p.agentsDir, aid, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ok: false, error: `Agent "${aid}" not found` };
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e: any) {
    return { ok: false, error: `Failed to read config: ${e?.message || e}` };
  }

  const value = getNestedValue(config, key);
  return { ok: true, aid, key, value };
}

// ==================== agentSet ====================

export async function agentSet(aid: string, key: string, rawValue: string): Promise<AgentResult<AgentSetResult>> {
  const p = resolvePaths();
  const configPath = path.join(p.agentsDir, aid, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ok: false, error: `Agent "${aid}" not found` };
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e: any) {
    return { ok: false, error: `Failed to read config: ${e?.message || e}` };
  }

  const value = parseJsonValue(rawValue);

  // active_baseagent 白名单校验：只允许已知 baseagent，挡住把模型名（如 deepseek）误设为后端
  if (key === 'active_baseagent') {
    if (typeof value !== 'string' || !(BASEAGENT_CANDIDATES as readonly string[]).includes(value)) {
      return { ok: false, error: `无效 active_baseagent: ${JSON.stringify(value)}（可选: ${BASEAGENT_CANDIDATES.join(' / ')}）` };
    }
  }

  setNestedValue(config, key, value);
  try {
    saveAgent(config);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }

  // Try hot-reload
  let reloaded = false;
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name: aid }) as any;
    reloaded = !!result?.ok;
  } catch {}

  return { ok: true, aid, key, value, reloaded };
}

// ==================== agentChannelUpsert ====================

export interface AgentChannelUpsertResult {
  ok: true;
  aid: string;
  channelKey: string;
  reloaded: boolean;
}

/**
 * Add or overwrite a channel instance on a per-agent config.
 *
 * - AUN type is rejected: AUN is implicit (managed by agent.aid + channel-loader),
 *   writing to channels[] has no effect.
 * - mode='add' + existing (type, name) → error
 * - mode='overwrite' + missing (type, name) → error
 *
 * Saves config atomically and triggers a hot-reload IPC. If the daemon is not
 * running or reload fails, returns reloaded:false (no error).
 */
export async function agentChannelUpsert(opts: {
  aid: string;
  channel: ChannelInstance;
  mode: 'add' | 'overwrite';
}): Promise<AgentResult<AgentChannelUpsertResult>> {
  const p = resolvePaths();

  const SUPPORTED_TYPES = new Set(['feishu', 'wechat', 'dingtalk', 'qqbot', 'wecom']);
  if (opts.channel.type === 'aun') {
    return { ok: false, error: 'AUN channel cannot be configured via channels[] (managed implicitly by agent.aid)' };
  }
  if (!SUPPORTED_TYPES.has(opts.channel.type)) {
    return { ok: false, error: `Unsupported channel type: ${opts.channel.type} (allowed: ${[...SUPPORTED_TYPES].join('/')})` };
  }
  if (!isValidChannelName(opts.channel.name)) {
    return { ok: false, error: `Invalid channel name: ${JSON.stringify(opts.channel.name)} (empty or contains '#')` };
  }

  let config: AgentConfig | null;
  try {
    config = loadAgent(opts.aid);
  } catch (e: any) {
    return { ok: false, error: `Failed to load agent config: ${e?.message || e}` };
  }
  if (!config) {
    return { ok: false, error: `Agent "${opts.aid}" not found` };
  }

  const channels = config.channels || [];
  const matchIdx = channels.findIndex(c => c.type === opts.channel.type && c.name === opts.channel.name);

  if (opts.mode === 'add') {
    if (matchIdx >= 0) {
      return { ok: false, error: `Channel (${opts.channel.type}, ${opts.channel.name}) already exists; pick a different name or use overwrite` };
    }
    channels.push(opts.channel);
  } else {
    if (matchIdx < 0) {
      return { ok: false, error: `Channel (${opts.channel.type}, ${opts.channel.name}) not found` };
    }
    channels[matchIdx] = opts.channel;
  }

  config.channels = channels;
  saveAgent(config);

  let reloaded = false;
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name: opts.aid }) as any;
    reloaded = !!result?.ok;
  } catch { /* daemon not running or reload failed */ }

  return {
    ok: true,
    aid: opts.aid,
    channelKey: `${opts.channel.type}#${opts.aid}#${opts.channel.name}`,
    reloaded,
  };
}

// ==================== agentDelete ====================

export async function agentDelete(aid: string, purge: boolean = false): Promise<AgentResult<AgentDeleteResult>> {
  const p = resolvePaths();
  const agentDir = path.join(p.agentsDir, aid);
  const configPath = path.join(agentDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ok: false, error: `Agent "${aid}" not found` };
  }

  // Try to stop via IPC first
  let stopped = false;
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name: aid }) as any;
    stopped = !!result?.ok;
  } catch {}

  if (purge) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  } else {
    fs.unlinkSync(configPath);
    // 清理构建进度文件（非 purge 删除只移除 config.json，需显式清理 create-status.json）
    const { removeCreateStatus } = await import('../core/message/create-status.js');
    removeCreateStatus(agentDir);
  }

  // Trigger resync so daemon drops the agent
  try {
    await ipcQuery(p.socket, { type: 'evolagent.resync' });
  } catch {}

  return { ok: true, aid, purged: purge, stopped };
}
// ==================== agentRename ====================

export async function agentRename(aid: string, newName: string): Promise<AgentResult<AgentRenameResult>> {
  const aunPath = process.env.AUN_HOME || defaultAunPath();
  const agentMdFilePath = getAgentMdPathFromPaths(aid);

  if (!fs.existsSync(agentMdFilePath)) {
    return { ok: false, error: `agent.md not found for ${aid}. Run: evolclaw aid agentmd put ${aid}` };
  }

  let content = fs.readFileSync(agentMdFilePath, 'utf-8');
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    return { ok: false, error: `agent.md has no valid frontmatter for ${aid}` };
  }

  const fm = fmMatch[2];
  const nameRegex = /^name:\s*["']?.*?["']?\s*$/m;
  let newFm: string;
  if (nameRegex.test(fm)) {
    newFm = fm.replace(nameRegex, `name: "${newName}"`);
  } else {
    newFm = `name: "${newName}"\n${fm}`;
  }

  content = fmMatch[1] + newFm + fmMatch[3] + content.slice(fmMatch[0].length);
  // agentmdPut 会写本地文件并 publishAgentMd
  let uploaded = false;
  try {
    const { agentmdPut } = await import('../aun/aid/index.js');
    await agentmdPut(content, { aid, aunPath });
    uploaded = true;
  } catch {}

  return { ok: true, aid, name: newName, uploaded };
}
