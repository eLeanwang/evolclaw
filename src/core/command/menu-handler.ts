import { type Session } from '../../types.js';
import { normalizePeer, resolveEffectiveModel, resolvePermissionMode, writeScope } from '../model/config-scope.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import { modelMatches } from './model-resolve.js';
import { filterModelsForRole, validateModelSelectionForRole } from '../model/model-permission.js';
import { type AgentRunnerFull, hasModelSwitcher, hasPermissionController } from '../../agents/runner-types.js';
import { getCodexEfforts } from '../../agents/codex-runner.js';
import { resolvePaths, getPackageRoot } from '../../paths.js';
import { buildEnvelope } from '../message/message-utils.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { parseDuration } from '../../trigger/parser.js';
import type { ParsedTriggerSet } from '../../trigger/parser.js';
import { checkLatestVersion, getLocalVersion, isLinkedInstall, compareVersions, resolveGlobalPkg } from '../../utils/npm-ops.js';
import { commandExists } from '../../utils/cross-platform.js';
import { loadDefaults, loadEvolclawConfig } from '../../config-store.js';
import {
  read as cfgRead,
  resolveEffective,
  routeFieldPath,
  write as cfgWrite,
  type Selector,
} from '../../config/config-manager.js';
import { execAgentAction, execAgentQuery, execAgentOptions, resolveProjectPath } from '../message/command-handler-agent-control.js';
import { gatewayList, gatewayUpdate, gatewayDelete, gatewayTest, gatewayModels, gatewaySetPrice, gatewaySyncEnv } from '../../config/gateway-config.js';
import { displaySessionTitle } from '../session/session-title.js';
import {
  isCapabilityType,
  listCapabilityOptions,
  queryCapabilityTypes,
  resolveCapabilityContext,
  updateCapabilityPolicy,
} from '../capability/capability-manager.js';
import { parseCliIntent, rawCliIntent, withDefaultRelationContext } from './cli-intent-parser.js';
import { authorizeCommand } from './command-permission.js';
import { auditCommandAuthorization, hashArgv } from './command-audit.js';
import type { CommandAuthorizationContext, CommandIntent, CommandScope } from '../../types.js';

/**
 * 获取 baseagent CLI 的版本号（claude/gemini/codex）。
 * 失败返回 null（命令不存在或执行失败）。
 */
function getBaseagentVersion(cmd: string): string | null {
  try {
    const output = execFileSync(cmd, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // claude: "2.1.187 (Claude Code)" → 提取 "2.1.187"
    // gemini: "0.38.0" → 直接返回
    // codex: "codex-cli 0.142.0" → 提取 "0.142.0"
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export interface MenuNext {
  type: 'select' | 'text';
  items?: MenuItem[];
  dynamic?: boolean;
}

export interface MenuItem {
  cmd?: string;
  value?: string;
  label: string;
  args?: string;
  desc?: string;
  selected?: boolean;
  next?: MenuNext;
  preview?: string;
  lastActive?: number;
  agentSessionId?: string;
  turns?: number;
}

export type MenuChatType = 'private' | 'group';

const allEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = typeof allEfforts[number];
const PERMISSION_MODE_KEYS = ['auto', 'bypass', 'readonly', 'plan', 'edit', 'request', 'noask'] as const;

/** menu file: fetch 文件大小上限（与 /file 一致） */
const FILE_FETCH_MAX_SIZE = 10 * 1024 * 1024;
/** menu file: query 的 sha256 仅对 ≤ 2 MB 文件计算，超过返回 null（见设计文档 §7 决策 2） */
const FILE_HASH_MAX_SIZE = 2 * 1024 * 1024;
const FILE_LIST_DEFAULT_LIMIT = 500;
const FILE_LIST_MAX_LIMIT = 1000;

interface FileListEntry {
  name: string;
  type: 'file' | 'directory';
  size: number | null;
  mtime: number;
  birthtime: number;
}

interface FileListEntryInfo {
  isDirectory: boolean;
  followTarget: boolean;
}

function validateCapabilityScope(args?: Record<string, any>): { error: string; code: string } | null {
  const scope = args?.scope ?? 'project';
  return scope === 'project' ? null : { error: 'MVP 只支持 scope=project', code: 'INVALID_SCOPE' };
}

function sanitizeCapabilityOptionsForRole(items: any[], role: string): any[] {
  if (role === 'owner' || role === 'admin') return items;
  return items.map(item => {
    const { desc: _desc, ...rest } = item;
    return rest;
  });
}

function sanitizeCapabilityQueryForRole(data: any, role: string): any {
  if (role === 'owner' || role === 'admin') return data;
  const { projectPath: _projectPath, ...rest } = data;
  return rest;
}

function resolveCapabilityTarget(this: any, params: {
  channel: string;
  args?: Record<string, any>;
  session?: Session | null;
  evolagent?: any;
  fromControlChannel?: boolean;
}): { ctx: import('../capability/types.js').CapabilityContext; config: any; agent: any } | { error: string; code: string } {
  const scopeError = validateCapabilityScope(params.args);
  if (scopeError) return scopeError;

  const requestedAid = params.args?.aid ?? params.args?.agent;
  const targetAgent = requestedAid
    ? this.agentRegistry?.get?.(String(requestedAid))
    : params.evolagent ?? this.getOwningAgent?.(params.channel);

  if (!targetAgent) {
    return { error: requestedAid ? `未找到 Agent: ${requestedAid}` : '当前 channel 无绑定 agent', code: requestedAid ? 'NOT_FOUND' : 'FORBIDDEN' };
  }

  if (!params.fromControlChannel) {
    const selfAid = this.getOwningAgent?.(params.channel)?.aid;
    if (selfAid && targetAgent.aid !== selfAid) {
      return { error: '跨 agent 操作仅允许通过控制 AID channel 执行', code: 'FORBIDDEN' };
    }
  }

  const freshConfig = (() => {
    try { return resolveEffective({ self: targetAgent.aid }, { cache: true }); }
    catch { return targetAgent.config; }
  })();
  const fallbackBaseagent = (() => {
    try { return targetAgent.baseagent; } catch { return undefined; }
  })();

  const ctx = resolveCapabilityContext({
    aid: targetAgent.aid,
    baseagent: params.args?.baseagent ?? params.session?.baseagent ?? freshConfig?.active_baseagent ?? fallbackBaseagent,
    projectPath: targetAgent.projectPath,
    sessionProjectPath: params.session?.projectPath,
    sessionBaseagent: params.session?.baseagent,
    config: freshConfig,
  });
  if ('error' in ctx) return ctx;
  return { ctx, config: freshConfig, agent: targetAgent };
}

function getRenameName(args: any): string {
  return (args?.name ?? args?.title ?? args?.value ?? '').toString().trim();
}

function buildSessionPayload(session: Session, name: string): Record<string, any> {
  const payload: Record<string, any> = { id: session.id, name };
  if (session.agentSessionId) payload.agentSessionId = session.agentSessionId;
  return payload;
}

async function findMainSessionTarget(
  sessionManager: any,
  channel: string,
  channelId: string,
  target: string,
  activeSession?: Session | null,
): Promise<Session | undefined> {
  if (!target) {
    return activeSession && !activeSession.threadId ? activeSession : undefined;
  }

  const sessions = (await sessionManager.listSessions(channel, channelId) as Session[])
    .filter((s: Session) => !s.threadId);

  return sessions.find((s: Session) =>
    s.name === target ||
    s.id === target ||
    (target.length >= 8 && s.id.startsWith(target)) ||
    s.agentSessionId === target ||
    (!!s.agentSessionId && target.length >= 8 && s.agentSessionId.startsWith(target))
  );
}

/**
 * 解析并校验 menu `name=file` 的目标路径（query/fetch 共用）。
 *
 * 与文本 `/file` 的差异（见设计文档 §6.2）：
 *   - 接受项目内**绝对路径**（文本 /file 仍拒绝绝对路径）
 *   - 项目外文件仅 aid channel owner（identity.role === 'owner'）可取
 *
 * 沿用 /file 的安全校验链：拒绝 `..` 穿越、realpathSync 后验证落点。
 * 成功返回 `{ realPath, projectPath, stat }`；失败返回 `{ error, code }`。
 */
function resolveMenuFilePath(
  input: string,
  session: { projectPath: string } | null | undefined,
  role: string | undefined,
  expectType?: 'file' | 'directory',
): { realPath: string; projectPath: string; stat: fs.Stats } | { error: string; code: string } {
  if (!session?.projectPath) return { error: '当前无活跃会话', code: 'NO_ACTIVE_SESSION' };
  const raw = (input ?? '').toString().trim();
  if (!raw) return { error: '缺少 path 参数', code: 'MISSING_VALUE' };

  // 拒绝 .. 路径穿越（兼容两种分隔符）
  if (raw.split(path.sep).includes('..') || raw.split('/').includes('..')) {
    return { error: '不支持 .. 路径穿越', code: 'NO_PERMISSION' };
  }

  // 相对路径基于 projectPath 解析；绝对路径原样
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(session.projectPath, raw);

  if (!fs.existsSync(resolved)) {
    return { error: '文件不存在', code: 'NOT_FOUND' };
  }

  let realPath: string;
  let realProjectPath: string;
  try {
    realPath = fs.realpathSync(resolved);
    realProjectPath = fs.realpathSync(session.projectPath);
  } catch {
    return { error: '文件不存在', code: 'NOT_FOUND' };
  }

  const inProject = realPath === realProjectPath || realPath.startsWith(realProjectPath + path.sep);
  // 项目外文件：仅 aid channel owner 可取（§6.2）
  if (!inProject && role !== 'owner') {
    return { error: '无权限：项目外文件仅 owner 可取', code: 'NO_PERMISSION' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { error: '文件不存在', code: 'NOT_FOUND' };
  }
  if (expectType === 'file' && stat.isDirectory()) {
    return { error: '暂不支持目录', code: 'NOT_SUPPORTED' };
  }
  if (expectType === 'directory' && !stat.isDirectory()) {
    return { error: '不是目录', code: 'NOT_A_DIRECTORY' };
  }

  return { realPath, projectPath: realProjectPath, stat };
}

function parseFileListOffset(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function parseFileListLimit(value: unknown): number {
  const raw = value === undefined || value === null || value === ''
    ? FILE_LIST_DEFAULT_LIMIT
    : Number(value);
  const n = Number.isFinite(raw) ? Math.floor(raw) : FILE_LIST_DEFAULT_LIMIT;
  return Math.min(Math.max(1, n), FILE_LIST_MAX_LIMIT);
}

function isInProject(realPath: string, realProjectPath: string): boolean {
  return realPath === realProjectPath || realPath.startsWith(realProjectPath + path.sep);
}

function getDirectoryEntryInfo(realPath: string, realProjectPath: string, role: string | undefined, dirent: fs.Dirent): FileListEntryInfo {
  if (dirent.isDirectory()) return { isDirectory: true, followTarget: true };
  if (!dirent.isSymbolicLink()) return { isDirectory: false, followTarget: true };
  const full = path.join(realPath, dirent.name);
  let targetRealPath: string;
  try {
    targetRealPath = fs.realpathSync(full);
  } catch {
    return { isDirectory: false, followTarget: false };
  }
  if (role !== 'owner' && !isInProject(targetRealPath, realProjectPath)) {
    return { isDirectory: false, followTarget: false };
  }
  try {
    return { isDirectory: fs.statSync(full).isDirectory(), followTarget: true };
  } catch {
    return { isDirectory: false, followTarget: false };
  }
}

function listDirectory(
  realPath: string,
  options: { offset: number; limit: number; includeHidden: boolean; projectPath: string; role: string | undefined },
): { data: { entries: FileListEntry[]; total: number; offset: number; limit: number; hasMore: boolean } } | { error: string; code: string } {
  const { offset, limit, includeHidden, projectPath, role } = options;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(realPath, { withFileTypes: true });
  } catch (e: any) {
    const code = e?.code === 'EACCES' || e?.code === 'EPERM' ? 'NO_PERMISSION' : 'EXEC_FAILED';
    return { error: `目录读取失败: ${e?.message ?? e}`, code };
  }

  if (!includeHidden) {
    dirents = dirents.filter(d => !d.name.startsWith('.'));
  }

  const entryInfoByName = new Map<string, FileListEntryInfo>();
  for (const dirent of dirents) {
    entryInfoByName.set(dirent.name, getDirectoryEntryInfo(realPath, projectPath, role, dirent));
  }

  dirents.sort((a, b) => {
    const ad = entryInfoByName.get(a.name)?.isDirectory ?? false;
    const bd = entryInfoByName.get(b.name)?.isDirectory ?? false;
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const total = dirents.length;
  const page = dirents.slice(offset, offset + limit);
  const entries: FileListEntry[] = page.map(dirent => {
    const full = path.join(realPath, dirent.name);
    const info = entryInfoByName.get(dirent.name) ?? { isDirectory: false, followTarget: true };
    // Only stat when we need size/mtime (dirent already tells us if it's a directory)
    let size: number | null = null;
    let mtime = 0;
    let birthtime = 0;
    if (!info.isDirectory) {
      try {
        const stat = info.followTarget ? fs.statSync(full) : fs.lstatSync(full);
        size = stat.size;
        mtime = stat.mtimeMs;
        birthtime = stat.birthtimeMs;
      } catch {}
    }
    return {
      name: dirent.name,
      type: info.isDirectory ? 'directory' : 'file',
      size,
      mtime,
      birthtime,
    };
  });

  return {
    data: {
      entries,
      total,
      offset,
      limit,
      hasMore: offset + entries.length < total,
    },
  };
}

const CLI_EXEC_WHITELIST: Record<string, '*' | Set<string>> = {
  status:  '*',
  model:   '*',
  stats:   '*',
  agent:   new Set(['list', 'show', 'get']),
  aid:     new Set(['list', 'show', 'lookup']),
  storage: new Set(['ls', 'quota']),
};

function tokenizeArgv(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function getAvailableEfforts(agent: AgentRunnerFull, model: string): readonly Effort[] {
  if (agent.name === 'claude') {
    return allEfforts;
  }

  if (agent.name === 'codex') {
    return getCodexEfforts(model) as readonly Effort[];
  }

  return [];
}

function modelDisplayLabel(agent: any, model: string): string {
  const full = agent.resolveModelId?.(model);
  return full && full !== model ? `${model} (${full})` : model;
}

function menuStringArg(args: Record<string, any> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

type MenuChatmodeScope = 'agent' | 'relation';
type MenuChatmodeField = 'private' | 'group' | 'nothuman';
type MenuChatmodeValue = 'interactive' | 'proactive';
type MenuDispatchScope = 'agent' | 'relation';
type MenuDispatchValue = 'mention' | 'broadcast';
type MenuPermissionScope = 'agent' | 'relation';
type MenuPermissionValue = typeof PERMISSION_MODE_KEYS[number];
type MenuModelScope = 'agent' | 'relation';
type MenuModelField = 'model' | 'effort';

interface MenuChatmodeTarget {
  scope: MenuChatmodeScope;
  sel: Selector;
  field: MenuChatmodeField;
  fieldPath: `chatmode.${MenuChatmodeField}`;
}

interface MenuDispatchTarget {
  scope: MenuDispatchScope;
  sel: Selector;
  fieldPath: 'dispatch';
}

interface MenuPermissionTarget {
  scope: MenuPermissionScope;
  sel: Selector;
  fieldPath: 'permissionMode';
}

interface MenuModelTarget {
  scope: MenuModelScope;
  sel: Selector;
  baseagent: string;
  field: MenuModelField;
  fieldPath: `baseagents.${string}.${MenuModelField}`;
}

function menuChatmodeScope(args?: Record<string, any>): MenuChatmodeScope | { error: string; code: string } {
  const raw = menuStringArg(args, 'scope') ?? 'agent';
  if (raw === 'agent' || raw === 'relation') return raw;
  return { error: `无效 scope: ${raw}，可选: agent / relation`, code: 'INVALID_SCOPE' };
}

function menuChatmodeField(args: Record<string, any> | undefined, session: Session | null | undefined, explicitChatType?: MenuChatType): MenuChatmodeField | { error: string; code: string } {
  const raw = menuStringArg(args, 'field')
    ?? menuStringArg(args, 'key')
    ?? menuStringArg(args, 'chatType');
  if (raw) {
    const key = raw.startsWith('chatmode.') ? raw.slice('chatmode.'.length) : raw;
    if (key === 'private' || key === 'group' || key === 'nothuman') return key;
    return { error: `无效 chatmode 字段: ${raw}，可选: private / group / nothuman`, code: 'INVALID_FIELD' };
  }
  return ((session?.chatType ?? explicitChatType) === 'group') ? 'group' : 'private';
}

function defaultChatmodeForField(field: MenuChatmodeField): MenuChatmodeValue {
  return field === 'private' ? 'interactive' : 'proactive';
}

function normalizeMenuPeer(input: string): string | { error: string; code: string } {
  try {
    return normalizePeer(input);
  } catch (e: any) {
    return { error: e?.message || String(e), code: e?.code || 'INVALID_PEER' };
  }
}

function resolveMenuChatmodeTarget(this: any, params: {
  args?: Record<string, any>;
  session?: Session | null;
  channel: string;
  channelId: string;
  userId?: string;
  role?: string;
  explicitChatType?: MenuChatType;
  fromControlChannel?: boolean;
}): MenuChatmodeTarget | { error: string; code: string } {
  const scope = menuChatmodeScope(params.args);
  if (typeof scope !== 'string') return scope;

  const field = menuChatmodeField(params.args, params.session, params.explicitChatType);
  if (typeof field !== 'string') return field;

  const explicitSelf = menuStringArg(params.args, 'self')
    ?? menuStringArg(params.args, 'aid');
  const currentSelf = this.getOwningAgent?.(params.channel)?.aid
    ?? params.session?.selfAID
    ?? undefined;
  const self = explicitSelf ?? currentSelf;
  if (!self) return { error: '缺少 self/aid 参数', code: 'MISSING_AID' };
  if (!params.fromControlChannel && explicitSelf && currentSelf && explicitSelf !== currentSelf) {
    return { error: '只能设置当前 agent 的 chatmode', code: 'FORBIDDEN' };
  }

  const sel: Selector = { self, role: params.role };
  if (scope === 'agent') {
    return { scope, sel, field, fieldPath: `chatmode.${field}` };
  }

  const explicitPeer = menuStringArg(params.args, 'peer') ?? menuStringArg(params.args, 'peerKey');
  let peerKey: string | undefined;
  if (explicitPeer) {
    const normalized = normalizeMenuPeer(explicitPeer);
    if (typeof normalized !== 'string') return normalized;
    peerKey = normalized;
  } else {
    const chatType = params.session?.chatType ?? params.explicitChatType ?? 'private';
    const channelType = this.resolveChannelType?.(params.channel) ?? params.session?.channelType;
    const peerKeyId = chatType === 'group'
      ? (params.session?.metadata?.groupId || params.channelId)
      : (params.userId || params.session?.metadata?.peerId || params.channelId);
    if (channelType && peerKeyId) peerKey = formatPeerKey(channelType, peerKeyId);
  }
  if (!peerKey) return { error: 'relation scope 需要 peer/peerKey，或可推导的当前对端', code: 'MISSING_PEER' };

  return { scope, sel: { ...sel, peerKey }, field, fieldPath: `chatmode.${field}` };
}

function readMenuChatmode(target: MenuChatmodeTarget): MenuChatmodeValue {
  try {
    const effective = resolveEffective(target.sel, { cache: true });
    const mode = effective.chatmode?.[target.field];
    return mode === 'interactive' || mode === 'proactive'
      ? mode
      : defaultChatmodeForField(target.field);
  } catch {
    return defaultChatmodeForField(target.field);
  }
}

function writeMenuChatmode(target: MenuChatmodeTarget, value: MenuChatmodeValue): void {
  const route = routeFieldPath(target.fieldPath, target.scope);
  const cur = (cfgRead<Record<string, any>>(route.target, target.sel) as Record<string, any>) || {};
  const block = cur.chatmode && typeof cur.chatmode === 'object' && !Array.isArray(cur.chatmode)
    ? { ...cur.chatmode }
    : {};
  block[target.field] = value;
  cur.chatmode = block;
  cfgWrite(route.target, cur, target.sel);
}

function menuDispatchScope(args?: Record<string, any>): MenuDispatchScope | { error: string; code: string } {
  const raw = menuStringArg(args, 'scope') ?? 'agent';
  if (raw === 'agent' || raw === 'relation') return raw;
  return { error: `无效 scope: ${raw}，可选: agent / relation`, code: 'INVALID_SCOPE' };
}

function resolveMenuDispatchTarget(this: any, params: {
  args?: Record<string, any>;
  session?: Session | null;
  channel: string;
  channelId: string;
  userId?: string;
  role?: string;
  explicitChatType?: MenuChatType;
  fromControlChannel?: boolean;
}): MenuDispatchTarget | { error: string; code: string } {
  const scope = menuDispatchScope(params.args);
  if (typeof scope !== 'string') return scope;

  const explicitSelf = menuStringArg(params.args, 'self')
    ?? menuStringArg(params.args, 'aid');
  const currentSelf = this.getOwningAgent?.(params.channel)?.aid
    ?? params.session?.selfAID
    ?? undefined;
  const self = explicitSelf ?? currentSelf;
  if (!self) return { error: '缺少 self/aid 参数', code: 'MISSING_AID' };
  if (!params.fromControlChannel && explicitSelf && currentSelf && explicitSelf !== currentSelf) {
    return { error: '只能设置当前 agent 的 dispatch', code: 'FORBIDDEN' };
  }

  const sel: Selector = { self, role: params.role };
  if (scope === 'agent') return { scope, sel, fieldPath: 'dispatch' };

  const explicitPeer = menuStringArg(params.args, 'peer') ?? menuStringArg(params.args, 'peerKey');
  let peerKey: string | undefined;
  if (explicitPeer) {
    const normalized = normalizeMenuPeer(explicitPeer);
    if (typeof normalized !== 'string') return normalized;
    peerKey = normalized;
  } else {
    const chatType = params.session?.chatType ?? params.explicitChatType ?? 'private';
    const channelType = this.resolveChannelType?.(params.channel) ?? params.session?.channelType;
    const peerKeyId = chatType === 'group'
      ? (params.session?.metadata?.groupId || params.channelId)
      : (params.userId || params.session?.metadata?.peerId || params.channelId);
    if (channelType && peerKeyId) peerKey = formatPeerKey(channelType, peerKeyId);
  }
  if (!peerKey) return { error: 'relation scope 需要 peer/peerKey，或可推导的当前对端', code: 'MISSING_PEER' };

  return { scope, sel: { ...sel, peerKey }, fieldPath: 'dispatch' };
}

function readMenuDispatch(target: MenuDispatchTarget, fallback: MenuDispatchValue | null = null): MenuDispatchValue | null {
  try {
    const mode = resolveEffective(target.sel, { cache: true }).dispatch;
    return mode === 'mention' || mode === 'broadcast' ? mode : fallback;
  } catch {
    return fallback;
  }
}

function writeMenuDispatch(target: MenuDispatchTarget, value: MenuDispatchValue | null): void {
  const route = routeFieldPath(target.fieldPath, target.scope);
  const cur = (cfgRead<Record<string, any>>(route.target, target.sel) as Record<string, any>) || {};
  if (value === null) delete cur.dispatch;
  else cur.dispatch = value;
  cfgWrite(route.target, cur, target.sel);
}

function menuPermissionScope(args?: Record<string, any>): MenuPermissionScope | { error: string; code: string } {
  const raw = menuStringArg(args, 'scope') ?? 'relation';
  if (raw === 'agent' || raw === 'relation') return raw;
  return { error: `无效 scope: ${raw}，可选: agent / relation`, code: 'INVALID_SCOPE' };
}

function resolveMenuPermissionTarget(this: any, params: {
  args?: Record<string, any>;
  session?: Session | null;
  channel: string;
  channelId: string;
  userId?: string;
  role?: string;
  explicitChatType?: MenuChatType;
  fromControlChannel?: boolean;
}): MenuPermissionTarget | { error: string; code: string } {
  const scope = menuPermissionScope(params.args);
  if (typeof scope !== 'string') return scope;

  const explicitSelf = menuStringArg(params.args, 'self')
    ?? menuStringArg(params.args, 'aid');
  const currentSelf = this.getOwningAgent?.(params.channel)?.aid
    ?? params.session?.selfAID
    ?? undefined;
  const self = explicitSelf ?? currentSelf;
  if (!self) return { error: '缺少 self/aid 参数', code: 'MISSING_AID' };
  if (!params.fromControlChannel && explicitSelf && currentSelf && explicitSelf !== currentSelf) {
    return { error: '只能设置当前 agent 的 permission', code: 'FORBIDDEN' };
  }

  const sel: Selector = { self, role: params.role };
  if (scope === 'agent') return { scope, sel, fieldPath: 'permissionMode' };

  const explicitPeer = menuStringArg(params.args, 'peer') ?? menuStringArg(params.args, 'peerKey');
  let peerKey: string | undefined;
  if (explicitPeer) {
    const normalized = normalizeMenuPeer(explicitPeer);
    if (typeof normalized !== 'string') return normalized;
    peerKey = normalized;
  } else {
    const chatType = params.session?.chatType ?? params.explicitChatType ?? 'private';
    const channelType = this.resolveChannelType?.(params.channel) ?? params.session?.channelType;
    const peerKeyId = chatType === 'group'
      ? (params.session?.metadata?.groupId || params.channelId)
      : (params.userId || params.session?.metadata?.peerId || params.channelId);
    if (channelType && peerKeyId) peerKey = formatPeerKey(channelType, peerKeyId);
  }
  if (!peerKey) return { error: 'relation scope 需要 peer/peerKey，或可推导的当前对端', code: 'MISSING_PEER' };

  return { scope, sel: { ...sel, peerKey }, fieldPath: 'permissionMode' };
}

function isMenuPermissionValue(value: string | undefined): value is MenuPermissionValue {
  return !!value && (PERMISSION_MODE_KEYS as readonly string[]).includes(value);
}

function readMenuPermission(target: MenuPermissionTarget): MenuPermissionValue {
  try {
    const mode = resolveEffective(target.sel, { cache: true }).permissionMode;
    if (isMenuPermissionValue(mode)) return mode;
  } catch {}
  const fallback = resolvePermissionMode(target.sel);
  return isMenuPermissionValue(fallback) ? fallback : 'auto';
}

function writeMenuPermission(target: MenuPermissionTarget, value: MenuPermissionValue): void {
  const route = routeFieldPath(target.fieldPath, target.scope);
  const cur = (cfgRead<Record<string, any>>(route.target, target.sel) as Record<string, any>) || {};
  cur.permissionMode = value;
  cfgWrite(route.target, cur, target.sel);
}

function menuModelScope(args?: Record<string, any>): MenuModelScope | { error: string; code: string } {
  const raw = menuStringArg(args, 'scope') ?? 'agent';
  if (raw === 'agent' || raw === 'relation') return raw;
  return { error: `无效 scope: ${raw}，可选: agent / relation`, code: 'INVALID_SCOPE' };
}

function resolveMenuModelTarget(this: any, params: {
  args?: Record<string, any>;
  session?: Session | null;
  channel: string;
  channelId: string;
  userId?: string;
  role?: string;
  explicitChatType?: MenuChatType;
  fromControlChannel?: boolean;
  field: MenuModelField;
}): MenuModelTarget | { error: string; code: string } {
  const scope = menuModelScope(params.args);
  if (typeof scope !== 'string') return scope;

  const explicitSelf = menuStringArg(params.args, 'self')
    ?? menuStringArg(params.args, 'aid');
  const currentAgent = this.getOwningAgent?.(params.channel) ?? null;
  const requestedAgent = explicitSelf
    ? (this.agentRegistry?.get?.(explicitSelf) ?? null)
    : null;
  const currentSelf = currentAgent?.aid
    ?? params.session?.selfAID
    ?? undefined;
  const self = explicitSelf ?? currentSelf;
  if (!self) return { error: '缺少 self/aid 参数', code: 'MISSING_AID' };
  if (!params.fromControlChannel && explicitSelf && currentSelf && explicitSelf !== currentSelf) {
    return { error: '只能设置当前 agent 的 model/effort', code: 'FORBIDDEN' };
  }

  const baseagent = menuStringArg(params.args, 'baseagent')
    ?? params.session?.baseagent
    ?? (params.session as any)?.agentId
    ?? requestedAgent?.baseagent
    ?? currentAgent?.baseagent
    ?? this.parseDefaultBaseagent?.();
  if (!baseagent) return { error: '缺少 baseagent 参数', code: 'MISSING_BASEAGENT' };

  const sel: Selector = { self, role: params.role };
  if (scope === 'agent') {
    return { scope, sel, baseagent, field: params.field, fieldPath: `baseagents.${baseagent}.${params.field}` };
  }

  const explicitPeer = menuStringArg(params.args, 'peer') ?? menuStringArg(params.args, 'peerKey');
  let peerKey: string | undefined;
  if (explicitPeer) {
    const normalized = normalizeMenuPeer(explicitPeer);
    if (typeof normalized !== 'string') return normalized;
    peerKey = normalized;
  } else {
    const chatType = params.session?.chatType ?? params.explicitChatType ?? 'private';
    const channelType = this.resolveChannelType?.(params.channel) ?? params.session?.channelType;
    const peerKeyId = chatType === 'group'
      ? (params.session?.metadata?.groupId || params.channelId)
      : (params.userId || params.session?.metadata?.peerId || params.channelId);
    if (channelType && peerKeyId) peerKey = formatPeerKey(channelType, peerKeyId);
  }
  if (!peerKey) return { error: 'relation scope 需要 peer/peerKey，或可推导的当前对端', code: 'MISSING_PEER' };

  return { scope, sel: { ...sel, peerKey }, baseagent, field: params.field, fieldPath: `baseagents.${baseagent}.${params.field}` };
}

function readMenuModel(target: MenuModelTarget, agent: any): { value: string | null; source: string | null } {
  try {
    const resolved = resolveEffectiveModel(target.sel, target.baseagent);
    const value = target.field === 'model' ? resolved.model : resolved.effort;
    const source = target.field === 'model' ? resolved.source : resolved.effortSource;
    if (value && source) return { value, source };
  } catch {}

  const fallback = target.field === 'model'
    ? (typeof agent?.getModel === 'function' ? agent.getModel() : agent?.name)
    : (typeof agent?.getEffort === 'function' ? agent.getEffort() : undefined);
  return { value: fallback ?? null, source: null };
}

function writeMenuModel(target: MenuModelTarget, value: string | null): void {
  if (target.field === 'model') {
    writeScope(target.scope, target.sel, target.baseagent, { model: value });
  } else {
    writeScope(target.scope, target.sel, target.baseagent, { effort: value });
  }
}

export function isProcessLevelOwner(peerId: string | undefined, owners: string[] | undefined): boolean {
  if (!peerId) return false;
  return (owners ?? []).includes(peerId);
}

// ── 控制面双轨鉴权（见 docs/.../2026-06-10-control-channel-auth-design.md）──
// 白名单而非黑名单：默认安全，新增进程级 action 需显式加入。
/** /agent 的进程级 action：仅控制 channel 可执行。 */
export const PROCESS_LEVEL_AGENT_ACTIONS = new Set(['create', 'delete', 'enable', 'disable']);
/** /agent 的「本 agent 自管理」action：agent channel 仅 owner/admin 可对自身 aid 执行；update 另行收紧为 owner。 */
export const SELF_MANAGE_AGENT_ACTIONS = new Set(['update', 'reload']);

/** 判断 (cmdBase, action) 是否为进程级操作（仅控制 channel 可执行）。
 *  /system 全部进程级；/agent 仅 create/delete/enable/disable 进程级；其余关系级。 */
export function isProcessLevelAction(cmdBase: string, action?: string): boolean {
  if (cmdBase === '/system') return true;
  if (cmdBase === '/gateway') return true;  // 网关改 baseagent 凭证，进程级，仅控制 channel
  if (cmdBase === '/config') return true;  // 配置查询/修改，进程级，仅控制 channel
  if (cmdBase === '/agent') return PROCESS_LEVEL_AGENT_ACTIONS.has(action ?? '');
  return false;
}

/** 控制面作用域闸门：在每个 exec 入口算出 cmdBase/action 后调用。
 *  闸1 进程级 action：仅控制 channel。
 *  闸2 跨 agent 寻址（args.aid ≠ 自身）：仅控制 channel。
 *  命中返回 FORBIDDEN 结果，否则返回 null（放行，后续走原有 owner/role 鉴权）。 */
function gateControlScope(
  this: any,
  opts: { cmdBase: string; action?: string; args?: Record<string, any>; channel: string; fromControlChannel: boolean },
): { error: string; code: string } | null {
  const { cmdBase, action, args, channel, fromControlChannel } = opts;
  if (fromControlChannel) return null;
  if (isProcessLevelAction(cmdBase, action)) {
    return { error: '此操作仅允许通过控制 AID channel 执行', code: 'FORBIDDEN' };
  }
  const targetAid = args?.aid;
  if (targetAid) {
    const currentAgentAid = this.getOwningAgent?.(channel)?.aid;
    if (targetAid !== currentAgentAid) {
      return { error: '跨 agent 操作仅允许通过控制 AID channel 执行', code: 'FORBIDDEN' };
    }
  }
  return null;
}

function buildMenuIntent(
  verb: 'query' | 'update' | 'action',
  cmdBase: string,
  args?: Record<string, any>,
  action?: string,
  value?: unknown,
  fromControlChannel = false,
): CommandIntent | null {
  const payload = { ...(args ?? {}), ...(value !== undefined ? { value } : {}) };
  const intent = (operation: string, scope: CommandScope = 'relation', extra?: Record<string, unknown>): CommandIntent => ({
    operation,
    scope,
    source: 'menu',
    args: { ...payload, ...(extra ?? {}) },
  });
  const modelScope = args?.scope === 'relation' ? 'relation' : 'agent';

  if (verb === 'query') {
    if (cmdBase === '/model') return intent('model.current', modelScope);
    if (cmdBase === '/effort') return intent('model.current', modelScope);
    if (cmdBase === '/gateway') return intent('gateway.read', 'process');
    if (cmdBase === '/config') return intent('config.read', 'process');
    if (cmdBase === '/system') return intent('system.status', 'process');
    if (cmdBase === '/agent') {
      return intent(fromControlChannel && !args?.aid ? 'agent.list' : 'agent.show', fromControlChannel ? 'control' : 'agent');
    }
  }

  if (verb === 'update') {
    if (cmdBase === '/model') return intent('model.use', modelScope, { model: value });
    if (cmdBase === '/effort') return intent('model.effort', modelScope, { effort: value });
    if (cmdBase === '/gateway') return intent('gateway.write', 'process');
    if (cmdBase === '/config') return intent('config.write', 'process');
  }

  if (verb === 'action') {
    if (cmdBase === '/file') {
      if (action === 'list') return intent('file.list', 'filesystem');
      if (action === 'fetch') return intent('file.fetch', 'filesystem');
    }
    if (cmdBase === '/gateway') return intent('gateway.write', 'process', { action });
    if (cmdBase === '/system') {
      if (action === 'restart') return intent('system.restart', 'process', { action });
      if (action === 'upgrade') return intent('system.upgrade', 'process', { action });
      if (action === 'check') return intent('system.status', 'process', { action });
    }
    if (cmdBase === '/agent') {
      if (action === 'reload') return intent('agent.reload', fromControlChannel ? 'control' : 'agent', { action });
      if (action === 'create') return intent('agent.create', 'control', { action });
      if (action === 'delete' || action === 'disable') return intent('agent.delete', 'control', { action });
    }
  }

  return null;
}

function buildRelationIntentArgs(params: {
  args?: Record<string, any>;
  selfAid?: string;
  peerKey?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(params.args ?? {}) };
  if (params.selfAid && out.self === undefined) out.self = params.selfAid;
  if (params.peerKey && out.peer === undefined && out.peerKey === undefined) out.peer = params.peerKey;
  return out;
}

function buildMenuAuthContext(
  owner: any,
  params: {
    intent: CommandIntent;
    identity: import('../../types.js').SessionIdentity;
    session?: Session | null;
    explicitChatType?: MenuChatType;
    channel: string;
    channelId: string;
    userId?: string;
    source: 'menu' | 'menu.cli';
    fromControlChannel: boolean;
  },
): CommandAuthorizationContext {
  const agent = owner.getOwningAgent?.(params.channel);
  const selfAid = agent?.aid || params.session?.selfAID;
  const channelType = owner.resolveChannelType?.(params.channel) || params.session?.channelType;
  const chatType = (params.session?.chatType as 'private' | 'group' | undefined) ?? params.explicitChatType;
  const peerKeyId = chatType === 'group'
    ? (params.session?.metadata?.groupId || params.channelId)
    : params.userId;
  const peerKey = channelType && peerKeyId ? formatPeerKey(channelType, peerKeyId) : undefined;
  const isDaemonOwner = isProcessLevelOwner(params.userId, loadEvolclawConfig().owners);

  return {
    intent: params.intent,
    actorId: params.userId,
    channel: params.channel,
    channelId: params.channelId,
    chatType,
    selfAid,
    peerKey,
    role: params.identity.role,
    isDaemonOwner,
    fromControlChannel: params.fromControlChannel,
    source: params.source,
  };
}

function authorizeMenuContext(authCtx: CommandAuthorizationContext): ReturnType<typeof authorizeCommand> {
  return authorizeCommand(authCtx);
}

async function authorizeMenuIntent(
  this: any,
  params: {
    intent: CommandIntent | null;
    identity: import('../../types.js').SessionIdentity;
    session?: Session | null;
    explicitChatType?: MenuChatType;
    channel: string;
    channelId: string;
    userId?: string;
    fromControlChannel: boolean;
  },
): Promise<{ error: string; code?: string } | null> {
  const { intent, identity, session, channel, channelId, userId, fromControlChannel } = params;
  if (!intent) return null;

  const authCtx = buildMenuAuthContext(this, {
    intent,
    identity,
    session,
    explicitChatType: params.explicitChatType,
    channel,
    channelId,
    userId,
    source: 'menu',
    fromControlChannel,
  });
  if (authCtx.intent.scope === 'relation') {
    authCtx.intent.args = buildRelationIntentArgs({
      args: authCtx.intent.args as Record<string, any>,
      selfAid: authCtx.selfAid,
      peerKey: authCtx.peerKey,
    });
  }

  const decision = authorizeMenuContext(authCtx);
  if (!decision.allow) {
    await auditCommandAuthorization({
      ts: Date.now(),
      source: 'menu',
      operation: intent.operation,
      scope: intent.scope,
      dangerous: intent.dangerous ?? false,
      actorId: userId,
      selfAid: authCtx.selfAid,
      peerKey: authCtx.peerKey,
      channel,
      channelId,
      role: identity.role,
      isDaemonOwner: authCtx.isDaemonOwner,
      fromControlChannel,
      decision: 'deny',
      code: decision.code,
      reason: decision.reason,
      matchedRule: decision.matchedRule,
      argsSummary: intent.args,
    });
    return { error: decision.reason, code: decision.code };
  }

  if (decision.dangerous) {
    await auditCommandAuthorization({
      ts: Date.now(),
      source: 'menu',
      operation: intent.operation,
      scope: intent.scope,
      dangerous: true,
      actorId: userId,
      selfAid: authCtx.selfAid,
      peerKey: authCtx.peerKey,
      channel,
      channelId,
      role: identity.role,
      isDaemonOwner: authCtx.isDaemonOwner,
      fromControlChannel,
      decision: 'allow',
      matchedRule: decision.matchedRule,
      argsSummary: intent.args,
    });
  }

  return null;
}


function ecwebErr(id: string, name: string | undefined, code: string, message: string): import('../../types.js').MenuResponse {
  return { type: 'menu.response', id, ...(name ? { name } : {}), error: { code, message } };
}

function ecwebResp(id: string, name: string | undefined, result: { data: any } | { error: string; code?: string }): import('../../types.js').MenuResponse {
  return 'error' in result
    ? { type: 'menu.response', id, ...(name ? { name } : {}), error: { code: result.code ?? 'EXEC_FAILED', message: result.error } }
    : { type: 'menu.response', id, ...(name ? { name } : {}), data: result.data };
}

function parseScheduleDurationMs(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = parseDuration(value);
  return parsed ?? Number.NaN;
}

export function validateScheduleParams(scheduleType: string, scheduleValue: string): string | null {
  if (!['once', 'delay', 'at', 'cron', 'interval', 'event'].includes(scheduleType)) {
    return `无效 scheduleType: ${scheduleType}（可选: once / delay / at / cron / interval / event）`;
  }
  if (scheduleType === 'once') return null;
  if (scheduleType === 'delay' || scheduleType === 'interval') {
    const ms = parseScheduleDurationMs(scheduleValue);
    if (!Number.isFinite(ms) || ms <= 0) return `${scheduleType} 的 scheduleValue 需为正数时长（如 30s / 15m / 2h / 1d）: ${scheduleValue}`;
  } else if (scheduleType === 'at') {
    const ts = new Date(scheduleValue).getTime();
    if (!Number.isFinite(ts)) return `at 的 scheduleValue 需为合法时间: ${scheduleValue}`;
  } else if (scheduleType === 'cron') {
    try { CronExpressionParser.parse(scheduleValue); }
    catch { return `无效 cron 表达式: ${scheduleValue}`; }
  } else if (!scheduleValue) {
    return 'event 的 scheduleValue 不能为空';
  }
  return null;
}

/**
 * 返回结构化命令菜单（供 menu.query 使用）
 * owner 看到全部命令，admin 看到管理级命令（不含 owner-only），visitor/member 仅看到用户级命令
 */
export function getMenuItems(this: any, role: string, chatType: string = 'private', scope: 'agent' | 'control' = 'agent'): { group: string; commands: MenuItem[] }[] {
  const isOwner = role === 'owner';
  const isAdmin = role === 'owner' || role === 'admin';
  const isControlScope = scope === 'control';
  const canReadTopic = role !== 'none';
  const items: { group: string; commands: MenuItem[] }[] = [];

  if (!isAdmin && chatType === 'group') {
    return [
      ...(canReadTopic ? [{
        group: '话题管理',
        commands: [
          { cmd: '/topic', label: '话题管理', desc: '查看当前聊天的话题会话', next: { type: 'select' as const, dynamic: true } },
        ]
      }] : []),
      {
        group: '其他',
        commands: [
          { cmd: '/status', label: '显示会话状态' },
          { cmd: '/check', label: '检查 EvolAgent 实例健康' },
          { cmd: '/help', label: '显示帮助信息' },
        ]
      }
    ];
  }

  items.push({
    group: '会话管理',
    commands: [
      { cmd: '/new', label: '创建新会话', desc: '清空历史，开始全新对话', next: { type: 'text' as const } },
      { cmd: '/s', label: '切换会话', desc: '切换到同项目下的其他会话', next: { type: 'select', dynamic: true } },
      ...(canReadTopic ? [{ cmd: '/topic', label: '话题管理', desc: '查看与管理当前聊天的话题会话', next: { type: 'select' as const, dynamic: true } }] : []),
      { cmd: '/name', label: '重命名当前会话', desc: '为当前会话设置一个易识别的名称', next: { type: 'text' as const } },
      { cmd: '/del', label: '删除指定会话', desc: '永久删除一个非活跃会话', next: { type: 'select', dynamic: true } },
      ...(isAdmin ? [
        { cmd: '/fork', label: '分支当前会话', desc: '基于当前会话创建独立分支', next: { type: 'text' as const } },
        { cmd: '/rewind', label: '查看历史/撤销指定轮次', desc: '回退会话到指定轮次，可选择撤销文件改动' },
        { cmd: '/compact', label: '压缩会话上下文', desc: '将长对话压缩为摘要以节省 token' },
      ] : []),
    ]
  });

  if (isAdmin) {
    items.push({
      group: 'Agent 与模型',
      commands: [
        { cmd: '/baseagent', label: '切换 Agent 后端', desc: '切换 Agent 当前 Baseagent', next: { type: 'select', dynamic: true } },
        { cmd: '/model', label: '切换模型', desc: '切换当前 Agent 使用的模型版本', next: { type: 'select', dynamic: true } },
        { cmd: '/effort', label: '切换推理强度', desc: '调整模型推理深度，影响响应速度与质量', next: { type: 'select', items: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' },
        ] } },
        { cmd: '/chatmode', label: '切换会话模式', desc: '控制 Agent 主动性（被动响应或主动推进）', next: { type: 'select', items: [
          { value: 'interactive', label: '交互模式', desc: '仅在收到消息时响应' },
          { value: 'proactive', label: '主动模式', desc: 'Agent 可主动推进任务' },
        ] } },
        { cmd: '/dispatch', label: '切换分发模式', desc: '控制群聊消息过滤（仅@提及或广播响应）', next: { type: 'select', items: [
          { value: 'mention', label: '@ 提及', desc: '仅在被 @ 提及时响应' },
          { value: 'broadcast', label: '广播', desc: '响应群内所有消息' },
        ] } },
        { cmd: '/capability', label: '能力开关管理', desc: '查看并管理 Skills / MCP / Plugins' },
      ]
    });

    items.push({
      group: '权限管理',
      commands: [
        { cmd: '/perm', label: '权限模式管理', desc: '控制工具调用的审批策略', next: { type: 'select', items: [
          { value: 'auto', label: '自动模式', desc: '根据风险等级自动决定是否审批' },
          { value: 'bypass', label: '免审批模式', desc: '普通操作自动放行，危险操作仍需确认' },
          { value: 'readonly', label: '只读模式', desc: '允许读取和临时目录写入，拒绝项目文件修改' },
          { value: 'plan', label: '计划模式', desc: '仅允许只读操作，写操作需审批' },
          { value: 'edit', label: '编辑模式', desc: '允许文件编辑，其他操作需审批' },
          { value: 'request', label: '请求模式', desc: '所有操作均需审批' },
          { value: 'noask', label: '静默模式', desc: '不弹出审批，自动拒绝未授权操作' },
          { value: 'allow', label: '允许此操作', desc: '本次允许当前待审批操作' },
          { value: 'always', label: '始终允许', desc: '永久允许同类操作' },
          { value: 'deny', label: '拒绝此操作', desc: '拒绝当前待审批操作' },
        ] } },
      ]
    });

    items.push({
      group: '运维',
      commands: [
        { cmd: '/status', label: '显示会话状态', desc: '查看当前会话、项目、Agent 的详细状态' },
        { cmd: '/stop', label: '中断当前任务', desc: '立即中断正在执行的 Agent 任务' },
        { cmd: '/check', label: '检查 EvolAgent 实例健康', desc: '检查各 EvolAgent 实例、后端与消息通道的健康状态' },
        { cmd: '/activity', label: '控制中间输出显示', desc: '设置工具调用过程的可见范围', next: { type: 'select', items: [
          { value: 'all', label: '全部显示', desc: '所有用户均可见中间输出' },
          { value: 'none', label: '不显示', desc: '关闭所有中间输出' },
        ] } },
        ...(isControlScope && isOwner ? [
          { cmd: '/restart', label: '重启服务', desc: '重启整个 EvolClaw 服务进程' },
        ] : []),
        ...(isAdmin ? [
          { cmd: '/file', label: '发送项目内文件', desc: '将项目目录内的文件发送给用户' },
        ] : []),
      ]
    });
  } else {
    items.push({
      group: '其他',
      commands: [
        { cmd: '/status', label: '显示会话状态', desc: '查看当前会话的基本状态' },
        { cmd: '/check', label: '检查 EvolAgent 实例健康', desc: '检查 EvolAgent 实例与消息通道健康状态' },
      ]
    });
  }

  items.push({
    group: '帮助',
    commands: [
      { cmd: '/help', label: '显示帮助信息', desc: '列出所有可用命令及说明' },
    ]
  });

  return items;
}

/** 动态子菜单：根据 cmd 路径返回选项列表（供 menu.query + cmd 使用） */
export async function getSubMenuItems(this: any, cmd: string, channel: string, channelId: string, userId?: string, args?: Record<string, any>, overrideIdentity?: import('../../types.js').SessionIdentity, explicitChatType?: MenuChatType, fromControlChannel = false): Promise<MenuItem[] | null> {
  const session = await this.sessionManager.getActiveSession(channel, channelId);

  const cmdBase0 = cmd.trim().split(' ')[0];
  const gated0 = gateControlScope.call(this, { cmdBase: cmdBase0, args, channel, fromControlChannel });
  if (gated0) throw { code: gated0.code, message: gated0.error };

  // ── /agent list（只读） ──
  // 控制 channel：验 evolclaw.owners，返回全量；agent channel：放行但仅返回自身单条。
  if (cmd === '/agent') {
    if (fromControlChannel) {
      if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
        throw { code: 'FORBIDDEN', message: '操作需要 owner 权限' };
      }
      const res = await execAgentOptions(args);
      if ('error' in res) throw { code: res.code, message: res.error };
      return (res.data.agents as any[]).map(ag => ({ value: ag.aid, label: ag.name || ag.aid, desc: ag.status }));
    }
    // agent channel：作用域绑定自身，仅返回自身单条
    const selfAid = this.getOwningAgent?.(channel)?.aid;
    if (!selfAid) throw { code: 'FORBIDDEN', message: '当前 channel 无绑定 agent' };
    const res = await execAgentOptions(args);
    if ('error' in res) throw { code: res.code, message: res.error };
    return (res.data.agents as any[])
      .filter(ag => ag.aid === selfAid)
      .map(ag => ({ value: ag.aid, label: ag.name || ag.aid, desc: ag.status }));
  }

  if (cmd === '/capability') {
    const type = args?.type;
    if (!isCapabilityType(type)) {
      throw { code: type ? 'INVALID_TYPE' : 'INVALID_ARGS', message: 'args.type 必须是 skill / mcp / plugin' };
    }
    const target = resolveCapabilityTarget.call(this, { channel, args, session, fromControlChannel });
    if ('error' in target) throw { code: target.code, message: target.error };
    const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
    const options = await listCapabilityOptions(target.ctx, target.config, type) as any[];
    return sanitizeCapabilityOptionsForRole(options, identity.role);
  }

  // ── 关系级 /trigger list（每个 trigger 一个 MenuItem） ──
  if (cmd === '/trigger') {
    const triggerScheduler = this.getTriggerSchedulerForChannel?.(channel);
    const scope = args?.options === 'all' ? 'all' : 'enabled';
    const role = (overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId)).role;
    const isAdmin = role === 'owner' || role === 'admin';
    if (!triggerScheduler) return [];
    const list = triggerScheduler.list({ all: scope === 'all' });
    return list
      .filter((definition: any) => this.canAccessTriggerDefinition(definition, userId ?? '', channel, isAdmin))
      .map((definition: any) => {
        const view = this.definitionToTriggerView(definition, triggerScheduler);
        return {
          ...view,
          value: definition.id,
          label: definition.name,
          desc: `${view.scheduleType}${view.nextFireAt ? ` | 下次 ${new Date(view.nextFireAt).toLocaleString()}` : ''}`,
          status: definition.enabled ? 'active' : 'disabled',
        };
      });
  }

  if (cmd === '/topic') {
    const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
    if (!this.canReadTopics(identity.role)) {
      throw { code: 'FORBIDDEN', message: '无权限查看话题' };
    }
    const sessions = await this.sessionManager.listSessions(channel, channelId);
    return sessions
      .filter((s: Session) => !!s.threadId)
      .map((s: Session) => this.buildTopicMenuItem(s));
  }

  if (cmd === '/s' || cmd === '/session' || cmd === '/del') {
    const sessions = await this.sessionManager.listSessions(channel, channelId);
    const active = cmd === '/del' ? await this.sessionManager.getActiveSession(channel, channelId) : null;
    const currentSession = session;
    const items: MenuItem[] = sessions
      .filter((s: Session) => !s.threadId)
      .filter((s: Session) => !active || s.id !== active.id)
      .map((s: Session) => {
        const displayName = displaySessionTitle(s.name, s.id.slice(0, 8));
        const item: MenuItem = {
          value: s.name || s.id.slice(0, 8),
          label: displayName,
          selected: currentSession ? s.id === currentSession.id : false,
        };
        if (s.agentSessionId) {
          item.agentSessionId = s.agentSessionId;
          const fileInfo = this.sessionManager.getSessionFileInfo(s.projectPath, s.agentSessionId, s.baseagent);
          if (fileInfo.turns) item.turns = fileInfo.turns;
          const firstMsg = this.sessionManager.readSessionFirstMessage(s.projectPath, s.agentSessionId, s.baseagent);
          if (firstMsg) item.preview = firstMsg.length > 80 ? firstMsg.slice(0, 80) + '…' : firstMsg;
        }
        if (s.updatedAt) item.lastActive = s.updatedAt;
        return item;
      });
    if (cmd === '/s' || cmd === '/session') {
      items.push({ value: 'cli', label: '查看 CLI 会话', desc: '列出未导入的 CLI 本地会话' });
    }
    return items;
  }

  if (cmd === '/baseagent') {
    const requestedAgent = typeof args?.aid === 'string'
      ? (this.agentRegistry?.get?.(args.aid) ?? null)
      : null;
    const currentAgent = requestedAgent?.baseagent
      ?? this.agentRegistry?.resolveByChannel(channel)?.baseagent
      ?? this.parseDefaultBaseagent?.();
    const available = requestedAgent?.name
      ? (this.getAvailableBaseagentsForOwner?.(requestedAgent.name) ?? [])
      : this.getAvailableBaseagents(channel);
    return available.map((name: string) => ({ value: name, label: name, selected: name === currentAgent }));
  }

  if (cmd === '/model') {
    const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
    const target = resolveMenuModelTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
      field: 'model',
    });
    if ('error' in target) throw { code: target.code, message: target.error };
    const agent = this.getAgent(channel, target.baseagent);
    if (hasModelSwitcher(agent) && agent.listModels) {
      const role = identity.role;
      const authIntent: CommandIntent = {
        operation: 'model.list',
        scope: target.scope,
        source: 'menu',
        args: {},
      };
      const authCtx = buildMenuAuthContext(this, {
        intent: authIntent,
        identity,
        session,
        explicitChatType,
        channel,
        channelId,
        userId,
        source: 'menu',
        fromControlChannel,
      });
      authIntent.args = target.scope === 'relation'
        ? buildRelationIntentArgs({ args, selfAid: target.sel.self, peerKey: target.sel.peerKey })
        : { ...(args ?? {}), self: target.sel.self };
      const decision = authorizeMenuContext(authCtx);
      if (!decision.allow) throw { code: decision.code, message: decision.reason };

      const rawModels = await agent.listModels() ?? [];
      const models = filterModelsForRole(role, target.baseagent, rawModels, (agent as any).resolveModelId?.bind(agent));
      const requestedModel = menuStringArg(args, 'model') ?? menuStringArg(args, 'current');
      const currentModel = requestedModel || readMenuModel(target, agent).value || agent.getModel();
      if (models.length > 0) return models.map((m: string) => ({ value: m, label: modelDisplayLabel(agent, m), selected: modelMatches(agent, m, currentModel) }));
    }
    return null;
  }

  // if (cmd === '/restart') {
  //   const isOwner = userId ? this.sessionManager.resolveIdentity(channel, userId).role === 'owner' : false;
  //   // 列出所有 channel type
  //   const visibleTypes = new Set<string>();
  //   for (const [name] of this.adapters) {
  //     const t = this.channelTypeMap.get(name);
  //     if (t) visibleTypes.add(t);
  //   }
  //   const channels = [...visibleTypes].map(type => ({ value: type, label: type, desc: '重连此类型所有渠道实例' }));
  //   if (isOwner) channels.unshift({ value: '', label: '重启服务', desc: '重启整个 EvolClaw 服务进程' });
  //   return channels;
  // }

  if (cmd === '/activity') {
    const currentMode = this.agentRegistry?.getShowActivities?.(channel) ?? 'all';
    return [
      { value: 'all', label: '私聊显示', selected: currentMode === 'all' },
      { value: 'none', label: '全部静默', selected: currentMode === 'none' },
    ];
  }

  if (cmd === '/effort') {
    const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
    const target = resolveMenuModelTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
      field: 'effort',
    });
    if ('error' in target) throw { code: target.code, message: target.error };
    const agent = this.getAgent(channel, target.baseagent);
    const requestedModel = menuStringArg(args, 'model') ?? menuStringArg(args, 'currentModel');
    const modelTarget: MenuModelTarget = { ...target, field: 'model', fieldPath: `baseagents.${target.baseagent}.model` };
    const currentModel = requestedModel || (hasModelSwitcher(agent) ? (readMenuModel(modelTarget, agent).value || agent.getModel()) : agent.name);
    const efforts = getAvailableEfforts(agent, currentModel);
    const currentEffort = menuStringArg(args, 'effort') ?? menuStringArg(args, 'current') ?? readMenuModel(target, agent).value ?? 'auto';
    const allItems = [...efforts, 'auto'] as string[];
    return allItems.map(e => ({ value: e, label: e === 'auto' ? 'auto (SDK默认)' : e, selected: e === currentEffort }));
  }

  if (cmd === '/chatmode') {
    const target = resolveMenuChatmodeTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: (overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId)).role,
      explicitChatType,
      fromControlChannel,
    });
    if ('error' in target) throw { code: target.code, message: target.error };
    const currentMode = readMenuChatmode(target);
    return [
      { value: 'interactive', label: '交互模式', selected: currentMode === 'interactive' },
      { value: 'proactive', label: '主动模式', selected: currentMode === 'proactive' },
    ];
  }

  if (cmd === '/dispatch') {
    const target = resolveMenuDispatchTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: (overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId)).role,
      explicitChatType,
      fromControlChannel,
    });
    if ('error' in target) throw { code: target.code, message: target.error };
    const fallback = session?.metadata?.dispatchMode === 'mention' || session?.metadata?.dispatchMode === 'broadcast'
      ? session.metadata.dispatchMode
      : null;
    const currentMode = readMenuDispatch(target, fallback);
    return [
      { value: 'mention', label: '@提及时响应', selected: currentMode === 'mention' },
      { value: 'broadcast', label: '所有消息响应', selected: currentMode === 'broadcast' },
    ];
  }

  if (cmd === '/perm') {
    const target = resolveMenuPermissionTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: (overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId)).role,
      explicitChatType,
      fromControlChannel,
    });
    if ('error' in target) throw { code: target.code, message: target.error };
    const currentMode = readMenuPermission(target);
    const permAgent = this.getAgent(channel, session?.baseagent);
    const validModes = hasPermissionController(permAgent)
      ? permAgent.listModes().filter(m => m.available).map(m => m.key)
      : [...PERMISSION_MODE_KEYS];
    return validModes.map(m => ({ value: m, label: m, selected: m === currentMode }));
  }

  return null;
}

// ── Menu Protocol exec ────────────────────────────────────────────────
//
// 三个入口对应 menu.query / menu.update / menu.action：
//   execMenuQuery  — 查询某项当前值（无会话时多数 fallback 到 evolagent config）
//   execMenuUpdate — 写入新值（持久化到 session 或 evolagent config）
//   execMenuAction — 触发动词（stop/restart/new/delete/compact/fork/switch/check/upgrade）
//
// 所有方法返回 { data } 或 { error, code? }。code 是结构化错误码（NO_ACTIVE_SESSION 等），
// 客户端可据此决定降级策略。message-bridge 把 code 透传到 menu.response。

/** menu.query — 查询当前值。 */
export async function execMenuQuery(this: any,
  cmd: string, channel: string, channelId: string, userId?: string, args?: Record<string, any>, explicitChatType?: MenuChatType, fromControlChannel = false, overrideIdentity?: import('../../types.js').SessionIdentity
): Promise<{ data: any } | { error: string; code?: string }> {
  const cmdBase = cmd.trim().split(' ')[0];
  if (!cmdBase) return { error: '缺少命令', code: 'MISSING_CMD' };
  const gated = gateControlScope.call(this, { cmdBase, args, channel, fromControlChannel });
  if (gated) return gated;
  const { session, evolagent } = await this.loadMenuContext(channel, channelId);
  const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
  const authDenied = await authorizeMenuIntent.call(this, {
    intent: buildMenuIntent('query', cmdBase, args, undefined, undefined, fromControlChannel),
    identity,
    session,
    explicitChatType,
    channel,
    channelId,
    userId,
    fromControlChannel,
  });
  if (authDenied) return authDenied;

  // ── /agent 查询（只读） ──
  // 控制 channel：验 owners，按 args.aid 查任意 agent；agent channel：强制查自身。
  if (cmdBase === '/agent') {
    if (fromControlChannel) {
      if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
      return await execAgentQuery(args);
    }
    const selfAid = this.getOwningAgent?.(channel)?.aid;
    if (!selfAid) return { error: '当前 channel 无绑定 agent', code: 'FORBIDDEN' };
    return await execAgentQuery({ ...(args ?? {}), aid: selfAid });
  }

  // ── /gateway 查询（只读，列出全部作用域的网关配置；apiKey 已掩码） ──
  // 进程级：闸门已要求 fromControlChannel；此处再验 owners 非空。
  if (cmdBase === '/gateway') {
    console.log('[gateway-env-debug] /gateway 查询请求，fromControlChannel:', fromControlChannel);
    console.log('[gateway-env-debug] userId:', userId);
    const owners = loadEvolclawConfig().owners;
    console.log('[gateway-env-debug] evolclaw.owners:', owners);
    console.log('[gateway-env-debug] isProcessLevelOwner:', isProcessLevelOwner(userId, owners));

    if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
      console.log('[gateway-env-debug] 权限检查失败：不是 owner');
      return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
    }
    console.log('[gateway-env-debug] 权限检查通过，调用 gatewayList()');
    return gatewayList();
  }

  // ── /config 查询（只读，查询各层配置） ──
  if (cmdBase === '/config') {
    const scope = args?.scope || 'process';

    if (scope === 'process') {
      // 进程级配置需要 owner 权限
      if (!fromControlChannel || !isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
      const cfg = loadEvolclawConfig();
      return { data: { scope: 'process', config: cfg } };
    }

    if (scope === 'defaults') {
      // 全局默认配置需要 owner 权限
      if (!fromControlChannel || !isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
      const { read, ConfigTarget } = await import('../../config/config-manager.js');
      const cfg = read(ConfigTarget.Defaults, undefined, { cache: true });
      return { data: { scope: 'defaults', config: cfg } };
    }

    if (scope === 'agent') {
      const aid = args?.aid;
      if (!aid) return { error: '缺少 aid 参数', code: 'MISSING_AID' };

      // 控制 channel 可以查任意 agent，agent channel 只能查自身
      if (!fromControlChannel) {
        const selfAid = this.getOwningAgent?.(channel)?.aid;
        if (selfAid !== aid) {
          return { error: '只能查询自己的配置', code: 'FORBIDDEN' };
        }
      }

      const { read, ConfigTarget } = await import('../../config/config-manager.js');
      const cfg = read(ConfigTarget.Agent, { self: aid }, { cache: true });
      return { data: { scope: 'agent', aid, config: cfg } };
    }

    return { error: '未知的 scope', code: 'INVALID_SCOPE' };
  }

  if (cmdBase === '/capability') {
    const type = args?.type;
    if (type !== undefined && !isCapabilityType(type)) {
      return { error: 'type 必须是 skill / mcp / plugin', code: 'INVALID_TYPE' };
    }
    const target = resolveCapabilityTarget.call(this, { channel, args, session, evolagent, fromControlChannel });
    if ('error' in target) return target;
    const identity = this.sessionManager.resolveIdentity(channel, userId);
    const data = queryCapabilityTypes(target.ctx, target.config, type);
    return { data: sanitizeCapabilityQueryForRole(data, identity.role) };
  }

  if (cmdBase === '/pwd') {
    const sessPath = session?.projectPath;
    const fallbackPath = evolagent?.config?.projects?.defaultPath;
    const path = sessPath ?? fallbackPath ?? null;
    const name = path ? this.getProjectName(path) : null;
    return { data: { name, path } };
  }

  if (cmdBase === '/session' || cmdBase === '/s') {
    if (!session) {
      return { data: { status: 'no-session' } };
    }
    const sessionKey = this.getQueueKey(session, channel, channelId);
    const sessionAgent = this.getAgent(channel, session.baseagent);
    const isProcessing = this.messageQueue.isProcessing(sessionKey) || sessionAgent.hasActiveStream(sessionKey);
    const queueLength = this.messageQueue.getQueueLength(sessionKey);
    const health = await this.sessionManager.getHealthStatus(session.id);

    let processingDuration: number | undefined;
    if (isProcessing && session.processingState) {
      const elapsed = Date.now() - parseInt(session.processingState, 10);
      if (!isNaN(elapsed) && elapsed > 0) processingDuration = Math.floor(elapsed / 1000);
    }

    let turns = 0;
    if (session.agentSessionId) {
      const fileInfo = this.sessionManager.getSessionFileInfo(session.projectPath, session.agentSessionId, session.baseagent);
      turns = fileInfo.turns;
    }

    const data: Record<string, any> = {
      name: session.name || null,
      agentSessionId: session.agentSessionId || null,
      status: isProcessing ? 'processing' : 'idle',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    if (processingDuration !== undefined) data.processingDuration = processingDuration;
    if (queueLength > 0) data.queueLength = queueLength;
    if (turns > 0) data.turns = turns;
    if (health.lastSuccessTime) data.lastSuccess = health.lastSuccessTime;
    if (health.consecutiveErrors) data.consecutiveErrors = health.consecutiveErrors;
    if (health.lastError) data.lastError = { type: health.lastErrorType || 'unknown', message: health.lastError.substring(0, 100) };
    return { data };
  }

  if (cmdBase === '/topic') {
    if (!this.canReadTopics(identity.role)) {
      return { error: '无权限查看话题', code: 'FORBIDDEN' };
    }
    const target = (args?.target ?? '').toString().trim();
    if (!target) return { error: '缺少 args.target', code: 'MISSING_VALUE' };
    const topic = await this.sessionManager.getThreadSession(channel, channelId, target);
    if (!topic) return { error: '话题不存在', code: 'NOT_FOUND' };
    const sessionKey = this.getQueueKey(topic, channel, channelId);
    const sessionAgent = this.getAgent(channel, topic.baseagent);
    const isProcessing = this.messageQueue.isProcessing(sessionKey) || sessionAgent.hasActiveStream(sessionKey);
    const queueLength = this.messageQueue.getQueueLength(sessionKey);
    const health = await this.sessionManager.getHealthStatus(topic.id);

    let processingDuration: number | undefined;
    if (isProcessing && topic.processingState) {
      const elapsed = Date.now() - parseInt(topic.processingState, 10);
      if (!isNaN(elapsed) && elapsed > 0) processingDuration = Math.floor(elapsed / 1000);
    }

    let turns = 0;
    if (topic.agentSessionId) {
      turns = this.sessionManager.getSessionFileInfo(topic.projectPath, topic.agentSessionId, topic.baseagent).turns;
    }

    const data: Record<string, any> = {
      threadId: topic.threadId,
      name: topic.name || null,
      agentSessionId: topic.agentSessionId || null,
      status: isProcessing ? 'processing' : 'idle',
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
    };
    if (processingDuration !== undefined) data.processingDuration = processingDuration;
    if (queueLength > 0) data.queueLength = queueLength;
    if (turns > 0) data.turns = turns;
    if (health.lastSuccessTime) data.lastSuccess = health.lastSuccessTime;
    if (health.consecutiveErrors) data.consecutiveErrors = health.consecutiveErrors;
    if (health.lastError) data.lastError = { type: health.lastErrorType || 'unknown', message: health.lastError.substring(0, 100) };
    return { data };
  }

  if (cmdBase === '/baseagent') {
    const requestedAgent = typeof args?.aid === 'string'
      ? (this.agentRegistry?.get?.(args.aid) ?? null)
      : null;
    const targetAgent = requestedAgent ?? evolagent;
    const value = targetAgent?.baseagent ?? targetAgent?.config?.active_baseagent ?? null;
    return { data: { baseagent: value, scope: 'agent' } };
  }

  if (cmdBase === '/model') {
    const target = resolveMenuModelTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
      field: 'model',
    });
    if ('error' in target) return target;
    const agent = this.getAgent(channel, target.baseagent);
    const current = readMenuModel(target, agent);
    return {
      data: {
        model: current.value,
        baseagent: target.baseagent,
        source: current.source,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/effort') {
    const target = resolveMenuModelTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
      field: 'effort',
    });
    if ('error' in target) return target;
    const agent = this.getAgent(channel, target.baseagent);
    const current = readMenuModel(target, agent);
    return {
      data: {
        effort: current.value,
        baseagent: target.baseagent,
        source: current.source,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/chatmode') {
    const target = resolveMenuChatmodeTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
    });
    if ('error' in target) return target;
    return {
      data: {
        mode: readMenuChatmode(target),
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/dispatch') {
    const chatType = session?.chatType ?? explicitChatType ?? 'private';
    if (chatType !== 'group') {
      return { error: 'dispatch 仅在群聊会话中有效', code: 'NOT_APPLICABLE' };
    }
    const target = resolveMenuDispatchTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
    });
    if ('error' in target) return target;
    const fallback = session?.metadata?.dispatchMode === 'mention' || session?.metadata?.dispatchMode === 'broadcast'
      ? session.metadata.dispatchMode
      : (evolagent?.config?.dispatch === 'mention' || evolagent?.config?.dispatch === 'broadcast' ? evolagent.config.dispatch : null);
    return {
      data: {
        mode: readMenuDispatch(target, fallback),
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/observable') {
    return { data: { observable: evolagent?.getObservable() ?? false } };
  }

  if (cmdBase === '/perm') {
    const target = resolveMenuPermissionTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      explicitChatType,
      fromControlChannel,
    });
    if ('error' in target) return target;
    return {
      data: {
        mode: readMenuPermission(target),
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/activity') {
    const currentMode = this.agentRegistry?.getShowActivities?.(channel) ?? 'all';
    return { data: { mode: currentMode } };
  }

  if (cmdBase === '/system') {
    if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
      return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
    }
    const owningAgent = this.getOwningAgent(channel);
    const data: Record<string, any> = {
      aid: loadEvolclawConfig().aid ?? null,
      pid: process.pid,
      node: process.version,
      uptime: Math.floor(process.uptime()),
    };
    try {
      const pkgPath = path.join(getPackageRoot(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg?.version) data.version = pkg.version;
    } catch {}
    try {
      const fp = path.join(getPackageRoot(), 'node_modules', '@agentunion', 'fastaun', 'package.json');
      const fp2 = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (fp2?.version) data.fastaunVersion = fp2.version;
    } catch {}
    // ecweb 是独立全局包，读其已装版本（与 /upgrade 一致）
    const ecwebPkg = resolveGlobalPkg('evolclaw-web');
    if (ecwebPkg?.version) data.ecwebVersion = ecwebPkg.version;
    const channels = owningAgent?.channelInstanceNames?.() ?? [];
    if (channels.length) {
      // 将 channelKey 字符串（如 "feishu#aid#name"）解析为对象 { type, instName }
      data.channels = channels.map((key: string) => {
        const parts = key.split('#');
        return { type: parts[0], instName: parts[2] || parts[0] };
      });
    }
    // 收集主机级可用的所有 baseagent 类型（检测已安装的 CLI + 版本）
    const baseagents: Array<{ name: string; version: string | null }> = [];
    for (const cmd of ['claude', 'gemini', 'codex']) {
      if (commandExists(cmd)) {
        baseagents.push({ name: cmd, version: getBaseagentVersion(cmd) });
      }
    }
    data.baseagents = baseagents;
    return { data };
  }

  // ── name=file：文件元信息（§5.1） ──
  // 权限（§6.3）：agent owner/admin 或 aid channel owner。项目外文件仅 owner 可取（§6.2，由 resolveMenuFilePath 校验）。
  if (cmdBase === '/file') {
    const role = identity.role;
    if (role !== 'owner' && role !== 'admin') {
      return { error: '无权限', code: 'NO_PERMISSION' };
    }
    const resolved = resolveMenuFilePath(args?.path, session, role, 'file');
    if ('error' in resolved) return resolved;
    const { realPath, stat } = resolved;

    // sha256 仅对 ≤ 2 MB 文件计算，超过返回 null，客户端降级到 size+mtime（§4、§7 决策 2）
    let sha256: string | null = null;
    if (stat.size <= FILE_HASH_MAX_SIZE) {
      try {
        sha256 = crypto.createHash('sha256').update(fs.readFileSync(realPath)).digest('hex');
      } catch {
        sha256 = null;
      }
    }

    return {
      data: {
        path: (args?.path ?? '').toString(),
        sha256,
        size: stat.size,
        mtime: stat.mtimeMs,
      },
    };
  }

  return { error: `不支持 query: ${cmdBase}`, code: 'NOT_SUPPORTED' };
}

/** menu.update — 写入新值。 */
export async function execMenuUpdate(this: any,
  cmd: string, value: string, channel: string, channelId: string, userId?: string,
  overrideIdentity?: import('../../types.js').SessionIdentity, fromControlChannel = false,
  args?: Record<string, any>
): Promise<{ data: any } | { error: string; code?: string }> {
  const cmdBase = cmd.trim().split(' ')[0];
  if (!cmdBase) return { error: '缺少命令', code: 'MISSING_CMD' };
  const gated = gateControlScope.call(this, { cmdBase, args, channel, fromControlChannel });
  if (gated) return gated;
  const arg = value.trim();
  if (!arg) return { error: '缺少 value 参数', code: 'MISSING_VALUE' };
  const { session, evolagent } = await this.loadMenuContext(channel, channelId);
  const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
  const isAdmin = identity.role === 'owner' || identity.role === 'admin';
  const authDenied = await authorizeMenuIntent.call(this, {
    intent: buildMenuIntent('update', cmdBase, args, undefined, arg, fromControlChannel),
    identity,
    session,
    channel,
    channelId,
    userId,
    fromControlChannel,
  });
  if (authDenied) return authDenied;

  // ── 进程级 /gateway update（网关配置，value 为 JSON：{scope,type,patch}） ──
  if (cmdBase === '/gateway') {
    let body: any;
    try { body = JSON.parse(arg); } catch { return { error: 'value 需为 JSON', code: 'INVALID_ARGS' }; }
    return await gatewayUpdate(body);
  }

  // ── 关系级 /trigger update（调度参数，value 为 JSON 字符串） ──
  if (cmdBase === '/trigger') {
    let patch: any;
    try { patch = JSON.parse(arg); } catch { return { error: 'value 需为 JSON', code: 'INVALID_ARGS' }; }
    if (!patch?.nameOrId) return { error: '缺少 nameOrId', code: 'INVALID_ARGS' };
    const isAdmin = identity.role === 'owner' || identity.role === 'admin';
    if (!isAdmin && !userId) return { error: '无法确认身份，请确保渠道提供发送者 ID', code: 'FORBIDDEN' };
    const triggerScheduler = this.getTriggerSchedulerForChannel?.(channel);
    if (!triggerScheduler) return { error: '触发器功能未启用', code: 'NOT_SUPPORTED' };
    const updated = await this.updateTriggerFromPatch(
      triggerScheduler,
      patch.nameOrId,
      patch,
      channel,
      channelId,
      userId ?? '',
      isAdmin,
    );
    if (!updated.ok) return { error: updated.error, code: /不存在|无权限/.test(updated.error) ? 'NOT_FOUND' : 'INVALID_ARGS' };
    return { data: { id: updated.trigger.id, nextFireAt: updated.trigger.nextFireAt } };
  }

  if (cmdBase === '/capability') {
    const type = args?.type;
    if (!isCapabilityType(type)) {
      return { error: 'args.type 必须是 skill / mcp / plugin', code: type ? 'INVALID_TYPE' : 'INVALID_ARGS' };
    }
    const name = (args?.name ?? '').toString().trim();
    if (name) {
      if (!isAdmin) return { error: '无权限', code: 'NO_PERMISSION' };
    } else if (identity.role !== 'owner') {
      return { error: '类型级能力策略仅 owner 可修改', code: 'NO_PERMISSION' };
    }

    const target = resolveCapabilityTarget.call(this, { channel, args, session, evolagent, fromControlChannel });
    if ('error' in target) return target;
    const support = queryCapabilityTypes(target.ctx, target.config, type).capabilities[type];
    if (!support?.canUpdate) {
      return { error: support?.reason || '当前 baseagent 不支持 capability 更新', code: 'NOT_SUPPORTED' };
    }
    if (name) {
      const options = await listCapabilityOptions(target.ctx, target.config, type);
      if (!options.some(item => item.value === name)) {
        return { error: `未发现能力: ${name}`, code: 'NOT_FOUND' };
      }
    }

    try {
      const data = updateCapabilityPolicy(target.ctx.aid, target.ctx.baseagent, type, arg as any, name || undefined);
      return { data };
    } catch (e: any) {
      return { error: e?.message || String(e), code: e?.code || 'EXEC_FAILED' };
    }
  }

  if (cmdBase === '/baseagent') {
    if (identity.role !== 'owner') return { error: '无权限', code: 'NO_PERMISSION' };
    if (!evolagent) return { error: '当前 channel 无绑定 agent，无法设置 active_baseagent', code: 'EXEC_FAILED' };
    const valid = this.getAvailableBaseagents(channel);
    if (valid.length && !valid.includes(arg)) {
      return { error: `无效 baseagent: ${arg}，可选: ${valid.join(' / ')}`, code: 'INVALID_VALUE' };
    }
    const previousBaseagent = evolagent.baseagent;
    evolagent.setActiveBaseagent(arg);
    this.eventBus.publish({
      type: 'agent:baseagent-changed',
      aid: evolagent.aid,
      baseagent: arg,
      previousBaseagent,
      scope: 'agent',
      timestamp: Date.now(),
    });
    return { data: { baseagent: arg, scope: 'agent' } };
  }

  if (cmdBase === '/model') {
    const target = resolveMenuModelTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      fromControlChannel,
      field: 'model',
    });
    if ('error' in target) return target;
    const agent = this.getAgent(channel, target.baseagent);
    let targetModel = arg;
    if (hasModelSwitcher(agent)) {
      const models = (await agent.listModels?.()) ?? [];
      const decision = validateModelSelectionForRole({
        role: identity.role,
        baseagent: target.baseagent,
        requestedModel: arg,
        models,
        resolveModelId: (agent as any).resolveModelId?.bind(agent),
      });
      if (!decision.ok) return { error: decision.message || `invalid model: ${arg}`, code: decision.code || 'INVALID_VALUE' };
      targetModel = decision.model || arg;
      if (models.length && !models.includes(targetModel)) {
        return { error: `无效模型: ${arg}`, code: 'INVALID_VALUE' };
      }
    }
    try {
      writeMenuModel(target, targetModel);
    } catch (e: any) {
      return { error: e?.message || String(e), code: e?.code || 'CONFIG_WRITE_FAILED' };
    }
    this.eventBus.publish({
      type: 'runner:model-changed',
      sessionId: session?.id,
      agentName: evolagent?.name,
      baseagent: target.baseagent,
      model: targetModel,
      timestamp: Date.now(),
    });
    return {
      data: {
        model: targetModel,
        baseagent: target.baseagent,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/effort') {
    if (!isAdmin) return { error: '无权限', code: 'NO_PERMISSION' };
    const target = resolveMenuModelTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      fromControlChannel,
      field: 'effort',
    });
    if ('error' in target) return target;
    const agent = this.getAgent(channel, target.baseagent);
    const modelTarget: MenuModelTarget = { ...target, field: 'model', fieldPath: `baseagents.${target.baseagent}.model` };
    const currentModel = hasModelSwitcher(agent) ? (readMenuModel(modelTarget, agent).value || agent.getModel()) : agent.name;
    const validEfforts = getAvailableEfforts(agent, currentModel);
    const allValid: string[] = [...validEfforts, 'auto'];
    if (!allValid.includes(arg)) {
      return { error: `无效推理强度: ${arg}，可选: ${allValid.join(' / ')}`, code: 'INVALID_VALUE' };
    }
    try {
      writeMenuModel(target, arg === 'auto' ? null : arg);
    } catch (e: any) {
      return { error: e?.message || String(e), code: e?.code || 'CONFIG_WRITE_FAILED' };
    }
    this.eventBus.publish({
      type: 'runner:model-changed',
      sessionId: session?.id,
      agentName: evolagent?.name,
      baseagent: target.baseagent,
      effort: arg,
      timestamp: Date.now(),
    });
    return {
      data: {
        effort: arg,
        baseagent: target.baseagent,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/chatmode') {
    if (!isAdmin) return { error: '无权限', code: 'NO_PERMISSION' };
    if (arg !== 'interactive' && arg !== 'proactive') {
      return { error: `无效模式: ${arg}`, code: 'INVALID_VALUE' };
    }
    const target = resolveMenuChatmodeTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      fromControlChannel,
    });
    if ('error' in target) return target;
    try {
      writeMenuChatmode(target, arg);
    } catch (e: any) {
      return { error: e?.message || String(e), code: e?.code || 'CONFIG_WRITE_FAILED' };
    }
    return {
      data: {
        mode: arg,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/dispatch') {
    if (!isAdmin) return { error: '无权限', code: 'NO_PERMISSION' };
    if (arg !== 'mention' && arg !== 'broadcast' && arg !== 'clear') {
      return { error: `无效模式: ${arg}`, code: 'INVALID_VALUE' };
    }
    const chatType = session?.chatType;
    if (!session || chatType !== 'group') {
      return { error: 'dispatch 仅在群聊会话中有效', code: 'NOT_APPLICABLE' };
    }
    const target = resolveMenuDispatchTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      fromControlChannel,
    });
    if ('error' in target) return target;
    try {
      writeMenuDispatch(target, arg === 'clear' ? null : arg);
    } catch (e: any) {
      return { error: e?.message || String(e), code: e?.code || 'CONFIG_WRITE_FAILED' };
    }
    return {
      data: {
        mode: arg === 'clear' ? null : arg,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/perm') {
    if (!isAdmin) return { error: '无权限', code: 'NO_PERMISSION' };
    const permAgent = this.getAgent(channel, session?.baseagent);
    const validModes = hasPermissionController(permAgent)
      ? permAgent.listModes().filter(m => m.available).map(m => m.key)
      : [...PERMISSION_MODE_KEYS];
    if (!validModes.includes(arg)) return { error: `无效模式: ${arg}`, code: 'INVALID_VALUE' };
    // 默认写关系级配置；显式 scope=agent 时写 agent 级 permissionMode。
    const target = resolveMenuPermissionTarget.call(this, {
      args,
      session,
      channel,
      channelId,
      userId,
      role: identity.role,
      fromControlChannel,
    });
    if ('error' in target) return target;
    try {
      writeMenuPermission(target, arg as MenuPermissionValue);
    } catch (e: any) {
      return { error: e?.message || String(e), code: e?.code || 'CONFIG_WRITE_FAILED' };
    }
    return {
      data: {
        mode: arg,
        scope: target.scope,
        field: target.fieldPath,
        self: target.sel.self,
        ...(target.sel.peerKey ? { peerKey: target.sel.peerKey } : {}),
      },
    };
  }

  if (cmdBase === '/activity') {
    const modeMap: Record<string, string> = { all: 'all', none: 'none' };
    const newMode = modeMap[arg];
    if (!newMode) return { error: `无效模式: ${arg}，可选: all / none`, code: 'INVALID_VALUE' };
    if (identity.role !== 'owner') return { error: '中间输出模式切换仅限 owner', code: 'NO_PERMISSION' };
    if (!this.agentRegistry?.setShowActivities) return { error: '找不到通道所属 agent，无法持久化', code: 'EXEC_FAILED' };
    this.agentRegistry.setShowActivities(channel, newMode as any);
    return { data: { mode: newMode } };
  }

  if (cmdBase === '/observable') {
    if (identity.role !== 'owner') return { error: '观察者模式仅限 owner 开关', code: 'NO_PERMISSION' };
    if (arg !== 'true' && arg !== 'false') return { error: `无效值: ${arg}，可选: true / false`, code: 'INVALID_VALUE' };
    if (!evolagent) return { error: '找不到通道所属 agent，无法持久化', code: 'EXEC_FAILED' };
    evolagent.setObservable(arg === 'true');
    return { data: { observable: arg === 'true' } };
  }

  return { error: `不支持 update: ${cmdBase}`, code: 'NOT_SUPPORTED' };
}

/** menu.action — 触发动词。 */
export async function execMenuAction(this: any,
  cmd: string, action: string, args: any, channel: string, channelId: string, userId?: string,
  overrideIdentity?: import('../../types.js').SessionIdentity,
  explicitChatType?: MenuChatType,
  requestId?: string,
  fromControlChannel = false,
): Promise<{ data: any } | { error: string; code?: string }> {
  const cmdBase = cmd.trim().split(' ')[0];
  if (!cmdBase) return { error: '缺少命令', code: 'MISSING_CMD' };
  if (!action) return { error: '缺少 action', code: 'MISSING_VALUE' };
  const gated = gateControlScope.call(this, { cmdBase, action, args, channel, fromControlChannel });
  if (gated) return gated;
  if (cmdBase === '/system' && fromControlChannel && !isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
    return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
  }
  const { session: authSession } = await this.loadMenuContext(channel, channelId);
  const authIdentity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
  if (cmdBase === '/agent' && !fromControlChannel && !args?.aid) {
    const selfAid = this.getOwningAgent?.(channel)?.aid;
    if (selfAid) args = { ...(args ?? {}), aid: selfAid };
  }
  const authDenied = await authorizeMenuIntent.call(this, {
    intent: buildMenuIntent('action', cmdBase, args, action, undefined, fromControlChannel),
    identity: authIdentity,
    session: authSession,
    explicitChatType,
    channel,
    channelId,
    userId,
    fromControlChannel,
  });
  if (authDenied) return authDenied;

  // ── /gateway action（进程级，gate 已确保 fromControlChannel） ──
  // test=连通性测试；delete=删除配置；models=模型+价格；set-price=改网关价格；sync-env=同步环境变量。
  if (cmdBase === '/gateway') {
    if (action === 'test') return await gatewayTest(args);
    if (action === 'delete') return await gatewayDelete(args);
    if (action === 'models') return await gatewayModels(args);
    if (action === 'set-price') return gatewaySetPrice(args);
    if (action === 'sync-env') return await gatewaySyncEnv(args);
    return { error: `不支持 gateway action: ${action}`, code: 'NOT_SUPPORTED' };
  }

  const { session } = await this.loadMenuContext(channel, channelId);
  const identity = overrideIdentity ?? this.sessionManager.resolveIdentity(channel, userId);
  const isMenuAdmin = identity.role === 'owner' || identity.role === 'admin';

  // ── /agent action ──
  // 控制 channel：验 evolclaw.owners，可执行进程级（create/delete/enable/disable）+ 自管理（update/reload）。
  // agent channel：闸门已挡掉进程级 + 跨 agent，仅 update/reload 能到此；reload 允许 owner/admin，update 仅 owner。
  if (cmdBase === '/agent') {
    if (fromControlChannel) {
      if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
        return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
      }
    } else {
      // 本 agent 自管理：reload 允许 owner/admin；update 会改鉴权相关元配置，仍仅 owner。
      const isAgentOwner = identity.role === 'owner';
      const isAgentAdmin = identity.role === 'owner' || identity.role === 'admin';
      if (action === 'update' ? !isAgentOwner : !isAgentAdmin) {
        return { error: action === 'update' ? '本 agent 配置更新仅 owner 可执行' : '本 agent 自管理操作仅 owner/admin 可执行', code: 'FORBIDDEN' };
      }
      const selfAid = this.getOwningAgent?.(channel)?.aid;
      if (!selfAid) return { error: '当前 channel 无绑定 agent', code: 'FORBIDDEN' };
      args = { ...(args ?? {}), aid: selfAid };
    }
    const a = { ...(args ?? {}) };
    if (action === 'create') {
      a.project = resolveProjectPath(a.project, a.aid ?? '', loadDefaults());
    }
    // queue-clear：清空指定 agent 的待处理消息（不影响处理中），直接走 messageQueue。
    if (action === 'queue-clear') {
      if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
      const handle = this.agentRegistry?.get(a.aid) ?? null;
      const agentName = handle?.name;
      if (!agentName) return { error: `未找到 Agent: ${a.aid}`, code: 'NOT_FOUND' };
      const cleared = this.messageQueue.clearByAgent(agentName);
      return { data: { cleared } };
    }
    // mute / unmute：禁言/解禁。禁言后消息照常入队但不消费，解禁后恢复。
    if (action === 'mute' || action === 'unmute') {
      if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
      const handle = this.agentRegistry?.get(a.aid) ?? null;
      const agentName = handle?.name;
      if (!agentName) return { error: `未找到 Agent: ${a.aid}`, code: 'NOT_FOUND' };
      if (action === 'mute') this.messageQueue.muteAgent(agentName);
      else this.messageQueue.unmuteAgent(agentName);
      return { data: { aid: a.aid, muted: action === 'mute' } };
    }
    // start / stop：运行时连/断渠道，不改 config.enabled。
    if (action === 'start' || action === 'stop') {
      if (!a.aid) return { error: '缺少 aid', code: 'INVALID_ARGS' };
      const hooks = (globalThis as any).__evolclaw_reloadHooks;
      if (!hooks) return { error: 'Reload hooks 未初始化', code: 'INTERNAL' };
      try {
        if (action === 'stop') {
          if (!this.agentRegistry?.stopAgent) return { error: 'stopAgent 不可用', code: 'INTERNAL' };
          await this.agentRegistry.stopAgent(a.aid, hooks);
          this.eventBus.publish({ type: 'agent:stopped', aid: a.aid, timestamp: Date.now() });
          // 中断该 agent 正在执行的大模型调用
          const handle = this.agentRegistry.get(a.aid);
          if (handle) this.messageQueue.interruptByAgent(handle.name);
        } else {
          if (!this.agentRegistry?.startAgent) return { error: 'startAgent 不可用', code: 'INTERNAL' };
          await this.agentRegistry.startAgent(a.aid, hooks);
          this.eventBus.publish({ type: 'agent:started', aid: a.aid, timestamp: Date.now() });
        }
        return { data: { aid: a.aid, action } };
      } catch (e: any) {
        this.eventBus.publish({ type: 'agent:error', aid: a.aid, action, error: e?.message || String(e), timestamp: Date.now() });
        return { error: e?.message || String(e), code: 'INTERNAL' };
      }
    }
    // reload / disable / delete 会中断 agent 正在处理的任务，执行前检查是否繁忙。
    // 队列按 agent 名计数，故先用 registry 把 aid 解析成 name；force 跳过。
    if ((action === 'reload' || action === 'disable' || action === 'delete') && a.aid && !a.force) {
      const handle = this.agentRegistry?.get(a.aid) ?? null;
      const agentName = handle?.name;
      if (agentName) {
        const busy = this.messageQueue.getProcessingCountByAgent(agentName)
                   + this.messageQueue.getQueueLengthByAgent(agentName);
        if (busy > 0) {
          return { error: `该 Agent 有 ${busy} 个任务执行中`, code: 'BUSY' };
        }
      }
    }
    return await execAgentAction(action, a, userId ?? '', this.eventBus);
  }

  // ── 关系级 /trigger（不走 owners；复用 isAdmin + scoped 逻辑，D4 直调底层） ──
  if (cmdBase === '/trigger') {
    const role = identity.role;
    const isAdmin = role === 'owner' || role === 'admin';
    const triggerScheduler = this.getTriggerSchedulerForChannel?.(channel);
    if (!triggerScheduler) return { error: '触发器功能未启用', code: 'NOT_SUPPORTED' };

    if (action === 'set') {
      // args 结构化 → 直接组装 ParsedTriggerSet（绕过 parseTriggerSet 文本解析，无注入风险）
      if (!args?.scheduleType || (args.scheduleType !== 'once' && !args?.scheduleValue) || !args?.prompt) {
        return { error: '缺少必填参数：scheduleType / scheduleValue / prompt', code: 'INVALID_ARGS' };
      }
      // menu 路径绕过了 parseTriggerSet 的校验，必须自行校验枚举/数值，
      // 避免非法调度参数进入 scheduler。
      const schedErr = validateScheduleParams(args.scheduleType, String(args.scheduleValue ?? ''));
      if (schedErr) return { error: schedErr, code: 'INVALID_ARGS' };
      const targetSession = args.targetSession ?? args.targetSessionStrategy ?? 'main';
      if (!['main', 'thread'].includes(targetSession)) {
        return { error: `无效 targetSession: ${targetSession}`, code: 'INVALID_ARGS' };
      }
      const parsed: ParsedTriggerSet = {
        scheduleType: args.scheduleType,
        scheduleValue: String(args.scheduleValue ?? ''),
        executionType: args.executionType ?? 'target_session',
        feedbackStrategy: args.feedbackStrategy ?? (args.targetChannel ? 'target' : 'origin'),
        targetSession,
        prompt: String(args.prompt),
        name: args.name,
        targetChannel: args.targetChannel,
        targetChannelId: args.targetChannelId,
        targetThreadId: args.targetThreadId,
        agentId: args.agentId,
        model: args.model,
        effort: args.effort,
        permissionMode: args.permissionMode,
      };
      const r = await this.registerTriggerFromParsed(
        parsed,
        channel,
        channelId,
        userId ?? '',
        undefined,
        this.resolveMenuChatType(channel, channelId, explicitChatType),
        undefined,
        isAdmin
      );
      if (!r.ok) return { error: r.error, code: /已存在|exists|重复/.test(r.error) ? 'CONFLICT' : 'INVALID_ARGS' };
      return { data: { id: r.trigger.id, name: r.trigger.name, nextFireAt: r.trigger.nextFireAt } };
    }

    if (action === 'cancel') {
      const nameOrId = args?.nameOrId;
      if (!nameOrId) return { error: '缺少 nameOrId', code: 'INVALID_ARGS' };
      if (!isAdmin && !userId) return { error: '无法确认身份，请确保渠道提供发送者 ID', code: 'FORBIDDEN' };
      const trigger = this.findTriggerDefinition(triggerScheduler, nameOrId, userId ?? '', channel, isAdmin);
      if (!trigger) return { error: '触发器不存在或无权限', code: 'NOT_FOUND' };
      const cancelled = triggerScheduler.cancel(trigger.id);
      this.eventBus.publish({ type: 'trigger:cancelled', triggerId: cancelled.id, name: cancelled.name, by: userId ?? '' });
      return { data: { id: cancelled.id, cancelled: true } };
    }

    if (action === 'enable' || action === 'disable') {
      const nameOrId = args?.nameOrId;
      if (!nameOrId) return { error: '缺少 nameOrId', code: 'INVALID_ARGS' };
      if (!isAdmin && !userId) return { error: '无法确认身份，请确保渠道提供发送者 ID', code: 'FORBIDDEN' };
      const trigger = this.findTriggerDefinition(triggerScheduler, nameOrId, userId ?? '', channel, isAdmin);
      if (!trigger) return { error: '触发器不存在或无权限', code: 'NOT_FOUND' };
      const updated = triggerScheduler.setEnabled(trigger.id, action === 'enable');
      return { data: { id: updated.id, enabled: updated.enabled } };
    }

    if (action === 'delete') {
      const nameOrId = args?.nameOrId;
      if (!nameOrId) return { error: '缺少 nameOrId', code: 'INVALID_ARGS' };
      if (!isAdmin && !userId) return { error: '无法确认身份，请确保渠道提供发送者 ID', code: 'FORBIDDEN' };
      const trigger = this.findTriggerDefinition(triggerScheduler, nameOrId, userId ?? '', channel, isAdmin);
      if (!trigger) return { error: '触发器不存在或无权限', code: 'NOT_FOUND' };
      if (trigger.enabled) return { error: '请先禁用触发器再删除', code: 'INVALID_STATE' };
      const deleted = triggerScheduler.delete(trigger.id);
      return { data: { id: deleted.id, deleted: true } };
    }

    if (action === 'run') {
      const nameOrId = args?.nameOrId;
      if (!nameOrId) return { error: '缺少 nameOrId', code: 'INVALID_ARGS' };
      if (!isAdmin && !userId) return { error: '无法确认身份，请确保渠道提供发送者 ID', code: 'FORBIDDEN' };
      const trigger = this.findTriggerDefinition(triggerScheduler, nameOrId, userId ?? '', channel, isAdmin);
      if (!trigger) return { error: '触发器不存在或无权限', code: 'NOT_FOUND' };
      if (!trigger.enabled) return { error: '触发器已禁用，不能立即执行', code: 'INVALID_STATE' };
      const result = await triggerScheduler.run(trigger.id, { dryRun: args?.dryRun === true });
      return { data: { id: trigger.id, runId: result.runId, status: result.status, reason: result.reason } };
    }

    return { error: `不支持的 trigger action: ${action}`, code: 'INVALID_ARGS' };
  }

  if (cmdBase === '/topic') {
    if (action !== 'delete' && action !== 'rename') {
      return { error: `不支持的 topic action: ${action}`, code: 'NOT_SUPPORTED' };
    }
    const target = (args?.target ?? '').toString().trim();
    if (!target) return { error: '缺少 args.target', code: 'MISSING_VALUE' };
    const renameName = action === 'rename' ? getRenameName(args) : '';
    if (action === 'rename' && !renameName) return { error: '缺少 args.name', code: 'MISSING_VALUE' };
    const topic = await this.sessionManager.getThreadSession(channel, channelId, target);
    if (!topic) return { error: '话题不存在', code: 'NOT_FOUND' };
    const chatType: MenuChatType = topic.chatType === 'group'
      ? 'group'
      : topic.chatType === 'private'
        ? 'private'
        : this.resolveMenuChatType(channel, channelId, explicitChatType);
    if (!this.canDeleteTopic(identity.role, chatType, topic, userId)) {
      return { error: action === 'rename' ? '无权限重命名话题' : '无权限删除话题', code: 'FORBIDDEN' };
    }

    if (action === 'rename') {
      const newName = renameName;
      const existing = await this.sessionManager.getSessionByName?.(channel, channelId, newName);
      if (existing && existing.id !== topic.id) {
        return { error: `名称 "${newName}" 已存在`, code: 'CONFLICT' };
      }
      const oldName = displaySessionTitle(topic.name, topic.threadId || '(未命名)');
      const success = await this.sessionManager.renameSession(topic.id, newName);
      if (!success) return { error: '重命名失败', code: 'EXEC_FAILED' };
      if (topic.agentSessionId) {
        try {
          const targetAgent = this.getAgent(channel, topic.baseagent);
          await targetAgent.setSessionName?.(topic.agentSessionId, newName);
        } catch {}
      }
      this.eventBus.publish({ type: 'session:renamed', sessionId: topic.id, oldName, newName });
      return {
        data: {
          action: 'rename',
          success: true,
          topic: {
            ...buildSessionPayload(topic, newName),
            threadId: topic.threadId,
          },
        },
      };
    }

    const success = await this.sessionManager.unbindSession(topic.id);
    if (!success) return { error: '删除失败', code: 'DELETE_FAILED' };
    this.eventBus.publish({ type: 'session:deleted', sessionId: topic.id });
    const targetAgent = this.getAgent(channel, topic.baseagent);
    await targetAgent.closeSession?.(topic.id);
    return { data: { deleted: true } };
  }

  // ── /session 系列 ──
  if (cmdBase === '/session' || cmdBase === '/s') {
    if (action === 'stop') {
      if (!session) return { error: '当前无活跃会话', code: 'NO_ACTIVE_SESSION' };
      const sessionKey = this.getQueueKey(session, channel, channelId);
      const sessionAgent = this.getAgent(channel, session.baseagent);
      const hasActive = sessionAgent.hasActiveStream(sessionKey);
      const queueLength = this.messageQueue.getQueueLength(sessionKey);
      if (queueLength === 0 && !hasActive) {
        return { error: '当前没有正在处理的任务', code: 'NO_ACTIVE_TASK' };
      }
      await sessionAgent.interrupt(sessionKey);
      this.eventBus.publish({
        type: 'task:interrupted',
        sessionId: sessionKey,
        reason: 'stop',
        agentName: this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>',
      });
      this.sessionManager.clearProcessing(sessionKey);
      return { data: { action: 'stop', success: true } };
    }

    if (action === 'new') {
      const name = (args?.name ?? '').toString().trim();
      return await this.delegateAsAction(action, name ? `/new ${name}` : '/new', channel, channelId, userId, { enrichSession: true });
    }

    if (action === 'rename') {
      const newName = getRenameName(args);
      if (!newName) return { error: '缺少 args.name', code: 'MISSING_VALUE' };
      const target = (args?.target ?? '').toString().trim();
      const targetSession = await findMainSessionTarget(this.sessionManager, channel, channelId, target, session);
      if (!targetSession) {
        return target
          ? { error: `会话不存在: ${target}`, code: 'NOT_FOUND' }
          : { error: '当前无活跃会话', code: 'NO_ACTIVE_SESSION' };
      }
      const targetChatType: MenuChatType = targetSession.chatType === 'group'
        ? 'group'
        : targetSession.chatType === 'private'
          ? 'private'
          : this.resolveMenuChatType(channel, channelId, explicitChatType);
      if (targetChatType === 'group' && !isMenuAdmin) {
        return { error: '无权限：群聊中仅管理员可重命名会话', code: 'NO_PERMISSION' };
      }
      const existing = await this.sessionManager.getSessionByName?.(channel, channelId, newName);
      if (existing && existing.id !== targetSession.id) {
        return { error: `名称 "${newName}" 已存在`, code: 'CONFLICT' };
      }
      const oldName = displaySessionTitle(targetSession.name, '(未命名)');
      const success = await this.sessionManager.renameSession(targetSession.id, newName);
      if (!success) return { error: '重命名失败', code: 'EXEC_FAILED' };
      if (targetSession.agentSessionId) {
        try {
          const targetAgent = this.getAgent(channel, targetSession.baseagent);
          await targetAgent.setSessionName?.(targetSession.agentSessionId, newName);
        } catch {}
      }
      this.eventBus.publish({ type: 'session:renamed', sessionId: targetSession.id, oldName, newName });
      return { data: { action: 'rename', success: true, session: buildSessionPayload(targetSession, newName) } };
    }

    if (action === 'delete') {
      const target = (args?.target ?? '').toString().trim();
      if (!target) return { error: '缺少 args.target', code: 'MISSING_VALUE' };
      return await this.delegateAsAction(action, `/del ${target}`, channel, channelId, userId);
    }

    if (action === 'switch') {
      const target = (args?.target ?? '').toString().trim();
      if (!target) return { error: '缺少 args.target', code: 'MISSING_VALUE' };
      return await this.delegateAsAction(action, `/s ${target}`, channel, channelId, userId, { enrichSession: true });
    }

    if (action === 'compact') {
      const need = this.requireSession(session);
      if (need) return need;
      return await this.delegateAsAction(action, '/compact', channel, channelId, userId);
    }

    if (action === 'fork') {
      const need = this.requireSession(session);
      if (need) return need;
      const name = (args?.name ?? '').toString().trim();
      return await this.delegateAsAction(action, name ? `/fork ${name}` : '/fork', channel, channelId, userId, { enrichSession: true });
    }

    return { error: `不支持的 session action: ${action}`, code: 'NOT_SUPPORTED' };
  }

  // ── /system 系列 ──
  if (cmdBase === '/system') {
    // D1 迁移：进程级鉴权统一查 evolclaw.json owners，替代各 action 内联的 identity.role 判断
    if (!isProcessLevelOwner(userId, loadEvolclawConfig().owners)) {
      return { error: '操作需要 owner 权限', code: 'FORBIDDEN' };
    }
    if (action === 'restart') {
      const restartInfo: Record<string, any> = { channel, channelId, timestamp: Date.now() };
      const dataDir = resolvePaths().dataDir;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'restart-pending.json'), JSON.stringify(restartInfo));
      const { spawn } = await import('child_process');
      spawn('node', [path.join(getPackageRoot(), 'dist', 'cli', 'index.js'), 'restart-monitor'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root }
      }).unref();
      this.eventBus.publish({ type: 'system:restart', channel, channelId });
      setTimeout(() => { process.kill(process.pid, 'SIGTERM'); }, 1000);
      return { data: { action: 'restart', success: true } };
    }

    if (action === 'check') {
      const r = await this.delegateAsAction(action, '/check', channel, channelId, userId, { overrideIdentity });
      // delegateAsAction 会把 structured 展开到 data 顶层，并保留 data.structured 兼容旧客户端。
      return r as any;
    }

    if (action === 'upgrade') {
      const devMode = isLinkedInstall();
      const localEvolclaw = getLocalVersion();
      // fastaun 本地版本：从 node_modules 读取（与 menu.query name=system 一致）
      let localFastaun: string | null = null;
      try {
        const fp = path.join(getPackageRoot(), 'node_modules', '@agentunion', 'fastaun', 'package.json');
        localFastaun = JSON.parse(fs.readFileSync(fp, 'utf-8'))?.version ?? null;
      } catch {}
      const [evolclawRemote, fastaunRemote, ecwebRemote] = await Promise.all([
        checkLatestVersion('evolclaw'),
        checkLatestVersion('@agentunion/fastaun'),
        checkLatestVersion('evolclaw-web'),
      ]);
      const cmp = (local: string | null, remote: string | null) =>
        !!(local && remote && compareVersions(local, remote) < 0);
      return {
        data: {
          devMode,
          evolclaw: { local: localEvolclaw, remote: evolclawRemote, hasUpdate: cmp(localEvolclaw, evolclawRemote) },
          fastaun:  { local: localFastaun, remote: fastaunRemote, hasUpdate: cmp(localFastaun, fastaunRemote) },
          // ecweb 本地版本由 ECWeb 进程自身注入（data.ecwebVersion），此处仅给 remote
          ecweb:    { remote: ecwebRemote },
        },
      };
    }

    return { error: `不支持的 system action: ${action}`, code: 'NOT_SUPPORTED' };
  }

  // ── /cli 透传 ──
  if (cmdBase === '/cli') {
    if (action !== 'exec') return { error: `不支持的 cli action: ${action}`, code: 'NOT_SUPPORTED' };

    let argv = Array.isArray(args?.argv) ? args.argv.map((x: any) => String(x))
               : typeof args?.command === 'string' ? [args.command]
               : null;
    if (!argv || argv.length === 0) return { error: '缺少 argv 或 command', code: 'MISSING_VALUE' };

    const cliAgent = this.getOwningAgent?.(channel);
    const cliSelfAid = cliAgent?.aid;
    const cliChannelType = this.resolveChannelType?.(channel);
    const cliChatType = (session?.chatType as 'private' | 'group' | undefined) ?? explicitChatType;
    const cliPeerKeyId = cliChatType === 'group'
      ? (session?.metadata?.groupId || channelId)
      : userId;
    const cliPeerKey = cliChannelType && cliPeerKeyId ? formatPeerKey(cliChannelType, cliPeerKeyId) : undefined;
    if (Array.isArray(args?.argv)) {
      argv = withDefaultRelationContext(argv, { self: cliSelfAid, peer: cliPeerKey });
    }

    // 解析 CLI intent
    const parseResult = Array.isArray(args?.argv)
      ? parseCliIntent(argv, 'menu.cli')
      : { kind: 'raw' as const, intent: rawCliIntent(argv, 'menu.cli'), reason: 'command string is always treated as raw CLI' };
    if (parseResult.kind === 'invalid') {
      return { error: parseResult.reason, code: parseResult.code };
    }

    // 构造授权上下文
    const authCtx = buildMenuAuthContext(this, {
      intent: parseResult.intent,
      identity,
      session,
      explicitChatType,
      channel,
      channelId,
      userId,
      source: 'menu.cli',
      fromControlChannel: fromControlChannel ?? false,
    });
    const selfAid = authCtx.selfAid;
    const peerKey = authCtx.peerKey;
    const isDaemonOwner = authCtx.isDaemonOwner;

    // 授权检查
    const decision = authorizeMenuContext(authCtx);
    if (!decision.allow) {
      await auditCommandAuthorization({
        ts: Date.now(),
        source: 'menu.cli',
        operation: parseResult.intent.operation,
        scope: parseResult.intent.scope,
        dangerous: parseResult.intent.dangerous ?? false,
        actorId: userId,
        selfAid,
        peerKey,
        channel,
        channelId,
        role: identity.role,
        isDaemonOwner,
        fromControlChannel: fromControlChannel ?? false,
        decision: 'deny',
        code: decision.code,
        reason: decision.reason,
        matchedRule: decision.matchedRule,
      });
      return { error: decision.reason, code: decision.code };
    }

    // 审计 dangerous 操作
    if (decision.dangerous) {
      await auditCommandAuthorization({
        ts: Date.now(),
        source: 'menu.cli',
        operation: parseResult.intent.operation,
        scope: parseResult.intent.scope,
        dangerous: true,
        actorId: userId,
        selfAid,
        peerKey,
        channel,
        channelId,
        role: identity.role,
        isDaemonOwner,
        fromControlChannel: fromControlChannel ?? false,
        decision: 'allow',
        matchedRule: decision.matchedRule,
        argvHash: hashArgv(argv),
      });
    }

    // 执行
    return await this.execCliPassthrough(argv);
  }

  // ── name=file action=list/fetch：目录浏览 / 拉取文件 ──
  // list 返回 JSON 目录项；fetch 内部等价于 /file <path>，复用 resolveMenuFilePath 校验链 + adapter.send(result.file)。
  // fetch 文件作为独立 result.file 消息异步发回；把请求 id 作为 correlationId 透传，
  // 客户端用它把异步到达的文件消息对回这次 fetch 点击。
  if (cmdBase === '/file') {
    // 权限（§6.3）：agent owner/admin 或 aid channel owner。项目外文件仅 owner（§6.2，由 resolveMenuFilePath 校验）。
    if (identity.role !== 'owner' && identity.role !== 'admin') {
      return { error: '无权限', code: 'NO_PERMISSION' };
    }

    if (action === 'list') {
      const dirArg = (args?.path ?? '.').toString().trim() || '.';
      const resolved = resolveMenuFilePath(dirArg, session, identity.role, 'directory');
      if ('error' in resolved) return resolved;
      const offset = parseFileListOffset(args?.offset);
      const limit = parseFileListLimit(args?.limit);
      const includeHidden = args?.includeHidden === true;
      const listed = listDirectory(resolved.realPath, { offset, limit, includeHidden, projectPath: resolved.projectPath, role: identity.role });
      if ('error' in listed) return listed;
      return { data: { path: dirArg, ...listed.data } };
    }

    if (action !== 'fetch') return { error: `不支持的 file action: ${action}`, code: 'NOT_SUPPORTED' };

    const resolved = resolveMenuFilePath(args?.path, session, identity.role, 'file');
    if ('error' in resolved) return resolved;
    const { realPath, stat } = resolved;

    if (stat.size > FILE_FETCH_MAX_SIZE) {
      return { error: `文件过大: ${(stat.size / 1024 / 1024).toFixed(1)} MB (限制 ${FILE_FETCH_MAX_SIZE / 1024 / 1024} MB)`, code: 'FILE_TOO_LARGE' };
    }

    const adapter = this.adapters.get(channel);
    if (!adapter) return { error: '通道不存在', code: 'EXEC_FAILED' };
    if (!adapter.capabilities?.file) return { error: '通道不支持文件发送', code: 'NOT_SUPPORTED' };

    try {
      const replyCtx = session ? this.getReplyContext(session) : undefined;
      await adapter.send(
        buildEnvelope({ channel: adapter.channelName, channelId, replyContext: replyCtx }),
        { kind: 'result.file', filePath: realPath, correlationId: requestId },
      );
      return { data: { action: 'fetch', success: true, size: stat.size } };
    } catch (e: any) {
      return { error: `文件发送失败: ${e?.message ?? e}`, code: 'EXEC_FAILED' };
    }
  }

  return { error: `不支持 action: ${cmdBase}`, code: 'NOT_SUPPORTED' };
}

/** ECWeb 专用入口：注入 owner identity，进程级操作检查 owners 非空。不暴露 cli。 */
export async function execMenuForEcweb(this: any, payload: any): Promise<import('../../types.js').MenuResponse> {
  const id = payload?.id ?? '';
  const name = payload?.name;

  if (name === 'cli' || payload?.cmd === '/cli') {
    return { type: 'menu.response', id, name, error: { code: 'NOT_SUPPORTED', message: 'cli 不在 ECWeb 控制范围' } };
  }

  const isProcessLevel = name === 'system' || name === 'agent' || name === 'gateway' || name === 'config';
  const owners = loadEvolclawConfig().owners ?? [];
  if (isProcessLevel && owners.length === 0) {
    return { type: 'menu.response', id, name, error: { code: 'FORBIDDEN', message: '请在 evolclaw.json 配置 owners 后使用进程级操作' } };
  }

  const ECWEB_CHANNEL = '__ecweb__';
  // payload.agent（aid 或 name）时，用该 agent 的首个 channel 实例作为 channel 参数，
  // 让 execMenuQuery / execMenuUpdate 能按真实 agent 解析 model/effort/perm 等会话级配置。
  // system / agent 两个进程级 name 不走此路径，仍用 ECWEB_CHANNEL。
  const agentChannelKey = (() => {
    if (!payload?.agent || isProcessLevel) return ECWEB_CHANNEL;
    const handle = this.agentRegistry?.get(payload.agent) ?? null;
    return handle?.channelInstanceNames()?.[0] ?? ECWEB_CHANNEL;
  })();
  const ownerIdentity: import('../../types.js').SessionIdentity = { role: 'owner', mode: 'interactive' };
  // 进程级操作用 owners[0] 让 isProcessLevelOwner() 通过；其余传 undefined
  const userId = isProcessLevel ? (owners[0] ?? '') : undefined;

  const nameMap: Record<string, string> = {
    pwd: '/pwd', session: '/session', baseagent: '/baseagent', model: '/model',
    topic: '/topic',
    effort: '/effort', chatmode: '/chatmode', dispatch: '/dispatch',
    permission: '/perm', activity: '/activity', system: '/system',
    agent: '/agent', trigger: '/trigger', file: '/file', gateway: '/gateway',
    config: '/config', capability: '/capability',
  };
  const cmd = name ? (nameMap[name] ?? payload.cmd) : payload.cmd;

  try {
    switch (payload?.type) {
      case 'menu.list':
        return { type: 'menu.response', id, data: this.getMenuItems('owner', 'private', 'control') };

      case 'menu.query': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        const r = await this.execMenuQuery(cmd, agentChannelKey, agentChannelKey, userId, payload.args, undefined, true, ownerIdentity);
        return ecwebResp(id, name, r);
      }

      case 'menu.options': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        const data = await this.getSubMenuItems(cmd, agentChannelKey, agentChannelKey, userId, payload.args, ownerIdentity, undefined, true) ?? [];
        return { type: 'menu.response', id, name, data };
      }

      case 'menu.update': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        if (!payload.value) return ecwebErr(id, name, 'MISSING_VALUE', '缺少 value');
        const r = await this.execMenuUpdate(cmd, payload.value, agentChannelKey, agentChannelKey, userId, ownerIdentity, true, payload.args);
        return ecwebResp(id, name, r);
      }

      case 'menu.action': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        if (!payload.action) return ecwebErr(id, name, 'MISSING_VALUE', '缺少 action');
        const r = await this.execMenuAction(cmd, payload.action, payload.args, agentChannelKey, agentChannelKey, userId, ownerIdentity, undefined, id, true);
        return ecwebResp(id, name, r);
      }

      default:
        return ecwebErr(id, name, 'NOT_SUPPORTED', `未知类型: ${payload?.type}`);
    }
  } catch (e: any) {
    return ecwebErr(id, name, 'INTERNAL', e?.message ?? String(e));
  }
}

/** 控制 AID channel 专用入口：peerId 必须 ∈ evolclaw.owners。
 *  全量权限（进程级 + 跨 agent + 关系级），fromControlChannel=true 放行闸门。
 *  与 ECWeb 入口的区别：鉴权主体是真实 peerId（而非注入 owner），按 evolclaw.owners 校验。 */
export async function execMenuForControl(this: any, payload: any, peerId: string): Promise<import('../../types.js').MenuResponse> {
  const id = payload?.id ?? '';
  const name = payload?.name;

  const owners = loadEvolclawConfig().owners ?? [];
  if (!isProcessLevelOwner(peerId, owners)) {
    return { type: 'menu.response', id, ...(name ? { name } : {}), error: { code: 'FORBIDDEN', message: '控制 channel 操作需要 owner 权限' } };
  }

  if (name === 'cli' || payload?.cmd === '/cli') {
    return { type: 'menu.response', id, name, error: { code: 'NOT_SUPPORTED', message: 'cli 不在控制 channel 范围' } };
  }

  const CONTROL_CHANNEL = '__control__';
  const ownerIdentity: import('../../types.js').SessionIdentity = { role: 'owner', mode: 'interactive' };

  const nameMap: Record<string, string> = {
    pwd: '/pwd', session: '/session', baseagent: '/baseagent', model: '/model',
    topic: '/topic',
    effort: '/effort', chatmode: '/chatmode', dispatch: '/dispatch',
    permission: '/perm', activity: '/activity', system: '/system',
    agent: '/agent', trigger: '/trigger', file: '/file', gateway: '/gateway',
    config: '/config', capability: '/capability',
  };
  const cmd = name ? (nameMap[name] ?? payload.cmd) : payload.cmd;

  try {
    switch (payload?.type) {
      case 'menu.list':
        return { type: 'menu.response', id, data: this.getMenuItems('owner', 'private', 'control') };

      case 'menu.query': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        const r = await this.execMenuQuery(cmd, CONTROL_CHANNEL, CONTROL_CHANNEL, peerId, payload.args, undefined, true, ownerIdentity);
        return ecwebResp(id, name, r);
      }

      case 'menu.options': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        const data = await this.getSubMenuItems(cmd, CONTROL_CHANNEL, CONTROL_CHANNEL, peerId, payload.args, ownerIdentity, undefined, true) ?? [];
        return { type: 'menu.response', id, name, data };
      }

      case 'menu.update': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        if (!payload.value) return ecwebErr(id, name, 'MISSING_VALUE', '缺少 value');
        const r = await this.execMenuUpdate(cmd, payload.value, CONTROL_CHANNEL, CONTROL_CHANNEL, peerId, ownerIdentity, true, payload.args);
        return ecwebResp(id, name, r);
      }

      case 'menu.action': {
        if (!cmd) return ecwebErr(id, name, 'MISSING_CMD', '缺少 name/cmd');
        if (!payload.action) return ecwebErr(id, name, 'MISSING_VALUE', '缺少 action');
        const r = await this.execMenuAction(cmd, payload.action, payload.args, CONTROL_CHANNEL, CONTROL_CHANNEL, peerId, ownerIdentity, undefined, id, true);
        return ecwebResp(id, name, r);
      }

      default:
        return ecwebErr(id, name, 'NOT_SUPPORTED', `未知类型: ${payload?.type}`);
    }
  } catch (e: any) {
    return ecwebErr(id, name, 'INTERNAL', e?.message ?? String(e));
  }
}
