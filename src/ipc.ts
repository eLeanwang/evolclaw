import net from 'net';
import fs from 'fs';
import os from 'os';
import { logger } from './utils/logger.js';
import type { EventBus } from './core/event-bus.js';
import type { AgentInfo, EvolAgentRegistryHandle, AidConnectionState } from './types.js';
import type { AidStatsSnapshot, StatsSnapshot } from './utils/stats.js';
import { fileCache } from './core/daemon-file-cache.js';
import type { FileCacheStats } from './core/daemon-file-cache.js';
import type { BindBeginRequest, BindBeginResponse, BindErrorResponse, BindStatusResponse } from './utils/aid-bind.js';
import type { HandoffMetadata, HandoffReturnIpcResponse, TaskRuntimeContext } from './core/message/handoff.js';
import type { ConfigExecutionResult } from './config/config-operation-service.js';
import type {
  DingtalkContactBindRegisterRequest,
  DingtalkContactBindRegisterResponse,
  DingtalkContactBindErrorResponse,
} from './channels/dingtalk.js';

const isWindows = process.platform === 'win32';
const isNamedPipe = (p: string) => isWindows && p.startsWith('\\\\.\\pipe\\');

export interface ChannelStatus {
  connected: boolean;
  channelType?: string;
  [key: string]: unknown;
}

export interface IpcStatusResponse {
  pid: number;
  uptime: number;
  controlPlane?: {
    ready: boolean;
    owned?: boolean;
  };
  agentRuntime?: {
    state: 'empty' | 'starting' | 'running' | 'stopped' | 'error';
    runnableAgents: number;
    runningAgents: number;
    error?: string;
  };
  channels: Record<string, ChannelStatus>;
  channelsByType?: Record<string, string[]>;  // channelType → instance names
  queue: { pending: number; processing: number };
  stats?: {
    received: number;
    sent?: number;
    completed: number;
    errors: number;
    avgResponseMs: number;
  };
  controlAid?: { aid: string; connected: boolean };
}

export interface IpcAunAidsResponse {
  ok: boolean;
  aids: AidConnectionState[];
}

export interface IpcCacheStatsResponse {
  ok: boolean;
  stats: FileCacheStats;
}

export interface IpcCtlRequest {
  type: 'ctl';
  cmd: string;       // 完整 slash cmd，如 "/model sonnet"
  sessionId: string;  // EVOLCLAW_SESSION_ID
}

export interface IpcCtlResponse {
  ok: boolean;
  result?: string;
  error?: string;
}

export interface IpcConfigOpRequest {
  type: 'config.op';
  argv: string[];
  sessionId: string;
  delegationToken: string;
}

export interface IpcConfigOpResponse {
  ok: boolean;
  result?: ConfigExecutionResult;
  error?: string;
  code?: string;
}

export interface IpcAunMsgSendResponse {
  ok: boolean;
  message_id?: string;
  seq?: number;
  timestamp?: number;
  status?: string;
  delivery_mode?: string;
  encrypt?: boolean;
  chatmode?: string;
  log_written?: boolean;
  error?: string;
  code?: string | number;
}

export interface IpcAunMsgSendLogRequest {
  content: string;
  source?: 'daemon' | 'cli' | 'msg' | 'ctl' | 'owner-inject' | 'handoff';
  handoff?: HandoffMetadata;
}

type StatusProvider = () => IpcStatusResponse;
type CommandExecutor = (cmd: string, sessionId: string) => Promise<IpcCtlResponse>;
type ConfigOperationExecutor = (argv: string[], sessionId: string, delegationToken: string) => Promise<IpcConfigOpResponse>;
type AunAidProvider = () => AidConnectionState[];
type AunAidStatsProvider = () => AidStatsSnapshot[];
type AunAidStatsRecorder = (params: { aid: string; toPeer: string; text: string; encrypt?: boolean; chatmode?: string }) => void;
type MenuExecutor = (payload: any) => Promise<any>;
type StatsSnapshotProvider = () => StatsSnapshot;
type AgentStatsSnapshot = {
  aid: string;
  received: number;
  sent: number;
  completed: number;
  errors: number;
  interrupts: number;
  avgResponseMs: number;
  processing: number;
  queued: number;
  muted: boolean;
};
type AgentStatsProvider = () => AgentStatsSnapshot[];
type QueueSnapshotProvider = (params: { agent: string }) => Array<{ status: string; sessionKey: string; channelType: string; channelId: string; projectPath: string; peerName?: string; preview: string; messageId?: string; elapsedMs?: number }>;
type QueueActionExecutor = (params: { agent: string; action: 'clear' | 'cancel' | 'interrupt'; messageId?: string; sessionKey?: string }) => Promise<{ ok: boolean; cleared?: number; cancelled?: boolean; interrupted?: boolean; error?: string }>;
type TriggerExecutor = (cmd: { type: string; [key: string]: any }) => Promise<any>;
type TaskRuntimeContextProvider = (params: { sessionId: string }) => TaskRuntimeContext | null | undefined;
type AunMsgSender = (params: { aid: string; to: string; payload: Record<string, unknown>; encrypt?: boolean; log?: IpcAunMsgSendLogRequest }) => Promise<IpcAunMsgSendResponse>;
type HandoffReturnExecutor = (params: { sessionId?: string; content: string }) => Promise<HandoffReturnIpcResponse>;
type BindExecutor = {
  begin: (cmd: BindBeginRequest) => BindBeginResponse | BindErrorResponse;
  status: (taskId: string) => BindStatusResponse | BindErrorResponse;
  cancel: (taskId: string) => BindStatusResponse | BindErrorResponse;
};
type DingtalkContactBindExecutor = {
  register: (cmd: DingtalkContactBindRegisterRequest) =>
    DingtalkContactBindRegisterResponse | DingtalkContactBindErrorResponse;
};

export class IpcServer {
  private server: net.Server | null = null;
  private agentRegistry?: EvolAgentRegistryHandle;
  private aunAidProvider?: AunAidProvider;
  private aunAidStatsProvider?: AunAidStatsProvider;
  private aunAidStatsRecorder?: AunAidStatsRecorder;
  private menuExecutor?: MenuExecutor;
  private statsProvider?: StatsSnapshotProvider;
  private agentStatsProvider?: AgentStatsProvider;
  private queueSnapshotProvider?: QueueSnapshotProvider;
  private queueActionExecutor?: QueueActionExecutor;
  private triggerExecutor?: TriggerExecutor;
  private taskRuntimeContextProvider?: TaskRuntimeContextProvider;
  private aunMsgSender?: AunMsgSender;
  private handoffReturnExecutor?: HandoffReturnExecutor;
  private bindExecutor?: BindExecutor;
  private configOperationExecutor?: ConfigOperationExecutor;
  private dingtalkContactBindExecutor?: DingtalkContactBindExecutor;

  // CPU 占用追踪：IPC handler 是一次性同步调用，无法在响应里做 200ms 异步采样，
  // 故用后台 1s interval 累积 process.cpuUsage() 增量，handler 直接读最近值。
  // procCpuPercent = 本 daemon 进程占单核的百分比（可 >100% 仅当多核，已 clamp 到 100）；
  // sysCpuPercent  = 整机所有核平均忙碌百分比（由 os.cpus() times 增量算出）。
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTs = Date.now();
  private cpuPercent = 0;            // 进程级
  private sysCpuPercent = 0;         // 系统级
  private lastCpuTimes: { idle: number; total: number } | null = null;
  private cpuTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private socketPath: string,
    private getStatus: StatusProvider,
    private commandExecutor?: CommandExecutor,
  ) {}

  /** Inject EvolAgentRegistry for evolagent.* IPC handlers */
  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  /** Inject menu.* executor (ECWeb Control proxies menu requests through this) */
  setMenuExecutor(executor: MenuExecutor): void {
    this.menuExecutor = executor;
  }

  setConfigOperationExecutor(executor: ConfigOperationExecutor): void {
    this.configOperationExecutor = executor;
  }

  /** Inject AUN AID state aggregator for aun-aids IPC handler */
  setAunAidProvider(provider: AunAidProvider): void {
    this.aunAidProvider = provider;
  }

  /** Inject AUN AID stats provider for aun-aid-stats IPC handler */
  setAunAidStatsProvider(provider: AunAidStatsProvider): void {
    this.aunAidStatsProvider = provider;
  }

  /** Inject AUN AID stats recorder for aun-aid-stats-record-outbound IPC handler */
  setAunAidStatsRecorder(recorder: AunAidStatsRecorder): void {
    this.aunAidStatsRecorder = recorder;
  }

  /** Inject global StatsSnapshot provider for monitor-snapshot IPC handler */
  setStatsProvider(provider: StatsSnapshotProvider): void {
    this.statsProvider = provider;
  }

  /** Inject per-agent rolling stats provider for ECWeb Agents page. */
  setAgentStatsProvider(provider: AgentStatsProvider): void {
    this.agentStatsProvider = provider;
  }

  /** Inject queue snapshot provider for queue-snapshot IPC handler (query mode) */
  setQueueSnapshotProvider(provider: QueueSnapshotProvider): void {
    this.queueSnapshotProvider = provider;
  }

  /** Inject queue action executor for queue-snapshot IPC handler (action mode) */
  setQueueActionExecutor(executor: QueueActionExecutor): void {
    this.queueActionExecutor = executor;
  }

  /** Inject daemon-level trigger executor for ec trigger. */
  setTriggerExecutor(executor: TriggerExecutor): void {
    this.triggerExecutor = executor;
  }

  /** Inject active task runtime-context provider for in-task CLI handoff metadata. */
  setTaskRuntimeContextProvider(provider: TaskRuntimeContextProvider): void {
    this.taskRuntimeContextProvider = provider;
  }

  /** Inject daemon-backed AUN private message sender for in-task `ec msg send`. */
  setAunMsgSender(sender: AunMsgSender): void {
    this.aunMsgSender = sender;
  }

  /** Inject internal handoff result return executor for `ec handoff return`. */
  setHandoffReturnExecutor(executor: HandoffReturnExecutor): void {
    this.handoffReturnExecutor = executor;
  }

  /** Inject bootstrap QR bind executor for init/init aun. */
  setBindExecutor(executor: BindExecutor): void {
    this.bindExecutor = executor;
  }

  /** Inject DingTalk contact binding-code executor. */
  setDingtalkContactBindExecutor(executor: DingtalkContactBindExecutor): void {
    this.dingtalkContactBindExecutor = executor;
  }

  /** Start the 1s background CPU sampling loop (for monitor-snapshot). Call after start(). */
  startCpuTracking(): void {
    if (this.cpuTimer) return;
    this.cpuTimer = setInterval(() => {
      const now = Date.now();
      const elapsedUs = (now - this.lastCpuTs) * 1000; // wall time in microseconds
      if (elapsedUs > 0) {
        const usage = process.cpuUsage(this.lastCpuUsage); // delta since last sample
        this.cpuPercent = Math.min(100, ((usage.user + usage.system) / elapsedUs) * 100);
      }
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuTs = now;

      // 系统级 CPU：os.cpus() 累计 times 的增量 → 整机平均忙碌率
      try {
        const cpus = os.cpus();
        let idle = 0, total = 0;
        for (const c of cpus) {
          idle += c.times.idle;
          total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
        }
        if (this.lastCpuTimes) {
          const idleDelta = idle - this.lastCpuTimes.idle;
          const totalDelta = total - this.lastCpuTimes.total;
          if (totalDelta > 0) {
            this.sysCpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
          }
        }
        this.lastCpuTimes = { idle, total };
      } catch { /* os.cpus() 理论上不抛 */ }
    }, 1000);
    // Don't keep the event loop alive for sampling alone.
    this.cpuTimer.unref?.();
  }

  /** Stop the CPU sampling loop. */
  stopCpuTracking(): void {
    if (this.cpuTimer) { clearInterval(this.cpuTimer); this.cpuTimer = null; }
  }

  start(): Promise<void> {
    // Remove stale socket file (Unix only — named pipes auto-cleanup on process exit)
    if (!isNamedPipe(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch {}
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => {
        let buf = '';
        conn.on('data', async (data) => {
          buf += data.toString();
          // Simple newline-delimited JSON protocol
          const idx = buf.indexOf('\n');
          if (idx === -1) return;
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const cmd = JSON.parse(line);
            const response = await this.handleCommand(cmd);
            conn.end(JSON.stringify(response) + '\n');
          } catch {
            conn.end(JSON.stringify({ error: 'invalid request' }) + '\n');
          }
        });
        conn.on('error', () => {}); // ignore client errors
      });

      const onListenError = (err: Error) => {
        logger.error('[IPC] Server error:', err);
        reject(err);
      };
      this.server.once('error', onListenError);

      this.server.listen(this.socketPath, () => {
        this.server?.off('error', onListenError);
        this.server?.on('error', (err) => {
          logger.error('[IPC] Server error:', err);
        });
        // Restrict to current user (Unix only — named pipes use Windows ACLs)
        if (!isNamedPipe(this.socketPath)) {
          try { fs.chmodSync(this.socketPath, 0o600); } catch {}
        }
        logger.info(`[IPC] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (!isNamedPipe(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch {}
    }
  }

  private async handleCommand(cmd: { type: string; [key: string]: any }): Promise<unknown> {
    switch (cmd.type) {
      case 'status':
        return this.getStatus();
      case 'ping':
        return { pong: true, pid: process.pid, protocolVersion: 1 };
      case 'bind.begin': {
        if (!this.bindExecutor) return { ok: false, error: 'bind executor not configured' };
        return this.bindExecutor.begin({
          bindType: cmd.bindType,
          targetAid: cmd.targetAid,
          agentName: cmd.agentName,
          ownerMode: cmd.ownerMode,
          ttlMs: cmd.ttlMs,
        });
      }
      case 'bind.status': {
        if (!this.bindExecutor) return { ok: false, error: 'bind executor not configured' };
        return this.bindExecutor.status(cmd.taskId);
      }
      case 'bind.cancel': {
        if (!this.bindExecutor) return { ok: false, error: 'bind executor not configured' };
        return this.bindExecutor.cancel(cmd.taskId);
      }
      case 'dingtalk.contact-bind.register': {
        if (!this.dingtalkContactBindExecutor) {
          return { ok: false, error: 'dingtalk contact bind executor not configured' };
        }
        return this.dingtalkContactBindExecutor.register({
          selfAid: cmd.selfAid,
          channelName: cmd.channelName,
          primaryId: cmd.primaryId,
        });
      }
      case 'aun-aids': {
        const aids = this.aunAidProvider ? this.aunAidProvider() : [];
        return { ok: true, aids };
      }
      case 'aun-aid-stats': {
        const stats = this.aunAidStatsProvider ? this.aunAidStatsProvider() : [];
        return { ok: true, stats };
      }
      case 'agent-stats': {
        const stats = this.agentStatsProvider ? this.agentStatsProvider() : [];
        return { ok: true, stats };
      }
      case 'cache-stats': {
        // daemon 统一 FileCache 的只读运行统计（watch web Cache 页用）。
        // 直接读单例，无需 provider 注入（与 manifest-engine 等 import 单例同款）。
        return { ok: true, stats: fileCache.stats() };
      }
      case 'queue-snapshot': {
        if (!cmd.agent) return { ok: false, error: 'missing agent' };
        if (!cmd.action) {
          // 纯查询
          if (!this.queueSnapshotProvider) return { ok: false, error: 'queue-snapshot not configured' };
          return { ok: true, items: this.queueSnapshotProvider({ agent: cmd.agent }) };
        }
        // 操作：clear / cancel / interrupt
        if (!this.queueActionExecutor) return { ok: false, error: 'queue actions not configured' };
        return await this.queueActionExecutor({
          agent: cmd.agent,
          action: cmd.action,
          messageId: cmd.messageId,
          sessionKey: cmd.sessionKey,
        });
      }
      case 'aun-aid-stats-record-outbound': {
        if (!this.aunAidStatsRecorder) return { ok: false, error: 'recorder not configured' };
        try {
          this.aunAidStatsRecorder({
            aid: cmd.aid,
            toPeer: cmd.toPeer,
            text: cmd.text ?? '',
            encrypt: cmd.encrypt,
            chatmode: cmd.chatmode,
          });
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message || e) };
        }
      }
      case 'task-runtime-context': {
        if (!this.taskRuntimeContextProvider) return { ok: false, error: 'task runtime context not configured' };
        if (!cmd.sessionId || typeof cmd.sessionId !== 'string') return { ok: false, error: 'missing sessionId' };
        const context = this.taskRuntimeContextProvider({ sessionId: cmd.sessionId }) ?? null;
        return { ok: true, context };
      }
      case 'aun-msg-send': {
        if (!this.aunMsgSender) return { ok: false, error: 'aun msg sender not configured' };
        if (!cmd.aid || typeof cmd.aid !== 'string') return { ok: false, error: 'missing aid' };
        if (!cmd.to || typeof cmd.to !== 'string') return { ok: false, error: 'missing to' };
        if (!cmd.payload || typeof cmd.payload !== 'object' || Array.isArray(cmd.payload)) {
          return { ok: false, error: 'missing payload' };
        }
        const rawLog = cmd.log && typeof cmd.log === 'object' && !Array.isArray(cmd.log)
          ? cmd.log as Record<string, unknown>
          : undefined;
        const log: IpcAunMsgSendLogRequest | undefined = typeof rawLog?.content === 'string'
          ? {
            content: rawLog.content,
            source: rawLog.source as IpcAunMsgSendLogRequest['source'],
            handoff: rawLog.handoff as IpcAunMsgSendLogRequest['handoff'],
          }
          : undefined;
        try {
          return await this.aunMsgSender({
            aid: cmd.aid,
            to: cmd.to,
            payload: cmd.payload as Record<string, unknown>,
            encrypt: cmd.encrypt === true,
            log,
          });
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case 'handoff-return': {
        if (!this.handoffReturnExecutor) return { ok: false, error: 'handoff return not configured' };
        if (!cmd.content || typeof cmd.content !== 'string') return { ok: false, error: 'missing content' };
        try {
          return await this.handoffReturnExecutor({
            sessionId: typeof cmd.sessionId === 'string' ? cmd.sessionId : undefined,
            content: cmd.content,
          });
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case 'ctl': {
        if (!this.commandExecutor) return { ok: false, error: 'ctl not configured' };
        const { cmd: slashCmd, sessionId } = cmd as unknown as IpcCtlRequest;
        if (!slashCmd || !sessionId) return { ok: false, error: 'missing cmd or sessionId' };
        return await this.commandExecutor(slashCmd, sessionId);
      }
      case 'config.op': {
        if (!this.configOperationExecutor) return { ok: false, code: 'NOT_CONFIGURED', error: 'config.op not configured' };
        const { argv, sessionId, delegationToken } = cmd as unknown as IpcConfigOpRequest;
        if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string') || !sessionId) {
          return { ok: false, code: 'INVALID_REQUEST', error: 'missing argv or sessionId' };
        }
        if (delegationToken !== undefined && typeof delegationToken !== 'string') {
          return { ok: false, code: 'INVALID_DELEGATION', error: 'delegationToken must be a string' };
        }
        return await this.configOperationExecutor(argv, sessionId, delegationToken);
      }
      case 'trigger.list':
      case 'trigger.show':
      case 'trigger.eventCatalog':
      case 'trigger.create':
      case 'trigger.update':
      case 'trigger.setEnabled':
      case 'trigger.cancel':
      case 'trigger.delete':
      case 'trigger.run': {
        if (!this.triggerExecutor) return { ok: false, error: 'trigger executor not configured' };
        try {
          return await this.triggerExecutor(cmd);
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case 'evolagent.list': {
        if (!this.agentRegistry) return { ok: false, error: 'EvolAgentRegistry not available' };
        return { ok: true, agents: this.agentRegistry.list() };
      }
      case 'evolagent.show': {
        if (!this.agentRegistry) return { ok: false, error: 'EvolAgentRegistry not available' };
        const name = cmd.name;
        if (!name || typeof name !== 'string') return { ok: false, error: 'missing name' };
        const agent = this.agentRegistry.get(name);
        if (!agent) return { ok: false, error: `Agent "${name}" not found` };
        const info = this.agentRegistry.list().find((i) => i.aid === name);
        // I7: null-guard list().find() result
        if (!info) return { ok: false, error: `Agent "${name}" found but info missing (race?)` };
        return { ok: true, agent: info };
      }
      case 'evolagent.reload': {
        if (!this.agentRegistry) return { ok: false, error: 'EvolAgentRegistry not available' };
        const name = cmd.name;
        if (!name || typeof name !== 'string') return { ok: false, error: 'missing name' };
        const hooks = (globalThis as any).__evolclaw_reloadHooks;
        if (!hooks) return { ok: false, error: 'Reload hooks not initialized' };
        try {
          const a = this.agentRegistry.get(name);
          if (!a) return { ok: false, error: `Agent "${name}" not found` };
          if (!this.agentRegistry.reload) return { ok: false, error: 'EvolAgentRegistry.reload not available' };
          await this.agentRegistry.reload(name, hooks);
          return { ok: true, result: `Agent "${name}" reloaded` };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case 'evolagent.load': {
        if (!this.agentRegistry) return { ok: false, error: 'EvolAgentRegistry not available' };
        const aid = cmd.aid;
        if (!aid || typeof aid !== 'string') return { ok: false, error: 'missing aid' };
        const hotLoad = (globalThis as any).__evolclaw_hotLoadAgent;
        if (!hotLoad) return { ok: false, error: 'Hot-load handler not initialized' };
        try {
          await hotLoad(aid);
          return { ok: true, result: `Agent "${aid}" loaded and online` };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case 'evolagent.resync': {
        if (!this.agentRegistry) return { ok: false, error: 'EvolAgentRegistry not available' };
        const resync = (globalThis as any).__evolclaw_resyncAgents;
        if (!resync) return { ok: false, error: 'Resync handler not initialized' };
        try {
          const results = await resync();
          return { ok: true, results };
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) };
        }
      }
      case 'menu.exec': {
        if (!this.menuExecutor) return { ok: false, error: 'menu.exec not configured' };
        try {
          const response = await this.menuExecutor(cmd.payload);
          return { ok: true, response };
        } catch (e: any) {
          return { ok: false, error: e?.message ?? String(e) };
        }
      }
      case 'monitor-snapshot': {
        // watch web Monitor 页用：进程级 + 系统级运行指标 + 全局 stats + per-agent 汇总。
        const mem = process.memoryUsage();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const aids = this.aunAidProvider ? this.aunAidProvider() : [];
        const aidStats = this.aunAidStatsProvider ? this.aunAidStatsProvider() : [];
        const statsMap = new Map(aidStats.map((s) => [s.aid, s]));
        const agentInfos: AgentInfo[] = this.agentRegistry ? this.agentRegistry.list() : [];
        const agentRuntimeStats = this.agentStatsProvider ? this.agentStatsProvider() : [];
        const agentRuntimeStatsMap = new Map(agentRuntimeStats.map((s) => [s.aid, s]));
        return {
          ok: true,
          snapshot: {
            ts: Date.now(),
            uptimeMs: Math.round(process.uptime() * 1000),
            cpuCount: os.cpus().length,
            // 进程级：本 daemon 进程
            memory: {
              rss: mem.rss,
              heapUsed: mem.heapUsed,
              heapTotal: mem.heapTotal,
              external: mem.external,
            },
            cpuPercent: Math.round(this.cpuPercent * 10) / 10,
            // 系统级：整机
            system: {
              memTotal: totalMem,
              memUsed: totalMem - freeMem,
              memFree: freeMem,
              cpuPercent: Math.round(this.sysCpuPercent * 10) / 10,
              loadAvg: os.loadavg(),   // [1m, 5m, 15m]（Windows 恒 0）
            },
            stats: this.statsProvider ? this.statsProvider() : null,
            agents: agentInfos.map((a) => ({
              aid: a.aid,
              agentName: a.name,
              status: a.status,
              stats: statsMap.get(a.aid) ?? null,
              runtimeStats: agentRuntimeStatsMap.get(a.aid) ?? null,
            })),
          },
        };
      }
      default:
        return { error: `unknown command: ${cmd.type}` };
    }
  }
}

/**
 * Query the running EvolClaw daemon via Unix socket.
 * Returns null if the service is not running or the socket is unreachable.
 */
export function ipcQuery<T = IpcStatusResponse>(socketPath: string, cmd: { type: string; [key: string]: unknown }, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify(cmd) + '\n');
    });

    conn.on('data', (data) => {
      buf += data.toString();
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch {
          resolve(null);
        }
        conn.destroy();
      }
    });

    conn.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
