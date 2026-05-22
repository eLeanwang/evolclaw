import fs from 'fs';
import path from 'path';
import { kitsDir, eckDebugDir, resolveRoot } from '../paths.js';
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
  selfAid: '当前 agent 的 AID',
  selfName: '当前 agent 的显示名',
  hasPersona: '是否有 persona 内容',
  hasWorkingMemory: '是否有 working memory',
  peerId: '对端在该渠道的原生 ID',
  peerKey: '对端跨渠道唯一标识（channel#urlEncode(peerId)）',
  peerName: '对端显示名',
  peerRole: '对端角色',
  groupId: '群组 ID（群聊时）',
  scene: '场景类型',
  chatType: '聊天类型',
  channel: '当前渠道',
  venueUid: 'venue 唯一标识',
  project: '当前项目目录名（由 CURRENT_PROJECT 派生）',
  sessionName: '会话名称',
  sessionMode: '会话模式',
  readonly: '是否只读模式',
  canSendFile: '当前渠道是否支持发文件',
  capabilities: '渠道能力列表',
  baseAgent: '当前 base agent 规范值（claude/codex/gemini/hermes）',
  baseAgentName: '当前 base agent 显示名',
};

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

export function renderKitSections(ctx: KitRenderContext): string {
  if (!_manifestCache) loadKitManifest();
  const sections = _manifestCache!;
  const fileParts: string[] = [];

  for (const section of sections) {
    if (section.enabled === false) continue;
    if (!evaluateWhen(section.when, ctx.vars)) continue;

    const files = loadSectionFiles(section, ctx);
    if (files.length === 0) continue;

    for (const [filePath, rawContent] of files) {
      const content = section.needsInjection ? renderTemplate(rawContent, ctx.vars) : rawContent;
      if (!content.trim()) continue;
      const label = section.description ? `${section.id} — ${section.description}` : section.id;
      fileParts.push(`Contenu de ${filePath} (${label}):\n\n${content.trimEnd()}`);
    }
  }

  if (fileParts.length === 0) return '';

  const body = fileParts.join('\n\n');
  const output = `<system-reminder>\nEvolClaw Context Kit documents are shown below.\n\n${body}\n\nIMPORTANT: Use this context when it affects the current interaction.\n</system-reminder>`;
  writeDebugFiles(ctx, output);
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
  let resolved = rawPath.replace(/\$([A-Z_]+)/g, (_, name) => {
    const val = ctx.vars[name];
    if (val === undefined || val === null || val === false || val === '') return '';
    return String(val);
  });
  resolved = resolved.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = ctx.vars[key];
    if (val === undefined || val === null || val === false || val === '') return '';
    return String(val);
  });
  if (!resolved || resolved.includes('$') || resolved.includes('{{')) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
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
    if (when.eq !== undefined) return val === when.eq;
    if (when.neq !== undefined) return val !== when.neq;
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

function renderTemplate(template: string, vars: Vars): string {
  // Pass 1: conditional sections {{?key=value}}...{{/}} and {{?key}}...{{/}}
  let result = template.replace(/\{\{\?(\w+)(?:=([^}]*))?\}\}([\s\S]*?)\{\{\/\}\}/g, (_match, key, value, body) => {
    if (value !== undefined) {
      return String(vars[key]) === value ? body : '';
    }
    return isTruthy(vars[key]) ? body : '';
  });

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

function writeDebugFiles(ctx: KitRenderContext, output: string): void {
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
  fs.writeFile(path.join(dir, `context-${ts}.md`), output, () => {});
}

