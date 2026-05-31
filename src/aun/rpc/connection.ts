import { getAidStore, loadClient, SLOT } from '../aid/store.js';

export interface ShortConnection {
  call(method: string, params: any): Promise<any>;
  close(): Promise<void>;
}

export interface ShortConnectionOpts {
  /** keystore 根目录，默认由 getAidStore 走 paths.aunPath()。 */
  aunPath?: string;
  /**
   * 应用 slot 标识，决定消费通道隔离键。
   * 默认 SLOT.cli（'evolclaw cli'）—— 与 daemon 共享 evolclaw 消费通道（短连接不踢长连接）。
   * 传具体值 = 独立通道，隔离 token / seq 游标 / 消息过滤。
   */
  slotId?: string;
}

export async function createShortConnection(aid: string, opts?: ShortConnectionOpts): Promise<ShortConnection> {
  const store = await getAidStore({ slotId: opts?.slotId ?? SLOT.cli, aunPath: opts?.aunPath });
  try {
    const client = await loadClient(store, aid);
    await client.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false });
    return {
      async call(method: string, params: any): Promise<any> {
        return client.call(method, params);
      },
      async close(): Promise<void> {
        try { await client.close(); } finally { store.close(); }
      },
    };
  } catch (e) {
    store.close();
    throw e;
  }
}
