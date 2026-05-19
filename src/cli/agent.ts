import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { resolvePaths } from '../paths.js';
import { loadDefaults, loadAllAgents, loadAgent, saveAgent, ensureAgentDirSkeleton } from '../config-store.js';
import { ipcQuery } from '../ipc.js';
import { CONFIG_SCHEMA_VERSION } from '../types.js';
import type { AgentConfig, ChannelInstance } from '../types.js';
import { isValidChannelName } from '../core/channel-loader.js';
import { commandExists } from '../utils/cross-platform.js';

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

const BASEAGENT_ENV_KEY: Record<Baseagent, string | undefined> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

function detectAvailableBaseagents(): Baseagent[] {
  return BASEAGENT_CANDIDATES.filter(b => commandExists(b));
}

function pickDefaultBaseagent(available: Baseagent[]): Baseagent | null {
  if (available.length === 0) return null;
  return available.includes('claude') ? 'claude' : available[0];
}

function buildBaseagentsBlock(chosen: Baseagent): Record<string, any> {
  const env = BASEAGENT_ENV_KEY[chosen];
  return { [chosen]: env ? { apiKey: `$ENV:${env}` } : {} };
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
  const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
  const agentMdPath = path.join(aunPath, 'AIDs', aid, 'agent.md');
  try {
    if (!fs.existsSync(agentMdPath)) return { name: null, description: null };
    const content = fs.readFileSync(agentMdPath, 'utf-8');
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
  const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
  return path.join(aunPath, 'AIDs', aid, 'agent.md');
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
}

export async function agentCreateInteractive(opts: AgentCreateInteractiveOpts = {}): Promise<AgentResult<AgentCreateResult>> {
  const p = resolvePaths();
  const rl = readline.createInterface({
    input: opts.stdin || process.stdin,
    output: opts.stdout || process.stdout,
  });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  try {
    const aidPrompt = opts.suggestedName
      ? `AID [${opts.suggestedName}]: `
      : 'AID (e.g. mybot.agentid.pub): ';
    const aidInput = (await ask(aidPrompt)).trim();
    const aid = aidInput || opts.suggestedName;
    if (!aid) return { ok: false, error: 'AID is required.' };

    const { isValidAid, aidCreate } = await import('../aun/aid/index.js');
    if (!isValidAid(aid)) {
      return { ok: false, error: `Invalid AID "${aid}": must be a valid multi-level domain (e.g. mybot.agentid.pub)` };
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
        || path.join(os.homedir(), 'evolclaw-projects');
      suggestedProjectPath = deriveAgentProjectPath(rootPath, aid);
    } catch {
      suggestedProjectPath = deriveAgentProjectPath(path.join(os.homedir(), 'evolclaw-projects'), aid);
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
      return { ok: false, error: `No baseagent CLI detected on PATH. Install one of: ${BASEAGENT_CANDIDATES.join('/')}` };
    }
    const defaultBa = pickDefaultBaseagent(available)!;
    let baseagent: Baseagent | null = null;
    while (baseagent === null) {
      const input = (await ask(`Baseagent (${available.join('/')}) [${defaultBa}]: `)).trim() || defaultBa;
      if (!BASEAGENT_CANDIDATES.includes(input as Baseagent)) {
        console.log(`  Invalid choice. Options: ${BASEAGENT_CANDIDATES.join('/')}`);
        continue;
      }
      if (!available.includes(input as Baseagent)) {
        console.log(`  ${input} not detected on PATH. Available: ${available.join('/')}`);
        continue;
      }
      baseagent = input as Baseagent;
    }

    // Owner
    const owner = (await ask('Owner AID (leave empty for auto-bind on first message): ')).trim() || undefined;

    // Name + description for agent.md
    const defaultName = aid.split('.')[0];
    const agentName = (await ask(`Display name [${defaultName}]: `)).trim() || defaultName;
    const agentDescription = (await ask('Description (optional): ')).trim() || '';

    rl.close();

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
      const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
      const agentMdPath = path.join(aunPath, 'AIDs', aid, 'agent.md');
      fs.mkdirSync(path.dirname(agentMdPath), { recursive: true });
      fs.writeFileSync(agentMdPath, content, 'utf-8');
      try {
        await agentmdPut(content, { aid, aunPath });
        agentmdUploaded = true;
      } catch (e: any) {
        console.warn(`  ⚠ agent.md upload failed: ${e?.message || e}`);
        console.warn(`  → Retry later with: evolclaw aid agentmd put ${aid}`);
      }
    } catch (e: any) {
      console.warn(`  ⚠ agent.md generation failed: ${e?.message || e}`);
    }

    return {
      ok: true,
      aid,
      configPath: toPosix(path.join(agentDirPath, 'config.json'))!,
      aidCreated,
      agentmdUploaded,
    };
  } finally {
    try { rl.close(); } catch { /* ignore */ }
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
}

export async function agentCreateNonInteractive(opts: AgentCreateNonInteractiveOpts): Promise<AgentResult<AgentCreateResult>> {
  const p = resolvePaths();
  const { isValidAid, aidCreate } = await import('../aun/aid/index.js');

  if (!isValidAid(opts.aid)) {
    return { ok: false, error: `Invalid AID "${opts.aid}": must be a valid multi-level domain (e.g. mybot.agentid.pub)` };
  }

  const agentDirPath = path.join(p.agentsDir, opts.aid);
  const configExists = fs.existsSync(path.join(agentDirPath, 'config.json'));
  if (configExists && !opts.force) {
    return { ok: false, error: `Agent "${opts.aid}" already exists: ${agentDirPath}/config.json (use --force to overwrite)` };
  }

  // Baseagent
  const available = detectAvailableBaseagents();
  if (available.length === 0) {
    return { ok: false, error: `No baseagent CLI detected on PATH. Install one of: ${BASEAGENT_CANDIDATES.join('/')}` };
  }
  let baseagent: Baseagent;
  if (opts.baseagent) {
    if (!BASEAGENT_CANDIDATES.includes(opts.baseagent as Baseagent)) {
      return { ok: false, error: `Invalid baseagent: ${opts.baseagent} (options: ${BASEAGENT_CANDIDATES.join('/')})` };
    }
    if (!available.includes(opts.baseagent as Baseagent)) {
      return { ok: false, error: `${opts.baseagent} not detected on PATH (available: ${available.join('/')})` };
    }
    baseagent = opts.baseagent as Baseagent;
  } else {
    baseagent = pickDefaultBaseagent(available)!;
  }

  if (!path.isAbsolute(opts.project)) {
    return { ok: false, error: `--project must be absolute: ${opts.project}` };
  }
  if (!fs.existsSync(opts.project)) {
    try {
      fs.mkdirSync(opts.project, { recursive: true });
    } catch (e: any) {
      return { ok: false, error: `Failed to create ${opts.project}: ${e?.message || e}` };
    }
  }

  if (opts.owner && !isValidAid(opts.owner)) {
    return { ok: false, error: `Invalid owner: ${opts.owner}` };
  }

  // Register AID
  let aidCreated = false;
  try {
    const result = await aidCreate(opts.aid);
    try { await result.client.close(); } catch { /* ignore */ }
    aidCreated = !result.alreadyExisted;
  } catch (e: any) {
    return { ok: false, error: `AID creation failed: ${e?.message || e}` };
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

  saveAgent(agentConfig);
  ensureAgentDirSkeleton(opts.aid);

  // Generate and upload agent.md
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
    const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
    const agentMdPath = path.join(aunPath, 'AIDs', opts.aid, 'agent.md');
    fs.mkdirSync(path.dirname(agentMdPath), { recursive: true });
    fs.writeFileSync(agentMdPath, content, 'utf-8');
    try {
      await agentmdPut(content, { aid: opts.aid, aunPath });
      agentmdUploaded = true;
    } catch (e: any) {
      console.warn(`⚠ agent.md upload failed: ${e?.message || e}`);
      console.warn(`  Retry later with: evolclaw aid agentmd put ${opts.aid}`);
    }
  } catch (e: any) {
    console.warn(`⚠ agent.md generation failed: ${e?.message || e}`);
  }

  return {
    ok: true,
    aid: opts.aid,
    configPath: toPosix(path.join(agentDirPath, 'config.json'))!,
    aidCreated,
    agentmdUploaded,
  };
}

// ==================== agentSyncAids ====================

export async function agentSyncAids(): Promise<AgentResult<AgentSyncResult>> {
  const p = resolvePaths();
  const { aidList } = await import('../aun/aid/index.js');

  const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
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
    || path.join(os.homedir(), 'evolclaw-projects');

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

  config.enabled = enabled;
  saveAgent(config);

  // Try hot-reload
  let reloaded = false;
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name: aid }) as any;
    reloaded = !!result?.ok;
  } catch {}

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
  setNestedValue(config, key, value);
  saveAgent(config);

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
    channelKey: `${opts.aid}#${opts.channel.type}#${opts.channel.name}`,
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
  }

  // Trigger resync so daemon drops the agent
  try {
    await ipcQuery(p.socket, { type: 'evolagent.resync' });
  } catch {}

  return { ok: true, aid, purged: purge, stopped };
}
// ==================== agentRename ====================

export async function agentRename(aid: string, newName: string): Promise<AgentResult<AgentRenameResult>> {
  const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
  const agentMdPath = path.join(aunPath, 'AIDs', aid, 'agent.md');

  if (!fs.existsSync(agentMdPath)) {
    return { ok: false, error: `agent.md not found for ${aid}. Run: evolclaw aid agentmd put ${aid}` };
  }

  let content = fs.readFileSync(agentMdPath, 'utf-8');
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
  fs.writeFileSync(agentMdPath, content, 'utf-8');

  // Upload
  let uploaded = false;
  try {
    const { agentmdPut } = await import('../aun/aid/index.js');
    await agentmdPut(content, { aid, aunPath });
    uploaded = true;
  } catch {}

  return { ok: true, aid, name: newName, uploaded };
}
