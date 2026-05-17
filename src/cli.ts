import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';
import { loadDefaults, loadAllAgents, mergeForAgent } from './config-store.js';
import { resolveAnthropicConfig } from './baseagents/resolve.js';
import { normalizeChannelInstances, channelTypes } from './utils/channel-helpers.js';
import { migrateProject } from './utils/migrate-project.js';
import readline from 'readline';
import { cmdInit } from './utils/init.js';
import { ipcQuery } from './ipc.js';
import { cmdInitWechat, cmdInitFeishu, cmdInitAun, cmdInitDingtalk, cmdInitQQBot, cmdInitWecom, checkAunEnvironment } from './utils/init-channel.js';
import * as platform from './utils/cross-platform.js';
import { EventBus } from './core/event-bus.js';
import { tryUpgrade, type UpgradeResult } from './utils/upgrade.js';
import { scanInstances, cleanupInstances, readAidLastActivity, writeRestartMonitor, removeRestartMonitor, isRestartMonitorWinner } from './utils/instance-registry.js';

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

function rotateLogs(logDir: string) {
  if (!fs.existsSync(logDir)) return;
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const file of fs.readdirSync(logDir)) {
    const filePath = path.join(logDir, file);
    if (file.endsWith('.log')) {
      // 轮转超大日志
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_SIZE) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        const newPath = `${filePath}.${timestamp}`;
        fs.renameSync(filePath, newPath);
        console.log(`  Rotated: ${file} -> ${path.basename(newPath)}`);
      }
    } else if (file.includes('.log.') || /^aun-\d{8}\.log$/.test(file)) {
      // 清理 7 天前的旧日志（含按日轮转的 aun-YYYYMMDD.log）
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  }
}

function countLines(pkgRoot: string, logDir: string) {
  const srcDir = path.join(pkgRoot, 'src');
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
  const entry = countFile(path.join(srcDir, 'index.ts'))
    + countFile(path.join(srcDir, 'config.ts'))
    + countFile(path.join(srcDir, 'types.ts'))
    + countFile(path.join(srcDir, 'cli.ts'))
    + countFile(path.join(srcDir, 'ipc.ts'))
    + countFile(path.join(srcDir, 'paths.ts'));
  const total = core + agents + channels + utils + entry;

  console.log('==================================================');
  console.log('EvolClaw 代码统计');
  console.log('==================================================');
  console.log(`核心模块:         ${String(core).padStart(8)} 行`);
  console.log(`Agent 模块:       ${String(agents).padStart(8)} 行`);
  console.log(`渠道适配:         ${String(channels).padStart(8)} 行`);
  console.log(`工具库:           ${String(utils).padStart(8)} 行`);
  console.log(`入口与配置:       ${String(entry).padStart(8)} 行`);
  console.log('--------------------------------------------------');
  console.log(`总计:             ${String(total).padStart(8)} 行`);
  console.log('==================================================');

  // 追加历史记录（仅在数据变化时）
  let shouldAppend = true;
  if (fs.existsSync(statsFile)) {
    const lines = fs.readFileSync(statsFile, 'utf-8').trim().split('\n');
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const lastTotal = lastLine.split('\t').pop();
      if (lastTotal === String(total)) {
        shouldAppend = false;
      }
    }
  }
  if (shouldAppend) {
    const _d = new Date();
    const _p = (n: number) => String(n).padStart(2, '0');
    const now = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`;
    fs.appendFileSync(statsFile, `${now}\t${core}\t${agents}\t${channels}\t${utils}\t${entry}\t${total}\n`);
  }

  showHistory(statsFile);
}

function showHistory(statsFile: string) {
  if (!fs.existsSync(statsFile)) return;
  const lines = fs.readFileSync(statsFile, 'utf-8').trim().split('\n');
  if (lines.length < 2) return;

  const recent = lines.slice(-8);
  console.log('\n==================================================');
  console.log('历史记录（最近 8 次）');
  console.log('==================================================');
  console.log(`${'时间'.padEnd(20)} ${'核心'.padStart(6)} ${'Agent'.padStart(6)} ${'渠道'.padStart(6)} ${'工具'.padStart(6)} ${'入口'.padStart(6)} ${'总计'.padStart(6)} ${'变化'.padStart(8)}`);
  console.log('--------------------------------------------------');

  let prevTotal: number | null = null;
  for (const line of recent) {
    const parts = line.split('\t');
    // 兼容旧格式（6列: time,core,ch,utils,entry,total）和新格式（7列: +agents）
    let time: string, c: string, a: string, ch: string, u: string, e: string, t: string;
    if (parts.length >= 7) {
      [time, c, a, ch, u, e, t] = parts;
    } else if (parts.length >= 6) {
      [time, c, ch, u, e, t] = parts;
      a = '-';
    } else {
      continue;
    }
    const total = parseInt(t, 10);
    let diff = '-';
    if (prevTotal !== null) {
      const change = total - prevTotal;
      diff = change >= 0 ? `+${change}` : `${change}`;
    }
    console.log(`${time.padEnd(20)} ${c.padStart(6)} ${a.padStart(6)} ${ch.padStart(6)} ${u.padStart(6)} ${e.padStart(6)} ${t.padStart(6)} ${diff.padStart(8)}`);
    prevTotal = total;
  }
  console.log('==================================================');
}

// ==================== Commands ====================

async function cmdStart() {
  const p = resolvePaths();
  ensureDataDirs();

  // 旧配置自动迁移（evolclaw.json → 新结构）
  const { autoMigrateIfNeeded } = await import('./config-store.js');
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
    console.log(`  启动于: ${first.record.startedAtIso}`);
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

  console.log('🚀 Starting EvolClaw...');
  rotateLogs(p.logs);
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
      console.log(`✓ EvolClaw started successfully (PID: ${childPid})`);
      console.log(`  EVOLCLAW_HOME: ${resolveRoot()}`);
      console.log(`  Logs: ${p.logs}/`);

      // 从主日志提取渠道连接摘要
      const mainLog = path.join(p.logs, 'evolclaw.log');
      if (fs.existsSync(mainLog)) {
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

async function cmdRestart() {
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

  // 停止所有活 main 进程（可能不止一个）
  const status = scanInstances();
  const aliveMains = status.mains.filter(m => m.alive);
  if (aliveMains.length > 0) {
    if (aliveMains.length > 1) {
      console.log(`⚠ 检测到 ${aliveMains.length} 个 main 实例，将一并停止: ${aliveMains.map(m => m.record.pid).join(', ')}`);
    }
    await Promise.all(aliveMains.map(m => stopPid(m.record.pid)));
    await sleep(500);
    cleanupInstances();
  }

  setTimeout(() => cmdStart(), 1000);
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
  let w = 0;
  for (const ch of s) {
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
  // Column widths（视觉宽度）
  const COL_AGENT = 14;
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

  for (const a of aids) {
    const agent = (a.agentName || '?').slice(0, COL_AGENT - 1);
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
        const { scanChatDirs, scanMetaFiles, readJsonFile, readLastJsonlLine } = await import('./core/session/session-fs-store.js');
        type SF = import('./core/session/session-fs-store.js').SessionFile;

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
      const { scanChatDirs, scanMetaFiles, readJsonFile, readLastJsonlLine } = await import('./core/session/session-fs-store.js');
      type SF = import('./core/session/session-fs-store.js').SessionFile;

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
        console.log('🔌 Channels (live):');
        // Group channels by channelType
        const groups = new Map<string, Array<{ name: string; ch: any }>>();
        for (const [name, ch] of Object.entries(status.channels)) {
          const type = (ch as any).channelType || name;
          if (!groups.has(type)) groups.set(type, []);
          groups.get(type)!.push({ name, ch: ch as any });
        }
        for (const [type, instances] of groups) {
          if (type === 'aun') {
            // AUN channels 改为一行汇总，详情走 🔑 AUN AIDs 表格
            console.log(`  aun: ${instances.length} instance(s) — see AUN AIDs section below`);
            continue;
          }
          if (instances.length === 1) {
            // Single instance: show instance name directly
            const { name, ch } = instances[0];
            const label = ch.connected ? '✓ Connected' : '⏳ Reconnecting';
            const aidLabel = ch.aid ? ` (${ch.aid})` : '';
            console.log(`  ${name}${aidLabel}: ${label}`);
          } else {
            // Multi-instance: feishu [name1(aid) ✓, name2 ✗]
            const parts = instances.map(({ name, ch }) => {
              const icon = ch.connected ? '✓' : '⏳';
              const aidPart = ch.aid ? `(${ch.aid})` : '';
              return `${name}${aidPart} ${icon}`;
            });
            console.log(`  ${type}: [${parts.join(', ')}]`);
          }
        }

        // 🔑 AUN AIDs 表格（独立区段）
        try {
          const aidsResp = await ipcQuery<{ ok: boolean; aids: any[] }>(p.socket, { type: 'aun-aids' });
          if (aidsResp?.ok && aidsResp.aids?.length > 0) {
            console.log('');
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
            const channels = a.channels?.join(', ') || '—';
            console.log(`  ${statusIcon} ${a.name.padEnd(14)} ${a.status.padEnd(10)} ${channels}`);
          }
        }
      }
    } catch {
      // IPC query for agents failed — skip section
    }
  }
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

function cmdLogs(args: string[]) {
  const raw = args.includes('--raw');
  const noColor = args.includes('--no-color');
  const levelIdx = args.indexOf('--level');
  const moduleIdx = args.indexOf('--module');
  const level = levelIdx !== -1 ? args[levelIdx + 1] : undefined;
  const module = moduleIdx !== -1 ? args[moduleIdx + 1] : undefined;

  const p = resolvePaths();
  const mainLog = path.join(p.logs, 'evolclaw.log');
  if (!fs.existsSync(mainLog)) {
    console.log(`❌ Log file not found: ${mainLog}`);
    process.exit(1);
  }

  if (raw) {
    // Raw mode: plain tail -f, no rendering at all
    if (platform.isWindows) {
      const tail = platform.tailFile(mainLog);
      platform.onShutdown(() => tail.abort());
    } else {
      const child = spawn('tail', ['-f', '-n', '50', mainLog], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code || 0));
    }
    return;
  }

  // Rendered mode: always filter+truncate, color depends on TTY
  const useColor = !noColor && !!process.stdout.isTTY;
  const opts = { level, module, color: useColor };

  function processLine(line: string) {
    const rendered = renderLogLine(line, opts);
    if (rendered !== null) process.stdout.write(rendered + '\n');
  }

  if (platform.isWindows) {
    // Windows: read existing content + watch
    const existing = fs.readFileSync(mainLog, 'utf-8').split('\n').slice(-50);
    existing.forEach(processLine);
    let size = fs.statSync(mainLog).size;
    const watcher = fs.watch(mainLog, () => {
      const newSize = fs.statSync(mainLog).size;
      if (newSize <= size) return;
      const buf = Buffer.alloc(newSize - size);
      const fd = fs.openSync(mainLog, 'r');
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      size = newSize;
      buf.toString().split('\n').forEach(l => l && processLine(l));
    });
    platform.onShutdown(() => watcher.close());
  } else {
    // Unix: spawn tail -f, pipe through renderer
    const child = spawn('tail', ['-f', '-n', '50', mainLog]);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', processLine);
    child.on('exit', (code) => process.exit(code || 0));
    platform.onShutdown(() => { child.kill(); });
  }
}

// ==================== Watch ====================

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

function formatWatchContent(line: string): string {
  // JSON line: parse and format key fields
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const obj = JSON.parse(line);
      const dir = obj.dir || '';
      const event = obj.event || '';
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
      const dirArrow = dir === 'IN' ? '<-' : dir === 'OUT' ? '->' : '  ';
      return `${dirArrow} ${event} [${aid}] ${dataStr}`.trimEnd();
    } catch { /* fall through */ }
  }
  return stripTimestamp(line);
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
  const shortName = (f: string) => path.basename(f, '.log');

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
    console.log(`📦 Instance: PID ${m.pid} | 启动于 ${m.startedAtIso} (${uptime}) | via ${m.launchedBy}`);
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
  const { aidList, aidLookup } = await import('./aid/index.js');
  const localAids = aidList();
  const aidNameMap = new Map<string, string>();

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

  const COL_AID = 30;
  const COL_STATUS = 16;
  const COL_UPTIME = 10;
  const COL_RECV = 6;
  const COL_SENT = 6;
  const COL_BIN = 10;
  const COL_BOUT = 10;
  const COL_LRECV = 12;
  const COL_LSENT = 12;
  const COL_PEERS = 6;

  function formatDuration(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m${sec % 60}s`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}h${min % 60}m`;
    const day = Math.floor(hour / 24);
    return `${day}d${hour % 24}h`;
  }

  function renderHeader(): string {
    return '  ' +
      padRight('AID', COL_AID) +
      padRight('STATUS', COL_STATUS) +
      padRight('UPTIME', COL_UPTIME) +
      padRight('RECV', COL_RECV) +
      padRight('SENT', COL_SENT) +
      padRight('BYTES IN', COL_BIN) +
      padRight('BYTES OUT', COL_BOUT) +
      padRight('LAST RECV', COL_LRECV) +
      padRight('LAST SENT', COL_LSENT) +
      padRight('PEERS', COL_PEERS);
  }

  function renderRow(aid: any, stats: any): string[] {
    const aidLabel = aid.aid.length > COL_AID - 2 ? aid.aid.slice(0, COL_AID - 4) + '..' : aid.aid;
    const statusLabel = AID_STATUS_LABELS[aid.status] || aid.status;
    const now = Date.now();
    const lastRecv = stats?.lastReceivedAt ? formatTimeAgoShort(now - stats.lastReceivedAt) : '—';
    const lastSent = stats?.lastSentAt ? formatTimeAgoShort(now - stats.lastSentAt) : '—';
    const uptime = (aid.status === 'connected' && aid.lastConnectedAt)
      ? formatDuration(now - aid.lastConnectedAt)
      : '—';

    const mainLine = '  ' +
      padRight(aidLabel, COL_AID) +
      padRight(statusLabel, COL_STATUS) +
      padRight(uptime, COL_UPTIME) +
      padRight(String(stats?.messagesReceived ?? 0), COL_RECV) +
      padRight(String(stats?.messagesSent ?? 0), COL_SENT) +
      padRight(formatBytes(stats?.bytesReceived ?? 0), COL_BIN) +
      padRight(formatBytes(stats?.bytesSent ?? 0), COL_BOUT) +
      padRight(lastRecv, COL_LRECV) +
      padRight(lastSent, COL_LSENT) +
      padRight(String(stats?.uniquePeerCount ?? 0), COL_PEERS);

    const namePart = aidNameMap.get(aid.aid) || stats?.selfName || aid.agentName || '';
    const BLUE = useColor ? '\x1b[34m' : '';
    let msgPreview = '';
    if (stats?.lastReceivedAt || stats?.lastSentAt) {
      const recvTs = stats.lastReceivedAt ?? 0;
      const sentTs = stats.lastSentAt ?? 0;
      if (recvTs >= sentTs && stats.lastReceivedText) {
        msgPreview = `${GREEN}↓ ${stats.lastReceivedText.replace(/\n/g, ' ').slice(0, 60)}${RST}`;
      } else if (stats.lastSentText) {
        msgPreview = `${BLUE}↑ ${stats.lastSentText.replace(/\n/g, ' ').slice(0, 60)}${RST}`;
      } else if (stats.lastReceivedText) {
        msgPreview = `${GREEN}↓ ${stats.lastReceivedText.replace(/\n/g, ' ').slice(0, 60)}${RST}`;
      }
    }
    const subLine = `${DIM}    ${namePart}${RST}${msgPreview ? '  ' + msgPreview : ''}`;

    return [mainLine, subLine];
  }

  let lastLineCount = 0;

  async function render(): Promise<void> {
    const lines: string[] = [];

    // Query daemon — may be offline
    const [aidsResp, statsResp, statusResp] = await Promise.all([
      ipcQuery<{ ok: boolean; aids: any[] }>(p.socket, { type: 'aun-aids' }),
      ipcQuery<{ ok: boolean; stats: any[] }>(p.socket, { type: 'aun-aid-stats' }),
      ipcQuery<any>(p.socket, { type: 'status' }),
    ]);

    const daemonOnline = statusResp !== null;
    const aids = aidsResp?.aids ?? [];
    const stats = statsResp?.stats ?? [];
    const statsMap = new Map<string, any>();
    for (const s of stats) statsMap.set(s.aid, s);

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const statusIndicator = daemonOnline
      ? `${GREEN}● Running${RST}`
      : `${RED}● Offline${RST}`;

    lines.push(`${BOLD}${CYAN}📊 EvolClaw AID Monitor${RST}  ${statusIndicator}  ${DIM}${timeStr} | Refresh: 1s | ESC to exit${RST}`);
    lines.push('');

    if (!daemonOnline) {
      lines.push(`  ${RED}EvolClaw is not running.${RST} Waiting for daemon to start...`);
      lines.push('');
    } else if (aids.length === 0) {
      lines.push('  No active AIDs');
      lines.push('');
    } else {
      lines.push(`${DIM}${renderHeader()}${RST}`);
      const lineWidth = COL_AID + COL_STATUS + COL_UPTIME + COL_RECV + COL_SENT + COL_BIN + COL_BOUT + COL_LRECV + COL_LSENT + COL_PEERS;
      lines.push(`${DIM}  ${'─'.repeat(lineWidth)}${RST}`);
      for (const aid of aids) {
        const s = statsMap.get(aid.aid);
        lines.push(...renderRow(aid, s));
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
- 主日志：${path.join(p.logs, 'evolclaw.log')}（logger 输出在这里，包含 config 校验失败等关键错误）
- 修复记录：${selfHealLog}（${selfHealExists}）

⚠️ 重要诊断技巧：
- stdout.log 可能是空的（进程秒退时 logger 输出不会到 stdout），一定要同时读 evolclaw.log
- 必须实际运行进程来复现错误：\`EVOLCLAW_HOME=${p.root} node dist/index.js 2>&1\`，观察输出和退出码
- 检查是否有旧进程仍在运行：\`ps aux | grep 'node.*dist/index.js' | grep -v grep\`，旧进程可能占用端口或锁文件
- 可以运行 \`EVOLCLAW_HOME=${p.root} node dist/cli.js diagnose\` 快速检查配置和数据库
- 如果进程无任何输出就 exit(1)，说明是 process.exit(1) 被显式调用，搜索源码中所有 process.exit(1) 位置
- 配置文件使用双 rename 原子写（foo.json → foo.json_ → foo.json__），崩溃时可从 foo.json_ 恢复

请执行以下步骤：
1. 读取 ${stdoutLog} 和 ${path.join(p.logs, 'evolclaw.log')} 的最后 50 行
2. 运行 \`EVOLCLAW_HOME=${p.root} node dist/index.js 2>&1\` 复现错误（设置 10 秒超时）
3. 如果 ${selfHealLog} 存在，先阅读之前的修复记录，避免重复尝试已失败的方案
4. 根据实际复现的错误修复代码
5. 执行 npm run build 确认编译通过
6. 验证修复：启动服务确认 ready.signal 已写入，然后执行 \`EVOLCLAW_HOME=${p.root} node dist/cli.js stop\` 优雅停止（restart-monitor 会负责最终启动）
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
    const { SessionManager } = await import('./core/session/session-manager.js');
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
  chatmode [mode]           查看/切换会话模式
  activity [all|dm|owner|none]  查看/控制中间输出显示模式
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
  evolclaw ctl compact
  evolclaw ctl chatmode proactive`);
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

  if (!sub || sub === 'list') {
    await cmdAgentList();
    return;
  }

  if (sub === 'new') {
    const name = args[1];
    const nonInteractive = args.includes('--non-interactive');
    if (nonInteractive) {
      if (!name) {
        console.error('Usage: evolclaw agent new <name> --non-interactive ...');
        process.exit(1);
      }
      await cmdAgentNewNonInteractive(name, args.slice(2));
    } else {
      // Interactive mode: name from CLI is suggested default; user can override at prompt
      await cmdAgentNew(name);
    }
    return;
  }

  if (sub === 'sync-aids') {
    await cmdAgentSyncAids();
    return;
  }

  if (sub === 'reload') {
    const name = args[1];
    const p = resolvePaths();
    if (!name) {
      // 无参数：全量 resync（扫磁盘，新增上线、删除下线、修改热更新）
      try {
        const result = await ipcQuery(p.socket, { type: 'evolagent.resync' }) as any;
        if (result?.ok) {
          console.log('✓ Agent resync 完成:');
          for (const line of (result.results || [])) {
            console.log(`  ${line}`);
          }
        } else {
          console.error(`✗ Resync failed: ${result?.error || 'unknown error'}`);
          process.exit(1);
        }
      } catch {
        console.error('⚠ evolclaw 未运行，请先 evolclaw start');
        process.exit(1);
      }
      return;
    }
    // 带参数：单 agent 热更新
    try {
      const result = await ipcQuery(p.socket, { type: 'evolagent.reload', name }) as any;
      if (result && result.ok) {
        console.log(`✓ Agent "${name}" reloaded`);
      } else {
        console.error(`✗ Reload failed: ${result?.error || 'unknown error'}`);
        process.exit(1);
      }
    } catch {
      console.error('⚠ evolclaw 未运行，请先 evolclaw start 后再 reload');
      console.log('  或直接 evolclaw restart 重新加载所有 agent');
      process.exit(1);
    }
    return;
  }

  // `evolclaw agent <name>` — show detail
  await cmdAgentShow(sub);
}

/**
 * evolclaw agent sync-aids
 *
 * 扫描 ~/.aun/AIDs/ 下所有有私钥的 AID，对于没有对应 agent config 的 AID，
 * 克隆第一个 agent（按 config.json 的 mtime 找最早创建的）作为模板，只替换 aid 字段。
 */
async function cmdAgentSyncAids(): Promise<void> {
  const p = resolvePaths();
  const { aidList } = await import('./aid/index.js');
  const { ensureAgentDirSkeleton, saveAgent, loadAllAgents } = await import('./config-store.js');
  const { CONFIG_SCHEMA_VERSION } = await import('./types.js');

  // 1. 用 aidList() 获取所有有私钥的本地 AID
  const aunPath = process.env.AUN_HOME || path.join(os.homedir(), '.aun');
  const allAids = aidList(aunPath);
  const localAids = allAids.filter(a => a.hasPrivateKey).map(a => a.aid);

  if (localAids.length === 0) {
    console.log('⚠ 未找到任何有私钥的本地 AID');
    return;
  }

  console.log(`发现 ${localAids.length} 个本地 AID（有私钥）`);

  // 2. 找已有的 agent 列表
  const { agents } = loadAllAgents();
  const existingAids = new Set(agents.map(a => a.aid));

  // 3. 找模板 agent（按 config.json mtime 最早的）
  let templateAgent = agents[0];
  if (agents.length > 1) {
    let earliestMtime = Infinity;
    for (const a of agents) {
      const configPath = path.join(p.agentsDir, a.aid, 'config.json');
      try {
        const stat = fs.statSync(configPath);
        if (stat.mtimeMs < earliestMtime) {
          earliestMtime = stat.mtimeMs;
          templateAgent = a;
        }
      } catch {}
    }
  }

  if (!templateAgent) {
    console.log('❌ 没有可用的模板 agent。请先创建第一个 agent：evolclaw agent new <aid>');
    return;
  }

  console.log(`模板 agent: ${templateAgent.aid}`);

  // 4. 为缺失的 AID 克隆 agent config
  const created: string[] = [];
  for (const aid of localAids) {
    if (existingAids.has(aid)) continue;

    const newConfig = {
      ...JSON.parse(JSON.stringify(templateAgent)),
      aid,
      channels: [],
    };
    newConfig.$schema_version = CONFIG_SCHEMA_VERSION;

    try {
      saveAgent(newConfig);
      ensureAgentDirSkeleton(aid);
      console.log(`  ✓ ${aid}`);
      created.push(aid);
    } catch (e: any) {
      console.error(`  ✗ ${aid}: ${e?.message || e}`);
    }
  }

  if (created.length === 0) {
    console.log('所有本地 AID 都已有对应 agent，无需同步。');
    return;
  }

  console.log(`\n✓ 同步完成：新建 ${created.length} 个 agent`);

  // 5. 触发 resync（如果 evolclaw 正在运行）
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.resync' }) as any;
    if (result?.ok) {
      console.log('  ✓ 已热加载到运行中的进程');
      for (const line of (result.results || [])) {
        console.log(`    ${line}`);
      }
    } else {
      console.log(`  ⚠ 热加载失败: ${result?.error || 'unknown'}，重启后生效`);
    }
  } catch {
    console.log('  evolclaw 未运行，新 agent 将在下次启动时加载。');
  }
}

async function cmdAgentList(): Promise<void> {
  const p = resolvePaths();

  // Try IPC first (running process has real status)
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.list' }) as any;
    if (result && result.ok && result.agents) {
      printAgentTable(result.agents);
      return;
    }
  } catch {
    // IPC unavailable — fall through to cold mode
  }

  // Cold mode: read from disk
  const { EvolAgentRegistry } = await import('./core/evolagent-registry.js');
  const registry = new EvolAgentRegistry(p.agentsDir);
  registry.loadAll();
  printAgentTable(registry.list());
}

function printAgentTable(list: any[]): void {
  if (list.length === 0) {
    console.log('No agents configured.');
    return;
  }

  console.log(
    'NAME'.padEnd(14) + 'STATUS'.padEnd(10) + 'CHANNELS'.padEnd(24) +
    'PROJECT'.padEnd(22) + 'BASEAGENT'.padEnd(11) + 'LAST ACTIVE'
  );
  for (const info of list) {
    const name = info.name;
    const status = info.status || 'stopped';
    const channels = info.channels?.length > 0 ? info.channels.join(', ').slice(0, 22) : '—';
    const project = info.projectPath ? path.basename(info.projectPath) : '—';
    const baseagent = info.baseagent || '—';
    const lastActive = info.lastActivity
      ? formatTimeAgo(Date.now() - info.lastActivity)
      : '—';
    console.log(
      name.padEnd(14) +
      status.padEnd(10) +
      channels.padEnd(24) +
      project.padEnd(22) +
      baseagent.padEnd(11) +
      lastActive
    );
  }
}

async function cmdAgentShow(name: string): Promise<void> {
  const p = resolvePaths();

  // Try IPC first
  try {
    const result = await ipcQuery(p.socket, { type: 'evolagent.show', name }) as any;
    if (result && result.ok && result.agent) {
      const info = result.agent;
      console.log(`${info.name} (${info.status})\n`);
      console.log(`  Baseagent:  ${info.baseagent}`);
      if (info.model) console.log(`  Model:      ${info.model}`);
      if (info.effort) console.log(`  Effort:     ${info.effort}`);
      console.log(`  Project:    ${info.projectPath}`);
      console.log(`  Channels:   ${info.channels?.join(', ') || '—'}`);
      if (info.activeSessions) console.log(`  Sessions:   ${info.activeSessions} active`);
      if (info.lastActivity) console.log(`  Last active: ${formatTimeAgo(Date.now() - info.lastActivity)}`);
      if (info.error) console.log(`  Error:      ${info.error}`);
      return;
    }
  } catch {
    // IPC unavailable — fall through to cold mode
  }

  // Cold mode
  const { EvolAgentRegistry } = await import('./core/evolagent-registry.js');
  const registry = new EvolAgentRegistry(p.agentsDir);
  registry.loadAll();

  const agent = registry.get(name);
  if (!agent) {
    console.error(`Agent "${name}" not found.`);
    const allList = registry.list();
    if (allList.length > 0) {
      console.log(`Available: ${allList.map(i => i.name).join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`${agent.name} (${agent.status})\n`);
  console.log(`  Baseagent:  ${agent.baseagent}`);
  if (agent.model) console.log(`  Model:      ${agent.model}`);
  if (agent.effort) console.log(`  Effort:     ${agent.effort}`);
  console.log(`  Project:    ${agent.projectPath}`);
  console.log(`  Channels:   ${agent.channelInstanceNames().join(', ') || '—'}`);
  if (agent.error) console.log(`  Error:      ${agent.error}`);
}

async function cmdAgentNew(suggestedName: string): Promise<void> {
  const p = resolvePaths();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  try {
    // 1. AID（新结构下 agent 标识就是 AID）
    const aidPrompt = suggestedName
      ? `AID [${suggestedName}]: `
      : 'AID (e.g. mybot.agentid.pub): ';
    const aidInput = (await ask(aidPrompt)).trim();
    const aid = aidInput || suggestedName;
    if (!aid) {
      console.error('AID is required.');
      process.exit(1);
    }
    const { isValidAid, aidCreate } = await import('./aid/index.js');
    if (!isValidAid(aid)) {
      console.error(`Invalid AID "${aid}": must be a valid multi-level domain (e.g. mybot.agentid.pub)`);
      process.exit(1);
    }

    const agentDirPath = path.join(p.agentsDir, aid);
    if (fs.existsSync(path.join(agentDirPath, 'config.json'))) {
      console.error(`Agent "${aid}" already exists: ${agentDirPath}/config.json`);
      process.exit(1);
    }

    console.log(`\nCreating agent: ${aid}\n`);

    // 2. 在 AUN 网络注册 AID
    try {
      const result = await aidCreate(aid);
      try { await result.client.close(); } catch {}
      console.log(`  ✓ AID ${result.alreadyExisted ? 'reused' : 'created'}: ${aid}`);
    } catch (e: any) {
      console.error(`  ⚠ AID creation failed (can retry later): ${e?.message || e}`);
    }

    // 3. Project path
    let suggestedProjectPath = '';
    try {
      const defaults = loadDefaults();
      const defaultProjectsRoot = defaults?.projects?.defaultPath
        ? path.dirname(defaults.projects.defaultPath)
        : path.join(os.homedir(), 'evolclaw-projects');
      suggestedProjectPath = path.join(defaultProjectsRoot, aid.split('.')[0]);
    } catch {
      suggestedProjectPath = path.join(os.homedir(), 'evolclaw-projects', aid.split('.')[0]);
    }
    const projectInput = (await ask(`Project path [${suggestedProjectPath}]: `)).trim();
    const projectPath = projectInput || suggestedProjectPath;
    if (!path.isAbsolute(projectPath)) {
      console.error('Project path must be an absolute path.');
      process.exit(1);
    }
    if (!fs.existsSync(projectPath)) {
      const create = (await ask(`Project path does not exist. Create? [Y/n]: `)).trim().toLowerCase();
      if (create === '' || create === 'y' || create === 'yes') {
        fs.mkdirSync(projectPath, { recursive: true });
        console.log(`  ✓ Created ${projectPath}`);
      } else {
        console.error('Aborted.');
        process.exit(1);
      }
    }

    // 4. Baseagent
    const baseagentChoices = ['claude', 'codex', 'gemini', 'hermes'];
    const baseagent = (await ask(`Baseagent (${baseagentChoices.join('/')}) [claude]: `)).trim() || 'claude';
    if (!baseagentChoices.includes(baseagent)) {
      console.error(`Invalid baseagent: ${baseagent}`);
      process.exit(1);
    }

    // 5. Chatmode
    const chatmodePrivate = (await ask('Private chat mode (interactive/proactive) [interactive]: ')).trim() || 'interactive';
    const chatmodeGroup = (await ask('Group chat mode (interactive/proactive) [proactive]: ')).trim() || 'proactive';

    // 6. Owner
    const owner = (await ask('Owner AID (leave empty for auto-bind on first message): ')).trim() || undefined;

    rl.close();

    // 7. 写入新格式 AgentConfig
    const { ensureAgentDirSkeleton, saveAgent } = await import('./config-store.js');
    const { CONFIG_SCHEMA_VERSION } = await import('./types.js');

    const agentConfig = {
      $schema_version: CONFIG_SCHEMA_VERSION,
      aid,
      enabled: true,
      owners: owner ? [owner] : [],
      channels: [],
      active_baseagent: baseagent,
      baseagents: { [baseagent]: {} },
      projects: { defaultPath: projectPath },
      chatmode: { private: chatmodePrivate, group: chatmodeGroup },
    };

    saveAgent(agentConfig as any);
    ensureAgentDirSkeleton(aid);
    console.log(`\n✓ Created: ${agentDirPath}/config.json`);
    console.log('  Run `evolclaw restart` to activate.');
  } finally {
    try { rl.close(); } catch {}
  }
}

async function cmdAgentNewNonInteractive(aid: string, args: string[]): Promise<void> {
  const p = resolvePaths();

  const { isValidAid, aidCreate } = await import('./aid/index.js');
  if (!isValidAid(aid)) {
    console.error(`Invalid AID "${aid}": must be a valid multi-level domain (e.g. mybot.agentid.pub)`);
    process.exit(1);
  }

  const agentDirPath = path.join(p.agentsDir, aid);
  if (fs.existsSync(path.join(agentDirPath, 'config.json'))) {
    console.error(`Agent "${aid}" already exists: ${agentDirPath}/config.json`);
    process.exit(1);
  }

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  // Required: baseagent + project
  const baseagent = getArg('--baseagent');
  if (!baseagent) {
    console.error('--baseagent is required (claude|codex|gemini|hermes)');
    process.exit(1);
  }
  const baseagentChoices = ['claude', 'codex', 'gemini', 'hermes'];
  if (!baseagentChoices.includes(baseagent)) {
    console.error(`Invalid --baseagent: ${baseagent}`);
    process.exit(1);
  }

  const project = getArg('--project');
  if (!project) {
    console.error('--project is required (absolute path)');
    process.exit(1);
  }
  if (!path.isAbsolute(project)) {
    console.error(`--project must be absolute: ${project}`);
    process.exit(1);
  }
  if (!fs.existsSync(project)) {
    try {
      fs.mkdirSync(project, { recursive: true });
      console.log(`  ✓ Created ${project}`);
    } catch (e: any) {
      console.error(`Failed to create ${project}: ${e?.message || e}`);
      process.exit(1);
    }
  }

  // Optional
  const chatmodePrivate = getArg('--chatmode-private') || 'interactive';
  const chatmodeGroup = getArg('--chatmode-group') || 'proactive';
  const chatmodeValid = new Set(['interactive', 'proactive']);
  if (!chatmodeValid.has(chatmodePrivate)) {
    console.error(`Invalid --chatmode-private: ${chatmodePrivate}`);
    process.exit(1);
  }
  if (!chatmodeValid.has(chatmodeGroup)) {
    console.error(`Invalid --chatmode-group: ${chatmodeGroup}`);
    process.exit(1);
  }

  const owner = getArg('--owner');
  if (owner && !isValidAid(owner)) {
    console.error(`Invalid --owner: ${owner}`);
    process.exit(1);
  }

  // Register AID on AUN network
  try {
    const result = await aidCreate(aid);
    try { await result.client.close(); } catch {}
    console.log(`✓ AID ${result.alreadyExisted ? 'reused' : 'created'}: ${aid}`);
  } catch (e: any) {
    console.error(`  ⚠ AID creation failed (can retry later): ${e?.message || e}`);
  }

  // Build channels[] list (AUN is implicit, only extra channels go here)
  const channels: any[] = [];

  const feishuAppId = getArg('--feishu-app-id');
  const feishuAppSecret = getArg('--feishu-app-secret');
  if (feishuAppId || feishuAppSecret) {
    if (!feishuAppId || !feishuAppSecret) {
      console.error('--feishu-app-id and --feishu-app-secret must both be provided');
      process.exit(1);
    }
    channels.push({ type: 'feishu', name: 'main', enabled: true, appId: feishuAppId, appSecret: feishuAppSecret });
  }

  const dingtalkClientId = getArg('--dingtalk-client-id');
  const dingtalkClientSecret = getArg('--dingtalk-client-secret');
  if (dingtalkClientId || dingtalkClientSecret) {
    if (!dingtalkClientId || !dingtalkClientSecret) {
      console.error('--dingtalk-client-id and --dingtalk-client-secret must both be provided');
      process.exit(1);
    }
    channels.push({ type: 'dingtalk', name: 'main', enabled: true, clientId: dingtalkClientId, clientSecret: dingtalkClientSecret });
  }

  // Write new format
  const { ensureAgentDirSkeleton, saveAgent } = await import('./config-store.js');
  const { CONFIG_SCHEMA_VERSION } = await import('./types.js');

  const agentConfig = {
    $schema_version: CONFIG_SCHEMA_VERSION,
    aid,
    enabled: true,
    owners: owner ? [owner] : [],
    channels,
    active_baseagent: baseagent,
    baseagents: { [baseagent]: {} },
    projects: { defaultPath: project },
    chatmode: { private: chatmodePrivate, group: chatmodeGroup },
  };

  saveAgent(agentConfig as any);
  ensureAgentDirSkeleton(aid);
  console.log(`✓ Created: ${agentDirPath}/config.json`);
  console.log('  Run `evolclaw restart` to activate.');
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

  if (sub === 'help') {
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

  const { aidList, aidCreate, aidShow, aidDelete, aidLookup, agentmdPut, agentmdGet, buildInitialAgentMd, isValidAid } = await import('./aid/index.js');

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
    console.log('  如需上线 AUN 通道，运行 evolclaw init aun');
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

  const { isValidAid } = await import('./aid/index.js');
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

  const { rpcCall, rpcBatch } = await import('./aun-rpc/index.js');

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

  const { isValidAid } = await import('./aid/index.js');
  if (!isValidAid(aid)) {
    console.error(`❌ 无效 AID 格式: ${aid}`);
    process.exit(1);
  }

  const { storageUpload, storageDownload, storageLs, storageRm, storageQuota } = await import('./storage/index.js');

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

// ==================== Main ====================

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
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

交互式初始化:
  evolclaw init               创建基础配置文件（交互式）
  evolclaw init feishu        飞书扫码登录并写入配置
  evolclaw init wechat        微信扫码登录并写入配置
  evolclaw init dingtalk      钉钉扫码登录并写入配置
  evolclaw init qqbot         QQ 机器人扫码绑定并写入配置
  evolclaw init wecom         企业微信 AI Bot 配置（手动输入）
  evolclaw init aun           AUN 交互式配置（AID 创建 + Owner 绑定）

非交互式初始化:
  evolclaw init --non-interactive [选项]

  选项:
    --default-path <path>     项目目录（默认: 当前目录）
    --channel <name>          渠道类型（默认: aun）
    --aun-aid <aid>           AUN Agent ID（必填，如 mybot.agentid.pub）
    --aun-owner <aid>         Owner AID（可选，如 alice.agentid.pub）

  示例:
    evolclaw init --non-interactive --aun-aid mybot.agentid.pub --aun-owner alice.agentid.pub
    evolclaw init --non-interactive --default-path /home/user/project --aun-aid bot.agentid.pub`);
      } else if (args[1] === 'wechat') {
        await cmdInitWechat();
      } else if (args[1] === 'feishu') {
        await cmdInitFeishu();
      } else if (args[1] === 'aun') {
        await cmdInitAun();
      } else if (args[1] === 'dingtalk') {
        await cmdInitDingtalk();
      } else if (args[1] === 'qqbot') {
        await cmdInitQQBot();
      } else if (args[1] === 'wecom') {
        await cmdInitWecom();
      } else if (args[1] && !args[1].startsWith('-')) {
        const supported = ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot', 'wecom'];
        console.error(`❌ 不支持的渠道: ${args[1]}`);
        console.error(`   支持的渠道: ${supported.join(', ')}`);
        process.exit(1);
      } else {
        const nonInteractive = args.includes('--non-interactive');
        if (nonInteractive) {
          await cmdInit({
            nonInteractive: true,
            defaultPath: getArgValue(args, '--default-path') || path.join(os.homedir(), 'projects', 'default'),
            channel: getArgValue(args, '--channel') || 'aun',
            aunAid: getArgValue(args, '--aun-aid'),
            aunOwner: getArgValue(args, '--aun-owner'),
          });
        } else {
          await cmdInit();
        }
      }
      break;
    case 'start':
      await cmdStart();
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart();
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
      } else {
        cmdWatch();
      }
      break;
    case 'restart-monitor':
      await cmdRestartMonitor();
      break;
    case 'mv':
      await cmdMv(args[1], args[2]);
      break;
    case 'diagnose':
      await cmdDiagnose();
      break;
    case 'ctl':
      await cmdCtl(args.slice(1));
      break;
    case 'agent':
      await cmdAgent(args.slice(1));
      break;
    case 'aid': {
      const { suppressSdkLogs } = await import('./aid/index.js');
      suppressSdkLogs();
      await cmdAid(args.slice(1));
      break;
    }
    case 'rpc': {
      const { suppressSdkLogs } = await import('./aid/index.js');
      suppressSdkLogs();
      await cmdRpc(args.slice(1));
      break;
    }
    case 'storage': {
      const { suppressSdkLogs } = await import('./aid/index.js');
      suppressSdkLogs();
      await cmdStorage(args.slice(1));
      break;
    }
    default:
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs|watch|ctl|diagnose|mv}

Commands:
  init          初始化 evolclaw home (${resolvePaths().defaultsConfig})
  init feishu   飞书扫码登录并写入配置
  init wechat   微信扫码登录并写入配置
  init dingtalk 钉钉扫码登录并写入配置
  init qqbot    QQ 机器人扫码绑定并写入配置
  init wecom    企业微信 AI Bot 配置（手动输入 Bot ID + Secret）
  init aun      AUN (AgentUnin.Network) 配置
  start         启动服务 (默认)
  stop          停止服务
  restart       重启服务
  status        查看状态
  logs          查看日志 (tail -f, 着色渲染)
                  --level error|warn   只显示指定级别及以上
                  --module <name>      只显示指定模块（如 feishu、AgentRunner）
                  --raw                原始输出，不着色
  watch         监控 logs/ 下所有 .log 文件（汇总实时输出，启动时显示最近 20 条）
  ctl           运行时自管理（模型切换、推理强度、压缩上下文等）
                  evolclaw ctl help 查看完整命令列表
  agent         管理 EvolAgent
                  agent              列出所有 agent
                  agent <name>       查看指定 agent 详情
                  agent new <name>   创建新 agent（交互式）
                  agent new <name> --non-interactive ...  非交互创建（自动化）
                    必填: --baseagent <claude|codex|gemini|hermes>
                          --project <absolute path>
                    可选 channel:
                          --aun-aid <aid> --aun-owner <aid>
                          --feishu-app-id xxx --feishu-app-secret yyy
                          --wechat-token xxx
                          --wecom-bot-id xxx --wecom-secret yyy
                          --dingtalk-client-id xxx --dingtalk-client-secret yyy
                          --qqbot-app-id xxx --qqbot-client-secret yyy
                    可选行为:
                          --chatmode-private <interactive|proactive> (默认 interactive)
                          --chatmode-group <interactive|proactive>   (默认 proactive)
                  agent reload <n>   热重载 agent 配置
  aid             AID 身份管理
                  aid list           列出本地所有 AID
                  aid new <aid>      创建新 AID 身份
  agentmd         agent.md 管理
                  agentmd <aid>      查看 agent.md
                  agentmd put <aid>  上传本地 agent.md
                  agentmd set <aid> <内容>  设置并上传
  diagnose      诊断启动环境（配置、数据库、进程）
  mv <old> <new>  迁移项目目录（保留 Claude/Codex/EvolClaw 会话）

Environment:
  EVOLCLAW_HOME   数据目录 (默认: ~/.evolclaw)
  LOG_LEVEL       日志级别 (默认: INFO)
  MESSAGE_LOG     消息日志 (默认: true)
  EVENT_LOG       事件日志 (默认: true)`);
      process.exit(1);
  }
}

// 直接运行时自动执行（node dist/cli.js ...）
if (platform.isMainScript(import.meta.url)) {
  main(process.argv.slice(2));
}
