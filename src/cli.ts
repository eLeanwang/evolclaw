import fs from 'fs';
import path from 'path';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';
import { cmdInit } from './utils/init.js';
import { cmdInitWechat } from './utils/init-wechat.js';
import { cmdInitFeishu } from './utils/init-feishu.js';
import * as platform from './utils/platform.js';

const execFileAsync = promisify(execFile);

// 清理 Claude Code 环境变量，防止 SDK 认为是嵌套会话
function cleanEnv() {
  for (const key of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CONFIG_DIR', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'
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
  const channels = countDir(path.join(srcDir, 'channels'), 'experimental');
  const utils = countDir(path.join(srcDir, 'utils'));
  const entry = countFile(path.join(srcDir, 'index.ts'))
    + countFile(path.join(srcDir, 'config.ts'))
    + countFile(path.join(srcDir, 'types.ts'))
    + countFile(path.join(srcDir, 'cli.ts'));
  const total = core + channels + utils + entry;

  console.log('==================================================');
  console.log('EvolClaw 代码统计');
  console.log('==================================================');
  console.log(`核心模块:         ${String(core).padStart(8)} 行`);
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
    fs.appendFileSync(statsFile, `${now}\t${core}\t${channels}\t${utils}\t${entry}\t${total}\n`);
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
  console.log(`${'时间'.padEnd(20)} ${'核心'.padStart(6)} ${'渠道'.padStart(6)} ${'工具'.padStart(6)} ${'入口'.padStart(6)} ${'总计'.padStart(6)} ${'变化'.padStart(8)}`);
  console.log('--------------------------------------------------');

  let prevTotal: number | null = null;
  for (const line of recent) {
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const [time, c, ch, u, e, t] = parts;
    const total = parseInt(t, 10);
    let diff = '-';
    if (prevTotal !== null) {
      const change = total - prevTotal;
      diff = change >= 0 ? `+${change}` : `${change}`;
    }
    console.log(`${time.padEnd(20)} ${c.padStart(6)} ${ch.padStart(6)} ${u.padStart(6)} ${e.padStart(6)} ${t.padStart(6)} ${diff.padStart(8)}`);
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

  // 检查 PID 文件
  const pid = isRunning(p.pid);
  if (pid) {
    console.log(`❌ EvolClaw is already running (PID: ${pid})`);
    console.log('  使用 evolclaw restart 重启，或 evolclaw stop 先停止');
    process.exit(1);
  }

  // 检查是否有残留进程（PID 文件已丢失但进程还在）
  let hasOrphan = false;
  const orphanPids = platform.findProcesses('node.*dist/index.js');
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
  const child = spawn('node', [appMain], {
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

  // 等待 ready signal（最多 15 秒）
  const startTime = Date.now();
  const checkReady = () => {
    // 进程已退出
    if (!isRunning(p.pid)) {
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

    // ready signal 出现
    if (fs.existsSync(p.readySignal)) {
      const pid = isRunning(p.pid);
      console.log(`✓ EvolClaw started successfully (PID: ${pid})`);
      console.log(`  EVOLCLAW_HOME: ${resolveRoot()}`);
      console.log(`  Logs: ${p.logs}/`);
      console.log('');
      // 代码统计仅在开发环境显示（EVOLCLAW_HOME 指向包目录）
      if (resolveRoot() === getPackageRoot()) {
        countLines(getPackageRoot(), p.logs);
      }
      return;
    }

    // 超时
    if (Date.now() - startTime > 15000) {
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
  } else {
    console.log('⚠ EvolClaw is not running');
    if (fs.existsSync(p.pid)) {
      console.log(`  Stale PID file found: ${p.pid}`);
    }
  }

  if (fs.existsSync(p.db)) {
    console.log('');
    console.log('📦 Sessions & Projects:');
    try {
      const Database = await import('node:sqlite');
      const db = new Database.DatabaseSync(p.db);
      const totalSessions = db.prepare('SELECT count(*) as cnt FROM sessions').get() as { cnt: number };
      const activeSessions = db.prepare('SELECT count(*) as cnt FROM sessions WHERE is_active=1').get() as { cnt: number };
      const uniqueChats = db.prepare('SELECT count(DISTINCT channel_id) as cnt FROM sessions').get() as { cnt: number };
      const projects = db.prepare('SELECT count(DISTINCT project_path) as cnt FROM sessions').get() as { cnt: number };
      db.close();

      console.log(`  Total sessions: ${totalSessions.cnt} (active: ${activeSessions.cnt})`);
      console.log(`  Unique chats: ${uniqueChats.cnt}`);
      console.log(`  Projects: ${projects.cnt}`);
    } catch {}
  }

  // Channel configuration status
  if (fs.existsSync(p.config)) {
    console.log('');
    console.log('🔌 Channels:');
    try {
      const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));
      if (config.channels?.feishu?.appId && config.channels?.feishu?.appSecret) {
        // Verify Feishu credentials connectivity
        try {
          const lark = await import('@larksuiteoapi/node-sdk');
          const client = new lark.Client({ appId: config.channels!.feishu!.appId, appSecret: config.channels!.feishu!.appSecret });
          const res = await client.auth.tenantAccessToken.internal({
            data: { app_id: config.channels!.feishu!.appId, app_secret: config.channels!.feishu!.appSecret },
          });
          if (res.code === 0) {
            console.log(`  Feishu: ✓ Connected (App ID: ${config.channels!.feishu!.appId.slice(0, 8)}...)`);
          } else {
            console.log(`  Feishu: ✗ Connection refused (${res.msg})`);
          }
        } catch (e: any) {
          const msg = e.message || '';
          if (msg.includes('ETIMEDOUT') || msg.includes('ENETUNREACH') || msg.includes('ENOTFOUND')) {
            console.log('  Feishu: ✗ Connection timeout (network unreachable)');
          } else {
            console.log(`  Feishu: ✗ Connection failed (${msg.slice(0, 80)})`);
          }
        }
      } else {
        console.log('  Feishu: - Not configured');
      }
      if (config.channels?.wechat?.token) {
        const tokenPreview = config.channels.wechat.token.slice(0, 20);
        // Validate token by calling getconfig API
        try {
          const baseUrl = (config.channels.wechat.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '');
          const body = JSON.stringify({ base_info: { channel_version: '1.0.0' } });
          const uint32 = (await import('node:crypto')).default.randomBytes(4).readUInt32BE(0);
          const wechatUin = Buffer.from(String(uint32), 'utf-8').toString('base64');
          const res = await fetch(`${baseUrl}/ilink/bot/getconfig`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'AuthorizationType': 'ilink_bot_token',
              'Authorization': `Bearer ${config.channels.wechat.token.trim()}`,
              'X-WECHAT-UIN': wechatUin,
            },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          const resp = JSON.parse(await res.text()) as { ret?: number; errcode?: number };
          const isExpired = resp.errcode === -14 || resp.ret === -14;
          if (isExpired) {
            console.log(`  WeChat: ✗ Token expired (Token: ${tokenPreview}...)`);
            console.log('          Run: evolclaw init wechat && evolclaw restart');
          } else {
            console.log(`  WeChat: ✓ Connected (Token: ${tokenPreview}...)`);
          }
        } catch (e: any) {
          const msg = e.message || '';
          if (msg.includes('ETIMEDOUT') || msg.includes('ENETUNREACH') || msg.includes('ENOTFOUND')) {
            console.log(`  WeChat: ✗ Connection timeout (Token: ${tokenPreview}...)`);
          } else {
            console.log(`  WeChat: ✓ Configured (Token: ${tokenPreview}...)`);
          }
        }
      } else {
        console.log('  WeChat: - Not configured');
      }
      // Check AUN with placeholder detection
      const aunDomain = config.channels?.aun?.domain;
      const aunAgent = config.channels?.aun?.agentName;
      const isAunPlaceholder = !aunDomain || !aunAgent ||
        aunDomain.includes('your-') || aunDomain.includes('placeholder') ||
        aunAgent.includes('your-') || aunAgent.includes('placeholder');
      if (aunDomain && aunAgent && !isAunPlaceholder) {
        console.log(`  AUN: ✓ Configured (${aunAgent}@${aunDomain})`);
      } else {
        console.log('  AUN: - Not configured');
      }
      if (config.agents?.anthropic?.model) {
        console.log(`  Model: ${config.agents.anthropic.model}`);
      }
      if (config.projects?.defaultPath) {
        console.log(`  Default project: ${config.projects.defaultPath}`);
      }
    } catch {}
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
  const READY_TIMEOUT = 15000; // 15s

  const log = (msg: string) => {
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}\n`;
    fs.appendFileSync(restartLog, line);
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
    await notifyChannel(p, pendingInfo, '✅ 服务重启成功！', log);
    cleanupPendingFile(pendingFile, log);
    process.exit(0);
  }

  // 启动失败，进入 self-heal 循环
  log('❌ Service failed to start, entering self-heal loop');
  await notifyChannel(p, pendingInfo, '⚠️ 服务启动失败，正在尝试自动修复...', log);

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    log(`Self-heal attempt ${attempt}/${MAX_HEAL_ATTEMPTS}`);
    await notifyChannel(p, pendingInfo, `🔧 自动修复中（第 ${attempt}/${MAX_HEAL_ATTEMPTS} 次）...`, log);

    // 调用 claude CLI 修复
    const healed = await invokeClaude(p, attempt, MAX_HEAL_ATTEMPTS, log);
    if (!healed) {
      log(`Self-heal attempt ${attempt} failed (claude invocation error)`);
      continue;
    }

    // 重新启动
    started = await spawnAndWaitReady(p, log, READY_TIMEOUT);
    if (started) {
      log(`✓ Self-heal succeeded on attempt ${attempt}`);
      archiveSelfHealLog(p, log);
      await notifyChannel(p, pendingInfo, `✅ 自愈成功！（第 ${attempt} 次修复后恢复）`, log);
      cleanupPendingFile(pendingFile, log);
      process.exit(0);
    }

    log(`Attempt ${attempt}: still failing after fix`);
  }

  // 全部失败
  log(`❌ All ${MAX_HEAL_ATTEMPTS} self-heal attempts failed`);
  await notifyChannel(p, pendingInfo, `❌ ${MAX_HEAL_ATTEMPTS} 次自动修复均失败，需要人工介入。\n修复记录：${p.selfHealLog}`, log);
  cleanupPendingFile(pendingFile, log);
  process.exit(1);
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
  const child = spawn('node', [appMain], {
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
  log: (msg: string) => void
): Promise<boolean> {
  const projectDir = getPackageRoot();
  const selfHealLog = p.selfHealLog;
  const stdoutLog = path.join(p.logs, 'stdout.log');

  const selfHealExists = fs.existsSync(selfHealLog) ? '存在，请先阅读之前的修复记录' : '不存在（首次修复）';

  const prompt = `EvolClaw 服务启动失败，需要你诊断并修复。这是第 ${attempt}/${maxAttempts} 次自动修复尝试。

关键信息：
- 项目目录：${projectDir}
- 错误日志：${stdoutLog}（请读取最后 50 行分析错误原因）
- 主日志：${path.join(p.logs, 'evolclaw.log')}（可能包含更多上下文）
- 修复记录：${selfHealLog}（${selfHealExists}）

请执行以下步骤：
1. 读取错误日志，分析启动失败的根本原因
2. 如果 ${selfHealLog} 存在，先阅读之前的修复记录，避免重复尝试已失败的方案
3. 修复代码问题
4. 执行 npm run build 确认编译通过
5. 将本次修复内容追加到 ${selfHealLog}，格式：
   ## 第 ${attempt} 次修复 - {时间}
   - 错误原因：...
   - 修复方案：...
   - 修改文件：...

注意：只修复导致启动失败的问题，不要做额外的重构或优化。`;

  try {
    log(`Invoking claude CLI (attempt ${attempt})...`);

    const { stdout, stderr } = await execFileAsync('claude', [
      '-p', prompt,
      '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep',
      '--output-format', 'text',
    ], {
      cwd: projectDir,
      timeout: 5 * 60 * 1000, // 5 分钟超时
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stdout) log(`Claude output: ${stdout.slice(0, 500)}`);
    if (stderr) log(`Claude stderr: ${stderr.slice(0, 200)}`);

    log(`Claude CLI completed (attempt ${attempt})`);
    return true;
  } catch (error: any) {
    log(`Claude CLI error: ${error.message?.slice(0, 300) || error}`);
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
 * 通过对应渠道 API 发送通知（轻量级，不依赖 Channel 实例）
 * 支持 feishu / wechat，根据 pendingInfo.channel 路由
 */
async function notifyChannel(
  p: ReturnType<typeof resolvePaths>,
  pendingInfo: { channel: string; channelId: string } | null,
  message: string,
  log: (msg: string) => void
) {
  if (!pendingInfo) return;

  const configPath = path.join(p.dataDir, 'evolclaw.json');
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (pendingInfo.channel === 'feishu') {
    try {
      if (!config.channels?.feishu?.appId || !config.channels?.feishu?.appSecret) return;

      const lark = await import('@larksuiteoapi/node-sdk');
      const client = new lark.Client({
        appId: config.channels!.feishu!.appId,
        appSecret: config.channels!.feishu!.appSecret,
      });

      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: pendingInfo.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message }),
        },
      });

      log(`Feishu notification sent: ${message.slice(0, 50)}`);
    } catch (error: any) {
      log(`Feishu notification failed: ${error.message?.slice(0, 200) || error}`);
    }
  } else if (pendingInfo.channel === 'wechat') {
    try {
      if (!config.channels?.wechat?.token) return;

      const crypto = await import('node:crypto');
      const baseUrl = (config.channels!.wechat!.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '');
      const token = config.channels!.wechat!.token;

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

// ==================== Main ====================

export async function main(args: string[]) {
  const cmd = args[0] || 'start';

  switch (cmd) {
    case 'init':
      if (args[1] === 'wechat') {
        await cmdInitWechat();
      } else if (args[1] === 'feishu') {
        await cmdInitFeishu();
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
    default:
      console.log(`Usage: evolclaw {init|start|stop|restart|status|logs}

Commands:
  init          创建配置文件 (${resolvePaths().config})
  init wechat   微信扫码登录并写入配置
  init feishu   飞书扫码登录并写入配置
  start         启动服务 (默认)
  stop          停止服务
  restart       重启服务
  status        查看状态
  logs          查看日志 (tail -f)

Environment:
  EVOLCLAW_HOME   数据目录 (默认: ~/.evolclaw)
  LOG_LEVEL       日志级别 (默认: INFO)
  MESSAGE_LOG     消息日志 (默认: true)
  EVENT_LOG       事件日志 (默认: true)`);
      process.exit(1);
  }
}

// 直接运行时自动执行（node dist/cli.js ...）
// 用 realpath 解析 symlink，否则 npm link 的 bin 路径与实际文件路径不匹配
const __selfUrl = import.meta.url;
const __argv1 = process.argv[1];
if (__argv1 && (
  __selfUrl === `file://${__argv1}` ||
  __selfUrl === `file://${fs.realpathSync(__argv1)}`
)) {
  main(process.argv.slice(2));
}
