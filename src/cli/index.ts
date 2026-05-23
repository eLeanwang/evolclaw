import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from '../paths.js';
import { loadDefaults, loadAllAgents, mergeForAgent } from '../config-store.js';
import { resolveAnthropicConfig } from '../agents/resolve.js';
import { normalizeChannelInstances, channelTypes } from '../utils/channel-helpers.js';
import { migrateProject } from '../config-store.js';
import readline from 'readline';
import { cmdInit } from './init.js';
import { ipcQuery } from '../ipc.js';
import { cmdInitWechat, cmdInitFeishu, cmdInitDingtalk, cmdInitQQBot, cmdInitWecom } from './init-channel.js';
import * as platform from '../utils/cross-platform.js';
import { EventBus } from '../core/event-bus.js';
import { tryUpgrade, tryUpgradeAunSdk, type UpgradeResult } from '../utils/npm-ops.js';
import { resolveAunCoreSdkPkg, AUN_CORE_SDK_PKG } from '../aun/aid/client.js';
import { scanInstances, cleanupInstances, readAidLastActivity, writeRestartMonitor, removeRestartMonitor, isRestartMonitorWinner, findOrphanProcesses, killOrphans, type OrphanProcess } from '../utils/instance-registry.js';

// Suppress Node.js ExperimentalWarning (e.g. SQLite) from cluttering CLI output
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name === 'ExperimentalWarning') return; process.stderr.write((w.stack ?? String(w)) + '\n'); });

const execFileAsync = promisify(execFile);

// 清理 Claude Code 环境变量，防止 SDK 认为是嵌套会话
function cleanEnv() {
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

function printStartupInfo(): void {
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

  console.log(`  EvolClaw v${version}`);
  console.log(`  包路径:     ${pkgRoot}`);
  console.log(`  安装类型:   ${isNpmInstall ? 'npm全局安装' : '开发仓(link)'}`);
  console.log(`  CLI执行:    ${cliRunsSource ? '源码(tsx)' : '编译产物(dist)'}`);
  console.log(`  Daemon执行: ${daemonRunsDist ? '编译产物(dist)' : '未知'}`);
  console.log(`  代码时间:   ${latestMtime ? formatLocalTime(latestMtime) : '?'}`);
}

async function cmdStart() {
  const cmdStartedAt = Date.now();
  printStartupInfo();

  const p = resolvePaths();
  ensureDataDirs();

  // 旧配置自动迁移（evolclaw.json → 新结构）
  const { autoMigrateIfNeeded } = await import('../config-store.js');
  autoMigrateIfNeeded();

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
    console.log(`❌ EvolClaw is already running (PID: ${aliveMains.map(m => m.record.pid).join(', ')})`);
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
    }
  });

  const childPid = child.pid!;
  child.unref();

  // 等待 ready signal（最多 30 秒，AUN sidecar 超时 15s + 其他通道连接）
  const startTime = Date.now();
  const checkReady = () => {
    // ready signal 出现（优先检查，避免 Windows 上误判进程状态）
    if (fs.existsSync(p.readySignal)) {
      const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
      let aunVer = 'unknown';
      try {
        const aunPkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'node_modules', '@agentunion', 'fastaun', 'package.json'), 'utf-8'));
        aunVer = aunPkg.version;
      } catch { /* ignore */ }
      console.log(`✓ EvolClaw v${pkg.version} started successfully (PID: ${childPid})  fastaun v${aunVer}`);
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

async function cmdStop() {
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

async function cmdRestart(opts: { clear?: boolean } = {}) {
  const cmdStartedAt = Date.now();
  printStartupInfo();

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

  console.log(`⏱ restart prep done in ${((Date.now() - cmdStartedAt) / 1000).toFixed(1)}s, starting...`);
  setTimeout(() => cmdStart(), 1000);
}

async function cmdDev(args: string[]) {
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

async function cmdStatus() {
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
    console.log(`✓ EvolClaw is running (PID: ${pid})`);
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
            for (const inst of cfg.channels) {
              // effective key: <aid>#<type>#<name>
              configChannelNames.add(`${cfg.aid}#${inst.type}#${inst.name}`);
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
            const sessionName = s.name || '默认会话';
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
}

/**
 * 把 channel fingerprint 列表（`<aid>#<type>#<name>`）折叠成展示用摘要。
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
    const type = parts[1];
    const name = parts.slice(2).join('#');
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

function cmdLogs(args: string[]) {
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
        if (chosen === 'log') { cmdWatch(); }
        else if (chosen === 'aid') { await cmdWatchAid(); }
        else if (chosen === 'msg') {
          const { cmdWatchMsg } = await import('./watch-msg.js');
          await cmdWatchMsg();
        }
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

function cmdWatch() {
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

  const listLogs = () => fs.readdirSync(p.logs).filter(f => f.endsWith('.log')).map(f => path.join(p.logs, f));
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
      const agentMdPath = path.join(os.homedir(), '.aun', 'AIDs', aid, 'agent.md');
      if (!fs.existsSync(agentMdPath)) return undefined;
      const content = fs.readFileSync(agentMdPath, 'utf-8');
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
async function cmdRestartMonitor() {
  const p = resolvePaths();
  const restartLog = path.join(p.logs, 'restart.log');
  const MAX_HEAL_ATTEMPTS = 3;
  const READY_TIMEOUT = 30000; // 30s（AUN sidecar 10s + Feishu 连接 12s）
  const HEAL_TIMEOUT = 30 * 60 * 1000; // 30 分钟，让 claude 自然结束
  const eventBus = new EventBus();

  const log = (msg: string) => {
    const _d = new Date();
    const _p = (n: number) => String(n).padStart(2, '0');
    const ts = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`;
    const line = `[${ts}] ${msg}\n`;
    fs.appendFileSync(restartLog, line);
  };

  // 单实例保护：pre-check + post-write 自检（同 main 进程）
  {
    const pre = scanInstances();
    const aliveOthers = pre.restartMonitors.filter(m => m.alive && m.record.pid !== process.pid);
    if (aliveOthers.length > 0) {
      log(`Another restart-monitor already running (PID: ${aliveOthers.map(m => m.record.pid).join(', ')}), exiting`);
      process.exit(0);
    }
  }

  // 立即登记自己；exit 路径上自动清理 record
  writeRestartMonitor();
  process.on('exit', () => removeRestartMonitor());

  // post-write 自检：(startedAt, pid) 选最早赢家
  {
    const verdict = isRestartMonitorWinner();
    if (!verdict.winner) {
      log(`Lost restart-monitor election to PID ${verdict.conflictingPid}, yielding`);
      removeRestartMonitor();
      process.exit(0);
    }
  }

  /** 检查服务是否已经在运行（ready signal 存在 + 至少一个活 main） */
  const isServiceAlive = (): boolean => {
    if (!fs.existsSync(p.readySignal)) return false;
    const s = scanInstances();
    return s.mains.some(m => m.alive);
  };

  log('Restart monitor started');

  // 读取 restart-pending.json 用于后续通知
  const pendingFile = path.join(p.dataDir, 'restart-pending.json');
  let pendingInfo: { channel: string; channelId: string; timestamp: number } | null = null;
  try {
    if (fs.existsSync(pendingFile)) {
      pendingInfo = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
    }
  } catch {}

  // 等待所有活 main 进程退出（可能不止一个）
  const oldStatus = scanInstances();
  const aliveMains = oldStatus.mains.filter(m => m.alive);
  if (aliveMains.length > 0) {
    const oldPids = aliveMains.map(m => m.record.pid);
    log(`Monitoring ${oldPids.length} main process(es): ${oldPids.join(', ')}`);

    // 先并行 SIGTERM 通知所有活 main
    for (const pid of oldPids) {
      try { platform.killProcess(pid, false); } catch {}
    }

    await Promise.all(oldPids.map(oldPid => new Promise<void>((resolve) => {
      let waited = 0;
      const interval = setInterval(() => {
        waited++;
        if (!platform.isProcessRunning(oldPid)) {
          clearInterval(interval);
          log(`Process ${oldPid} has exited`);
          resolve();
          return;
        }
        if (waited >= 30) {
          clearInterval(interval);
          log(`ERROR: Process ${oldPid} still running after 30s, force killing`);
          platform.killProcess(oldPid, true);
          resolve();
        }
      }, 1000);
    })));

    await sleep(3000);
    cleanupInstances();
  }

  // 版本检查与自动升级
  log('Checking for updates...');
  const upgrade = await tryUpgrade();
  switch (upgrade.status) {
    case 'upgraded':
      log(`✅ Upgraded: ${upgrade.from} → ${upgrade.to}`);
      await notifyChannel(p, pendingInfo, `📦 已升级 ${upgrade.from} → ${upgrade.to}`, log);
      break;
    case 'no-update':
      log(`Already up to date (${upgrade.from})`);
      break;
    case 'skipped':
      log(upgrade.error
        ? 'Skipped upgrade (network unavailable)'
        : 'Skipped upgrade check (dev mode)');
      break;
    case 'failed':
      log(`⚠ Upgrade failed (${upgrade.from} → ${upgrade.to}): ${upgrade.error}`);
      await notifyChannel(p, pendingInfo, `⚠️ 升级失败，使用当前版本继续`, log);
      break;
  }

  // AUN SDK 版本检查与升级
  const aunUpgrade = await tryUpgradeAunSdk(resolveAunCoreSdkPkg, AUN_CORE_SDK_PKG);
  switch (aunUpgrade.status) {
    case 'upgraded':
      log(`✅ AUN SDK upgraded: ${aunUpgrade.from} → ${aunUpgrade.to}`);
      await notifyChannel(p, pendingInfo, `📦 AUN SDK 已升级 ${aunUpgrade.from} → ${aunUpgrade.to}`, log);
      break;
    case 'no-update':
      break;
    case 'failed':
      log(`⚠ AUN SDK upgrade failed (${aunUpgrade.from} → ${aunUpgrade.to}): ${aunUpgrade.error}`);
      break;
  }

  // 启动并检测 ready signal
  let started = await spawnAndWaitReady(p, log, READY_TIMEOUT);

  if (started) {
    log('✓ Service restarted successfully');
    archiveSelfHealLog(p, log);
    // 通知由新进程自行发送（channel-agnostic），此处不再调用 notifyChannel
    process.exit(0);
  }

  // 启动失败 — 测试环境下跳过 self-heal（避免 claude -p 污染会话列表、误杀生产进程）
  if (p.root.startsWith('/tmp/') || process.env.EVOLCLAW_TEST === '1') {
    log('❌ Service failed to start (test environment detected, skipping self-heal)');
    await notifyChannel(p, pendingInfo, '❌ 服务启动失败（测试环境，已跳过自动修复）', log);
    cleanupPendingFile(pendingFile, log);
    process.exit(1);
  }

  // 启动失败，进入 self-heal 循环
  log('❌ Service failed to start, entering self-heal loop');
  eventBus.publish({ type: 'self-heal:started', reason: 'Service failed to start after restart' });
  await notifyChannel(p, pendingInfo, '⚠️ 服务启动失败，正在尝试自动修复...', log);

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    // 前置检查：服务可能已被上一轮 claude 修复并启动
    if (isServiceAlive()) {
      log(`✓ Service already running before attempt ${attempt}, skipping`);
      await sendHealSummary(p, pendingInfo, attempt - 1, log);
      eventBus.publish({ type: 'self-heal:completed', success: true, attempts: attempt - 1 });
      archiveSelfHealLog(p, log);
      cleanupPendingFile(pendingFile, log);
      process.exit(0);
    }

    log(`Self-heal attempt ${attempt}/${MAX_HEAL_ATTEMPTS}`);
    eventBus.publish({ type: 'self-heal:attempt', attemptNumber: attempt, maxAttempts: MAX_HEAL_ATTEMPTS });
    await notifyChannel(p, pendingInfo, `🔧 自动修复中（第 ${attempt}/${MAX_HEAL_ATTEMPTS} 次）...`, log);

    const healed = await invokeClaude(p, attempt, MAX_HEAL_ATTEMPTS, HEAL_TIMEOUT, log);

    // 后置检查：不管 invokeClaude 返回什么，都检查服务实际状态
    if (isServiceAlive()) {
      log(`✓ Service is running after attempt ${attempt}`);
      await sendHealSummary(p, pendingInfo, attempt, log);
      eventBus.publish({ type: 'self-heal:completed', success: true, attempts: attempt });
      archiveSelfHealLog(p, log);
      cleanupPendingFile(pendingFile, log);
      process.exit(0);
    }

    if (!healed) {
      log(`Self-heal attempt ${attempt} failed (claude invocation error)`);
      continue;
    }

    // claude 正常完成但服务没自动启动，尝试 spawn
    started = await spawnAndWaitReady(p, log, READY_TIMEOUT);
    if (started) {
      log(`✓ Self-heal succeeded on attempt ${attempt}`);
      await sendHealSummary(p, pendingInfo, attempt, log);
      eventBus.publish({ type: 'self-heal:completed', success: true, attempts: attempt });
      archiveSelfHealLog(p, log);
      cleanupPendingFile(pendingFile, log);
      process.exit(0);
    }

    log(`Attempt ${attempt}: still failing after fix`);
  }

  // 全部失败 — 最后再检查一次
  if (isServiceAlive()) {
    log('✓ Service recovered during final check');
    await sendHealSummary(p, pendingInfo, MAX_HEAL_ATTEMPTS, log);
    eventBus.publish({ type: 'self-heal:completed', success: true, attempts: MAX_HEAL_ATTEMPTS });
    archiveSelfHealLog(p, log);
    cleanupPendingFile(pendingFile, log);
    process.exit(0);
  }

  log(`❌ All ${MAX_HEAL_ATTEMPTS} self-heal attempts failed`);
  eventBus.publish({ type: 'self-heal:completed', success: false, attempts: MAX_HEAL_ATTEMPTS });
  await notifyChannel(p, pendingInfo, `❌ ${MAX_HEAL_ATTEMPTS} 次自动修复均失败，需要人工介入。\n修复记录：${p.selfHealLog}`, log);
  cleanupPendingFile(pendingFile, log);
  process.exit(1);
}

/**
 * 发送 self-heal 修复成功小结（从 self-heal.md 提取摘要）
 */
async function sendHealSummary(
  p: ReturnType<typeof resolvePaths>,
  pendingInfo: { channel: string; channelId: string } | null,
  attempts: number,
  log: (msg: string) => void
) {
  let summary = `✅ 自动修复成功（第 ${attempts || 1} 次尝试）`;
  try {
    if (fs.existsSync(p.selfHealLog)) {
      const content = fs.readFileSync(p.selfHealLog, 'utf-8');
      // 提取最后一个 ## 章节的要点
      const sections = content.split(/^## /m).filter(Boolean);
      const last = sections[sections.length - 1];
      if (last) {
        const lines = last.split('\n').filter(l => l.startsWith('- ')).map(l => l.trim());
        if (lines.length > 0) {
          summary += '\n' + lines.join('\n');
        }
      }
    }
  } catch {}
  summary += '\n\n⚠️ 修复前进行中的任务已中断，如需继续请重新发送。';
  await notifyChannel(p, pendingInfo, summary, log);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupPendingFile(filePath: string, log: (msg: string) => void) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log('Cleaned up restart-pending.json');
    }
  } catch {}
}

/**
 * 启动新进程并等待 ready.signal
 */
async function spawnAndWaitReady(
  p: ReturnType<typeof resolvePaths>,
  log: (msg: string) => void,
  timeout: number
): Promise<boolean> {
  // 删除旧的 ready signal
  try { fs.unlinkSync(p.readySignal); } catch {}
  // 清理残留 instance 文件和进程
  cleanupInstances();

  cleanEnv();

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
      EVOLCLAW_LAUNCHED_BY: 'restart-monitor',
      LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
      MESSAGE_LOG: process.env.MESSAGE_LOG || 'true',
      EVENT_LOG: process.env.EVENT_LOG || 'true',
    }
  });

  const childPid = child.pid!;
  child.unref();

  log(`Spawned new process PID: ${childPid}, waiting for ready signal...`);

  // 轮询等待 ready.signal 出现
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(500);

    // 进程已退出则提前失败
    if (!platform.isProcessRunning(childPid)) {
      log('Process exited before ready signal');
      return false;
    }

    if (fs.existsSync(p.readySignal)) {
      log('Ready signal detected');
      return true;
    }
  }

  log(`Ready signal not received within ${timeout / 1000}s`);
  // 超时后杀掉进程
  if (platform.isProcessRunning(childPid)) {
    platform.killProcess(childPid);
  }
  cleanupInstances();
  return false;
}

/**
 * 调用 claude CLI 进行自动修复
 */
async function invokeClaude(
  p: ReturnType<typeof resolvePaths>,
  attempt: number,
  maxAttempts: number,
  timeout: number,
  log: (msg: string) => void
): Promise<boolean> {
  const projectDir = getPackageRoot();
  const selfHealLog = p.selfHealLog;
  const stdoutLog = path.join(p.logs, 'stdout.log');

  const selfHealExists = fs.existsSync(selfHealLog) ? '存在，请先阅读之前的修复记录' : '不存在（首次修复）';

  const prompt = `EvolClaw 服务启动失败，需要你诊断并修复。这是第 ${attempt}/${maxAttempts} 次自动修复尝试。

关键信息：
- 项目目录：${projectDir}
- EVOLCLAW_HOME：${p.root}
- 错误日志：${stdoutLog}
- 主日志：${p.logs}/evolclaw-*.log（按小时切片，读最新的那个，包含 config 校验失败等关键错误）
- 修复记录：${selfHealLog}（${selfHealExists}）

⚠️ 重要诊断技巧：
- stdout.log 可能是空的（进程秒退时 logger 输出不会到 stdout），一定要同时读 evolclaw-*.log 最新文件
- 必须实际运行进程来复现错误：\`EVOLCLAW_HOME=${p.root} node dist/index.js 2>&1\`，观察输出和退出码
- 检查是否有旧进程仍在运行：\`ps aux | grep 'node.*dist/index.js' | grep -v grep\`，旧进程可能占用端口或锁文件
- 可以运行 \`EVOLCLAW_HOME=${p.root} node dist/cli/index.js diagnose\` 快速检查配置和数据库
- 如果进程无任何输出就 exit(1)，说明是 process.exit(1) 被显式调用，搜索源码中所有 process.exit(1) 位置
- 配置文件使用双 rename 原子写（foo.json → foo.json_ → foo.json__），崩溃时可从 foo.json_ 恢复

请执行以下步骤：
1. 读取 ${stdoutLog} 和 ${p.logs}/evolclaw-*.log（最新文件）的最后 50 行
2. 运行 \`EVOLCLAW_HOME=${p.root} node dist/index.js 2>&1\` 复现错误（设置 10 秒超时）
3. 如果 ${selfHealLog} 存在，先阅读之前的修复记录，避免重复尝试已失败的方案
4. 根据实际复现的错误修复代码
5. 执行 npm run build 确认编译通过
6. 验证修复：启动服务确认 ready.signal 已写入，然后执行 \`EVOLCLAW_HOME=${p.root} node dist/cli/index.js stop\` 优雅停止（restart-monitor 会负责最终启动）
7. 将本次修复内容追加到 ${selfHealLog}，格式：
   ## 第 ${attempt} 次修复 - {时间}
   - 错误原因：...
   - 修复方案：...
   - 修改文件：...

注意：只修复导致启动失败的问题，不要做额外的重构或优化。`;

  try {
    log(`Invoking claude CLI (attempt ${attempt}, timeout ${timeout / 60000}min)...`);

    const { stdout, stderr } = await execFileAsync('claude', [
      '-p', prompt,
      '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep',
      '--output-format', 'text',
      '--no-session-persistence',
    ], {
      cwd: projectDir,
      timeout,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stdout) log(`Claude output: ${stdout.slice(0, 500)}`);
    if (stderr) log(`Claude stderr: ${stderr.slice(0, 500)}`);

    log(`Claude CLI completed (attempt ${attempt})`);
    return true;
  } catch (error: any) {
    if (error.killed) {
      log(`Claude CLI timeout after ${timeout / 60000}min (attempt ${attempt})`);
    } else {
      log(`Claude CLI error: exit code ${error.code ?? 'unknown'} (attempt ${attempt})`);
    }
    if (error.stdout) log(`Claude output: ${String(error.stdout).slice(0, 500)}`);
    if (error.stderr) {
      const stderr = String(error.stderr).replace(/Warning: no stdin.*\n?/g, '').trim();
      if (stderr) log(`Claude stderr: ${stderr.slice(0, 300)}`);
    }
    return false;
  }
}

/**
 * 归档 self-heal.md
 */
function archiveSelfHealLog(
  p: ReturnType<typeof resolvePaths>,
  log: (msg: string) => void
) {
  if (!fs.existsSync(p.selfHealLog)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const archivePath = path.join(p.logs, `self-heal-${timestamp}.md`);
  fs.renameSync(p.selfHealLog, archivePath);
  log(`Archived self-heal log to ${archivePath}`);
}

/**
 * Resolve a channel instance name to its type and config object.
 * Searches across all channel types (feishu, wechat, aun) for a matching instance.
 */
function resolveInstanceConfig(instanceName: string): { type: string; config: any } | null {
  // 新结构：channel key 是 <aid>#<type>#<name>，解析后从对应 agent 的 channels[] 找
  const parts = instanceName.split('#');
  if (parts.length === 3) {
    const [aid, type, name] = parts;
    const { agents } = loadAllAgents();
    const agent = agents.find(a => a.aid === aid);
    if (!agent) return null;
    const inst = agent.channels.find((c: any) => c.type === type && c.name === name);
    if (inst) return { type, config: inst };
  }
  return null;
}

/**
 * 通过对应渠道 API 发送通知（轻量级，不依赖 Channel 实例）
 * 支持 feishu / wechat，根据 pendingInfo.channel 路由
 *
 * Phase 3 例外说明（出站消息统一计划，docs/outbound-message-unification.md）：
 * 主网关进程出站系统通知（上线 / 重启完成 / channel:error 等）已迁到
 * `adapter.send(envelope, { kind: 'system.notice' | 'system.error', ... })` 统一入口。
 * 但 cli.ts 在 restart-monitor 子进程里跑，不持有 EvolAgent / ChannelAdapter 实例
 * （主网关进程已退出，新进程还没起或起不来），只能直连协议 SDK 自发。
 * 因此 self-heal 全流程（启动失败 / 修复中 / 修复成功 / 全部失败）和升级失败通知
 * 留在这里直发，**不属于** Phase 3 改造范围。
 */
async function notifyChannel(
  p: ReturnType<typeof resolvePaths>,
  pendingInfo: { channel: string; channelId: string; rootId?: string } | null,
  message: string,
  log: (msg: string) => void
) {
  if (!pendingInfo) return;

  const resolved = resolveInstanceConfig(pendingInfo.channel);
  if (!resolved) {
    log(`Channel instance "${pendingInfo.channel}" not found in any agent config`);
    return;
  }

  if (resolved.type === 'feishu') {
    try {
      const inst = resolved.config;
      if (!inst.appId || !inst.appSecret) return;

      const lark = await import('@larksuiteoapi/node-sdk');
      const client = new lark.Client({
        appId: inst.appId,
        appSecret: inst.appSecret,
      });

      if (pendingInfo.rootId) {
        await client.im.message.reply({
          path: { message_id: pendingInfo.rootId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text: message }),
            reply_in_thread: true,
          },
        });
      } else {
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: pendingInfo.channelId,
            msg_type: 'text',
            content: JSON.stringify({ text: message }),
          },
        });
      }

      log(`Feishu notification sent: ${message.slice(0, 50)}`);
    } catch (error: any) {
      log(`Feishu notification failed: ${error.message?.slice(0, 200) || error}`);
    }
  } else if (resolved.type === 'wechat') {
    try {
      const inst = resolved.config;
      if (!inst.token) return;

      const crypto = await import('node:crypto');
      const baseUrl = (inst.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '');
      const token = inst.token;

      // 读取缓存的 context_token
      const syncBufPath = path.join(p.dataDir, 'wechat-context-tokens.json');
      let contextToken: string | undefined;
      try {
        if (fs.existsSync(syncBufPath)) {
          const tokens = JSON.parse(fs.readFileSync(syncBufPath, 'utf-8'));
          contextToken = tokens[pendingInfo.channelId];
        }
      } catch {}

      if (!contextToken) {
        log(`WeChat notification skipped: no context_token for ${pendingInfo.channelId}`);
        return;
      }

      const uint32 = crypto.randomBytes(4).readUInt32BE(0);
      const wechatUin = Buffer.from(String(uint32), 'utf-8').toString('base64');
      const body = JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: pendingInfo.channelId,
          client_id: `evolclaw-restart:${Date.now()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: message } }],
          context_token: contextToken,
        },
        base_info: { channel_version: '1.0.0' },
      });

      const res = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'AuthorizationType': 'ilink_bot_token',
          'Authorization': `Bearer ${token.trim()}`,
          'X-WECHAT-UIN': wechatUin,
          'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        },
        body,
      });

      if (res.ok) {
        log(`WeChat notification sent: ${message.slice(0, 50)}`);
      } else {
        log(`WeChat notification failed: HTTP ${res.status}`);
      }
    } catch (error: any) {
      log(`WeChat notification failed: ${error.message?.slice(0, 200) || error}`);
    }
  }
}

// ==================== Migrate ====================

async function cmdMv(oldDir?: string, newDir?: string) {
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
    if (r.evolclawConfigUpdated) console.log('✓ agent config projects.list 已更新');

    console.log('\n迁移完成！');
  } catch (e) {
    console.error(`迁移失败: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

// ==================== Diagnose ====================

async function cmdDiagnose() {
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

// ==================== Ctl ====================

async function cmdCtl(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error(`用法: evolclaw ctl <command> [args...]

查询:
  status                    查看会话状态
  check                     检查渠道健康状态
  help                      显示帮助

配置:
  model [model-id]          查看/切换模型（如 opus, sonnet, haiku）
  effort [low|medium|high]  查看/切换推理强度
  compact                   压缩当前会话上下文
  perm [mode]               查看/切换权限模式

项目:
  bind <path>               注册项目目录（不切换当前会话）

消息:
  send <消息内容>           主动发送文本消息（proactive 模式）
  file [channel] <path>     发送项目内文件

运维:
  agentmd [put|set <内容>]  查看/管理 agent.md（仅 AUN 通道）
  restart [channel]         重启服务或重连指定渠道

示例:
  evolclaw ctl model sonnet
  evolclaw ctl effort high
  evolclaw ctl compact`);
    process.exit(1);
  }

  // help 不需要连接服务，直接复用无参数时的帮助输出
  if (args[0] === 'help') {
    return cmdCtl([]);
  }

  const sessionId = process.env.EVOLCLAW_SESSION_ID;
  if (!sessionId) {
    console.error('错误: EVOLCLAW_SESSION_ID 未设置（仅在 evolclaw 托管环境中可用）');
    process.exit(1);
  }

  const cmd = '/' + args.join(' ');
  const socketPath = resolvePaths().socket;

  // compact/restart 等长时操作使用更长超时
  const longRunning = ['/compact', '/restart'];
  const timeout = longRunning.some(c => cmd.startsWith(c)) ? 60_000 : 10_000;

  const result = await ipcQuery(socketPath, {
    type: 'ctl',
    cmd,
    sessionId,
  }, timeout);

  if (!result) {
    console.error('错误: 无法连接 evolclaw 服务');
    process.exit(1);
  }

  const ctlResult = result as any;
  if (ctlResult.ok) {
    console.log(ctlResult.result);
  } else {
    console.error(ctlResult.error || '执行失败');
    process.exit(1);
  }
}

// ==================== Agent ====================

async function cmdAgent(args: string[]): Promise<void> {
  const sub = args[0];
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';

  if (sub === 'help' || sub === '--help' || sub === '-h' || args.includes('--help') || args.includes('-h')) {
    console.log(`用法: evolclaw agent <command>

Commands:
  list                    列出所有 agent
  show <aid>              查看 agent 详情（身份 + 配置 + 连接 + 会话 + 路径）
  new [aid]               交互式创建 agent
  new <aid> --non-interactive ...  非交互式创建
  sync-aids               从本地 AID 批量创建 agent
  enable <aid>            启用 agent
  disable <aid>           停用 agent
  get <aid> <key>         读取单个配置字段（支持点路径）
  set <aid> <key> <val>   修改单个配置字段（支持点路径）
  rename <aid> <name>     修改 agent 名称（更新 agent.md 并重新上传）
  reload [aid]            热重载配置（无参数=全量 resync）
  delete <aid> [--purge]  删除 agent

Options:
  --format json           输出 JSON 格式

示例:
  evolclaw agent list
  evolclaw agent show mybot.agentid.pub
  evolclaw agent new mybot.agentid.pub
  evolclaw agent enable mybot.agentid.pub
  evolclaw agent get mybot.agentid.pub active_baseagent
  evolclaw agent set mybot.agentid.pub active_baseagent codex
  evolclaw agent rename mybot.agentid.pub "My Bot"
  evolclaw agent delete mybot.agentid.pub --purge`);
    return;
  }

  const {
    agentList, agentShow, agentCreateInteractive, agentCreateNonInteractive,
    agentSyncAids, agentReload, agentEnable, agentDisable,
    agentGet, agentSet, agentDelete, agentRename,
  } = await import('./agent.js');

  // --- list ---
  if (!sub || sub === 'list') {
    const result = await agentList();
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.agents.length === 0) {
      console.log('No agents configured.');
      return;
    }
    console.log(
      'NAME'.padEnd(14) + 'STATUS'.padEnd(10) + 'CHANNELS'.padEnd(24) +
      'PROJECT'.padEnd(22) + 'BASEAGENT'.padEnd(11) + 'LAST ACTIVE'
    );
    for (const info of result.agents) {
      const name = info.name;
      const status = info.status || 'stopped';
      const channels = info.channels?.length > 0 ? info.channels.join(', ').slice(0, 22) : '—';
      const project = info.projectPath ? path.basename(info.projectPath) : '—';
      const baseagent = info.baseagent || '—';
      const lastActive = info.lastActivity ? formatTimeAgo(Date.now() - info.lastActivity) : '—';
      console.log(
        name.padEnd(14) + status.padEnd(10) + channels.padEnd(24) +
        project.padEnd(22) + baseagent.padEnd(11) + lastActive
      );
    }
    return;
  }

  // --- new ---
  if (sub === 'new') {
    const name = args[1];
    const nonInteractive = args.includes('--non-interactive');
    if (nonInteractive) {
      if (!name) {
        console.error('Usage: evolclaw agent new <aid> --non-interactive ...');
        process.exit(1);
      }
      const getArg = (flag: string): string | undefined => {
        const idx = args.indexOf(flag);
        return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
      };
      const result = await agentCreateNonInteractive({
        aid: name,
        baseagent: getArg('--baseagent'),
        project: getArg('--project') || '',
        owner: getArg('--owner'),
        name: getArg('--name'),
        description: getArg('--description'),
        force: args.includes('--force'),
      });
      if (!result.ok) {
        if (formatJson) { console.log(JSON.stringify(result)); }
        else { console.error(`❌ ${result.error}`); }
        process.exit(1);
      }
      if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`✓ Created: ${result.configPath}`);
        console.log(result.agentmdUploaded
          ? '  ✓ agent.md 已发布'
          : '  ⚠ agent.md 上传失败（可用 evolclaw aid agentmd put 重试）');
        console.log('  Run `evolclaw restart` to activate.');
      }
    } else {
      const result = await agentCreateInteractive({ suggestedName: name });
      if (!result.ok) {
        if (formatJson) { console.log(JSON.stringify(result)); }
        else { console.error(`❌ ${result.error}`); }
        process.exit(1);
      }
      if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`\n✓ Created: ${result.configPath}`);
        console.log(result.agentmdUploaded
          ? '  ✓ agent.md 已发布'
          : '  ⚠ agent.md 上传失败（可用 evolclaw aid agentmd put 重试）');
        console.log('  Run `evolclaw restart` to activate.');
      }
    }
    return;
  }

  // --- sync-aids ---
  if (sub === 'sync-aids') {
    const result = await agentSyncAids();
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.created.length === 0) {
      console.log('所有本地 AID 都已有对应 agent，无需同步。');
    } else {
      console.log(`✓ 同步完成：新建 ${result.created.length} 个 agent（模板: ${result.template}）`);
      for (const aid of result.created) console.log(`  ✓ ${aid}`);
      if (result.hotReloaded) console.log('  ✓ 已热加载到运行中的进程');
      else console.log('  evolclaw 未运行，新 agent 将在下次启动时加载。');
    }
    return;
  }

  // --- reload ---
  if (sub === 'reload') {
    const target = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const result = await agentReload(target);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`✗ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (target) {
      console.log(`✓ Agent "${target}" reloaded`);
    } else {
      console.log('✓ Agent resync 完成:');
      for (const line of (result.results || [])) console.log(`  ${line}`);
    }
    return;
  }

  // --- enable ---
  if (sub === 'enable') {
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent enable <aid>'); process.exit(1); }
    const result = await agentEnable(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} enabled${result.reloaded ? ' (hot-reloaded)' : ''}`); }
    return;
  }

  // --- disable ---
  if (sub === 'disable') {
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent disable <aid>'); process.exit(1); }
    const result = await agentDisable(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} disabled${result.reloaded ? ' (hot-reloaded)' : ''}`); }
    return;
  }

  // --- get ---
  if (sub === 'get') {
    const aid = args[1];
    const key = args[2];
    if (!aid || !key) { console.error('用法: evolclaw agent get <aid> <key>'); process.exit(1); }
    const result = await agentGet(aid, key);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else {
      const val = result.value;
      console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
    }
    return;
  }

  // --- set ---
  if (sub === 'set') {
    const aid = args[1];
    const key = args[2];
    const val = args[3];
    if (!aid || !key || val === undefined) { console.error('用法: evolclaw agent set <aid> <key> <value>'); process.exit(1); }
    const result = await agentSet(aid, key, val);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} ${key} = ${JSON.stringify(result.value)}${result.reloaded ? ' (hot-reloaded)' : ''}`); }
    return;
  }

  // --- rename ---
  if (sub === 'rename') {
    const aid = args[1];
    const newName = args[2];
    if (!aid || !newName) { console.error('用法: evolclaw agent rename <aid> <name>'); process.exit(1); }
    const result = await agentRename(aid, newName);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} renamed to "${newName}"${result.uploaded ? ' (uploaded)' : ' (local only, upload failed)'}`); }
    return;
  }

  // --- delete ---
  if (sub === 'delete') {
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent delete <aid> [--purge]'); process.exit(1); }
    const purge = args.includes('--purge');
    const result = await agentDelete(aid, purge);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) { console.log(JSON.stringify(result, null, 2)); }
    else { console.log(`✓ ${aid} deleted${purge ? ' (purged)' : ''}`); }
    return;
  }

  // --- show ---
  if (sub === 'show') {
    const aid = args[1];
    if (!aid) { console.error('用法: evolclaw agent show <aid>'); process.exit(1); }
    const result = await agentShow(aid);
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(result.error); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printAgentShowHuman(result);
    return;
  }

  // --- default: `evolclaw agent <aid>` (shorthand for show) ---
  const result = await agentShow(sub);
  if (!result.ok) {
    if (formatJson) { console.log(JSON.stringify(result)); }
    else { console.error(result.error); }
    process.exit(1);
  }
  if (formatJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printAgentShowHuman(result);
}

function printAgentShowHuman(result: any): void {
  console.log(`${result.aid} (${result.status})\n`);
  if (result.identity.name || result.identity.description) {
    console.log('  Identity');
    if (result.identity.name) console.log(`    Name:         ${result.identity.name}`);
    if (result.identity.description) console.log(`    Description:  ${result.identity.description}`);
    console.log('');
  }
  console.log('  Config');
  console.log(`    Baseagent:    ${result.config.baseagent || '—'}`);
  if (result.config.model) console.log(`    Model:        ${result.config.model}`);
  if (result.config.effort) console.log(`    Effort:       ${result.config.effort}`);
  if (result.config.chatmode) console.log(`    Chatmode:     private=${result.config.chatmode.private}  group=${result.config.chatmode.group}`);
  if (result.config.owners.length) console.log(`    Owners:       ${result.config.owners.join(', ')}`);
  console.log(`    Channels:     ${result.config.channels.length > 0 ? result.config.channels.join(', ') : '—'}`);
  console.log('');
  if (result.connection) {
    const c = result.connection;
    console.log('  Connection');
    console.log(`    Status:       ${c.status}`);
    console.log(`    Uptime:       ${c.uptime_ms != null ? formatDurationMs(c.uptime_ms) : '—'}`);
    console.log(`    Reconnects:   ${c.reconnect_count}`);
    console.log(`    Msgs recv:    ${c.messages_received}`);
    console.log(`    Msgs sent:    ${c.messages_sent}`);
    console.log(`    Bytes in:     ${formatBytes(c.bytes_received)}`);
    console.log(`    Bytes out:    ${formatBytes(c.bytes_sent)}`);
    console.log(`    Last recv:    ${c.last_received_at ? formatTimeAgo(Date.now() - new Date(c.last_received_at).getTime()) : '—'}`);
    console.log(`    Last sent:    ${c.last_sent_at ? formatTimeAgo(Date.now() - new Date(c.last_sent_at).getTime()) : '—'}`);
    console.log(`    Peers:        ${c.unique_peer_count}`);
    console.log('');
  } else {
    console.log('  Connection      (daemon offline)');
    console.log('');
  }
  console.log('  Sessions');
  console.log(`    Active:       ${result.sessions.active}`);
  console.log(`    Last active:  ${result.sessions.last_activity ? formatTimeAgo(Date.now() - new Date(result.sessions.last_activity).getTime()) : '—'}`);
  console.log('');
  console.log('  Paths');
  console.log(`    Config:       ${result.paths.config}`);
  console.log(`    Agent.md:     ${result.paths.agent_md}`);
  console.log(`    Project:      ${result.paths.project || '—'}`);
  console.log(`    Data:         ${result.paths.data}`);
}

function formatDurationMs(ms: number): string {
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

// ==================== AID ====================

function resolveAunPath(args: string[]): string | undefined {
  const idx = args.indexOf('--aun-path');
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return process.env.AUN_HOME || undefined;
}

async function cmdAid(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';
  const aunPath = resolveAunPath(args);

  if (sub === 'help' || sub === '--help' || sub === '-h' || args.includes('--help') || args.includes('-h')) {
    console.log(`用法: evolclaw aid <command>

Commands:
  list              列出本地所有 AID
  show <aid>        查看本地 AID 详情（证书有效期、私钥状态）
  new <aid>         创建新 AID 身份
  delete <aid>      删除本地 AID（无网络注销）
  lookup <aid>      远程探测 AID（是否存在 + 网关 + agent.md）
  agentmd put <aid> 读本地 agent.md → 签名 → 上传
  agentmd get <aid> 下载 agent.md → 验签 → 本地持久化

Options:
  --format json     输出 JSON 格式

示例:
  evolclaw aid list
  evolclaw aid show toleiliang2.agentid.pub
  evolclaw aid new reviewer.agentid.pub
  evolclaw aid delete old.agentid.pub
  evolclaw aid lookup someone.agentid.pub
  evolclaw aid agentmd put mybot.agentid.pub
  evolclaw aid agentmd get someone.agentid.pub`);
    return;
  }

  const { aidList, aidCreate, aidShow, aidDelete, aidLookup, agentmdPut, agentmdGet, buildInitialAgentMd, isValidAid } = await import('../aun/aid/index.js');

  if (sub === 'list') {
    const aids = aidList(aunPath);
    if (formatJson) {
      console.log(JSON.stringify(aids, null, 2));
      return;
    }
    if (aids.length === 0) {
      console.log('本地无 AID');
      return;
    }
    console.log('本地 AID:');
    for (const a of aids) {
      const icons = [
        a.hasPrivateKey ? '🔑' : '  ',
        a.hasAgentMd ? '📄' : '  ',
      ].join('');
      console.log(`  ${icons} ${a.aid}`);
    }
    console.log('\n🔑=私钥  📄=agent.md');
    return;
  }

  if (sub === 'show') {
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw aid show <aid>');
      process.exit(1);
    }
    const info = aidShow(aid, { aunPath });
    if (formatJson) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    console.log(`AID: ${info.aid}`);
    console.log(`  私钥: ${info.hasPrivateKey ? '有' : '无'}`);
    console.log(`  agent.md: ${info.hasAgentMd ? '有' : '无'}`);
    console.log(`  证书到期: ${info.certExpiresAt ?? '无证书'}`);
    if (info.certSubject) console.log(`  证书主体: ${info.certSubject}`);
    return;
  }

  if (sub === 'new') {
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw aid new <完整AID>\n例: evolclaw aid new reviewer.agentid.pub');
      process.exit(1);
    }
    if (!isValidAid(aid)) {
      console.error(`❌ 无效 AID 格式: ${aid}`);
      process.exit(1);
    }

    const result = await aidCreate(aid, { aunPath });

    if (!result.alreadyExisted) {
      const content = buildInitialAgentMd({ aid });
      try {
        await agentmdPut(content, { aid, client: result.client, aunPath });
        console.log('✓ agent.md 已发布');
      } catch (e: any) {
        console.warn(`⚠ agent.md 发布失败（首次连接将自动重试）: ${String(e.message || e).slice(0, 100)}`);
      }
    }
    try { await result.client.close(); } catch {}

    const verb = result.alreadyExisted ? '已存在' : '已创建';
    console.log(`✓ ${aid} ${verb}`);
    console.log('  如需上线 AUN 通道，运行 evolclaw agent new ' + aid);
    return;
  }

  if (sub === 'delete') {
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw aid delete <aid>');
      process.exit(1);
    }
    const deleted = aidDelete(aid, { aunPath });
    if (deleted) {
      console.log(`✓ ${aid} 已删除`);
    } else {
      console.error(`❌ 本地不存在: ${aid}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'lookup') {
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw aid lookup <aid>');
      process.exit(1);
    }
    if (!isValidAid(aid)) {
      console.error(`❌ 无效 AID 格式: ${aid}`);
      process.exit(1);
    }
    const result = await aidLookup(aid);
    if (formatJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.exists) {
      console.log(`✓ ${aid} 已注册`);
      if (result.gateway) console.log(`  网关: ${result.gateway}`);
      if (result.content) {
        const hasSig = result.content.includes('AUN-SIGNATURE');
        console.log(`  签名: ${hasSig ? '有（未验证，如需验证请用 evolclaw aid agentmd get ' + aid + '）' : '无'}`);
        console.log('');
        console.log(result.content);
      }
    } else {
      console.log(`✗ ${aid} 未注册`);
      if (result.gateway) console.log(`  网关: ${result.gateway}`);
      if (result.error) console.log(`  原因: ${result.error}`);
    }
    return;
  }

  if (sub === 'agentmd') {
    const verb = args[1];
    const aid = args[2];

    if (verb === 'put') {
      if (!aid) {
        console.error('用法: evolclaw aid agentmd put <aid>');
        process.exit(1);
      }
      if (!isValidAid(aid)) {
        console.error(`❌ 无效 AID 格式: ${aid}`);
        process.exit(1);
      }
      const aunBase = aunPath ?? path.join(os.homedir(), '.aun');
      const localPath = path.join(aunBase, 'AIDs', aid, 'agent.md');
      if (!fs.existsSync(localPath)) {
        console.error(`❌ 本地无 agent.md: ${aid}`);
        process.exit(1);
      }
      const content = fs.readFileSync(localPath, 'utf-8');
      await agentmdPut(content, { aid, aunPath });
      console.log('✓ agent.md 已发布');
      return;
    }

    if (verb === 'get') {
      if (!aid) {
        console.error('用法: evolclaw aid agentmd get <aid>');
        process.exit(1);
      }
      if (!isValidAid(aid)) {
        console.error(`❌ 无效 AID 格式: ${aid}`);
        process.exit(1);
      }
      try {
        const result = await agentmdGet(aid, { withVerification: true, aunPath });
        if (!result.content || !result.content.trim()) {
          console.log(`ℹ️ ${aid} 尚未设置 agent.md`);
          return;
        }
        if (formatJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.content);
          const v = result.verification;
          if (v.status === 'verified') {
            console.error(`✓ 签名验证通过`);
          } else if (v.status === 'invalid') {
            console.error(`⚠ 签名验证失败: ${v.reason ?? '未知原因'}`);
          } else {
            console.error(`ℹ️ 未签名`);
          }
        }
      } catch (e: any) {
        const msg = String(e.message || e);
        if (msg.includes('not found') || msg.includes('404')) {
          console.log(`ℹ️ ${aid} 尚未设置 agent.md`);
        } else {
          console.error(`❌ 获取失败: ${msg.slice(0, 100)}`);
          process.exit(1);
        }
      }
      return;
    }

    console.error(`未知子命令: aid agentmd ${verb ?? ''}\n用法: evolclaw aid agentmd [put|get] <aid>`);
    process.exit(1);
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw aid [list|show|new|delete|lookup|agentmd] <aid>`);
  process.exit(1);
}

// ==================== RPC ====================

async function cmdRpc(args: string[]): Promise<void> {
  if (args[0] === 'help' || args.length === 0) {
    console.log(`用法: evolclaw rpc --as <aid> --params <params>

通用 AUN RPC 调用。

--params 自动判断输入形式:
  单行 JSON (以 { 开头)     → 单次调用
  多行 JSONL                → 逐行执行，失败即停
  文件路径 (文件存在)        → 读取文件内容作为 JSONL

每行 JSON 格式: {"method":"<namespace.method>","params":{...}}

示例:
  evolclaw rpc --as alice.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'
  evolclaw rpc --as alice.agentid.pub --params calls.jsonl`);
    return;
  }

  const asIdx = args.indexOf('--as');
  const paramsIdx = args.indexOf('--params');
  const aunPath = resolveAunPath(args);

  if (asIdx === -1 || asIdx + 1 >= args.length) {
    console.error('❌ 缺少 --as <aid>');
    process.exit(1);
  }
  if (paramsIdx === -1 || paramsIdx + 1 >= args.length) {
    console.error('❌ 缺少 --params <params>');
    process.exit(1);
  }

  const aid = args[asIdx + 1];
  const paramsRaw = args[paramsIdx + 1];

  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(aid)) {
    console.error(`❌ 无效 AID 格式: ${aid}`);
    process.exit(1);
  }

  // Determine input: file, single JSON, or multi-line JSONL
  let lines: string[];
  if (fs.existsSync(paramsRaw)) {
    lines = fs.readFileSync(paramsRaw, 'utf-8').split('\n').filter(l => l.trim());
  } else if (paramsRaw.includes('\n')) {
    lines = paramsRaw.split('\n').filter(l => l.trim());
  } else {
    lines = [paramsRaw];
  }

  // Parse calls
  const calls: Array<{ method: string; params: any }> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed.method) {
        console.error(`❌ 第 ${i + 1} 行缺少 "method" 字段`);
        process.exit(1);
      }
      calls.push({ method: parsed.method, params: parsed.params ?? {} });
    } catch (e: any) {
      console.error(`❌ 第 ${i + 1} 行 JSON 解析失败: ${e.message}`);
      process.exit(1);
    }
  }

  const { rpcCall, rpcBatch } = await import('../aun/rpc/index.js');

  if (calls.length === 1) {
    const result = await rpcCall(aid, calls[0].method, calls[0].params, { aunPath });
    console.log(JSON.stringify(result));
  } else {
    const results = await rpcBatch(aid, calls, { aunPath });
    for (const r of results) {
      console.log(JSON.stringify(r));
    }
  }
}

// ==================== Storage ====================

async function cmdStorage(args: string[]): Promise<void> {
  const sub = args[0];
  const aunPath = resolveAunPath(args);
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';

  if (!sub || sub === 'help') {
    console.log(`用法: evolclaw storage <command> <aid> [options]

Commands:
  upload <aid> <local-file> <remote-path> [--public]   上传文件（默认私有）
  download <aid> <url> [local-path]                    下载文件
  ls <aid> [prefix]                                    列文件
  rm <aid> <remote-path>                               删文件
  quota <aid>                                          查配额

<url> 格式: [https://]<owner-aid>/<path>

示例:
  evolclaw storage upload myaid.agentid.pub ./doc.txt notes/doc.txt
  evolclaw storage upload myaid.agentid.pub ./pic.png images/pic.png --public
  evolclaw storage download myaid.agentid.pub myaid.agentid.pub/notes/doc.txt ./doc.txt
  evolclaw storage download myaid.agentid.pub bob.agentid.pub/public/file.pdf ./file.pdf
  evolclaw storage ls myaid.agentid.pub notes/
  evolclaw storage rm myaid.agentid.pub notes/doc.txt
  evolclaw storage quota myaid.agentid.pub`);
    return;
  }

  const aid = args[1];
  if (!aid) {
    console.error('❌ 缺少 <aid> 参数');
    process.exit(1);
  }

  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(aid)) {
    console.error(`❌ 无效 AID 格式: ${aid}`);
    process.exit(1);
  }

  const { storageUpload, storageDownload, storageLs, storageRm, storageQuota } = await import('../aun/storage/index.js');

  if (sub === 'upload') {
    const localFile = args[2];
    const remotePath = args[3];
    const isPublic = args.includes('--public');

    if (!localFile || !remotePath) {
      console.error('用法: evolclaw storage upload <aid> <local-file> <remote-path> [--public]');
      process.exit(1);
    }
    if (!fs.existsSync(localFile)) {
      console.error(`❌ 文件不存在: ${localFile}`);
      process.exit(1);
    }

    const result = await storageUpload(aid, localFile, remotePath, { isPublic, aunPath });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: result.error })); }
      else { console.error(`❌ 上传失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify({ ok: true, objectKey: remotePath, isPublic, ref: `${aid}/${remotePath}` }));
    } else {
      console.log(`✓ 已上传: ${remotePath}${isPublic ? ' (公开)' : ''}`);
      console.log(`  引用: ${aid}/${remotePath}`);
      console.log(`  下载: evolclaw storage download ${aid} ${aid}/${remotePath}`);
    }
    return;
  }

  if (sub === 'download') {
    const url = args[2];
    const localPath = args[3];

    if (!url) {
      console.error('用法: evolclaw storage download <aid> <url> [local-path]');
      process.exit(1);
    }

    const result = await storageDownload(aid, url, localPath, { aunPath });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: result.error })); }
      else { console.error(`❌ 下载失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify({ ok: true, localPath: result.localPath, size: result.size }));
    } else {
      console.log(`✓ 已下载: ${result.localPath} (${result.size} bytes)`);
    }
    return;
  }

  if (sub === 'ls') {
    const prefix = args[2] || '';
    const result = await storageLs(aid, prefix, { aunPath });
    if (!result.ok) {
      console.error(`❌ 列文件失败: ${JSON.stringify(result.error)}`);
      process.exit(1);
    }
    const objects = result.result?.objects || result.result || [];
    if (Array.isArray(objects) && objects.length === 0) {
      console.log('(空)');
    } else {
      console.log(JSON.stringify(objects, null, 2));
    }
    return;
  }

  if (sub === 'rm') {
    const remotePath = args[2];
    if (!remotePath) {
      console.error('用法: evolclaw storage rm <aid> <remote-path>');
      process.exit(1);
    }
    const result = await storageRm(aid, remotePath, { aunPath });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify({ ok: false, error: result.error })); }
      else { console.error(`❌ 删除失败: ${JSON.stringify(result.error)}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify({ ok: true, objectKey: remotePath }));
    } else {
      console.log(`✓ 已删除: ${remotePath}`);
    }
    return;
  }

  if (sub === 'quota') {
    const result = await storageQuota(aid, { aunPath });
    if (!result.ok) {
      console.error(`❌ 查询配额失败: ${JSON.stringify(result.error)}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result.result, null, 2));
    return;
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw storage [upload|download|ls|rm|quota]`);
  process.exit(1);
}

// ==================== Msg ====================

async function cmdMsg(args: string[]): Promise<void> {
  const sub = args[0];
  const aunPath = resolveAunPath(args);
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';
  const appIdx = args.indexOf('--app');
  const appSlot = appIdx >= 0 ? args[appIdx + 1] : undefined;
  const asDaemon = args.includes('--as-daemon');

  if (!sub || sub === 'help') {
    console.log(`用法: evolclaw msg <command> <from-aid> [args...] [options]

Commands:
  send <from> <to> <text>                              发送文本
  send <from> <to> --file <path> [--as <type>]         发送文件（image|video|voice|file）
  send <from> <to> --link <url> [--title T]            发送链接卡片
  send <from> <to> --payload <json>                    发送自定义 payload
  pull <from> [--after-seq N] [--limit N]              拉取收件箱
  ack <from> <seq> --app <name>                        确认已读（必须传 --app）
  recall <from> <message-id> [<message-id>...]         撤回消息
  online <from> <target-aid> [<target-aid>...]         查询在线状态

Options:
  --app <name>          指定应用 slot（隔离 ack 游标）
  --as-daemon           ack 时显式以 daemon 身份（高危，会污染 daemon 游标）
  --format json         输出 JSON 格式
  --content-type <mime> 显式覆盖 MIME（仅 --file 模式）
  --text <说明>          附件说明文字（仅 --file 模式）
  --transcript <text>   语音转写（仅 --as voice）

示例:
  evolclaw msg send alice.agentid.pub bob.agentid.pub "hello"
  evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./pic.png
  evolclaw msg send alice.agentid.pub bob.agentid.pub --file ./demo.mp4 --as video
  evolclaw msg send alice.agentid.pub bob.agentid.pub --link https://example.com --title "AUN"
  evolclaw msg pull alice.agentid.pub --app my-bot
  evolclaw msg ack alice.agentid.pub 42 --app my-bot
  evolclaw msg recall alice.agentid.pub msg-uuid-1 msg-uuid-2
  evolclaw msg online alice.agentid.pub bob.agentid.pub carol.agentid.pub`);
    return;
  }

  const from = args[1];
  if (!from) {
    console.error('❌ 缺少 <from-aid> 参数');
    process.exit(1);
  }
  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(from)) {
    console.error(`❌ 无效 AID 格式: ${from}`);
    process.exit(1);
  }

  const { msgSend, msgPull, msgAck, msgRecall, msgOnline } = await import('../aun/msg/index.js');
  const commonOpts = { aunPath, slotId: appSlot };

  if (sub === 'send') {
    const to = args[2];
    if (!to) {
      console.error('用法: evolclaw msg send <from> <to> <text|--file ...|--link ...|--payload ...>');
      process.exit(1);
    }
    if (!isValidAid(to)) {
      console.error(`❌ 无效目标 AID: ${to}`);
      process.exit(1);
    }

    const fileVal = getArgValue(args, '--file');
    const linkVal = getArgValue(args, '--link');
    const payloadVal = getArgValue(args, '--payload');
    let body: any;

    if (fileVal) {
      body = {
        mode: 'file',
        filePath: fileVal,
        as: getArgValue(args, '--as'),
        contentType: getArgValue(args, '--content-type'),
        text: getArgValue(args, '--text'),
        transcript: getArgValue(args, '--transcript'),
      };
    } else if (linkVal) {
      body = {
        mode: 'link',
        url: linkVal,
        title: getArgValue(args, '--title'),
        description: getArgValue(args, '--description'),
      };
    } else if (payloadVal) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payloadVal); }
      catch (e: any) {
        console.error(`❌ --payload 解析失败: ${e.message}`);
        process.exit(1);
      }
      body = { mode: 'payload', payload: parsed };
    } else {
      const text = collectPositional(args, 3).join(' ');
      if (!text) {
        console.error('❌ 缺少消息内容（文本或 --file/--link/--payload）');
        process.exit(1);
      }
      body = { mode: 'text', text };
    }

    const encrypt = args.includes('--encrypt');
    const result = await msgSend({ from, to, body, encrypt, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ 发送失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ 已发送 ${result.message_id ?? ''} seq=${result.seq ?? '-'} status=${result.status ?? '-'}`);
    }
    return;
  }

  if (sub === 'pull') {
    if (!appSlot) {
      console.error('⚠ 警告: 未传 --app，将使用 daemon 共享 slot（可能与 daemon 看到同一批消息）');
    }
    const afterSeqStr = getArgValue(args, '--after-seq');
    const limitStr = getArgValue(args, '--limit');
    const afterSeq = afterSeqStr !== undefined ? Number(afterSeqStr) : undefined;
    const limit = limitStr !== undefined ? Number(limitStr) : undefined;
    if (afterSeq !== undefined && !Number.isFinite(afterSeq)) {
      console.error(`❌ --after-seq 必须是数字: ${afterSeqStr}`);
      process.exit(1);
    }
    if (limit !== undefined && !Number.isFinite(limit)) {
      console.error(`❌ --limit 必须是数字: ${limitStr}`);
      process.exit(1);
    }

    const result = await msgPull({ from, afterSeq, limit, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ 拉取失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ ${result.count} 条消息，latest_seq=${result.latest_seq}`);
      for (const m of result.messages) {
        const text = (m.payload as any)?.text ?? JSON.stringify(m.payload).slice(0, 80);
        console.log(`  [${m.seq}] ${m.from}: ${text}`);
      }
      if (result.ephemeral_dropped_count && result.ephemeral_dropped_count > 0) {
        console.log(`  (临时消息淘汰: ${result.ephemeral_dropped_count} 条)`);
      }
    }
    return;
  }

  if (sub === 'ack') {
    const seqStr = args[2];
    if (!seqStr) {
      console.error('用法: evolclaw msg ack <from> <seq> --app <name>');
      process.exit(1);
    }
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      console.error(`❌ seq 必须是数字: ${seqStr}`);
      process.exit(1);
    }
    if (!appSlot && !asDaemon) {
      console.error('❌ ack 必须传 --app <name>（或 --as-daemon 显式以 daemon 身份，高危）');
      console.error('   理由: 不传 --app 会推进 daemon 共享的 ack 游标，导致 daemon 丢消息');
      process.exit(1);
    }

    const result = await msgAck({ from, seq, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ack 失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ ack_seq=${result.ack_seq}`);
    }
    return;
  }

  if (sub === 'recall') {
    const messageIds = collectPositional(args, 2);
    if (messageIds.length === 0) {
      console.error('用法: evolclaw msg recall <from> <message-id> [<message-id>...]');
      process.exit(1);
    }

    const result = await msgRecall({ from, messageIds, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ recall 失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`✓ 受理 ${result.accepted}，撤回 ${result.recalled}`);
      if (result.errors && result.errors.length > 0) {
        for (const e of result.errors) {
          console.log(`  失败 ${e.message_id}: ${e.error}`);
        }
      }
    }
    return;
  }

  if (sub === 'online') {
    const targets = collectPositional(args, 2);
    if (targets.length === 0) {
      console.error('用法: evolclaw msg online <from> <target-aid> [<target-aid>...]');
      process.exit(1);
    }
    for (const t of targets) {
      if (!isValidAid(t)) {
        console.error(`❌ 无效 AID: ${t}`);
        process.exit(1);
      }
    }

    const result = await msgOnline({ from, targets, ...commonOpts });
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ 查询失败: ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      for (const [aid, online] of Object.entries(result.online)) {
        console.log(`  ${online ? '🟢' : '⚫'} ${aid}`);
      }
    }
    return;
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw msg [send|pull|ack|recall|online]`);
  process.exit(1);
}

// ==================== Group ====================

async function cmdGroup(args: string[]): Promise<void> {
  const sub = args[0];
  const aunPath = resolveAunPath(args);
  const formatJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';
  const appIdx = args.indexOf('--app');
  const appSlot = appIdx >= 0 ? args[appIdx + 1] : undefined;
  const asDaemon = args.includes('--as-daemon');

  if (!sub || sub === 'help') {
    console.log(`用法: evolclaw group <command> <from-aid> [args...] [options]

消息:
  send <from> <group-id> <text>                        发送群文本
  send <from> <group-id> --file <path> [--as <type>]   发送群文件
  send <from> <group-id> --payload <json>              发送自定义 payload
  pull <from> <group-id> [--after-seq N] [--limit N]   拉取群消息
  ack <from> <group-id> <seq> --app <name>             确认已读（必须传 --app）

群管理:
  create <from> <name> [--visibility public|private] [--description D] [--join-mode M]  创建群
  list <from> [--size N]                                列出我加入的群
  info <from> <group-id>                                查看群详情
  update <from> <group-id> [--name N] [--description D] 修改群信息
  dissolve <from> <group-id>                            解散群

成员:
  join <from> <group-id> [--message M] [--answer A]    申请加入
  leave <from> <group-id>                              退出群
  invite <from> <group-id> <member-aid> [<member-aid>...]   邀请成员
  kick <from> <group-id> <member-aid>                  踢出成员
  members <from> <group-id> [--page N] [--size N]      列出群成员
  online <from> <group-id>                             查看在线成员

Options:
  --app <name>          指定应用 slot（隔离 ack 游标）
  --as-daemon           ack 时显式以 daemon 身份（高危）
  --format json         输出 JSON 格式
  --mention <aid>       发送时 @ 某个成员（可多次）
  --mention-all         发送时 @ 所有人

示例:
  evolclaw group create alice.agentid.pub "Dev Team" --visibility private
  evolclaw group send alice.agentid.pub g-dev.agentid.pub "hello team"
  evolclaw group send alice.agentid.pub g-dev.agentid.pub "@bob 看下 PR" --mention bob.agentid.pub
  evolclaw group send alice.agentid.pub g-dev.agentid.pub --file ./arch.png
  evolclaw group invite alice.agentid.pub g-dev.agentid.pub bob.agentid.pub carol.agentid.pub
  evolclaw group members alice.agentid.pub g-dev.agentid.pub`);
    return;
  }

  const from = args[1];
  if (!from) {
    console.error('❌ 缺少 <from-aid> 参数');
    process.exit(1);
  }
  const { isValidAid } = await import('../aun/aid/index.js');
  if (!isValidAid(from)) {
    console.error(`❌ 无效 AID 格式: ${from}`);
    process.exit(1);
  }

  const {
    groupSend, groupPull, groupAck,
    groupCreate, groupInfo, groupList, groupUpdate, groupDissolve,
    groupJoin, groupLeave, groupInvite, groupKick, groupMembers, groupOnline,
  } = await import('../aun/msg/index.js');
  const commonOpts = { aunPath, slotId: appSlot };

  // 通用 group_id 提取（第三参数）
  const requireGroupId = (): string => {
    const gid = args[2];
    if (!gid) {
      console.error(`❌ 缺少 <group-id> 参数`);
      process.exit(1);
    }
    return gid;
  };

  // 收集 --mention（可多次）
  const collectMentions = (): Array<Record<string, unknown>> => {
    const mentions: Array<Record<string, unknown>> = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--mention') {
        mentions.push({ aid: args[i + 1] });
      }
    }
    if (args.includes('--mention-all')) {
      mentions.push({ scope: 'all' });
    }
    return mentions;
  };

  // 输出辅助
  const outputResult = (result: any, successHuman: () => void) => {
    if (!result.ok) {
      if (formatJson) { console.log(JSON.stringify(result)); }
      else { console.error(`❌ ${result.error}`); }
      process.exit(1);
    }
    if (formatJson) {
      console.log(JSON.stringify(result));
    } else {
      successHuman();
    }
  };

  // ---- 消息 ----

  if (sub === 'send') {
    const groupId = requireGroupId();
    const fileVal = getArgValue(args, '--file');
    const payloadVal = getArgValue(args, '--payload');
    let body: any;

    if (fileVal) {
      body = {
        mode: 'file',
        filePath: fileVal,
        as: getArgValue(args, '--as'),
        contentType: getArgValue(args, '--content-type'),
        text: getArgValue(args, '--text'),
        transcript: getArgValue(args, '--transcript'),
      };
    } else if (payloadVal) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payloadVal); }
      catch (e: any) {
        console.error(`❌ --payload 解析失败: ${e.message}`);
        process.exit(1);
      }
      body = { mode: 'payload', payload: parsed };
    } else {
      const text = collectPositional(args, 3).join(' ');
      if (!text) {
        console.error('❌ 缺少消息内容（文本或 --file/--payload）');
        process.exit(1);
      }
      body = { mode: 'text', text };
    }

    const mentions = collectMentions();
    const encryptGroup = args.includes('--encrypt');
    const result = await groupSend({ from, groupId, body, mentions: mentions.length ? mentions : undefined, encrypt: encryptGroup, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已发送 message_id=${r.message?.message_id ?? '-'} seq=${r.message?.seq ?? '-'}`);
    });
    return;
  }

  if (sub === 'pull') {
    const groupId = requireGroupId();
    if (!appSlot) {
      console.error('⚠ 警告: 未传 --app，将使用 daemon 共享 slot');
    }
    const afterSeqStr = getArgValue(args, '--after-seq');
    const limitStr = getArgValue(args, '--limit');
    const afterSeq = afterSeqStr !== undefined ? Number(afterSeqStr) : undefined;
    const limit = limitStr !== undefined ? Number(limitStr) : undefined;

    const result = await groupPull({ from, groupId, afterSeq, limit, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ ${r.messages.length} 条消息，latest_seq=${r.latest_message_seq}${r.has_more ? '（还有更多）' : ''}`);
      for (const m of r.messages) {
        const text = m.payload?.text ?? JSON.stringify(m.payload).slice(0, 80);
        console.log(`  [${m.seq}] ${m.sender_aid}: ${text}`);
      }
    });
    return;
  }

  if (sub === 'ack') {
    const groupId = requireGroupId();
    const seqStr = args[3];
    if (!seqStr) {
      console.error('用法: evolclaw group ack <from> <group-id> <seq> --app <name>');
      process.exit(1);
    }
    const seq = Number(seqStr);
    if (!Number.isFinite(seq)) {
      console.error(`❌ seq 必须是数字: ${seqStr}`);
      process.exit(1);
    }
    if (!appSlot && !asDaemon) {
      console.error('❌ group ack 必须传 --app <name>（或 --as-daemon 显式以 daemon 身份，高危）');
      process.exit(1);
    }

    const result = await groupAck({ from, groupId, seq, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ ack_seq=${r.ack_seq}`);
    });
    return;
  }

  // ---- 群管理 ----

  if (sub === 'create') {
    const name = args[2];
    if (!name) {
      console.error('用法: evolclaw group create <from> <name> [--visibility ...] [--description ...]');
      process.exit(1);
    }
    const visibility = getArgValue(args, '--visibility') as any;
    if (visibility && visibility !== 'public' && visibility !== 'private') {
      console.error(`❌ --visibility 必须是 public 或 private`);
      process.exit(1);
    }
    const result = await groupCreate({
      from,
      name,
      visibility,
      description: getArgValue(args, '--description'),
      joinMode: getArgValue(args, '--join-mode') as any,
      groupId: getArgValue(args, '--group-id'),
      ...commonOpts,
    });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已创建群 ${r.group?.group_id}`);
      console.log(`  名称: ${r.group?.name}`);
      console.log(`  可见性: ${r.group?.visibility}`);
    });
    return;
  }

  if (sub === 'list') {
    const sizeStr = getArgValue(args, '--size');
    const size = sizeStr !== undefined ? Number(sizeStr) : undefined;
    const result = await groupList({ from, size, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      if (r.items.length === 0) {
        console.log('(没有加入任何群)');
        return;
      }
      console.log(`共 ${r.total} 个群:`);
      for (const g of r.items) {
        console.log(`  ${g.group_id}  ${g.name}  (${g.member_count ?? '?'} 人)`);
      }
    });
    return;
  }

  if (sub === 'info') {
    const groupId = requireGroupId();
    const result = await groupInfo({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      const g = (result as any).group;
      console.log(`Group: ${g.group_id}`);
      console.log(`  名称:     ${g.name}`);
      console.log(`  群主:     ${g.owner_aid}`);
      console.log(`  可见性:   ${g.visibility ?? '-'}`);
      console.log(`  状态:     ${g.status ?? '-'}`);
      console.log(`  成员数:   ${g.member_count ?? '-'}`);
      console.log(`  最新 seq: ${g.message_seq ?? '-'}`);
      if (g.description) console.log(`  描述:     ${g.description}`);
    });
    return;
  }

  if (sub === 'update') {
    const groupId = requireGroupId();
    const name = getArgValue(args, '--name');
    const description = getArgValue(args, '--description');
    if (name === undefined && description === undefined) {
      console.error('❌ 至少需要 --name 或 --description 之一');
      process.exit(1);
    }
    const result = await groupUpdate({ from, groupId, name, description, ...commonOpts });
    outputResult(result, () => {
      const g = (result as any).group;
      console.log(`✓ 已更新 ${g.group_id}`);
      console.log(`  名称: ${g.name}`);
    });
    return;
  }

  if (sub === 'dissolve') {
    const groupId = requireGroupId();
    const result = await groupDissolve({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 已解散 ${r.group_id} (${r.status})`);
    });
    return;
  }

  // ---- 成员 ----

  if (sub === 'join') {
    const groupId = requireGroupId();
    const result = await groupJoin({
      from, groupId,
      message: getArgValue(args, '--message'),
      answer: getArgValue(args, '--answer'),
      ...commonOpts,
    });
    outputResult(result, () => {
      console.log(`✓ 已提交入群申请`);
    });
    return;
  }

  if (sub === 'leave') {
    const groupId = requireGroupId();
    const result = await groupLeave({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已退出 ${groupId}`);
    });
    return;
  }

  if (sub === 'invite') {
    const groupId = requireGroupId();
    const members = collectPositional(args, 3);
    if (members.length === 0) {
      console.error('用法: evolclaw group invite <from> <group-id> <member-aid> [<member-aid>...]');
      process.exit(1);
    }
    for (const m of members) {
      if (!isValidAid(m)) {
        console.error(`❌ 无效 AID: ${m}`);
        process.exit(1);
      }
    }
    const result = await groupInvite({ from, groupId, members, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`✓ 成功 ${r.added.length}，失败 ${r.failed.length}`);
      for (const a of r.added) console.log(`  + ${a}`);
      for (const f of r.failed) console.log(`  ✗ ${f.aid}: ${f.error}`);
    });
    return;
  }

  if (sub === 'kick') {
    const groupId = requireGroupId();
    const memberAid = args[3];
    if (!memberAid) {
      console.error('用法: evolclaw group kick <from> <group-id> <member-aid>');
      process.exit(1);
    }
    const result = await groupKick({ from, groupId, memberAid, ...commonOpts });
    outputResult(result, () => {
      console.log(`✓ 已踢出 ${memberAid}`);
    });
    return;
  }

  if (sub === 'members') {
    const groupId = requireGroupId();
    const pageStr = getArgValue(args, '--page');
    const sizeStr = getArgValue(args, '--size');
    const result = await groupMembers({
      from, groupId,
      page: pageStr !== undefined ? Number(pageStr) : undefined,
      size: sizeStr !== undefined ? Number(sizeStr) : undefined,
      ...commonOpts,
    });
    outputResult(result, () => {
      const r = result as any;
      console.log(`共 ${r.total} 名成员（第 ${r.page} 页）:`);
      for (const m of r.members) {
        console.log(`  [${m.role}] ${m.aid}`);
      }
    });
    return;
  }

  if (sub === 'online') {
    const groupId = requireGroupId();
    const result = await groupOnline({ from, groupId, ...commonOpts });
    outputResult(result, () => {
      const r = result as any;
      console.log(`在线 ${r.online_count}/${r.total}:`);
      for (const m of r.members) {
        console.log(`  🟢 ${m.aid}`);
      }
    });
    return;
  }

  console.error(`未知子命令: ${sub}\n用法: evolclaw group [send|pull|ack|create|list|info|update|dissolve|join|leave|invite|kick|members|online]`);
  process.exit(1);
}

// ==================== Main ====================

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * 收集位置参数（从 startIdx 开始），跳过 flag 及其值。
 * 已知"取值"的 flag 会消耗下一个 arg；已知"开关"的 flag 只占自身。
 */
function collectPositional(args: string[], startIdx: number): string[] {
  const VALUE_FLAGS = new Set([
    '--format', '--app', '--after-seq', '--limit', '--file', '--link',
    '--payload', '--title', '--description', '--text', '--transcript',
    '--as', '--content-type', '--mention', '--visibility', '--join-mode',
    '--group-id', '--name', '--message', '--answer', '--page', '--size',
    '--aun-path',
  ]);
  const out: string[] = [];
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++; // 跳过 flag 的值
      // else: 开关 flag，自身已被跳过
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function main(args: string[]) {
  const cmd = args[0] || 'start';

  if (cmd === '--version' || cmd === '-v' || cmd === '-V') {
    const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
    console.log(pkg.version);
    return;
  }

  switch (cmd) {
    case 'init':
      if (args[1] === 'help') {
        console.log(`用法: evolclaw init [渠道] [选项]

仅初始化 defaults.json:
  evolclaw init                          交互式（写完 defaults.json 后嵌套 agent new）
  evolclaw init --non-interactive [选项]
    --baseagent <claude|codex|gemini>    默认: PATH 中第一个可用项
    --force                              已存在 defaults.json 时覆盖

配置渠道（先 evolclaw agent new 创建 agent）:
  evolclaw init feishu        飞书扫码登录
  evolclaw init wechat        微信扫码登录
  evolclaw init dingtalk      钉钉扫码登录
  evolclaw init qqbot         QQ 机器人扫码绑定
  evolclaw init wecom         企业微信 AI Bot 配置（手动输入）`);
      } else if (args[1] === 'wechat') {
        await cmdInitWechat();
      } else if (args[1] === 'feishu') {
        await cmdInitFeishu();
      } else if (args[1] === 'dingtalk') {
        await cmdInitDingtalk();
      } else if (args[1] === 'qqbot') {
        await cmdInitQQBot();
      } else if (args[1] === 'wecom') {
        await cmdInitWecom();
      } else if (args[1] && !args[1].startsWith('-')) {
        const supported = ['feishu', 'wechat', 'dingtalk', 'qqbot', 'wecom'];
        console.error(`❌ 不支持的渠道: ${args[1]}`);
        console.error(`   支持的渠道: ${supported.join(', ')}`);
        process.exit(1);
      } else {
        const nonInteractive = args.includes('--non-interactive');
        await cmdInit({
          nonInteractive,
          baseagent: getArgValue(args, '--baseagent'),
          force: args.includes('--force'),
        });
      }
      break;
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart({ clear: args.includes('--clear') });
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'logs':
      cmdLogs(args.slice(1));
      break;
    case 'watch':
      if (args[1] === 'aid') {
        await cmdWatchAid();
      } else if (args[1] === 'msg') {
        if (args[2] === '--help' || args[2] === '-h' || args[2] === 'help') {
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
          break;
        }
        const { cmdWatchMsg } = await import('./watch-msg.js');
        await cmdWatchMsg();
      } else if (args[1] === 'log') {
        cmdWatch();
      } else if (!args[1]) {
        await cmdWatchMenu();
      } else {
        cmdWatch();
      }
      break;
    case 'restart-monitor':
      await cmdRestartMonitor();
      break;
    case 'dev':
      await cmdDev(args.slice(1));
      break;
    case 'mv':
      await cmdMv(args[1], args[2]);
      break;
    case 'diagnose':
      await cmdDiagnose();
      break;
    case 'net': {
      const { cmdNet } = await import('./net-check.js');
      await cmdNet(args.slice(1));
      break;
    }
    case 'ctl':
      await cmdCtl(args.slice(1));
      break;
    case 'agent':
      await cmdAgent(args.slice(1));
      break;
    case 'aid': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdAid(args.slice(1));
      break;
    }
    case 'rpc': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdRpc(args.slice(1));
      break;
    }
    case 'storage': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdStorage(args.slice(1));
      break;
    }
    case 'msg': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdMsg(args.slice(1));
      break;
    }
    case 'group': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      await cmdGroup(args.slice(1));
      break;
    }
    case 'bench': {
      const { suppressSdkLogs } = await import('../aun/aid/index.js');
      suppressSdkLogs();
      const { cmdBench } = await import('./bench.js');
      await cmdBench(args.slice(1));
      break;
    }
    case 'link-rules': {
      const { cmdLinkRules } = await import('./link-rules.js');
      cmdLinkRules(args.slice(1));
      break;
    }
    default:
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs|watch|ctl|diagnose|net|mv}

Commands:
  init          初始化 evolclaw home (${resolvePaths().defaultsConfig})
  init feishu   飞书扫码登录并写入配置
  init wechat   微信扫码登录并写入配置
  init dingtalk 钉钉扫码登录并写入配置
  init qqbot    QQ 机器人扫码绑定并写入配置
  init wecom    企业微信 AI Bot 配置（手动输入 Bot ID + Secret）
  start         启动服务 (默认)
  stop          停止服务
  restart       重启服务
                  --clear  顺带 SIGKILL 跨 HOME 残留的 evolclaw 主进程
  status        查看状态
  logs          查看日志 (tail -f, 着色渲染)
                  --level error|warn   只显示指定级别及以上
                  --module <name>      只显示指定模块（如 feishu、AgentRunner）
                  --raw                原始输出，不着色
  watch         监控面板选择菜单（↑↓ 选择 log/aid/msg）
  watch log     监控 logs/ 下所有 .log 文件（汇总实时输出，启动时显示最近 20 条）
  watch aid     AID 连接状态实时监控（显示各 AID 在线/离线/重连状态）
  watch msg     消息监控（三面板交互式 TUI：AID 列表 / 对端统计 / 消息流）
  ctl           运行时自管理（模型切换、推理强度、压缩上下文等）
                  evolclaw ctl help 查看完整命令列表
  agent         管理 EvolAgent
                  agent              列出所有 agent
                  agent <name>       查看指定 agent 详情
                  agent new <name>   创建新 agent（交互式）
                  agent new <name> --non-interactive ...  非交互创建（自动化）
                    必填: --project <absolute path>
                    可选: --baseagent <claude|codex|gemini>  (默认: PATH 中第一个可用)
                          --owner <aid>
                          --name <display-name>
                          --description <text>
                          --force                            (覆盖已有 config.json)
                  agent sync-aids    从本地 AID 批量同步创建 agent（以最早 agent 为模板）
                  agent reload       全量 resync（扫磁盘，新增上线、删除下线、修改热更新）
                  agent reload <n>   热重载指定 agent 配置
  aid           AID 身份管理
                  aid list           列出本地所有 AID
                  aid show <aid>     查看本地 AID 详情（证书有效期、私钥状态）
                  aid new <aid>      创建新 AID 身份
                  aid delete <aid>   删除本地 AID
                  aid lookup <aid>   远程探测 AID（是否存在 + 网关 + agent.md）
                  aid agentmd put <aid>  签名并上传 agent.md
                  aid agentmd get <aid>  下载并验签 agent.md
  net           网络链路诊断
                  net check [<aid>]  10 步链路检测（DNS→Discovery→TCP→TLS→WSS→Auth→Ping→Echo）
                  net help           查看详细帮助
  rpc           AUN RPC 调用
                  rpc --as <aid> --params <json|jsonl|file>
  storage       文件存储
                  storage upload <aid> <file> <path> [--public]
                  storage download <aid> <url> [local-path]
                  storage ls <aid> [prefix]
                  storage rm <aid> <path>
                  storage quota <aid>
  diagnose      诊断启动环境（配置、数据库、进程）
  mv <old> <new>  迁移项目目录（保留 Claude/Codex/EvolClaw 会话）
  bench         AUN 消息性能基准测试
                  bench --aids 5 --rounds 10 --concurrency 5

Environment:
  EVOLCLAW_HOME   数据目录 (默认: ~/.evolclaw)
  LOG_LEVEL       日志级别 (默认: INFO)
  MESSAGE_LOG     消息日志 (默认: true)
  EVENT_LOG       事件日志 (默认: true)`);
      process.exit(1);
  }
}

// 直接运行时自动执行（node dist/cli/index.js ...）
if (platform.isMainScript(import.meta.url)) {
  main(process.argv.slice(2));
}
