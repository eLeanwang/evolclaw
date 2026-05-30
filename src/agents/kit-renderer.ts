import fs from 'fs';
import path from 'path';
import { kitsDir, eckDebugDir, resolveRoot, getPackageRoot } from '../paths.js';
import { logger } from '../utils/logger.js';

// ── Types ──

type VarValue = string | boolean | number | undefined | null;
type Vars = Record<string, VarValue>;

interface ManifestSection {
  id: string;
  type: 'file' | 'directory';
  file?: string;
  path?: string;
  pattern?: string;
  order: number;
  needsInjection: boolean;
  when: 'always' | WhenCondition;
  enabled?: boolean;
  description?: string;
}

interface WhenCondition {
  var?: string;
  eq?: unknown;
  neq?: unknown;
  in?: unknown[];
  nin?: unknown[];
  any?: string[];
  all?: string[];
}

interface RawManifest {
  $schema_version: number;
  mode?: 'patch' | 'replace';
  templatesDir?: string;
  sections: ManifestSection[];
}

export interface KitRenderContext {
  vars: Vars;
  sessionId: string;
}

// ── Param descriptions (for debug output) ──

const PARAM_DESCRIPTIONS: Record<string, string> = {
  EVOLCLAW_HOME: '用户数据根目录',
  PACKAGE_ROOT: 'evolclaw 包根目录',
  CURRENT_PROJECT: '当前项目完整路径',
  PERSONAL_DIR: '当前 agent 个人数据目录',
  RELATIONS_DIR: '当前 agent 关系数据目录',
  VENUES_DIR: '当前 agent 环境数据目录',
  selfAid: '当前 agent 的 AID',
  selfName: '当前 agent 的显示名',
  hasPersona: '是否有 persona 内容',
  hasWorkingMemory: '是否有 working memory',
  peerId: '对端在该渠道的原生 ID',
  peerKey: '对端跨渠道唯一标识（channel#urlEncode(peerId)）',
  peerName: '对端显示名',
  peerRole: '对端角色（owner/admin/guest/anonymous）',
  peerType: '对端类型（human/agent）',
  groupId: '群组 ID（群聊时）',
  chatType: '聊天类型（private=私聊 / group=群聊 / null=本地开发）',
  channel: '渠道类型（aun/feishu/wechat/dingtalk/qqbot/wecom）',
  venueUid: '场所唯一标识（预留）',
  dispatch: '群分发模式（mention=被@才响应 / broadcast=所有消息都响应）',
  clientType: '客户端类型（desktop/web/mobile）',
  permissionMode: '权限模式（auto/bypass/request/edit/plan/noask/readonly）',
  capabilities: '当前渠道支持的能力列表',
  project: '当前项目目录名',
  sessionId: 'evolclaw 会话 ID',
  sessionName: '会话名称',
  sessionKey: '会话路由键（channelType#urlEncode(channelId)#urlEncode(threadId)）',
  sessionCreatedAt: '会话创建时间（ISO）',
  threadId: '话题 ID（多话题路由时）',
  chatMode: '会话模式（interactive=同步交互 / proactive=主动推送）',
  readonly: '是否只读模式',
  baseAgent: 'base agent 规范值（claude/codex/gemini/hermes）',
  baseAgentName: 'base agent 显示名',
  baseAgentModel: 'base agent 使用的模型',
  agentSessionId: 'base agent 会话 ID',
};

// ── Path shortening ──

interface PathMapping {
  prefix: string;
  alias: string;
}

function buildPathMappings(vars: Vars): PathMapping[] {
  const pkgRoot = getPackageRoot();
  const evolHome = String(vars['EVOLCLAW_HOME'] || resolveRoot());
  const selfAid = vars['selfAid'] ? String(vars['selfAid']) : '';
  const currentProject = vars['CURRENT_PROJECT'] ? String(vars['CURRENT_PROJECT']) : '';

  const mappings: PathMapping[] = [
    { prefix: path.join(pkgRoot, 'kits', 'rules'), alias: '$KITS_RULES' },
    { prefix: path.join(pkgRoot, 'kits', 'templates', 'system-fragments'), alias: '$KITS_FRAGMENTS' },
    { prefix: path.join(pkgRoot, 'kits', 'templates'), alias: '$KITS_TEMPLATES' },
    { prefix: path.join(pkgRoot, 'kits', 'docs'), alias: '$KITS_DOCS' },
    { prefix: path.join(pkgRoot, 'kits'), alias: '$KITS' },
    { prefix: pkgRoot, alias: '$PACKAGE_ROOT' },
  ];

  if (selfAid) {
    mappings.push({ prefix: path.join(evolHome, 'agents', selfAid, 'personal'), alias: '$PERSONAL_DIR' });
    mappings.push({ prefix: path.join(evolHome, 'agents', selfAid, 'relations'), alias: '$RELATIONS_DIR' });
    mappings.push({ prefix: path.join(evolHome, 'agents', selfAid, 'venues'), alias: '$VENUES_DIR' });
    mappings.push({ prefix: path.join(evolHome, 'agents', selfAid), alias: '$AGENT_DIR' });
  }
  mappings.push({ prefix: evolHome, alias: '$EVOLCLAW_HOME' });

  if (currentProject) {
    mappings.push({ prefix: currentProject, alias: '$CURRENT_PROJECT' });
  }

  // Sort by prefix length descending so longer (more specific) paths match first
  mappings.sort((a, b) => b.prefix.length - a.prefix.length);
  return mappings;
}

function shortenPath(filePath: string, mappings: PathMapping[]): string {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { prefix, alias } of mappings) {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedPrefix)) {
      const rest = normalized.slice(normalizedPrefix.length);
      return alias + rest;
    }
  }
  return filePath;
}

// ── Cache ──

let _manifestCache: ManifestSection[] | null = null;
const _sessionPathCache = new Map<string, Map<string, string>>();

// ── Public API ──

export function loadKitManifest(): void {
  _manifestCache = loadAndMergeManifest();
  logger.info(`[KitRenderer] Loaded manifest: ${_manifestCache.length} sections`);
}

export function invalidateKitCache(): void {
  _manifestCache = null;
  _sessionPathCache.clear();
}

export function invalidateSessionCache(sessionId: string): void {
  _sessionPathCache.delete(sessionId);
}

interface SectionDiagnostic {
  id: string;
  description?: string;
  type: 'file' | 'directory';
  rawPath: string;
  pattern?: string;
  needsInjection?: boolean;
  when?: unknown;
  enabled: boolean;
  whenPassed: boolean;
  resolvedPath: string | null;
  resolveStatus: 'ok' | 'unresolved-vars' | 'not-exist' | 'skipped-disabled' | 'skipped-when' | 'no-path';
  unresolvedTokens?: string[];
  fileCount: number;
  emptyContent?: boolean;
  used: boolean;
  injected: boolean;
}

export function renderKitSections(ctx: KitRenderContext): string {
  if (!_manifestCache) loadKitManifest();
  const sections = _manifestCache!;
  const fileParts: string[] = [];
  const fragmentParts: string[] = [];
  const pathMappings = buildPathMappings(ctx.vars);
  const diagnostics: SectionDiagnostic[] = [];

  for (const section of sections) {
    const rawPath = section.type === 'file' ? (section.file ?? '') : (section.path ?? '');
    const diag: SectionDiagnostic = {
      id: section.id,
      description: section.description,
      type: section.type,
      rawPath,
      pattern: section.pattern,
      needsInjection: section.needsInjection,
      when: section.when,
      enabled: section.enabled !== false,
      whenPassed: false,
      resolvedPath: null,
      resolveStatus: 'no-path',
      fileCount: 0,
      used: false,
      injected: false,
    };

    if (section.enabled === false) {
      diag.resolveStatus = 'skipped-disabled';
      diagnostics.push(diag);
      continue;
    }
    diag.whenPassed = evaluateWhen(section.when, ctx.vars);
    if (!diag.whenPassed) {
      diag.resolveStatus = 'skipped-when';
      diagnostics.push(diag);
      continue;
    }

    if (rawPath) {
      const resolveResult = resolvePathWithDiag(rawPath, ctx);
      diag.resolvedPath = resolveResult.resolved;
      diag.resolveStatus = resolveResult.status;
      if (resolveResult.unresolvedTokens.length > 0) diag.unresolvedTokens = resolveResult.unresolvedTokens;
    }

    const files = loadSectionFiles(section, ctx);
    diag.fileCount = files.length;
    if (files.length === 0) {
      diagnostics.push(diag);
      continue;
    }

    let anyUsed = false;
    for (const [filePath, rawContent] of files) {
      const content = section.needsInjection ? renderTemplate(rawContent, ctx.vars) : rawContent;
      if (!content.trim()) {
        diag.emptyContent = true;
        continue;
      }
      const label = section.description ? `${section.id} — ${section.description}` : section.id;
      const displayPath = shortenPath(filePath, pathMappings);
      const part = `Contenu de ${displayPath} (${label}):\n\n${content.trimEnd()}`;
      fileParts.push(part);
      anyUsed = true;
      if (section.needsInjection) {
        fragmentParts.push(part);
        diag.injected = true;
      }
    }
    diag.used = anyUsed;
    diagnostics.push(diag);
  }

  const body = fileParts.join('\n\n');
  const output = fileParts.length > 0
    ? `<system-reminder>\nEvolClaw Context Kit documents are shown below.\n\n${body}\n\nIMPORTANT: Use this context when it affects the current interaction.\n</system-reminder>`
    : '';
  const fragmentsOutput = fragmentParts.length > 0 ? fragmentParts.join('\n\n') : '';
  writeDebugFiles(ctx, output, fragmentsOutput, diagnostics);
  return output;
}

export function cleanEckDebug(): void {
  const dir = eckDebugDir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist yet */ }
}
// CHUNK_CONTINUE_2

// ── Manifest loading ──

function loadAndMergeManifest(): ManifestSection[] {
  const kitsPath = path.join(kitsDir(), 'eck_manifest.json');
  const eckPath = path.join(resolveRoot(), 'eck', 'eck_manifest.json');

  let base: RawManifest;
  try {
    base = JSON.parse(fs.readFileSync(kitsPath, 'utf-8'));
  } catch (err) {
    logger.error(`[KitRenderer] Failed to load kits/eck_manifest.json: ${err}`);
    return [];
  }

  if (!fs.existsSync(eckPath)) {
    return sortSections(base.sections);
  }

  try {
    const override: RawManifest = JSON.parse(fs.readFileSync(eckPath, 'utf-8'));
    if (override.mode === 'replace') {
      return sortSections(override.sections);
    }
    const merged = new Map<string, ManifestSection>();
    for (const s of base.sections) merged.set(s.id, { ...s });
    for (const s of override.sections) {
      const existing = merged.get(s.id);
      if (existing) {
        merged.set(s.id, { ...existing, ...s });
      } else {
        merged.set(s.id, s);
      }
    }
    return sortSections([...merged.values()]);
  } catch (err) {
    logger.warn(`[KitRenderer] Failed to load eck override, using kits only: ${err}`);
    return sortSections(base.sections);
  }
}

function sortSections(sections: ManifestSection[]): ManifestSection[] {
  return sections.slice().sort((a, b) => a.order - b.order);
}

// ── Section content loading ──

function loadSectionFiles(section: ManifestSection, ctx: KitRenderContext): [string, string][] {
  if (section.type === 'file' && section.file) {
    const result = loadFileSection(section.file, ctx);
    return result ? [result] : [];
  }
  if (section.type === 'directory' && section.path) {
    return loadDirectorySection(section.path, section.pattern, ctx);
  }
  return [];
}

function loadFileSection(filePath: string, ctx: KitRenderContext): [string, string] | null {
  const resolved = resolvePath(filePath, ctx);
  if (!resolved) return null;

  const sessionCache = getSessionCache(ctx.sessionId);
  if (sessionCache.has(resolved)) return [resolved, sessionCache.get(resolved)!];

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    sessionCache.set(resolved, content);
    return [resolved, content];
  } catch {
    return null;
  }
}

function loadDirectorySection(dirPath: string, pattern: string | undefined, ctx: KitRenderContext): [string, string][] {
  const resolved = resolvePath(dirPath, ctx);
  if (!resolved) return [];
  return readDirectoryFiles(resolved, pattern).map(([name, content]) => [path.join(resolved, name), content] as [string, string]);
}

// ── Path resolution ──

function resolvePath(rawPath: string, ctx: KitRenderContext): string | null {
  const r = resolvePathWithDiag(rawPath, ctx);
  return r.status === 'ok' ? r.resolved : null;
}

interface ResolvePathResult {
  resolved: string | null;
  status: SectionDiagnostic['resolveStatus'];
  unresolvedTokens: string[];
}

function resolvePathWithDiag(rawPath: string, ctx: KitRenderContext): ResolvePathResult {
  const unresolved: string[] = [];
  let resolved = rawPath.replace(/\$([A-Z_]+)/g, (_m, name) => {
    const val = ctx.vars[name];
    if (val === undefined || val === null || val === false || val === '') {
      unresolved.push(`$${name}`);
      return '';
    }
    return String(val);
  });
  resolved = resolved.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const val = ctx.vars[key];
    if (val === undefined || val === null || val === false || val === '') {
      unresolved.push(`{{${key}}}`);
      return '';
    }
    return String(val);
  });
  if (!resolved || resolved.includes('$') || resolved.includes('{{')) {
    return { resolved: resolved || null, status: 'unresolved-vars', unresolvedTokens: unresolved };
  }
  if (unresolved.length > 0) {
    // 占位符是非必需变量，但有的解析为空——视为未解析
    return { resolved, status: 'unresolved-vars', unresolvedTokens: unresolved };
  }
  if (!fs.existsSync(resolved)) {
    return { resolved, status: 'not-exist', unresolvedTokens: unresolved };
  }
  return { resolved, status: 'ok', unresolvedTokens: unresolved };
}
// CHUNK_CONTINUE_5

// ── Directory reading ──

function readDirectoryFiles(dirPath: string, pattern?: string): [string, string][] {
  const glob = pattern || '*.md';
  try {
    const files = fs.readdirSync(dirPath)
      .filter(f => matchGlob(f, glob))
      .sort();
    return files.map(f => {
      const content = fs.readFileSync(path.join(dirPath, f), 'utf-8');
      return [f, content] as [string, string];
    });
  } catch {
    return [];
  }
}

function matchGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\{([^}]+)\}/g, (_, alts: string) => `(${alts.split(',').join('|')})`);
  return new RegExp(`^${regex}$`).test(filename);
}

// ── When condition evaluation ──

function evaluateWhen(when: 'always' | WhenCondition, vars: Vars): boolean {
  if (when === 'always') return true;
  if (when.var !== undefined) {
    const val = vars[when.var];
    if (when.eq !== undefined) {
      // 把 undefined 视作 null 的等价物，便于 manifest 用 eq:null/neq:null 表达"未注入"
      if (when.eq === null) return val === null || val === undefined;
      return val === when.eq;
    }
    if (when.neq !== undefined) {
      if (when.neq === null) return val !== null && val !== undefined;
      return val !== when.neq;
    }
    if (when.in !== undefined) return (when.in as unknown[]).includes(val);
    if (when.nin !== undefined) return !(when.nin as unknown[]).includes(val);
  }
  if (when.any) return when.any.some(k => isTruthy(vars[k]));
  if (when.all) return when.all.every(k => isTruthy(vars[k]));
  return true;
}

function isTruthy(val: VarValue): boolean {
  return val !== undefined && val !== null && val !== false && val !== '' && val !== 0;
}
// CHUNK_CONTINUE_6

// ── Template rendering ──

function resolveConditions(template: string, vars: Vars): string {
  // Find innermost {{?...}}...{{/}} block (no nested {{? inside) and resolve it.
  // Repeat until no blocks remain.
  const inner = /\{\{\?(\w+)(?:(!=|=)([^}]*))?\}\}([^]*?)\{\{\/\}\}/;
  let result = template;
  let prev: string;
  do {
    prev = result;
    result = result.replace(inner, (_match, key, op, value, body) => {
      if (op === '=') return String(vars[key]) === value ? body : '';
      if (op === '!=') return String(vars[key]) !== value ? body : '';
      return isTruthy(vars[key]) ? body : '';
    });
  } while (result !== prev);
  return result;
}

function renderTemplate(template: string, vars: Vars): string {
  // Pass 1: resolve nested conditionals inside-out
  let result = resolveConditions(template, vars);

  // Pass 2: variable substitution {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const val = vars[key];
    if (!isTruthy(val)) return '';
    return String(val);
  });

  // Pass 3: remove blank lines
  return result.split('\n').filter(line => line.trim() !== '').join('\n');
}

// ── Session cache helper ──

function getSessionCache(sessionId: string): Map<string, string> {
  let cache = _sessionPathCache.get(sessionId);
  if (!cache) {
    cache = new Map();
    _sessionPathCache.set(sessionId, cache);
  }
  return cache;
}

// ── Debug output ──

function writeDebugFiles(ctx: KitRenderContext, output: string, fragmentsOutput: string, diagnostics: SectionDiagnostic[]): void {
  const now = new Date();
  const ts = now.toISOString().replace(/[T:.]/g, '-').slice(0, 19);
  const dir = eckDebugDir();

  const varsData = {
    timestamp: now.toISOString(),
    sessionId: ctx.sessionId,
    params: Object.entries(ctx.vars)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([name, value]) => ({
        name,
        value,
        description: PARAM_DESCRIPTIONS[name] || '',
      })),
  };

  fs.writeFile(path.join(dir, `vars-${ts}.json`), JSON.stringify(varsData, null, 2), () => {});
  if (output) fs.writeFile(path.join(dir, `context-${ts}.md`), output, () => {});
  if (fragmentsOutput) {
    fs.writeFile(path.join(dir, `fragments-${ts}.md`), fragmentsOutput, () => {});
  }

  fs.writeFile(path.join(dir, `manifest-${ts}.md`), formatManifestDiagnostics(ctx, diagnostics), () => {});
}

function formatManifestDiagnostics(ctx: KitRenderContext, diagnostics: SectionDiagnostic[]): string {
  const STATUS_ICON: Record<SectionDiagnostic['resolveStatus'], string> = {
    'ok': 'OK',
    'unresolved-vars': 'UNRESOLVED-VARS',
    'not-exist': 'NOT-EXIST',
    'skipped-disabled': 'SKIPPED(disabled)',
    'skipped-when': 'SKIPPED(when)',
    'no-path': 'NO-PATH',
  };

  const used = diagnostics.filter(d => d.used).length;
  const skippedWhen = diagnostics.filter(d => d.resolveStatus === 'skipped-when').length;
  const errors = diagnostics.filter(d => d.resolveStatus === 'unresolved-vars' || d.resolveStatus === 'not-exist').length;

  const lines: string[] = [];
  lines.push(`# ECK Manifest Diagnostics`);
  lines.push('');
  lines.push(`- timestamp: ${new Date().toISOString()}`);
  lines.push(`- sessionId: ${ctx.sessionId}`);
  lines.push(`- sections total: ${diagnostics.length}`);
  lines.push(`- sections used: ${used}`);
  lines.push(`- sections skipped (when=false): ${skippedWhen}`);
  lines.push(`- sections with errors (unresolved-vars/not-exist): ${errors}`);
  lines.push('');

  if (errors > 0) {
    lines.push(`## Errors`);
    lines.push('');
    for (const d of diagnostics) {
      if (d.resolveStatus !== 'unresolved-vars' && d.resolveStatus !== 'not-exist') continue;
      lines.push(`### ${d.id}${d.description ? ' — ' + d.description : ''}`);
      lines.push(`- status: ${STATUS_ICON[d.resolveStatus]}`);
      lines.push(`- type: ${d.type}`);
      lines.push(`- raw path: \`${d.rawPath}\``);
      lines.push(`- resolved: \`${d.resolvedPath ?? '(null)'}\``);
      if (d.unresolvedTokens && d.unresolvedTokens.length > 0) {
        lines.push(`- unresolved tokens: ${d.unresolvedTokens.map(t => '`' + t + '`').join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push(`## All sections`);
  lines.push('');
  lines.push(`| order | id | status | type | raw path | resolved | files | used | injected |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  diagnostics.forEach((d, idx) => {
    const status = STATUS_ICON[d.resolveStatus];
    const rawPath = d.rawPath ? '`' + d.rawPath + '`' : '—';
    const resolvedShort = d.resolvedPath ? '`' + (d.resolvedPath.length > 60 ? '…' + d.resolvedPath.slice(-58) : d.resolvedPath) + '`' : '—';
    lines.push(`| ${idx + 1} | ${d.id} | ${status} | ${d.type} | ${rawPath} | ${resolvedShort} | ${d.fileCount} | ${d.used ? 'Y' : '·'} | ${d.injected ? 'Y' : '·'} |`);
  });
  lines.push('');

  // 详细列出每个 section
  lines.push(`## Section details`);
  lines.push('');
  for (const d of diagnostics) {
    lines.push(`### ${d.id}${d.description ? ' — ' + d.description : ''}`);
    lines.push(`- status: ${STATUS_ICON[d.resolveStatus]}`);
    lines.push(`- type: ${d.type}`);
    if (d.rawPath) lines.push(`- raw path: \`${d.rawPath}\``);
    if (d.pattern) lines.push(`- pattern: \`${d.pattern}\``);
    if (d.when !== undefined) lines.push(`- when: \`${JSON.stringify(d.when)}\` → ${d.whenPassed ? 'true' : 'false'}`);
    lines.push(`- needsInjection: ${d.needsInjection ? 'true' : 'false'}`);
    lines.push(`- enabled: ${d.enabled}`);
    if (d.resolvedPath) lines.push(`- resolved: \`${d.resolvedPath}\``);
    if (d.unresolvedTokens && d.unresolvedTokens.length > 0) {
      lines.push(`- unresolved tokens: ${d.unresolvedTokens.map(t => '`' + t + '`').join(', ')}`);
    }
    lines.push(`- file count: ${d.fileCount}`);
    if (d.emptyContent) lines.push(`- note: 文件存在但渲染后内容为空`);
    lines.push(`- used in output: ${d.used ? 'yes' : 'no'}`);
    lines.push(`- injected as fragment: ${d.injected ? 'yes' : 'no'}`);
    lines.push('');
  }

  return lines.join('\n');
}

