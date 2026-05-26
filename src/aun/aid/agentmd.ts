import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAunClient } from './client.js';
import { agentMdPath, aidLocalDir, resolveRoot } from '../../paths.js';

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
async function createBareClient(aunPath?: string): Promise<any> {
  const p = aunPath ?? resolveRoot();
  const { AUNClient } = await import('@agentunion/fastaun');
  const caCertPath = path.join(p, 'CA', 'root', 'root.crt');
  const clientOpts: any = { aun_path: p, debug: false };
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
  const aunPath = opts?.aunPath ?? resolveRoot();
  const localPath = agentMdPath(aid);

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
        const info = await client.fetchAgentMd(aid);
        const remote: string = info.content;
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
    const info = await client.fetchAgentMd(aid);
    const raw: string = info.content;

    if (!opts?.withVerification) {
      return raw;
    }

    const certPem = await obtainCertPem(aid, aunPath, client);
    const verification = await verifyContent(raw, aid, certPem, client);

    return { content: raw, verification };
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Upload agent.md: write to local file → publishAgentMd (auto-sign + upload).
 */
export async function agentmdPut(content: string, opts: { aid: string; client?: any; aunPath?: string }): Promise<void> {
  const aunPath = opts.aunPath ?? resolveRoot();
  const client = opts.client ?? await getAunClient(opts.aid, { aunPath });
  const ownClient = !opts.client;

  const dir = aidLocalDir(opts.aid);
  const filePath = path.join(dir, 'agent.md');
  const existed = fs.existsSync(filePath);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    await client.publishAgentMd();
  } catch (e) {
    if (!existed) try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw e;
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Check if agent.md is up-to-date (30-day cache), fetch if changed.
 * Returns changed=true + content when a new version was downloaded.
 */
export async function agentmdSync(
  aid: string,
  opts?: { client?: any }
): Promise<{ changed: boolean; content?: string }> {
  const client = opts?.client ?? await createBareClient();
  const ownClient = !opts?.client;
  try {
    const state = await client.checkAgentMd(aid, 30);
    if (!state.in_sync || !state.local_found) {
      const info = await client.fetchAgentMd(aid);
      return { changed: true, content: info.content };
    }
    const localPath = agentMdPath(aid);
    const content = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : undefined;
    return { changed: false, content };
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }
}
