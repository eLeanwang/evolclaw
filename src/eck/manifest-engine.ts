// 声明式 manifest 渲染引擎（共享）。
// 系统提示词渲染（kit-renderer）与消息渲染（message-renderer）共用同一套
// when 求值、模板渲染、路径解析、manifest 加载/缓存原语，避免两套实现漂移。

import fs from 'fs';
import path from 'path';
import { kitsDir, resolveRoot, getPackageRoot } from '../paths.js';
import { logger } from '../utils/logger.js';
import { fileCache } from '../core/daemon-file-cache.js';

// ── Types ──

export type VarValue = string | boolean | number | undefined | null | VarValue[] | { [k: string]: VarValue };
export type Vars = Record<string, VarValue>;

export interface ManifestSection {
  id: string;
  type: 'file' | 'directory';
  file?: string;
  path?: string;
  pattern?: string;
  /** 目录段：最多加载文件数（默认 DIR_MAX_FILES=20）。仅 type=directory 生效。 */
  maxFiles?: number;
  /** 目录段：最多加载总字节（默认 DIR_MAX_BYTES=40960=40KB）。仅 type=directory 生效。 */
  maxBytes?: number;
  order: number;
  needsInjection: boolean;
  when: 'always' | WhenCondition;
  enabled?: boolean;
  description?: string;
  // ── 三段式循环（wrapper + forEach + child）。可选。
  //    有 loop 时：file 作为 wrapper 模板（含 {{@loop}} 占位），
  //    对 vars[loop.forEach] 数组每个元素渲染 loop.childFile，拼接后填入 {{@loop}}。
  //    仅 needsInjection:true 生效（loop 必然要模板渲染）。
  loop?: LoopSpec;
  // ── 消息渲染模式（类型 + 名称）。引擎本身忽略这三个字段（命中仍只靠 when）；
  //    仅 message-renderer 用它们算「config 未配时回退到 isDefault 的模式名」。
  //    详见 docs/observer-insert-design.md 第二部分。
  modeType?: 'private' | 'group' | 'inject';
  modeName?: string;
  isDefault?: boolean;
}

/** 三段式循环规格。 */
export interface LoopSpec {
  /** vars 中的数组变量名（元素为对象 → 字段可在 child 模板用 {{field}} 访问；标量 → {{.}}）。 */
  forEach: string;
  /** 每元素渲染的子模板文件路径（可含 $NAME / {{key}}）。 */
  childFile: string;
  /** 元素之间的分隔符，默认换行 "\n"。可设为 ""（无分隔）、"\n\n"（空行分段）等。 */
  separator?: string;
}

export interface WhenCondition {
  var?: string;
  eq?: unknown;
  neq?: unknown;
  in?: unknown[];
  nin?: unknown[];
  any?: string[];
  all?: string[];
  /** 复合 AND：全部子条件成立才命中（用于「item 类型 + 激活模式」这类多维匹配）。 */
  and?: WhenCondition[];
  /** 复合 OR：任一子条件成立即命中。 */
  or?: WhenCondition[];
}

export interface RawManifest {
  $schema_version: number;
  mode?: 'patch' | 'replace';
  templatesDir?: string;
  /** 整个清单渲染最多文件数（默认 TOTAL_MAX_FILES=50）。跨所有段累计。 */
  totalMaxFiles?: number;
  /** 整个清单渲染最多总字节（默认 TOTAL_MAX_BYTES=102400=100KB）。跨所有段累计。 */
  totalMaxBytes?: number;
  sections: ManifestSection[];
}

// ── 限额默认值 ──
/** 单目录段默认最多文件数 */
export const DIR_MAX_FILES = 20;
/** 单目录段默认最多总字节（40KB） */
export const DIR_MAX_BYTES = 40 * 1024;
/** 整个清单默认最多文件数 */
export const TOTAL_MAX_FILES = 50;
/** 整个清单默认最多总字节（100KB） */
export const TOTAL_MAX_BYTES = 100 * 1024;

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

/** 清单顶层限额（总闸）。缺省时用默认常量。 */
export interface ManifestMeta {
  totalMaxFiles: number;
  totalMaxBytes: number;
}

/**
 * 读取清单顶层总闸限额（base + eck override 合并，override 优先）。
 * 与 loadManifest 分开，避免改动现有 `ManifestSection[]` 返回契约。
 */
export function loadManifestMeta(filename: string): ManifestMeta {
  const kitsPath = path.join(kitsDir(), filename);
  return fileCache.get<ManifestMeta>(
    `${kitsPath}#meta`,
    () => {
      const kits = readRawManifest(kitsPath);
      const eck = readRawManifest(path.join(resolveRoot(), 'eck', filename));
      return {
        totalMaxFiles: eck?.totalMaxFiles ?? kits?.totalMaxFiles ?? TOTAL_MAX_FILES,
        totalMaxBytes: eck?.totalMaxBytes ?? kits?.totalMaxBytes ?? TOTAL_MAX_BYTES,
      };
    },
    { policy: 'on-reload', group: 'kits' },
  );
}

function readRawManifest(p: string): RawManifest | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 从 manifest 抽出每个 modeType 标了 isDefault 的 modeName。
 * 供 message-renderer 在 agent config.render 未配某类型时回退。
 * 同一 modeType 有多个 isDefault 时取 order 最小（已排序）的第一个。
 */
export function defaultModeNames(sections: ManifestSection[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sections) {
    if (s.modeType && s.isDefault && s.modeName && out[s.modeType] === undefined) {
      out[s.modeType] = s.modeName;
    }
  }
  return out;
}
// ── When condition evaluation ──

export function evaluateWhen(when: 'always' | WhenCondition, vars: Vars): boolean {
  if (when === 'always') return true;
  // 复合条件优先：and / or 递归求值。
  if (when.and) return when.and.every(c => evaluateWhen(c, vars));
  if (when.or) return when.or.some(c => evaluateWhen(c, vars));
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
  if (Array.isArray(val)) return val.length > 0;  // 空数组视为假，使 {{?arr}} / {{#each}} 落空
  return val !== undefined && val !== null && val !== false && val !== '' && val !== 0;
}

// ── Template rendering ──

/**
 * 展开 {{#each KEY}}BODY{{/each}} 循环块（在条件/变量替换之前跑）。
 * - vars[KEY] 为非空数组才展开；每个元素构造子作用域：
 *     对象元素 → { ...vars, ...el }（字段可用 {{field}} 访问）
 *     标量元素 → { ...vars, '.': el }（{{.}} 访问当前元素）
 *   另注入 {{@index}}（0 基序号）。
 * - body 经完整 renderTemplate 递归渲染，天然支持嵌套 each / 条件。
 * - 非数组或空数组 → 整块渲染为空串。
 * 用深度扫描定位**最外层** each 块（正则无法平衡嵌套），从外向内展开。
 */
function resolveEach(template: string, vars: Vars, stripBlankLines: boolean): string {
  const OPEN = /\{\{#each\s+([A-Za-z_]\w*)\}\}/g;
  let result = '';
  let cursor = 0;
  OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN.exec(template)) !== null) {
    const blockStart = m.index;
    const key = m[1];
    const bodyStart = OPEN.lastIndex;
    // 从 bodyStart 起按深度找配对的 {{/each}}
    const TOKEN = /\{\{#each\s+[A-Za-z_]\w*\}\}|\{\{\/each\}\}/g;
    TOKEN.lastIndex = bodyStart;
    let depth = 1;
    let bodyEnd = -1;
    let blockEnd = -1;
    let t: RegExpExecArray | null;
    while ((t = TOKEN.exec(template)) !== null) {
      if (t[0].startsWith('{{#each')) depth++;
      else { depth--; if (depth === 0) { bodyEnd = t.index; blockEnd = TOKEN.lastIndex; break; } }
    }
    if (bodyEnd === -1) break;  // 无配对，剩余原样输出
    // 输出块前的原文
    result += template.slice(cursor, blockStart);
    const body = template.slice(bodyStart, bodyEnd);
    const arr = vars[key];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const el = arr[i];
        const scope: Vars = (el && typeof el === 'object' && !Array.isArray(el))
          ? { ...vars, ...(el as Record<string, VarValue>), '@index': i }
          : { ...vars, '.': el as VarValue, '@index': i };
        result += renderTemplate(body, scope, stripBlankLines);
      }
    }
    // 数组以外（含 undefined / 非数组）→ 整块跳过（不输出）
    cursor = blockEnd;
    OPEN.lastIndex = blockEnd;
  }
  result += template.slice(cursor);
  return result;
}

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
  let result = resolveEach(template, vars, stripBlankLines);
  result = resolveConditions(result, vars);
  // 变量替换：支持普通名、当前元素 {{.}}、循环序号 {{@index}}。
  result = result.replace(/\{\{(\.|@index|\w+)\}\}/g, (_match, key) => {
    const val = vars[key];
    if (!isTruthy(val) && val !== 0) return '';  // 0 是有效序号/值，保留
    if (val === 0) return '0';
    return String(val);
  });
  if (stripBlankLines) return result.split('\n').filter(line => line.trim() !== '').join('\n');
  return result;
}

/**
 * 三段式循环渲染：wrapper 里的 `{{@loop}}` 占位处，用 childTpl 对 vars[forEach]
 * 数组每个元素渲染并拼接后填入。复用现有 `{{#each}}` 原语（不新写循环）：
 *   把 wrapper 的 `{{@loop}}` 替换为 `{{#each forEach}}<childTpl>{{/each}}`，整体丢给 renderTemplate。
 * 因此 childTpl 内可再嵌套 `{{#each}}`、访问元素字段与外层 vars（子作用域已合并）。
 *
 * 若 wrapper 不含 `{{@loop}}`，childTpl 循环结果直接追加到 wrapper 末尾（容错）。
 */
/**
 * 三段式循环渲染：对 vars[forEach] 数组每个元素渲染 childTpl，以 separator 连接，
 * 填入 wrapperTpl 的 `{{@loop}}` 占位处。
 *
 * - 每个元素构造子作用域（对象元素 → { ...vars, ...el, '@index': i }；标量 → { ...vars, '.': el, '@index': i }），
 *   因此 childTpl 内可访问元素字段、外层 vars、`{{@index}}`，也可再嵌套 `{{#each}}` / 另一个占位。
 * - separator 默认换行；可为 ""（无分隔）、"\n\n" 等。
 * - onElementScope 可选钩子：在渲染每个元素前修改其子作用域（供 message-renderer 做 content 哨兵化）。
 * - wrapper 不含 `{{@loop}}` 时，循环结果追加到 wrapper 末尾（容错）。
 * - 空数组 / 非数组 → 循环结果为空串。
 */
export function renderLoopSection(
  wrapperTpl: string, childTpl: string, forEach: string,
  vars: Vars, stripBlankLines = true,
  separator = '\n',
  onElementScope?: (scope: Vars, index: number) => void,
): string {
  const arr = vars[forEach];
  const parts: string[] = [];
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      const scope: Vars = (el && typeof el === 'object' && !Array.isArray(el))
        ? { ...vars, ...(el as Record<string, VarValue>), '@index': i }
        : { ...vars, '.': el as VarValue, '@index': i };
      if (onElementScope) onElementScope(scope, i);
      parts.push(renderTemplate(childTpl, scope, stripBlankLines));
    }
  }
  const loopResult = parts.join(separator);
  // wrapper 用哨兵占位 {{@loop}} → 先渲染 wrapper 外层变量，再字面量替换回 loopResult，
  // 避免已渲染的 loopResult（可能含元素文本里的 {{}}）被二次解析。
  const LOOP_SENTINEL = '\x00ECLOOP\x00';
  const wrapperWithSentinel = wrapperTpl.includes('{{@loop}}')
    ? wrapperTpl.split('{{@loop}}').join(LOOP_SENTINEL)
    : wrapperTpl + '\n' + LOOP_SENTINEL;
  const renderedWrapper = renderTemplate(wrapperWithSentinel, vars, stripBlankLines);
  return renderedWrapper.split(LOOP_SENTINEL).join(loopResult);
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
  // 路径规范化：模板里 ../ 等相对片段折叠成真实路径。
  // 不再在此 existsSync——存在性由随后经 fileCache 的内容读取顺带得到（file
  // section 读出 null 即不存在），避免每 section 每消息一次 syscall。
  resolved = path.normalize(resolved);
  return { resolved, status: 'ok', unresolvedTokens: unresolved };
}

function resolvePath(rawPath: string, vars: Vars): string | null {
  const r = resolvePathWithDiag(rawPath, vars);
  return r.status === 'ok' ? r.resolved : null;
}

/** 加载 loop 的 child 子模板文件内容（路径解析 + fileCache）。找不到返回 null。 */
export function loadChildTemplate(childFile: string, vars: Vars): string | null {
  const resolved = resolvePath(childFile, vars);
  if (!resolved) return null;
  return fileCache.getText(resolved, { policy: 'on-reload', group: 'kits' });
}

// ── Section content loading ──

/** 目录段限额溢出信息（供渲染层注入截断说明）。 */
export interface DirOverflow {
  droppedFiles: number;   // 因限额未加载的文件数
  reason: 'files' | 'bytes';  // 触发的限额维度
  limit: number;          // 触发的限额值
}

/**
 * 返回 [filePath, rawContent][]；按 sessionId 缓存已读文件内容。
 * 若传入 overflowOut 且目录段触发单目录限额（maxFiles/maxBytes），
 * 会把溢出信息写入 overflowOut.value（不传则不启用限额收集，行为同旧版但仍应用默认上限）。
 */
export function loadSectionFiles(
  section: ManifestSection,
  vars: Vars,
  sessionCache: Map<string, string>,
  overflowOut?: { value?: DirOverflow },
): [string, string][] {
  if (section.type === 'file' && section.file) {
    const result = loadFileSection(section.file, vars, sessionCache);
    return result ? [result] : [];
  }
  if (section.type === 'directory' && section.path) {
    const resolved = resolvePath(section.path, vars);
    if (!resolved) return [];
    const maxFiles = section.maxFiles ?? DIR_MAX_FILES;
    const maxBytes = section.maxBytes ?? DIR_MAX_BYTES;
    const { files, overflow } = readDirectoryFiles(resolved, section.pattern, maxFiles, maxBytes);
    if (overflow && overflowOut) overflowOut.value = overflow;
    return files.map(([name, content]) => [path.join(resolved, name), content] as [string, string]);
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

/**
 * 读取目录下匹配文件，受单目录限额（maxFiles/maxBytes）约束。
 * 返回已加载文件 + 溢出信息（超限时）。按 fileCache 缓存目录列表与文件内容。
 */
function readDirectoryFiles(
  dirPath: string, pattern: string | undefined,
  maxFiles: number, maxBytes: number,
): { files: [string, string][]; overflow?: DirOverflow } {
  const glob = pattern || '*.md';
  // 目录列表 + 各文件内容均走 fileCache（on-reload）。目录列表以 "<dir>|<glob>"
  // 为键缓存文件名数组；各文件内容走 fileCache.getText 共享。
  const names = fileCache.get<string[]>(
    `${dirPath} ${glob}`,
    () => {
      try { return fs.readdirSync(dirPath).filter(f => matchGlob(f, glob)).sort(); }
      catch { return []; }
    },
    { policy: 'on-reload', group: 'kits' },
  );
  const out: [string, string][] = [];
  let usedBytes = 0;
  let overflow: DirOverflow | undefined;
  for (let i = 0; i < names.length; i++) {
    const f = names[i];
    // 文件数限额
    if (out.length >= maxFiles) {
      overflow = { droppedFiles: names.length - out.length, reason: 'files', limit: maxFiles };
      break;
    }
    const fp = path.join(dirPath, f);
    const content = fileCache.getText(fp, { policy: 'on-reload', group: 'kits' });
    if (content === null) continue;
    // 字节限额（至少加载一个文件，避免单个超大文件导致空目录）
    const size = Buffer.byteLength(content, 'utf-8');
    if (out.length > 0 && usedBytes + size > maxBytes) {
      overflow = { droppedFiles: names.length - out.length, reason: 'bytes', limit: maxBytes };
      break;
    }
    usedBytes += size;
    out.push([f, content]);
  }
  return { files: out, overflow };
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
