// 声明式 manifest 渲染引擎（共享）。
// 系统提示词渲染（kit-renderer）与消息渲染（message-renderer）共用同一套
// when 求值、模板渲染、路径解析、manifest 加载/缓存原语，避免两套实现漂移。

import fs from 'fs';
import path from 'path';
import { kitsDir, resolveRoot, getPackageRoot } from '../paths.js';
import { logger } from '../utils/logger.js';
import { fileCache } from '../core/cache/file-cache.js';

// ── Types ──

export type VarValue = string | boolean | number | undefined | null;
export type Vars = Record<string, VarValue>;

export interface ManifestSection {
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

export interface WhenCondition {
  var?: string;
  eq?: unknown;
  neq?: unknown;
  in?: unknown[];
  nin?: unknown[];
  any?: string[];
  all?: string[];
}

export interface RawManifest {
  $schema_version: number;
  mode?: 'patch' | 'replace';
  templatesDir?: string;
  sections: ManifestSection[];
}

export interface RenderContext {
  vars: Vars;
  sessionId: string;
}

// ── Manifest loading / cache ──
// manifest 定义随包发布、运行期靠 reload/重启刷新 → on-reload（group 'kits'）。
// base + eck override 合成结果以 base 文件路径为键缓存；loader 内读两个文件。

/** 清空所有 manifest 缓存（manifest 结构变更后调用，由 invalidateKitCache 串联）。 */
export function invalidateManifestCache(): void {
  fileCache.invalidateGroup('kits');
}

/**
 * 加载并合并 manifest。基础文件在 $KITS/<filename>，
 * 覆盖文件在 $EVOLCLAW_HOME/eck/<filename>（可选）。结果按 order 升序缓存。
 */
export function loadManifest(filename: string): ManifestSection[] {
  const kitsPath = path.join(kitsDir(), filename);
  return fileCache.get<ManifestSection[]>(
    kitsPath,
    () => {
      const sections = loadAndMergeManifest(filename);
      logger.info(`[ManifestEngine] Loaded ${filename}: ${sections.length} sections`);
      return sections;
    },
    { policy: 'on-reload', group: 'kits' },
  );
}

function loadAndMergeManifest(filename: string): ManifestSection[] {
  const kitsPath = path.join(kitsDir(), filename);
  const eckPath = path.join(resolveRoot(), 'eck', filename);

  let base: RawManifest;
  try {
    base = JSON.parse(fs.readFileSync(kitsPath, 'utf-8'));
  } catch (err) {
    logger.error(`[ManifestEngine] Failed to load kits/${filename}: ${err}`);
    return [];
  }

  if (!fs.existsSync(eckPath)) return sortSections(base.sections);

  try {
    const override: RawManifest = JSON.parse(fs.readFileSync(eckPath, 'utf-8'));
    if (override.mode === 'replace') return sortSections(override.sections);
    const merged = new Map<string, ManifestSection>();
    for (const s of base.sections) merged.set(s.id, { ...s });
    for (const s of override.sections) {
      const existing = merged.get(s.id);
      merged.set(s.id, existing ? { ...existing, ...s } : s);
    }
    return sortSections([...merged.values()]);
  } catch (err) {
    logger.warn(`[ManifestEngine] Failed to load eck override for ${filename}, using kits only: ${err}`);
    return sortSections(base.sections);
  }
}

function sortSections(sections: ManifestSection[]): ManifestSection[] {
  return sections.slice().sort((a, b) => a.order - b.order);
}
// ── When condition evaluation ──

export function evaluateWhen(when: 'always' | WhenCondition, vars: Vars): boolean {
  if (when === 'always') return true;
  if (when.var !== undefined) {
    const val = vars[when.var];
    if (when.eq !== undefined) {
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

export function isTruthy(val: VarValue): boolean {
  return val !== undefined && val !== null && val !== false && val !== '' && val !== 0;
}

// ── Template rendering ──

function resolveConditions(template: string, vars: Vars): string {
  // 只匹配**最内层** {{?...}}...{{/}} 块（逐字符负向前瞻排除嵌套），do/while 由内向外消解。
  const inner = /\{\{\?(\w+)(?:(!=|=)([^}]*))?\}\}((?:(?!\{\{\?)[^])*?)\{\{\/\}\}/;
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

/**
 * 渲染模板：条件块 + 变量替换。stripBlankLines=true 时删除空行（系统提示词用，
 * 紧凑）；false 时保留空行（消息正文用，正文多段结构不能被压扁）。
 */
export function renderTemplate(template: string, vars: Vars, stripBlankLines = true): string {
  let result = resolveConditions(template, vars);
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const val = vars[key];
    if (!isTruthy(val)) return '';
    return String(val);
  });
  if (stripBlankLines) return result.split('\n').filter(line => line.trim() !== '').join('\n');
  return result;
}
// ── Path resolution ──

export type ResolveStatus =
  | 'ok' | 'unresolved-vars' | 'not-exist'
  | 'skipped-disabled' | 'skipped-when' | 'no-path';

export interface ResolvePathResult {
  resolved: string | null;
  status: ResolveStatus;
  unresolvedTokens: string[];
}

export function resolvePathWithDiag(rawPath: string, vars: Vars): ResolvePathResult {
  const unresolved: string[] = [];
  let resolved = rawPath.replace(/\$([A-Z_]+)/g, (_m, name) => {
    const val = vars[name];
    if (val === undefined || val === null || val === false || val === '') {
      unresolved.push(`$${name}`);
      return '';
    }
    return String(val);
  });
  resolved = resolved.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    const val = vars[key];
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
    return { resolved, status: 'unresolved-vars', unresolvedTokens: unresolved };
  }
  // 路径规范化：模板里 ../ 等相对片段折叠成真实路径
  resolved = path.normalize(resolved);
  if (!fs.existsSync(resolved)) {
    return { resolved, status: 'not-exist', unresolvedTokens: unresolved };
  }
  return { resolved, status: 'ok', unresolvedTokens: unresolved };
}

function resolvePath(rawPath: string, vars: Vars): string | null {
  const r = resolvePathWithDiag(rawPath, vars);
  return r.status === 'ok' ? r.resolved : null;
}

// ── Section content loading ──

/** 返回 [filePath, rawContent][]；按 sessionId 缓存已读文件内容。 */
export function loadSectionFiles(
  section: ManifestSection,
  vars: Vars,
  sessionCache: Map<string, string>,
): [string, string][] {
  if (section.type === 'file' && section.file) {
    const result = loadFileSection(section.file, vars, sessionCache);
    return result ? [result] : [];
  }
  if (section.type === 'directory' && section.path) {
    const resolved = resolvePath(section.path, vars);
    if (!resolved) return [];
    return readDirectoryFiles(resolved, section.pattern)
      .map(([name, content]) => [path.join(resolved, name), content] as [string, string]);
  }
  return [];
}

function loadFileSection(
  filePath: string, vars: Vars, sessionCache: Map<string, string>,
): [string, string] | null {
  void sessionCache;  // 内容跨 session 共享，改走全局 fileCache（on-reload）
  const resolved = resolvePath(filePath, vars);
  if (!resolved) return null;
  // 内容跨 session 共享：用全局 fileCache（on-reload，reload/重启时失效），
  // 不再按 session 重复缓存同一文件内容。
  const content = fileCache.getText(resolved, { policy: 'on-reload', group: 'kits' });
  return content === null ? null : [resolved, content];
}

function readDirectoryFiles(dirPath: string, pattern?: string): [string, string][] {
  const glob = pattern || '*.md';
  // 目录列表 + 各文件内容均走 fileCache（on-reload）。目录列表以 "<dir>|<glob>"
  // 为键缓存文件名数组；各文件内容走 fileCache.getText 共享。
  const names = fileCache.get<string[]>(
    `${dirPath} ${glob}`,
    () => {
      try { return fs.readdirSync(dirPath).filter(f => matchGlob(f, glob)).sort(); }
      catch { return []; }
    },
    { policy: 'on-reload', group: 'kits' },
  );
  const out: [string, string][] = [];
  for (const f of names) {
    const fp = path.join(dirPath, f);
    const content = fileCache.getText(fp, { policy: 'on-reload', group: 'kits' });
    if (content !== null) out.push([f, content]);
  }
  return out;
}

function matchGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\{([^}]+)\}/g, (_, alts: string) => `(${alts.split(',').join('|')})`);
  return new RegExp(`^${regex}$`).test(filename);
}

// ── Path shortening (debug 输出用，把绝对路径回缩成别名) ──

interface PathMapping { prefix: string; alias: string; }

export function buildPathMappings(vars: Vars): PathMapping[] {
  const pkgRoot = getPackageRoot();
  const evolHome = String(vars['EVOLCLAW_HOME'] || resolveRoot());
  const selfAid = vars['selfAid'] ? String(vars['selfAid']) : '';
  const currentProject = vars['CURRENT_PROJECT'] ? String(vars['CURRENT_PROJECT']) : '';

  const mappings: PathMapping[] = [
    { prefix: path.join(pkgRoot, 'kits', 'rules'), alias: '$KITS_RULES' },
    { prefix: path.join(pkgRoot, 'kits', 'templates', 'system-fragments'), alias: '$KITS_FRAGMENTS' },
    { prefix: path.join(pkgRoot, 'kits', 'templates', 'message-fragments'), alias: '$KITS_MESSAGE_FRAGMENTS' },
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
  if (currentProject) mappings.push({ prefix: currentProject, alias: '$CURRENT_PROJECT' });
  mappings.sort((a, b) => b.prefix.length - a.prefix.length);
  return mappings;
}

export function shortenPath(filePath: string, mappings: PathMapping[]): string {
  const normalized = filePath.replace(/\\/g, '/');
  for (const { prefix, alias } of mappings) {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedPrefix)) {
      return alias + normalized.slice(normalizedPrefix.length);
    }
  }
  return filePath;
}
