import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ShortConnection {
  call(method: string, params: any): Promise<any>;
  close(): Promise<void>;
}

export async function createShortConnection(aid: string, opts?: { aunPath?: string }): Promise<ShortConnection> {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
  const { AUNClient } = await import('@agentunion/fastaun');

  const clientOpts: any = { aun_path: aunPath, debug: false };
  if (fs.existsSync(caCertPath)) clientOpts.root_ca_path = caCertPath;

  const client = new AUNClient(clientOpts);
  await client.auth.createAid({ aid });
  const authResult = await client.auth.authenticate({ aid });

  const accessToken = authResult?.access_token ?? (client as any)._access_token;
  const gateway = (client as any)._gatewayUrl ?? authResult?.gateway;

  await client.connect(
    { access_token: accessToken, gateway },
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
