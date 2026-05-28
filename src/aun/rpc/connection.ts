import { aunPath as defaultAunPath } from '../../paths.js';
import { createAunClient } from '../aid/client.js';
import { loadProcessConfig } from '../../config-store.js';

export interface ShortConnection {
  call(method: string, params: any): Promise<any>;
  close(): Promise<void>;
}

export interface ShortConnectionOpts {
  aunPath?: string;
  /** 应用 slot 标识。用于隔离 ack 游标，避免多应用共用 AID 时互相污染。空字符串表示默认 slot。 */
  slotId?: string;
}

export async function createShortConnection(aid: string, opts?: ShortConnectionOpts): Promise<ShortConnection> {
  const aunPath = opts?.aunPath ?? defaultAunPath();
  const slotId = opts?.slotId ?? '';

  const encryptionSeed = loadProcessConfig().aun?.encryptionSeed
    || process.env.AUN_ENCRYPTION_SEED
    || 'evol';
  const client = await createAunClient({ aunPath, encryptionSeed });
  const authResult = await client.auth.authenticate({ aid });

  const accessToken = authResult?.access_token ?? (client as any)._access_token;
  const gateway = (client as any)._gatewayUrl ?? authResult?.gateway;

  await client.connect(
    {
      access_token: accessToken,
      gateway,
      slot_id: slotId,
      connection_kind: 'short',
    },
    { auto_reconnect: false },
  );

  return {
    async call(method: string, params: any): Promise<any> {
      return client.call(method, params);
    },
    async close(): Promise<void> {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}
