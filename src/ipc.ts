import net from 'net';
import fs from 'fs';
import { logger } from './utils/logger.js';
import type { EvolAgentRegistryHandle, AidConnectionState } from './types.js';
import type { AidStatsSnapshot } from './utils/stats.js';
import { fileCache } from './core/daemon-file-cache.js';
import type { FileCacheStats } from './core/daemon-file-cache.js';

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
  channels: Record<string, ChannelStatus>;
  channelsByType?: Record<string, string[]>;  // channelType → instance names
  queue: { pending: number; processing: number };
  stats?: {
    received: number;
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

type StatusProvider = () => IpcStatusResponse;
type CommandExecutor = (cmd: string, sessionId: string) => Promise<IpcCtlResponse>;
type AunAidProvider = () => AidConnectionState[];
type AunAidStatsProvider = () => AidStatsSnapshot[];
type AunAidStatsRecorder = (params: { aid: string; toPeer: string; text: string; encrypt?: boolean; chatmode?: string }) => void;
type MenuExecutor = (payload: any) => Promise<any>;

export class IpcServer {
  private server: net.Server | null = null;
  private agentRegistry?: EvolAgentRegistryHandle;
  private aunAidProvider?: AunAidProvider;
  private aunAidStatsProvider?: AunAidStatsProvider;
  private aunAidStatsRecorder?: AunAidStatsRecorder;
  private menuExecutor?: MenuExecutor;

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

  start(): void {
    // Remove stale socket file (Unix only — named pipes auto-cleanup on process exit)
    if (!isNamedPipe(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch {}
    }

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

    this.server.on('error', (err) => {
      logger.error('[IPC] Server error:', err);
    });

    this.server.listen(this.socketPath, () => {
      // Restrict to current user (Unix only — named pipes use Windows ACLs)
      if (!isNamedPipe(this.socketPath)) {
        try { fs.chmodSync(this.socketPath, 0o600); } catch {}
      }
      logger.info(`[IPC] Listening on ${this.socketPath}`);
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
      case 'aun-aids': {
        const aids = this.aunAidProvider ? this.aunAidProvider() : [];
        return { ok: true, aids };
      }
      case 'aun-aid-stats': {
        const stats = this.aunAidStatsProvider ? this.aunAidStatsProvider() : [];
        return { ok: true, stats };
      }
      case 'cache-stats': {
        // daemon 统一 FileCache 的只读运行统计（watch web Cache 页用）。
        // 直接读单例，无需 provider 注入（与 manifest-engine 等 import 单例同款）。
        return { ok: true, stats: fileCache.stats() };
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
      case 'ctl': {
        if (!this.commandExecutor) return { ok: false, error: 'ctl not configured' };
        const { cmd: slashCmd, sessionId } = cmd as unknown as IpcCtlRequest;
        if (!slashCmd || !sessionId) return { ok: false, error: 'missing cmd or sessionId' };
        return await this.commandExecutor(slashCmd, sessionId);
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
        const info = this.agentRegistry.list().find((i) => i.name === name);
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
