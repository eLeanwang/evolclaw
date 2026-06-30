/**
 * ConfigStore —— 新结构（evolclaw-home-directory.md）的配置加载/合并/写入。
 *
 *   agents/defaults.json                   ← DefaultsConfig
 *   agents/<aid>/config.json               ← AgentConfig（per-agent）
 *
 * 合并规则：
 *   - 统一由 ConfigManager.resolveEffective() 处理
 *   - 覆盖链：defaults → agent/config → relation/config
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
  EffectiveAgentConfig,
  ChannelInstance,
  ChatmodeBlock,
  ShowActivitiesMode,
  DebugBlock,
} from './types.js';
import { CONFIG_SCHEMA_VERSION } from './types.js';
import { resolveAgentConfig, resolveEffective } from './config/config-manager.js';
import { expandVars, buildEnvResolver } from './config/merge.js';
import { mergeBehaviorIntoEffective } from './config/behavior.js';
import { normalizeAgentLifecycle } from './config/lifecycle.js';
import { logger } from './utils/logger.js';

// ── 进程级配置（{root}/evolclaw.json）─────────────────────────────────────
// agent 级配置（agents/<aid>/config.json）见本文件下半部分。

export interface TunnelTarget {
  name: string;
  port: number;
  pathPrefix?: string;
}

export interface TunnelConfig {
  targets: TunnelTarget[];
}

export interface EvolclawAunConfig {
  encryptionSeed?: string | null;  // null 原样保留（迁移自旧 config.json）
}

/**
 * 单个 Service Proxy 服务：把一个本地 HTTP/WS 服务暴露到 AUN 网络。
 * 访问路径为 https://{providerAid}/{name}/...，proxy-server 剥掉 {name} 前缀后
 * 转发剩余 path 回连本地 endpoint。
 */
export interface ServiceProxyService {
  name: string;                 // 服务名（URL 段），仅 [a-z0-9_-]+，不得用 api/health/proxy/ws 等保留名
  enabled?: boolean;            // 默认 true
  endpoint?: string;            // 本地回连地址，如 http://127.0.0.1:42705。
                                //   省略时按 source 自动发现（见 source 字段）
  source?: 'ecweb' | 'static';  // endpoint 来源：'ecweb'=读 instance 文件发现端口（忽略 endpoint）；
                                //   'static'=用显式 endpoint。默认 static
  serviceType?: string;         // http / websocket / sse / mcp，默认 http
  visibility?: string;          // public / private，默认 private
  metadata?: Record<string, unknown>;  // 非敏感描述（label 等）
}

export interface ServiceProxyConfig {
  enabled?: boolean;            // 总开关，默认 false
  services?: ServiceProxyService[];
}

export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  owners?: string[];          // 进程级控制面鉴权名单（AID）：谁能远程管理本 daemon（/agent /system）
  debug?: DebugBlock;
  tunnel?: TunnelConfig;
  aun?: EvolclawAunConfig;   // 从旧 config.json 迁入
  serviceProxy?: ServiceProxyConfig;  // AUN Service Proxy：把本地服务暴露到 AUN 网络
  ecweb?: {
    enabled?: boolean;        // true = evolclaw start 时自动后台启动 ecweb
    port?: number;            // 监听端口，默认 42705
  };
  watch?: {
    logTypes?: string[];   // 上次勾选的日志类型（shortName，去轮转后缀）
  };
}

/** 读 {root}/evolclaw.json。文件不存在返回 {}，不报错。 */
export function loadEvolclawConfig(): EvolclawConfig {
  const raw = atomicReadJson<EvolclawConfig>(resolvePaths().evolclawJson);
  return raw ?? {};
}

/** 原子写入 {root}/evolclaw.json。调用方负责传完整对象（含要保留的字段）。 */
export function saveEvolclawConfig(value: EvolclawConfig): void {
  atomicWriteJson(resolvePaths().evolclawJson, value);
}

const SUPPORTED_CHANNEL_TYPES = new Set([
  'aun', 'feishu', 'wechat', 'dingtalk', 'qqbot', 'wecom',
]);

// ── env 展开（${VAR}，design §五）─────────────────────────────────────────
//
// 仅支持 ${VAR}（旧 $ENV:NAME 已废弃）。展开经 merge.ts 的 expandVars + 三级 .env 解析器
// （关系 > agent > 全局 > process.env）。loadAgent 传 agent 作用域；loadDefaults 用全局。

/** 全局作用域（仅 {root}/.env + process.env）展开 ${VAR}。 */
export function expandEnvRefs<T>(value: T): T {
  const resolver = buildEnvResolver({ rootDir: resolvePaths().root });
  return expandVars(value, resolver);
}

/** agent 作用域展开（agent/.env > 全局 .env > process.env）。 */
function expandEnvRefsForAgent<T>(value: T, aid: string): T {
  const resolver = buildEnvResolver({ rootDir: resolvePaths().root, agentDir: agentDir(aid) });
  return expandVars(value, resolver);
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

/** 递归对象合并：overlay 覆盖 base；标量与数组按 overlay 替换；plain object 递归。
 *  saveDefaultsSafe 内部用（保留现有"补丁式写 defaults"语义，与覆盖链合并无关）。 */
function deepMergeObject(base: any, overlay: any): any {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = deepMergeObject(base[k], v);
  return out;
}
function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── 进程配置迁移（旧 {root}/config.json ProcessConfig → evolclaw.json）──────
//
// ProcessConfig 类型 + loadProcessConfig/saveProcessConfig 已废弃并删除：
// 唯一有效字段 aun.encryptionSeed 已迁入 evolclaw.json（见 migrateProcessConfigIfNeeded），
// 读取源切到 loadEvolclawConfig（store.ts）。log / aun.gateway / aun.keystorePath 是死字段。

/**
 * 一次性迁移：{root}/config.json（旧 ProcessConfig）→ {root}/evolclaw.json。
 * - 仅搬运 aun.encryptionSeed（逐字节原样，含 null）；log / aun.gateway / aun.keystorePath 是死字段，丢弃。
 * - 合并写入（不覆盖 evolclaw.json 已有字段如 aid）。
 * - 完成后归档 config.json → config.json.migrated（保留备份，不直接删）。
 *
 * ⚠️ encryptionSeed 是 AID 私钥的加密种子，迁移前后 getAidStore 拿到的 seed 必须逐字节一致，
 * 否则所有已注册 AID 私钥解不开。这里只搬运不改值（含 null）。
 */
export function migrateProcessConfigIfNeeded(): void {
  const p = resolvePaths();
  const oldPath = p.processConfig; // {root}/config.json
  const raw = atomicReadJson<{ aun?: { encryptionSeed?: string | null } }>(oldPath);
  if (raw === null) return; // 不存在 → no-op

  const evc = loadEvolclawConfig();
  // 仅当旧文件确实带 aun.encryptionSeed 字段时才搬（hasOwnProperty，保 null 语义）
  const didMigrateSeed = !!(raw.aun && Object.prototype.hasOwnProperty.call(raw.aun, 'encryptionSeed'));
  if (didMigrateSeed) {
    evc.aun = { ...(evc.aun ?? {}), encryptionSeed: raw.aun!.encryptionSeed };
  }
  evc.$schema_version = evc.$schema_version ?? 1;
  saveEvolclawConfig(evc);

  // 归档旧文件（不删，留备份）
  try {
    fs.renameSync(oldPath, oldPath + '.migrated');
  } catch { /* ignore */ }
  const what = didMigrateSeed ? 'aun.encryptionSeed 已搬运' : 'aun.encryptionSeed 不存在（无需搬运）';
  logger.info(`[migrate] config.json → evolclaw.json (${what}，config.json 已归档为 .migrated)`);
}

// ── 自动迁移（已删除）─────────────────────────────────────────────────
//
// 旧 data/evolclaw.json / agents/<name>.json → 新结构的一次性迁移已随配置体系 v2 退场
// （fresh init，不做兼容过渡，见 docs/config-system-design-v2.md §七）。
// 保留空壳仅为调用点签名兼容——startup 不再调用。
export function autoMigrateIfNeeded(): void {
  /* no-op: legacy migration removed (config-system v2 fresh init) */
}

export function loadAgent(aid: string): AgentConfig | null {
  const p = agentConfigPath(aid);
  const raw = atomicReadJson<AgentConfig>(p);
  if (raw === null) return null;
  if (raw.aid !== aid) {
    throw new Error(`[config] ${p}: aid field "${raw.aid}" != directory name "${aid}"`);
  }
  const cfg = normalizeAgentLifecycle(expandEnvRefsForAgent(raw, aid));
  if (cfg.projects?.defaultPath) {
    cfg.projects.defaultPath = cfg.projects.defaultPath.replace(/[/\\]+$/, '');
  }
  return cfg;
}

export function saveAgent(value: AgentConfig): void {
  if (value.projects) {
    const projects = value.projects;
    const normalized: NonNullable<AgentConfig['projects']> = {};
    if (typeof projects.rootPath === 'string') normalized.rootPath = projects.rootPath;
    if (typeof projects.defaultPath === 'string') normalized.defaultPath = projects.defaultPath;
    if (Object.keys(normalized).length > 0) value = { ...value, projects: normalized };
    else {
      const { projects: _projects, ...rest } = value;
      value = rest as AgentConfig;
    }
  }
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

function isGeneratedControlAid(aid: string): boolean {
  return /^ec\d{5}\.agentid\.pub$/.test(aid);
}

function hasLocalAidPrivateKey(aid: string): boolean {
  return fs.existsSync(path.join(resolvePaths().root, 'AIDs', aid, 'private', 'key.json'));
}

function isControlAidStateDir(dirName: string, controlAid?: string): boolean {
  if (dirName === controlAid) return true;
  return isGeneratedControlAid(dirName) && hasLocalAidPrivateKey(dirName);
}

/**
 * 扫描 agents/ 目录加载所有 self-agent 配置。
 *
 * 跳过条件（warn-and-skip）：
 *   - 目录名不是合法 AID
 *   - 缺 config.json（控制 AID 状态目录除外）
 *   - config.json 解析或基础校验失败
 *
 * 不抛错——返回 skipped 列表交调用方决定是否继续。
 */
export function loadAllAgents(): AgentLoadResult {
  const agentsDir = resolvePaths().agentsDir;
  const result: AgentLoadResult = { agents: [], skipped: [] };
  const controlAid = loadEvolclawConfig().aid;

  if (!fs.existsSync(agentsDir)) return result;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const cfgPath = path.join(agentsDir, dirName, 'config.json');

    // Skip directories without config.json (could be utility dirs like response-modes, templates, etc.)
    if (!fs.existsSync(cfgPath)) {
      if (isControlAidStateDir(dirName, controlAid)) {
        logger.debug(`[config] ignore control AID state dir agents/${dirName}`);
      } else {
        logger.debug(`[config] ignore non-agent dir agents/${dirName} (no config.json)`);
      }
      continue;
    }

    // Now validate AID format since config.json exists
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

/**
 * @deprecated 设计目标（config-system-design-v2 §七）是用 ConfigManager 的 ajv schema
 * 校验替代本函数。但**当前 agent config.json 尚未完成完整 schema 定义**——现有文件仍
 * 包含少量历史/实验字段。agent-config schema 是 `additionalProperties:false`，
 * 此刻切到 schema 校验可能让现存 agent 加载失败。
 *
 * 因此本函数**暂保留纯业务规则校验**（不接 schema）。待 schema 补齐所有字段后，
 * 再切换到 ConfigManager.validateConfig。
 * 见 docs/config-v2-inconsistencies-analysis.md 问题 B / config-system-v2-implementation-status.md。
 */
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
 * @deprecated Compatibility shim for older callers/tests.
 *
 * Runtime merging is owned by ConfigManager.resolveEffective(). This helper keeps
 * the old direct API alive while also overlaying HA fields from behavior.json.
 */
export function mergeForAgent(agent: AgentConfig, defaults: DefaultsConfig | null): AgentConfig {
  const hMerged = defaults ? deepMergeObject(defaults, agent) as AgentConfig : { ...agent };
  delete (hMerged as any).owners;
  delete (hMerged as any).admins;
  if (agent.owners) hMerged.owners = [...agent.owners];
  if (agent.admins) hMerged.admins = [...agent.admins];
  return mergeBehaviorIntoEffective(hMerged, { self: agent.aid }) as AgentConfig;
}

// ── 目录骨架 ───────────────────────────────────────────────────────────

/**
 * 为某个 self-agent 创建文档约定的子目录骨架（personal/、identities/、venues/ 等）。
 * 已存在则跳过，幂等可重复调用。
 *
 * 注：本函数只建**目录骨架**，不碰 config.json——由 saveAgent（创建路径）
 * 或 ConfigManager.ensureFile（设计目标）负责。
 * 骨架那部分职责，目录骨架职责保留在此。
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
// 复用与 Claude SDK 对齐的统一编码（resolve→realpath→NFC→非字母数字替换为 -），
// 避免本地实现规则不一致导致中文/非 ASCII 路径迁移时找不到 SDK 会话目录。
import { encodePath } from './utils/cross-platform.js';

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
  directoryMoved: boolean;
}

export async function migrateProject(oldPath: string, newPath: string): Promise<MigrateResult> {
  const result: MigrateResult = {
    claudeSessionsMoved: false,
    claudeHistoryUpdated: false,
    codexUpdated: 0,
    evolclawDbUpdated: 0,
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

  return result;
}
