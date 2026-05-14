import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';
import { loadConfig, validateConfigIntegrity, resolveAnthropicConfig, normalizeChannelInstances, channelTypes } from './config.js';
import { migrateProject } from './utils/migrate-project.js';
import readline from 'readline';
import { cmdInit } from './utils/init.js';
import { ipcQuery } from './ipc.js';
import { cmdInitWechat, cmdInitFeishu, cmdInitAun, cmdInitDingtalk, cmdInitQQBot, cmdInitWecom, checkAunEnvironment } from './utils/init-channel.js';
import * as platform from './utils/cross-platform.js';
import { EventBus } from './core/event-bus.js';
import { tryUpgrade, type UpgradeResult } from './utils/upgrade.js';

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

function isRunning(pidFile: string): number | null {
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  if (platform.isProcessRunning(pid)) {
    return pid;
  }
  fs.unlinkSync(pidFile);
  return null;
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

  const countDir = (dir: string, exclude?: string): number => {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (exclude && entry.name === exclude) continue;
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
  const channels = countDir(path.join(srcDir, 'channels'), 'experimental');
  const utils = countDir(path.join(srcDir, 'utils'));
  const entry = countFile(path.join(srcDir, 'index.ts'))
    + countFile(path.join(srcDir, 'config.ts'))
    + countFile(path.join(srcDir, 'types.ts'))
    + countFile(path.join(srcDir, 'cli.ts'));
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

  // 检查配置文件
  if (!fs.existsSync(p.config)) {
    console.log('❌ 配置文件不存在，请先运行 evolclaw init');
    process.exit(1);
  }

  // 配置完整性校验
  try {
    const config = loadConfig(p.config);
    const integrity = validateConfigIntegrity(config);
    if (!integrity.valid) {
      console.log(`❌ 配置文件完整性校验失败:`);
      for (const reason of integrity.reasons) {
        console.log(`  - ${reason}`);
      }
      console.log(`\n配置文件: ${p.config}`);
      process.exit(1);
    }
  } catch (e: any) {
    console.log(`❌ 配置文件加载失败: ${e.message}`);
    process.exit(1);
  }

  // 检查 PID 文件
  const pid = isRunning(p.pid);
  if (pid) {
    console.log(`❌ EvolClaw is already running (PID: ${pid})`);
    console.log('  使用 evolclaw restart 重启，或 evolclaw stop 先停止');
    process.exit(1);
  }

  // 检查是否有残留进程（PID 文件已丢失但进程还在）
  // 只清理属于当前 EVOLCLAW_HOME 的进程，避免误杀其他实例
  let hasOrphan = false;
  const evolclawMain = path.join(getPackageRoot(), 'dist', 'index.js');
  const allPids = platform.findProcesses(evolclawMain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const orphanPids = allPids.filter(pid => platform.getProcessEnv(pid, 'EVOLCLAW_HOME') === p.root);
  if (orphanPids.length > 0) {
    console.log(`⚠ 发现 ${orphanPids.length} 个残留进程，正在清理...`);
    for (const p of orphanPids) {
      platform.killProcess(p);
    }
    hasOrphan = true;
  }

  // 如果清理了残留进程，等待它们退出
  if (hasOrphan) {
    await sleep(2000);
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
    env: {
      ...process.env,
      EVOLCLAW_HOME: p.root,
      LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
      MESSAGE_LOG: process.env.MESSAGE_LOG || 'true',
      EVENT_LOG: process.env.EVENT_LOG || 'true',
    }
  });

  fs.writeFileSync(p.pid, String(child.pid));
  child.unref();

  // 等待 ready signal（最多 30 秒，AUN sidecar 超时 15s + 其他通道连接）
  const startTime = Date.now();
  const checkReady = () => {
    // ready signal 出现（优先检查，避免 Windows 上 isRunning 误判）
    if (fs.existsSync(p.readySignal)) {
      const pid = isRunning(p.pid);
      console.log(`✓ EvolClaw started successfully (PID: ${pid})`);
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
    if (!isRunning(p.pid)) {
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

/**
 * 停止进程并等待退出，返回 Promise
 */
async function stopAndWait(pidFile: string): Promise<void> {
  const pid = isRunning(pidFile);
  if (!pid) return;

  console.log(`🛑 Stopping EvolClaw (PID: ${pid})...`);
  platform.killProcess(pid);

  await new Promise<void>((resolve) => {
    let waited = 0;
    const check = setInterval(() => {
      waited++;
      if (!platform.isProcessRunning(pid)) {
        clearInterval(check);
        try { fs.unlinkSync(pidFile); } catch {}
        console.log('✓ EvolClaw stopped');
        resolve();
        return;
      }
      if (waited >= 10) {
        clearInterval(check);
        platform.killProcess(pid, true);
        try { fs.unlinkSync(pidFile); } catch {}
        console.log('✓ EvolClaw stopped (forced)');
        resolve();
      }
    }, 1000);
  });
}

async function cmdStop() {
  const p = resolvePaths();
  const pid = isRunning(p.pid);
  if (!pid) {
    console.log('⚠ EvolClaw is not running');
    return;
  }
  await stopAndWait(p.pid);
}

async function cmdRestart() {
  console.log('🔄 Restarting EvolClaw...');
  const p = resolvePaths();

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

  await stopAndWait(p.pid);
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
  const pid = isRunning(p.pid);

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

    // Runtime statistics (only when running)
    if (fs.existsSync(p.db)) {
      try {
        const Database = await import('node:sqlite');
        const db = new Database.DatabaseSync(p.db);

        // Get recent active sessions (last 5)
        const recentSessions = db.prepare(`
          SELECT id, project_path, name, channel, chat_type, thread_id, agent_session_id, agent_id, metadata, updated_at
          FROM sessions
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT 5
        `).all() as Array<{ id: string; project_path: string; name: string | null; channel: string; chat_type: string; thread_id: string; agent_session_id: string | null; agent_id: string | null; metadata: string | null; updated_at: number }>;

        // Detect orphan sessions (channel no longer in config)
        let orphanCount = 0;
        try {
          const config = loadConfig(p.config);
          const configChannelNames = new Set<string>();
          for (const type of channelTypes) {
            const raw = (config.channels as any)?.[type];
            const instances = normalizeChannelInstances(raw, type);
            for (const inst of instances) {
              configChannelNames.add(inst.name);
            }
          }

          const channelCounts = db.prepare(`
            SELECT channel, COUNT(*) as c FROM sessions
            WHERE deleted_at IS NULL
            GROUP BY channel
          `).all() as Array<{ channel: string; c: number }>;

          for (const row of channelCounts) {
            if (!configChannelNames.has(row.channel)) {
              orphanCount += row.c;
            }
          }
        } catch {}

        db.close();

        if (recentSessions.length > 0) {
          console.log('');
          console.log('📋 Recent Active Sessions:');
          for (const s of recentSessions) {
            const projectName = path.basename(s.project_path);
            const sessionType = s.thread_id ? '话题会话' : '主会话';
            const chatType = s.chat_type === 'group' ? '群聊' : '单聊';
            const sessionName = s.name || '默认会话';
            const timeAgo = formatTimeAgo(Date.now() - s.updated_at);
            const meta = s.metadata ? JSON.parse(s.metadata) : {};
            const dot = meta.isActive ? '•' : '○';
            const agentId = s.agent_session_id ? ` [${s.agent_session_id}]` : '';
            const agentType = s.agent_id || 'claude';
            console.log(`  ${dot} [${agentType}] ${projectName} / ${sessionName} (${sessionType}, ${chatType})${agentId} - ${timeAgo}`);
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
    if (fs.existsSync(p.pid)) {
      console.log(`  Stale PID file found: ${p.pid}`);
    }
  }

  // Session & Project statistics (always show if DB exists)
  if (fs.existsSync(p.db)) {
    console.log('');
    console.log('📦 Sessions & Projects:');
    try {
      const Database = await import('node:sqlite');
      const db = new Database.DatabaseSync(p.db);
      const totalSessions = db.prepare('SELECT count(*) as cnt FROM sessions WHERE deleted_at IS NULL').get() as { cnt: number };
      const activeSessions = db.prepare("SELECT count(*) as cnt FROM sessions WHERE json_extract(metadata, '$.isActive') = true AND deleted_at IS NULL").get() as { cnt: number };
      const uniqueChats = db.prepare('SELECT count(DISTINCT channel_id) as cnt FROM sessions WHERE deleted_at IS NULL').get() as { cnt: number };
      const projects = db.prepare('SELECT count(DISTINCT project_path) as cnt FROM sessions WHERE deleted_at IS NULL').get() as { cnt: number };
      db.close();

      console.log(`  Total sessions: ${totalSessions.cnt} (active: ${activeSessions.cnt})`);
      console.log(`  Unique chats: ${uniqueChats.cnt}`);
      console.log(`  Projects: ${projects.cnt}`);
    } catch {}
  }

  // Channel status
  if (fs.existsSync(p.config)) {
    console.log('');
    const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

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
          if (instances.length === 1) {
            // Single instance: show instance name directly
            const { name, ch } = instances[0];
            const label = ch.connected ? '✓ Connected' : ch.reconnectAttempt ? `⏳ Reconnecting (${ch.reconnectAttempt}/${ch.maxAttempts})` : '✗ Disconnected';
            console.log(`  ${name}: ${label}`);
          } else {
            // Multi-instance: feishu [name1 ✓, name2 ✗]
            const parts = instances.map(({ name, ch }) => {
              const icon = ch.connected ? '✓' : ch.reconnectAttempt ? '⏳' : '✗';
              return `${name} ${icon}`;
            });
            console.log(`  ${type}: [${parts.join(', ')}]`);
          }
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
        const agents = agentResult.agents.filter((a: any) => !a.isDefault);
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

/**
 * restart-monitor: 内部命令，由 /restart 命令调用
 * 支持 self-heal：启动失败时调用 claude CLI 自动修复，最多重试 3 次
 */
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

  /** 检查服务是否已经在运行（ready signal 存在 + 进程存活） */
  const isServiceAlive = (): boolean => {
    return fs.existsSync(p.readySignal) && isRunning(p.pid) !== null;
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

  // 等待旧进程退出
  if (fs.existsSync(p.pid)) {
    const oldPid = parseInt(fs.readFileSync(p.pid, 'utf-8').trim(), 10);
    log(`Monitoring process PID: ${oldPid}`);

    await new Promise<void>((resolve) => {
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
          log('ERROR: Process still running after 30s, force killing');
          platform.killProcess(oldPid, true);
          resolve();
        }
      }, 1000);
    });

    await sleep(3000);
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
  // 杀掉可能残留的进程（先读 PID 再删文件，避免数据库锁）
  try {
    const stalePid = parseInt(fs.readFileSync(p.pid, 'utf-8').trim(), 10);
    if (!isNaN(stalePid)) platform.killProcess(stalePid, true);
  } catch {}
  try { fs.unlinkSync(p.pid); } catch {}

  cleanEnv();

  const stdoutLog = path.join(p.logs, 'stdout.log');
  const out = fs.openSync(stdoutLog, 'a');
  const err = fs.openSync(stdoutLog, 'a');

  const appMain = path.join(getPackageRoot(), 'dist', 'index.js');
  const child = spawn('node', ['--no-warnings=ExperimentalWarning', appMain], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      EVOLCLAW_HOME: p.root,
      LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
      MESSAGE_LOG: process.env.MESSAGE_LOG || 'true',
      EVENT_LOG: process.env.EVENT_LOG || 'true',
    }
  });

  fs.writeFileSync(p.pid, String(child.pid));
  child.unref();

  log(`Spawned new process PID: ${child.pid}, waiting for ready signal...`);

  // 轮询等待 ready.signal 出现
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(500);

    // 进程已退出则提前失败
    if (!isRunning(p.pid)) {
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
  const pid = isRunning(p.pid);
  if (pid) {
    platform.killProcess(pid);
    try { fs.unlinkSync(p.pid); } catch {}
  }
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
- evolclaw.json 有自动备份机制：运行时 config watch 检测到文件损坏会自动保存内存快照到 \`data/evolclaw-{timestamp}.json\`，同时 \`data/evolclaw.backup.json\` 是最近一次完整配置的备份。如果 evolclaw.json 损坏或缺失，可以从这些备份恢复

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
function resolveInstanceConfig(config: any, instanceName: string): { type: string; config: any } | null {
  for (const type of ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot', 'wecom']) {
    const raw = config.channels?.[type];
    if (!raw) continue;
    if (Array.isArray(raw)) {
      const inst = raw.find((i: any) => i.name === instanceName);
      if (inst) return { type, config: inst };
    } else {
      const name = raw.name || type;
      if (name === instanceName) return { type, config: raw };
    }
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

  const configPath = path.join(p.dataDir, 'evolclaw.json');
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const resolved = resolveInstanceConfig(config, pendingInfo.channel);
  if (!resolved) {
    log(`Channel instance "${pendingInfo.channel}" not found in config`);
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
    if (r.evolclawDbUpdated > 0) console.log(`✓ EvolClaw sessions.db 已更新 (${r.evolclawDbUpdated} 个会话)`);
    if (r.evolclawConfigUpdated) console.log('✓ evolclaw.json projects.list 已更新');

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
    const config = loadConfig();
    console.log(`[diagnose] ✓ 配置文件加载成功: ${p.config}`);

    const integrity = validateConfigIntegrity(config);
    if (!integrity.valid) {
      console.error(`[diagnose] ❌ 配置完整性校验失败:\n  ${integrity.reasons.join('\n  ')}`);
      hasError = true;
    } else {
      console.log(`[diagnose] ✓ 配置完整性校验通过`);
    }

    // 3. 检查 Anthropic 配置
    try {
      const anthropic = resolveAnthropicConfig(config);
      console.log(`[diagnose] ✓ Anthropic 配置解析成功 (apiKey: ${anthropic.apiKey ? '已设置' : '❌ 未设置'}, model: ${anthropic.model || 'default'})`);
    } catch (e) {
      console.error(`[diagnose] ❌ Anthropic 配置解析失败: ${e instanceof Error ? e.message : e}`);
      hasError = true;
    }
  } catch (e) {
    console.error(`[diagnose] ❌ 配置文件加载失败: ${e instanceof Error ? e.message : e}`);
    hasError = true;
  }

  // 4. 检查数据库
  try {
    const { SessionManager } = await import('./core/session/session-manager.js');
    const eventBus = new EventBus();
    new SessionManager(p.db, eventBus);
    console.log(`[diagnose] ✓ 数据库初始化成功: ${p.db}`);
  } catch (e) {
    console.error(`[diagnose] ❌ 数据库初始化失败: ${e instanceof Error ? e.message : e}`);
    hasError = true;
  }

  // 5. 检查残留进程
  try {
    const pid = isRunning(p.pid);
    if (pid) {
      console.log(`[diagnose] ⚠️ 已有进程运行中: PID ${pid}`);
    } else {
      console.log(`[diagnose] ✓ 无残留进程`);
    }
  } catch {
    console.log(`[diagnose] ✓ 无 PID 文件`);
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

  if (!sub) {
    await cmdAgentList();
    return;
  }

  if (sub === 'new') {
    const name = args[1];
    if (!name) {
      console.error('Usage: evolclaw agent new <name> [--non-interactive ...]');
      process.exit(1);
    }
    const nonInteractive = args.includes('--non-interactive');
    if (nonInteractive) {
      await cmdAgentNewNonInteractive(name, args.slice(2));
    } else {
      await cmdAgentNew(name);
    }
    return;
  }

  if (sub === 'reload') {
    const name = args[1];
    if (!name) {
      console.error('Usage: evolclaw agent reload <name>');
      process.exit(1);
    }
    const p = resolvePaths();
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
  const { AgentRegistry } = await import('./core/agent-registry.js');
  const { loadConfig } = await import('./config.js');

  let config: any;
  try {
    config = loadConfig(p.config);
  } catch {
    config = { agents: {}, channels: {}, projects: { defaultPath: process.cwd() } };
  }

  const registry = new AgentRegistry(p.agentsDir);
  registry.loadAll(config);
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
    const name = info.isDefault ? '[default]' : info.name;
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
  const { AgentRegistry } = await import('./core/agent-registry.js');
  const { loadConfig } = await import('./config.js');

  let config: any;
  try {
    config = loadConfig(p.config);
  } catch {
    config = { agents: {}, channels: {}, projects: { defaultPath: process.cwd() } };
  }

  const registry = new AgentRegistry(p.agentsDir);
  registry.loadAll(config);

  const agent = registry.get(name);
  if (!agent) {
    console.error(`Agent "${name}" not found.`);
    const allList = registry.list().filter(i => !i.isDefault);
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
  if (agent.configPath) console.log(`  Config:     ${agent.configPath}`);
}

async function cmdAgentNew(name: string): Promise<void> {
  const p = resolvePaths();
  const agentPath = path.join(p.agentsDir, `${name}.json`);

  if (fs.existsSync(agentPath)) {
    console.error(`Agent "${name}" already exists: ${agentPath}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  try {
    console.log(`\nCreating agent: ${name}\n`);

    const projectPath = (await ask('Project path: ')).trim();
    if (!projectPath || !path.isAbsolute(projectPath)) {
      console.error('Project path must be an absolute path.');
      process.exit(1);
    }
    if (!fs.existsSync(projectPath)) {
      const create = (await ask(`Project path does not exist. Create ${projectPath}? [Y/n]: `)).trim().toLowerCase();
      if (create === '' || create === 'y' || create === 'yes') {
        try {
          fs.mkdirSync(projectPath, { recursive: true });
          console.log(`  ✓ Created ${projectPath}`);
        } catch (e: any) {
          console.error(`Failed to create ${projectPath}: ${e?.message || e}`);
          process.exit(1);
        }
      } else {
        console.error('Aborted: project path does not exist.');
        process.exit(1);
      }
    }

    const baseagentChoices = ['claude', 'codex', 'gemini', 'hermes'];
    const baseagent = (await ask(`Baseagent (${baseagentChoices.join('/')}) [claude]: `)).trim() || 'claude';
    if (!baseagentChoices.includes(baseagent)) {
      console.error(`Invalid baseagent: ${baseagent}`);
      process.exit(1);
    }

    const model = (await ask('Model (leave empty for default): ')).trim() || undefined;
    const effort = (await ask('Effort (low/medium/high/max) [high]: ')).trim() || 'high';

    const chatmodeChoices = ['interactive', 'proactive'];
    const chatmodePrivate = (await ask(`ChatMode private (${chatmodeChoices.join('/')}) [interactive]: `)).trim() || 'interactive';

    // Channels (loop to allow multiple)
    const channelsConfig: Record<string, any[]> = {};
    const { getChannelCredentialCollector } = await import('./utils/init-channel.js');

    // Close outer rl before channel loop (collectors create their own readline)
    rl.close();

    while (true) {
      const loopRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const loopAsk = (q: string): Promise<string> => new Promise(r => loopRl.question(q, r));

      const addChannel = (await loopAsk('\nAdd channel? (y/n) [n]: ')).trim().toLowerCase();
      if (addChannel !== 'y') {
        loopRl.close();
        break;
      }

      const channelType = (await loopAsk('Channel type (feishu/aun/wechat/wecom/dingtalk/qqbot): ')).trim();
      const collector = getChannelCredentialCollector(channelType);
      if (!collector) {
        console.error(`Unknown channel type: ${channelType}`);
        loopRl.close();
        continue;
      }

      // Close loop rl before collector opens its own
      loopRl.close();

      let creds: any = null;
      try {
        creds = await collector();
      } catch (e: any) {
        console.error(`  Channel setup failed: ${e?.message || e}`);
      }
      if (!creds) {
        console.log('  Channel setup cancelled.');
        continue;
      }

      const nameRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const defaultEffName = `${name}-${channelType}`;
      const instName = await new Promise<string>(r => nameRl.question(`  Channel instance name (leave empty for ${defaultEffName}): `, r));
      nameRl.close();

      const trimmedName = instName.trim();
      if (trimmedName) creds.name = trimmedName;
      // else: omit name; effective channel name will be ${agent.name}-${type} via EvolAgent.effectiveChannelName
      if (!channelsConfig[channelType]) channelsConfig[channelType] = [];
      channelsConfig[channelType].push(creds);
    }

    // Simplify channels: if only one instance per type, unwrap from array
    const finalChannels: Record<string, any> = {};
    for (const [type, instances] of Object.entries(channelsConfig)) {
      finalChannels[type] = instances.length === 1 ? instances[0] : instances;
    }

    const agentConfig = {
      name,
      enabled: true,
      agents: { [baseagent]: { ...(model && { model }), effort } },
      channels: finalChannels,
      projects: { defaultPath: projectPath.trim() },
      chatmode: { private: chatmodePrivate, group: 'proactive' },
    };

    fs.mkdirSync(p.agentsDir, { recursive: true });
    fs.writeFileSync(agentPath, JSON.stringify(agentConfig, null, 2));
    console.log(`\n✓ Created: ${agentPath}`);
    console.log('  Run `evolclaw restart` to activate.');
  } finally {
    // rl may already be closed if channel collector was invoked
    try { rl.close(); } catch {}
  }
}

async function cmdAgentNewNonInteractive(name: string, args: string[]): Promise<void> {
  const p = resolvePaths();
  const agentPath = path.join(p.agentsDir, `${name}.json`);

  if (fs.existsSync(agentPath)) {
    console.error(`Agent "${name}" already exists: ${agentPath}`);
    process.exit(1);
  }

  // Helper: extract --flag value from args
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

  // Optional: chatmode
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

  // Channels
  const channelsConfig: Record<string, any> = {};

  // AUN
  const aunAid = getArg('--aun-aid');
  const aunOwner = getArg('--aun-owner');
  if (aunAid || aunOwner) {
    if (!aunAid || !aunOwner) {
      console.error('--aun-aid and --aun-owner must both be provided');
      process.exit(1);
    }
    const { isValidAid, aidCreate } = await import('./channels/aun-ops.js');
    if (!isValidAid(aunAid)) {
      console.error(`Invalid --aun-aid: ${aunAid}`);
      process.exit(1);
    }
    if (!isValidAid(aunOwner)) {
      console.error(`Invalid --aun-owner: ${aunOwner}`);
      process.exit(1);
    }
    try {
      const result = await aidCreate(aunAid);
      try { await result.client.close(); } catch { /* ignore */ }
      console.log(`✓ AID ${result.alreadyExisted ? 'reused' : 'created'}: ${aunAid}`);
    } catch (e: any) {
      console.error(`AID creation failed: ${e?.message || e}`);
      process.exit(1);
    }
    channelsConfig.aun = { enabled: true, aid: aunAid, owner: aunOwner };
  }

  // Feishu
  const feishuAppId = getArg('--feishu-app-id');
  const feishuAppSecret = getArg('--feishu-app-secret');
  if (feishuAppId || feishuAppSecret) {
    if (!feishuAppId || !feishuAppSecret) {
      console.error('--feishu-app-id and --feishu-app-secret must both be provided');
      process.exit(1);
    }
    channelsConfig.feishu = [{
      name: `feishu-${name}`,
      enabled: true,
      appId: feishuAppId,
      appSecret: feishuAppSecret,
    }];
  }

  // WeChat
  const wechatToken = getArg('--wechat-token');
  if (wechatToken) {
    channelsConfig.wechat = { enabled: true, token: wechatToken };
  }

  // WeCom
  const wecomBotId = getArg('--wecom-bot-id');
  const wecomSecret = getArg('--wecom-secret');
  if (wecomBotId || wecomSecret) {
    if (!wecomBotId || !wecomSecret) {
      console.error('--wecom-bot-id and --wecom-secret must both be provided');
      process.exit(1);
    }
    channelsConfig.wecom = { enabled: true, botId: wecomBotId, secret: wecomSecret };
  }

  // DingTalk
  const dingtalkClientId = getArg('--dingtalk-client-id');
  const dingtalkClientSecret = getArg('--dingtalk-client-secret');
  if (dingtalkClientId || dingtalkClientSecret) {
    if (!dingtalkClientId || !dingtalkClientSecret) {
      console.error('--dingtalk-client-id and --dingtalk-client-secret must both be provided');
      process.exit(1);
    }
    channelsConfig.dingtalk = { enabled: true, clientId: dingtalkClientId, clientSecret: dingtalkClientSecret };
  }

  // QQBot
  const qqbotAppId = getArg('--qqbot-app-id');
  const qqbotClientSecret = getArg('--qqbot-client-secret');
  if (qqbotAppId || qqbotClientSecret) {
    if (!qqbotAppId || !qqbotClientSecret) {
      console.error('--qqbot-app-id and --qqbot-client-secret must both be provided');
      process.exit(1);
    }
    channelsConfig.qqbot = { enabled: true, appId: qqbotAppId, clientSecret: qqbotClientSecret };
  }

  if (Object.keys(channelsConfig).length === 0) {
    console.error('At least one channel must be configured (aun / feishu / wechat / wecom / dingtalk / qqbot)');
    process.exit(1);
  }

  const agentConfig = {
    name,
    enabled: true,
    agents: { [baseagent]: {} },
    channels: channelsConfig,
    projects: { defaultPath: project },
    chatmode: { private: chatmodePrivate, group: chatmodeGroup },
  };

  fs.mkdirSync(p.agentsDir, { recursive: true });
  fs.writeFileSync(agentPath, JSON.stringify(agentConfig, null, 2));
  console.log(`✓ Created: ${agentPath}`);
  console.log('  Run `evolclaw restart` (or `evolclaw agent reload <name>`) to activate.');
}

// ==================== AID ====================

async function cmdAid(args: string[]): Promise<void> {
  const sub = args[0] || 'list';

  if (sub === 'help') {
    console.log(`用法: evolclaw aid <command>

Commands:
  list              列出本地所有 AID
  new <aid>         创建新 AID 身份

示例:
  evolclaw aid list
  evolclaw aid new reviewer.agentid.pub`);
    return;
  }

  const { aidList, aidCreate, agentmdPut, buildInitialAgentMd, isValidAid } = await import('./channels/aun-ops.js');

  if (sub === 'list') {
    const aids = aidList();
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

    const result = await aidCreate(aid);

    if (!result.alreadyExisted) {
      const content = buildInitialAgentMd({ aid });
      try {
        await agentmdPut(content, { aid, client: result.client });
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

  console.error(`未知子命令: ${sub}\n用法: evolclaw aid [list|new <aid>]`);
  process.exit(1);
}

// ==================== AgentMd ====================

async function cmdAgentmd(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === 'help') {
    console.log(`用法: evolclaw agentmd <command> <aid>

Commands:
  <aid>                 查看指定 AID 的 agent.md
  put <aid>             上传本地 agent.md 到 AUN 网络
  set <aid> <内容>      设置并上传 agent.md

示例:
  evolclaw agentmd mybot.agentid.pub
  evolclaw agentmd put mybot.agentid.pub
  evolclaw agentmd set mybot.agentid.pub "---\\naid: mybot.agentid.pub\\n---"`);
    return;
  }

  const { agentmdGet, agentmdPut, isValidAid } = await import('./channels/aun-ops.js');

  if (args[0] === 'put') {
    const aid = args[1];
    if (!aid) {
      console.error('用法: evolclaw agentmd put <aid>');
      process.exit(1);
    }
    if (!isValidAid(aid)) {
      console.error(`❌ 无效 AID 格式: ${aid}`);
      process.exit(1);
    }
    // Read local file directly (put = push local → network)
    const localPath = path.join(os.homedir(), '.aun', 'AIDs', aid, 'agent.md');
    if (!fs.existsSync(localPath)) {
      console.error(`❌ 本地无 agent.md: ${aid}`);
      process.exit(1);
    }
    const content = fs.readFileSync(localPath, 'utf-8');
    await agentmdPut(content, { aid });
    console.log('✓ agent.md 已发布');
    return;
  }

  if (args[0] === 'set') {
    const aid = args[1];
    const content = args.slice(2).join(' ');
    if (!aid || !content) {
      console.error('用法: evolclaw agentmd set <aid> <内容>');
      process.exit(1);
    }
    if (!isValidAid(aid)) {
      console.error(`❌ 无效 AID 格式: ${aid}`);
      process.exit(1);
    }
    await agentmdPut(content, { aid });
    console.log('✓ agent.md 已更新并发布');
    return;
  }

  // Default: view
  const aid = args[0];
  if (!isValidAid(aid)) {
    console.error(`❌ 无效 AID 格式: ${aid}`);
    process.exit(1);
  }
  try {
    const md = await agentmdGet(aid);
    if (!md || !md.trim()) {
      console.log(`ℹ️ ${aid} 尚未设置 agent.md`);
    } else {
      console.log(md);
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
    case 'aid':
      await cmdAid(args.slice(1));
      break;
    case 'agentmd':
      await cmdAgentmd(args.slice(1));
      break;
    default:
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs|ctl|diagnose|mv}

Commands:
  init          创建配置文件 (${resolvePaths().config})
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
