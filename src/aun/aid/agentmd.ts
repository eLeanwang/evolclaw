import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAunClient } from './client.js';

export interface AgentmdGetResult {
  content: string;
  verification: { status: 'verified' | 'invalid' | 'unsigned'; reason?: string };
}

export function buildInitialAgentMd(opts: { aid: string; type?: string }): string {
  const agentName = opts.aid.split('.')[0];
  const agentType = opts.type || 'ai';
  return `---\naid: "${opts.aid}"\nname: "${agentName}"\ntype: "${agentType}"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\n---\n`;
}

/**
 * Resolve the gateway URL for an AID via .well-known discovery.
 */
async function discoverGateway(aid: string): Promise<string | undefined> {
  try {
    const resp = await fetch(`https://${aid}/.well-known/aun-gateway`, { redirect: 'follow' });
    if (!resp.ok) return undefined;
    const text = await resp.text();
    try {
      return JSON.parse(text.trim()).gateways?.[0]?.url ?? text.trim();
    } catch {
      return text.trim();
    }
  } catch { return undefined; }
}

/**
 * Obtain cert PEM for an AID: local first, then network.
 * Persists fetched cert to local for future use.
 */
async function obtainCertPem(aid: string, aunPath: string, client?: any): Promise<string | undefined> {
  const localCert = path.join(aunPath, 'AIDs', aid, 'public', 'cert.pem');
  if (fs.existsSync(localCert)) {
    return fs.readFileSync(localCert, 'utf-8');
  }

  // Fetch from network via SDK's _fetchPeerCert (needs gateway)
  if (client) {
    try {
      if (!(client as any)._gatewayUrl) {
        (client as any)._gatewayUrl = await discoverGateway(aid);
      }
      if ((client as any)._gatewayUrl) {
        const certPem = await (client as any)._fetchPeerCert.call(client, aid);
        // Persist for future use
        if (certPem) {
          const certDir = path.join(aunPath, 'AIDs', aid, 'public');
          fs.mkdirSync(certDir, { recursive: true });
          fs.writeFileSync(localCert, certPem, 'utf-8');
        }
        return certPem;
      }
    } catch { /* fall through */ }
  }

  return undefined;
}

/**
 * Verify agent.md content using SDK.
 */
async function verifyContent(content: string, aid: string, certPem: string | undefined, client: any): Promise<AgentmdGetResult['verification']> {
  if (!content.includes('AUN-SIGNATURE')) {
    return { status: 'unsigned' };
  }
  if (!certPem) {
    return { status: 'invalid', reason: 'certificate not available' };
  }
  try {
    const result = await client.auth.verifyAgentMd(content, { aid, certPem });
    if (result.status === 'verified' || result.verified) {
      return { status: 'verified' };
    }
    return { status: 'invalid', reason: result.reason };
  } catch (e: any) {
    return { status: 'invalid', reason: `verify error: ${String(e.message || e).slice(0, 100)}` };
  }
}

/**
 * Create a bare AUNClient (no createAid) for read-only operations.
 */
async function createBareClient(aunPath: string): Promise<any> {
  const { AUNClient } = await import('@agentunion/fastaun');
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
  const clientOpts: any = { aun_path: aunPath, debug: false };
  if (fs.existsSync(caCertPath)) clientOpts.root_ca_path = caCertPath;
  return new AUNClient(clientOpts);
}

/**
 * Get agent.md content with optional verification.
 *
 * Flow:
 * 1. Local agent.md exists → verify locally (fetch cert if needed)
 *    - verified → return
 *    - invalid → fallback to remote download → verify → overwrite local if valid
 * 2. No local agent.md → download from remote → verify → persist
 */
export async function agentmdGet(aid: string, opts?: { client?: any; aunPath?: string }): Promise<string>;
export async function agentmdGet(aid: string, opts: { client?: any; aunPath?: string; withVerification: true }): Promise<AgentmdGetResult>;
export async function agentmdGet(aid: string, opts?: { client?: any; aunPath?: string; withVerification?: boolean }): Promise<string | AgentmdGetResult> {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const localPath = path.join(aunPath, 'AIDs', aid, 'agent.md');

  // === Path A: local agent.md exists ===
  if (fs.existsSync(localPath)) {
    const content = fs.readFileSync(localPath, 'utf-8');
    if (!opts?.withVerification) return content;

    // Verify local content
    const client = opts?.client ?? await createBareClient(aunPath);
    const ownClient = !opts?.client;
    try {
      const certPem = await obtainCertPem(aid, aunPath, client);
      const verification = await verifyContent(content, aid, certPem, client);

      if (verification.status !== 'invalid') {
        return { content, verification };
      }

      // Fallback: local invalid → try remote
      try {
        const remote: string = await client.auth.downloadAgentMd(aid);
        if (remote) {
          const remoteVerification = await verifyContent(remote, aid, certPem, client);
          if (remoteVerification.status === 'verified') {
            fs.writeFileSync(localPath, remote, 'utf-8');
            return { content: remote, verification: remoteVerification };
          }
        }
      } catch { /* remote fetch failed, return local invalid result */ }

      return { content, verification };
    } finally {
      if (ownClient) try { await client.close(); } catch { /* ignore */ }
    }
  }

  // === Path B: no local agent.md → download from remote ===
  const client = opts?.client ?? await createBareClient(aunPath);
  const ownClient = !opts?.client;
  try {
    const raw: string = await client.auth.downloadAgentMd(aid);

    if (!opts?.withVerification) {
      // Persist without verification
      const aidDir = path.join(aunPath, 'AIDs', aid);
      fs.mkdirSync(aidDir, { recursive: true });
      fs.writeFileSync(path.join(aidDir, 'agent.md'), raw, 'utf-8');
      return raw;
    }

    const certPem = await obtainCertPem(aid, aunPath, client);
    const verification = await verifyContent(raw, aid, certPem, client);

    // Persist to local
    const aidDir = path.join(aunPath, 'AIDs', aid);
    fs.mkdirSync(aidDir, { recursive: true });
    fs.writeFileSync(path.join(aidDir, 'agent.md'), raw, 'utf-8');

    return { content: raw, verification };
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Upload agent.md: auto-sign + upload + sync to local file.
 */
export async function agentmdPut(content: string, opts: { aid: string; client?: any; aunPath?: string }): Promise<void> {
  const aunPath = opts.aunPath ?? path.join(os.homedir(), '.aun');
  const client = opts.client ?? await getAunClient(opts.aid, { aunPath });
  const ownClient = !opts.client;

  try {
    let signed: string;
    try {
      signed = await client.auth.signAgentMd(content);
    } catch {
      signed = content;
    }

    await client.auth.uploadAgentMd(signed);

    const aidDir = path.join(aunPath, 'AIDs', opts.aid);
    fs.mkdirSync(aidDir, { recursive: true });
    fs.writeFileSync(path.join(aidDir, 'agent.md'), signed, 'utf-8');
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }
}
