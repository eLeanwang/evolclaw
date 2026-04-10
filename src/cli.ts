import fs from 'fs';
import path from 'path';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';
import { loadConfig, validateConfigIntegrity, resolveAnthropicConfig } from './config.js';
import { migrateProject } from './utils/migrate-project.js';
import readline from 'readline';
import { cmdInit, cmdInitAun, checkAunEnvironment } from './utils/init.js';
import { ipcQuery } from './utils/ipc-client.js';
import { cmdInitWechat } from './utils/init-wechat.js';
import { cmdInitFeishu } from './utils/init-feishu.js';
import * as platform from './utils/cross-platform.js';
import { EventBus } from './core/event-bus.js';

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
    } else if (file.includes('.log.')) {
      // 清理 7 天前的旧日志
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
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
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
  let hasOrphan = false;
  const evolclawMain = path.join(getPackageRoot(), 'dist', 'index.js');
  const orphanPids = platform.findProcesses(evolclawMain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
  // Feishu
  if (config.channels?.feishu?.appId) {
    console.log(`  feishu: Configured (App ID: ${config.channels.feishu.appId.slice(0, 8)}...)`);
  } else {
    console.log('  feishu: - Not configured');
  }
  // WeChat
  if (config.channels?.wechat?.token) {
    console.log(`  wechat: Configured (Token: ${config.channels.wechat.token.slice(0, 20)}...)`);
  } else {
    console.log('  wechat: - Not configured');
  }
  // AUN
  const aunAid = config.channels?.aun?.aid;
  if (aunAid && !aunAid.includes('your-') && !aunAid.includes('placeholder')) {
    console.log(`  aun: Configured (${aunAid})`);
  } else {
    console.log('  aun: - Not configured');
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
      if (info.memory) console.log(`  Memory: ${info.memory} KB`);
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
        for (const [name, ch] of Object.entries(status.channels)) {
          const label = ch.connected
            ? '✓ Connected'
            : ch.reconnectAttempt
              ? `⏳ Reconnecting (${ch.reconnectAttempt}/${ch.maxAttempts})`
              : '✗ Disconnected';
          console.log(`  ${name}: ${label}`);
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

  console.log('');
  console.log('📁 Log Files:');
  const mainLog = path.join(p.logs, 'evolclaw.log');
  if (fs.existsSync(mainLog)) {
    const stat = fs.statSync(mainLog);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`  Main log: ${mainLog} (${sizeMB} MB)`);
    console.log('');
    console.log('📝 Recent activity (last 10 lines):');
    const content = fs.readFileSync(mainLog, 'utf-8').trim().split('\n');
    console.log(content.slice(-10).map(l => `  ${l}`).join('\n'));
  } else {
    console.log('  (no log file yet)');
  }
}

function cmdLogs() {
  const p = resolvePaths();
  const mainLog = path.join(p.logs, 'evolclaw.log');
  if (!fs.existsSync(mainLog)) {
    console.log(`❌ Log file not found: ${mainLog}`);
    process.exit(1);
  }

  if (platform.isWindows) {
    // Windows: use fs.watch for live tail
    const tail = platform.tailFile(mainLog);
    platform.onShutdown(() => tail.abort());
  } else {
    // Unix: use tail -f
    const child = spawn('tail', ['-f', mainLog], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
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
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}\n`;
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

  // 启动并检测 ready signal
  let started = await spawnAndWaitReady(p, log, READY_TIMEOUT);

  if (started) {
    log('✓ Service restarted successfully');
    archiveSelfHealLog(p, log);
    // 通知由新进程自行发送（channel-agnostic），此处不再调用 notifyChannel
    process.exit(0);
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
  // 杀掉可能残留的进程
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
  for (const type of ['feishu', 'wechat', 'aun']) {
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
    const { SessionManager } = await import('./core/session-manager.js');
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

async function cmdTui() {
  const config = loadConfig();
  // Find the first AUN instance (TUI connects to one AUN instance)
  const aunResolved = resolveInstanceConfig(config as any, 'aun');
  const aun = aunResolved?.type === 'aun' ? aunResolved.config : null;
  if (!aun?.owner || !aun?.aid) {
    console.error('[tui] AUN 未配置，请先运行: evolclaw init aun');
    process.exit(1);
  }

  // TUI requires Python + aun_core (independent of init aun which is now pure TS)
  const pythonCheck = aun.pythonBin || process.env.AUN_PYTHON || 'python3';
  if (!platform.commandExists(pythonCheck)) {
    console.error(`[tui] Python 未找到 (${pythonCheck})`);
    console.error('  → TUI 依赖 Python 和 aun-core: pip3 install aun-core');
    process.exit(1);
  }

  const pythonBin = aun.pythonBin || process.env.AUN_PYTHON || 'python3';
  const cliScript = path.join(getPackageRoot(), 'aun', 'aun_cli.py');
  if (!fs.existsSync(cliScript)) {
    console.error(`[tui] aun_cli.py 不存在: ${cliScript}`);
    console.error('  → TUI 需要 AUN CLI 工具，请确认源码目录包含 aun/aun_cli.py');
    console.error('  → 安装: pip3 install aun-core && 从源码仓库获取 aun_cli.py');
    process.exit(1);
  }
  const child = spawn(pythonBin, [cliScript, '-a', aun.owner, '-t', aun.aid], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ==================== Main ====================

export async function main(args: string[]) {
  const cmd = args[0] || 'start';

  switch (cmd) {
    case 'init':
      if (args[1] === 'wechat') {
        await cmdInitWechat();
      } else if (args[1] === 'feishu') {
        await cmdInitFeishu();
      } else if (args[1] === 'aun') {
        await cmdInitAun();
      } else {
        await cmdInit();
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
      cmdLogs();
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
    case 'tui':
      await cmdTui();
      break;
    default:
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs|tui|diagnose|mv}

Commands:
  init          创建配置文件 (${resolvePaths().config})
  init feishu   飞书扫码登录并写入配置
  init wechat   微信扫码登录并写入配置
  init aun      AUN (AgentUnin.Network) 配置
  start         启动服务 (默认)
  stop          停止服务
  restart       重启服务
  status        查看状态
  logs          查看日志 (tail -f)
  tui           启动 AUN TUI 客户端
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
