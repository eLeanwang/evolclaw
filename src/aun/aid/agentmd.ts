import fs from 'fs';
import path from 'path';
import { getAunClient, createAunClient } from './client.js';
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
  return createAunClient({ aunPath });
}

/**
 * Get agent.md content with optional verification.
 *
 * Standard flow (SDK 0.3.3):
 * 1. agentmdSync (check + fetch if changed) — SDK auto-saves to {agentMdPath}/{aid}/agent.md
 * 2. If sync fails, fall back to local file
 * 3. With verification: signature status from fetchAgentMd is the source of truth
 */
export async function agentmdGet(aid: string, opts?: { client?: any; aunPath?: string }): Promise<string>;
export async function agentmdGet(aid: string, opts: { client?: any; aunPath?: string; withVerification: true }): Promise<AgentmdGetResult>;
export async function agentmdGet(aid: string, opts?: { client?: any; aunPath?: string; withVerification?: boolean }): Promise<string | AgentmdGetResult> {
  const aunPath = opts?.aunPath ?? resolveRoot();
  const client = opts?.client ?? await createBareClient(aunPath);
  const ownClient = !opts?.client;
  const localPath = agentMdPath(aid);

  try {
    // Try SDK fetch (auto-saves locally + verifies signature)
    let content: string | undefined;
    let verification: AgentmdGetResult['verification'] | undefined;
    try {
      const info = await client.fetchAgentMd(aid);
      content = info.content;
      const sig: any = info.signature ?? {};
      const status = sig.status === 'verified' ? 'verified' : sig.status === 'unsigned' ? 'unsigned' : 'invalid';
      verification = { status, ...(sig.reason ? { reason: String(sig.reason) } : {}) };
    } catch (err) {
      // Network failed — fall back to local file (verify signature via SDK if requested)
      if (!fs.existsSync(localPath)) throw err;
      content = fs.readFileSync(localPath, 'utf-8');
      if (opts?.withVerification) {
        const certPem = await obtainCertPem(aid, aunPath, client);
        verification = await verifyContent(content, aid, certPem, client);
      }
    }

    if (!opts?.withVerification) return content!;
    return { content: content!, verification: verification ?? { status: 'unsigned' } };
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
