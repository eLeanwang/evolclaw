import net from 'net';
import fs from 'fs';
import { logger } from './utils/logger.js';

const isWindows = process.platform === 'win32';
const isNamedPipe = (p: string) => isWindows && p.startsWith('\\\\.\\pipe\\');

export interface ChannelStatus {
  connected: boolean;
  channelType?: string;
  reconnectAttempt?: number;
  maxAttempts?: number;
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

export class IpcServer {
  private server: net.Server | null = null;

  constructor(
    private socketPath: string,
    private getStatus: StatusProvider,
    private commandExecutor?: CommandExecutor,
  ) {}

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

  private async handleCommand(cmd: { type: string }): Promise<unknown> {
    switch (cmd.type) {
      case 'status':
        return this.getStatus();
      case 'ping':
        return { pong: true, pid: process.pid };
      case 'ctl': {
        if (!this.commandExecutor) return { ok: false, error: 'ctl not configured' };
        const { cmd: slashCmd, sessionId } = cmd as unknown as IpcCtlRequest;
        if (!slashCmd || !sessionId) return { ok: false, error: 'missing cmd or sessionId' };
        return await this.commandExecutor(slashCmd, sessionId);
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
export function ipcQuery(socketPath: string, cmd: { type: string; [key: string]: unknown }, timeoutMs = 3000): Promise<IpcStatusResponse | null> {
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
