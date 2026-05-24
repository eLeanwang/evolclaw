import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getAunClient, downloadCaRoot } from './client.js';
import { resolvePaths, aidsDir as evolclawAidsDir, agentMdPath } from '../../paths.js';
import type { AidInfo, AidShowResult, AidLookupResult, AidCreateResult } from './types.js';

// ==================== Validation ====================

export function isValidAid(name: string): boolean {
  const labels = name.split('.');
  return labels.length >= 3 && labels.every(l => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l));
}

// ==================== AID Operations ====================

export function aidList(aunPath?: string): AidInfo[] {
  const aunAidsDir = path.join(aunPath ?? path.join(os.homedir(), '.aun'), 'AIDs');
  const ecAidsDir = evolclawAidsDir();

  const seen = new Map<string, AidInfo>();

  // Scan ~/.aun/AIDs (private keys live here)
  if (fs.existsSync(aunAidsDir)) {
    for (const e of fs.readdirSync(aunAidsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      seen.set(e.name, {
        aid: e.name,
        hasPrivateKey: fs.existsSync(path.join(aunAidsDir, e.name, 'private')),
        hasAgentMd: fs.existsSync(agentMdPath(e.name)),
      });
    }
  }

  // Scan $EVOLCLAW_HOME/AIDs (agent.md lives here)
  if (fs.existsSync(ecAidsDir) && ecAidsDir !== aunAidsDir) {
    for (const e of fs.readdirSync(ecAidsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (seen.has(e.name)) continue;
      seen.set(e.name, {
        aid: e.name,
        hasPrivateKey: fs.existsSync(path.join(aunAidsDir, e.name, 'private')),
        hasAgentMd: fs.existsSync(agentMdPath(e.name)),
      });
    }
  }

  return [...seen.values()];
}

export async function aidCreate(aid: string, opts?: { aunPath?: string }): Promise<AidCreateResult> {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const aidDir = path.join(aunPath, 'AIDs', aid);

  if (fs.existsSync(aidDir) && fs.existsSync(path.join(aidDir, 'private'))) {
    const client = await getAunClient(aid, { aunPath });
    return { aid, alreadyExisted: true, gateway: '', client };
  }

  const { AUNClient, GatewayDiscovery } = await import('@agentunion/fastaun');
  let client = new AUNClient({ aun_path: aunPath });

  try {
    const result = await client.auth.createAid({ aid });
    const gateway = result.gateway || '';

    const caDownloaded = await downloadCaRoot(aunPath, gateway);

    const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
    if (caDownloaded && fs.existsSync(caCertPath)) {
      try { await client.close(); } catch { /* ignore */ }
      client = new AUNClient({ aun_path: aunPath, root_ca_path: caCertPath });
      await client.auth.createAid({ aid });
    }

    let gatewayUrl = gateway;
    if (!gatewayUrl) {
      try {
        const discovery = new GatewayDiscovery({});
        gatewayUrl = await discovery.discover(`https://${aid}/.well-known/aun-gateway`);
      } catch { /* fall through */ }
    }
    if (gatewayUrl) {
      (client as any)._gatewayUrl = gatewayUrl;
    }

    return { aid, alreadyExisted: false, gateway: gatewayUrl, client };
  } catch (e) {
    try { await client.close(); } catch { /* ignore */ }
    throw e;
  }
}

// ==================== Show ====================

export function aidShow(aid: string, opts?: { aunPath?: string }): AidShowResult {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const aidDir = path.join(aunPath, 'AIDs', aid);

  const hasPrivateKey = fs.existsSync(path.join(aidDir, 'private'));
  const hasAgentMd = fs.existsSync(agentMdPath(aid));

  let certExpiresAt: string | null = null;
  let certSubject: string | null = null;
  const certPath = path.join(aidDir, 'public', 'cert.pem');
  if (fs.existsSync(certPath)) {
    try {
      const pem = fs.readFileSync(certPath, 'utf-8');
      const x509 = new crypto.X509Certificate(pem);
      certExpiresAt = x509.validTo;
      certSubject = x509.subject;
    } catch { /* ignore parse errors */ }
  }

  return { aid, hasPrivateKey, hasAgentMd, certExpiresAt, certSubject };
}

// ==================== Delete ====================

export function aidDelete(aid: string, opts?: { aunPath?: string }): boolean {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const aidDir = path.join(aunPath, 'AIDs', aid);

  if (!fs.existsSync(aidDir)) return false;
  fs.rmSync(aidDir, { recursive: true, force: true });
  return true;
}

// ==================== Lookup ====================

export async function aidLookup(aid: string): Promise<AidLookupResult> {
  let gateway = '';
  try {
    const gwResp = await fetch(`https://${aid}/.well-known/aun-gateway`, { redirect: 'follow' });
    if (gwResp.ok) {
      const text = await gwResp.text();
      // Response may be JSON with gateways array or plain URL
      try {
        const parsed = JSON.parse(text.trim());
        if (parsed.gateways?.[0]?.url) {
          gateway = parsed.gateways[0].url;
        } else {
          gateway = text.trim();
        }
      } catch {
        gateway = text.trim();
      }
    }
  } catch { /* ignore */ }

  try {
    const resp = await fetch(`https://${aid}/agent.md`, { redirect: 'follow' });
    if (resp.ok) {
      const content = await resp.text();
      return { exists: true, aid, gateway, content };
    }
    return { exists: false, aid, gateway, error: `agent_md_not_found` };
  } catch (e: any) {
    return { exists: false, aid, gateway, error: String(e.message || e) };
  }
}

// ==================== Lifecycle Log ====================

export interface AidLifecycleEvent {
  ts: number;
  iso: string;
  event: 'connected' | 'disconnected' | 'kicked' | 'reconnecting';
  aid: string;
  [key: string]: unknown;
}

function lifecycleLogPath(aid: string): string {
  const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
  return path.join(resolvePaths().aidLogsDir, `${aidName}.jsonl`);
}

export function appendAidLifecycle(event: AidLifecycleEvent): void {
  const filePath = lifecycleLogPath(event.aid);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
}

export function readAidLifecycle(aid: string, lastN = 50): AidLifecycleEvent[] {
  const filePath = lifecycleLogPath(aid);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const events: AidLifecycleEvent[] = [];
    for (const line of lines.slice(-lastN)) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return events;
  } catch {
    return [];
  }
}
