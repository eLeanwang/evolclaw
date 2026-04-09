import net from 'net';
import type { IpcStatusResponse } from '../core/ipc-server.js';

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
