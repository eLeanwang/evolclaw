/**
 * ConfigStore —— 新结构（evolclaw-home-directory.md）的配置加载/合并/写入。
 *
 *   agents/defaults.json                   ← DefaultsConfig
 *   agents/<aid>/config.json               ← AgentConfig（per-agent）
 *
 * 合并规则（mergeForAgent）：
 *   - 深合并：models / chatmode / aun / baseagents / projects 子字段
 *   - 标量覆盖：active_baseagent / show_activities / flush_delay / debounce
 *   - per-agent only：aid / enabled / owners / admins / channels（不进 defaults）
 *
 * 写入：通过 atomic-write 双 rename，避免崩溃损坏。
 *
 * 旧 data/evolclaw.json / agents/<name>.json 不识别、不兼容——视若不存在。
 */

import fs from 'fs';
import path from 'path';
import {
  resolvePaths,
  agentConfig as agentConfigPath,
  agentDir,
} from './paths.js';
import { atomicReadJson, atomicWriteJson } from './utils/atomic-write.js';
import { checkAgentDir, isValidAid } from './aun/aid/validation.js';
import { isValidChannelName } from './core/channel-loader.js';
import type {
  DefaultsConfig,
  AgentConfig,
  MergedAgentConfig,
  ChannelInstance,
  AunRuntimeBlock,
  BaseagentsBlock,
  ModelsBlock,
  ProjectsBlock,
  ChatmodeBlock,
} from './types.js';
import { CONFIG_SCHEMA_VERSION } from './types.js';
import { logger } from './utils/logger.js';

const SUPPORTED_CHANNEL_TYPES = new Set([
  'aun', 'feishu', 'wechat', 'dingtalk', 'qqbot', 'wecom',
]);

const ENV_PREFIX = '$ENV:';

// ── env 展开 ────────────────────────────────────────────────────────────

/**
 * 递归展开对象中形如 "$ENV:NAME" 的字符串。
 *   - 命中环境变量 → 替换为变量值
 *   - 未设置环境变量 → 字段视为空字符串，并 warning 提示一次（同一变量名只警告一次）
 *
 * 真正"漏配是否致命"由调用方在 use 时报错。
 */
const warnedEnvKeys = new Set<string>();

export function expandEnvRefs<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: any): any {
  if (typeof v === 'string') {
    if (v.startsWith(ENV_PREFIX)) {
      const name = v.slice(ENV_PREFIX.length);
      const env = process.env[name];
      if (env === undefined) {
        if (!warnedEnvKeys.has(name)) {
          logger.warn(`[config] env "${name}" not set; field will be empty`);
          warnedEnvKeys.add(name);
        }
        return '';
      }
      return env;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val);
    return out;
  }
  return v;
}

// ── 加载/写入 ──────────────────────────────────────────────────────────

export function loadDefaults(): DefaultsConfig | null {
  const p = resolvePaths().defaultsConfig;
  const raw = atomicReadJson<DefaultsConfig>(p);
  if (raw === null) return null;
  if (typeof raw.$schema_version !== 'number') {
    logger.warn(`[config] ${p}: missing $schema_version, treating as ${CONFIG_SCHEMA_VERSION}`);
  }
  return expandEnvRefs(raw);
}

export function saveDefaults(value: DefaultsConfig): void {
  backupDefaults(resolvePaths().defaultsConfig);
  atomicWriteJson(resolvePaths().defaultsConfig, value);
}

/**
 * 备份 defaults.json 为 defaults_YYYYMMDDhhmmss.json。文件不存在时为 no-op。
 * 同秒重复调用会被覆盖（同一秒内的内容相同，可接受）。
 */
function backupDefaults(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  const backupPath = path.join(path.dirname(filePath), `defaults_${ts}.json`);
  try {
    fs.copyFileSync(filePath, backupPath);
  } catch (e) {
    logger.warn(`[config] backup failed: ${backupPath}: ${e}`);
  }
}

/**
 * 安全写入 defaults.json：备份现有文件 → 深合并 patch → 原子写入。
 *
 * 与 saveDefaults() 不同，本函数保留现有字段，仅覆盖 patch 中显式指定的字段。
 * 适用场景：evolclaw init 仅修改 active_baseagent/baseagents 时，不应丢失 chatmode/projects 等其它字段。
 */
export function saveDefaultsSafe(patch: Partial<DefaultsConfig>): void {
  const p = resolvePaths().defaultsConfig;
  let existing: DefaultsConfig | null = null;
  try {
    existing = atomicReadJson<DefaultsConfig>(p);
  } catch (e) {
    logger.warn(`[config] existing defaults.json unparsable, will be backed up and replaced: ${e}`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  backupDefaults(p);
  const merged = existing
    ? deepMergeObject(existing, patch)
    : { $schema_version: CONFIG_SCHEMA_VERSION, ...patch };
  atomicWriteJson(p, merged);
}

// ── 进程配置（{root}/config.json，evolclaw 实例级，与 agent 无关）──────

export interface ProcessConfig {
  $schema_version?: number;
  log?: {
    level?: string;
    retention_hours?: number;
    message_log?: boolean;
    event_log?: boolean;
  };
  aun?: {
    gateway?: string;
    keystorePath?: string;
    encryptionSeed?: string;
  };
}

export function loadProcessConfig(): ProcessConfig {
  const raw = atomicReadJson<ProcessConfig>(resolvePaths().processConfig);
  if (raw === null) return {};
  return expandEnvRefs(raw);
}

export function saveProcessConfig(value: ProcessConfig): void {
  atomicWriteJson(resolvePaths().processConfig, value);
}

// ── 自动迁移 ───────────────────────────────────────────────────────────

/**
 * 启动时自动迁移：如果 agents/defaults.json 不存在但 data/evolclaw.json 存在，
 * 从旧配置构造新结构（defaults.json + per-agent config.json），然后把旧文件改名。
 *
 * 同时处理旧 agents/<name>.json 文件（friendly-name 形态）。
 *
 * 幂等：已迁移过（defaults.json 存在）则跳过。
 */
export function autoMigrateIfNeeded(): void {
  const p = resolvePaths();
  const defaultsPath = p.defaultsConfig;
  const oldConfigPath = path.join(p.dataDir, 'evolclaw.json');

  if (fs.existsSync(defaultsPath)) return;
  if (!fs.existsSync(oldConfigPath)) return;

  logger.info('[migrate] Detected legacy data/evolclaw.json without agents/defaults.json — auto-migrating...');

  let oldConfig: any;
  try {
    oldConfig = JSON.parse(fs.readFileSync(oldConfigPath, 'utf-8'));
  } catch (e) {
    logger.error(`[migrate] Failed to parse ${oldConfigPath}: ${e}`);
    return;
  }

  // 1. 构造 defaults.json
  const defaults: DefaultsConfig = {
    $schema_version: CONFIG_SCHEMA_VERSION,
    active_baseagent: oldConfig.agents?.defaultAgent || 'claude',
    baseagents: {} as any,
    models: oldConfig.models,
    projects: oldConfig.projects ? { defaultPath: oldConfig.projects.defaultPath, list: oldConfig.projects.list, autoCreate: oldConfig.projects.autoCreate } : undefined,
    chatmode: oldConfig.chatmode,
    show_activities: oldConfig.showActivities,
    flush_delay: oldConfig.flushDelay,
    debounce: oldConfig.debounce,
    aun: oldConfig.channels?.aun?.keystorePath ? { keystorePath: oldConfig.channels.aun.keystorePath } : undefined,
  };

  // 搬 baseagents
  const KNOWN_BASEAGENTS = ['claude', 'codex', 'gemini', 'hermes'];
  for (const ba of KNOWN_BASEAGENTS) {
    const block = oldConfig.agents?.[ba];
    if (block && typeof block === 'object') {
      (defaults.baseagents as any)[ba] = { ...block };
    }
  }

  fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
  atomicWriteJson(defaultsPath, defaults);
  logger.info(`[migrate] ✓ Created ${defaultsPath}`);

  // 2. 从旧 evolclaw.json 的 channels 块 + 旧 agents/<name>.json 构造 per-agent config.json
  //    旧结构：evolclaw.json.channels 是全局 channel dict（属于 "default agent"），
  //    agents/<name>.json 是 named agent。

  // 2a. 处理旧 agents/<name>.json 文件
  const agentsDir = p.agentsDir;
  if (fs.existsSync(agentsDir)) {
    const entries = fs.readdirSync(agentsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'defaults.json' || entry.startsWith('schema-')) continue;
      const filePath = path.join(agentsDir, entry);
      if (!fs.statSync(filePath).isFile()) continue;

      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const aid = raw.channels?.aun?.aid;
        if (!aid || !isValidAid(aid)) {
          logger.warn(`[migrate] skip ${entry}: no valid AID in channels.aun.aid`);
          continue;
        }

        const agentConfig = buildAgentConfigFromLegacy(aid, raw, oldConfig);
        const agentDirPath = path.join(agentsDir, aid);
        fs.mkdirSync(agentDirPath, { recursive: true });
        atomicWriteJson(path.join(agentDirPath, 'config.json'), agentConfig);
        ensureAgentDirSkeleton(aid);

        // 改名旧文件
        fs.renameSync(filePath, filePath + '_');
        logger.info(`[migrate] ✓ ${entry} → agents/${aid}/config.json`);
      } catch (e) {
        logger.warn(`[migrate] skip ${entry}: ${e}`);
      }
    }
  }

  // 2b. 如果 evolclaw.json 的 channels 里有 AUN 实例且没有对应的 agents/<name>.json，
  //     说明旧结构只有一个"default agent"——为它也建一个 per-agent config.json
  const globalAun = oldConfig.channels?.aun;
  const globalAunAid = Array.isArray(globalAun)
    ? globalAun[0]?.aid
    : globalAun?.aid;

  if (globalAunAid && isValidAid(globalAunAid)) {
    const targetDir = path.join(agentsDir, globalAunAid);
    if (!fs.existsSync(path.join(targetDir, 'config.json'))) {
      const agentConfig = buildAgentConfigFromGlobalChannels(globalAunAid, oldConfig);
      fs.mkdirSync(targetDir, { recursive: true });
      atomicWriteJson(path.join(targetDir, 'config.json'), agentConfig);
      ensureAgentDirSkeleton(globalAunAid);
      logger.info(`[migrate] ✓ global channels → agents/${globalAunAid}/config.json`);
    }
  }

  // 3. 改名旧 evolclaw.json
  try {
    fs.renameSync(oldConfigPath, oldConfigPath + '_');
    logger.info(`[migrate] ✓ Renamed ${oldConfigPath} → evolclaw.json_`);
  } catch (e) {
    logger.warn(`[migrate] Failed to rename old config: ${e}`);
  }

  logger.info('[migrate] Auto-migration complete.');
}

/**
 * 从旧 agents/<name>.json 构造新 AgentConfig。
 * 旧格式：{ name, enabled, agents: { claude: {...} }, channels: { aun: {...}, feishu: {...} }, projects, chatmode }
 */
function buildAgentConfigFromLegacy(aid: string, raw: any, globalConfig: any): AgentConfig {
  const channels: ChannelInstance[] = [];

  // AUN 是隐式的（从 aid 派生），不放进 channels[]
  const aunBlock = raw.channels?.aun;

  // 其它 channels（非 AUN）
  for (const [type, block] of Object.entries(raw.channels || {})) {
    if (type === 'aun' || type === 'defaultChannel') continue;
    const instances = Array.isArray(block) ? block : [block];
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue;
      channels.push({
        ...inst,
        type,
        name: (inst as any).name || 'main',
      } as any);
    }
  }

  // owners / admins
  const owners: string[] = [];
  const admins: string[] = [];
  if (aunBlock?.owner) owners.push(aunBlock.owner);
  if (aunBlock?.admins) admins.push(...aunBlock.admins);

  // baseagent
  const agentKeys = Object.keys(raw.agents || {}).filter(k => k !== 'defaultAgent');
  const activeBaseagent = agentKeys[0] || globalConfig.agents?.defaultAgent || 'claude';

  return {
    $schema_version: CONFIG_SCHEMA_VERSION,
    aid,
    enabled: raw.enabled !== false,
    owners,
    admins: admins.length > 0 ? admins : undefined,
    channels,
    active_baseagent: activeBaseagent,
    baseagents: raw.agents ? filterBaseagents(raw.agents) : undefined,
    projects: raw.projects,
    chatmode: raw.chatmode,
  } as AgentConfig;
}

/**
 * 从旧 evolclaw.json 的全局 channels 块构造 per-agent config（"default agent" 场景）。
 */
function buildAgentConfigFromGlobalChannels(aid: string, globalConfig: any): AgentConfig {
  const channels: ChannelInstance[] = [];

  // AUN 是隐式的（从 aid 派生），不放进 channels[]
  const aunRaw = globalConfig.channels?.aun;
  const aunInst = Array.isArray(aunRaw) ? aunRaw[0] : aunRaw;

  // 其它 channels（非 AUN）
  for (const [type, block] of Object.entries(globalConfig.channels || {})) {
    if (type === 'aun' || type === 'defaultChannel') continue;
    const instances = Array.isArray(block) ? block : [block];
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue;
      if ((inst as any).enabled === false) continue;
      channels.push({
        ...inst,
        type,
        name: (inst as any).name || 'main',
      } as any);
    }
  }

  const owners: string[] = [];
  const admins: string[] = [];
  if (aunInst?.owner) owners.push(aunInst.owner);
  if (aunInst?.admins) admins.push(...aunInst.admins);

  const activeBaseagent = globalConfig.agents?.defaultAgent || 'claude';

  return {
    $schema_version: CONFIG_SCHEMA_VERSION,
    aid,
    enabled: true,
    owners,
    admins: admins.length > 0 ? admins : undefined,
    channels,
    active_baseagent: activeBaseagent,
    projects: globalConfig.projects,
    chatmode: globalConfig.chatmode,
  } as AgentConfig;
}

function filterBaseagents(agents: any): BaseagentsBlock | undefined {
  const result: any = {};
  const KNOWN = ['claude', 'codex', 'gemini', 'hermes'];
  for (const k of KNOWN) {
    if (agents[k] && typeof agents[k] === 'object') result[k] = agents[k];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}


export function loadAgent(aid: string): AgentConfig | null {
  const p = agentConfigPath(aid);
  const raw = atomicReadJson<AgentConfig>(p);
  if (raw === null) return null;
  if (raw.aid !== aid) {
    throw new Error(`[config] ${p}: aid field "${raw.aid}" != directory name "${aid}"`);
  }
  return expandEnvRefs(raw);
}

export function saveAgent(value: AgentConfig): void {
  if (!isValidAid(value.aid)) {
    throw new Error(`[config] saveAgent: invalid aid "${value.aid}" (must be a valid multi-level domain like mybot.agentid.pub)`);
  }
  if (value.owners) {
    for (const o of value.owners) {
      if (!isValidAid(o)) {
        throw new Error(`[config] saveAgent: invalid owner AID "${o}" in ${value.aid} (must be a valid multi-level domain like alice.agentid.pub)`);
      }
    }
  }
  if (value.admins) {
    for (const a of value.admins) {
      if (!isValidAid(a)) {
        throw new Error(`[config] saveAgent: invalid admin AID "${a}" in ${value.aid} (must be a valid multi-level domain like alice.agentid.pub)`);
      }
    }
  }
  atomicWriteJson(agentConfigPath(value.aid), value);
}

export interface AgentLoadIssue {
  dirName: string;
  reason: string;
}

export interface AgentLoadResult {
  agents: AgentConfig[];
  skipped: AgentLoadIssue[];
}

/**
 * 扫描 agents/ 目录加载所有 self-agent 配置。
 *
 * 跳过条件（warn-and-skip）：
 *   - 目录名不是合法 AID
 *   - 缺 config.json
 *   - config.json 解析或基础校验失败
 *
 * 不抛错——返回 skipped 列表交调用方决定是否继续。
 */
export function loadAllAgents(): AgentLoadResult {
  const agentsDir = resolvePaths().agentsDir;
  const result: AgentLoadResult = { agents: [], skipped: [] };

  if (!fs.existsSync(agentsDir)) return result;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const why = checkAgentDir(agentsDir, dirName);
    if (why) {
      result.skipped.push({ dirName, reason: why });
      logger.warn(`[config] skip agents/${dirName}: ${why}`);
      continue;
    }
    try {
      const cfg = loadAgent(dirName);
      if (cfg === null) {
        result.skipped.push({ dirName, reason: 'config.json missing after dir check' });
        continue;
      }
      const errs = validateAgentConfig(cfg);
      if (errs.length > 0) {
        const reason = errs.join('; ');
        result.skipped.push({ dirName, reason });
        logger.warn(`[config] skip agents/${dirName}: ${reason}`);
        continue;
      }
      result.agents.push(cfg);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      result.skipped.push({ dirName, reason });
      logger.warn(`[config] skip agents/${dirName}: ${reason}`);
    }
  }
  return result;
}

// ── 校验 ───────────────────────────────────────────────────────────────

export function validateAgentConfig(cfg: AgentConfig): string[] {
  const errs: string[] = [];
  if (!cfg.aid || !isValidAid(cfg.aid)) errs.push(`invalid aid: ${cfg.aid}`);
  if (!Array.isArray(cfg.channels)) {
    errs.push('channels must be an array');
    return errs;
  }

  let aunCount = 0;
  const seenNamesByType = new Map<string, Set<string>>();
  for (const [i, ch] of cfg.channels.entries()) {
    if (!ch || typeof ch !== 'object') {
      errs.push(`channels[${i}] must be an object`);
      continue;
    }
    if (ch.type === 'aun') {
      // AUN 是隐式的（从 agent.aid 派生），不应出现在 channels[] 里
      // 容忍但 warn——不算 error，跳过校验
      aunCount++;
      continue;
    }
    if (!SUPPORTED_CHANNEL_TYPES.has(ch.type)) {
      errs.push(`channels[${i}].type "${ch.type}" not supported`);
      continue;
    }
    if (!isValidChannelName(ch.name)) {
      errs.push(`channels[${i}].name invalid (empty or contains '#'): ${JSON.stringify(ch.name)}`);
      continue;
    }
    const set = seenNamesByType.get(ch.type) ?? new Set<string>();
    if (set.has(ch.name)) {
      errs.push(`channels[${i}]: duplicate name "${ch.name}" within type "${ch.type}"`);
    } else {
      set.add(ch.name);
      seenNamesByType.set(ch.type, set);
    }
  }
  if (aunCount > 0) {
    logger.warn(`[config] agent ${cfg.aid}: channels[] contains ${aunCount} AUN entry(s) — AUN is implicit, these will be ignored`);
  }
  return errs;
}

// ── 合并 ───────────────────────────────────────────────────────────────

/**
 * defaults + per-agent → MergedAgentConfig
 * defaults 缺失时直接返回 per-agent（视 defaults 为空对象）。
 */
export function mergeForAgent(agent: AgentConfig, defaults: DefaultsConfig | null): MergedAgentConfig {
  const d = defaults ?? ({ $schema_version: CONFIG_SCHEMA_VERSION } as DefaultsConfig);

  const merged: MergedAgentConfig = {
    $schema_version: agent.$schema_version ?? CONFIG_SCHEMA_VERSION,
    aid: agent.aid,
    enabled: agent.enabled,
    owners: agent.owners,
    admins: agent.admins,
    aun: deepMergeBlocks<AunRuntimeBlock>(d.aun, agent.aun),
    channels: agent.channels,
    active_baseagent: agent.active_baseagent ?? d.active_baseagent,
    baseagents: deepMergeBlocks<BaseagentsBlock>(d.baseagents, agent.baseagents),
    models: deepMergeBlocks<ModelsBlock>(d.models, agent.models),
    projects: deepMergeBlocks<ProjectsBlock>(d.projects, agent.projects),
    chatmode: deepMergeBlocks<ChatmodeBlock>(d.chatmode, agent.chatmode),
    show_activities: agent.show_activities ?? d.show_activities,
    flush_delay: agent.flush_delay ?? d.flush_delay,
    debounce: agent.debounce ?? d.debounce,
    debug: deepMergeBlocks(d.debug, agent.debug),
    enable_rich_content: agent.enable_rich_content ?? d.enable_rich_content,
  };
  return merged;
}

function deepMergeBlocks<T extends object>(base?: T, overlay?: T): T | undefined {
  if (!base && !overlay) return undefined;
  if (!base) return overlay;
  if (!overlay) return base;
  return deepMergeObject(base, overlay) as T;
}

/** 递归对象合并：overlay 覆盖 base；标量与数组按 overlay 直接替换；plain object 递归。 */
function deepMergeObject(base: any, overlay: any): any {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = deepMergeObject(base[k], v);
  }
  return out;
}

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── 目录骨架 ───────────────────────────────────────────────────────────

/**
 * 为某个 self-agent 创建文档约定的子目录骨架（personal/、identities/、venues/ 等）。
 * 已存在则跳过，幂等可重复调用。
 */
export function ensureAgentDirSkeleton(aid: string): void {
  const root = agentDir(aid);
  const subs = [
    'personal',
    'personal/memory',
    'personal/skills',
    'relations/contacts',
    'relations/_observed',
    'relations/_observed/_index',
    'relations/_index',
    'relations/_trash',
    'venues',
    'venues/_index',
    'venues/_trash',
    'sessions',
    'data/cache',
    'index',
  ];
  for (const sub of subs) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
}

// ── identities → relations 迁移 ──────────────────────────────────────

/**
 * 启动时自动迁移：如果 agents/<aid>/identities/ 存在但 relations/ 不存在，
 * 将 identities/ 重命名为 relations/。幂等。
 */
export function migrateIdentitiesIfNeeded(): void {
  const agentsDir = resolvePaths().agentsDir;
  if (!fs.existsSync(agentsDir)) return;

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const oldDir = path.join(agentsDir, entry.name, 'identities');
    const newDir = path.join(agentsDir, entry.name, 'relations');
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      logger.info(`[migrate] Renamed agents/${entry.name}/identities/ → relations/`);
    }
  }
}

// ── Project Migration ────────────────────────────────────────────────────────
import os from 'os';

/** 将绝对路径编码为 Claude Code 的目录名格式（/ \ . 替换为 -） */
function encodePath(p: string): string {
  return p.replace(/[/\\\.]/g, '-');
}

/** 查找最新的 ~/.codex/state_*.sqlite */
function findCodexDb(): string | null {
  const codexHome = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexHome)) return null;
  const files = fs.readdirSync(codexHome)
    .filter(f => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => {
      const va = parseInt(a.match(/state_(\d+)/)?.[1] || '0');
      const vb = parseInt(b.match(/state_(\d+)/)?.[1] || '0');
      return vb - va;
    });
  return files.length > 0 ? path.join(codexHome, files[0]) : null;
}

export interface MigrateResult {
  claudeSessionsMoved: boolean;
  claudeHistoryUpdated: boolean;
  codexUpdated: number;
  evolclawDbUpdated: number;
  evolclawConfigUpdated: boolean;
  directoryMoved: boolean;
}

export async function migrateProject(oldPath: string, newPath: string): Promise<MigrateResult> {
  const result: MigrateResult = {
    claudeSessionsMoved: false,
    claudeHistoryUpdated: false,
    codexUpdated: 0,
    evolclawDbUpdated: 0,
    evolclawConfigUpdated: false,
    directoryMoved: false,
  };

  const oldAbs = path.resolve(oldPath);
  const newAbs = path.resolve(newPath);

  if (!fs.existsSync(oldAbs)) throw new Error(`源目录不存在: ${oldAbs}`);
  if (fs.existsSync(newAbs)) throw new Error(`目标目录已存在: ${newAbs}`);

  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  const oldEncoded = encodePath(oldAbs);
  const newEncoded = encodePath(newAbs);

  // 1. 迁移 ~/.claude/projects/{encoded}/
  const oldClaudeDir = path.join(claudeProjects, oldEncoded);
  const newClaudeDir = path.join(claudeProjects, newEncoded);
  if (fs.existsSync(oldClaudeDir)) {
    fs.renameSync(oldClaudeDir, newClaudeDir);
    result.claudeSessionsMoved = true;
  }

  // 2. .jsonl 内部路径不需要替换 — 它们是历史对话记录，
  //    resume 时模型会根据当前 cwd 工作，旧路径只是历史上下文

  // 3. 更新 ~/.claude/history.jsonl
  const historyFile = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (fs.existsSync(historyFile)) {
    const lines = fs.readFileSync(historyFile, 'utf-8').split('\n');
    const updated = lines.map(line => {
      if (!line.trim()) return line;
      try {
        const obj = JSON.parse(line);
        if (obj.project === oldAbs) { obj.project = newAbs; return JSON.stringify(obj); }
      } catch { /* skip */ }
      return line;
    });
    const newContent = updated.join('\n');
    if (newContent !== fs.readFileSync(historyFile, 'utf-8')) {
      fs.writeFileSync(historyFile, newContent, 'utf-8');
      result.claudeHistoryUpdated = true;
    }
  }

  // 4. 更新 Codex SQLite threads.cwd
  const codexDbPath = findCodexDb();
  if (codexDbPath) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(codexDbPath);
      const r = db.prepare('UPDATE threads SET cwd = ? WHERE cwd = ?').run(newAbs, oldAbs) as any;
      result.codexUpdated = r.changes ?? 0;
      db.close();
    } catch { /* Codex not installed or DB locked */ }
  }

  // 5. 移动项目目录
  fs.renameSync(oldAbs, newAbs);
  result.directoryMoved = true;

  // 6. 更新 EvolClaw sessions（文件系统）
  const p = resolvePaths();
  if (fs.existsSync(p.sessionsDir)) {
    try {
      const { scanChatDirs, scanMetaFiles, readJsonFile, atomicWriteJson, appendJsonl } = await import('./core/session/session-fs-store.js');
      type SF = import('./core/session/session-fs-store.js').SessionFile;

      let updated = 0;
      const chatDirs = scanChatDirs(p.sessionsDir);
      for (const { dirPath } of chatDirs) {
        // 更新 active.json
        const activePath = path.join(dirPath, 'active.json');
        const active = readJsonFile<SF>(activePath);
        if (active && active.projectPath === oldAbs) {
          active.projectPath = newAbs;
          active.updatedAt = Date.now();
          atomicWriteJson(activePath, active);
          updated++;
        }
        // 更新各 meta jsonl 的最后一行（append 一条新快照标记 projectPath 变化）
        for (const metaFile of scanMetaFiles(dirPath)) {
          const metaPath = path.join(dirPath, metaFile);
          const { readLastJsonlLine } = await import('./core/session/session-fs-store.js');
          const meta = readLastJsonlLine<SF>(metaPath);
          if (meta && meta.projectPath === oldAbs) {
            meta.projectPath = newAbs;
            meta.updatedAt = Date.now();
            appendJsonl(metaPath, meta);
            updated++;
          }
        }
      }
      result.evolclawDbUpdated = updated;
    } catch { /* fs not accessible */ }
  }

  // 7. 更新各 self-agent config.json 的 projects.list
  try {
    const { agents } = loadAllAgents();
    for (const cfg of agents) {
      if (!cfg.projects?.list) continue;
      let changed = false;
      for (const [k, v] of Object.entries(cfg.projects.list)) {
        if (v === oldAbs) { cfg.projects.list[k] = newAbs; changed = true; }
      }
      if (changed) {
        saveAgent(cfg);
        result.evolclawConfigUpdated = true;
      }
    }
  } catch { /* agents not accessible */ }

  return result;
}
