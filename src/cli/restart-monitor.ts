import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { resolvePaths, getPackageRoot } from '../paths.js';
import { loadEvolclawConfig } from '../config-store.js';
import * as platform from '../utils/cross-platform.js';
import { EventBus } from '../core/event-bus.js';
import { tryUpgrade, tryUpgradeAunSdk, tryUpgradeGlobalPkg, resolveGlobalPkg } from '../utils/npm-ops.js';
import { resolveAunCoreSdkPkg, AUN_CORE_SDK_PKG } from '../aun/aid/client.js';
import { isValidAid } from '../aun/aid/index.js';
import { msgSend } from '../aun/msg/index.js';
import { scanInstances, cleanupInstances, writeRestartMonitor, removeRestartMonitor, isRestartMonitorWinner } from '../utils/instance-registry.js';

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

export async function cmdRestartMonitor() {
  const p = resolvePaths();
  const restartLog = path.join(p.logs, 'restart.log');
  const MAX_HEAL_ATTEMPTS = 3;
  const READY_TIMEOUT = 30000; // 30s（AUN sidecar + 外部渠道连接预留）
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

  // restart-pending.json 只留给新主进程发送发起会话内的“重启成功”回执。
  const pendingFile = path.join(p.dataDir, 'restart-pending.json');

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
      await notifyDaemonOwners(p, `📦 已升级 ${upgrade.from} → ${upgrade.to}`, log);
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
      await notifyDaemonOwners(p, `⚠️ evolclaw 升级失败，使用当前版本继续\n${upgrade.error ?? ''}`.trim(), log);
      break;
  }

  // AUN SDK 版本检查与升级
  const aunUpgrade = await tryUpgradeAunSdk(resolveAunCoreSdkPkg, AUN_CORE_SDK_PKG);
  switch (aunUpgrade.status) {
    case 'upgraded':
      log(`✅ AUN SDK upgraded: ${aunUpgrade.from} → ${aunUpgrade.to}`);
      await notifyDaemonOwners(p, `📦 AUN SDK 已升级 ${aunUpgrade.from} → ${aunUpgrade.to}`, log);
      break;
    case 'no-update':
      break;
    case 'failed':
      log(`⚠ AUN SDK upgrade failed (${aunUpgrade.from} → ${aunUpgrade.to}): ${aunUpgrade.error}`);
      await notifyDaemonOwners(p, `⚠️ AUN SDK 升级失败，使用当前版本继续\n${aunUpgrade.error ?? ''}`.trim(), log);
      break;
  }

  // evolclaw-web 版本检查与升级（已安装才检查）
  const ecwebUpgrade = await tryUpgradeGlobalPkg(() => resolveGlobalPkg('evolclaw-web'), 'evolclaw-web');
  switch (ecwebUpgrade.status) {
    case 'upgraded':
      log(`✅ evolclaw-web upgraded: ${ecwebUpgrade.from} → ${ecwebUpgrade.to}`);
      await notifyDaemonOwners(p, `📦 evolclaw-web 已升级 ${ecwebUpgrade.from} → ${ecwebUpgrade.to}`, log);
      break;
    case 'no-update':
      break;
    case 'failed':
      log(`⚠ evolclaw-web upgrade failed (${ecwebUpgrade.from} → ${ecwebUpgrade.to}): ${ecwebUpgrade.error}`);
      await notifyDaemonOwners(p, `⚠️ evolclaw-web 升级失败，使用当前版本继续\n${ecwebUpgrade.error ?? ''}`.trim(), log);
      break;
  }

  // 启动并检测 ready signal
  let started = await spawnAndWaitReady(p, log, READY_TIMEOUT);

  if (started) {
    log('✓ Service restarted successfully');
    archiveSelfHealLog(p, log);
    // 发起会话内的“重启成功”通知由新进程自行发送，此处只负责失败/自愈告警。
    process.exit(0);
  }

  // 启动失败 — 测试环境下跳过 self-heal（避免 claude -p 污染会话列表、误杀生产进程）
  if (p.root.startsWith('/tmp/') || process.env.EVOLCLAW_TEST === '1') {
    log('❌ Service failed to start (test environment detected, skipping self-heal)');
    await notifyDaemonOwners(p, '❌ 服务启动失败（测试环境，已跳过自动修复）', log);
    cleanupPendingFile(pendingFile, log);
    process.exit(1);
  }

  // 启动失败，进入 self-heal 循环
  log('❌ Service failed to start, entering self-heal loop');
  eventBus.publish({ type: 'self-heal:started', reason: 'Service failed to start after restart' });
  await notifyDaemonOwners(p, '⚠️ 服务启动失败，正在尝试自动修复...', log);

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    // 前置检查：服务可能已被上一轮 claude 修复并启动
    if (isServiceAlive()) {
      log(`✓ Service already running before attempt ${attempt}, skipping`);
      await sendHealSummary(p, attempt - 1, log);
      eventBus.publish({ type: 'self-heal:completed', success: true, attempts: attempt - 1 });
      archiveSelfHealLog(p, log);
      cleanupPendingFile(pendingFile, log);
      process.exit(0);
    }

    log(`Self-heal attempt ${attempt}/${MAX_HEAL_ATTEMPTS}`);
    eventBus.publish({ type: 'self-heal:attempt', attemptNumber: attempt, maxAttempts: MAX_HEAL_ATTEMPTS });
    await notifyDaemonOwners(p, `🔧 自动修复中（第 ${attempt}/${MAX_HEAL_ATTEMPTS} 次）...`, log);

    const healed = await invokeClaude(p, attempt, MAX_HEAL_ATTEMPTS, HEAL_TIMEOUT, log);

    // 后置检查：不管 invokeClaude 返回什么，都检查服务实际状态
    if (isServiceAlive()) {
      log(`✓ Service is running after attempt ${attempt}`);
      await sendHealSummary(p, attempt, log);
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
      await sendHealSummary(p, attempt, log);
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
    await sendHealSummary(p, MAX_HEAL_ATTEMPTS, log);
    eventBus.publish({ type: 'self-heal:completed', success: true, attempts: MAX_HEAL_ATTEMPTS });
    archiveSelfHealLog(p, log);
    cleanupPendingFile(pendingFile, log);
    process.exit(0);
  }

  log(`❌ All ${MAX_HEAL_ATTEMPTS} self-heal attempts failed`);
  eventBus.publish({ type: 'self-heal:completed', success: false, attempts: MAX_HEAL_ATTEMPTS });
  await notifyDaemonOwners(p, `❌ ${MAX_HEAL_ATTEMPTS} 次自动修复均失败，需要人工介入。\n修复记录：${p.selfHealLog}`, log);
  cleanupPendingFile(pendingFile, log);
  process.exit(1);
}

/**
 * 发送 self-heal 修复成功小结（从 self-heal.md 提取摘要）
 */
async function sendHealSummary(
  p: ReturnType<typeof resolvePaths>,
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
  await notifyDaemonOwners(p, summary, log);
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

async function notifyDaemonOwners(
  p: ReturnType<typeof resolvePaths>,
  message: string,
  log: (msg: string) => void
) {
  const cfg = loadEvolclawConfig();
  const daemonAid = typeof cfg.aid === 'string' ? cfg.aid.trim() : '';
  if (!daemonAid) {
    log('Daemon owner notification skipped: evolclaw.json.aid not configured');
    return;
  }
  if (!isValidAid(daemonAid)) {
    log(`Daemon owner notification skipped: invalid evolclaw.json.aid ${daemonAid}`);
    return;
  }

  const owners = Array.from(new Set((Array.isArray(cfg.owners) ? cfg.owners : [])
    .map(owner => typeof owner === 'string' ? owner.trim() : '')
    .filter(Boolean)));
  if (owners.length === 0) {
    log('Daemon owner notification skipped: evolclaw.json.owners not configured');
    return;
  }

  const validOwners = owners.filter(owner => {
    const valid = isValidAid(owner);
    if (!valid) log(`Daemon owner notification skipped invalid owner AID: ${owner}`);
    return valid;
  });
  if (validOwners.length === 0) return;

  const text = formatDaemonOwnerNotice(p, message);
  for (const owner of validOwners) {
    try {
      const result = await msgSend({
        from: daemonAid,
        to: owner,
        body: { mode: 'text', text },
        slotId: 'restart-monitor',
      });
      if (!result.ok) {
        log(`Daemon owner notification failed for ${owner}: ${result.error}`);
        continue;
      }
      log(`Daemon owner notification sent to ${owner}: ${result.message_id}`);
    } catch (error: any) {
      log(`Daemon owner notification failed for ${owner}: ${error.message?.slice(0, 200) || error}`);
    }
  }
}

function formatDaemonOwnerNotice(
  p: ReturnType<typeof resolvePaths>,
  message: string
): string {
  return [
    'EvolClaw restart-monitor',
    message,
    '',
    `EVOLCLAW_HOME: ${p.root}`,
  ].join('\n');
}
