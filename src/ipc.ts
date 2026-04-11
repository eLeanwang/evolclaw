import net from 'net';
import fs from 'fs';
import { logger } from './utils/logger.js';

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

type StatusProvider = () => IpcStatusResponse;

export class IpcServer {
  private server: net.Server | null = null;

  constructor(
    private socketPath: string,
    private getStatus: StatusProvider,
  ) {}

  start(): void {
    // Remove stale socket file
    try { fs.unlinkSync(this.socketPath); } catch {}

    this.server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (data) => {
        buf += data.toString();
        // Simple newline-delimited JSON protocol
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const cmd = JSON.parse(line);
          const response = this.handleCommand(cmd);
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
      // Ensure socket is readable by current user only
      try { fs.chmodSync(this.socketPath, 0o600); } catch {}
      logger.info(`[IPC] Listening on ${this.socketPath}`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try { fs.unlinkSync(this.socketPath); } catch {}
  }

  private handleCommand(cmd: { type: string }): unknown {
    switch (cmd.type) {
      case 'status':
        return this.getStatus();
      case 'ping':
        return { pong: true, pid: process.pid };
      default:
        return { error: `unknown command: ${cmd.type}` };
    }
  }
}

/**
 * Query the running EvolClaw daemon via Unix socket.
 * Returns null if the service is not running or the socket is unreachable.
 */
export function ipcQuery(socketPath: string, cmd: { type: string }, timeoutMs = 3000): Promise<IpcStatusResponse | null> {
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
