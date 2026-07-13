// 【重要】最先加载环境变量，确保后续模块初始化时可用
import dotenv from 'dotenv';
import path from 'path';
import { ensureDataDirs, resolvePaths, agentDir, getPackageRoot, agentMdPath } from './paths.js';

// 立即加载 .env 文件（在其他模块导入之前）
try {
  dotenv.config({ path: path.join(resolvePaths().root, '.env') });
} catch {
  // 首次运行时 .env 可能不存在，忽略错误
}

import { ClaudeSessionFileAdapter } from './core/session/adapters/claude-session-file-adapter.js';
import { CodexSessionFileAdapter } from './core/session/adapters/codex-session-file-adapter.js';
import { GeminiSessionFileAdapter } from './core/session/adapters/gemini-session-file-adapter.js';
import { resolveAnthropicConfig } from './agents/baseagent.js';
import { loadDefaults, loadAllAgents, ensureAgentDirSkeleton, migrateIdentitiesIfNeeded, migrateProcessConfigIfNeeded, loadEvolclawConfig } from './config-store.js';
import { initConfigManager, resolveEffective } from './config/config-manager.js';
import { shouldFailFastForMissingOwners } from './config/owner-policy.js';
import { getFirstStaticAgentOwner, resolvePeerRoleDetail, roleToSessionIdentity } from './config/peer-role-resolver.js';
import { snapshot as configSnapshot, retentionCleanup, readCurrent, readWVersion, writeWVersion, diffWorkingVsVersion, paramDiff, incrementSuccessCount, collectConfigFiles } from './config/snapshot.js';
import { appendBootLog, selfDiagnose } from './config/boot-log.js';
import type { Config, EffectiveAgentConfig, AgentConfig, DefaultsConfig, SessionIdentity } from './types.js';
import { CONFIG_SCHEMA_VERSION } from './types.js';
import type { Session } from './types.js';
import { SessionManager } from './core/session/session-manager.js';
import { ClaudeAgentPlugin } from './agents/claude-runner.js';
import { CodexAgentPlugin } from './agents/codex-runner.js';
import { GeminiAgentPlugin } from './agents/gemini-runner.js';
import { FeishuChannelPlugin } from './channels/feishu.js';
import { WechatChannelPlugin } from './channels/wechat.js';
import { AUNChannel, AUNChannelPlugin } from './channels/aun.js';
import { startServiceProxy } from './aun/service-proxy.js';
import { BindService, type BindRequestPayload } from './utils/aid-bind.js';
import { DingtalkChannelPlugin } from './channels/dingtalk.js';
import { QQBotChannelPlugin } from './channels/qqbot.js';
import { WecomChannelPlugin } from './channels/wecom.js';
import type { IMessageProcessor } from './core/message/message-processor-interface.js';
import { buildEnvelope } from './core/message/message-utils.js';
import { ResponseEngine } from './core/message/response-engine.js';
import { MessageQueue } from './core/message/message-queue.js';
import { MessageBridge } from './core/message/message-bridge.js';
import { MenuRequestDeduper, hasValidMenuId, menuFailure, menuPayloadFingerprint, parseMenuControl, validateMenuRequest } from './core/message/menu-control-protocol.js';
import { BootstrapService } from './core/bootstrap-service.js';
import { MessageCache } from './core/message/message-cache.js';
import { CommandHandler, isProcessLevelOwner } from './core/command/command-handler.js';
import { EventBus, GatewayEvent } from './core/event-bus.js';
import { getEventCatalog } from './core/event-catalog.js';
import { StatsCollector } from './utils/stats.js';
import { AidStatsCollector } from './utils/stats.js';
import { PermissionGateway } from './core/permission.js';
import { InteractionRouter } from './core/interaction-router.js';
import { AgentDelegationRegistry } from './core/auth/agent-delegation.js';
import { ChannelLoader, type ChannelInstance, tryParseChannelKey } from './core/channel-loader.js';
import { AgentLoader } from './core/baseagent-loader.js';
import { EvolAgentRegistry, type ReloadHooks } from './core/evolagent-registry.js';
import { buildReloadHooks } from './core/channel-loader.js';
import { IpcServer, IpcStatusResponse, ChannelStatus } from './ipc.js';
import { ChannelAdapter, Message, OutboundEnvelope, OutboundPayload } from './types.js';
import { logger, setLogLevel } from './utils/logger.js';
import { fetchEcwebPairCode } from './utils/ecweb-utils.js';
import { writeMain, removeAll, isMainWinner, scanInstances } from './utils/instance-registry.js';
import { detectDuplicates } from './core/evolagent-registry.js';
import { loadKitManifest, cleanEckDebug, invalidateKitCache } from './eck/kit-renderer.js';
import { initEck } from './eck/init.js';
import { TriggerDefinitionManager } from './trigger/manager.js';
import { TriggerRunStateStore } from './trigger/state.js';
import { TriggerAuditLogger } from './trigger/audit.js';
import { TriggerScriptExecutor } from './trigger/script-executor.js';
import { TriggerFeedbackDispatcher } from './trigger/feedback.js';
import { TriggerRuntimeScheduler } from './trigger/scheduler.js';
import { DaemonChannel } from './channels/daemon.js';
import { normalizeTriggerDefinition } from './trigger/validation.js';
import type { TriggerDefinition } from './trigger/types.js';
import { atomicWriteJson } from './core/session/session-fs-store.js';
import { appendMessageLog, buildOutboundEntry } from './core/message/message-log.js';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { spawn } from 'child_process';
import * as platform from './utils/cross-platform.js';

const controlMenuDeduper = new MenuRequestDeduper<import('./types.js').MenuResponse>();

/** 出站 payload 摘要（用于 channel-out.log） */
function summarizeOutboundPayload(payload: any): Record<string, any> {
  if (!payload) return { kind: 'unknown' };
  const s: Record<string, any> = { kind: payload.kind };
  switch (payload.kind) {
    case 'activity.batch':
      s.itemCount = payload.items?.length ?? 0;
      s.items = payload.items;
      break;
    case 'result.text':
      s.isFinal = payload.isFinal;
      s.text = payload.text;
      break;
    case 'command.result':
    case 'command.error':
    case 'result.error':
      s.text = payload.text;
      break;
    case 'result.file':
      s.filePath = payload.filePath;
      break;
    case 'system.notice':
    case 'system.error':
      s.subtype = payload.subtype;
      s.text = payload.text;
      break;
    case 'interaction':
      s.interactionId = payload.interaction?.id;
      s.interactionKind = payload.interaction?.kind?.kind;
      break;
    case 'status.started':
    case 'status.progress':
    case 'status.queued':
    case 'status.completed':
    case 'status.interrupted':
    case 'status.error':
    case 'status.timeout':
      s.metadata = payload.metadata;
      break;
  }
  return s;
}

function shouldCountSentPayload(payload: OutboundPayload): boolean {
  return [
    'result.text',
    'result.file',
    'result.image',
    'result.error',
    'command.result',
    'command.error',
    'interaction',
  ].includes(payload.kind);
}

function outboundPayloadToLogText(payload: OutboundPayload): { text: string; msgType: 'text' | 'file' | 'image' } | null {
  switch (payload.kind) {
    case 'result.text':
    case 'command.result':
    case 'command.error':
    case 'result.error':
      return { text: payload.text, msgType: 'text' };
    case 'result.file':
      return { text: payload.fileName || payload.filePath, msgType: 'file' };
    case 'result.image':
      return { text: payload.alt || '[image]', msgType: 'image' };
    case 'interaction':
      return { text: payload.fallbackText || '[interaction]', msgType: 'text' };
    default:
      return null;
  }
}

function normalizeMessageSource(value: unknown): 'daemon' | 'cli' | 'msg' | 'ctl' | 'owner-inject' {
  return value === 'cli' || value === 'msg' || value === 'ctl' || value === 'owner-inject'
    ? value
    : 'daemon';
}

function daemonConversationWatchdogMs(settings: { idleMonitor?: { timeout?: number } }): number {
  const idleTimeoutSec = settings.idleMonitor?.timeout;
  const idleMs = typeof idleTimeoutSec === 'number' && Number.isFinite(idleTimeoutSec) && idleTimeoutSec > 0
    ? idleTimeoutSec * 1000
    : 120_000;
  return Math.ceil(idleMs * 5 + 60_000);
}

function hasOriginIdentity(origin: unknown): boolean {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false;
  const raw = origin as Record<string, unknown>;
  return typeof raw.channelKey === 'string' && raw.channelKey.length > 0
    && typeof raw.channelId === 'string' && raw.channelId.length > 0;
}

function originFromActorSession(session: Session): TriggerDefinition['origin'] | undefined {
  const peerId = session.metadata?.peerId;
  if (!peerId) return undefined;
  return {
    channelKey: session.metadata?.channelKey || session.channel,
    channelId: session.channelId,
    session: session.threadId ? 'thread' : 'main',
    threadId: session.threadId || undefined,
    peerId,
    sessionKey: session.sessionKey,
  };
}

function seedUpgradeCheckTrigger(manager: TriggerDefinitionManager, owner: { aid: string; originPeerId?: string; baseagent: string }): void {
  const now = Date.now();
  const scriptName = 'upgrade-check.sh';
  const definition = normalizeTriggerDefinition({
    $schema_version: 4,
    id: '__upgrade-check',
    agentAid: owner.aid,
    enabled: true,
    name: '__upgrade-check',
    description: 'System trigger: check EvolClaw upgrades after install or upgrade.',
    createdAt: now,
    updatedAt: now,
    origin: {
      channelKey: 'daemon',
      channelId: owner.originPeerId || owner.aid,
      session: 'main',
      peerId: owner.originPeerId || owner.aid,
      sessionKey: `daemon#${owner.originPeerId || owner.aid}#__system__`,
    },
    source: {
      type: 'cron',
      expression: '59 3 * * *',
      timezone: 'Asia/Shanghai',
    },
    execution: {
      type: 'script',
      script: {
        path: scriptName,
        runtime: 'bash',
        timeoutMs: 60_000,
      },
      permissionMode: 'bypass',
      onError: 'fail',
      noopSentinel: '[[NOOP]]',
    },
    feedback: {
      strategy: 'silent',
    },
    reliability: {
      concurrency: 'forbid',
      missedPolicy: 'run_once',
      retry: {
        maxAttempts: 0,
        backoffMs: 30_000,
      },
    },
  });
  const dir = manager.triggerDir(definition.id);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, scriptName);
  const packageRoot = getPackageRoot();
  const cliPath = path.join(packageRoot, 'dist', 'cli', 'index.js');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const devMode = fs.existsSync(path.join(packageRoot, 'src', 'index.ts'));
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `CLI_PATH=${JSON.stringify(cliPath)}`,
    `PACKAGE_JSON=${JSON.stringify(packageJsonPath)}`,
    `DEV_MODE=${devMode ? '1' : '0'}`,
    '',
    'json() {',
    '  local outcome="$1"',
    '  local text="$2"',
    '  node -e \'console.log(JSON.stringify({ outcome: process.argv[1], text: process.argv[2], files: [] }))\' "$outcome" "$text"',
    '}',
    '',
    'if [ "$DEV_MODE" = "1" ]; then',
    '  json "noop" "upgrade check skipped in dev mode"',
    '  exit 0',
    'fi',
    '',
    'local_version="$(node -e \'try { console.log(require(process.argv[1]).version || "") } catch { process.exit(0) }\' "$PACKAGE_JSON")"',
    'remote_version="$(npm view evolclaw version 2>/dev/null || true)"',
    '',
    'if [ -z "$remote_version" ]; then',
    '  json "error" "failed to check evolclaw latest version"',
    '  exit 0',
    'fi',
    '',
    'if [ -z "$local_version" ]; then',
    '  json "error" "failed to read local evolclaw version"',
    '  exit 0',
    'fi',
    '',
    'version_cmp="$(node -e \'',
    'const [a, b] = process.argv.slice(1);',
    'const pa = a.split("-")[0].split(".").map(Number);',
    'const pb = b.split("-")[0].split(".").map(Number);',
    'const n = Math.max(pa.length, pb.length);',
    'let out = 0;',
    'for (let i = 0; i < n; i++) {',
    '  const av = Number.isFinite(pa[i]) ? pa[i] : 0;',
    '  const bv = Number.isFinite(pb[i]) ? pb[i] : 0;',
    '  if (av < bv) { out = -1; break; }',
    '  if (av > bv) { out = 1; break; }',
    '}',
    'console.log(out);',
    '\' "$local_version" "$remote_version")"',
    '',
    'if [ "$version_cmp" != "-1" ]; then',
    '  json "noop" "evolclaw is already up to date ($local_version; latest $remote_version)"',
    '  exit 0',
    'fi',
    '',
    'if [ ! -f "$CLI_PATH" ]; then',
    '  json "error" "restart-monitor entry not found: $CLI_PATH"',
    '  exit 0',
    'fi',
    '',
    'nohup node "$CLI_PATH" restart-monitor >/dev/null 2>&1 &',
    'json "success" "evolclaw upgrade available: ${local_version:-unknown} -> $remote_version; restart-monitor started"',
    '',
  ].join('\n'));
  fs.chmodSync(scriptPath, 0o755);
  atomicWriteJson(manager.definitionPath(definition.id), definition);
  fs.rmSync(manager.activePath(definition.id), { force: true });
}

function removeLegacyAgentUpgradeCheck(manager: TriggerDefinitionManager): void {
  let existing: TriggerDefinition | undefined;
  try {
    existing = manager.get('__upgrade-check');
  } catch {
    fs.rmSync(manager.triggerDir('__upgrade-check'), { recursive: true, force: true });
    return;
  }
  if (!existing) return;
  const isLegacySystemOrigin = existing.origin?.channelKey === '__system__' || existing.origin?.channelKey === 'daemon';
  const isUpgradeScript = existing.execution.type === 'script'
    && existing.execution.script?.path === 'upgrade-check.sh';
  if (!isLegacySystemOrigin || !isUpgradeScript) return;
  fs.rmSync(manager.triggerDir('__upgrade-check'), { recursive: true, force: true });
}

/**
 * 通过 adapter.send 发送系统类 payload（system.notice / system.error / 等）。
 *
 * 网关层（本文件）的所有出站系统通知（上线 / 重启完成 / 渠道告警 / agent 启动失败等）
 * 走这里集中调度，让渠道按 capabilities 决定呈现方式。
 *
 * 当 adapter 还没实现 send（旧 adapter）时，按 payload.kind 降级到 sendText。
 *
 * Exported for unit test coverage; runtime callers are inside main() closure.
 */
export async function sendSystemPayload(
  adapter: ChannelAdapter,
  envelope: OutboundEnvelope,
  payload: OutboundPayload
): Promise<void> {
  await adapter.send(envelope, payload);
}

async function runBindBootstrapDaemon(evolclawCfg: ReturnType<typeof loadEvolclawConfig>, defaults: DefaultsConfig): Promise<void> {
  logger.warn('[bind-bootstrap] starting control AID + IPC only');
  const bindService = new BindService({
    receiverAid: evolclawCfg.aid!,
    getAvailableBaseagents: detectAvailableBaseagentsForBind,
    getUptimeSeconds: () => Math.floor(process.uptime()),
  });
  bindService.startCleanup();

  let controlChannel: AUNChannel | undefined;
  controlChannel = new AUNChannel({
    aid: evolclawCfg.aid!,
    agentName: evolclawCfg.aid!,
    channelName: 'control',
    pureIdentity: true,
    aunTrace: evolclawCfg.debug?.aunTrace ?? defaults.debug?.aunTrace,
    aunSdkLog: evolclawCfg.debug?.aunSdkLog ?? defaults.debug?.aunSdkLog,
  });

  try {
    await controlChannel.connect();
    logger.info(`✓ 控制 AID 已连接: ${evolclawCfg.aid}`);
  } catch (e: any) {
    logger.warn(`控制 AID 首连失败（后台自动重连，不影响 bootstrap IPC）: ${e?.message || e}`);
  }

  controlChannel.onMessage(async (opts) => {
    const text = (opts.content || '').trim();
    let parsed: BindRequestPayload | null = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const response = parsed ? await bindService.handleRequest(parsed, opts.peerId) : null;
    if (response) {
      await controlChannel!.sendMessage(opts.channelId, JSON.stringify(response));
    }
  });

  const ipcServer = new IpcServer(resolvePaths().socket, (): IpcStatusResponse => ({
    pid: process.pid,
    uptime: Math.round(process.uptime() * 1000),
    channels: {},
    channelsByType: {},
    queue: { pending: 0, processing: 0 },
    controlAid: { aid: evolclawCfg.aid!, connected: controlChannel?.getAidState().status === 'connected' },
  }));
  ipcServer.setBindExecutor({
    begin: (cmd) => bindService.begin(cmd),
    status: (taskId) => bindService.status(taskId),
    cancel: (taskId) => bindService.cancel(taskId),
  });
  await ipcServer.start();

  fs.writeFileSync(resolvePaths().readySignal, String(Date.now()));
  logger.info(`✓ Bind bootstrap ready signal written: ${resolvePaths().readySignal}`);

  const shutdown = async (signal?: string) => {
    logger.info(`[bind-bootstrap] shutting down${signal ? ` (${signal})` : ''}`);
    ipcServer.stop();
    bindService.stopCleanup();
    if (controlChannel) {
      try { await controlChannel.disconnect(); } catch { /* ignore */ }
    }
    removeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => removeAll());
}

export function readEvolclawVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectAvailableBaseagentsForBind(): string[] {
  const out: string[] = [];
  for (const cmd of ['claude', 'gemini', 'codex']) {
    if (commandExists(cmd)) out.push(cmd);
  }
  return out;
}

/**
 * 启动失败时分类打印（不交互、不自动回落，只给准确提示）。
 * 分类：W 解析失败 / W 有未存改动(param diff) / W==w-version(版本自身坏) → 建议自检命令。
 */
function printConfigFailure(skipped: Array<{ dirName: string; reason: string }>): void {
  const root = resolvePaths().root;
  const agentsDir = path.join(root, 'agents');
  const lines: string[] = ['❌ 启动失败：无法加载任何 self-agent 配置。'];

  // 先检查是否有解析错误（语法级失败）
  const parseErrors: string[] = [];
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(agentsDir, entry.name, 'config.json');
      if (!fs.existsSync(cfgPath)) continue;
      try { JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch (e) {
        parseErrors.push(`  agents/${entry.name}/config.json 无法解析: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (parseErrors.length > 0) {
    lines.push('配置文件语法错误：');
    lines.push(...parseErrors);
    const wv = readWVersion();
    if (wv) lines.push(`  回退到上一版本: ec config restore ${wv.delta}`);
  } else {
    // 检查 W vs w-version
    const wv = readWVersion();
    if (wv) {
      const diff = diffWorkingVsVersion(wv.delta);
      if (!('error' in diff) && (diff.modified.length + diff.added.length + diff.deleted.length > 0)) {
        lines.push(`当前参数与版本 ${wv.delta} 存在差异（可能是失败原因）：`);
        const pdiff = paramDiff(wv.delta);
        if (!('error' in pdiff)) {
          for (const fd of pdiff) {
            for (const c of fd.changes) {
              lines.push(`  ${fd.file}: ${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
            }
          }
        }
        lines.push(`  回退: ec config restore ${wv.delta}`);
      } else {
        // W == w-version，版本自身有问题
        lines.push('当前配置版本无法加载。');
        lines.push('  用自检模式逐版本回落: ec start --diagnose  或  ec restart --diagnose');
      }
    } else {
      lines.push('No self-agent configured. Run `evolclaw aid new <name>` to create one.');
    }
    if (skipped.length > 0) {
      lines.push(`  跳过的目录 (${skipped.length}):`);
      for (const s of skipped) lines.push(`    - ${s.dirName}: ${s.reason}`);
    }
  }

  const msg = lines.join('\n');
  logger.error(msg);
  console.error(msg);
}

function readFastaunVersion(): string {
  try {
    const url = (import.meta as any).resolve?.('@agentunion/fastaun');
    if (!url) return 'unknown';
    let dir = path.dirname(fileURLToPath(url));
    while (dir !== path.dirname(dir)) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === '@agentunion/fastaun') return pkg.version || 'unknown';
      }
      dir = path.dirname(dir);
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  // 启动信息：目录类型 + 版本号 + 代码最新时间戳
  {
    const pkgRoot = getPackageRoot();
    const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    const isDist = runDir.includes(path.join(pkgRoot, 'dist'));
    const isLinked = fs.existsSync(path.join(pkgRoot, '.git'));
    const dirType = isDist ? (isLinked ? '开发仓/dist' : '安装路径/dist') : '源码(tsx)';
    const scanDir = isDist ? path.join(pkgRoot, 'dist') : path.join(pkgRoot, 'src');
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
    const fmtTime = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; };
    console.error(`[EvolClaw] EvolClaw v${version}`);
    console.error(`[EvolClaw] 执行类型: ${dirType}`);
    console.error(`[EvolClaw] 包路径:   ${pkgRoot}`);
    console.error(`[EvolClaw] 代码时间: ${latestMtime ? fmtTime(latestMtime) : '?'}`);
  }

  // 过滤飞书 SDK 的 info 日志
  const originalLog = console.log;
  const originalInfo = console.info;

  const filter = (...args: any[]) => {
    const firstArg = String(args[0] || '');
    return firstArg.includes('[info]') || firstArg.includes('[ws]');
  };

  console.log = (...args: any[]) => {
    if (filter(...args)) return;
    originalLog(...args);
  };

  console.info = (...args: any[]) => {
    if (filter(...args)) return;
    originalInfo(...args);
  };

  logger.info(`EvolClaw v${readEvolclawVersion()} starting... (fastaun v${readFastaunVersion()})`);

  // 确保数据目录存在
  ensureDataDirs();

  // .env 文件已在模块顶部加载，此处不再重复加载

  // ── 单实例保护（pre-check + post-write self-check）──
  // pre-check：发现已有活 main 直接退出，避免起任何副作用
  {
    const pre = scanInstances();
    const aliveOthers = pre.mains.filter(m => m.alive && m.record.pid !== process.pid);
    if (aliveOthers.length > 0) {
      const pids = aliveOthers.map(m => m.record.pid).join(', ');
      const msg = `❌ Another EvolClaw instance is already running (PID: ${pids}). Use 'evolclaw restart' to replace it.`;
      logger.error(msg);
      console.error(msg);
      process.exit(1);
    }
  }

  // 立即登记自己（让其他并发启动者能看见我）
  const launchedBy = (process.env.EVOLCLAW_LAUNCHED_BY as any) || 'start';
  writeMain(launchedBy);
  logger.info(`✓ Instance record written: main-${process.pid}.json`);

  // post-write 自检：写完 record 后再扫一次，发现并发对手时按 (startedAt, pid) 选赢家
  {
    const verdict = isMainWinner();
    if (!verdict.winner) {
      logger.warn(`Lost main election to PID ${verdict.conflictingPid}, yielding`);
      console.error(`⚠ Another instance (PID ${verdict.conflictingPid}) started concurrently and won the election. Yielding.`);
      removeAll();
      process.exit(0);
    }
  }

  // ── 自动迁移 ──
  migrateIdentitiesIfNeeded();
  // autoMigrateIfNeeded 已随配置体系 v2 退场（fresh init，不做兼容过渡）。
  // config.json（ProcessConfig）→ evolclaw.json：必须在任何 getAidStore（AUN 连接）之前，
  // 否则首次读 encryptionSeed 时迁移还没发生。
  migrateProcessConfigIfNeeded();

  // ── 配置体系初始化（schema 字段不相交硬约束校验）──
  try {
    initConfigManager();
  } catch (e) {
    const msg = `❌ 配置 schema 校验失败: ${e instanceof Error ? e.message : String(e)}`;
    logger.error(msg);
    console.error(msg);
    process.exit(1);
  }

  // ── 自检模式（EVOLCLAW_DIAGNOSE=1 由 ec start --diagnose / ec restart --diagnose 注入）──
  if (process.env.EVOLCLAW_DIAGNOSE === '1') {
    logger.info('[diagnose] 进入自检模式，逐版本回落尝试...');
    const result = await selfDiagnose();
    if (result.ok) {
      logger.info(`[diagnose] ✓ 回落到 ${result.actualVersion?.delta} 成功，继续启动。`);
      // W 已展开为好版本，继续正常启动流程（不再是诊断）
    } else {
      const msg = result.message ?? '✗ 自检失败：未找到可用版本。';
      logger.error(msg);
      console.error(msg);
      process.exit(1);
    }
  }

  // ── ECK 运行时初始化 ──
  initEck();

  // 加载 ECK manifest + 清理旧调试文件
  cleanEckDebug();
  loadKitManifest();

  // 加载配置（新结构：defaults.json + per-agent config.json）
  const defaults: DefaultsConfig = loadDefaults() ?? { $schema_version: CONFIG_SCHEMA_VERSION };
  const evolclawCfg = loadEvolclawConfig();
  let processLevelOwners = evolclawCfg.owners ?? [];
  const bindBootstrapMode = process.env.EVOLCLAW_BIND_BOOTSTRAP === '1';
  if (processLevelOwners.length === 0 && shouldFailFastForMissingOwners()) {
    throw new Error('evolclaw.json.owners is required when EVOLCLAW_REQUIRE_OWNERS=1');
  }

  // 进程级 menu 操作（/system /agent）鉴权：owners 来自 evolclaw.json 顶层。
  // owners 为空时这些操作一律 FORBIDDEN，启动时提示如何配置。
  if (processLevelOwners.length === 0) {
    logger.warn('[startup] evolclaw.json.owners 未配置：进程级 menu 操作（/system /agent）将一律拒绝。' +
      '如需远程管理，请在 evolclaw.json 配置 owners: [<你的 AID>]');
  }

  // 应用配置中的日志级别（优先于环境变量）
  // logLevel 现在不在新结构中——若要保留，将来可加 defaults.debug.logLevel
  // 阶段 2c 暂跳过

  const paths = resolvePaths();

  if (bindBootstrapMode && evolclawCfg.aid && loadAllAgents().agents.length === 0) {
    await runBindBootstrapDaemon(evolclawCfg, defaults);
    return;
  }

  // ── EvolAgent Registry：加载 agents/<aid>/config.json ──
  const agentRegistry = new EvolAgentRegistry(paths.agentsDir);
  agentRegistry.loadAll();
  const agentInfos = agentRegistry.list();

  if (agentInfos.length === 0) {
    const skipped = agentRegistry.getSkipped();
    logger.info('✓ No self-agent configured; starting Control Plane only');
    if (skipped.length > 0) {
      logger.warn(`[startup] skipped ${skipped.length} agent director${skipped.length === 1 ? 'y' : 'ies'} while starting empty runtime`);
      for (const s of skipped) logger.warn(`  - ${s.dirName}: ${s.reason}`);
    }
  } else {
    logger.info(`✓ Loaded ${agentInfos.length} self-agent(s)`);
    for (const info of agentInfos) {
      if (info.status === 'error') {
        logger.error(`  ✗ ${info.name}: ${info.error}`);
      } else if (info.status === 'disabled') {
        logger.info(`  ○ ${info.name} (disabled)`);
      } else {
        logger.info(`  ● ${info.name} ${info.baseagent} @ ${path.basename(info.projectPath)}`);
      }
    }
  }

  // 跨 agent 凭证冲突
  {
    const dups = detectDuplicates(agentRegistry.runnableAgents());
    for (const d of dups) {
      const owners = d.agents.map(o => `${o.aid}(${o.channelName})`).join(', ');
      logger.warn(`⚠ Duplicate channel credential: ${d.fingerprint} claimed by ${owners}.`);
    }
  }

  // 选定主 agent（启动期 anthropic resolve 用，配合 IPC `evolagent.list` 显示）。
  // 空 runtime 下没有 primary agent，Control Plane 仍继续启动。
  const primaryAgent = agentRegistry.runnableAgents()[0];
  let agentRuntimeState: 'empty' | 'starting' | 'running' | 'stopped' | 'error' = primaryAgent ? 'starting' : 'empty';
  let agentRuntimeError: string | undefined;
  if (!primaryAgent && agentInfos.length > 0) {
    agentRuntimeState = 'error';
    agentRuntimeError = 'No runnable self-agent (all are error/disabled).';
    logger.warn(`[startup] ${agentRuntimeError} Control Plane will remain available.`);
  }

  // 进程级设置：idleMonitor 属于 evolclaw.json；debug 继续沿用 defaults 的现有行为。
  const globalSettings: import('./types.js').GlobalSettings = {
    idleMonitor: evolclawCfg.idleMonitor,
    debug: (defaults as any).debug,
  };

  if (globalSettings.debug?.logLevel) {
    setLogLevel(globalSettings.debug.logLevel);
  }

  // 启动期 anthropic 凭证校验已移除：runner 创建时由 AgentLoader 错误处理
  logger.info('✓ Config loaded');


  // Store for IPC access (T10 will wire this)
  // M4: removed dead globalThis.__evolclaw_agentRegistry assignment

  // 创建事件总线
  const eventBus = new EventBus();
  logger.info('✓ Event bus initialized');

  // 把所有事件录到 events.log（受 EVENT_LOG 环境变量控制）
  eventBus.subscribeAll((event) => logger.event(event));
  eventBus.subscribe('agent:updated', (event) => {
    if ((event as any).nameChanged) agentRegistry?.invalidateAgentDisplayCache?.((event as any).aid);
  });

  // 统计收集器（近 1 小时滚动统计）
  const statsCollector = new StatsCollector(eventBus);

  // Per-AID 消息统计收集器（累计，供 watch aid 实时展示）
  const aidStatsCollector = new AidStatsCollector(eventBus);
  aidStatsCollector.setSessionsDir(paths.sessionsDir);
  // 持久化网络流量到 message_events 表
  aidStatsCollector.onMessage = (ev) => {
    import('./stats/writer.js').then(({ insertMessageEvent }) => {
      insertMessageEvent(paths.root, ev);
    }).catch(() => {});
  };

  // 日聚合表 usage_daily：首次启动回填 + 每日自愈。
  // 首次：表为空但明细非空时全量回填历史数据；之后靠 writer 写时增量维护。
  // 自愈：每日全量重建一次，纠正任何写时漂移。
  import('./stats/db.js').then(({ getDb, rebuildDailyRollup }) => {
    const db = getDb(paths.root);
    if (!db) return;
    try {
      const daily = db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number };
      const events = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
      if (daily.n === 0 && events.n > 0) {
        logger.info('[Stats] usage_daily 为空，回填历史数据…');
        rebuildDailyRollup(paths.root);
      }
    } catch (e) {
      logger.warn(`[Stats] usage_daily 回填检测失败（非致命）: ${e}`);
    }
    // 每日自愈（24h），纠正写时增量漂移。
    setInterval(() => {
      try { rebuildDailyRollup(paths.root); }
      catch (e) { logger.warn(`[Stats] usage_daily 自愈失败（非致命）: ${e}`); }
    }, 24 * 60 * 60 * 1000);
  }).catch(() => {});

  // 初始化 SessionManager（文件系统后端）
  const resolveSessionIdentity = (
    channel: string,
    userId?: string,
    chatType?: 'private' | 'group',
    conversationId?: string,
  ): SessionIdentity => {
    const parsed = tryParseChannelKey(channel);
    const owningAgent = agentRegistry.resolveByChannel(channel);
    const selfAid = owningAgent?.aid ?? parsed?.selfAID;
    if (!selfAid || !userId) return { role: 'none', mode: 'interactive' };
    const actualChatType = chatType || 'private';
    // 群聊角色需按群 ID 命中群成员角色表；私聊按 userId。缺省回退到 userId 保持旧行为。
    const actualConversationId = actualChatType === 'group'
      ? (conversationId || userId)
      : userId;
    const detail = resolvePeerRoleDetail({
      selfAid,
      channelType: parsed?.type || channel,
      chatType: actualChatType,
      actorId: userId,
      conversationId: actualConversationId,
    });
    return roleToSessionIdentity(detail.effectiveRole);
  };

  const modeIdToChatMode = (modeId: unknown): 'interactive' | 'proactive' | undefined => (
    modeId === 'interactive' || modeId === 'proactive' ? modeId : undefined
  );

  const sessionManager = new SessionManager(paths.sessionsDir, eventBus,
    resolveSessionIdentity,
    (channel) => {
      const owningAgent = agentRegistry.resolveByChannel(channel);
      if (!owningAgent?.aid) return undefined;
      try {
        const effective = resolveEffective({ self: owningAgent.aid }, { cache: true });
        const legacy = effective.chatmode ?? owningAgent.config.chatmode;
        const responseModes = effective.response_modes;
        return {
          private: modeIdToChatMode(responseModes?.default_private) ?? legacy?.private,
          group: modeIdToChatMode(responseModes?.default_group) ?? legacy?.group,
          nothuman: legacy?.nothuman,
        };
      } catch (e) {
        logger.warn('[SessionManager] resolve chatMode defaults failed for channel=' + channel + ': ' + (e instanceof Error ? e.message : String(e)));
        return owningAgent.config.chatmode;
      }
    },
  );

  // chatMode 作为新 session 初始值读取 owning agent effective config；已有 session 保持自身状态。
  logger.info('✓ Database initialized');

  // 注册会话文件适配器（Claude / Codex 各自的会话文件操作）
  sessionManager.registerFileAdapter(new ClaudeSessionFileAdapter());
  sessionManager.registerFileAdapter(new CodexSessionFileAdapter());
  sessionManager.registerFileAdapter(new GeminiSessionFileAdapter());

  // Agent 插件系统：每个 EvolAgent × 每个 baseagent 一个独立 runner（H1/H2 修复）
  const agentLoader = new AgentLoader();
  agentLoader.register(new ClaudeAgentPlugin());
  agentLoader.register(new CodexAgentPlugin());
  agentLoader.register(new GeminiAgentPlugin());

  const agentInstances = agentLoader.createAll(agentRegistry, {
    onSessionIdUpdate: async (sessionId: string, agentSessionId: string) => {
      await sessionManager.updateAgentSessionIdBySessionId(sessionId, agentSessionId);
    },
  });

  // agentMap 复合键：${aid}::${baseagent}
  const agentMap = new Map<string, any>();
  for (const inst of agentInstances) {
    agentMap.set(`${inst.evolagentName}::${inst.baseagent}`, inst.agent);
  }
  const primaryBaseagent = primaryAgent?.baseagent ?? 'claude';
  let primaryRunnerKey = primaryAgent ? `${primaryAgent.aid}::${primaryBaseagent}` : '<empty>::claude';
  const agentRunner = agentMap.get(primaryRunnerKey) || agentInstances[0]?.agent;
  if (primaryAgent && !agentRunner) {
    agentRuntimeState = 'error';
    agentRuntimeError = 'No agent backend available. Check baseagents config (no runners created).';
    primaryAgent.status = 'error';
    primaryAgent.error = agentRuntimeError;
    logger.error(agentRuntimeError);
  } else if (!primaryAgent) {
    logger.info('✓ Agent Runtime empty; no runners created');
  } else {
    logger.info(`✓ Runners ready (primary key: ${primaryRunnerKey}, total: ${agentMap.size}, keys: ${[...agentMap.keys()].join(', ')})`);
  }

  // 权限审批网关
  const permissionGateway = new PermissionGateway();
  permissionGateway.setEventBus(eventBus);

  // 交互路由器
  const interactionRouter = new InteractionRouter();

  // 为所有支持权限的 agent 设置 gateway
  for (const inst of agentInstances) {
    inst.agent.setPermissionGateway?.(permissionGateway);
  }

  // 创建消息缓存
  const messageCache = new MessageCache();
  logger.info('✓ Message cache initialized');

  // 定期清理过期消息（每小时）
  setInterval(() => {
    messageCache.cleanupExpired();
  }, 60 * 60 * 1000);

  // 渠道插件系统
  const channelLoader = new ChannelLoader();
  channelLoader.register(new FeishuChannelPlugin());
  channelLoader.register(new WechatChannelPlugin());
  channelLoader.register(new AUNChannelPlugin());
  channelLoader.register(new DingtalkChannelPlugin());
  channelLoader.register(new QQBotChannelPlugin());
  channelLoader.register(new WecomChannelPlugin());

  // Create channel instances: 每个 self-agent 各自的 channels
  const evolagentInstances: ChannelInstance[] = [];
  for (const agent of agentRegistry.runnableAgents()) {
    try {
      const instances = await channelLoader.createForAgent(agent);
      evolagentInstances.push(...instances);
    } catch (e) {
      logger.error(`[Agent ${agent.aid}] Failed to create channels: ${e}`);
      agent.status = 'error';
      agent.error = `Channel creation failed: ${e}`;
    }
  }

  const channelInstances = evolagentInstances;
  logger.info(`✓ Created ${channelInstances.length} channel instance(s)`);

  const bindService = evolclawCfg.aid
    ? new BindService({
        receiverAid: evolclawCfg.aid,
        getAvailableBaseagents: detectAvailableBaseagentsForBind,
        getUptimeSeconds: () => Math.floor(process.uptime()),
        onDaemonOwnersUpdated: (owners: string[]) => { processLevelOwners = owners; },
      })
    : null;
  bindService?.startCleanup();

  const agentDelegationRegistry = new AgentDelegationRegistry();

  // 创建命令处理器
  const cmdHandler = new CommandHandler(sessionManager, agentMap, messageCache, eventBus, primaryRunnerKey);
  cmdHandler.setAgentDelegationRegistry(agentDelegationRegistry);
  cmdHandler.setPermissionGateway(permissionGateway);
  cmdHandler.setInteractionRouter(interactionRouter);
  cmdHandler.setStatsCollector(statsCollector);

  // 创建消息处理器
  // 默认使用 ResponseEngine（插件化引擎）。
  // MessageProcessor（旧引擎）保留为参考真相，不删除但不再使用。
  const responseEngine = new ResponseEngine(
    agentMap,
    sessionManager,
    globalSettings,
    messageCache,
    eventBus,
    (content, channel, channelId, userId, threadId) => {
      const sendFn = async (id: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => {
        const adapter = cmdHandler.getAdapter(channel);
        if (!adapter) return;
        if (text) {
          await adapter.send(
            buildEnvelope({ channel: adapter.channelName, channelId: id, replyContext: opts }),
            { kind: 'system.notice', text, subtype: 'health' }
          );
        }
      };
      return cmdHandler.handle(content, channel, channelId, sendFn, userId, threadId);
    },
    primaryRunnerKey
  );
  responseEngine.setAgentDelegationRegistry(agentDelegationRegistry);
  const processor: IMessageProcessor = responseEngine;

  // 回填 processor 和 messageQueue 的引用
  cmdHandler.setProcessor(processor);

  // Inject EvolAgentRegistry (methods added by T6/T7)
  if ((processor as any).setAgentRegistry) {
    (processor as any).setAgentRegistry(agentRegistry);
  }
  if ((cmdHandler as any).setAgentRegistry) {
    (cmdHandler as any).setAgentRegistry(agentRegistry);
  }

  // 设置交互路由器
  processor.setInteractionRouter(interactionRouter);

  // 设置 compact 开始回调（对所有支持的 agent）
  for (const inst of agentInstances) {
    inst.agent.setCompactStartCallback?.((sessionId: string) => {
      processor.handleCompactStart(sessionId);
    });
  }

  // 创建消息队列
  const messageQueue = new MessageQueue(async (message) => {
    await processor.processMessage(message);
  }, {
    persistencePath: path.join(resolvePaths().dataDir, 'message-queue.json'),
  });

  // 设置中断回调（精确中断正在处理的 agent）
  messageQueue.setInterruptCallback(async (sessionKey, baseagent, evolagentName) => {
    const effectiveBaseagent = baseagent || primaryBaseagent;
    const evol = evolagentName || primaryAgent?.aid;
    if (!evol) return;
    const agent = agentMap.get(`${evol}::${effectiveBaseagent}`)
      || agentMap.get(primaryRunnerKey);
    if (agent) {
      await agent.interrupt(sessionKey);
    }
  });
  messageQueue.setEventBus(eventBus);

  // 进程退出时立即刷盘队列状态（防止 debounce 期间的消息丢失）
  onShutdown(() => messageQueue.persistQueuesImmediate());

  // 回填 messageQueue 引用
  cmdHandler.setMessageQueue(messageQueue);
  processor.setMessageQueue(messageQueue);

  // Trigger runtime: daemon-level script + feedback scheduler.
  const triggerSchedulers = new Map<string, TriggerRuntimeScheduler>();
  const triggerAudit = new TriggerAuditLogger();
  const triggerScriptExecutor = new TriggerScriptExecutor();
  const daemonChannel = new DaemonChannel(sessionManager, messageQueue, {
    watchdogMs: daemonConversationWatchdogMs(globalSettings),
  });
  const triggerStartupAgents = [...agentRegistry.runnableAgents()];
  const controlAid = evolclawCfg.aid || '__daemon__';
  const daemonTriggerOwner = {
    aid: triggerStartupAgents.some(agent => agent.aid === controlAid) ? `${controlAid}#daemon` : controlAid,
    originPeerId: controlAid,
    baseagent: primaryAgent?.baseagent || 'codex',
    projectPath: primaryAgent?.projectPath || process.cwd(),
  };
  const getTriggerChannel = (agentAid: string, channelKey: string) => {
    if (agentAid === daemonTriggerOwner.aid && channelKey === daemonChannel.channelKey) {
      return {
        adapter: daemonChannel,
        agentAid,
        agentName: daemonTriggerOwner.aid,
        projectPath: daemonTriggerOwner.projectPath,
        baseagent: daemonTriggerOwner.baseagent,
      };
    }
    const agent = agentRegistry.get(agentAid);
    if (!agent) return undefined;
    const inst = channelInstances.find((candidate) => (
      candidate.adapter.channelKey === channelKey
      || candidate.adapter.channelName === channelKey
    ));
    const parsed = inst ? tryParseChannelKey(inst.adapter.channelKey) : null;
    if (inst && parsed?.selfAID !== agentAid) return undefined;
    if (!inst) return undefined;
    return {
      adapter: inst.adapter,
      agentAid,
      agentName: agent.aid,
      projectPath: agent.projectPath,
      baseagent: agent.baseagent,
    };
  };
  const validateTriggerFeedbackChannels = (definition: TriggerDefinition) => {
    if (definition.feedback.strategy === 'silent') return;
    const target = definition.feedback.strategy === 'target'
      ? definition.feedback.target
      : definition.origin;
    if (target && !getTriggerChannel(definition.agentAid, target.channelKey)) {
      throw new Error(`agent ${definition.agentAid} has no configured channel ${target.channelKey}`);
    }
  };
  const definitionWithActorOrigin = async (rawDefinition: unknown, actorSessionId: unknown): Promise<unknown> => {
    if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) return rawDefinition;
    const definition = rawDefinition as Record<string, unknown>;
    let actorOrigin: TriggerDefinition['origin'] | undefined;
    if (typeof actorSessionId === 'string' && actorSessionId) {
      const actorSession = await sessionManager.getSessionById(actorSessionId);
      actorOrigin = actorSession ? originFromActorSession(actorSession) : undefined;
    }
    if (actorOrigin) return { ...definition, origin: actorOrigin };
    if (hasOriginIdentity(definition.origin)) return definition;
    return definition;
  };
  const startTriggerScheduler = async (owner: { aid: string; baseagent: string; projectPath: string }, opts: { seedUpgradeCheck?: boolean } = {}) => {
    triggerSchedulers.get(owner.aid)?.stop();
    const manager = new TriggerDefinitionManager(owner.aid);
    if (opts.seedUpgradeCheck) {
      seedUpgradeCheckTrigger(manager, owner);
    } else {
      removeLegacyAgentUpgradeCheck(manager);
    }
    const state = new TriggerRunStateStore(manager);
    const dispatcher = new TriggerFeedbackDispatcher({
      getChannel: getTriggerChannel,
      sessionManager,
      messageQueue,
      eventBus,
    });
    const scheduler = new TriggerRuntimeScheduler(
      manager,
      state,
      triggerAudit,
      triggerScriptExecutor,
      dispatcher,
      daemonChannel,
      {
        projectPath: owner.projectPath,
        baseagent: owner.baseagent,
        getBaseagent: () => agentRegistry.get(owner.aid)?.baseagent || owner.baseagent,
      },
      eventBus,
    );
    triggerSchedulers.set(owner.aid, scheduler);
    try {
      await scheduler.init();
    } catch (err) {
      logger.error(`[Trigger] Scheduler init failed for ${owner.aid}: ${err}`);
    }
  };
  cmdHandler.setTriggerSchedulerResolver((agentAid) => triggerSchedulers.get(agentAid));
  const startedTriggerAgents = new Set<string>();
  const ensureTriggerSchedulerStarted = async (agent: typeof triggerStartupAgents[number]) => {
    if (startedTriggerAgents.has(agent.aid)) return;
    startedTriggerAgents.add(agent.aid);
    await startTriggerScheduler(agent);
  };
  const ensureDaemonTriggerSchedulerStarted = async () => {
    if (startedTriggerAgents.has(daemonTriggerOwner.aid)) return;
    startedTriggerAgents.add(daemonTriggerOwner.aid);
    await startTriggerScheduler(daemonTriggerOwner, { seedUpgradeCheck: true });
  };

  // 默认策略
  const defaultPolicy = {
    canSwitchProject: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    canListProjects: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    canCreateSession: () => true,
    canDeleteSession: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    canImportCliSession: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    messagePrefix: () => '',
    showMiddleResult: () => true,
    showIdleMonitor: () => true,
    accumulateErrors: () => true,
  };

  processor.registerChannel(daemonChannel, defaultPolicy, { channelType: 'daemon' });
  cmdHandler.registerAdapter(daemonChannel);
  cmdHandler.registerChannel(daemonChannel.channelName, daemonChannel, 'daemon');

  // ── MessageBridge：Channel ↔ Core 消息桥梁 ──

  const defaultProjectPath = primaryAgent?.projectPath
    ?? defaults.projects?.defaultPath
    ?? path.join(paths.root, 'projects', 'default');
  const msgBridge = new MessageBridge(defaultProjectPath, sessionManager, processor, messageQueue, cmdHandler, eventBus, primaryAgent?.config.debounce);
  msgBridge.setAgentRegistry(agentRegistry);
  const bootstrapService = new BootstrapService(agentRegistry, eventBus);
  msgBridge.setBootstrapService(bootstrapService);

  // ── Channel instance registration (shared by startup and hot-load) ──

  function registerChannelInstance(inst: ChannelInstance): void {
    // 0. 包装 adapter.send，记录所有出站到 channel-out.log
    const originalSend = inst.adapter.send.bind(inst.adapter);
    inst.adapter.send = async (envelope: any, payload: any) => {
      logger.channelOut({ channel: inst.adapter.channelName, channelId: envelope.channelId, taskId: envelope.taskId, payload: summarizeOutboundPayload(payload) });
      const result = await originalSend(envelope, payload);
      if (shouldCountSentPayload(payload)) {
        const owningAgent = agentRegistry.resolveByChannel(inst.adapter.channelKey)
          ?? agentRegistry.resolveByChannel(inst.adapter.channelName);
        if ((inst.channelType || inst.adapter.channelName) !== 'aun') {
          try {
            const logPayload = outboundPayloadToLogText(payload);
            const session = envelope.sessionId
              ? await sessionManager.getSessionById(envelope.sessionId)
              : sessionManager.getActiveSessionSync(envelope.channel ?? inst.adapter.channelName, envelope.channelId, inst.channelType || inst.adapter.channelName, owningAgent?.aid);
            if (logPayload && session) {
              const chatDir = sessionManager.getChatDir(session);
              const isGroup = session.chatType === 'group';
              const target = isGroup
                ? (session.metadata?.groupId || session.channelId)
                : (session.metadata?.peerId || envelope.channelId);
              appendMessageLog(chatDir, buildOutboundEntry({
                from: owningAgent?.aid ?? envelope.agentName ?? session.selfAID ?? 'self',
                to: String(target || envelope.channelId),
                chatType: isGroup ? 'group' : 'private',
                groupId: isGroup ? String(session.metadata?.groupId || session.channelId) : null,
                msgId: `${envelope.taskId || 'out'}_${Date.now()}`,
                content: logPayload.text,
                replyTo: envelope.replyContext?.replyToMessageId ?? null,
                agent: session.baseagent ?? null,
                model: null,
                durationMs: null,
                msgType: logPayload.msgType,
                source: normalizeMessageSource(envelope.replyContext?.metadata?.source),
                chatmode: envelope.chatmode,
              }));
            }
          } catch (err) {
            logger.debug(`[MessageLog] Failed to write outbound channel log: ${err}`);
          }
        }
        eventBus.publish({
          type: 'message:sent',
          sessionId: envelope.sessionId ?? envelope.taskId ?? `out-${Date.now()}`,
          channel: envelope.channel ?? inst.adapter.channelName,
          channelName: inst.adapter.channelName,
          channelId: envelope.channelId,
          agentName: owningAgent?.aid ?? envelope.agentName,
          payloadKind: payload.kind,
          timestamp: Date.now(),
        });
      }
      return result;
    };

    // 1. 项目路径提供器
    if (inst.onProjectPathRequest && inst.channel.onProjectPathRequest) {
      inst.channel.onProjectPathRequest(async (channelId: string) => {
        // Effective default path: use the agent that owns this channel.
        const owningAgent = agentRegistry.resolveByChannel(inst.adapter.channelKey);
        const effectiveDefault = owningAgent?.projectPath
          ?? defaultProjectPath;
        const parsedKey = tryParseChannelKey(inst.adapter.channelKey);
        const session = await sessionManager.getOrCreateSession(
          inst.adapter.channelKey, channelId,
          effectiveDefault,
          undefined, undefined, undefined, undefined, undefined,
          owningAgent?.baseagent,
          parsedKey?.selfAID, parsedKey?.type
        );
        return path.isAbsolute(session.projectPath)
          ? session.projectPath
          : path.resolve(process.cwd(), session.projectPath);
      });
    }

    // 2. 注册 adapter、policy 和 options（注入 channelType）
    const opts = inst.channelType
      ? { ...inst.options, channelType: inst.channelType }
      : inst.options;
    processor.registerChannel(inst.adapter, inst.policy || defaultPolicy, opts);
    cmdHandler.registerAdapter(inst.adapter);
    cmdHandler.registerChannel(inst.adapter.channelName, inst.channel, inst.channelType);
    if (inst.policy) {
      cmdHandler.registerPolicy(inst.adapter.channelName, inst.policy);
    }

    // 3. 交互回调
    if (inst.adapter.onInteraction) {
      inst.adapter.onInteraction((response) => {
        interactionRouter.handle(response);
      });
    }

    // 4. MessageBridge 注册
    const channelType = inst.channelType || inst.adapter.channelName;
    if (inst.registerBridge) {
      inst.registerBridge(msgBridge, channelType);
    }

    // 4b. 生命周期钩子
    if (inst.registerHooks) {
      inst.registerHooks({ eventBus, sessionManager });
    }

    // 4c. 观察者模式配置读取器（AUN）：从 EvolAgent 的 merged config 读 observable/owners，
    // 不另建缓存——EvolAgent 那份在启动/重启/热重载时统一更新，是唯一真相源。
    const channelForObserver = inst.channel as { setObserverConfigResolver?: (fn: () => { observable: boolean; owners: string[] }) => void };
    if (typeof channelForObserver.setObserverConfigResolver === 'function') {
      const channelKey = inst.adapter.channelKey;
      channelForObserver.setObserverConfigResolver(() => {
        const owningAgent = agentRegistry.resolveByChannel(channelKey);
        return {
          observable: owningAgent?.getObservable() ?? false,
          owners: owningAgent ? Array.from(new Set(owningAgent.config.owners ?? [])) : [],
        };
      });
    }

    // 5. 撤回消息 → 中断执行中任务
    inst.channel.onRecall?.((messageId: string) => {
      msgBridge.cancel(messageId);
    });
  }

  // ── 注册所有渠道实例 ──
  for (const inst of channelInstances) {
    registerChannelInstance(inst);
  }

  // Bind adapters to their owning agents and mark running
  for (const inst of channelInstances) {
    const agent = agentRegistry.resolveByChannel(inst.adapter.channelKey);
    if (!agent || agent.status === 'error') continue;
    agent.channels.set(inst.adapter.channelKey, inst.adapter);
    const hasRunner = agentInstances.some(runner => runner.evolagentName === agent.aid);
    if (agent.status === 'stopped' && hasRunner) {
      agent.status = 'running';
    }
  }
  if (agentRegistry.list().some((info: any) => info.status === 'running')) {
    agentRuntimeState = 'running';
    agentRuntimeError = undefined;
  } else if (agentRegistry.runnableAgents().length === 0 && agentRegistry.list().length === 0) {
    agentRuntimeState = 'empty';
  } else if (agentRuntimeState === 'starting') {
    agentRuntimeState = 'error';
    agentRuntimeError = agentRuntimeError ?? 'No runnable self-agent reached running state.';
  }

  // ── 配置快照 + 启动日志（启动完毕锚点，网络无关）──────────────────
  try {
    const wv = readWVersion();
    const isDiagnoseMode = process.env.EVOLCLAW_DIAGNOSE === '1';

    // P2: W≠w-version → 自动建版本（新版本 → current + w-version 自动更新）
    //     自检模式下已由 selfDiagnose 处理，跳过（避免重复保存刚展开的回落版本）
    let startupVersion = wv;
    if (!isDiagnoseMode && wv) {
      const diff = diffWorkingVsVersion(wv.delta);
      const hasChanges = !('error' in diff) && (diff.modified.length + diff.added.length + diff.deleted.length) > 0;
      if (hasChanges) {
        const r = configSnapshot('startup');
        if (r.created) startupVersion = readWVersion(); // P2 产生了新版本，w-version 已更新
      }
    }

    // P3/回落成功：W==w-version → successCount++
    if (startupVersion) {
      incrementSuccessCount(startupVersion.delta);
    }

    // boot-log
    const startMethod = process.env.EVOLCLAW_DIAGNOSE === '1' ? 'diagnose'
      : (process.env.EVOLCLAW_LAUNCHED_BY === 'start' ? 'manual' : 'auto');
    appendBootLog({
      bootedAt: new Date().toISOString(),
      startMethod: startMethod as any,
      selectedVersion: readCurrent(),
      actualVersion: startupVersion,
      fellBack: !!(isDiagnoseMode && startupVersion && readCurrent()?.delta !== startupVersion.delta),
      versions: { evolclaw: readEvolclawVersion(), '@agentunion/fastaun': readFastaunVersion(), node: process.version },
      platform: `${process.platform}/${process.arch}`,
    });
    retentionCleanup();
  } catch (e) {
    logger.warn(`[config] startup snapshot/boot-log failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  // 预填充 Feishu 已知 thread_id（重启后避免误判话题创建）。
  // 必须早于 connect()，后台连接后 Feishu 可能立即收到消息。
  for (const inst of channelInstances) {
    const channelType = inst.channelType || inst.adapter.channelName;
    if (channelType === 'feishu' && 'preloadThreads' in inst.channel) {
      const threadIds = sessionManager.getKnownThreadIds(inst.adapter.channelKey);
      (inst.channel as any).preloadThreads(threadIds);
    }
  }

  const connectedChannels = new Set<string>();
  const onlineNoticeSent = new Set<string>();
  const pendingFile = path.join(resolvePaths().dataDir, 'restart-pending.json');
  let pendingRestartNoticeInFlight: Promise<void> | null = null;
  let pendingRestartNoticeSent = false;

  const sendOnlineNoticeForChannel = (inst: ChannelInstance): void => {
    const name = inst.adapter.channelName;
    const agent = agentRegistry.resolveByChannel(inst.adapter.channelKey) ?? agentRegistry.resolveByChannel(name);
    if (!agent) return;
    if (!agent.config.debug?.upmsg) return;
    const ownerAid = getFirstStaticAgentOwner(agent.aid);
    if (!ownerAid) return;
    const noticeKey = `${agent.aid}#${name}`;
    if (onlineNoticeSent.has(noticeKey)) return;
    onlineNoticeSent.add(noticeKey);

    setTimeout(() => {
      const adapter = agent.channels.get(inst.adapter.channelKey) ?? agent.channels.get(name);
      if (!adapter) return;
      let agentName = agent.aid;
      try {
        const mdPath = agentMdPath(agent.aid);
        const content = fs.readFileSync(mdPath, 'utf-8');
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)/m);
        if (nameMatch) agentName = nameMatch[1].trim().replace(/"$/, '');
      } catch {}
      const projectDir = path.basename(agent.projectPath);
      const text = `✓ ${agentName} 已上线 | 工作目录: ${projectDir}`;
      const envelope = buildEnvelope({
        taskId: `system-online-${crypto.randomBytes(5).toString('hex')}`,
        channel: adapter.channelName,
        channelId: ownerAid,
        agentName,
      });
      sendSystemPayload(adapter, envelope, {
        kind: 'system.notice',
        text,
        subtype: 'restarted',
      }).catch(() => {});
    }, 1000 + Math.random() * 2000);
  };

  const trySendPendingRestartNotice = async (): Promise<void> => {
    if (pendingRestartNoticeSent) return;
    if (pendingRestartNoticeInFlight) {
      try {
        await pendingRestartNoticeInFlight;
      } catch {
        // The first caller logs the actual send/read error.
      }
      return;
    }
    if (!fs.existsSync(pendingFile)) return;

    pendingRestartNoticeInFlight = (async () => {
      if (pendingRestartNoticeSent) return;
      if (!fs.existsSync(pendingFile)) return;

      const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
      const adapter = cmdHandler.getAdapter(pending.channel)
        ?? channelInstances.find(inst => inst.adapter.channelKey === pending.channel)?.adapter;
      if (!adapter) return;
      if (!connectedChannels.has(pending.channel)
        && !connectedChannels.has(adapter.channelName)
        && !connectedChannels.has(adapter.channelKey)) {
        logger.info(`[Restart] Pending notification waits for channel connection: ${pending.channel}`);
        return;
      }
      const replyContext = pending.rootId
        ? { replyToMessageId: pending.rootId, replyInThread: !!pending.threadId }
        : undefined;
      const owningAgent = agentRegistry.resolveByChannel(adapter.channelKey);
      const envelope = buildEnvelope({
        taskId: `system-restart-${process.pid}`,
        channel: adapter.channelKey,
        channelId: pending.channelId,
        agentName: owningAgent?.aid || 'evolclaw',
        replyContext,
      });
      await sendSystemPayload(adapter, envelope, {
        kind: 'system.notice',
        text: '✅ 服务重启成功！',
        subtype: 'restarted',
      });
      pendingRestartNoticeSent = true;
      fs.rmSync(pendingFile, { force: true });
      logger.info(`[Restart] Notification sent via ${pending.channel}`);
    })();

    try {
      await pendingRestartNoticeInFlight;
    } catch (e) {
      logger.error('[Restart] Failed to send restart notification:', e);
    } finally {
      pendingRestartNoticeInFlight = null;
    }
  };

  const summarizeConnectedChannels = (connected: string[]): string => {
    const connectedTypeCount = new Map<string, number>();
    const typeOrder: string[] = [];
    for (const inst of channelInstances) {
      const name = inst.adapter.channelName;
      if (!connected.includes(name)) continue;
      const type = inst.channelType || name;
      if (!connectedTypeCount.has(type)) {
        connectedTypeCount.set(type, 0);
        typeOrder.push(type);
      }
      connectedTypeCount.set(type, connectedTypeCount.get(type)! + 1);
    }
    return typeOrder
      .map(type => {
        const n = connectedTypeCount.get(type)!;
        return n === 1 ? type : `${type}×${n}`;
      })
      .join(', ');
  };

  const markChannelConnected = async (inst: ChannelInstance): Promise<void> => {
    const name = inst.adapter.channelName;
    const key = inst.adapter.channelKey;
    if (connectedChannels.has(name)) return;
    connectedChannels.add(name);
    connectedChannels.add(key);

    const type = inst.channelType || name;
    eventBus.publish({
      type: 'channel:connected',
      channel: type.toLowerCase(),
      channelName: name,
      timestamp: Date.now()
    });

    // Run async operations in parallel
    const agent = agentRegistry.resolveByChannel(inst.adapter.channelKey) ?? agentRegistry.resolveByChannel(name);
    await Promise.all([
      bootstrapService.tryStartBootstrap({
        adapter: inst.adapter,
        channelKey: inst.adapter.channelKey,
        channelType: inst.channelType || type,
        source: 'connected',
      }),
      agent ? ensureTriggerSchedulerStarted(agent) : Promise.resolve(),
      Promise.resolve().then(() => sendOnlineNoticeForChannel(inst)),
      trySendPendingRestartNotice(),
    ]);
  };
  const markChannelDisconnected = (channelName: string): void => {
    connectedChannels.delete(channelName);
    const inst = channelInstances.find(candidate => candidate.adapter.channelName === channelName);
    if (inst) connectedChannels.delete(inst.adapter.channelKey);
  };

  // ── 连接所有渠道（后台首连，AUN/任意渠道故障不阻塞 daemon 主流程）──
  logger.info(`🚀 EvolClaw core is ready; connecting ${channelInstances.length} channel(s) in background`);
  const connectAllPromise = channelLoader.connectAll(channelInstances, {
    concurrency: 10,
    onConnected: markChannelConnected,
    onFailed: (inst, error) => {
      logger.warn(`[startup] ${inst.adapter.channelName} initial connect failed: ${error}`);
    },
  });

  connectAllPromise.then((connected) => {
    const channelSummary = summarizeConnectedChannels(connected);
    logger.info(`✅ ${connected.length} channel(s) connected: ${channelSummary}`);
    eventBus.publish({
      type: 'system:started',
      channels: connected.map(c => c.toLowerCase()),
      timestamp: Date.now()
    });
  }).catch((e) => {
    logger.warn(`[startup] channel connection task failed unexpectedly: ${e}`);
  });

  // Trigger scheduler 与渠道连接解耦：cron 定时任务独立于渠道可用性运行
  // （触发时若渠道未连，发送侧自行排队/重试）。markChannelConnected 里的
  // ensureTriggerSchedulerStarted 仅作"尽早启动"优化，此处保证即使渠道首连
  // 全部失败（如 gateway 宕机），trigger 仍无条件启动。Set 去重，不会重复。
  ensureDaemonTriggerSchedulerStarted().catch((e) => {
    logger.warn(`[startup] daemon trigger scheduler start failed for ${daemonTriggerOwner.aid}: ${e}`);
  });
  for (const agent of triggerStartupAgents) {
    ensureTriggerSchedulerStarted(agent).catch((e) => {
      logger.warn(`[startup] trigger scheduler start failed for ${agent.aid}: ${e}`);
    });
  }

  // ── 控制 AID（daemon 进程身份）：pureIdentity 接入 AUN，独立于 evolagent ──
  // 证书缺失检测/生成在 CLI 侧（evolclaw start）完成。daemon 是后台进程无终端，
  // 这里只做兜底：证书缺失时 warn 并继续（AUNChannel 内部后台重连），绝不阻塞。
  if (evolclawCfg.aid) {
    const aunPath = resolvePaths().root;
    const certKey = path.join(aunPath, 'AIDs', evolclawCfg.aid, 'private', 'key.json');
    if (!fs.existsSync(certKey)) {
      logger.warn(`控制 AID 证书缺失：${evolclawCfg.aid}（AUN 控制通道后台重连；如需重建运行 evolclaw init）`);
    }
  }

  let controlChannel: AUNChannel | undefined;
  if (evolclawCfg.aid) {
    controlChannel = new AUNChannel({
      aid: evolclawCfg.aid,
      agentName: evolclawCfg.aid,
      channelName: 'control',
      pureIdentity: true,
      aunTrace: evolclawCfg.debug?.aunTrace ?? defaults.debug?.aunTrace,
      aunSdkLog: evolclawCfg.debug?.aunSdkLog ?? defaults.debug?.aunSdkLog,
    });
    // connect() 失败不置空实例：AUNChannel 内部有无限重连（SDK auto_reconnect +
    // scheduleReconnect），首连失败后台会自愈；保留实例供 status 显示 disconnected。
    try {
      await controlChannel.connect();
      logger.info(`✓ 控制 AID 已连接: ${evolclawCfg.aid}`);
    } catch (e: any) {
      logger.warn(`控制 AID 首连失败（后台自动重连，不影响 daemon 主流程）: ${e?.message || e}`);
    }

    // ── ECWeb 自动启动 ──
    // 如果 config.ecweb.enabled，自动拉起 ecweb 服务
    if (evolclawCfg.ecweb?.enabled) {
      const ecwebPath = path.join(resolvePaths().root, 'ecweb');
      const ecwebEntry = path.join(ecwebPath, 'dist', 'index.js');
      if (fs.existsSync(ecwebEntry)) {
        try {
          const ecwebProc = spawn('node', [ecwebEntry], {
            cwd: ecwebPath,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root }
          });
          ecwebProc.unref();
          logger.info(`✓ ECWeb 已启动 (PID: ${ecwebProc.pid})`);
          onShutdown(() => {
            try {
              if (ecwebProc.pid) platform.killProcess(ecwebProc.pid, true);
              logger.info(`✓ ECWeb 已停止`);
            } catch {}
          });
        } catch (e: any) {
          logger.warn(`ECWeb 启动失败: ${e?.message || e}`);
        }
      } else {
        logger.warn(`ECWeb 配置已启用但未找到 ${ecwebEntry}`);
      }
    }

    // 控制 AID 接收 owner 指令：
    // 1. /pair — ECWeb 配对码（文本快路径）
    // 2. menu.* JSON — 路由到 cmdHandler.execMenuForControl（进程级 + 全量权限）
    // 发送方身份由 AUN X.509 证书链验证，非 owner 完全静默。
    controlChannel.onMessage(async (opts) => {
      try {
        const text = (opts.content || '').trim();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        if (bindService && parsed?.type === 'bind.request') {
          const response = await bindService.handleRequest(parsed, opts.peerId);
          if (response) {
            // 用 sendStructured 直发 typed payload（payload.type='bind.response'），
            // 不能用 sendMessage——它会把内容包成 {type:'text', text:...}，App 无法识别。
            // encrypted 跟随入站请求：bind.response 与 bind.request 的加密/明文对称。
            await controlChannel!.sendStructured(
              opts.channelId,
              response as unknown as Record<string, any>,
              { metadata: { encrypted: opts.encrypted } },
            );
          }
          return;
        }
        const menuControl = parseMenuControl(text);
        if (menuControl.isMenu && !hasValidMenuId(menuControl)) {
          logger.warn(`[ControlMenu] dropped malformed request without id type=${menuControl.type}`);
          return;
        }
        if (menuControl.isMenu && !isProcessLevelOwner(opts.peerId, processLevelOwners)) {
          const response = menuFailure(
            { id: menuControl.id, ...(menuControl.name?.trim() ? { name: menuControl.name } : {}) },
            { code: 'ROLE_ACCESS_DENIED', message: 'Current identity cannot access the control channel' },
          );
          await controlChannel!.sendStructured(
            opts.channelId,
            response as unknown as Record<string, any>,
            { metadata: { encrypted: opts.encrypted } },
          );
          return;
        }
        if (!isProcessLevelOwner(opts.peerId, processLevelOwners)) {
          logger.debug(`控制 AID 收到非 owner 消息，忽略: from=${opts.peerId}`);
          return;
        }
        if (text.toLowerCase() === '/pair') {
          const port = evolclawCfg.ecweb?.port ?? 42705;
          const pair = await fetchEcwebPairCode(port);
          let reply: string;
          if (pair) {
            const mins = Math.max(0, Math.round((pair.expiresAt - Date.now()) / 60000));
            reply = `ECWeb 配对码：${pair.code}（约 ${mins} 分钟内有效）\n在浏览器打开 ECWeb 后输入此码登录`;
          } else {
            reply = 'ECWeb 未运行或暂不可达。请在主机运行 ec watch web 启动后重试。';
          }
          await controlChannel!.sendMessage(opts.channelId, reply);
          return;
        }
        // menu.* JSON 路由：owner 已在上方校验，转交 execMenuForControl（fromControlChannel=true）
        if (menuControl.isMenu) {
          const validationError = validateMenuRequest(menuControl.request);
          if (validationError) {
            await controlChannel!.sendStructured(
              opts.channelId,
              menuFailure(
                { id: menuControl.id, ...(menuControl.name?.trim() ? { name: menuControl.name } : {}) },
                validationError,
              ) as unknown as Record<string, any>,
              { metadata: { encrypted: opts.encrypted } },
            );
            return;
          }
          const deduped = await controlMenuDeduper.execute(
            [opts.channelId, opts.peerId, menuControl.id].join('\u001f'),
            menuPayloadFingerprint(menuControl.raw),
            () => cmdHandler.execMenuForControl(parsed, opts.peerId),
          );
          const response = 'conflict' in deduped
            ? menuFailure(
                { id: menuControl.id, ...(menuControl.name?.trim() ? { name: menuControl.name } : {}) },
                { code: 'CONFLICT', message: 'Request ID was already used with a different payload' },
              )
            : deduped.value;
          // 同 bind.response：sendStructured 直发 typed payload（payload.type='menu.response'），
          // 不能用 sendMessage（会包成 {type:'text',...}）；encrypted 跟随入站请求保持对称。
          await controlChannel!.sendStructured(
            opts.channelId,
            response as unknown as Record<string, any>,
            { metadata: { encrypted: opts.encrypted } },
          );
          return;
        }
        // owner 发的其他内容：提示可用指令
        await controlChannel!.sendMessage(opts.channelId, '可用指令：/pair（获取 ECWeb 登录配对码）');
      } catch (e: any) {
        logger.warn(`控制 AID 消息处理失败: ${e?.message || e}`);
      }
    });

    // ── Service Proxy：把本地服务（ecweb 等）通过控制 AID 暴露到 AUN 网络 ──
    // 挂在控制 AUNChannel 上，动态解引用其 client（规避重连换 client）。
    // 失败只 warn，不影响 daemon 主流程。
    if (evolclawCfg.serviceProxy?.enabled && evolclawCfg.aid) {
      // 短暂延迟确保控制 channel 完全就绪
      const channel = controlChannel;
      const aid = evolclawCfg.aid;
      const config = evolclawCfg.serviceProxy;
      setTimeout(() => {
        if (!channel) return;
        const proxyHandle = startServiceProxy(channel, aid, config);
        if (proxyHandle) {
          onShutdown(() => proxyHandle.stop());
        }
      }, 500);
    }
  }

  // 统一 channel:health 跨通道通知（仅 auth_error）
  // 按 (channelType, ownerId) 去重，避免同类型多实例重复通知
  eventBus.subscribe('channel:error', (event) => {
    if (event.type !== 'channel:error' || event.status !== 'auth_error') return;
    const sourceChannelType = event.channel;
    const sourceChannelName = (event as any).channelName || sourceChannelType;
    const msg = event.message;
    logger.error(`[ChannelHealth] ${sourceChannelName} auth_error: ${msg}`);

    const notified = new Set<string>();  // channelType 去重（同类型只通知一次）
    for (const other of channelInstances) {
      const otherType = other.channelType || other.adapter.channelName;
      if (otherType === sourceChannelType) continue;  // 跳过同类型通道
      if (notified.has(otherType)) continue;  // 同类型已通知过
      const owningAgent = agentRegistry.resolveByChannel(other.adapter.channelKey);
      const ownerId = owningAgent
        ? getFirstStaticAgentOwner(owningAgent.aid)
        : undefined;
      if (!ownerId) continue;
      notified.add(otherType);
      const envelope = buildEnvelope({
        taskId: `system-channel-down-${crypto.randomBytes(5).toString('hex')}`,
        channel: other.adapter.channelKey,
        channelId: ownerId,
        agentName: owningAgent?.aid || 'evolclaw',
      });
      sendSystemPayload(other.adapter, envelope, {
        kind: 'system.error',
        text: msg,
        subtype: 'channel_down',
        recoverable: false,
      }).catch(err => {
        logger.error(`[ChannelHealth] Failed to notify ${other.adapter.channelName} owner:`, err);
      });
    }
  });

  // 先恢复消息队列。若某个 session 有原始 active/pending 消息，下面的泛化 resume 会跳过它。
  messageQueue.restorePersisted(true);

  // 恢复重启前未完成的会话。这里是兜底路径：仅当队列文件没有原始消息时，才注入恢复提示。
  const pendingSessions = sessionManager.getPendingProcessingSessions();
  if (pendingSessions.length > 0) {
    logger.info(`[Resume] Found ${pendingSessions.length} pending session(s) from before restart`);
    for (const session of pendingSessions) {
      if (messageQueue.isProcessing(session.id) || messageQueue.getQueueLength(session.id) > 0) {
        logger.info(`[Resume] session ${session.id}: persisted queue already restored, skipping generic resume`);
        continue;
      }
      if (!session.agentSessionId) {
        sessionManager.clearProcessing(session.id);
        continue;
      }
      // 复合键：${aid}::${baseagent}，从 channel 反查 self-agent
      const owningAgent = agentRegistry.resolveByChannel(session.channel);
      if (!owningAgent) {
        logger.warn(`[Resume] session ${session.id}: channel "${session.channel}" not routable, skipping`);
        sessionManager.clearProcessing(session.id);
        continue;
      }
      const evolName = owningAgent.aid;
      const baseagentName = session.baseagent || primaryBaseagent;
      const agent = agentMap.get(`${evolName}::${baseagentName}`) || agentMap.get(primaryRunnerKey);
      if (!agent) {
        sessionManager.clearProcessing(session.id);
        continue;
      }
      logger.info(`[Resume] Resuming session: ${session.id} (agent: ${evolName}::${baseagentName})`);
      const parsedResumeKey = tryParseChannelKey(session.channel);
      const resumeSelfAID = session.selfAID || parsedResumeKey?.selfAID;
      const resumeMessage: Message = {
        channel: session.channel,
        channelType: session.channelType || parsedResumeKey?.type,
        selfAID: resumeSelfAID,
        channelId: session.channelId,
        content: '服务已重启，请继续之前未完成的任务。',
        timestamp: Date.now(),
        peerId: '',
        threadId: session.threadId || undefined,
        replyContext: (session.metadata as any)?.replyContext,
      };
      // 清除状态后入队（processMessage 会重新标记）
      sessionManager.clearProcessing(session.id);
      messageQueue.enqueue(session.id, resumeMessage, session.projectPath, { sessionKeyField: session.sessionKey, selfAID: resumeSelfAID }).catch(err => {
        logger.error(`[Resume] Failed to resume session ${session.id}:`, err);
      });
    }
  }

  // IPC server — 供 CLI 查询实时状态 + Agent ctl 指令执行
  const ipcServer = new IpcServer(resolvePaths().socket, (): IpcStatusResponse => {
    const channels: Record<string, ChannelStatus> = {};
    const channelsByType: Record<string, string[]> = {};
    for (const inst of channelInstances) {
      const name = inst.adapter.channelName;
      const status = inst.channel.getStatus?.() ?? { connected: true };
      const channelType = inst.channelType || name;
      channels[name] = { ...status, channelType };
      if (!channelsByType[channelType]) channelsByType[channelType] = [];
      channelsByType[channelType].push(name);
    }
    const snap = statsCollector.getSnapshot();
    const agentListForStatus = agentRegistry.list();
    return {
      pid: process.pid,
      uptime: snap.uptimeMs,
      controlPlane: {
        ready: true,
        owned: processLevelOwners.length > 0,
      },
      agentRuntime: {
        state: agentRuntimeState,
        runnableAgents: agentListForStatus.filter((a: any) => a.status !== 'error' && a.status !== 'disabled').length,
        runningAgents: agentListForStatus.filter((a: any) => a.status === 'running').length,
        ...(agentRuntimeError ? { error: agentRuntimeError } : {}),
      },
      channels,
      channelsByType,
      queue: {
        pending: messageQueue.getGlobalQueueLength(),
        processing: messageQueue.getGlobalProcessingCount(),
      },
      stats: {
        received: snap.lastHour.received,
        sent: snap.lastHour.sent,
        completed: snap.lastHour.completed,
        errors: snap.lastHour.errors,
        avgResponseMs: snap.lastHour.avgResponseMs,
      },
      controlAid: evolclawCfg.aid
        ? { aid: evolclawCfg.aid, connected: controlChannel?.getAidState().status === 'connected' }
        : undefined,
    };
  }, async (cmd, sessionId) => cmdHandler.handleCtl(cmd, sessionId));

  // M3: direct call (not cast) — wire EvolAgentRegistry into IPC for evolagent.* handlers
  ipcServer.setAgentRegistry(agentRegistry);
  ipcServer.setMenuExecutor((payload) => cmdHandler.execMenuForEcweb(payload));
  ipcServer.setConfigOperationExecutor((argv, sessionId, delegationToken) =>
    cmdHandler.handleConfigOperation(argv, sessionId, delegationToken));
  cmdHandler.setDaemonStatusProvider(() => {
    const aidState = controlChannel?.getAidState?.();
    return {
      aid: evolclawCfg.aid ?? null,
      aun: aidState ? {
        connected: aidState.status === 'connected',
        status: aidState.status,
        reconnectCount: aidState.reconnectCount ?? 0,
        flapCount: aidState.flapCount ?? 0,
        ...(aidState.lastError ? { lastError: String(aidState.lastError).slice(0, 80) } : {}),
        ...(aidState.kickDetail?.reason ? { kickReason: String(aidState.kickDetail.reason).slice(0, 80) } : {}),
      } : {
        connected: false,
        status: evolclawCfg.aid ? 'disconnected' : 'disabled',
      },
    };
  });
  if (bindService) {
    ipcServer.setBindExecutor({
      begin: (cmd) => bindService.begin(cmd),
      status: (taskId) => bindService.status(taskId),
      cancel: (taskId) => bindService.cancel(taskId),
    });
  }

  // 注入 AUN AID 状态聚合器：遍历所有 aun 类型 channel，调 getAidState() 收集
  ipcServer.setAunAidProvider(() => {
    const out: import('./types.js').AidConnectionState[] = [];
    for (const inst of channelInstances) {
      if (inst.channelType !== 'aun') continue;
      const ch = inst.channel as any;
      if (typeof ch?.getAidState === 'function') {
        try {
          const aidState = ch.getAidState();
          // 增强：添加队列状态
          const agentName = aidState.agentName || aidState.aid;
          const processing = messageQueue.getProcessingCountByAgent(agentName);
          const queued = messageQueue.getQueueLengthByAgent(agentName);
          out.push({
            ...aidState,
            queueStatus: { processing, queued }
          });
        } catch { /* ignore */ }
      }
    }
    return out;
  });

  // 注入 Per-AID 统计收集器到所有 AUN channel 实例
  for (const inst of channelInstances) {
    if (inst.channelType !== 'aun') continue;
    const ch = inst.channel as any;
    if (typeof ch?.setAidStatsCollector === 'function') {
      ch.setAidStatsCollector(aidStatsCollector);
    }
  }

  // 注入 Per-AID 统计 IPC provider
  aidStatsCollector.setQueueStatsProvider((agentName: string) => ({
    processing: messageQueue.getProcessingCountByAgent(agentName),
    queued: messageQueue.getQueueLengthByAgent(agentName),
    muted: messageQueue.isAgentMuted(agentName),
  }));
  ipcServer.setAunAidStatsProvider(() => aidStatsCollector.getAllSnapshots());
  ipcServer.setAunAidStatsRecorder((params) => {
    aidStatsCollector.recordOutbound(
      params.aid,
      params.toPeer,
      Buffer.byteLength(params.text || '', 'utf-8'),
      params.text,
      false,
      params.encrypt,
      params.chatmode,
      'send',
    );
  });
  ipcServer.setTaskRuntimeContextProvider(({ sessionId }) => responseEngine.getTaskRuntimeContext(sessionId));
  ipcServer.setAunMsgSender(async (params) => {
    const inst = channelInstances.find((candidate) => {
      if (candidate.channelType !== 'aun') return false;
      const ch = candidate.channel as any;
      try {
        const aidState = typeof ch?.getAidState === 'function' ? ch.getAidState() : null;
        if (aidState?.aid === params.aid) return true;
        if (typeof ch?.getAid === 'function' && ch.getAid() === params.aid) return true;
      } catch { /* ignore */ }
      return false;
    });
    const ch = inst?.channel as any;
    if (!ch || typeof ch.sendDaemonMsg !== 'function') {
      return { ok: false, error: `AUN channel not found for ${params.aid}`, code: 'AUN_CHANNEL_NOT_FOUND' };
    }
    return await ch.sendDaemonMsg({
      to: params.to,
      payload: params.payload,
      encrypt: params.encrypt,
      log: params.log,
    });
  });

  // ── Reload hooks: enable agentRegistry.reload() to drain/disconnect/restart channels ──
  const reloadHooks: ReloadHooks = buildReloadHooks({
    channelLoader,
    channelInstances,
    registerChannelInstance,
    unregisterChannelInstance: (channelName: string) => {
      markChannelDisconnected(channelName);
      processor.unregisterChannel(channelName);
      cmdHandler.unregisterChannel(channelName);
      msgBridge.removeChannel(channelName);
    },
    onChannelStarted: (inst: ChannelInstance) => {
      // startChannel 重建渠道时重新注入 AidStatsCollector（与 hot-load 路径对齐）
      if (inst.channelType === 'aun') {
        const ch = inst.channel as any;
        if (typeof ch?.setAidStatsCollector === 'function') ch.setAidStatsCollector(aidStatsCollector);
      }
    },
    onChannelConnected: markChannelConnected,
    messageQueue,
  });

  // Make reload hooks accessible to IPC handler & ctl handler (both run in this process)
  (globalThis as any).__evolclaw_reloadHooks = reloadHooks;

  // Hot-load handler: dynamically add a new agent at runtime
  (globalThis as any).__evolclaw_hotLoadAgent = async (aid: string) => {
    agentRuntimeState = 'starting';
    agentRuntimeError = undefined;
    const agent = agentRegistry.loadNewAgent(aid);
    if (!agent) {
      agentRuntimeState = agentRegistry.runnableAgents().length > 0 ? 'running' : 'error';
      agentRuntimeError = `Failed to load agent ${aid}`;
      throw new Error(agentRuntimeError);
    }

    const newAgentInstances = agentLoader.createForAgent(agent, {
      onSessionIdUpdate: async (sessionId: string, agentSessionId: string) => {
        await sessionManager.updateAgentSessionIdBySessionId(sessionId, agentSessionId);
      },
    });
    for (const inst of newAgentInstances) {
      agentMap.set(`${inst.evolagentName}::${inst.baseagent}`, inst.agent);
      inst.agent.setPermissionGateway?.(permissionGateway);
      inst.agent.setCompactStartCallback?.((sessionId: string) => {
        processor.handleCompactStart(sessionId);
      });
    }
    if (newAgentInstances.length === 0) {
      agent.status = 'error';
      agent.error = 'No baseagent runner created for hot-loaded agent';
      agentRuntimeState = 'error';
      agentRuntimeError = agent.error;
      throw new Error(agent.error);
    }

    // 创建 channels
    const instances = await channelLoader.createForAgent(agent);
    for (const inst of instances) {
      registerChannelInstance(inst);
      if (inst.channelType === 'aun') {
        const ch = inst.channel as any;
        if (typeof ch?.setAidStatsCollector === 'function') ch.setAidStatsCollector(aidStatsCollector);
      }
      agent.channels.set(inst.adapter.channelKey, inst.adapter);
      channelInstances.push(inst);
    }
    agent.status = 'running';

    // 连接
    await channelLoader.connectAll(instances, { onConnected: markChannelConnected });
    await ensureTriggerSchedulerStarted(agent);
    agentRuntimeState = 'running';
    agentRuntimeError = undefined;
    logger.info(`[HotLoad] ✓ Agent ${aid} online with ${instances.length} channel(s)`);
  };

  // Full resync handler: scan disk, load new agents, unload removed/disabled, reload changed
  (globalThis as any).__evolclaw_resyncAgents = async () => {
    const { loadAllAgents: scanAgents, loadDefaults: readDefaults } = await import('./config-store.js');
    const { resolveEffective } = await import('./config/config-manager.js');
    const freshDefaults = readDefaults();
    const { agents: diskAgents } = scanAgents();
    const diskAidSet = new Set(diskAgents.map(a => a.aid));

    const results: string[] = [];

    // 1. 下线：运行时有但磁盘上没有 / disabled 的
    for (const [aid, agent] of [...(agentRegistry as any).agents.entries()] as [string, any][]) {
      const diskCfg = diskAgents.find(a => a.aid === aid);
      if (!diskCfg || diskCfg.enabled === false) {
        triggerSchedulers.get(aid)?.stop();
        triggerSchedulers.delete(aid);
        // 断开所有 channels
        for (const chName of agent.channelInstanceNames()) {
          const inst = channelInstances.find(i => i.adapter.channelName === chName);
          if (inst) {
            try { await inst.disconnect(); } catch {}
            markChannelDisconnected(inst.adapter.channelName);
            const idx = channelInstances.indexOf(inst);
            if (idx >= 0) channelInstances.splice(idx, 1);
          }
        }
        (agentRegistry as any).agents.delete(aid);
        results.push(`- ${aid} (offline)`);
        continue;
      }
    }

    // 2. 新增：磁盘上有但运行时没有的
    for (const cfg of diskAgents) {
      if (cfg.enabled === false) continue;
      if ((agentRegistry as any).agents.has(cfg.aid)) continue;
      try {
        await (globalThis as any).__evolclaw_hotLoadAgent(cfg.aid);
        results.push(`+ ${cfg.aid} (online)`);
      } catch (e: any) {
        results.push(`✗ ${cfg.aid}: ${e?.message || e}`);
      }
    }

    // 3. 已有的：重新 reload（config 可能改了）
    const hooks = (globalThis as any).__evolclaw_reloadHooks;
    for (const cfg of diskAgents) {
      if (cfg.enabled === false) continue;
      if (!(agentRegistry as any).agents.has(cfg.aid)) continue;
      // 只有磁盘上存在且运行时也存在的才 reload
      try {
        await agentRegistry.reload(cfg.aid, hooks);
        const runtimeAgent = agentRegistry.get(cfg.aid);
        if (runtimeAgent) await startTriggerScheduler(runtimeAgent);
        results.push(`↻ ${cfg.aid} (reloaded)`);
      } catch (e: any) {
        results.push(`⚠ ${cfg.aid}: ${e?.message || e}`);
      }
    }

    // 重建 channel index + 清除 kit 缓存
    invalidateKitCache();
    (agentRegistry as any).channelIndex.clear();
    (agentRegistry as any).buildChannelIndex();

    logger.info(`[Resync] Done: ${results.length} agent(s) processed`);
    return results;
  };

  ipcServer.setStatsProvider(() => statsCollector.getSnapshot());
  ipcServer.setAgentStatsProvider(() => agentRegistry.list().map((agent) => {
    const snap = statsCollector.getSnapshot(agent.aid);
    return {
      aid: agent.aid,
      received: snap.lastHour.received,
      sent: snap.lastHour.sent,
      completed: snap.lastHour.completed,
      errors: snap.lastHour.errors,
      interrupts: snap.lastHour.interrupts,
      avgResponseMs: snap.lastHour.avgResponseMs,
      processing: messageQueue.getProcessingCountByAgent(agent.aid),
      queued: messageQueue.getQueueLengthByAgent(agent.aid),
      muted: messageQueue.isAgentMuted(agent.aid),
    };
  }));

  // Queue snapshot & action (for evolclaw queue --agent CLI)
  ipcServer.setQueueSnapshotProvider((params: { agent: string }) => {
    const handle = agentRegistry.get(params.agent);
    const agentName = handle?.name;
    if (!agentName) return [];
    return messageQueue.getQueueItemsByAgent(agentName);
  });
  ipcServer.setQueueActionExecutor(async (params) => {
    const handle = agentRegistry.get(params.agent);
    const agentName = handle?.name;
    if (!agentName) return { ok: false, error: `agent not found: ${params.agent}` };

    switch (params.action) {
      case 'clear':
        return { ok: true, cleared: messageQueue.clearByAgent(agentName) };
      case 'cancel':
        if (!params.messageId) return { ok: false, error: 'missing messageId' };
        return { ok: true, cancelled: messageQueue.cancelMessageById(agentName, params.messageId) };
      case 'interrupt':
        if (!params.sessionKey) return { ok: false, error: 'missing sessionKey' };
        {
          const sessionId = messageQueue.findSessionIdBySessionKey(params.sessionKey);
          if (!sessionId) return { ok: false, error: `session not found: ${params.sessionKey}` };
          return { ok: true, interrupted: await messageQueue.interruptBySession(sessionId) };
        }
      default:
        return { ok: false, error: `unknown action: ${params.action}` };
    }
  });
  ipcServer.setTriggerExecutor(async (cmd: { type: string; [key: string]: any }) => {
    const schedulerFor = (agentAid: string): TriggerRuntimeScheduler => {
      const scheduler = triggerSchedulers.get(agentAid);
      if (!scheduler) throw new Error(`trigger scheduler not found for agent: ${agentAid}`);
      return scheduler;
    };
    const requireAgent = (agentAid: unknown): string => {
      if (typeof agentAid !== 'string' || !agentAid) throw new Error('missing agentAid');
      if (agentAid === daemonTriggerOwner.aid) return agentAid;
      if (!agentRegistry.get(agentAid)) throw new Error(`agent not found: ${agentAid}`);
      return agentAid;
    };

    switch (cmd.type) {
      case 'trigger.list': {
        const agentAid = requireAgent(cmd.agentAid);
        return { ok: true, triggers: schedulerFor(agentAid).list({ all: cmd.all === true }) };
      }
      case 'trigger.show': {
        const agentAid = requireAgent(cmd.agentAid);
        if (!cmd.triggerId) throw new Error('missing triggerId');
        return { ok: true, ...schedulerFor(agentAid).show(cmd.triggerId) };
      }
      case 'trigger.eventCatalog': {
        return { ok: true, ...getEventCatalog({ includeInternal: cmd.includeInternal === true }) };
      }
      case 'trigger.create': {
        const definition = normalizeTriggerDefinition(await definitionWithActorOrigin(cmd.definition, cmd.actorSessionId));
        requireAgent(definition.agentAid);
        validateTriggerFeedbackChannels(definition);
        const trigger = schedulerFor(definition.agentAid).create(definition, cmd.files ?? [], { enable: cmd.enable });
        return { ok: true, trigger };
      }
      case 'trigger.update': {
        const agentAid = requireAgent(cmd.agentAid);
        if (!cmd.triggerId) throw new Error('missing triggerId');
        const definition = normalizeTriggerDefinition({ ...cmd.definition, id: cmd.triggerId, agentAid });
        if (definition.agentAid !== agentAid) throw new Error('definition.agentAid does not match request agentAid');
        validateTriggerFeedbackChannels(definition);
        const trigger = schedulerFor(agentAid).update(cmd.triggerId, definition, cmd.files ?? []);
        return { ok: true, trigger };
      }
      case 'trigger.setEnabled': {
        const agentAid = requireAgent(cmd.agentAid);
        if (!cmd.triggerId) throw new Error('missing triggerId');
        if (typeof cmd.enabled !== 'boolean') throw new Error('missing enabled');
        const trigger = schedulerFor(agentAid).setEnabled(cmd.triggerId, cmd.enabled);
        return { ok: true, trigger };
      }
      case 'trigger.cancel': {
        const agentAid = requireAgent(cmd.agentAid);
        if (!cmd.triggerId) throw new Error('missing triggerId');
        const trigger = schedulerFor(agentAid).cancel(cmd.triggerId);
        return { ok: true, trigger };
      }
      case 'trigger.delete': {
        const agentAid = requireAgent(cmd.agentAid);
        if (!cmd.triggerId) throw new Error('missing triggerId');
        const trigger = schedulerFor(agentAid).delete(cmd.triggerId);
        return { ok: true, trigger };
      }
      case 'trigger.run': {
        const agentAid = requireAgent(cmd.agentAid);
        if (!cmd.triggerId) throw new Error('missing triggerId');
        const result = await schedulerFor(agentAid).run(cmd.triggerId, { dryRun: cmd.dryRun === true });
        return {
          ok: result.ok,
          result,
          runId: result.runId,
          triggerId: result.triggerId,
          status: result.status,
          reason: result.reason,
          error: result.error,
          audit: result.audit,
        };
      }
      default:
        return { ok: false, error: `unknown trigger command: ${cmd.type}` };
    }
  });
  ipcServer.startCpuTracking();

  // I3: start IPC server after all hooks/executors/providers are registered.
  await ipcServer.start();

  // 写入 ready 信号（Control Plane 已可通过 IPC 查询；channel 连接不阻塞启动判定）
  const readySignalPath = resolvePaths().readySignal;
  fs.writeFileSync(readySignalPath, String(Date.now()));
  logger.info(`✓ Ready signal written: ${readySignalPath}`);

  // 配置 reload 走 IPC `evolagent.reload` 触发，不再用 watchFile。
  // 双 rename 原子写下 watchFile 的语义会被破坏，且新结构有 N 个 config.json 要监控；
  // 显式触发更可控。

  // 优雅关闭
  let shutdownSignal = 'unknown';
  const shutdown = async (signal?: string) => {
    if (signal) shutdownSignal = signal;
    const pid = process.pid;
    const ppid = process.ppid;
    logger.info(`\n\nShutting down gracefully... (signal=${shutdownSignal}, pid=${pid}, ppid=${ppid})`);
    ipcServer.stopCpuTracking();
    ipcServer.stop();
    bindService?.stopCleanup();
    for (const scheduler of triggerSchedulers.values()) {
      scheduler.stop();
    }
    eventBus.publish({
      type: 'system:shutdown',
      timestamp: Date.now()
    });

    // 断开插件系统的渠道
    await channelLoader.disconnectAll(channelInstances);
    for (const inst of channelInstances) {
      const type = inst.channelType || inst.adapter.channelName;
      eventBus.publish({ type: 'channel:disconnected', channel: type, channelName: inst.adapter.channelName, reason: 'shutdown' });
    }

    // 断开控制 AID（daemon 进程身份）
    if (controlChannel) {
      try { await controlChannel.disconnect(); } catch { /* ignore */ }
    }

    sessionManager.close();
    removeAll();
    logger.info('✓ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 全局错误处理：防止未捕获的 WebSocket 错误导致进程崩溃
  // 特别是 fastaun SDK 在连接超时时，WebSocket 可能发出未被监听的 'error' 事件
  process.on('uncaughtException', (error: Error) => {
    // 检查是否是 WebSocket 连接超时相关错误
    const isWsError = error.message?.includes('WebSocket was closed before the connection was established');
    const isFastaunError = error.stack?.includes('@agentunion/fastaun');

    if (isWsError || isFastaunError) {
      logger.warn(`Caught WebSocket connection error (non-fatal): ${error.message}`);
      logger.debug(`WebSocket error stack: ${error.stack}`);
      // 不退出进程，让 AUN 重连机制处理
      return;
    }

    // 其他未捕获错误仍然是致命的
    logger.error('Uncaught exception:', error);
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: any) => {
    logger.error('Unhandled promise rejection:', reason);
    console.error('Unhandled promise rejection:', reason);
    // Promise rejection 不立即退出，记录后继续运行
  });

  // 兜底：进程退出前同步删除 instance 文件（防 async shutdown 未完成就被杀）
  process.on('exit', () => {
    removeAll();
  });
}

// 仅在直接执行时启动；导入此模块（如单元测试）时不触发 main()。
import { isMainScript, onShutdown, commandExists } from './utils/cross-platform.js';
if (isMainScript(import.meta.url)) {
  main().catch((error) => {
    const msg = `Fatal error: ${error?.stack || error}`;
    logger.error('Fatal error:', error);
    console.error(msg);  // ensure it lands in stdout.log for self-heal diagnostics
    process.exit(1);
  });
}
