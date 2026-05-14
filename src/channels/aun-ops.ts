/**
 * AUN AID / agent.md 原子操作层
 *
 * 短生命周期操作（创建 AID、上传 agent.md 等），供 CLI / ctl / in-chat 三层共享。
 * 与 aun.ts（长连接运行时）分离。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { isWindows } from '../utils/cross-platform.js';
import { resolvePaths } from '../paths.js';

// ==================== Constants ====================

export const MIN_AUN_CORE_SDK = [0, 2, 17] as const;
export const AUN_CORE_SDK_PKG = '@agentunion/fastaun';

// ==================== Types ====================

export interface AidInfo {
  aid: string;
  hasPrivateKey: boolean;
  hasAgentMd: boolean;
}

export interface AidCreateResult {
  aid: string;
  alreadyExisted: boolean;
  gateway: string;
  client: any; // AUNClient — dynamic import, avoid static dep
}

// ==================== SDK & Environment ====================

function compareVersion(a: string, min: readonly [number, number, number]): boolean {
  const parts = a.split('.').map(n => parseInt(n, 10));
  if (parts.length < 3 || parts.some(isNaN)) return false;
  if (parts[0] !== min[0]) return parts[0] > min[0];
  if (parts[1] !== min[1]) return parts[1] > min[1];
  return parts[2] >= min[2];
}

export function isAunSdkVersionOk(version: string): boolean {
  return compareVersion(version, MIN_AUN_CORE_SDK);
}

export function resolveAunCoreSdkPkg(): { version: string; path: string } | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
      const candidate = path.join(dir, 'node_modules', AUN_CORE_SDK_PKG, 'package.json');
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (data.name === AUN_CORE_SDK_PKG) return { version: data.version, path: candidate };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through */ }

  try {
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';
    const globalRoot = execFileSync(npmCmd, ['root', '-g'], {
      encoding: 'utf-8', timeout: 10000, shell: isWindows,
    }).trim();
    const pkgPath = path.join(globalRoot, AUN_CORE_SDK_PKG, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const data = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return { version: data.version, path: pkgPath };
    }
  } catch { /* not found */ }

  return null;
}

/** Non-interactive SDK check + auto-install */
export async function ensureAunSdk(): Promise<void> {
  const installed = resolveAunCoreSdkPkg();
  if (installed && isAunSdkVersionOk(installed.version)) return;

  const { npmInstallGlobal } = await import('../utils/init-channel.js');
  console.log(`正在安装 ${AUN_CORE_SDK_PKG}@latest...`);
  await npmInstallGlobal(`${AUN_CORE_SDK_PKG}@latest`);
}

/** SDK minimum version met? */
export function isAunSdkReady(): boolean {
  const installed = resolveAunCoreSdkPkg();
  return !!(installed && isAunSdkVersionOk(installed.version));
}

// ==================== CA Root ====================

export async function downloadCaRoot(aunPath: string, gatewayUrl: string, indent = ''): Promise<boolean> {
  const caDir = path.join(aunPath, 'CA', 'root');
  const caCertPath = path.join(caDir, 'root.crt');
  if (fs.existsSync(caCertPath)) return true;
  if (!gatewayUrl) return false;

  try {
    fs.mkdirSync(caDir, { recursive: true });
    const gwHttp = gatewayUrl.replace(/^wss?:/, 'https:').replace(/\/aun$/, '');
    const resp = await fetch(`${gwHttp}/pki/chain`, { redirect: 'follow' });
    if (!resp.ok) {
      console.warn(`${indent}⚠ CA 根证书下载失败: HTTP ${resp.status}`);
      return false;
    }
    const body = await resp.text();
    if (!body.includes('BEGIN CERTIFICATE')) {
      console.warn(`${indent}⚠ CA 根证书响应内容无效，跳过写入`);
      return false;
    }
    fs.writeFileSync(caCertPath, body);
    console.log(`${indent}✓ CA 根证书已下载`);
    return true;
  } catch (e) {
    console.warn(`${indent}⚠ CA 根证书下载失败: ${e}，可稍后手动下载`);
    return false;
  }
}

// ==================== Validation ====================

export function isValidAid(name: string): boolean {
  const labels = name.split('.');
  return labels.length >= 3 && labels.every(l => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l));
}

// ==================== AUNClient Factory ====================

/**
 * Get a short-lived AUNClient with CA cert loaded and identity ready.
 * Caller is responsible for closing: `try { await client.close(); } catch {}`
 */
export async function getAunClient(aid: string, opts?: { aunPath?: string }): Promise<any> {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
  const { AUNClient } = await import('@agentunion/fastaun');

  const clientOpts: any = { aun_path: aunPath };
  if (fs.existsSync(caCertPath)) clientOpts.root_ca_path = caCertPath;

  const client = new AUNClient(clientOpts);
  // Ensure identity is loaded (idempotent if already created)
  await client.auth.createAid({ aid });
  return client;
}

// ==================== AID Operations ====================

export function aidList(aunPath?: string): AidInfo[] {
  const aidsDir = path.join(aunPath ?? path.join(os.homedir(), '.aun'), 'AIDs');
  if (!fs.existsSync(aidsDir)) return [];

  const entries = fs.readdirSync(aidsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => ({
      aid: e.name,
      hasPrivateKey: fs.existsSync(path.join(aidsDir, e.name, 'private')),
      hasAgentMd: fs.existsSync(path.join(aidsDir, e.name, 'agent.md')),
    }));
}

/**
 * Create AID: keygen + register + CA download.
 * Does NOT touch agent.md — call agentmdPut separately.
 * Returns a reusable client (caller must close).
 */
export async function aidCreate(aid: string, opts?: { aunPath?: string }): Promise<AidCreateResult> {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const aidDir = path.join(aunPath, 'AIDs', aid);

  // Already exists locally
  if (fs.existsSync(aidDir) && fs.existsSync(path.join(aidDir, 'private'))) {
    const client = await getAunClient(aid, { aunPath });
    return { aid, alreadyExisted: true, gateway: '', client };
  }

  const { AUNClient, GatewayDiscovery } = await import('@agentunion/fastaun');
  let client = new AUNClient({ aun_path: aunPath });

  try {
    const result = await client.auth.createAid({ aid });
    const gateway = result.gateway || '';

    // Download CA root cert
    const caDownloaded = await downloadCaRoot(aunPath, gateway);

    // Rebuild client with CA cert for subsequent operations
    const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
    if (caDownloaded && fs.existsSync(caCertPath)) {
      try { await client.close(); } catch { /* ignore */ }
      client = new AUNClient({ aun_path: aunPath, root_ca_path: caCertPath });
      await client.auth.createAid({ aid });
    }

    // Set gateway URL for upload operations
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

// ==================== AgentMd Operations ====================

export function buildInitialAgentMd(opts: { aid: string; type?: string }): string {
  const agentName = opts.aid.split('.')[0];
  const agentType = opts.type || 'ai';
  return `---\naid: "${opts.aid}"\nname: "${agentName}"\ntype: "${agentType}"\nversion: "1.0.0"\ndescription: ""\ntags:\n  - evolclaw\ninitialized: false\n---\n`;
}

/**
 * Get agent.md content.
 * For self (local AID with private key): reads local file, falls back to download.
 * For others: downloads from AUN network.
 */
export async function agentmdGet(aid: string, opts?: { client?: any; aunPath?: string }): Promise<string> {
  const aunPath = opts?.aunPath ?? path.join(os.homedir(), '.aun');
  const localPath = path.join(aunPath, 'AIDs', aid, 'agent.md');

  // Try local first for self AIDs (has private key)
  const hasPrivateKey = fs.existsSync(path.join(aunPath, 'AIDs', aid, 'private'));
  if (hasPrivateKey && fs.existsSync(localPath)) {
    return fs.readFileSync(localPath, 'utf-8');
  }

  // Download from network
  const client = opts?.client ?? await getAunClient(aid, { aunPath });
  const ownClient = !opts?.client;
  try {
    return await client.auth.downloadAgentMd(aid);
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Upload agent.md (sign + upload) and sync to local file.
 * If client is provided, reuses it; otherwise creates a short-lived one.
 */
export async function agentmdPut(content: string, opts: { aid: string; client?: any; aunPath?: string }): Promise<void> {
  const aunPath = opts.aunPath ?? path.join(os.homedir(), '.aun');
  const client = opts.client ?? await getAunClient(opts.aid, { aunPath });
  const ownClient = !opts.client;

  try {
    await client.auth.uploadAgentMd(content);
  } finally {
    if (ownClient) try { await client.close(); } catch { /* ignore */ }
  }

  // Sync to local
  const aidDir = path.join(aunPath, 'AIDs', opts.aid);
  fs.mkdirSync(aidDir, { recursive: true });
  fs.writeFileSync(path.join(aidDir, 'agent.md'), content, 'utf-8');
}

// ==================== Config ====================

/**
 * Append a new AUN instance to the config's channels.aun array and save.
 * Handles upgrade from single-object to array format.
 */
export function appendAunInstance(config: any, inst: { name: string; aid: string; owner?: string; enabled?: boolean }): void {
  if (!config.channels) config.channels = {};

  const newInst = {
    name: inst.name,
    enabled: inst.enabled ?? true,
    aid: inst.aid,
    ...(inst.owner && { owner: inst.owner }),
  };

  if (Array.isArray(config.channels.aun)) {
    config.channels.aun.push(newInst);
  } else if (config.channels.aun) {
    const oldInst = { ...config.channels.aun, name: config.channels.aun.name || 'aun' };
    config.channels.aun = [oldInst, newInst];
  } else {
    config.channels.aun = [newInst];
  }

  fs.writeFileSync(resolvePaths().config, JSON.stringify(config, null, 2) + '\n');
}

