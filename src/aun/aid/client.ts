import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import type { AUNClient } from '@agentunion/fastaun';
import { isWindows } from '../../utils/cross-platform.js';

/**
 * Suppress SDK console logs (DEBUG/INFO/WARN) in CLI context.
 * Call once at CLI entry point — NOT at module load time, to avoid
 * affecting the daemon process which imports this module for slash commands.
 */
export function suppressSdkLogs(): void {
  process.env.AUN_LOG_INI_DISABLE = '1';
  const _origLog = console.log;
  const _origInfo = console.info;
  const _origWarn = console.warn;
  const SDK_LOG_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\]\[(?:DEBUG|INFO|WARN|ERROR)\]/;
  console.log = (...args: any[]) => { if (typeof args[0] === 'string' && SDK_LOG_RE.test(args[0])) return; _origLog(...args); };
  console.info = (...args: any[]) => { if (typeof args[0] === 'string' && SDK_LOG_RE.test(args[0])) return; _origInfo(...args); };
  console.warn = (...args: any[]) => { if (typeof args[0] === 'string' && SDK_LOG_RE.test(args[0])) return; _origWarn(...args); };
  console.error = (...args: any[]) => { if (typeof args[0] === 'string' && SDK_LOG_RE.test(args[0])) return; process.stderr.write(args.map(String).join(' ') + '\n'); };
}

// ==================== Constants ====================

export const MIN_AUN_CORE_SDK = [0, 3, 4] as const;
export const AUN_CORE_SDK_PKG = '@agentunion/fastaun';

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

export async function ensureAunSdk(): Promise<void> {
  const installed = resolveAunCoreSdkPkg();
  if (installed && isAunSdkVersionOk(installed.version)) return;

  const { npmInstallGlobal } = await import('../../utils/npm-ops.js');
  console.log(`正在安装 ${AUN_CORE_SDK_PKG}@latest...`);
  await npmInstallGlobal(`${AUN_CORE_SDK_PKG}@latest`);
}

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

// ==================== AUNClient Factory ====================

export interface CreateClientOpts {
  aunPath?: string;
  /** SDK encryption seed; 留空时 SDK 自动从 {aun_path}/.seed 派生 */
  encryptionSeed?: string;
  debug?: boolean;
  /** AUNClient 第二个构造参数：是否打印 SDK 内部日志 */
  aunSdkLog?: boolean;
}

/**
 * 统一构造 AUNClient：自动绑 root_ca_path + setAgentMdPath(aidsDir())。
 * 不做 registerAid / authenticate / connect，调用方按需续作。
 *
 * 所有 new AUNClient 调用都应走此工厂，避免 SDK 默认把 agent.md 写到
 * {aun_path}/AgentMDs（默认目录）。
 */
export async function createAunClient(opts: CreateClientOpts = {}): Promise<AUNClient> {
  const { aunPath: defaultAunPath, aidsDir } = await import('../../paths.js');
  const aunPath = opts.aunPath ?? defaultAunPath();
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
  const { AUNClient } = await import('@agentunion/fastaun');

  const clientOpts: any = { aun_path: aunPath, debug: opts.debug ?? false };
  if (fs.existsSync(caCertPath)) clientOpts.root_ca_path = caCertPath;
  if (opts.encryptionSeed != null) clientOpts.encryption_seed = opts.encryptionSeed;

  const client = opts.aunSdkLog !== undefined
    ? new AUNClient(clientOpts, opts.aunSdkLog)
    : new AUNClient(clientOpts);
  client.setAgentMdPath(aidsDir());
  return client;
}

export async function getAunClient(aid: string, opts?: { aunPath?: string }): Promise<AUNClient> {
  const { loadProcessConfig } = await import('../../config-store.js');
  const encryptionSeed = loadProcessConfig().aun?.encryptionSeed
    ?? process.env.AUN_ENCRYPTION_SEED
    ?? 'evol';
  const client = await createAunClient({ aunPath: opts?.aunPath, encryptionSeed });
  await client.auth.authenticate({ aid });
  return client;
}
