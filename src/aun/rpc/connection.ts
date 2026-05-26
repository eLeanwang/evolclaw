import fs from 'fs';
import path from 'path';
import os from 'os';
import { aidsDir, aunPath as defaultAunPath } from '../../paths.js';

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
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
  const { AUNClient } = await import('@agentunion/fastaun');

  const encryptionSeed = process.env.AUN_ENCRYPTION_SEED || undefined;
  const clientOpts: any = { aun_path: aunPath, debug: false };
  if (fs.existsSync(caCertPath)) clientOpts.root_ca_path = caCertPath;
  if (encryptionSeed) clientOpts.encryption_seed = encryptionSeed;

  const client = new AUNClient(clientOpts);
  client.setAgentMdPath(aidsDir());
  await client.auth.createAid({ aid });
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
