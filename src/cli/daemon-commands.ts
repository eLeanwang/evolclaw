import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot, agentMdPath } from '../paths.js';
import { loadDefaults, loadAllAgents, mergeForAgent, loadEvolclawConfig, saveEvolclawConfig } from '../config-store.js';
import { resolveAnthropicConfig } from '../agents/baseagent.js';
import { migrateProject } from '../config-store.js';
import { ipcQuery } from '../ipc.js';
import { isHelpFlag } from './help.js';
import { cmdInit, needsControlAidInit, initTail } from './init.js';
import * as platform from '../utils/cross-platform.js';
import { EventBus } from '../core/event-bus.js';
import { tryUpgrade, tryUpgradeAunSdk, tryUpgradeGlobalPkg, resolveGlobalPkg, type UpgradeResult } from '../utils/npm-ops.js';
import { fetchEcwebPairCode } from '../utils/ecweb-pair.js';
import { resolveEcwebLaunchCommand } from '../utils/ecweb-launch.js';
import { resolveAunCoreSdkPkg, AUN_CORE_SDK_PKG } from '../aun/aid/client.js';
import { scanInstances, cleanupInstances, readAidLastActivity, findOrphanProcesses, killOrphans, type OrphanProcess } from '../utils/instance-registry.js';
import { filterLogFiles, deriveLogTypes, computePreChecked, validateLogTypes, shortLogName as shortLogNameLocal } from './watch-logs.js';
import { displaySessionTitle } from '../core/session/session-title.js';

const execFileAsync = promisify(execFile);

// 清理 Claude Code 环境变量，防止 SDK 认为是嵌套会话
export function cleanEnv() {
  for (const key of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete process.env[key];
  }
}

/**
 * 启动时归档过大的 stdout.log。其它 .log 文件由各自的 LogWriter 管理切片/清理，
 * 不再扫描整个目录——LogWriter 模式下重复的 size 检查会和 hourly rotation 冲突。
 */
function rotateStdoutIfNeeded(logDir: string) {
  if (!fs.existsSync(logDir)) return;
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const stdoutLog = path.join(logDir, 'stdout.log');

  // 归档当前 stdout.log（若超过 10MB）
  try {
    const stat = fs.statSync(stdoutLog);
    if (stat.size > MAX_SIZE) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const newPath = `${stdoutLog}.${timestamp}`;
      fs.renameSync(stdoutLog, newPath);
      console.log(`  Rotated: stdout.log -> ${path.basename(newPath)}`);
    }
  } catch { /* file not exist */ }

  // 清理 7 天前的 stdout.log.* 归档
  try {
    for (const file of fs.readdirSync(logDir)) {
      if (!file.startsWith('stdout.log.')) continue;
      const full = path.join(logDir, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

function countLines(pkgRoot: string, logDir: string) {
  // 生产安装：pkgRoot/src/；开发模式：pkgRoot 是 dist/，src/ 在其兄弟目录
  const srcCandidate = path.join(pkgRoot, 'src');
  const srcDir = fs.existsSync(srcCandidate)
    ? srcCandidate
    : path.join(pkgRoot, '..', 'src');
  const statsFile = path.join(logDir, 'line-stats.log');

  const countDir = (dir: string): number => {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += countDir(full);
      } else if (entry.name.endsWith('.ts')) {
        total += fs.readFileSync(full, 'utf-8').split('\n').length;
      }
    }
    return total;
  };

  const countFile = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return 0;
    return fs.readFileSync(filePath, 'utf-8').split('\n').length;
  };

  console.log('\n[launcher] 正在统计代码行数...\n');

  const core = countDir(path.join(srcDir, 'core'));
  const agents = countDir(path.join(srcDir, 'agents'));
  const channels = countDir(path.join(srcDir, 'channels'));
  const utils = countDir(path.join(srcDir, 'utils'));
  const cli = countDir(path.join(srcDir, 'cli'));
  const aun = countDir(path.join(srcDir, 'aun'));
  const entry = countFile(path.join(srcDir, 'index.ts'))
    + countFile(path.join(srcDir, 'config-store.ts'))
    + countFile(path.join(srcDir, 'types.ts'))
    + countFile(path.join(srcDir, 'ipc.ts'))
    + countFile(path.join(srcDir, 'paths.ts'));
  const total = core + agents + channels + utils + cli + aun + entry;

  console.log('==================================================');
  console.log('EvolClaw 代码统计');
  console.log('==================================================');
  console.log(`核心模块:         ${String(core).padStart(8)} 行`);
  console.log(`Agent 模块:       ${String(agents).padStart(8)} 行`);
  console.log(`渠道适配:         ${String(channels).padStart(8)} 行`);
  console.log(`工具库:           ${String(utils).padStart(8)} 行`);
  console.log(`CLI:              ${String(cli).padStart(8)} 行`);
  console.log(`AUN 协议:         ${String(aun).padStart(8)} 行`);
  console.log(`入口与配置:       ${String(entry).padStart(8)} 行`);
  console.log('--------------------------------------------------');
  console.log(`总计:             ${String(total).padStart(8)} 行`);
  console.log('==================================================');

  // 追加历史记录（仅在数据变化时）
  let shouldAppend = true;
  let prevTotal = 0;
  if (fs.existsSync(statsFile)) {
    const lines = fs.readFileSync(statsFile, 'utf-8').trim().split('\n');
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const parts = lastLine.split('\t');
      // 旧格式8列: time core agents channels utils entry total delta → total at [6]
      // 新格式10列: time core agents channels utils cli aun entry total delta → total at [8]
      const lastTotalStr = parts.length >= 10 ? parts[8] : parts[6];
      prevTotal = parseInt(lastTotalStr ?? parts[parts.length - 2], 10) || 0;
      if (prevTotal === total) {
        shouldAppend = false;
      }
    }
  }
  if (shouldAppend) {
    const _d = new Date();
    const _p = (n: number) => String(n).padStart(2, '0');
    const now = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`;
    const delta = total - prevTotal;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    fs.appendFileSync(statsFile, `${now}\t${core}\t${agents}\t${channels}\t${utils}\t${cli}\t${aun}\t${entry}\t${total}\t${deltaStr}\n`);
  }

  showHistory(statsFile);
}

function showHistory(statsFile: string) {
  if (!fs.existsSync(statsFile)) return;
  const lines = fs.readFileSync(statsFile, 'utf-8').trim().split('\n');
  if (lines.length < 2) return;

  const recent = lines.slice(-10);
  console.log('\n==================================================');
  console.log('历史记录（最近 10 次）');
  console.log('==================================================');
  console.log(`${'Time'.padEnd(19)} ${'Core'.padStart(6)} ${'Agent'.padStart(6)} ${'Chan'.padStart(6)} ${'Utils'.padStart(6)} ${'CLI'.padStart(6)} ${'AUN'.padStart(6)} ${'Entry'.padStart(6)} ${'Total'.padStart(6)} ${'Delta'.padStart(8)}`);
  console.log('--------------------------------------------------');

  let prevTotal: number | null = null;
  for (const line of recent) {
    const parts = line.split('\t');
    // 格式演进：
    // 旧6列: time core channels utils entry total
    // 旧7列: time core agents channels utils entry total
    // 旧8列: time core agents channels utils entry total delta
    // 新10列: time core agents channels utils cli aun entry total delta
    let time: string, c: string, a: string, ch: string, u: string, cl: string, au: string, e: string, t: string, d: string | undefined;
    if (parts.length >= 10) {
      [time, c, a, ch, u, cl, au, e, t, d] = parts;
    } else if (parts.length >= 8) {
      // 旧8列: time core agents channels utils entry total delta
      [time, c, a, ch, u, e, t, d] = parts;
      cl = '-'; au = '-';
    } else if (parts.length >= 7) {
      // 旧7列: time core agents channels utils entry total
      [time, c, a, ch, u, e, t] = parts;
      cl = '-'; au = '-';
    } else if (parts.length >= 6) {
      [time, c, ch, u, e, t] = parts;
      a = '-'; cl = '-'; au = '-';
    } else {
      continue;
    }
    const total = parseInt(t, 10);
    let diff: string;
    if (d) {
      diff = d;
    } else if (prevTotal !== null) {
      const change = total - prevTotal;
      diff = change >= 0 ? `+${change}` : `${change}`;
    } else {
      diff = '-';
    }
    console.log(`${time.padEnd(19)} ${c.padStart(6)} ${a.padStart(6)} ${ch.padStart(6)} ${u.padStart(6)} ${cl.padStart(6)} ${au.padStart(6)} ${e.padStart(6)} ${t.padStart(6)} ${diff.padStart(8)}`);
    prevTotal = total;
  }
  console.log('==================================================');
}

// ==================== Commands ====================

/**
 * 检测并展示跨 HOME 残留的 evolclaw 主进程。
 *
 * 这些孤儿不在自己 HOME 的 instance/ 登记簿内，instance-registry 的常规清理
 * （cleanupInstances）够不到。常见来源：
 *   - 测试套件 spawn 后未在 afterAll 杀子进程
 *   - 旧版本 pidfile 模式遗留（升级后 record 缺失）
 *
 * 仅打印提示，不主动杀；调用方决定是否清理。
 */
function reportOrphans(orphans: OrphanProcess[]): void {
  if (orphans.length === 0) return;
  console.log(`⚠ 检测到 ${orphans.length} 个未登记的 evolclaw 主进程（跨 HOME 残留）:`);
  for (const o of orphans) {
    const home = o.evolclawHome ?? '未知';
    console.log(`    PID ${o.pid}  EVOLCLAW_HOME=${home}`);
  }
  console.log('  这些进程不属于当前 HOME 的实例登记簿，自动清理不会处理它们。');
  console.log('  使用 evolclaw restart --clear 一并清掉，或手动 kill。');
}

function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function printStartupInfo(opts: { pid?: number; running?: boolean } = {}): void {
  const pkgRoot = getPackageRoot();
  const isNpmInstall = pkgRoot.includes('node_modules');
  const cliRunsSource = !import.meta.url.includes('/dist/');
  const daemonEntry = path.join(pkgRoot, 'dist', 'index.js');
  const daemonRunsDist = fs.existsSync(daemonEntry);

  const scanDir = path.join(pkgRoot, daemonRunsDist ? 'dist' : 'src');
  let latestMtime = 0;
  const scanRecursive = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanRecursive(full); continue; }
        if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
          const mt = fs.statSync(full).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        }
      }
    } catch {}
  };
  scanRecursive(scanDir);

  let version = '?';
  try { version = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8')).version; } catch {}

  let aunVer: string | null = null;
  try {
    aunVer = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'node_modules', '@agentunion', 'fastaun', 'package.json'), 'utf-8')).version;
  } catch {}

  const pidPart = opts.pid ? ` (PID: ${opts.pid})` : '';
  const aunPart = aunVer ? `  fastaun v${aunVer}` : '';
  const prefix = opts.running ? '✓ EvolClaw is running , v' : '  EvolClaw v';
  console.log(`${prefix}${version}${pidPart}${aunPart}`);
  console.log(`  包路径:     ${pkgRoot}`);
  console.log(`  安装类型:   ${isNpmInstall ? 'npm全局安装' : '开发仓(link)'}`);
  console.log(`  CLI执行:    ${cliRunsSource ? '源码(tsx)' : '编译产物(dist)'}`);
  console.log(`  Daemon执行: ${daemonRunsDist ? '编译产物(dist)' : '未知'}`);
  console.log(`  代码时间:   ${latestMtime ? formatLocalTime(latestMtime) : '?'}`);
}

export async function cmdStart(opts: { diagnose?: boolean } = {}) {
  const cmdStartedAt = Date.now();
  printStartupInfo();

  const p = resolvePaths();
  ensureDataDirs();

  // 旧配置自动迁移（evolclaw.json → 新结构）
  const { autoMigrateIfNeeded } = await import('../config-store.js');
  autoMigrateIfNeeded();

  // 未初始化时自动引导：无 defaults 文件且无任何 agent → 视为未初始化
  // （baseagents 已从 defaults 移入各 agent behavior.json，故改用"有无 agent"判定）
  const defaults = loadDefaults();
  const hasAnyAgent = loadAllAgents().agents.length > 0;
  if (!defaults && !hasAnyAgent) {
    console.log('⚡ 未检测到初始化配置，自动启动初始化向导...\n');
    await cmdInit();
    return;
  }

  // 种入网关配置：从 env / settings.json 导入 baseUrl+apiKey 到 defaults（幂等）
  const { reconcileBaseagentDefaults } = await import('../core/baseagent-seed.js');
  reconcileBaseagentDefaults();

  // 控制 AID 门禁：缺 aid 且交互式 → 只补全控制 AID + owners（不重走 baseagent 向导）。
  // 非 TTY（restart-monitor/systemd/管道）不补全（无法交互），只提示后继续启动，daemon 侧 warn 兜底。
  const evolclawCfgStart = loadEvolclawConfig();
  if (needsControlAidInit(evolclawCfgStart.aid, !!process.stdin.isTTY)) {
    console.log('⚡ 控制 AID 未配置，自动补全...\n');
    const { suppressSdkLogs } = await import('../aun/aid/index.js');
    suppressSdkLogs();
    await initTail();
    return;
  }
  if (!evolclawCfgStart.aid) {
    console.log('⚠ 控制 AID 未配置（非交互式启动，跳过补全）。如需进程身份/远程管理，请运行 evolclaw init');
  } else if (process.stdin.isTTY) {
    // 证书缺失时在 CLI 侧提示，daemon 是后台进程无终端不做交互
    const certKey = path.join(resolvePaths().root, 'AIDs', evolclawCfgStart.aid, 'private', 'key.json');
    if (!fs.existsSync(certKey)) {
      console.log(`⚠ 控制 AID 证书缺失：${evolclawCfgStart.aid}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await new Promise<string>(res => rl.question('  [1] 继续启动  [2] 重新生成 AID  [3] 退出 [1/2/3]: ', res));
      rl.close();
      if (ans.trim() === '3') { process.exit(0); }
      if (ans.trim() === '2') {
        const { suppressSdkLogs } = await import('../aun/aid/index.js');
        suppressSdkLogs();
        const { generateControlAid } = await import('../aun/aid/control-aid.js');
        const result = await generateControlAid();
        saveEvolclawConfig({ ...loadEvolclawConfig(), aid: result.aid });
        console.log(`✓ 新控制 AID: ${result.aid}`);
      }
    }
  }

  // 检查至少有一个 self-agent
  const { agents, skipped } = loadAllAgents();
  if (agents.length === 0) {
    console.log('❌ 未配置任何 self-agent。');
    console.log('');
    console.log('创建方式：');
    console.log('  1. 下载 Evol App（https://evolai.cn）→ 创建 Agent → 将引导文本输入给 baseagent 执行');
    console.log('  2. 手动创建：evolclaw agent new <your-aid>.agentid.pub');
    console.log('');
    if (skipped.length > 0) {
      console.log(`跳过的目录:`);
      for (const s of skipped) console.log(`  - ${s.dirName}: ${s.reason}`);
    }
    process.exit(1);
  }

  // 检查 instance 目录中的进程状态
  const status = scanInstances();
  const aliveMains = status.mains.filter(m => m.alive);
  if (aliveMains.length > 0) {
    const first = aliveMains[0];
    console.log(`  EvolClaw is already running (PID: ${aliveMains.map(m => m.record.pid).join(', ')})`);
    console.log(`  启动于: ${new Date(first.record.startedAtIso).toLocaleString()}`);
    console.log(`  启动方式: ${first.record.launchedBy}`);
    // 报告 AID 状态
    if (status.aidLastActivity.size > 0) {
      console.log('  AID 状态:');
      const now = Date.now();
      for (const [aid, info] of status.aidLastActivity) {
        const ago = formatTimeAgo(now - info.ts);
        const symbol = info.event === 'disconnected' ? '✗' : '✓';
        console.log(`    ${symbol} ${aid} — 最后活动 ${ago} (${info.event})`);
      }
    }
    console.log('  使用 evolclaw restart 重启，或 evolclaw stop 先停止');
    process.exit(1);
  }

  // 清理残留进程和文件
  if (status.mains.length > 0 || status.restartMonitors.length > 0) {
    const killed = cleanupInstances();
    if (killed.length > 0) {
      console.log(`⚠ 清理了 ${killed.length} 个残留进程: ${killed.join(', ')}`);
      await sleep(2000);
    }
  }

  // 跨 HOME 孤儿（未登记进程）只警告，不动
  reportOrphans(findOrphanProcesses());

  console.log('🚀 Starting EvolClaw...');
  rotateStdoutIfNeeded(p.logs);
  cleanEnv();

  // 删除旧的 ready signal
  try { fs.unlinkSync(p.readySignal); } catch {}

  const stdoutLog = path.join(p.logs, 'stdout.log');
  const out = fs.openSync(stdoutLog, 'a');
  const err = fs.openSync(stdoutLog, 'a');

  const appMain = path.join(getPackageRoot(), 'dist', 'index.js');
  const child = spawn('node', ['--no-warnings=ExperimentalWarning', appMain], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: {
      ...process.env,
      EVOLCLAW_HOME: p.root,
      EVOLCLAW_LAUNCHED_BY: 'start',
      LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
      MESSAGE_LOG: process.env.MESSAGE_LOG || 'true',
      EVENT_LOG: process.env.EVENT_LOG || 'true',
      ...(opts.diagnose ? { EVOLCLAW_DIAGNOSE: '1' } : {}),
    }
  });

  const childPid = child.pid!;
  child.unref();

  // 等待 ready signal（最多 30 秒，AUN sidecar 超时 15s + 其他通道连接）
  const startTime = Date.now();
  const checkReady = async () => {
    // ready signal 出现（优先检查，避免 Windows 上误判进程状态）
    if (fs.existsSync(p.readySignal)) {
      console.log(`✓ EvolClaw started successfully (PID: ${childPid})`);
      console.log(`  EVOLCLAW_HOME: ${resolveRoot()}`);
      console.log(`  Logs: ${p.logs}/`);

      // 从主日志提取渠道连接摘要
      const mainLog = findLatestLog(p.logs, 'evolclaw');
      if (mainLog) {
        const logLines = fs.readFileSync(mainLog, 'utf-8').split('\n');
        // 从末尾往前找最近一次启动的摘要
        let channelSummary = '';
        for (let i = logLines.length - 1; i >= 0; i--) {
          if (logLines[i].includes('EvolClaw is running with')) {
            channelSummary = logLines[i];
            break;
          }
        }
        if (channelSummary) {
          const match = channelSummary.match(/running with .+/);
          if (match) console.log(`  ${match[0]}`);
        }
        // 最近一次启动的失败信息
        let lastReadyIdx = -1;
        for (let i = logLines.length - 1; i >= 0; i--) {
          if (logLines[i].includes('Ready signal written')) {
            lastReadyIdx = i;
            break;
          }
        }
        if (lastReadyIdx > 0) {
          for (let i = Math.max(0, lastReadyIdx - 20); i < lastReadyIdx; i++) {
            const line = logLines[i];
            if (line.includes('failed to connect') || line.includes('Failed to create channel')) {
              const match = line.match(/\[WARN\]\s*(.+)/);
              console.log(`  ⚠ ${match ? match[1] : line.trim()}`);
            }
          }
        }
      }
      console.log('');
      // 代码统计仅在开发环境显示（EVOLCLAW_HOME 指向包目录）
      if (resolveRoot() === getPackageRoot()) {
        countLines(getPackageRoot(), p.logs);
      }
      console.log(`⏱ done in ${((Date.now() - cmdStartedAt) / 1000).toFixed(1)}s`);
      // ECWeb 自动后台启动
      await startEcwebIfEnabled(p);
      return;
    }

    // 超时
    if (Date.now() - startTime > 30000) {
      console.log('❌ Failed to start EvolClaw (ready signal timeout)');
      console.log('');
      console.log('📝 Error details (last 10 lines of stdout):');
      if (fs.existsSync(stdoutLog)) {
        const content = fs.readFileSync(stdoutLog, 'utf-8').trim().split('\n');
        console.log(content.slice(-10).map(l => `  ${l}`).join('\n'));
      }
      console.log(`⏱ failed after ${((Date.now() - cmdStartedAt) / 1000).toFixed(1)}s`);
      process.exit(1);
      return;
    }

    // 进程已退出且无 ready signal
    if (!platform.isProcessRunning(childPid)) {
      // 给进程一点时间写 ready signal（可能刚好在写入中）
      if (Date.now() - startTime > 3000) {
        console.log('❌ Failed to start EvolClaw');
        console.log('');
        console.log('📝 Error details (last 10 lines of stdout):');
        if (fs.existsSync(stdoutLog)) {
          const content = fs.readFileSync(stdoutLog, 'utf-8').trim().split('\n');
          console.log(content.slice(-10).map(l => `  ${l}`).join('\n'));
        }
        console.log(`⏱ failed after ${((Date.now() - cmdStartedAt) / 1000).toFixed(1)}s`);
        process.exit(1);
        return;
      }
    }

    setTimeout(checkReady, 500);
  };

  setTimeout(checkReady, 1000);
}

async function stopPid(pid: number): Promise<void> {
  console.log(`🛑 Stopping EvolClaw (PID: ${pid})...`);
  platform.killProcess(pid);

  await new Promise<void>((resolve) => {
    let waited = 0;
    const check = setInterval(() => {
      waited++;
      if (!platform.isProcessRunning(pid)) {
        clearInterval(check);
        console.log('✓ EvolClaw stopped');
        resolve();
        return;
      }
      if (waited >= 10) {
        clearInterval(check);
        platform.killProcess(pid, true);
        console.log('✓ EvolClaw stopped (forced)');
        resolve();
      }
    }, 1000);
  });
}

export async function cmdStop() {
  const status = scanInstances();
  const aliveMains = status.mains.filter(m => m.alive);
  if (aliveMains.length === 0) {
    console.log('⚠ EvolClaw is not running');
    return;
  }
  await Promise.all(aliveMains.map(m => stopPid(m.record.pid)));
  await sleep(500);
  cleanupInstances();
  if (aliveMains.length > 1) {
    console.log(`⚠ 停止了 ${aliveMains.length} 个 main 实例: ${aliveMains.map(m => m.record.pid).join(', ')}`);
  }
}

export async function cmdRestart(opts: { clear?: boolean; diagnose?: boolean } = {}) {
  const cmdStartedAt = Date.now();

  console.log('🔄 Restarting EvolClaw...');

  // 版本检查与自动升级
  console.log('📦 Checking for updates...');
  const upgrade = await tryUpgrade();
  switch (upgrade.status) {
    case 'upgraded':
      console.log(`✅ Upgraded: ${upgrade.from} → ${upgrade.to}`);
      break;
    case 'no-update':
      console.log(`✓ Already up to date (${upgrade.from})`);
      break;
    case 'skipped':
      console.log(upgrade.error
        ? '⏭ Skipped upgrade (network unavailable)'
        : '⏭ Skipped upgrade check (dev mode)');
      break;
    case 'failed':
      console.log(`⚠ Upgrade failed (${upgrade.from} → ${upgrade.to}), continuing with current version`);
      break;
  }

  // AUN SDK 版本检查与升级
  const aunUpgrade = await tryUpgradeAunSdk(resolveAunCoreSdkPkg, AUN_CORE_SDK_PKG);
  switch (aunUpgrade.status) {
    case 'upgraded':
      console.log(`✅ AUN SDK upgraded: ${aunUpgrade.from} → ${aunUpgrade.to}`);
      break;
    case 'no-update':
      break; // silent
    case 'failed':
      console.log(`⚠ AUN SDK upgrade failed (${aunUpgrade.from} → ${aunUpgrade.to})`);
      break;
  }

  // evolclaw-web 版本检查与升级（已安装才检查，与 AUN SDK 同级）
  const ecwebUpgrade = await tryUpgradeGlobalPkg(() => resolveGlobalPkg('evolclaw-web'), 'evolclaw-web');
  switch (ecwebUpgrade.status) {
    case 'upgraded':
      console.log(`✅ evolclaw-web upgraded: ${ecwebUpgrade.from} → ${ecwebUpgrade.to}`);
      break;
    case 'no-update':
      break; // silent
    case 'failed':
      console.log(`⚠ evolclaw-web upgrade failed (${ecwebUpgrade.from} → ${ecwebUpgrade.to})`);
      break;
  }

  // 停止所有活 main 进程（可能不止一个）
  const status = scanInstances();
  const aliveMains = status.mains.filter(m => m.alive);
  if (aliveMains.length > 0) {
    if (aliveMains.length > 1) {
      console.log(`⚠ 检测到 ${aliveMains.length} 个 main 实例，将一并停止: ${aliveMains.map(m => m.record.pid).join(', ')}`);
    }
    await Promise.all(aliveMains.map(m => stopPid(m.record.pid)));
    await sleep(500);
  }
  cleanupInstances();

  // 孤儿处理：同 HOME 的孤儿无条件 kill（restart 必须替换旧实例）；
  // 跨 HOME 的孤儿只在 --clear 时 kill，否则仅警告。
  {
    const orphans = findOrphanProcesses();
    const currentHome = resolveRoot();
    const sameHome = orphans.filter(o => o.evolclawHome === currentHome);
    const otherHome = orphans.filter(o => o.evolclawHome !== currentHome);
    if (sameHome.length > 0) {
      const killed = killOrphans(sameHome);
      console.log(`☠ 已 SIGKILL ${killed.length} 个同 HOME 孤儿进程: ${killed.join(', ')}`);
      await sleep(500);
    }
    if (opts.clear && otherHome.length > 0) {
      const killed = killOrphans(otherHome);
      console.log(`☠ 已 SIGKILL ${killed.length} 个跨 HOME 孤儿进程: ${killed.join(', ')}`);
      await sleep(500);
    }
  }

  // 清理 codex app-server 孤儿进程（无 HOME 区分，全局清理）
  {
    const killed = stopCodexAppServerOrphans();
    if (killed > 0) {
      console.log(`☠ 已清理 ${killed} 个 codex app-server 孤儿进程`);
      await sleep(500);
    }
  }

  console.log(`⏱ restart prep done in ${((Date.now() - cmdStartedAt) / 1000).toFixed(1)}s, starting...`);
  setTimeout(() => cmdStart(), 1000);
}

export async function cmdDev(args: string[]) {
  const pkgRoot = getPackageRoot();
  const isNpmInstall = pkgRoot.includes('node_modules');
  const p = resolvePaths();
  const devMarker = path.join(p.dataDir, 'dev-repo.path');
  const sub = args[0];

  if (!sub) {
    if (!isNpmInstall) {
      console.log(`当前: [dev] ${pkgRoot}`);
      console.log('');
      console.log('断开开发仓链接:');
      console.log('  evolclaw dev off');
    } else {
      console.log(`当前: [pkg] ${pkgRoot}`);
      console.log('');
      let devPath: string | null = null;
      try { devPath = fs.readFileSync(devMarker, 'utf-8').trim(); } catch {}
      if (devPath && fs.existsSync(devPath)) {
        console.log('链接到开发仓:');
        console.log(`  evolclaw dev on`);
        console.log(`  (已记录路径: ${devPath})`);
      } else {
        console.log('链接到开发仓:');
        console.log('  evolclaw dev <开发仓路径>');
      }
    }
    return;
  }

  if (sub === 'off') {
    if (isNpmInstall) {
      console.log('当前已是 [pkg] 模式，无需断开');
      return;
    }
    console.log('🔗 断开开发仓链接...');
    let npmPrefix: string;
    if (process.platform === 'win32' && process.env.APPDATA) {
      npmPrefix = path.join(process.env.APPDATA, 'npm');
    } else {
      npmPrefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf-8', shell: true }).trim();
    }
    const linkPath = path.join(npmPrefix, 'node_modules', 'evolclaw');
    const binPath = path.join(npmPrefix, 'evolclaw');
    try { fs.rmSync(linkPath, { recursive: true }); } catch {}
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.unlinkSync(binPath + '.cmd'); } catch {}
    try { fs.unlinkSync(binPath + '.ps1'); } catch {}
    console.log('✓ 已断开');
    console.log(`  已删除: ${linkPath}`);
    console.log(`  如需恢复: evolclaw dev on（需从已安装的 evolclaw 执行）`);
    return;
  }

  if (sub === 'on') {
    if (!isNpmInstall) {
      console.log(`当前已是 [dev] 模式: ${pkgRoot}`);
      return;
    }
    let devPath: string | null = null;
    try { devPath = fs.readFileSync(devMarker, 'utf-8').trim(); } catch {}
    if (!devPath || !fs.existsSync(devPath)) {
      console.log('未记录开发仓路径');
      console.log('');
      console.log('用法: evolclaw dev <开发仓路径>');
      process.exit(1);
    }
    console.log(`🔗 链接开发仓: ${devPath}`);
    try {
      execFileSync('npm', ['link'], { stdio: 'inherit', cwd: devPath, shell: true });
      console.log(`✓ 已链接 [dev] ${devPath}`);
    } catch (e: any) {
      console.error('❌ npm link 失败:', e.message);
      process.exit(1);
    }
    return;
  }

  // evolclaw dev <path> — 记录路径 + 建立链接
  const devPath = path.resolve(sub);
  const pkgJson = path.join(devPath, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    console.error(`❌ 路径不存在或无 package.json: ${devPath}`);
    process.exit(1);
  }
  let pkg: any;
  try { pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')); } catch {
    console.error(`❌ 无法解析 package.json: ${pkgJson}`);
    process.exit(1);
  }
  if (pkg.name !== 'evolclaw') {
    console.error(`❌ package.json name 不是 evolclaw（是 "${pkg.name}"）`);
    process.exit(1);
  }

  // 已经链接到同一路径，只记录不重复 link
  if (!isNpmInstall && path.resolve(pkgRoot) === devPath) {
    fs.mkdirSync(p.dataDir, { recursive: true });
    fs.writeFileSync(devMarker, devPath, 'utf-8');
    console.log(`✓ 当前已链接到该路径，路径已记录`);
    return;
  }

  console.log(`🔗 链接开发仓: ${devPath}`);
  try {
    execFileSync('npm', ['link'], { stdio: 'inherit', cwd: devPath, shell: true });
  } catch (e: any) {
    console.error('❌ npm link 失败:', e.message);
    process.exit(1);
  }

  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.writeFileSync(devMarker, devPath, 'utf-8');
  console.log(`✓ 已链接 [dev] ${devPath}`);
  console.log(`  路径已记录，下次可用 evolclaw dev on 快速切换`);
}

function formatTimeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  return `${day}天前`;
}

/** 双字符宽字符 padding：中文/emoji 算 2 列，其他算 1 列 */
function visualWidth(s: string): number {
  // Strip ANSI escape sequences (color codes etc.) before measuring
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK / Hangul / 全角符号 / Emoji 等宽字符
    if (
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x9FFF) ||
      (code >= 0xA000 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFE30 && code <= 0xFE4F) ||
      (code >= 0xFF00 && code <= 0xFF60) ||
      (code >= 0x1F300 && code <= 0x1FAFF)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padRight(s: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(s));
  return s + ' '.repeat(pad);
}

const AID_STATUS_LABELS: Record<string, string> = {
  connected: '✓ Connected',
  reconnecting: '⏳ Reconnecting',
  aid_blocked: '🔒 AID Blocked',
  kicked: '✗ Kicked',
  failed: '✗ Failed',
  disabled: '○ Disabled',
};

function renderAunAidsTable(aids: any[]): void {
  // Column widths（视觉宽度）：AGENT 列按实际名字最长值动态扩展
  const agentNames = aids.map(a => (a.agentName || '?').replace(/\.agentid\.pub$/, ''));
  const COL_AGENT = Math.max(5, ...agentNames.map(n => n.length)) + 2;
  const COL_AID = 32;
  const COL_STATUS = 16;
  const COL_RECONN = 8;
  const COL_LAST = 14;

  // 表头
  console.log(
    '  ' +
    padRight('AGENT', COL_AGENT) +
    padRight('AID', COL_AID) +
    padRight('STATUS', COL_STATUS) +
    padRight('RECONN', COL_RECONN) +
    padRight('LAST ATTEMPT', COL_LAST) +
    'NOTE'
  );

  for (let i = 0; i < aids.length; i++) {
    const a = aids[i];
    const agent = agentNames[i];
    const aid = (a.aid || '?').slice(0, COL_AID - 1);
    const statusLabel = AID_STATUS_LABELS[a.status] || a.status || '?';
    const reconn = String(a.reconnectCount ?? 0);
    const lastAttempt = a.lastAttemptAt
      ? formatTimeAgo(Date.now() - a.lastAttemptAt)
      : '—';

    let note = '';
    if (a.status === 'connected' && a.lastConnectedAt) {
      note = `uptime ${formatTimeAgo(Date.now() - a.lastConnectedAt).replace('前', '')}`;
    } else if (a.status === 'aid_blocked' && a.blockedBy) {
      const home = (a.blockedBy.evolclawHome || '').replace(os.homedir(), '~');
      const ag = a.blockedBy.agentName ? `, agent=${a.blockedBy.agentName}` : '';
      note = `held by PID ${a.blockedBy.pid} (HOME=${home}${ag})`;
    } else if (a.lastError) {
      note = a.lastError;
    }

    console.log(
      '  ' +
      padRight(agent, COL_AGENT) +
      padRight(aid, COL_AID) +
      padRight(statusLabel, COL_STATUS) +
      padRight(reconn, COL_RECONN) +
      padRight(lastAttempt, COL_LAST) +
      note
    );
  }
}

function showConfigChannels(config: any) {
  const groups: Array<{ type: string; instances: string[] }> = [];

  const channelChecks: Array<{ type: string; isValid: (inst: any) => boolean }> = [
    { type: 'feishu', isValid: (inst: any) => !!inst.appId && inst.enabled !== false },
    { type: 'wechat', isValid: (inst: any) => !!inst.token && inst.enabled !== false },
    { type: 'aun', isValid: (inst: any) => !!inst.aid && inst.enabled !== false && !inst.aid.includes('your-') && !inst.aid.includes('placeholder') },
    { type: 'dingtalk', isValid: (inst: any) => !!inst.clientId && inst.enabled !== false && !inst.clientId.includes('your-') && !inst.clientId.includes('placeholder') },
    { type: 'qqbot', isValid: (inst: any) => !!inst.appId && inst.enabled !== false && !inst.appId.includes('your-') && !inst.appId.includes('placeholder') },
    { type: 'wecom', isValid: (inst: any) => !!inst.botId && inst.enabled !== false && !inst.botId.includes('your-') && !inst.botId.includes('placeholder') },
  ];

  for (const { type, isValid } of channelChecks) {
    const raw = config.channels?.[type];
    if (!raw) continue;
    if (Array.isArray(raw)) {
      const names = raw.filter(isValid).map((inst: any) => inst.name || type);
      if (names.length > 0) groups.push({ type, instances: names });
    } else if (isValid(raw)) {
      groups.push({ type, instances: [raw.name || type] });
    }
  }

  if (groups.length > 0) {
    for (const g of groups) {
      if (g.instances.length === 1) {
        console.log(`  ${g.instances[0]}: ✓ Configured`);
      } else {
        console.log(`  ${g.type}: [${g.instances.join(', ')}]`);
      }
    }
  } else {
    console.log('  (no channels configured)');
  }
}

export async function cmdStatus() {
  const p = resolvePaths();
  const status = scanInstances();
  const aliveMains = status.mains.filter(m => m.alive);
  const pid = aliveMains.length > 0 ? aliveMains[0].record.pid : null;

  if (aliveMains.length > 1) {
    console.log(`⚠ 检测到 ${aliveMains.length} 个 main 实例同时运行: ${aliveMains.map(m => m.record.pid).join(', ')}`);
    console.log('  这是异常状态，建议执行 evolclaw restart 让所有实例统一退出');
    console.log('');
  }

  if (pid) {
    printStartupInfo({ pid, running: true });
    console.log('');
    console.log('📊 Process Info:');
    try {
      const info = platform.getProcessInfo(pid);
      if (info.uptime) console.log(`  Uptime: ${info.uptime}`);
      if (info.cpu) console.log(`  CPU: ${info.cpu}%`);
      if (info.memory) {
        const memKB = parseInt(info.memory, 10);
        const memStr = memKB >= 1024 ? `${(memKB / 1024).toFixed(0)} MB` : `${memKB} KB`;
        console.log(`  Memory: ${memStr}`);
      }
    } catch {}
    console.log(`  EVOLCLAW_HOME: ${resolveRoot()}`);

    // Runtime statistics (read from sessions filesystem)
    if (fs.existsSync(p.sessionsDir)) {
      try {
        const { scanChatDirs, scanMetaFiles, readJsonFile, readLastJsonlLine } = await import('../core/session/session-fs-store.js');
        type SF = import('../core/session/session-fs-store.js').SessionFile;

        const chatDirs = scanChatDirs(p.sessionsDir);

        // 收集所有 session（active + 各 meta 最后一行）
        type SessionRow = SF & { isActive: boolean };
        const allSessions: SessionRow[] = [];
        for (const { dirPath } of chatDirs) {
          const active = readJsonFile<SF>(path.join(dirPath, 'active.json'));
          if (active) allSessions.push({ ...active, isActive: true });
          for (const metaFile of scanMetaFiles(dirPath)) {
            const meta = readLastJsonlLine<SF>(path.join(dirPath, metaFile));
            if (!meta) continue;
            // 跳过同 id 的（active.json 已经是它的最新版）
            if (active && active.id === meta.id) continue;
            allSessions.push({ ...meta, isActive: false });
          }
        }

        // 最近 5 个（按 updatedAt 倒排）
        const recentSessions = [...allSessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

        // 检测 orphan：session 的 channel 实例名不在任何 self-agent 配置内
        let orphanCount = 0;
        try {
          const { agents } = loadAllAgents();
          const configChannelNames = new Set<string>();
          for (const cfg of agents) {
            // AUN 是从 agent 自身 AID 隐式派生的内建通道，不出现在 cfg.channels 里。
            // 不补这条，所有 aun#<aid>#main 会话都会被误判成 orphan。
            configChannelNames.add(`aun#${cfg.aid}#main`);
            for (const inst of cfg.channels) {
              // effective key: <type>#<selfAID>#<name>
              configChannelNames.add(`${inst.type}#${cfg.aid}#${inst.name}`);
            }
          }
          for (const s of allSessions) {
            if (!configChannelNames.has(s.channel)) orphanCount++;
          }
        } catch {}

        if (recentSessions.length > 0) {
          console.log('');
          console.log('📋 Recent Active Sessions:');
          for (const s of recentSessions) {
            const projectName = path.basename(s.projectPath);
            const sessionType = s.threadId ? '话题会话' : '主会话';
            const chatType = s.chatType === 'group' ? '群聊' : '单聊';
            const sessionName = displaySessionTitle(s.name);
            const timeAgo = formatTimeAgo(Date.now() - s.updatedAt);
            const dot = s.isActive ? '•' : '○';
            const agentSidLabel = s.agentSessionId ? ` [${s.agentSessionId}]` : '';
            const agentType = s.agentType || 'claude';
            console.log(`  ${dot} [${agentType}] ${projectName} / ${sessionName} (${sessionType}, ${chatType})${agentSidLabel} - ${timeAgo}`);
          }
        }

        if (orphanCount > 0) {
          console.log('');
          console.log(`⚠ Orphan sessions: ${orphanCount}`);
        }
      } catch {}
    }
  } else {
    console.log('⚠ EvolClaw is not running');
  }

  // Session & Project statistics (从文件系统读)
  if (fs.existsSync(p.sessionsDir)) {
    console.log('');
    console.log('📦 Sessions & Projects:');
    try {
      const { scanChatDirs, scanMetaFiles, readJsonFile, readLastJsonlLine } = await import('../core/session/session-fs-store.js');
      type SF = import('../core/session/session-fs-store.js').SessionFile;

      const chatDirs = scanChatDirs(p.sessionsDir);
      let totalSessions = 0;
      let activeSessions = 0;
      const channelIdSet = new Set<string>();
      const projectSet = new Set<string>();

      for (const { channelId, dirPath } of chatDirs) {
        channelIdSet.add(channelId);
        const active = readJsonFile<SF>(path.join(dirPath, 'active.json'));
        if (active) {
          activeSessions++;
          projectSet.add(active.projectPath);
        }
        for (const metaFile of scanMetaFiles(dirPath)) {
          const meta = readLastJsonlLine<SF>(path.join(dirPath, metaFile));
          if (!meta) continue;
          totalSessions++;
          projectSet.add(meta.projectPath);
        }
      }

      console.log(`  Total sessions: ${totalSessions} (active: ${activeSessions})`);
      console.log(`  Unique chats: ${channelIdSet.size}`);
      console.log(`  Projects: ${projectSet.size}`);
    } catch {}
  }

  // Channel status
  if (fs.existsSync(p.defaultsConfig)) {
    console.log('');
    const config = JSON.parse(fs.readFileSync(p.defaultsConfig, 'utf-8'));

    if (pid) {
      // Running: query IPC for real-time status
      const status = await ipcQuery(p.socket, { type: 'status' });
      if (status) {
        // 🔑 AUN AIDs 表格（详细 AUN 实例状态）
        try {
          const aidsResp = await ipcQuery<{ ok: boolean; aids: any[] }>(p.socket, { type: 'aun-aids' });
          if (aidsResp?.ok && aidsResp.aids?.length > 0) {
            console.log('🔑 AUN AIDs:');
            renderAunAidsTable(aidsResp.aids);
          }
        } catch { /* ignore */ }

        // 控制 AID（daemon 进程身份）状态
        if (status.controlAid) {
          const state = status.controlAid.connected ? 'connected' : 'disconnected';
          console.log(`control: ${status.controlAid.aid}  [${state}]`);
        } else {
          console.log('control: not configured');
        }

        if (status.stats) {
          console.log('');
          console.log('📊 Last hour:');
          console.log(`  Messages: ${status.stats.received} received, ${status.stats.completed} completed`);
          if (status.stats.errors > 0) console.log(`  Errors: ${status.stats.errors}`);
          if (status.stats.completed > 0) console.log(`  Avg response: ${(status.stats.avgResponseMs / 1000).toFixed(1)}s`);
        }
      } else {
        // IPC unreachable but PID exists — show config only
        console.log('🔌 Channels (IPC unreachable):');
        showConfigChannels(config);
      }
    } else {
      console.log('🔌 Channel Configuration:');
      showConfigChannels(config);
    }
  }

  // EvolAgent summary (via IPC, only when running)
  if (pid) {
    try {
      const agentResult = await ipcQuery(p.socket, { type: 'evolagent.list' }) as any;
      if (agentResult?.ok && agentResult.agents?.length > 0) {
        const agents = agentResult.agents;
        if (agents.length > 0) {
          console.log('');
          console.log('🤖 EvolAgents:');
          for (const a of agents) {
            const statusIcon = a.status === 'running' ? '●' : a.status === 'error' ? '✗' : a.status === 'disabled' ? '○' : '◌';
            const channels = summarizeChannelFingerprints(a.channels || []);
            const shortName = a.name.replace(/\.agentid\.pub$/, '');
            console.log(`  ${statusIcon} ${shortName.padEnd(20)} ${a.status.padEnd(10)} ${channels}`);
          }
        }
      }
    } catch {
      // IPC query for agents failed — skip section
    }
  }

  // ECWeb status（独立于 main 进程：ecweb 是单独 detached 进程）
  await printEcwebStatus(p);
}

/**
 * 把 channel fingerprint 列表（`<type>#<selfAID>#<name>`）折叠成展示用摘要。
 *
 * 聚合规则：
 *   - 按 type 分组
 *   - 单实例：直接打 type（如 `aun`、`wechat`）
 *   - 多实例：`type×N (name1, name2, ...)`
 *   - 输出顺序保持首次出现的 type 顺序（aun 通常排第一，因为 channelInstanceNames 把它放头）
 */
function summarizeChannelFingerprints(fingerprints: string[]): string {
  if (fingerprints.length === 0) return '—';
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const fp of fingerprints) {
    const parts = fp.split('#');
    if (parts.length < 3) {
      if (!groups.has(fp)) { groups.set(fp, []); order.push(fp); }
      continue;
    }
    const type = parts[0];
    const name = parts[2];
    if (!groups.has(type)) { groups.set(type, []); order.push(type); }
    groups.get(type)!.push(name);
  }
  return order.map(type => {
    const names = groups.get(type)!;
    if (names.length === 0) return type;
    if (names.length === 1) return type;
    return `${type}×${names.length} (${names.join(', ')})`;
  }).join(', ');
}

// Log line pattern: [timestamp] [LEVEL] [Module?] message
const LOG_RE = /^(\[[^\]]+\]) (\[(?:INFO|WARN|ERROR|DEBUG)\]) ((?:\[[^\]]+\] )*)(.*)$/;
const MAX_MSG = 200; // truncate long messages

function makeColors(enabled: boolean) {
  const e = (code: string) => enabled ? code : '';
  return {
    reset: e('\x1b[0m'), dim: e('\x1b[2m'), bold: e('\x1b[1m'),
    red: e('\x1b[31m'), yellow: e('\x1b[33m'), cyan: e('\x1b[36m'),
    magenta: e('\x1b[35m'), gray: e('\x1b[90m'),
  };
}

function renderLogLine(line: string, opts: { level?: string; module?: string; color: boolean }): string | null {
  const m = line.match(LOG_RE);
  if (!m) return line; // passthrough non-standard lines (stack traces etc.)

  const [, ts, levelTag, modulePart, msg] = m;
  const level = levelTag.slice(1, -1); // strip brackets

  // Level filter
  if (opts.level) {
    const want = opts.level.toUpperCase();
    if (want === 'ERROR' && level !== 'ERROR') return null;
    if (want === 'WARN' && level !== 'WARN' && level !== 'ERROR') return null;
  }

  // Module filter (case-insensitive substring match)
  if (opts.module) {
    const mod = modulePart.toLowerCase();
    if (!mod.includes(opts.module.toLowerCase())) return null;
  }

  // Truncate long messages (always, regardless of color)
  const truncated = msg.length > MAX_MSG ? msg.slice(0, MAX_MSG) + '…' : msg;

  const C = makeColors(opts.color);

  // Color by level
  const levelColor = level === 'ERROR' ? C.red : level === 'WARN' ? C.yellow : level === 'DEBUG' ? C.gray : '';

  // Highlight user messages: [channel] channelId: text
  const isUserMsg = modulePart && /^\S+: .+$/.test(truncated);
  const renderedMsg = isUserMsg
    ? C.cyan + truncated + C.reset
    : levelColor + truncated + C.reset;

  return (
    C.dim + ts + C.reset + ' ' +
    levelColor + C.bold + levelTag + C.reset + ' ' +
    C.magenta + modulePart.trimEnd() + C.reset +
    (modulePart ? ' ' : '') +
    renderedMsg
  );
}

function findLatestLog(logDir: string, baseName: string): string | null {
  if (!fs.existsSync(logDir)) return null;
  // Try exact name first (legacy non-rotated)
  const exact = path.join(logDir, `${baseName}.log`);
  if (fs.existsSync(exact)) return exact;
  // Find latest rotated file: baseName-YYYYMMDD-HH.log
  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith(`${baseName}-`) && f.endsWith('.log'))
    .sort();
  if (files.length === 0) return null;
  return path.join(logDir, files[files.length - 1]);
}

export function cmdLogs(args: string[]) {
  const raw = args.includes('--raw');
  const noColor = args.includes('--no-color');
  const levelIdx = args.indexOf('--level');
  const moduleIdx = args.indexOf('--module');
  const level = levelIdx !== -1 ? args[levelIdx + 1] : undefined;
  const module = moduleIdx !== -1 ? args[moduleIdx + 1] : undefined;

  const p = resolvePaths();
  const mainLog = findLatestLog(p.logs, 'evolclaw');
  if (!mainLog) {
    console.log(`❌ Log file not found in: ${p.logs}`);
    process.exit(1);
  }

  // Rendered mode: always filter+truncate, color depends on TTY
  const useColor = !noColor && !!process.stdout.isTTY;
  const opts = { level, module, color: useColor };

  function processLine(line: string) {
    const rendered = renderLogLine(line, opts);
    if (rendered !== null) process.stdout.write(rendered + '\n');
  }

  // Backfill last 50 lines from current file
  const existing = fs.readFileSync(mainLog, 'utf-8').split('\n').slice(-51);
  if (existing.length && existing[existing.length - 1] === '') existing.pop();
  existing.forEach(processLine);

  if (raw) {
    // Raw mode: poll without rendering
    let currentFile = mainLog;
    let position = fs.statSync(currentFile).size;
    let pending = '';
    const timer = setInterval(() => {
      const latest = findLatestLog(p.logs, 'evolclaw');
      if (latest && latest !== currentFile) {
        currentFile = latest;
        position = 0;
        pending = '';
      }
      let stat: fs.Stats;
      try { stat = fs.statSync(currentFile); } catch { return; }
      if (stat.size < position) { position = 0; pending = ''; }
      if (stat.size === position) return;
      const buf = Buffer.alloc(stat.size - position);
      try {
        const fd = fs.openSync(currentFile, 'r');
        fs.readSync(fd, buf, 0, buf.length, position);
        fs.closeSync(fd);
      } catch { return; }
      position = stat.size;
      const parts = (pending + buf.toString('utf-8')).split('\n');
      pending = parts.pop() || '';
      for (const line of parts) {
        if (line) process.stdout.write(line + '\n');
      }
    }, 200);
    platform.onShutdown(() => { clearInterval(timer); process.exit(0); });
    return;
  }

  // Follow mode: poll with rendering, auto-switch on rotation
  let currentFile = mainLog;
  let position = fs.statSync(currentFile).size;
  let pending = '';
  const timer = setInterval(() => {
    const latest = findLatestLog(p.logs, 'evolclaw');
    if (latest && latest !== currentFile) {
      currentFile = latest;
      position = 0;
      pending = '';
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(currentFile); } catch { return; }
    if (stat.size < position) { position = 0; pending = ''; }
    if (stat.size === position) return;
    const buf = Buffer.alloc(stat.size - position);
    try {
      const fd = fs.openSync(currentFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, position);
      fs.closeSync(fd);
    } catch { return; }
    position = stat.size;
    const parts = (pending + buf.toString('utf-8')).split('\n');
    pending = parts.pop() || '';
    for (const line of parts) {
      if (line) processLine(line);
    }
  }, 200);
  platform.onShutdown(() => { clearInterval(timer); process.exit(0); });
}

// ==================== Watch ====================

let watchUseColor = false;

const WATCH_BRACKET_TS_RE = /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]/;
const WATCH_JSON_TS_RE = /"ts"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)"/;

function parseWatchTs(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se, ms, z] = m;
  const msNum = ms ? parseInt((ms + '000').slice(0, 3), 10) : 0;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, msNum);
  return new Date(+y, +mo - 1, +d, +h, +mi, +se, msNum).getTime();
}

function extractWatchTs(line: string): number | null {
  const m = line.match(WATCH_BRACKET_TS_RE) || line.match(WATCH_JSON_TS_RE);
  if (!m) return null;
  const t = parseWatchTs(m[1]);
  return isNaN(t) ? null : t;
}

function toLocalTimeStr(epoch: number): string {
  const d = new Date(epoch);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function stripTimestamp(line: string): string {
  const m = line.match(WATCH_BRACKET_TS_RE);
  if (m) return line.slice(m[0].length).trimStart();
  return line;
}

function compactAunLog(line: string, color: boolean): string {
  if (!color) {
    // No-color mode: just compact [LEVEL][module] [aid] → [LEVEL][module] aid:
    return line
      .replace(/^\[([A-Z]+)\]\[([^\]]+)\] \[([^\]]+)\] /, '[$1][$2] $3: ')
      .replace(/^\[([A-Z]+)\] /, '[$1] ');
  }

  // Pattern 1: [LEVEL][module] [aid] msg  (AUN SDK logs in stdout)
  const m1 = line.match(/^\[([A-Z]+)\]\[([^\]]+)\](?: \[([^\]]+)\])? (.*)/s);
  if (m1) {
    const [, level, mod, aid, rest] = m1;
    const lc = LEVEL_COLORS[level] || '';
    const mc = assignModuleColor(mod);
    const aidPart = aid ? ` ${aid}:` : '';
    return `${lc}[${level}]${RST_CONST}${mc}[${mod}]${RST_CONST}${aidPart} ${rest}`;
  }

  // Pattern 2: [AiBotSDK] [LEVEL] msg  (WeCom SDK logs)
  const m2 = line.match(/^\[([^\]]+)\] \[(DEBUG|INFO|WARN|ERROR)\] (.*)/s);
  if (m2) {
    const [, sdk, level, rest] = m2;
    const lc = LEVEL_COLORS[level] || '';
    const mc = assignModuleColor(sdk);
    return `${lc}[${level}]${RST_CONST}${mc}[${sdk}]${RST_CONST} ${rest}`;
  }

  // Pattern 3: [LEVEL] [Module] msg  or  [LEVEL] msg  (evolclaw main log after stripTimestamp)
  const m3 = line.match(/^\[(DEBUG|INFO|WARN|ERROR)\] (?:\[([^\]]+)\] )?(.*)/s);
  if (m3) {
    const [, level, mod, rest] = m3;
    const lc = LEVEL_COLORS[level] || '';
    if (mod) {
      const mc = assignModuleColor(mod);
      return `${lc}[${level}]${RST_CONST} ${mc}[${mod}]${RST_CONST} ${rest}`;
    }
    return `${lc}[${level}]${RST_CONST} ${rest}`;
  }

  return line;
}

const RST_CONST = '\x1b[0m';
const LEVEL_COLORS: Record<string, string> = {
  DEBUG: '\x1b[2m',       // dim
  INFO: '\x1b[36m',      // cyan
  WARN: '\x1b[33m',      // yellow
  ERROR: '\x1b[31m',     // red
};
const moduleColorPool = [
  '\x1b[35m',  // magenta
  '\x1b[34m',  // blue
  '\x1b[32m',  // green
  '\x1b[96m',  // bright cyan
  '\x1b[93m',  // bright yellow
  '\x1b[95m',  // bright magenta
  '\x1b[94m',  // bright blue
  '\x1b[92m',  // bright green
];
const moduleColorMap = new Map<string, string>();
let moduleColorIdx = 0;
function assignModuleColor(mod: string): string {
  let c = moduleColorMap.get(mod);
  if (!c) { c = moduleColorPool[moduleColorIdx++ % moduleColorPool.length]; moduleColorMap.set(mod, c); }
  return c;
}

function formatWatchContent(line: string): string {
  // JSON line: parse and format key fields
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const obj = JSON.parse(line);

      // Message log format: { ts, msgId, sessionId, dir, status, duration? }
      if (obj.msgId && obj.status) {
        const dirLabel = obj.dir === 'inbound' ? '[IN]' : obj.dir === 'outbound' ? '[OUT]' : '     ';
        const peer = obj.msgId.replace(/_\d+(_reply)?$/, '').replace(/^[^_]+_/, '');
        const dur = obj.duration != null ? ` duration=${obj.duration}ms` : '';
        if (!watchUseColor) return `${dirLabel}[${obj.status}] ${peer}:${dur}`.trimEnd();
        const dc = obj.dir === 'inbound' ? '\x1b[32m' : '\x1b[33m'; // green in, yellow out
        const ec = assignModuleColor(obj.status);
        return `${dc}${dirLabel}${RST_CONST}${ec}[${obj.status}]${RST_CONST} ${peer}:${dur}`.trimEnd();
      }

      // Event log format: { ts, type, ... }
      if (obj.type && !obj.dir) {
        const parts: string[] = [];
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'ts' || k === 'type') continue;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            parts.push(`${k}=${v}`);
          }
        }
        if (!watchUseColor) return `[${obj.type}] ${parts.join(' ')}`.trimEnd();
        const tc = assignModuleColor(obj.type.split(':')[0]);
        return `${tc}[${obj.type}]${RST_CONST} ${parts.join(' ')}`.trimEnd();
      }

      // AUN trace log format: { ts, dir, event, self_aid, data, ... }
      if (obj.dir && obj.event) {
        const aid = obj.self_aid || '';
        const data = obj.data;
        let dataStr = '';
        if (data) {
          const parts: string[] = [];
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
              parts.push(`${k}=${v}`);
            }
          }
          dataStr = parts.join(' ');
        }
        const dirLabel = obj.dir === 'IN' ? '[IN]' : obj.dir === 'OUT' ? '[OUT]' : '     ';
        const aidPart = aid ? `${aid}: ` : '';
        if (!watchUseColor) return `${dirLabel}[${obj.event}] ${aidPart}${dataStr}`.trimEnd();
        const dc = obj.dir === 'IN' ? '\x1b[32m' : '\x1b[33m'; // green in, yellow out
        const ec = assignModuleColor(obj.event.split('.')[0]);
        return `${dc}${dirLabel}${RST_CONST}${ec}[${obj.event}]${RST_CONST} ${aidPart}${dataStr}`.trimEnd();
      }

      // Unknown JSON format — show compact key=value summary
      const parts: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'ts') continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          parts.push(`${k}=${v}`);
        }
      }
      return parts.join(' ');
    } catch { /* fall through */ }
  }
  return compactAunLog(stripTimestamp(line), watchUseColor);
}

const WATCH_FILE_COLORS = [
  '\x1b[36m',  // cyan
  '\x1b[33m',  // yellow
  '\x1b[32m',  // green
  '\x1b[35m',  // magenta
  '\x1b[34m',  // blue
  '\x1b[91m',  // bright red
  '\x1b[92m',  // bright green
  '\x1b[93m',  // bright yellow
  '\x1b[94m',  // bright blue
  '\x1b[95m',  // bright magenta
  '\x1b[96m',  // bright cyan
];

async function cmdWatchMenu(): Promise<void> {
  const items = [
    { key: 'log', label: 'log', desc: 'real-time log tail' },
    { key: 'aid', label: 'aid', desc: 'AID connection stats' },
    { key: 'msg', label: 'msg', desc: 'message inspector' },
    { key: 'web', label: 'web', desc: 'browser dashboard (aid/msg/session)' },
  ];
  let index = 0;
  const useColor = !!process.stdout.isTTY;
  const RST = useColor ? '\x1b[0m' : '';
  const DIM = useColor ? '\x1b[2m' : '';
  const BOLD = useColor ? '\x1b[1m' : '';
  const CYAN = useColor ? '\x1b[36m' : '';

  const pkgRoot = getPackageRoot();

  function render() {
    let buf = '\x1b[2J\x1b[H';
    buf += `${BOLD}evolclaw watch${RST}  ${DIM}${pkgRoot}${RST}\n\n`;
    for (let i = 0; i < items.length; i++) {
      const sel = i === index;
      const marker = sel ? `${CYAN}${BOLD}  ▸ ` : '    ';
      const label = sel ? `${items[i].label}${RST}` : `${DIM}${items[i].label}${RST}`;
      buf += `${marker}${label}   ${DIM}${items[i].desc}${RST}\n`;
    }
    buf += `\n${DIM}  ↑↓ select  Enter confirm  ESC exit${RST}\n`;
    process.stdout.write(buf);
  }

  render();

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = async (data: Buffer) => {
      if (data[0] === 0x1b && data.length === 1) { cleanup(); return; }
      if (data[0] === 0x03) { cleanup(); return; }
      if (data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) { index = Math.max(0, index - 1); render(); }
        if (data[2] === 0x42) { index = Math.min(items.length - 1, index + 1); render(); }
      }
      if (data[0] === 0x0d) {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\x1b[2J\x1b[H');
        const chosen = items[index].key;
        if (chosen === 'log') { await cmdWatchLogsFlow(); }
        else if (chosen === 'aid') { await cmdWatchAid(); }
        else if (chosen === 'msg') {
          const { cmdWatchMsg } = await import('./watch-msg.js');
          await cmdWatchMsg();
        }
        else if (chosen === 'web') { await cmdWatchWeb(); }
        resolve();
      }
    };

    function cleanup() {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[2J\x1b[H');
      resolve();
    }

    process.stdin.on('data', onData);
  });
}

/**
 * 勾选要监控的日志类型。返回选中类型数组；ESC/Ctrl+C 取消返回 null。
 * types: 可用类型（字母序）。preChecked: 预勾集合。fileCount: 类型→当前文件数。
 */
async function cmdWatchLogsSelect(
  types: string[],
  preChecked: Set<string>,
  fileCount: Map<string, number>,
): Promise<string[] | null> {
  let index = 0;
  const checked = new Set(preChecked);
  const useColor = !!process.stdout.isTTY;
  const RST = useColor ? '\x1b[0m' : '';
  const DIM = useColor ? '\x1b[2m' : '';
  const BOLD = useColor ? '\x1b[1m' : '';
  const CYAN = useColor ? '\x1b[36m' : '';
  let hint = '';

  function render() {
    let buf = '\x1b[2J\x1b[H';
    buf += `${BOLD}选择要监控的日志类型${RST}\n\n`;
    for (let i = 0; i < types.length; i++) {
      const sel = i === index;
      const mark = checked.has(types[i]) ? '✔' : ' ';
      const cursor = sel ? `${CYAN}${BOLD}▸ ` : '  ';
      const n = fileCount.get(types[i]) ?? 0;
      const label = sel ? `${types[i]}${RST}` : `${DIM}${types[i]}${RST}`;
      buf += `${cursor}[${mark}] ${label}   ${DIM}(${n} file${n === 1 ? '' : 's'})${RST}\n`;
    }
    buf += `\n${DIM}  ↑↓ 移动  空格 勾选  Enter 确认  ESC 取消${RST}\n`;
    if (hint) buf += `${CYAN}  ${hint}${RST}\n`;
    process.stdout.write(buf);
  }

  render();

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(null); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data: Buffer) => {
      if ((data[0] === 0x1b && data.length === 1) || data[0] === 0x03) {
        finish(null); return;
      }
      if (data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) { index = Math.max(0, index - 1); hint = ''; render(); }
        if (data[2] === 0x42) { index = Math.min(types.length - 1, index + 1); hint = ''; render(); }
        return;
      }
      if (data[0] === 0x20) { // space
        const t = types[index];
        if (checked.has(t)) checked.delete(t); else checked.add(t);
        hint = ''; render(); return;
      }
      if (data[0] === 0x0d) { // enter
        if (checked.size === 0) { hint = '至少选择一项'; render(); return; }
        finish(types.filter(t => checked.has(t)));
      }
    };

    function finish(result: string[] | null) {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[2J\x1b[H');
      resolve(result);
    }

    process.stdin.on('data', onData);
  });
}

/** logs 勾选流程：扫描类型 → 预勾 → 菜单 → 保存 → 监控。 */
async function cmdWatchLogsFlow(): Promise<void> {
  const p = resolvePaths();
  if (!fs.existsSync(p.logs)) {
    console.log(`❌ Log directory not found: ${p.logs}`);
    process.exit(1);
  }
  const files = fs.readdirSync(p.logs).filter(f => f.endsWith('.log'));
  const types = deriveLogTypes(files);
  if (types.length === 0) {
    console.log(`⚠ ${p.logs} 下暂无 .log 文件`);
    return;
  }
  const fileCount = new Map<string, number>();
  for (const t of types) fileCount.set(t, files.filter(f => shortLogNameLocal(f) === t).length);

  const cfg = loadEvolclawConfig();
  const preChecked = computePreChecked(types, cfg.watch?.logTypes);

  if (!process.stdin.isTTY) {
    const fallback = cfg.watch?.logTypes && cfg.watch.logTypes.length > 0
      ? new Set(cfg.watch.logTypes) : new Set(types);
    cmdWatch(fallback);
    return;
  }

  const selected = await cmdWatchLogsSelect(types, preChecked, fileCount);
  if (selected === null) return;
  saveEvolclawConfig({ ...cfg, watch: { ...cfg.watch, logTypes: selected } });
  cmdWatch(new Set(selected));
}

function cmdWatch(filterTypes: Set<string>) {
  const p = resolvePaths();
  if (!fs.existsSync(p.logs)) {
    console.log(`❌ Log directory not found: ${p.logs}`);
    process.exit(1);
  }

  // 清理残留的 watch 文件（旧 watch 进程被强杀时留下的）
  fs.mkdirSync(p.instanceDir, { recursive: true });
  for (const file of fs.readdirSync(p.instanceDir)) {
    if (!file.startsWith('watch-') || !file.endsWith('.json')) continue;
    const filePath = path.join(p.instanceDir, file);
    try {
      const rec = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (rec.pid && !platform.isProcessRunning(rec.pid)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  // 注册 instance
  const instanceFile = path.join(p.instanceDir, `watch-${process.pid}.json`);
  const instanceRecord = {
    pid: process.pid,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    type: 'watch',
  };
  fs.writeFileSync(instanceFile, JSON.stringify(instanceRecord, null, 2));

  const useColor = !!process.stdout.isTTY;
  watchUseColor = useColor;
  const RST = useColor ? '\x1b[0m' : '';
  const DIM = useColor ? '\x1b[2m' : '';
  const colorMap = new Map<string, string>();
  let colorIdx = 0;
  const getColor = (name: string): string => {
    if (!useColor) return '';
    let c = colorMap.get(name);
    if (!c) { c = WATCH_FILE_COLORS[colorIdx++ % WATCH_FILE_COLORS.length]; colorMap.set(name, c); }
    return c;
  };

  const listLogs = () => {
    const all = fs.readdirSync(p.logs).filter(f => f.endsWith('.log')).map(f => path.join(p.logs, f));
    return filterLogFiles(all, filterTypes);
  };
  // Strip rotation suffix (e.g., "evolclaw-20260518-21" → "evolclaw")
  const shortName = (f: string) => path.basename(f, '.log').replace(/-\d{8}-\d{2}$/, '');

  // 计算最长文件名用于对齐
  let maxNameLen = 0;
  const updateMaxName = () => {
    for (const file of listLogs()) {
      const len = shortName(file).length;
      if (len > maxNameLen) maxNameLen = len;
    }
  };
  updateMaxName();

  const formatLine = (file: string, ts: number, line: string): string => {
    const timeStr = `${DIM}${toLocalTimeStr(ts)}${RST}`;
    const name = shortName(file);
    const c = getColor(name);
    const paddedName = `${c}${name.padEnd(maxNameLen)}${RST}`;
    const content = formatWatchContent(line);
    return `${timeStr} ${paddedName} ${content}`;
  };

  console.log(`🔭 Watching ${p.logs}/*.log (ESC to stop)\n`);

  // 显示当前实例信息和 AID 状态
  const instStatus = scanInstances();
  const aliveMainEntries = instStatus.mains.filter(m => m.alive);
  if (aliveMainEntries.length > 0) {
    if (aliveMainEntries.length > 1) {
      console.log(`⚠ 检测到 ${aliveMainEntries.length} 个 main 实例: ${aliveMainEntries.map(m => m.record.pid).join(', ')}（异常）\n`);
    }
    const m = aliveMainEntries[0].record;
    const uptime = formatTimeAgo(Date.now() - m.startedAt);
    console.log(`📦 Instance: PID ${m.pid} | 启动于 ${new Date(m.startedAtIso).toLocaleString()} (${uptime}) | via ${m.launchedBy}`);
    if (instStatus.aidLastActivity.size > 0) {
      const now = Date.now();
      const aidLines: string[] = [];
      for (const [aid, info] of instStatus.aidLastActivity) {
        const ago = formatTimeAgo(now - info.ts);
        const symbol = info.event === 'disconnected' ? '✗' : '✓';
        aidLines.push(`  ${symbol} ${aid} — ${info.event} ${ago}`);
      }
      console.log(`🔑 AIDs:\n${aidLines.join('\n')}`);
    }
    console.log('');
  } else {
    console.log('⚠ EvolClaw 主进程未运行\n');
  }

  // Backfill: 跨所有 .log 汇总最近 20 条带时间戳行；遇到无时间戳行就停止该文件向上追溯
  const TAIL_BYTES = 256 * 1024;
  const collected: { ts: number; file: string; line: string }[] = [];
  for (const file of listLogs()) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { continue; }
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    try {
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
    } catch { continue; }
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift();
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      const ts = extractWatchTs(lines[i]);
      if (ts === null) break;
      collected.push({ ts, file, line: lines[i] });
    }
  }
  collected.sort((a, b) => a.ts - b.ts);
  for (const r of collected.slice(-20)) {
    process.stdout.write(formatLine(r.file, r.ts, r.line) + '\n');
  }

  if (collected.length > 0) process.stdout.write('\n');

  // 实时跟踪
  const state = new Map<string, { position: number; pending: string }>();
  for (const file of listLogs()) {
    try { state.set(file, { position: fs.statSync(file).size, pending: '' }); } catch {}
  }

  const pumpFile = (file: string) => {
    const s = state.get(file);
    if (!s) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    if (stat.size < s.position) { s.position = 0; s.pending = ''; }
    if (stat.size === s.position) return;
    const buf = Buffer.alloc(stat.size - s.position);
    try {
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, s.position);
      fs.closeSync(fd);
    } catch { return; }
    s.position = stat.size;
    const parts = (s.pending + buf.toString('utf-8')).split('\n');
    s.pending = parts.pop() || '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const ts = extractWatchTs(line);
      if (ts !== null) {
        process.stdout.write(formatLine(file, ts, line) + '\n');
      } else {
        // 无时间戳行：对齐到内容列
        const pad = 12 + 1 + maxNameLen + 1; // "HH:MM:SS.mmm" + space + name + space
        process.stdout.write(' '.repeat(pad) + line + '\n');
      }
    }
  };

  const timer = setInterval(() => {
    for (const file of listLogs()) {
      if (!state.has(file)) state.set(file, { position: 0, pending: '' });
    }
    updateMaxName();
    for (const file of state.keys()) pumpFile(file);
  }, 200);

  const cleanup = () => { clearInterval(timer); try { fs.unlinkSync(instanceFile); } catch {} if (process.stdin.isTTY) process.stdin.setRawMode(false); process.exit(0); };
  process.on('exit', () => { try { fs.unlinkSync(instanceFile); } catch {} });

  // ESC key listener
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key: Buffer) => {
      if (key[0] === 0x1b && key.length === 1) cleanup();  // ESC
      if (key[0] === 0x03) cleanup();  // Ctrl+C fallback
    });
  }

  platform.onShutdown(cleanup);
}

// ==================== Watch AID (real-time stats table) ====================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return i === 0 ? `${bytes} B` : `${val.toFixed(1)} ${units[i]}`;
}

function formatTimeAgoShort(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return `${day}d ago`;
}

async function cmdWatchAid(): Promise<void> {
  const p = resolvePaths();

  // Get version
  const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
  const version = pkg.version;

  // Load AID names: first from local agent.md, then refresh from network
  const { aidList, aidLookup } = await import('../aun/aid/index.js');
  const localAids = aidList();
  const aidNameMap = new Map<string, string>();
  const refreshedAids = new Set<string>();

  function readLocalName(aid: string): string | undefined {
    try {
      const mdPath = agentMdPath(aid);
      if (!fs.existsSync(mdPath)) return undefined;
      const content = fs.readFileSync(mdPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return undefined;
      const nameMatch = fmMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
      return nameMatch?.[1]?.trim() || undefined;
    } catch { return undefined; }
  }

  function parseNameFromContent(content: string): string | undefined {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const nameMatch = fmMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
    return nameMatch?.[1]?.trim() || undefined;
  }

  // Phase 1: read cached local names
  for (const a of localAids) {
    if (!a.hasPrivateKey) continue;
    const name = readLocalName(a.aid);
    if (name) aidNameMap.set(a.aid, name);
  }

  // Phase 2: refresh names from network via aidLookup (async, non-blocking)
  const refreshNames = async () => {
    for (const a of localAids) {
      if (!a.hasPrivateKey) continue;
      try {
        const result = await aidLookup(a.aid);
        if (result.exists && result.content) {
          const name = parseNameFromContent(result.content);
          if (name) aidNameMap.set(a.aid, name);
        }
        refreshedAids.add(a.aid);
      } catch { /* ignore network errors */ }
    }
  };
  refreshNames();

  // Register instance
  fs.mkdirSync(p.instanceDir, { recursive: true });
  const instanceFile = path.join(p.instanceDir, `watch-aid-${process.pid}.json`);
  fs.writeFileSync(instanceFile, JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    type: 'watch-aid',
  }, null, 2));

  const useColor = !!process.stdout.isTTY;
  const RST = useColor ? '\x1b[0m' : '';
  const DIM = useColor ? '\x1b[2m' : '';
  const BOLD = useColor ? '\x1b[1m' : '';
  const CYAN = useColor ? '\x1b[36m' : '';
  const GREEN = useColor ? '\x1b[32m' : '';
  const RED = useColor ? '\x1b[31m' : '';
  const CLR_LINE = '\x1b[2K';

  const watchStartedAt = new Date();
  const watchStartStr = `${String(watchStartedAt.getHours()).padStart(2, '0')}:${String(watchStartedAt.getMinutes()).padStart(2, '0')}:${String(watchStartedAt.getSeconds()).padStart(2, '0')}`;

  const COL_AID = 28;
  const COL_STATUS = 14;
  const COL_UPTIME = 11;
  const COL_STATE = 11;
  const COL_RECONN = 6;
  const COL_RECV = 5;
  const COL_SENT = 5;
  const COL_SYS = 8;
  const COL_BIN = 9;
  const COL_BOUT = 9;
  const COL_LRECV = 10;
  const COL_LSENT = 10;
  const COL_PEERS = 5;

  // 表头跟随系统语言
  const isChinese = (process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase().includes('zh');
  const HEADERS = isChinese
    ? { aid: 'AID', status: '状态', uptime: '运行', state: '工作', reconn: '重连', recv: '收', sent: '发', sys: '系统', bin: '入流量', bout: '出流量', lrecv: '最后收', lsent: '最后发', peers: '对端' }
    : { aid: 'AID', status: 'STATUS', uptime: 'UPTIME', state: 'STATE', reconn: 'RECONN', recv: 'RECV', sent: 'SENT', sys: 'SYS R/S', bin: 'BYTES IN', bout: 'BYTES OUT', lrecv: 'LAST RECV', lsent: 'LAST SENT', peers: 'PEERS' };

  function formatDuration(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    if (min < 60) return `${min}m${String(s).padStart(2, '0')}s`;
    const hour = Math.floor(min / 60);
    const m = min % 60;
    if (hour < 24) return `${hour}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    const day = Math.floor(hour / 24);
    return `${day}d${hour % 24}h${String(m).padStart(2, '0')}m`;
  }

  function renderHeader(): string {
    return '  ' +
      padRight(HEADERS.aid, COL_AID) +
      padRight(HEADERS.status, COL_STATUS) +
      padRight(HEADERS.uptime, COL_UPTIME) +
      padRight(HEADERS.state, COL_STATE) +
      padRight(HEADERS.reconn, COL_RECONN) +
      padRight(HEADERS.recv, COL_RECV) +
      padRight(HEADERS.sent, COL_SENT) +
      padRight(HEADERS.sys, COL_SYS) +
      padRight(HEADERS.bin, COL_BIN) +
      padRight(HEADERS.bout, COL_BOUT) +
      padRight(HEADERS.lrecv, COL_LRECV) +
      padRight(HEADERS.lsent, COL_LSENT) +
      padRight(HEADERS.peers, COL_PEERS);
  }

  function renderRow(aid: any, stats: any, projectPath?: string): string[] {
    const aidLabel = aid.aid.length > COL_AID - 2 ? aid.aid.slice(0, COL_AID - 4) + '..' : aid.aid;
    const statusLabel = AID_STATUS_LABELS[aid.status] || aid.status;
    const now = Date.now();
    const lastRecv = stats?.lastReceivedAt ? formatTimeAgoShort(now - stats.lastReceivedAt) : '—';
    const lastSent = stats?.lastSentAt ? formatTimeAgoShort(now - stats.lastSentAt) : '—';
    const uptime = (aid.status === 'connected' && aid.lastConnectedAt)
      ? formatDuration(now - aid.lastConnectedAt)
      : '—';

    // State: processing / queued / idle
    const YELLOW = useColor ? '\x1b[33m' : '';
    let stateLabel = 'idle';
    if (stats?.processing > 0) {
      stateLabel = `${YELLOW}working${RST}`;
    } else if (stats?.queued > 0) {
      stateLabel = `${YELLOW}queued(${stats.queued})${RST}`;
    }

    const mainLine = '  ' +
      padRight(aidLabel, COL_AID) +
      padRight(statusLabel, COL_STATUS) +
      padRight(uptime, COL_UPTIME) +
      padRight(stateLabel, COL_STATE) +
      padRight(String(aid.reconnectCount ?? 0), COL_RECONN) +
      padRight(String(stats?.messagesReceived ?? 0), COL_RECV) +
      padRight(String(stats?.messagesSent ?? 0), COL_SENT) +
      padRight(`${stats?.systemReceived ?? 0}/${stats?.systemSent ?? 0}`, COL_SYS) +
      padRight(formatBytes(stats?.bytesReceived ?? 0), COL_BIN) +
      padRight(formatBytes(stats?.bytesSent ?? 0), COL_BOUT) +
      padRight(lastRecv, COL_LRECV) +
      padRight(lastSent, COL_LSENT) +
      padRight(String(stats?.uniquePeerCount ?? 0), COL_PEERS);

    const namePart = aidNameMap.get(aid.aid) || stats?.selfName || aid.agentName || '';
    const nameColor = refreshedAids.has(aid.aid) ? '' : DIM;
    const nameReset = refreshedAids.has(aid.aid) ? '' : RST;
    const BLUE = useColor ? '\x1b[34m' : '';
    const ORANGE = useColor ? '\x1b[38;5;208m' : '';
    const MAGENTA = useColor ? '\x1b[35m' : '';

    // 标记生成：[明文/密文|自主/响应]（紫色=工具渲染标记）
    const mkTags = (encrypt?: boolean | null, chatmode?: string | null) => {
      const enc = encrypt ? '密文' : '明文';
      const mode = chatmode === 'proactive' ? '自主' : '响应';
      return `${MAGENTA}[${enc}|${mode}]${RST}`;
    };

    let msgPreview = '';
    if (stats?.lastReceivedAt || stats?.lastSentAt) {
      const recvTs = stats.lastReceivedAt ?? 0;
      const sentTs = stats.lastSentAt ?? 0;
      if (recvTs >= sentTs && stats.lastReceivedText) {
        const fromShort = stats.lastReceivedFrom ? stats.lastReceivedFrom.split('.')[0] : '';
        msgPreview = `${GREEN}↓ ${fromShort ? `${ORANGE}${fromShort}${RST}${GREEN}: ` : ''}${stats.lastReceivedText.replace(/\n/g, ' ').slice(0, 60)}${RST}`;
      } else if (stats.lastSentText) {
        const toShort = stats.lastSentTo ? stats.lastSentTo.split('.')[0] : '';
        const tags = mkTags(stats.lastSentEncrypt, stats.lastSentChatmode);
        // task 进行中时也显示计数（processing > 0 说明还在跑）
        const isWorking = (stats.processing ?? 0) > 0;
        const taskEnd = stats?.lastTaskEnd;
        const counts = isWorking && taskEnd
          ? `${MAGENTA}[大模型${taskEnd.numTurns}|调用${taskEnd.toolUseCount}|thought${taskEnd.thoughtPutCount}|msg${taskEnd.replyCount}]${RST}`
          : '';
        msgPreview = `${BLUE}↑${tags}${counts} ${toShort ? `${ORANGE}${toShort}${RST}${BLUE}: ` : ''}${stats.lastSentText.replace(/\n/g, ' ').slice(0, 60)}${RST}`;
      } else if (stats.lastReceivedText) {
        const fromShort = stats.lastReceivedFrom ? stats.lastReceivedFrom.split('.')[0] : '';
        msgPreview = `${GREEN}↓ ${fromShort ? `${ORANGE}${fromShort}${RST}${GREEN}: ` : ''}${stats.lastReceivedText.replace(/\n/g, ' ').slice(0, 60)}${RST}`;
      }
    }
    // 任务结束状态覆盖：仅当 taskEnd 比最后收发都新时才覆盖
    const taskEnd = stats?.lastTaskEnd;
    if (taskEnd && taskEnd.ts >= (stats?.lastSentAt ?? 0) && taskEnd.ts >= (stats?.lastReceivedAt ?? 0)) {
      const tags = mkTags(taskEnd.encrypt, taskEnd.chatmode);
      // 计数标记: [大模型N|调用N|thoughtN(streamN)|msgN]
      const thoughtLabel = taskEnd.thoughtPutCount > 0
        ? `thought${taskEnd.numTurns}(stream${taskEnd.thoughtPutCount})`
        : `thought${taskEnd.numTurns}`;
      const counts = `${MAGENTA}[大模型${taskEnd.numTurns}|调用${taskEnd.toolUseCount}|${thoughtLabel}|msg${taskEnd.replyCount}]${RST}`;
      if (taskEnd.status === 'error') {
        msgPreview = `${RED}${tags}${counts} 错误: ${taskEnd.errorType ?? '未知错误'}${RST}`;
      } else if (taskEnd.sentDuringTask) {
        // 有 message.send：蓝色加粗 + 内容
        const toShort = stats?.lastSentTo ? stats.lastSentTo.split('.')[0] : '';
        const textPreview = stats?.lastSentText ? stats.lastSentText.replace(/\n/g, ' ').slice(0, 60) : '';
        msgPreview = `${BOLD}${BLUE}↑${tags}${counts} ${toShort ? `${ORANGE}${toShort}${RST}${BOLD}${BLUE}: ` : ''}${textPreview}${RST}`;
      } else if (taskEnd.thoughtDuringTask) {
        // 只有 thought：普通蓝色 + thought 内容
        const textPreview = taskEnd.lastThoughtText
          ? taskEnd.lastThoughtText.replace(/\n/g, ' ').slice(0, 60)
          : (taskEnd.finalText ? taskEnd.finalText.replace(/\n/g, ' ').slice(0, 60) : '');
        msgPreview = `${BLUE}↑${tags}${counts} ${textPreview}${RST}`;
      } else {
        // 既没 send 也没 thought
        const textPreview = taskEnd.finalText
          ? taskEnd.finalText.replace(/\n/g, ' ').slice(0, 60)
          : '(无输出)';
        msgPreview = `${ORANGE}${tags}${counts} ${textPreview}${RST}`;
      }
    }
    const subLine1 = `    ${nameColor}${namePart}${nameReset}${msgPreview ? '  ' + msgPreview : ''}`;
    const dirLabel = projectPath || '—';
    const subLine2 = `${DIM}    ${dirLabel}${RST}`;

    const result = [mainLine, subLine1, subLine2];

    if (aid.status === 'failed' || aid.status === 'kicked' || aid.status === 'kicked_no_retry') {
      const parts: string[] = [];
      if (aid.lastAttemptAt) {
        const d = new Date(aid.lastAttemptAt);
        const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        parts.push(`last_attempt=${ts}`);
      }
      if (aid.kickDetail?.code) {
        parts.push(`code=${aid.kickDetail.code}`);
      }
      if (aid.kickDetail?.reason) {
        parts.push(`reason=${aid.kickDetail.reason}`);
      }
      if (aid.lastError) {
        parts.push(`error=${aid.lastError}`);
      }
      if (aid.gatewayUrl) {
        parts.push(`gateway=${aid.gatewayUrl}`);
      }
      if (parts.length > 0) {
        result.push(`${RED}    ⚠ ${parts.join('  ')}${RST}`);
      }
    }

    return result;
  }

  let lastLineCount = 0;

  async function render(): Promise<void> {
    const lines: string[] = [];

    // Query daemon — may be offline
    const [aidsResp, statsResp, statusResp, agentsResp] = await Promise.all([
      ipcQuery<{ ok: boolean; aids: any[] }>(p.socket, { type: 'aun-aids' }),
      ipcQuery<{ ok: boolean; stats: any[] }>(p.socket, { type: 'aun-aid-stats' }),
      ipcQuery<any>(p.socket, { type: 'status' }),
      ipcQuery<{ ok: boolean; agents: any[] }>(p.socket, { type: 'evolagent.list' }),
    ]);

    const daemonOnline = statusResp !== null;
    const aids = aidsResp?.aids ?? [];
    const stats = statsResp?.stats ?? [];
    const statsMap = new Map<string, any>();
    for (const s of stats) statsMap.set(s.aid, s);

    // Map agentName → projectPath
    const agents = agentsResp?.agents ?? [];
    const agentProjectMap = new Map<string, string>();
    for (const a of agents) {
      if (a.name && a.projectPath) agentProjectMap.set(a.name, a.projectPath);
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    // Compute daemon start time
    let startedAtStr = '';
    if (daemonOnline && statusResp?.uptime) {
      const startedAt = new Date(Date.now() - statusResp.uptime);
      startedAtStr = `${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}:${String(startedAt.getSeconds()).padStart(2, '0')}`;
    }

    const statusIndicator = daemonOnline
      ? `${GREEN}● Running${RST}`
      : `${RED}● Offline${RST}`;

    const startInfo = startedAtStr ? ` | Started: ${startedAtStr}` : '';
    lines.push(`${BOLD}${CYAN}📊 EvolClaw AID Monitor${RST}  ${statusIndicator}  ${DIM}${timeStr} | Watch: ${watchStartStr}${startInfo} | Refresh: 1s | ESC to exit${RST}`);
    lines.push('');

    if (!daemonOnline) {
      lines.push(`  ${RED}EvolClaw is not running.${RST} Waiting for daemon to start...`);
      lines.push('');
    } else if (aids.length === 0) {
      lines.push('  No active AIDs');
      lines.push('');
    } else {
      lines.push(`${DIM}${renderHeader()}${RST}`);
      const lineWidth = COL_AID + COL_STATUS + COL_UPTIME + COL_STATE + COL_RECONN + COL_RECV + COL_SENT + COL_SYS + COL_BIN + COL_BOUT + COL_LRECV + COL_LSENT + COL_PEERS;
      lines.push(`${DIM}  ${'─'.repeat(lineWidth)}${RST}`);
      for (const aid of aids) {
        const s = statsMap.get(aid.aid);
        const projPath = agentProjectMap.get(aid.agentName);
        lines.push(...renderRow(aid, s, projPath));
      }
      lines.push('');
    }

    // Status bar
    lines.push(`${DIM}  ${'─'.repeat(80)}${RST}`);

    if (daemonOnline) {
      const connectedCount = aids.filter((a: any) => a.status === 'connected').length;
      const totalRecv = stats.reduce((sum: number, s: any) => sum + (s.messagesReceived ?? 0), 0);
      const totalSent = stats.reduce((sum: number, s: any) => sum + (s.messagesSent ?? 0), 0);
      const totalBytesIn = stats.reduce((sum: number, s: any) => sum + (s.bytesReceived ?? 0), 0);
      const totalBytesOut = stats.reduce((sum: number, s: any) => sum + (s.bytesSent ?? 0), 0);

      const gateways = [...new Set(aids.filter((a: any) => a.gatewayUrl).map((a: any) => a.gatewayUrl))];
      const gatewayStr = gateways.length > 0 ? gateways.join(', ') : '—';

      const daemonUptime = statusResp?.uptime ? formatDuration(statusResp.uptime) : '—';
      const daemonPid = statusResp?.pid ?? '—';

      lines.push(`  ${GREEN}Gateway:${RST} ${gatewayStr}`);
      lines.push(`  ${GREEN}AIDs:${RST} ${aids.length} total, ${connectedCount} connected | ${GREEN}Messages:${RST} ↓${totalRecv} ↑${totalSent} | ${GREEN}Traffic:${RST} ↓${formatBytes(totalBytesIn)} ↑${formatBytes(totalBytesOut)}`);
      lines.push(`  ${GREEN}Version:${RST} ${version} | ${GREEN}PID:${RST} ${daemonPid} | ${GREEN}Uptime:${RST} ${daemonUptime}`);
    } else {
      lines.push(`  ${GREEN}Version:${RST} ${version}`);
    }

    // Build frame buffer: cursor home, then each line with clear-to-EOL
    let buf = '\x1b[H';
    for (const line of lines) {
      buf += CLR_LINE + line + '\n';
    }
    // Clear any leftover lines from previous frame
    for (let i = lines.length; i < lastLineCount; i++) {
      buf += CLR_LINE + '\n';
    }
    lastLineCount = lines.length;

    process.stdout.write(buf);
  }

  // Initial clear screen
  process.stdout.write('\x1b[2J\x1b[H');
  await render();

  const timer = setInterval(render, 1000);

  const cleanup = () => {
    clearInterval(timer);
    try { fs.unlinkSync(instanceFile); } catch {}
    process.exit(0);
  };

  // Listen for ESC key
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      if (data[0] === 0x1b || data[0] === 0x03) cleanup();
    });
  }

  platform.onShutdown(cleanup);
}

interface EcwebInstanceRecord {
  pid: number;
  port: number;
}

function isEcwebInstanceFile(file: string): boolean {
  return /^(ecweb|watch-web)-\d+\.json$/.test(file);
}

/** 扫描 instance/ 目录，返回存活的 ecweb 实例（兼容 ecweb-*.json 和旧 watch-web-*.json）。 */
function findAliveEcwebs(p: ReturnType<typeof resolvePaths>): EcwebInstanceRecord[] {
  const alive: EcwebInstanceRecord[] = [];
  if (!fs.existsSync(p.instanceDir)) return alive;
  for (const file of fs.readdirSync(p.instanceDir)) {
    if (!isEcwebInstanceFile(file)) continue;
    const filePath = path.join(p.instanceDir, file);
    try {
      const rec = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (rec.pid && platform.isProcessRunning(rec.pid)) {
        alive.push({ pid: rec.pid, port: rec.port ?? 42705 });
      } else {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
  return alive;
}

function findAliveEcweb(p: ReturnType<typeof resolvePaths>): EcwebInstanceRecord | null {
  const alive = findAliveEcwebs(p);
  return alive[0] ?? null;
}

/**
 * 轻量 HTTP 就绪探测：GET / 返回 2xx 即视为就绪。
 * 不走 /api/pair-code（会触发配对码刷新副作用），不走 /api/health（不存在）。
 * 根路径由 serveStatic 处理，返回 index.html，无副作用。
 */
async function probeEcwebReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 输出 ECWeb 状态。判定口径：
 *   1. 进程是否存活（instance/ 下的 pid 文件 + isProcessRunning）
 *   2. HTTP 是否就绪——探测根路径 /（serveStatic → index.html, 无副作用）。
 */
async function printEcwebStatus(p: ReturnType<typeof resolvePaths>): Promise<void> {
  const cfg = loadEvolclawConfig();
  if (cfg.ecweb?.enabled === false) {
    console.log('');
    console.log('🔭 ECWeb: 已禁用 (evolclaw.json → ecweb.enabled: false)');
    return;
  }

  const inst = findAliveEcweb(p);
  if (!inst) {
    console.log('');
    console.log('🔭 ECWeb: 未运行');
    return;
  }

  // 进程存活，再确认 HTTP 真正就绪（探测根路径 /，无业务副作用）
  const ready = await probeEcwebReady(inst.port);
  console.log('');
  if (ready) {
    console.log(`🔭 ECWeb: 运行中 (PID: ${inst.pid})  http://localhost:${inst.port}`);
  } else {
    console.log(`🔭 ECWeb: 进程存活 (PID: ${inst.pid}) 但 HTTP 未就绪 (端口 ${inst.port})，查看 logs/watch-web.log`);
  }
}

function removeEcwebInstanceFiles(p: ReturnType<typeof resolvePaths>): void {
  if (!fs.existsSync(p.instanceDir)) return;
  for (const file of fs.readdirSync(p.instanceDir)) {
    if (!isEcwebInstanceFile(file)) continue;
    try { fs.unlinkSync(path.join(p.instanceDir, file)); } catch {}
  }
}

/** 清理所有 codex app-server 孤儿进程，返回清理的进程数。 */
function stopCodexAppServerOrphans(): number {
  // 查找所有 codex app-server 进程（无论是 node 启动的还是原生二进制）
  const codexProcs = platform.findProcesses('codex app-server');
  let killed = 0;
  for (const pid of codexProcs) {
    try {
      platform.killProcess(pid, true);
      killed++;
    } catch {}
  }
  return killed;
}

/** 若 ecweb 在运行则杀掉并清理 pid 文件，返回是否成功 kill。 */
function stopEcwebIfRunning(p: ReturnType<typeof resolvePaths>): boolean {
  const alive = findAliveEcweb(p);
  let killed = false;
  if (alive) {
    try { platform.killProcess(alive.pid, true); } catch {}
    killed = true;
  }
  // 清理 pid 文件（仅 ecweb-<pid>.json / watch-web-<pid>.json，
  // 不碰 ecweb-tokens.json 等非 pid 文件，否则会清空配对 token 库导致每次重启都要重新配对）
  removeEcwebInstanceFiles(p);
  // 端口兜底：杀掉任何仍占用 ecweb 端口的残留进程（含手动启动、未登记 pid 文件的）。
  // 仅靠 pid 文件无法清理这类进程，会导致下次启动端口被占。
  const port = loadEvolclawConfig().ecweb?.port ?? 42705;
  for (const pid of platform.findProcessByPort(port)) {
    try { platform.killProcess(pid, true); killed = true; } catch {}
  }
  return killed;
}

/**
 * 后台 detached 启动 ecweb；若已运行则先停再启（确保加载最新代码）。
 * 启动后轮询端口确认 HTTP 服务真正就绪，打印明确的成功/失败结论（而非模糊的「已在后台启动」状态描述）。
 * 返回 true=本次确实启动成功，false=未启用/未安装/启动失败。
 */
async function startEcwebIfEnabled(p: ReturnType<typeof resolvePaths>): Promise<boolean> {
  const cfg = loadEvolclawConfig();
  if (!cfg.ecweb?.enabled) return false;
  stopEcwebIfRunning(p);  // 先停旧进程（有则停），保证加载最新代码

  const port = cfg.ecweb.port ?? 42705;
  const args = ['--home', p.root, '--port', String(port)];
  const launch = resolveEcwebLaunchCommand(args);
  if (!launch) {
    console.log('⚠ ECWeb 未安装，跳过启动（运行 npm i -g evolclaw-web 后可用）');
    return false;
  }

  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
  const pid = child.pid;
  if (!pid) {
    console.log('❌ ECWeb 启动失败（进程创建失败）');
    return false;
  }

  fs.mkdirSync(p.instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(p.instanceDir, `ecweb-${pid}.json`),
    JSON.stringify({ pid, port, startedAt: Date.now() }, null, 2),
  );

  // 轮询端口确认 HTTP 服务真正就绪（spawn 成功 ≠ 端口绑定成功），顺便拿配对码
  let pair: { code: string; expiresAt: number } | null = null;
  for (let i = 0; i < 20; i++) {
    pair = await fetchEcwebPairCode(port);
    if (pair) break;
    await sleep(250);
  }

  if (pair) {
    const mins = Math.max(0, Math.round((pair.expiresAt - Date.now()) / 60000));
    console.log(`✓ ECWeb 启动成功 (PID: ${pid})  http://localhost:${port}`);
    console.log(`   配对码: ${pair.code}  (约 ${mins} 分钟内有效，已配对过的浏览器无需重新配对)`);
    return true;
  }
  console.log(`❌ ECWeb 启动失败：端口 ${port} 未就绪（进程 PID ${pid} 可能已退出，查看 logs/watch-web.log）`);
  return false;
}

/** 显示 ecweb 访问信息 + 配对码（启动后 ecweb 需要一点时间起 HTTP，故重试几次）。 */
async function printEcwebAccess(port: number): Promise<void> {
  console.log(`🔭 ECWeb  http://localhost:${port}`);
  let pair: { code: string; expiresAt: number } | null = null;
  for (let i = 0; i < 10 && !pair; i++) {
    pair = await fetchEcwebPairCode(port);
    if (!pair) await sleep(300);
  }
  if (pair) {
    const mins = Math.max(0, Math.round((pair.expiresAt - Date.now()) / 60000));
    console.log(`   配对码: ${pair.code}  (约 ${mins} 分钟内有效，配对后 token 缓存 24h)`);
  } else {
    console.log('   配对码: 暂不可用（稍后重试 ec watch web，或查看 logs/watch-web.log）');
  }
}

async function cmdWatchWeb(): Promise<void> {
  const p = resolvePaths();

  // 1. 检查安装
  if (!platform.commandExists('evolclaw-web')) {
    process.stdout.write('📦 evolclaw-web 未安装。');
    if (!process.stdin.isTTY) {
      process.stdout.write(' 请手动安装: npm install -g evolclaw-web\n');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise<string>(res => rl.question(' 立即安装？[Y/n] ', res));
    rl.close();
    if (ans.trim().toLowerCase() === 'n') { process.exit(0); }
    process.stdout.write('\n');
    const { npmInstallGlobal } = await import('../utils/npm-ops.js');
    try {
      await npmInstallGlobal('evolclaw-web@latest');
    } catch (e: any) {
      process.stderr.write(`❌ 安装失败: ${e?.stderr || e?.message || e}\n`);
      process.exit(1);
    }
  } else {
    // 已安装：检查并自动升级到最新版（参考 fastaun 自动升级机制）
    const upgrade = await tryUpgradeGlobalPkg(() => resolveGlobalPkg('evolclaw-web'), 'evolclaw-web');
    switch (upgrade.status) {
      case 'upgraded':
        process.stdout.write(`✅ evolclaw-web 已升级: ${upgrade.from} → ${upgrade.to}\n`);
        break;
      case 'failed':
        process.stdout.write(`⚠ evolclaw-web 升级失败 (${upgrade.from} → ${upgrade.to})，继续使用当前版本\n`);
        break;
      // no-update / skipped: 静默
    }
  }

  // 2. 启动（后台）并同步配置。默认行为是替换旧实例，确保新配置/新版静态资源生效。
  const cfg = loadEvolclawConfig();
  const port = cfg.ecweb?.port ?? 42705;
  if (cfg.ecweb?.enabled === undefined) {
    // 首次手动启动时自动写入 enabled:true
    saveEvolclawConfig({ ...cfg, ecweb: { enabled: true, port } });
  }
  if (cfg.ecweb?.enabled === false) {
    const alive = findAliveEcweb(p);
    if (alive) {
      await printEcwebAccess(alive.port);
      return;
    }
    process.stderr.write('❌ ECWeb 已禁用。请在 evolclaw.json 中启用 ecweb.enabled，或删除该字段后重试。\n');
    process.exit(1);
  }
  const ok = await startEcwebIfEnabled(p);
  if (!ok) process.exit(1);  // 失败原因已由 startEcwebIfEnabled 打印
  // 启动成功的访问信息已由 startEcwebIfEnabled 打印，无需 printEcwebAccess 重复输出
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== Migrate ====================

export async function cmdMv(oldDir?: string, newDir?: string) {
  if (!oldDir || !newDir) {
    console.log('Usage: evolclaw mv <old_directory> <new_directory>');
    console.log('Example: evolclaw mv ~/projects/old-name ~/projects/new-name');
    process.exit(1);
  }

  const oldAbs = path.resolve(oldDir);
  const newAbs = path.resolve(newDir);
  console.log(`迁移项目: ${oldAbs} → ${newAbs}\n`);

  try {
    const r = await migrateProject(oldAbs, newAbs);

    if (r.claudeSessionsMoved) console.log('✓ Claude Code 会话目录已迁移');
    if (r.claudeHistoryUpdated) console.log('✓ Claude Code history.jsonl 已更新');
    if (r.codexUpdated > 0) console.log(`✓ Codex 数据库已更新 (${r.codexUpdated} 个会话)`);
    if (r.directoryMoved) console.log('✓ 项目目录已移动');
    if (r.evolclawDbUpdated > 0) console.log(`✓ EvolClaw 会话存储已更新 (${r.evolclawDbUpdated} 条记录)`);

    console.log('\n迁移完成！');
  } catch (e) {
    console.error(`迁移失败: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

// ==================== Diagnose ====================

export async function cmdDiagnose() {
  const p = resolvePaths();
  let hasError = false;

  // 1. 检查数据目录
  console.log(`[diagnose] EVOLCLAW_HOME = ${p.root}`);
  if (!fs.existsSync(p.root)) {
    console.error(`[diagnose] ❌ 数据目录不存在: ${p.root}`);
    hasError = true;
  } else {
    console.log(`[diagnose] ✓ 数据目录存在`);
  }

  // 2. 加载并校验配置
  try {
    // 2. 加载 self-agents
    const { agents, skipped } = loadAllAgents();
    if (agents.length === 0) {
      console.error(`[diagnose] ❌ 未配置 self-agent。请运行 \`evolclaw aid new <name>\``);
      hasError = true;
      if (skipped.length > 0) {
        console.error(`[diagnose] 跳过的目录:`);
        for (const s of skipped) console.error(`  - ${s.dirName}: ${s.reason}`);
      }
    } else {
      console.log(`[diagnose] ✓ 已加载 ${agents.length} 个 self-agent`);
    }

    // 3. 检查 Anthropic 配置（用首个 self-agent 的 effective config）
    if (agents.length > 0) {
      try {
        const defaults = loadDefaults();
        const merged = mergeForAgent(agents[0], defaults);
        const syntheticConfig = {
          agents: {
            claude: merged.baseagents?.claude as any,
            codex: merged.baseagents?.codex as any,
            gemini: merged.baseagents?.gemini as any,
          } as any,
          channels: {} as any,
          projects: merged.projects as any,
        };
        const anthropic = resolveAnthropicConfig(syntheticConfig as any);
        console.log(`[diagnose] ✓ Anthropic 配置解析成功 (apiKey: ${anthropic.apiKey ? '已设置' : '❌ 未设置'}, model: ${anthropic.model || 'default'})`);
      } catch (e) {
        console.error(`[diagnose] ❌ Anthropic 配置解析失败: ${e instanceof Error ? e.message : e}`);
        hasError = true;
      }
    }
  } catch (e) {
    console.error(`[diagnose] ❌ 配置加载失败: ${e instanceof Error ? e.message : e}`);
    hasError = true;
  }

  // 4. 检查 Session 文件系统存储
  try {
    const { SessionManager } = await import('../core/session/session-manager.js');
    const eventBus = new EventBus();
    new SessionManager(p.sessionsDir, eventBus);
    console.log(`[diagnose] ✓ Session 存储初始化成功: ${p.sessionsDir}`);
  } catch (e) {
    console.error(`[diagnose] ❌ Session 存储初始化失败: ${e instanceof Error ? e.message : e}`);
    hasError = true;
  }

  // 5. 检查残留进程
  try {
    const instStatus = scanInstances();
    const aliveMains = instStatus.mains.filter(m => m.alive);
    if (aliveMains.length > 0) {
      console.log(`[diagnose] ⚠️ 已有进程运行中: PID ${aliveMains.map(m => m.record.pid).join(', ')}`);
    } else {
      console.log(`[diagnose] ✓ 无残留进程`);
    }
  } catch {
    console.log(`[diagnose] ✓ 无 instance 文件`);
  }

  // 6. 检查关键文件
  const appMain = path.join(getPackageRoot(), 'dist', 'index.js');
  if (!fs.existsSync(appMain)) {
    console.error(`[diagnose] ❌ 编译产物不存在: ${appMain}`);
    hasError = true;
  } else {
    console.log(`[diagnose] ✓ 编译产物存在: ${appMain}`);
  }

  if (hasError) {
    console.error('\n[diagnose] ❌ 诊断发现问题，请修复后重试');
    process.exit(1);
  } else {
    console.log('\n[diagnose] ✓ 所有检查通过');
  }
}


export async function cmdWatchCommand(args: string[]): Promise<void> {
  // watch 子命令（aid/msg）会调 AUN SDK（aidLookup 刷名片、对端探测等），
  // 与 aid/msg/group 等命令一致：进 case 先关掉 SDK 的 [aun_core] 日志，
  // 否则 SDK debug 日志会直喷终端、糊住 watch 的 TUI 面板。
  const { suppressSdkLogs } = await import('../aun/aid/index.js');
  suppressSdkLogs();
  if (args[0] === 'aid') {
    await cmdWatchAid();
  } else if (args[0] === 'msg') {
    if (isHelpFlag(args[1])) {
      console.log(`用法: evolclaw watch msg

三面板交互式消息监控 TUI。

面板:
  左 (Scope)     本地 AID 列表，显示收发统计和对端数量
  中 (Stats)     选中 AID 的对端列表（默认 All），显示 per-peer 收发数
  右 (Messages)  消息流，带滚动条

操作:
  ↑↓             当前面板内导航
  ←→ / Tab       切换面板
  Enter          选中 AID / 选中对端
  Backspace      返回上一级
  Page Up/Down   消息滚动
  ESC            退出`);
      return;
    }
    const { cmdWatchMsg } = await import('./watch-msg.js');
    await cmdWatchMsg();
  } else if (args[0] === 'log' || args[0] === 'logs') {
    const requested = args.slice(1);
    if (requested.length > 0) {
      const p2 = resolvePaths();
      const avail = fs.existsSync(p2.logs)
        ? deriveLogTypes(fs.readdirSync(p2.logs).filter(f => f.endsWith('.log')))
        : [];
      const invalid = validateLogTypes(requested, avail);
      if (invalid.length > 0) {
        console.log(`❌ 无效日志类型: ${invalid.join(', ')}`);
        console.log(`可用类型: ${avail.join(', ') || '(无)'}`);
        process.exit(1);
      }
      cmdWatch(new Set(requested));
    } else {
      await cmdWatchLogsFlow();
    }
  } else if (args[0] === 'web' || args[0] === 'session') {
    await cmdWatchWeb();
  } else if (!args[0]) {
    await cmdWatchMenu();
  } else {
    await cmdWatchLogsFlow();
  }
}
