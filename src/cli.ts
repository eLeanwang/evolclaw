import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';

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

  const sampleSrc = path.join(getPackageRoot(), 'data', 'config.sample.json');
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

  setTimeout(() => {
    const running = isRunning(p.pid);
    if (running) {
      console.log(`✓ EvolClaw started successfully (PID: ${running})`);
      console.log(`  EVOLCLAW_HOME: ${resolveRoot()}`);
      console.log(`  Logs: ${p.logs}/`);
      console.log('');
      countLines(getPackageRoot(), p.logs);
    } else {
      console.log('❌ Failed to start EvolClaw');
      console.log('');
      console.log('📝 Error details (last 10 lines of stdout):');
      if (fs.existsSync(stdoutLog)) {
        const content = fs.readFileSync(stdoutLog, 'utf-8').trim().split('\n');
        console.log(content.slice(-10).map(l => `  ${l}`).join('\n'));
      }
      process.exit(1);
    }
  }, 2000);
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
 */
function cmdRestartMonitor() {
  const p = resolvePaths();
  const restartLog = path.join(p.logs, 'restart.log');

  const log = (msg: string) => {
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}\n`;
    fs.appendFileSync(restartLog, line);
  };

  log('Restart monitor started');

  if (!fs.existsSync(p.pid)) {
    log('ERROR: PID file not found');
    process.exit(1);
  }

  const oldPid = parseInt(fs.readFileSync(p.pid, 'utf-8').trim(), 10);
  log(`Monitoring process PID: ${oldPid}`);

  let waited = 0;
  const waitInterval = setInterval(() => {
    waited++;
    try {
      process.kill(oldPid, 0);
    } catch {
      clearInterval(waitInterval);
      log(`Process ${oldPid} has exited`);
      startAfterWait();
      return;
    }
    if (waited >= 30) {
      clearInterval(waitInterval);
      log('ERROR: Process still running after 30s');
      process.exit(1);
    }
  }, 1000);

  function startAfterWait() {
    log('Waiting 3 seconds before restart...');
    setTimeout(() => {
      log('Starting new process...');
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

      setTimeout(() => {
        const running = isRunning(p.pid);
        if (running) {
          log(`✓ Service restarted successfully (PID: ${running})`);
        } else {
          log('❌ Failed to start service');
        }
        process.exit(running ? 0 : 1);
      }, 2000);
    }, 3000);
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
      cmdRestartMonitor();
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
