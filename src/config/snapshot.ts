/**
 * snapshot —— 配置快照与回滚。
 *
 * 快照范围 = 整个配置文件体系（evolclaw.json + agents/defaults.json + 每 agent 的
 * config.json + 每关系的 config.json）+ extra_backup 声明文件。
 * **不含 .env**（凭证不进版本库）。
 *
 * 版本号：全量百位递增（v100/v200…），增量嵌套其下（v101…v199，每全量 ≤99 个增量）。
 * 目录：{root}/backups/config/v100/{meta.json, snapshot/...} + v101/{meta.json, delta/...}
 * 指针：current.json {full, delta}。
 *
 * 两层比对：
 *   - 要不要建版本 → 与 current.json 当前版本比（一致跳过；schema-migration 无条件）
 *   - 建增量还是全量 → 与所属全量比（差异文件 > 半数 / 增量达99 / --full → 升全量）
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { logger } from '../utils/logger.js';

export type SnapshotTrigger = 'manual' | 'startup' | 'schema-migration';

export interface CurrentPointer { full: string; delta: string; }

export interface SnapshotMeta {
  version: string;
  type: 'full' | 'delta';
  baseVersion?: string;
  createdAt: string;
  trigger: SnapshotTrigger;
  description?: string;
  changedFiles: string[];
  deletedFiles: string[];
  successCount: number;
}

export interface SnapshotResult {
  created: boolean;
  version?: string;
  type?: 'full' | 'delta';
  reason?: string;
}

const RETAIN_FULL = 10;
const RETAIN_DELTA = 20;

// ── 配置文件集合扫描（相对 root 的 POSIX 路径）────────────────────────────────

/** 收集当前工作目录下所有受快照管理的配置文件（相对 root，正斜杠）。 */
export function collectConfigFiles(root: string): string[] {
  const out: string[] = [];
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const pushIf = (abs: string) => { if (fs.existsSync(abs)) out.push(rel(abs)); };

  pushIf(path.join(root, 'evolclaw.json'));
  const agentsRoot = path.join(root, 'agents');
  pushIf(path.join(agentsRoot, 'defaults.json'));

  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const adir = path.join(agentsRoot, entry.name);
      pushIf(path.join(adir, 'config.json'));
      // extra_backup 声明
      collectExtraBackup(adir, root, out);
      const relations = path.join(adir, 'relations');
      if (fs.existsSync(relations)) {
        for (const pk of fs.readdirSync(relations, { withFileTypes: true })) {
          if (!pk.isDirectory() || pk.name.startsWith('_')) continue;
          const rdir = path.join(relations, pk.name);
          pushIf(path.join(rdir, 'config.json'));
          collectExtraBackup(rdir, root, out);
        }
      }
    }
  }
  return [...new Set(out)];
}

function collectExtraBackup(dir: string, root: string, out: string[]): void {
  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) return;
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch { return; }
  const eb = cfg.extra_backup;
  if (!Array.isArray(eb)) return;
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  for (const e of eb) {
    if (!e || typeof e !== 'object' || !e.path) continue;
    const sub = path.join(dir, e.path);
    if (!fs.existsSync(sub)) continue;
    const pattern: string = e.pattern || '*';
    if (pattern.toLowerCase().includes('.env')) continue; // 安全：拒 .env
    for (const f of fs.readdirSync(sub)) {
      if (matchGlob(f, pattern) && !f.endsWith('.env')) {
        const abs = path.join(sub, f);
        if (fs.statSync(abs).isFile()) out.push(rel(abs));
      }
    }
  }
}

function matchGlob(name: string, pattern: string): boolean {
  // 极简 glob：* → .*，? → .
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

// ── current.json 指针 ────────────────────────────────────────────────────────

export function readCurrent(): CurrentPointer | null {
  const p = resolvePaths().configCurrentPointer;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as CurrentPointer; } catch { return null; }
}

export function writeCurrent(ptr: CurrentPointer): void {
  const p = resolvePaths().configCurrentPointer;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ptr, null, 2) + '\n', 'utf-8');
}

// ── w-version.json（W 的版本标记）─────────────────────────────────────────────

export function readWVersion(): CurrentPointer | null {
  const p = resolvePaths().configWVersion;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as CurrentPointer; } catch { return null; }
}

export function writeWVersion(ptr: CurrentPointer): void {
  const p = resolvePaths().configWVersion;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ptr, null, 2) + '\n', 'utf-8');
}

// ── 版本目录 ──────────────────────────────────────────────────────────────────

function backupsDir(): string { return resolvePaths().configBackupsDir; }

/** 列出所有全量版本号（v100/v200…），升序。 */
function listFulls(): string[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^v\d+00$/.test(e.name))
    .map(e => e.name)
    .sort(cmpVersion);
}

/** 列出某全量目录下的增量版本号（v101…），升序。 */
function listDeltas(full: string): string[] {
  const dir = path.join(backupsDir(), full);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^v\d+$/.test(e.name) && e.name !== full)
    .map(e => e.name)
    .sort(cmpVersion);
}

function cmpVersion(a: string, b: string): number {
  return parseInt(a.slice(1)) - parseInt(b.slice(1));
}

/** 所有版本（全量 + 增量）升序，附 type。 */
export function listAllVersions(): SnapshotMeta[] {
  const out: SnapshotMeta[] = [];
  for (const full of listFulls()) {
    out.push(readMeta(full, full));
    for (const d of listDeltas(full)) out.push(readMeta(full, d));
  }
  return out.filter(Boolean) as SnapshotMeta[];
}

function readMeta(full: string, version: string): SnapshotMeta {
  const metaPath = version === full
    ? path.join(backupsDir(), full, 'meta.json')
    : path.join(backupsDir(), full, version, 'meta.json');
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SnapshotMeta; } catch {
    return { version, type: version === full ? 'full' : 'delta', createdAt: '', trigger: 'manual', changedFiles: [], deletedFiles: [], successCount: 0 };
  }
}

function writeMeta(full: string, version: string, meta: SnapshotMeta): void {
  const metaPath = version === full
    ? path.join(backupsDir(), full, 'meta.json')
    : path.join(backupsDir(), full, version, 'meta.json');
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

/** 递增版本的 successCount(成功启动计数),用于回落资格判定。 */
export function incrementSuccessCount(version: string): void {
  const loc = locateVersion(version);
  if (!loc) return;
  const meta = readMeta(loc.full, loc.delta);
  meta.successCount = (meta.successCount || 0) + 1;
  writeMeta(loc.full, loc.delta, meta);
}

function nextFullVersion(): string {
  const fulls = listFulls();
  if (fulls.length === 0) return 'v100';
  const last = parseInt(fulls[fulls.length - 1].slice(1));
  return 'v' + (Math.floor(last / 100) * 100 + 100);
}

function nextDeltaVersion(full: string): string {
  const deltas = listDeltas(full);
  const base = parseInt(full.slice(1));
  if (deltas.length === 0) return 'v' + (base + 1);
  const last = parseInt(deltas[deltas.length - 1].slice(1));
  return 'v' + (last + 1);
}

// ── 读文件内容（用于比对/写快照）─────────────────────────────────────────────

function readWorkFile(root: string, relPath: string): string | null {
  try { return fs.readFileSync(path.join(root, relPath), 'utf-8'); } catch { return null; }
}

/** 展开某版本到一份内容 map（相对路径 → 内容）。增量基于父全量叠加。 */
export function materializeVersion(full: string, delta: string): Map<string, string> {
  const map = new Map<string, string>();
  const snapDir = path.join(backupsDir(), full, 'snapshot');
  if (fs.existsSync(snapDir)) walkInto(snapDir, snapDir, map);
  if (delta !== full) {
    const changesPath = path.join(backupsDir(), full, delta, 'delta', 'changes.jsonl');
    const filesDir = path.join(backupsDir(), full, delta, 'delta', 'files');
    if (fs.existsSync(changesPath)) {
      for (const line of fs.readFileSync(changesPath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const ch = JSON.parse(line) as { op: string; path: string };
        if (ch.op === 'delete') { map.delete(ch.path); }
        else {
          const content = readWorkFile(filesDir, ch.path);
          if (content !== null) map.set(ch.path, content);
        }
      }
    }
  }
  return map;
}

function walkInto(baseDir: string, cur: string, map: Map<string, string>): void {
  for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
    const abs = path.join(cur, e.name);
    if (e.isDirectory()) walkInto(baseDir, abs, map);
    else {
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');
      map.set(rel, fs.readFileSync(abs, 'utf-8'));
    }
  }
}

/** 当前工作目录配置文件 → 内容 map。 */
function materializeWorkdir(root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of collectConfigFiles(root)) {
    const c = readWorkFile(root, rel);
    if (c !== null) map.set(rel, c);
  }
  return map;
}

/** 比对两份 map，返回差异。 */
function diffMaps(oldM: Map<string, string>, newM: Map<string, string>): { add: string[]; modify: string[]; del: string[] } {
  const add: string[] = [], modify: string[] = [], del: string[] = [];
  for (const [k, v] of newM) {
    if (!oldM.has(k)) add.push(k);
    else if (oldM.get(k) !== v) modify.push(k);
  }
  for (const k of oldM.keys()) if (!newM.has(k)) del.push(k);
  return { add, modify, del };
}

// ── snapshot：建版本 ──────────────────────────────────────────────────────────

export function snapshot(trigger: SnapshotTrigger, opts: { full?: boolean; description?: string } = {}): SnapshotResult {
  const root = resolvePaths().root;
  const work = materializeWorkdir(root);
  const cur = readCurrent();

  // 决策一：要不要建版本（与 current 版本比；schema-migration 无条件）
  if (trigger !== 'schema-migration' && cur) {
    const curMap = materializeVersion(cur.full, cur.delta);
    const d = diffMaps(curMap, work);
    if (d.add.length === 0 && d.modify.length === 0 && d.del.length === 0) {
      return { created: false, reason: 'no-change' };
    }
  }

  // 决策二：增量 vs 全量（与所属全量比）
  const fulls = listFulls();
  const baseFull = cur?.full && fulls.includes(cur.full) ? cur.full : (fulls[fulls.length - 1] || null);
  let makeFull = opts.full || !baseFull;
  let baseMap: Map<string, string> | null = null;
  if (!makeFull && baseFull) {
    baseMap = materializeVersion(baseFull, baseFull);
    const d = diffMaps(baseMap, work);
    const fullFileCount = Math.max(baseMap.size, 1);
    const changeCount = d.add.length + d.modify.length + d.del.length;
    if (changeCount * 2 > fullFileCount) makeFull = true;            // 差异 > 半数
    if (listDeltas(baseFull).length >= 99) makeFull = true;          // 增量达 99
  }

  if (makeFull) return createFull(root, work, trigger, opts.description);
  return createDelta(root, work, baseFull!, baseMap!, trigger, opts.description);
}

function createFull(root: string, work: Map<string, string>, trigger: SnapshotTrigger, description?: string): SnapshotResult {
  const version = nextFullVersion();
  const verDir = path.join(backupsDir(), version);
  const snapDir = path.join(verDir, 'snapshot');
  for (const [rel, content] of work) {
    const dest = path.join(snapDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }
  const meta: SnapshotMeta = {
    version, type: 'full', createdAt: nowIso(), trigger, description,
    changedFiles: [...work.keys()], deletedFiles: [],
    successCount: 0,
  };
  fs.writeFileSync(path.join(verDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  writeCurrent({ full: version, delta: version });
  writeWVersion({ full: version, delta: version });
  logger.info(`[snapshot] created full ${version} (trigger=${trigger}, ${work.size} files)`);
  return { created: true, version, type: 'full' };
}

function createDelta(root: string, work: Map<string, string>, baseFull: string, baseMap: Map<string, string>, trigger: SnapshotTrigger, description?: string): SnapshotResult {
  const version = nextDeltaVersion(baseFull);
  const verDir = path.join(backupsDir(), baseFull, version);
  const deltaDir = path.join(verDir, 'delta');
  const filesDir = path.join(deltaDir, 'files');
  const d = diffMaps(baseMap, work);

  const lines: string[] = [];
  for (const p of d.add) { lines.push(JSON.stringify({ op: 'add', path: p })); writeDeltaFile(filesDir, p, work.get(p)!); }
  for (const p of d.modify) { lines.push(JSON.stringify({ op: 'modify', path: p })); writeDeltaFile(filesDir, p, work.get(p)!); }
  for (const p of d.del) lines.push(JSON.stringify({ op: 'delete', path: p }));

  fs.mkdirSync(deltaDir, { recursive: true });
  fs.writeFileSync(path.join(deltaDir, 'changes.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
  const meta: SnapshotMeta = {
    version, type: 'delta', baseVersion: baseFull, createdAt: nowIso(), trigger, description,
    changedFiles: [...d.add, ...d.modify], deletedFiles: d.del,
    successCount: 0,
  };
  fs.writeFileSync(path.join(verDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  writeCurrent({ full: baseFull, delta: version });
  writeWVersion({ full: baseFull, delta: version });
  logger.info(`[snapshot] created delta ${version} on ${baseFull} (trigger=${trigger}, +${d.add.length} ~${d.modify.length} -${d.del.length})`);
  return { created: true, version, type: 'delta' };
}

function writeDeltaFile(filesDir: string, rel: string, content: string): void {
  const dest = path.join(filesDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf-8');
}

function nowIso(): string {
  // Date 在 workflow 脚本里被禁；此处是运行时模块，正常可用。
  return new Date().toISOString();
}

// ── restore：恢复到指定版本 ──────────────────────────────────────────────────

/** 找某版本号属于哪个全量（全量自身或某增量）。 */
function locateVersion(version: string): { full: string; delta: string } | null {
  if (/^v\d+00$/.test(version)) return listFulls().includes(version) ? { full: version, delta: version } : null;
  for (const full of listFulls()) {
    if (listDeltas(full).includes(version)) return { full, delta: version };
  }
  return null;
}

export interface RestoreResult { ok: boolean; version?: string; error?: string; appliedFiles?: number; }

/** 恢复：展开目标版本到工作目录 + 更新 current.json（先建 pre-restore 快照）。 */
export function restore(version: string): RestoreResult {
  const loc = locateVersion(version);
  if (!loc) return { ok: false, error: `版本不存在: ${version}` };

  // pre-restore 快照（保护当前工作目录状态）
  snapshot('manual', { description: `pre-restore before ${version}` });

  const root = resolvePaths().root;
  const target = materializeVersion(loc.full, loc.delta);
  const current = materializeWorkdir(root);

  // 删除工作目录中目标版本没有的配置文件
  for (const rel of current.keys()) {
    if (!target.has(rel)) {
      try { fs.unlinkSync(path.join(root, rel)); } catch { /* best effort */ }
    }
  }
  // 写入目标版本所有文件
  let applied = 0;
  for (const [rel, content] of target) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
    applied++;
  }
  writeCurrent({ full: loc.full, delta: loc.delta });
  writeWVersion({ full: loc.full, delta: loc.delta });
  logger.info(`[snapshot] restored ${version} (${applied} files)`);
  return { ok: true, version, appliedFiles: applied };
}

// ── diff：两版本差异 ─────────────────────────────────────────────────────────

export interface VersionDiff { added: string[]; modified: string[]; deleted: string[]; }

export function diffVersions(v1: string, v2: string): VersionDiff | { error: string } {
  const a = locateVersion(v1), b = locateVersion(v2);
  if (!a) return { error: `版本不存在: ${v1}` };
  if (!b) return { error: `版本不存在: ${v2}` };
  const ma = materializeVersion(a.full, a.delta);
  const mb = materializeVersion(b.full, b.delta);
  const d = diffMaps(ma, mb);
  return { added: d.add, modified: d.modify, deleted: d.del };
}

/** W vs 指定版本的文件级差异。 */
export function diffWorkingVsVersion(version: string): VersionDiff | { error: string } {
  const loc = locateVersion(version);
  if (!loc) return { error: `版本不存在: ${version}` };
  const root = resolvePaths().root;
  const work = materializeWorkdir(root);
  const target = materializeVersion(loc.full, loc.delta);
  const d = diffMaps(target, work);
  return { added: d.add, modified: d.modify, deleted: d.del };
}

export interface ParamDiff {
  file: string;
  changes: Array<{ path: string; before: any; after: any; op: 'add' | 'modify' | 'delete' }>;
}

/** 参数级 diff（字段路径 + 值变化）：W vs 指定版本。 */
export function paramDiff(version: string): ParamDiff[] | { error: string } {
  const fileDiff = diffWorkingVsVersion(version);
  if ('error' in fileDiff) return fileDiff;
  const root = resolvePaths().root;
  const work = materializeWorkdir(root);
  const loc = locateVersion(version)!;
  const target = materializeVersion(loc.full, loc.delta);
  const out: ParamDiff[] = [];

  for (const file of [...fileDiff.added, ...fileDiff.modified, ...fileDiff.deleted]) {
    const wContent = work.get(file);
    const tContent = target.get(file);
    const changes: ParamDiff['changes'] = [];

    // 文件新增/删除 = 整体 add/delete
    if (!tContent && wContent) {
      try { changes.push({ path: '<file>', before: null, after: JSON.parse(wContent), op: 'add' }); } catch { /* 无法解析,跳过 */ }
    } else if (tContent && !wContent) {
      try { changes.push({ path: '<file>', before: JSON.parse(tContent), after: null, op: 'delete' }); } catch { /* */ }
    } else if (tContent && wContent) {
      // 文件修改 = 字段级 diff
      try {
        const a = JSON.parse(tContent);
        const b = JSON.parse(wContent);
        diffObjects('', a, b, changes);
      } catch { /* 解析失败,跳过 */ }
    }
    if (changes.length > 0) out.push({ file, changes });
  }
  return out;
}

function diffObjects(prefix: string, a: any, b: any, out: ParamDiff['changes']): void {
  const allKeys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of allKeys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const aVal = a?.[k];
    const bVal = b?.[k];
    if (aVal === undefined && bVal !== undefined) {
      out.push({ path, before: null, after: bVal, op: 'add' });
    } else if (aVal !== undefined && bVal === undefined) {
      out.push({ path, before: aVal, after: null, op: 'delete' });
    } else if (JSON.stringify(aVal) !== JSON.stringify(bVal)) {
      if (typeof aVal === 'object' && typeof bVal === 'object' && !Array.isArray(aVal) && !Array.isArray(bVal)) {
        diffObjects(path, aVal, bVal, out);
      } else {
        out.push({ path, before: aVal, after: bVal, op: 'modify' });
      }
    }
  }
}

// ── prune / retention（design §八 + addendum D5）──────────────────────────────

export interface PruneResult { wouldDelete: string[]; deleted: string[]; kept: string[]; }

/**
 * 清理：保留最近 keepFull 全量 / keepDelta 增量（跨全量统计）。dryRun=true 只列不删。
 * 拒删：current 指向的版本、被保留区间内增量依赖的全量。
 */
export function prune(opts: { keepFull?: number; keepDelta?: number; dryRun?: boolean } = {}): PruneResult {
  const keepFull = opts.keepFull ?? RETAIN_FULL;
  const keepDelta = opts.keepDelta ?? RETAIN_DELTA;
  const cur = readCurrent();
  const fulls = listFulls();

  // 增量保留：跨全量按时间（版本号近似）取最近 keepDelta
  const allDeltas: Array<{ full: string; ver: string }> = [];
  for (const f of fulls) for (const d of listDeltas(f)) allDeltas.push({ full: f, ver: d });
  const keptDeltas = new Set(allDeltas.slice(-keepDelta).map(d => `${d.full}/${d.ver}`));

  // 全量保留：最近 keepFull + 仍被保留增量依赖的全量 + current 全量
  const keptFulls = new Set(fulls.slice(-keepFull));
  for (const d of allDeltas) if (keptDeltas.has(`${d.full}/${d.ver}`)) keptFulls.add(d.full);
  if (cur) keptFulls.add(cur.full);

  const wouldDelete: string[] = [];
  const deleted: string[] = [];
  const kept: string[] = [];

  for (const f of fulls) {
    if (keptFulls.has(f)) {
      kept.push(f);
      // 该全量保留时，清理其下未保留的增量
      for (const d of listDeltas(f)) {
        const tag = `${f}/${d}`;
        const isCurrent = cur && cur.full === f && cur.delta === d;
        if (keptDeltas.has(tag) || isCurrent) { kept.push(d); continue; }
        wouldDelete.push(d);
        if (!opts.dryRun) { rmDir(path.join(backupsDir(), f, d)); deleted.push(d); }
      }
    } else {
      wouldDelete.push(f);
      if (!opts.dryRun) { rmDir(path.join(backupsDir(), f)); deleted.push(f); }
    }
  }
  return { wouldDelete, deleted, kept };
}

function rmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 启动后延迟清理：保留策略默认值，非 dry-run。 */
export function retentionCleanup(): void {
  try { prune({ dryRun: false }); } catch (e) { logger.warn(`[snapshot] retention cleanup failed: ${e}`); }
}
