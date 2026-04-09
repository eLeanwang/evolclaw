import net from 'net';
import fs from 'fs';
import { logger } from '../utils/logger.js';

export interface ChannelStatus {
  connected: boolean;
  reconnectAttempt?: number;
  maxAttempts?: number;
  [key: string]: unknown;
}

export interface IpcStatusResponse {
  pid: number;
  uptime: number;
  channels: Record<string, ChannelStatus>;
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
