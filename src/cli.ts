import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createRequire } from 'module';
import { spawn, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';

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
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.unlinkSync(pidFile);
    return null;
  }
}

function killAllInstances() {
  try {
    const output = execFileSync('pgrep', ['-f', 'node.*dist/index.js'], { encoding: 'utf-8' }).trim();
    if (output) {
      const pids = output.split('\n');
      console.log(`  Found ${pids.length} running instance(s), stopping them...`);
      for (const pid of pids) {
        try { process.kill(parseInt(pid, 10)); } catch {}
      }
    }
  } catch {}
}

function rotateLogs(logDir: string) {
  if (!fs.existsSync(logDir)) return;
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  for (const file of fs.readdirSync(logDir)) {
    if (!file.endsWith('.log')) continue;
    const filePath = path.join(logDir, file);
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const newPath = `${filePath}.${timestamp}`;
      fs.renameSync(filePath, newPath);
      console.log(`  Rotated: ${file} -> ${path.basename(newPath)}`);
    }
  }
  // 清理 7 天前的旧日志
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(logDir)) {
    if (!file.includes('.log.')) continue;
    const filePath = path.join(logDir, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
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

function checkEnvironment() {
  console.log('🔍 环境检查...\n');
  let allGood = true;

  // Node.js >= 22
  const nodeVer = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeVer >= 22) {
    console.log(`  ✓ Node.js v${process.versions.node}`);
  } else {
    console.log(`  ⚠ Node.js v${process.versions.node} — 需要 >= 22（node:sqlite 依赖）`);
    allGood = false;
  }

  // claude CLI
  try {
    execFileSync('which', ['claude'], { encoding: 'utf-8' });
    console.log('  ✓ claude CLI 已安装');
  } catch {
    console.log('  ⚠ claude CLI 未找到 — 请先安装 Claude Code');
    allGood = false;
  }

  // @anthropic-ai/claude-agent-sdk >= 0.2.75
  try {
    const esmRequire = createRequire(import.meta.url);
    const sdkPkgPath = esmRequire.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf-8'));
    const sdkVer = sdkPkg.version as string;
    const parts = sdkVer.split('.').map(Number);
    const sdkOk = parts[0] > 0 || parts[1] > 2 || (parts[1] === 2 && parts[2] >= 75);
    if (sdkOk) {
      console.log(`  ✓ claude-agent-sdk v${sdkVer}`);
    } else {
      console.log(`  ⚠ claude-agent-sdk v${sdkVer} — 需要 >= 0.2.75（forkSession 支持）`);
      allGood = false;
    }
  } catch {
    console.log('  ⚠ claude-agent-sdk 未安装');
    allGood = false;
  }

  console.log('');
  if (!allGood) {
    console.log('  部分检查未通过，可继续初始化，但运行时可能出错\n');
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function setupEnvVar(home: string): void {
  const exportLine = `export EVOLCLAW_HOME="${home}"`;

  // Detect shell profile
  const shell = process.env.SHELL || '/bin/bash';
  let profilePath: string;
  if (shell.endsWith('zsh')) {
    profilePath = path.join(os.homedir(), '.zshrc');
  } else {
    profilePath = path.join(os.homedir(), '.bashrc');
  }

  // Check if already set
  if (fs.existsSync(profilePath)) {
    const content = fs.readFileSync(profilePath, 'utf-8');
    if (content.includes('EVOLCLAW_HOME')) {
      console.log(`  ✓ EVOLCLAW_HOME 已在 ${profilePath} 中配置`);
      return;
    }
  }

  fs.appendFileSync(profilePath, `\n# EvolClaw\n${exportLine}\n`);
  console.log(`  ✓ 已写入 ${profilePath}: ${exportLine}`);
  console.log(`  ⚠ 请执行 source ${profilePath} 或重新打开终端使其生效`);
}

async function cmdInit() {
  const p = resolvePaths();
  ensureDataDirs();

  if (fs.existsSync(p.config)) {
    console.log(`配置文件已存在: ${p.config}`);
    return;
  }

  const sampleSrc = path.join(getPackageRoot(), 'data', 'evolclaw.sample.json');
  if (!fs.existsSync(sampleSrc)) {
    console.log(`❌ 找不到示例配置: ${sampleSrc}`);
    return;
  }

  checkEnvironment();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('📝 交互式配置\n');

    // feishu.appId
    let appId = '';
    while (!appId) {
      appId = (await ask(rl, '  飞书 App ID: ')).trim();
      if (!appId) console.log('  ⚠ 不能为空');
    }

    // feishu.appSecret
    let appSecret = '';
    while (!appSecret) {
      appSecret = (await ask(rl, '  飞书 App Secret: ')).trim();
      if (!appSecret) console.log('  ⚠ 不能为空');
    }

    // projects.defaultPath
    let defaultPath = '';
    while (!defaultPath) {
      defaultPath = (await ask(rl, '  默认项目路径: ')).trim();
      if (!defaultPath) {
        console.log('  ⚠ 不能为空');
      } else if (!fs.existsSync(defaultPath)) {
        console.log(`  ⚠ 路径不存在: ${defaultPath}`);
        defaultPath = '';
      }
    }

    // anthropic.model
    const modelInput = (await ask(rl, '  模型 [sonnet(默认)/opus/haiku]: ')).trim().toLowerCase();
    const model = ['opus', 'haiku'].includes(modelInput) ? modelInput : 'sonnet';

    // Generate config
    const config = JSON.parse(fs.readFileSync(sampleSrc, 'utf-8'));
    config.feishu.appId = appId;
    config.feishu.appSecret = appSecret;
    config.projects.defaultPath = defaultPath;
    config.anthropic.model = model;

    fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');
    console.log(`\n✓ 已创建配置文件: ${p.config}`);

    // Setup EVOLCLAW_HOME in shell profile
    setupEnvVar(resolveRoot());
  } finally {
    rl.close();
  }
}

function cmdStart() {
  const p = resolvePaths();
  ensureDataDirs();

  // 检查 PID 文件
  const pid = isRunning(p.pid);
  if (pid) {
    console.log(`❌ EvolClaw is already running (PID: ${pid})`);
    console.log('  使用 evolclaw restart 重启，或 evolclaw stop 先停止');
    process.exit(1);
  }

  // 检查是否有残留进程（PID 文件已丢失但进程还在）
  let hasOrphan = false;
  try {
    const output = execFileSync('pgrep', ['-f', 'node.*dist/index.js'], { encoding: 'utf-8' }).trim();
    if (output) {
      const pids = output.split('\n');
      console.log(`⚠ 发现 ${pids.length} 个残留进程，正在清理...`);
      for (const p of pids) {
        try { process.kill(parseInt(p, 10)); } catch {}
      }
      hasOrphan = true;
    }
  } catch {}

  // 如果清理了残留进程，等待它们退出
  if (hasOrphan) {
    execFileSync('sleep', ['2']);
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
      countLines(getPackageRoot(), p.logs);
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

function cmdStop() {
  const p = resolvePaths();
  const pid = isRunning(p.pid);
  if (!pid) {
    console.log('⚠ EvolClaw is not running');
    return;
  }

  console.log(`🛑 Stopping EvolClaw (PID: ${pid})...`);
  process.kill(pid);

  let waited = 0;
  const check = setInterval(() => {
    waited++;
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(check);
      try { fs.unlinkSync(p.pid); } catch {}
      console.log('✓ EvolClaw stopped');
      return;
    }
    if (waited >= 10) {
      clearInterval(check);
      try { process.kill(pid, 9); } catch {}
      try { fs.unlinkSync(p.pid); } catch {}
      console.log('✓ EvolClaw stopped (forced)');
    }
  }, 1000);
}

function cmdRestart() {
  console.log('🔄 Restarting EvolClaw...');
  const p = resolvePaths();
  const pid = isRunning(p.pid);

  if (pid) {
    process.kill(pid);
    let waited = 0;
    while (waited < 10) {
      try {
        process.kill(pid, 0);
        execFileSync('sleep', ['1']);
        waited++;
      } catch {
        break;
      }
    }
    if (waited >= 10) {
      try { process.kill(pid, 9); } catch {}
    }
    try { fs.unlinkSync(p.pid); } catch {}
  }

  setTimeout(() => cmdStart(), 1000);
}

function cmdStatus() {
  const p = resolvePaths();
  const pid = isRunning(p.pid);

  if (pid) {
    console.log(`✓ EvolClaw is running (PID: ${pid})`);
    console.log('');
    console.log('📊 Process Info:');
    try {
      const uptime = execFileSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf-8' }).trim();
      const cpu = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf-8' }).trim();
      const mem = execFileSync('ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf-8' }).trim();
      console.log(`  Uptime: ${uptime}`);
      console.log(`  CPU: ${cpu}%`);
      console.log(`  Memory: ${mem} KB`);
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
      const output = execFileSync('sqlite3', [p.db,
        'SELECT count(*) FROM sessions; SELECT count(*) FROM sessions WHERE is_active=1; SELECT count(DISTINCT channel_id) FROM sessions; SELECT count(DISTINCT project_path) FROM sessions;'
      ], { encoding: 'utf-8' }).trim().split('\n');
      if (output.length >= 4) {
        console.log(`  会话总数: ${output[0]} (活跃: ${output[1]})`);
        console.log(`  独立会话: ${output[2]} 个`);
        console.log(`  涉及项目: ${output[3]} 个`);
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
  const child = spawn('tail', ['-f', mainLog], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
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
        try {
          process.kill(oldPid, 0);
        } catch {
          clearInterval(interval);
          log(`Process ${oldPid} has exited`);
          resolve();
          return;
        }
        if (waited >= 30) {
          clearInterval(interval);
          log('ERROR: Process still running after 30s, force killing');
          try { process.kill(oldPid, 9); } catch {}
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
    await notifyFeishu(p, pendingInfo, '✅ 服务重启成功！', log);
    cleanupPendingFile(pendingFile, log);
    process.exit(0);
  }

  // 启动失败，进入 self-heal 循环
  log('❌ Service failed to start, entering self-heal loop');
  await notifyFeishu(p, pendingInfo, '⚠️ 服务启动失败，正在尝试自动修复...', log);

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    log(`Self-heal attempt ${attempt}/${MAX_HEAL_ATTEMPTS}`);
    await notifyFeishu(p, pendingInfo, `🔧 自动修复中（第 ${attempt}/${MAX_HEAL_ATTEMPTS} 次）...`, log);

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
      await notifyFeishu(p, pendingInfo, `✅ 自愈成功！（第 ${attempt} 次修复后恢复）`, log);
      cleanupPendingFile(pendingFile, log);
      process.exit(0);
    }

    log(`Attempt ${attempt}: still failing after fix`);
  }

  // 全部失败
  log(`❌ All ${MAX_HEAL_ATTEMPTS} self-heal attempts failed`);
  await notifyFeishu(p, pendingInfo, `❌ ${MAX_HEAL_ATTEMPTS} 次自动修复均失败，需要人工介入。\n修复记录：${p.selfHealLog}`, log);
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
    try { process.kill(pid); } catch {}
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
 * 通过 Feishu API 发送通知（轻量级，不依赖 FeishuChannel）
 */
async function notifyFeishu(
  p: ReturnType<typeof resolvePaths>,
  pendingInfo: { channel: string; channelId: string } | null,
  message: string,
  log: (msg: string) => void
) {
  if (!pendingInfo || pendingInfo.channel !== 'feishu') return;

  try {
    const configPath = path.join(p.dataDir, 'evolclaw.json');
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.feishu?.appId || !config.feishu?.appSecret) return;

    const lark = await import('@larksuiteoapi/node-sdk');
    const client = new lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
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
}

// ==================== Main ====================

export async function main(args: string[]) {
  const cmd = args[0] || 'start';

  switch (cmd) {
    case 'init':
      await cmdInit();
      break;
    case 'start':
      cmdStart();
      break;
    case 'stop':
      cmdStop();
      break;
    case 'restart':
      cmdRestart();
      break;
    case 'status':
      cmdStatus();
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
  init      创建配置文件 (${resolvePaths().config})
  start     启动服务 (默认)
  stop      停止服务
  restart   重启服务
  status    查看状态
  logs      查看日志 (tail -f)

Environment:
  EVOLCLAW_HOME   数据目录 (默认: ~/.evolclaw)
  LOG_LEVEL       日志级别 (默认: INFO)
  MESSAGE_LOG     消息日志 (默认: true)
  EVENT_LOG       事件日志 (默认: true)`);
      process.exit(1);
  }
}

// 直接运行时自动执行（node dist/cli.js ...）
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
