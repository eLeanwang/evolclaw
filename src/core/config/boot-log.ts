/**
 * boot-log —— 启动日志与自检回落（design §九 + 双指针模型）。
 *
 * boot-log.jsonl：每次成功启动追加一行（最近 300 条，超限按月归档）。
 * 自检模式：逐版本回落尝试，**展开版本到 W 并真实启动**（不是内存探测）。
 *   - P4:进入时若 W≠w-version,先把 W 存档（successCount=0）
 *   - 回落序列：从 current 往老遍历，跳过 successCount==0 的版本（例外：最新两个无条件参与）
 *   - 回落 = 展开版本到 W + writeWVersion，current 不动
 *   - Q-C:全失败 → 还原成最新版本
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';
import { logger } from '../../utils/logger.js';
import {
  readCurrent, readWVersion, writeWVersion, materializeVersion, listAllVersions,
  diffVersions, snapshot, restore, paramDiff,
  type CurrentPointer, type SnapshotMeta,
} from './snapshot.js';

const MAX_LINES = 300;
const KEEP_MIN = 150;
const FALLBACK_MAX_TRIES = 20;
const FALLBACK_MAX_MS = 120_000;

export interface BootLogEntry {
  bootedAt: string;
  startMethod: 'auto' | 'manual' | 'diagnose';
  selectedVersion: CurrentPointer | null;
  actualVersion: CurrentPointer | null;
  fellBack: boolean;
  versions: Record<string, string>;
  platform: string;
}

export function appendBootLog(entry: BootLogEntry): void {
  const p = resolvePaths().configBootLog;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
  archiveIfNeeded(p);
}

/** 读最近 n 条 boot-log（含归档回溯）。 */
export function readBootLog(n: number): BootLogEntry[] {
  const p = resolvePaths().configBootLog;
  let lines: string[] = [];
  try { lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean); } catch { /* none */ }
  if (lines.length < n) {
    const archDir = resolvePaths().configBootLogArchiveDir;
    if (fs.existsSync(archDir)) {
      const archFiles = fs.readdirSync(archDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
      for (const f of archFiles) {
        const more = fs.readFileSync(path.join(archDir, f), 'utf-8').split('\n').filter(Boolean);
        lines = [...more, ...lines];
        if (lines.length >= n) break;
      }
    }
  }
  return lines.slice(-n).map(l => { try { return JSON.parse(l) as BootLogEntry; } catch { return null; } }).filter(Boolean) as BootLogEntry[];
}

function archiveIfNeeded(file: string): void {
  let lines: string[];
  try { lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean); } catch { return; }
  if (lines.length <= MAX_LINES) return;

  const archDir = resolvePaths().configBootLogArchiveDir;
  fs.mkdirSync(archDir, { recursive: true });
  const monthOf = (l: string): string => {
    try { return (JSON.parse(l).bootedAt as string).slice(0, 7); } catch { return 'unknown'; }
  };
  const thisMonth = monthOf(lines[lines.length - 1]);
  const keep: string[] = [];
  const archived: Record<string, string[]> = {};
  for (const l of lines) {
    const m = monthOf(l);
    if (m === thisMonth) keep.push(l);
    else (archived[m] = archived[m] || []).push(l);
  }
  // 本月不足 KEEP_MIN，则从归档里补最新的回来
  if (keep.length < KEEP_MIN) {
    const flatArch = lines.filter(l => monthOf(l) !== thisMonth);
    const need = KEEP_MIN - keep.length;
    const backfill = flatArch.slice(-need);
    keep.unshift(...backfill);
    // 从 archived 中移除 backfill
    const backfillSet = new Set(backfill);
    for (const m of Object.keys(archived)) archived[m] = archived[m].filter(l => !backfillSet.has(l));
  }
  for (const [m, ls] of Object.entries(archived)) {
    if (ls.length === 0) continue;
    fs.appendFileSync(path.join(archDir, `${m}.jsonl`), ls.join('\n') + '\n', 'utf-8');
  }
  fs.writeFileSync(file, keep.join('\n') + '\n', 'utf-8');
}

// ── 自检回落 ──────────────────────────────────────────────────────────────────

/** 探测函数：W 已展开到磁盘，尝试加载配置，返回 true=可用。 */
export type DiagnoseProbe = () => boolean;

export interface DiagnoseResult {
  ok: boolean;
  selectedVersion: CurrentPointer | null;   // current 指向（始终不变）
  actualVersion: CurrentPointer | null;      // 回落成功的版本（W 现在的内容）
  fellBack: boolean;
  triedVersions: string[];
  breaker?: 'tries' | 'time';
  message?: string;
}

/**
 * 自检模式：逐版本展开到 W，真实探测配置加载，找到第一个可用版本。
 *   - P4: W≠w-version → 先把 W 存档（保留你的改动，即使是坏的）
 *   - 回落序列: 从 current 往老，跳过 successCount==0（例外：序列中最新两个无条件参与）
 *   - 展开 = 覆盖 W + writeWVersion；current 始终不动
 *   - Q-C: 全失败 → 还原成最新版本（W 原样回来）
 * probe: 注入点，默认用 loadAllAgents 检测配置层，也用于测试。
 */
export async function selfDiagnose(
  probe?: DiagnoseProbe,
  now: () => number = () => Date.now(),
): Promise<DiagnoseResult> {
  const selected = readCurrent();
  const wVer = readWVersion();
  const root = resolvePaths().root;

  // P4: W 有未存改动 → 先把 W 存档（坏的也存，保留改动）
  // 判断：w-version 不存在，或 W 内容 ≠ w-version 指向的内容
  const wHasChanges = !wVer || await workingDiffersFromVersion(wVer.delta);
  if (wHasChanges) {
    snapshot('manual', { description: 'diagnose: archive current W before fallback' });
    // snapshot 已经更新了 current + w-version 到新版本
  }

  // 构建候选序列（从 current 往老遍历）
  const allVersions = listAllVersions().sort((a, b) => cmpVer(b.version, a.version)); // 降序
  const cur = readCurrent(); // P4 后重读（可能已更新）
  const startIdx = cur ? allVersions.findIndex(m => m.version === cur.delta) : 0;
  const sequence = startIdx >= 0 ? allVersions.slice(startIdx) : allVersions;

  // 回落资格：successCount>0，或属序列中最新两个
  const candidates = sequence.filter((m, i) => i < 2 || m.successCount > 0);
  if (candidates.length === 0) {
    const latest = allVersions[0]?.version;
    if (latest) await expandToW(latest, root);
    return {
      ok: false, selectedVersion: selected, actualVersion: null, fellBack: false, triedVersions: [],
      message: '✗ 自检失败：无可用候选版本（所有版本 successCount=0）。已还原到最新版本。',
    };
  }

  const probeFn: DiagnoseProbe = probe ?? await makeDefaultProbe();
  const tried: string[] = [];
  const t0 = now();
  let tryCount = 0;

  for (const candidate of candidates) {
    if (tryCount > 0) {
      if (tryCount > FALLBACK_MAX_TRIES) {
        await expandToW(allVersions[0].version, root); // Q-C
        return breakerResult('tries', selected, tried);
      }
      if (now() - t0 > FALLBACK_MAX_MS) {
        await expandToW(allVersions[0].version, root); // Q-C
        return breakerResult('time', selected, tried);
      }
    }
    tryCount++;
    tried.push(candidate.version);

    // 展开到 W
    await expandToW(candidate.version, root);

    let ok = false;
    try { ok = probeFn(); } catch { ok = false; }

    if (ok) {
      const actual: CurrentPointer = findVersionPtr(candidate.version, allVersions);
      const fellBack = !selected || selected.delta !== candidate.version;
      if (fellBack) printFallbackInfo(selected, actual);
      return { ok: true, selectedVersion: selected, actualVersion: actual, fellBack, triedVersions: tried };
    }
  }

  // Q-C: 全失败 → 还原最新版本
  if (allVersions.length > 0) await expandToW(allVersions[0].version, root);
  return {
    ok: false, selectedVersion: selected, actualVersion: null, fellBack: false, triedVersions: tried,
    message: `✗ 自检失败：已尝试 ${tried.length} 个候选版本（${tried.join('→')}）仍无可用。已还原最新版本。`,
  };
}

async function expandToW(version: string, root: string): Promise<void> {
  const all = listAllVersions();
  const m = all.find(x => x.version === version);
  if (!m) return;
  const full = m.baseVersion || version;
  const files = materializeVersion(full, version);
  // 删除 W 中不在目标版本的配置文件
  const { collectConfigFiles } = await import('./snapshot.js');
  const existing = collectConfigFiles(root);
  for (const rel of existing) {
    if (!files.has(rel)) { try { fs.unlinkSync(path.join(root, rel)); } catch { /* */ } }
  }
  for (const [rel, content] of files) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }
  writeWVersion({ full, delta: version });
}

async function workingDiffersFromVersion(version: string): Promise<boolean> {
  const { diffWorkingVsVersion } = await import('./snapshot.js');
  const d = diffWorkingVsVersion(version);
  if ('error' in d) return true;
  return d.added.length + d.modified.length + d.deleted.length > 0;
}

async function makeDefaultProbe(): Promise<DiagnoseProbe> {
  // 延迟 import 避免循环依赖：config-store → core/config，boot-log 在 core/config
  const { loadAllAgents } = await import('../../config-store.js');
  return () => {
    try {
      const { agents } = loadAllAgents();
      return agents.length > 0;
    } catch { return false; }
  };
}

function cmpVer(a: string, b: string): number {
  return parseInt(a.slice(1)) - parseInt(b.slice(1));
}

function findVersionPtr(version: string, all: SnapshotMeta[]): CurrentPointer {
  const m = all.find(x => x.version === version);
  return { full: m?.baseVersion || version, delta: version };
}

function breakerResult(kind: 'tries' | 'time', selected: CurrentPointer | null, tried: string[]): DiagnoseResult {
  const msg = kind === 'tries'
    ? `✗ 自检失败：回落尝试达到 ${FALLBACK_MAX_TRIES} 次上限（${tried.join('→')}）。已还原最新版本。`
    : `✗ 自检失败：回落耗时超过 2 分钟（已尝试 ${tried.join('→')}）。已还原最新版本。`;
  return { ok: false, selectedVersion: selected, actualVersion: null, fellBack: false, triedVersions: tried, breaker: kind, message: msg };
}

function printFallbackInfo(selected: CurrentPointer | null, actual: CurrentPointer): void {
  const lines = [`⚠ 当前版本 ${selected?.delta ?? '?'} 启动失败，已回落到 ${actual.delta}。`];
  // 参数级差异：actual(W现状) vs selected(失败版本)
  if (selected) {
    const d = diffVersions(actual.delta, selected.delta);
    if (!('error' in d)) {
      const changed = [...d.modified, ...d.added, ...d.deleted];
      if (changed.length) lines.push(`  变化文件：${changed.join(', ')}`);
    }
    lines.push(`  失败版本 vs 回落版本的参数差异：ec config diff ${actual.delta} ${selected.delta}`);
  }
  lines.push(`  current.json 仍指向 ${selected?.delta ?? '?'}（未改写）。`);
  lines.push(`  采用回落版本：ec config restore ${actual.delta}`);
  logger.warn(lines.join('\n'));
  console.error(lines.join('\n'));
}

/** restore 回落版本到工作目录（采用某可用版本时调用）。委托 snapshot.restore。 */
export { readCurrent };
