/**
 * evolclaw IPC client（独立版）— 通过 Unix socket / 命名管道查询运行中的 daemon。
 *
 * 协议：newline-delimited JSON，一问一答即断。
 * 与 evolclaw src/ipc.ts 的 ipcQuery 一致；连不上返回 null（daemon 未运行）。
 *
 * watch 用到的只读查询：aun-aids / aun-aid-stats / status / evolagent.list / ping
 */

import net from 'net';

export function ipcQuery<T = any>(
  socketPath: string,
  cmd: { type: string; [key: string]: unknown },
  timeoutMs = 3000,
): Promise<T | null> {
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
