/**
 * Instance registry — manages {HOME}/data/instance/ directory.
 *
 * 真相源：每个进程写一份带 PID 的 record 文件。判定"是否已有实例运行"时，
 * 遍历所有 record，根据 (pid, startedAt) 对每个 record 做存活校验。
 *
 * 不使用 lock 文件——record 文件本身就是登记簿，"互斥"由 post-write 自检
 * （写完 record 立刻扫一遍，比自己早的赢）保证。这样 6 个并发进程同时启动
 * 也不会互相覆盖（PID 不同名字也不同），最终通过 startedAt 比较选出唯一赢家。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { resolvePaths } from '../paths.js';
import { isProcessRunning, killProcess, isWindows, findProcesses } from './cross-platform.js';
import { getProcessStartTime, startTimeMatches } from './process-introspect.js';

// ── Types ──

export type LaunchedBy = 'start' | 'restart-cli' | 'restart-network' | 'self-heal' | 'restart-monitor';

export interface MainRecord {
  pid: number;
  startedAt: number;
  startedAtIso: string;
  launchedBy: LaunchedBy;
}

export interface RestartMonitorRecord {
  pid: number;
  startedAt: number;
  startedAtIso: string;
  launchedBy: 'restart-monitor';
}

export interface AidEvent {
  ts: number;
  iso: string;
  event: 'connected' | 'disconnected' | 'kicked' | 'message_in' | 'message_out';
  aid: string;
  [key: string]: unknown;
}

export interface InstanceEntry<T> {
  record: T;
  alive: boolean;
}

export interface InstanceStatus {
  /** 所有 main-<pid>.json 记录（包含已死的，用 alive 字段区分） */
  mains: InstanceEntry<MainRecord>[];
  /** 所有 restart-monitor-<pid>.json 记录 */
  restartMonitors: InstanceEntry<RestartMonitorRecord>[];
  /** 所有活 main 进程的 AID 最后活动时间（按 PID 聚合） */
  aidLastActivity: Map<string, { ts: number; event: string }>;
}

// ── Helpers ──

function instanceDir(): string {
  return resolvePaths().instanceDir;
}

function writeAtomic(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function safeParseJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isAlive(pid: number, recordedStartedAt: number): boolean {
  if (!isProcessRunning(pid)) return false;
  const actual = getProcessStartTime(pid);
  // 拿不到启动时间时保守认为是我们的进程（宁可误判活着，不误杀）
  if (actual === null) return true;
  return startTimeMatches(recordedStartedAt, actual);
}

// ── Main record ──

function mainFileName(pid: number): string {
  return `main-${pid}.json`;
}

export function writeMain(launchedBy: LaunchedBy): string {
  const dir = instanceDir();
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = getProcessStartTime(process.pid) ?? Date.now();
  const record: MainRecord = {
    pid: process.pid,
    startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    launchedBy,
  };
  const filePath = path.join(dir, mainFileName(process.pid));
  writeAtomic(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function removeMain(pid?: number): void {
  const target = pid ?? process.pid;
  const filePath = path.join(instanceDir(), mainFileName(target));
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Post-write 自检：写完 main record 后立刻扫一次目录。
 * 如果发现别的活 main，按 (startedAt, pid) 选最早的赢家。
 *
 * @returns 当前进程是否赢家。false 表示应该让出（删自己的 record + exit）。
 */
export function isMainWinner(): { winner: boolean; conflictingPid?: number } {
  const status = scanInstances();
  const aliveMains = status.mains.filter(m => m.alive);
  if (aliveMains.length <= 1) return { winner: true };

  const self = aliveMains.find(m => m.record.pid === process.pid);
  if (!self) return { winner: true };  // 自己的记录都没了，让别人去争吧

  // (startedAt, pid) 字典序最小者赢
  const winnerEntry = aliveMains.reduce((best, cur) => {
    if (cur.record.startedAt < best.record.startedAt) return cur;
    if (cur.record.startedAt > best.record.startedAt) return best;
    return cur.record.pid < best.record.pid ? cur : best;
  });

  if (winnerEntry.record.pid === process.pid) return { winner: true };
  return { winner: false, conflictingPid: winnerEntry.record.pid };
}

// ── Restart monitor record ──

function restartMonitorFileName(pid: number): string {
  return `restart-monitor-${pid}.json`;
}

export function writeRestartMonitor(): string {
  const dir = instanceDir();
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = getProcessStartTime(process.pid) ?? Date.now();
  const record: RestartMonitorRecord = {
    pid: process.pid,
    startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    launchedBy: 'restart-monitor',
  };
  const filePath = path.join(dir, restartMonitorFileName(process.pid));
  writeAtomic(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function removeRestartMonitor(pid?: number): void {
  const target = pid ?? process.pid;
  const filePath = path.join(instanceDir(), restartMonitorFileName(target));
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Post-write 自检：与 isMainWinner 同语义，用于 restart-monitor。
 */
export function isRestartMonitorWinner(): { winner: boolean; conflictingPid?: number } {
  const status = scanInstances();
  const alive = status.restartMonitors.filter(m => m.alive);
  if (alive.length <= 1) return { winner: true };

  const self = alive.find(m => m.record.pid === process.pid);
  if (!self) return { winner: true };

  const winnerEntry = alive.reduce((best, cur) => {
    if (cur.record.startedAt < best.record.startedAt) return cur;
    if (cur.record.startedAt > best.record.startedAt) return best;
    return cur.record.pid < best.record.pid ? cur : best;
  });

  if (winnerEntry.record.pid === process.pid) return { winner: true };
  return { winner: false, conflictingPid: winnerEntry.record.pid };
}

// ─ AID event log ──

function aidFileName(pid: number): string {
  return `aid-${pid}.jsonl`;
}

export function appendAidEvent(event: AidEvent, pid?: number): void {
  const target = pid ?? process.pid;
  const dir = instanceDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, aidFileName(target));
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(filePath, line);
}

export function removeAidLog(pid?: number): void {
  const target = pid ?? process.pid;
  const filePath = path.join(instanceDir(), aidFileName(target));
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * 读取 aid jsonl 文件尾部，提取每个 AID 的最后活动时间和事件类型。
 */
export function readAidLastActivity(pid: number): Map<string, { ts: number; event: string }> {
  const filePath = path.join(instanceDir(), aidFileName(pid));
  const result = new Map<string, { ts: number; event: string }>();
  if (!fs.existsSync(filePath)) return result;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as AidEvent;
        if (ev.aid && ev.ts) {
          result.set(ev.aid, { ts: ev.ts, event: ev.event });
        }
      } catch {}
    }
  } catch {}
  return result;
}

// ── Scan & cleanup ──

/**
 * 扫描 instance/ 目录，返回所有实例记录（含死活状态）。
 *
 * 损坏的 JSON 文件直接删除。aid-*.jsonl 在 scan 时不解析，由调用方按需读取。
 */
export function scanInstances(): InstanceStatus {
  const status: InstanceStatus = {
    mains: [],
    restartMonitors: [],
    aidLastActivity: new Map(),
  };

  const dir = instanceDir();
  if (!fs.existsSync(dir)) return status;

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return status;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);

    if (file.startsWith('main-') && file.endsWith('.json')) {
      const record = safeParseJson<MainRecord>(filePath);
      if (record && record.pid && record.startedAt) {
        const alive = isAlive(record.pid, record.startedAt);
        status.mains.push({ record, alive });
        if (alive) {
          // 合并所有活 main 的 AID 活动记录（按 ts 取最新）
          for (const [aid, info] of readAidLastActivity(record.pid)) {
            const prev = status.aidLastActivity.get(aid);
            if (!prev || info.ts > prev.ts) {
              status.aidLastActivity.set(aid, info);
            }
          }
        }
      } else {
        try { fs.unlinkSync(filePath); } catch {}
      }
    } else if (file.startsWith('restart-monitor-') && file.endsWith('.json')) {
      const record = safeParseJson<RestartMonitorRecord>(filePath);
      if (record && record.pid && record.startedAt) {
        const alive = isAlive(record.pid, record.startedAt);
        status.restartMonitors.push({ record, alive });
      } else {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  }

  return status;
}

/**
 * 清理所有非自己 PID 的残留文件。仍活着的旧实例进程会被 SIGKILL。
 * 返回被杀掉的 PID 列表。
 */
export function cleanupInstances(): number[] {
  const dir = instanceDir();
  if (!fs.existsSync(dir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const killed: number[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);

    if (file.startsWith('main-') && file.endsWith('.json')) {
      const record = safeParseJson<MainRecord>(filePath);
      if (record?.pid) {
        if (record.pid === process.pid) continue;
        if (isProcessRunning(record.pid)) {
          const actual = getProcessStartTime(record.pid);
          if (startTimeMatches(record.startedAt, actual)) {
            killPid(record.pid);
            killed.push(record.pid);
          }
        }
      }
      try { fs.unlinkSync(filePath); } catch {}
    } else if (file.startsWith('restart-monitor-') && file.endsWith('.json')) {
      const record = safeParseJson<RestartMonitorRecord>(filePath);
      if (record?.pid) {
        if (record.pid === process.pid) continue;
        if (isProcessRunning(record.pid)) {
          const actual = getProcessStartTime(record.pid);
          if (startTimeMatches(record.startedAt, actual)) {
            killPid(record.pid);
            killed.push(record.pid);
          }
        }
      }
      try { fs.unlinkSync(filePath); } catch {}
    } else if (file.startsWith('aid-') && file.endsWith('.jsonl')) {
      // aid-<pid>.jsonl：自己的不动，其他的清掉
      const m = file.match(/^aid-(\d+)\.jsonl$/);
      if (m && parseInt(m[1], 10) === process.pid) continue;
      try { fs.unlinkSync(filePath); } catch {}
    } else if (file.endsWith('.tmp')) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  return killed;
}

/**
 * 删除当前进程拥有的所有 instance 文件（正常关闭时调用）。
 */
export function removeAll(pid?: number): void {
  const target = pid ?? process.pid;
  removeMain(target);
  removeAidLog(target);
}

// ── Internal ──

function killPid(pid: number): void {
  killProcess(pid, true);
}

// ── Orphan detection (cross-HOME) ──

export interface OrphanProcess {
  pid: number;
  evolclawHome: string | null;
  cmdline: string;
}

/**
 * 扫所有 node 进程中跑 dist/index.js 的 PID，减去当前 HOME 已登记的 main PID。
 *
 * 用途：检测跨 HOME 残留的 evolclaw 主进程（例如测试套件 spawn 后未清理、
 * 旧版本 pidfile 模式遗留等），由 cmdStart/cmdRestart 在启动前提示用户。
 *
 * Linux 下额外读取 /proc/<pid>/environ 提取 EVOLCLAW_HOME 用于展示。
 * Windows / macOS 取不到环境变量时 evolclawHome 为 null。
 *
 * 不会主动 kill——清理由调用方决定（cmdRestart --kill-orphans 才执行）。
 */
export function findOrphanProcesses(): OrphanProcess[] {
  // 1. 已登记 PID（自己 HOME 下的 main + 自己进程）
  const known = new Set<number>([process.pid]);
  const status = scanInstances();
  for (const m of status.mains) known.add(m.record.pid);
  for (const m of status.restartMonitors) known.add(m.record.pid);

  // 2. 系统中所有跑 dist/index.js 的 node 进程
  const candidates = findProcesses('node.*dist/index.js');

  const orphans: OrphanProcess[] = [];
  for (const pid of candidates) {
    if (known.has(pid)) continue;
    if (!isProcessRunning(pid)) continue;

    const cmdline = readCmdline(pid);
    // 二次验证：确实是 evolclaw 的 dist/index.js
    if (!/dist[\\/]index\.js/.test(cmdline)) continue;

    // 三次验证：排除 ecweb（/ecweb/dist/index.js）
    if (/[\\/]ecweb[\\/]dist[\\/]index\.js/.test(cmdline)) continue;

    orphans.push({
      pid,
      evolclawHome: readEvolclawHome(pid),
      cmdline,
    });
  }
  return orphans;
}

/**
 * SIGKILL 所有传入的孤儿 PID。返回成功杀掉的 PID 列表（即调用后已停的）。
 */
export function killOrphans(orphans: OrphanProcess[]): number[] {
  const killed: number[] = [];
  for (const o of orphans) {
    try {
      killProcess(o.pid, true);
      killed.push(o.pid);
    } catch {}
  }
  return killed;
}

function readCmdline(pid: number): string {
  if (isWindows) {
    try {
      const result = spawnSync(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'],
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      const out = result.stdout || '';
      const m = out.match(/CommandLine=([^\r\n]+)/);
      return m ? m[1].trim() : '';
    } catch {
      return '';
    }
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    try {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.stdout?.trim() || '';
    } catch {
      return '';
    }
  }
}

function readEvolclawHome(pid: number): string | null {
  // Linux: /proc/<pid>/environ
  if (!isWindows && process.platform !== 'darwin') {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
      for (const entry of env.split('\0')) {
        if (entry.startsWith('EVOLCLAW_HOME=')) return entry.slice('EVOLCLAW_HOME='.length);
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}
