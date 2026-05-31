import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getAidStore, loadAid, loadClient, AidLoadError, SLOT } from './store.js';
import { downloadCaRoot } from './client.js';
import { resolvePaths, aidsDir as evolclawAidsDir, agentMdPath, aunPath as defaultAunPath } from '../../paths.js';
import type { AidInfo, AidCategory, AidShowResult, AidLookupResult, AidCreateResult } from './types.js';

// ==================== Validation ====================

export function isValidAid(name: string): boolean {
  const labels = name.split('.');
  return labels.length >= 3 && labels.every(l => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(l));
}

/**
 * 根据扫描得到的状态推断 AID 分类。
 *  - hasPrivateKey + signVerified=true            → mine
 *  - hasPrivateKey + (signVerified=false 或未实测) → broken
 *  - !hasPrivateKey + hasCert                     → peer-cert
 *  - !hasPrivateKey + !hasCert                    → no-cert
 */
function categorizeAid(info: { hasPrivateKey: boolean; hasCert: boolean; signVerified: boolean | null; canSign: boolean }): AidCategory {
  if (info.hasPrivateKey) {
    if (info.signVerified === true) return 'mine';
    return 'broken';
  }
  return info.hasCert ? 'peer-cert' : 'no-cert';
}

// ==================== AID Operations ====================

export function aidList(aunPath?: string): AidInfo[] {
  const root = aunPath ?? defaultAunPath();
  const aunAidsDir = path.join(root, 'AIDs');

  const seen = new Map<string, AidInfo>();

  if (fs.existsSync(aunAidsDir)) {
    for (const e of fs.readdirSync(aunAidsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const aidDir = path.join(aunAidsDir, e.name);
      const keyJsonPath = path.join(aidDir, 'private', 'key.json');
      const hasPrivateKey = fs.existsSync(path.join(aidDir, 'private'));
      const certPath = path.join(aidDir, 'public', 'cert.pem');
      let hasCert = false;
      let certExpired = false;
      let keyMatchesCert: boolean | null = null;
      if (fs.existsSync(certPath)) {
        hasCert = true;
        try {
          const certPem = fs.readFileSync(certPath, 'utf-8');
          const x509 = new crypto.X509Certificate(certPem);
          certExpired = new Date(x509.validTo) < new Date();
          if (hasPrivateKey && fs.existsSync(keyJsonPath)) {
            try {
              const kp = JSON.parse(fs.readFileSync(keyJsonPath, 'utf-8'));
              const localPubB64 = typeof kp?.public_key_der_b64 === 'string' ? kp.public_key_der_b64 : '';
              if (localPubB64) {
                const certPubDer = x509.publicKey.export({ type: 'spki', format: 'der' });
                const localPubDer = Buffer.from(localPubB64, 'base64');
                keyMatchesCert = certPubDer.equals(localPubDer);
              }
            } catch { /* key.json 不可解析视作不匹配 */ keyMatchesCert = false; }
          }
        } catch {
          // 证书无法解析视为过期 / 不可用
          certExpired = true;
        }
      }
      seen.set(e.name, {
        aid: e.name,
        category: categorizeAid({
          hasPrivateKey,
          hasCert,
          // 静态扫描没跑实测，用 canSign 作为 mine/broken 的近似判定
          signVerified: hasPrivateKey ? (hasCert && !certExpired && keyMatchesCert === true) : null,
          canSign: hasPrivateKey && hasCert && !certExpired && keyMatchesCert === true,
        }),
        hasPrivateKey,
        hasAgentMd: fs.existsSync(agentMdPath(e.name)),
        hasCert,
        certExpired,
        keyMatchesCert,
        canSign: hasPrivateKey && hasCert && !certExpired && keyMatchesCert === true,
        signVerified: null,
      });
    }
  }

  return [...seen.values()];
}

// ==================== Sign Self-Test ====================

/**
 * 实跑一次本地 sign + verify，验证 AID 是否真能签名/验签。
 * 全本地（不联网）：用 SDK 解密私钥 → ECDSA 签 payload → 用本地 cert 公钥验。
 * 任一环节失败都视为不可签——包括私钥 passphrase 解不开、cert 被 SDK 主动 discard 等。
 */
export async function verifySignAbility(
  aid: string,
  opts?: { aunPath?: string; store?: any }
): Promise<{ ok: boolean; reason?: string }> {
  const aunPath = opts?.aunPath ?? defaultAunPath();
  let ownStore: any = null;
  try {
    let store = opts?.store;
    if (!store) {
      store = await getAidStore({ slotId: SLOT.cli, aunPath });
      ownStore = store;
    }
    // 加载本地 AID 值对象（含私钥），sign + verify 全本地完成
    let aidObj: any;
    try {
      aidObj = loadAid(store, aid);
    } catch (e: any) {
      const code = e instanceof AidLoadError ? e.code : 'LOAD_FAILED';
      return { ok: false, reason: `load failed: ${code} ${String(e?.message || e).slice(0, 100)}` };
    }
    const probe = `# probe\naid: "${aid}"\n`;
    const signRes = aidObj.signAgentMd(probe);
    if (!signRes.ok) {
      return { ok: false, reason: `sign failed: ${String(signRes.error?.message || signRes.error?.code).slice(0, 120)}` };
    }
    const verifyRes = aidObj.verifyAgentMd(signRes.data.signed);
    if (!verifyRes.ok) {
      return { ok: false, reason: `verify threw: ${String(verifyRes.error?.message || verifyRes.error?.code).slice(0, 120)}` };
    }
    if (verifyRes.data.status === 'verified') return { ok: true };
    return { ok: false, reason: `verify failed: ${verifyRes.data.status ?? 'unknown'}${verifyRes.data.reason ? ' — ' + verifyRes.data.reason : ''}` };
  } finally {
    if (ownStore) {
      try { ownStore.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * aidList 的"实测版"：先做静态扫描，再对每个 AID 跑一次本地 sign+verify。
 * 共用同一个 AUNClient 实例，避免重复初始化 secret-store / sqlite。
 */
export async function aidListVerified(aunPath?: string): Promise<AidInfo[]> {
  const list = aidList(aunPath);
  const root = aunPath ?? defaultAunPath();
  const store = await getAidStore({ slotId: SLOT.cli, aunPath: root });
  try {
    for (const a of list) {
      // canSign=false 的 AID 不必跑实测，结论已经明确
      if (!a.canSign) {
        a.signVerified = false;
        if (!a.hasPrivateKey) a.signError = 'no private key';
        else if (!a.hasCert) a.signError = 'no cert';
        else if (a.certExpired) a.signError = 'cert expired';
        else if (a.keyMatchesCert === false) a.signError = 'key/cert public-key mismatch';
        a.category = categorizeAid({
          hasPrivateKey: a.hasPrivateKey, hasCert: a.hasCert,
          signVerified: a.signVerified, canSign: a.canSign,
        });
        continue;
      }
      const r = await verifySignAbility(a.aid, { aunPath: root, store });
      a.signVerified = r.ok;
      if (!r.ok) a.signError = r.reason;
      a.category = categorizeAid({
        hasPrivateKey: a.hasPrivateKey, hasCert: a.hasCert,
        signVerified: a.signVerified, canSign: a.canSign,
      });
    }
  } finally {
    try { store.close(); } catch { /* ignore */ }
  }
  return list;
}

export async function aidCreate(aid: string, opts?: { aunPath?: string; force?: boolean }): Promise<AidCreateResult> {
  const aunPath = opts?.aunPath ?? defaultAunPath();
  const aidDir = path.join(aunPath, 'AIDs', aid);
  const hasPrivateKey = fs.existsSync(path.join(aidDir, 'private'));

  // 如果私钥已存在，先验证签名能力
  if (hasPrivateKey) {
    const verifyResult = await verifySignAbility(aid, { aunPath });

    if (verifyResult.ok) {
      // 身份有效：加载并认证，返回已认证的 client
      const store = await getAidStore({ slotId: SLOT.cli, aunPath });
      try {
        const client = await loadClient(store, aid);
        const auth = await client.authenticate();
        return { aid, alreadyExisted: true, gateway: String(auth?.gateway ?? ''), client };
      } catch (e) {
        store.close();
        throw e;
      }
    }

    // 签名验证失败
    if (!opts?.force) {
      const error = new Error(
        `AID ${aid} 已存在但身份无效（${verifyResult.reason || '签名验证失败'}）。\n` +
        `使用 --force 参数尝试恢复或重新注册。`
      ) as any;
      error.code = 'AID_INVALID';
      error.reason = verifyResult.reason;
      throw error;
    }

    // --force：先尝试 authenticate 恢复证书
    const recoverStore = await getAidStore({ slotId: SLOT.cli, aunPath });
    try {
      const recoverClient = await loadClient(recoverStore, aid);
      const auth = await recoverClient.authenticate();
      return { aid, alreadyExisted: true, gateway: String(auth?.gateway ?? ''), client: recoverClient };
    } catch {
      recoverStore.close();
      fs.rmSync(aidDir, { recursive: true, force: true });
    }
  }

  // 新注册流程：AIDStore.register → downloadCaRoot → load → authenticate
  const store = await getAidStore({ slotId: SLOT.cli, aunPath });
  try {
    const regResult = await store.register(aid);
    if (!regResult.ok) {
      const e = new Error(regResult.error.message) as any;
      e.code = regResult.error.code;
      throw e;
    }

    // 注册成功后下载 CA 根证书（如果还没有）
    // 从 AID well-known 发现 gateway 用于 CA 下载
    let gatewayUrl = '';
    try {
      const { GatewayDiscovery } = await import('@agentunion/fastaun');
      const discovery = new GatewayDiscovery({});
      gatewayUrl = await discovery.discover(`https://${aid}/.well-known/aun-gateway`);
    } catch { /* fall through */ }

    if (gatewayUrl) {
      await downloadCaRoot(aunPath, gatewayUrl);
    }

    // 重建 store（CA 可能刚下载，需要 rootCaPath 生效）
    store.close();
    const store2 = await getAidStore({ slotId: SLOT.cli, aunPath });
    try {
      const client = await loadClient(store2, aid);
      await client.authenticate();
      return { aid, alreadyExisted: false, gateway: gatewayUrl, client };
    } catch (e) {
      store2.close();
      throw e;
    }
  } catch (e) {
    store.close();
    throw e;
  }
}

// ==================== Show ====================

export async function aidShow(aid: string, opts?: { aunPath?: string }): Promise<AidShowResult> {
  const aunPath = opts?.aunPath ?? defaultAunPath();
  const aidDir = path.join(aunPath, 'AIDs', aid);

  const hasPrivateKey = fs.existsSync(path.join(aidDir, 'private'));
  const hasAgentMd = fs.existsSync(agentMdPath(aid));

  let certExpiresAt: string | null = null;
  let certSubject: string | null = null;
  let certExpired = false;
  let certPem: string | null = null;
  let keyMatchesCert: boolean | null = null;
  const certPath = path.join(aidDir, 'public', 'cert.pem');
  if (fs.existsSync(certPath)) {
    try {
      certPem = fs.readFileSync(certPath, 'utf-8');
      const x509 = new crypto.X509Certificate(certPem);
      certExpiresAt = x509.validTo;
      certSubject = x509.subject;
      certExpired = new Date(x509.validTo) < new Date();
      const keyJsonPath = path.join(aidDir, 'private', 'key.json');
      if (hasPrivateKey && fs.existsSync(keyJsonPath)) {
        try {
          const kp = JSON.parse(fs.readFileSync(keyJsonPath, 'utf-8'));
          const localPubB64 = typeof kp?.public_key_der_b64 === 'string' ? kp.public_key_der_b64 : '';
          if (localPubB64) {
            const certPubDer = x509.publicKey.export({ type: 'spki', format: 'der' });
            const localPubDer = Buffer.from(localPubB64, 'base64');
            keyMatchesCert = certPubDer.equals(localPubDer);
          }
        } catch { keyMatchesCert = false; }
      }
    } catch { /* ignore parse errors */ }
  }

  let agentMdSignature: 'verified' | 'invalid' | 'unsigned' | 'unknown' = 'unknown';
  let agentMdSignatureReason: string | undefined;
  let signVerified: boolean | null = null;
  let signError: string | undefined;

  // 先做一次签名自检（共享 store，避免重复起 SDK）
  const store = await getAidStore({ slotId: SLOT.cli, aunPath });
  try {
    if (hasPrivateKey && certPem && !certExpired && keyMatchesCert !== false) {
      const r = await verifySignAbility(aid, { aunPath, store });
      signVerified = r.ok;
      if (!r.ok) signError = r.reason;
    } else {
      signVerified = false;
      if (!hasPrivateKey) signError = 'no private key';
      else if (!certPem) signError = 'no cert';
      else if (certExpired) signError = 'cert expired';
      else if (keyMatchesCert === false) signError = 'key/cert public-key mismatch';
    }

    if (hasAgentMd) {
      try {
        const content = fs.readFileSync(agentMdPath(aid), 'utf-8');
        if (!content.includes('AUN-SIGNATURE')) {
          agentMdSignature = 'unsigned';
        } else {
          // 用本地 AID 值对象验签（含本地 cert 公钥）
          const aidObj = loadAid(store, aid);
          const result = aidObj.verifyAgentMd(content);
          if (!result.ok) {
            agentMdSignature = 'unknown';
            agentMdSignatureReason = String(result.error?.message || result.error?.code).slice(0, 100);
          } else if (result.data.status === 'verified') {
            agentMdSignature = 'verified';
          } else if (result.data.status === 'unsigned') {
            agentMdSignature = 'unsigned';
          } else {
            agentMdSignature = 'invalid';
            agentMdSignatureReason = result.data.reason;
          }
        }
      } catch (e: any) {
        agentMdSignature = 'unknown';
        agentMdSignatureReason = String(e?.message || e).slice(0, 100);
      }
    }
  } finally {
    try { store.close(); } catch {}
  }

  return { aid, hasPrivateKey, hasAgentMd, certExpiresAt, certSubject, certExpired, keyMatchesCert, signVerified, signError, agentMdSignature, agentMdSignatureReason };
}

// ==================== Delete ====================

export function aidDelete(aid: string, opts?: { aunPath?: string }): boolean {
  const aunPath = opts?.aunPath ?? defaultAunPath();
  const aidDir = path.join(aunPath, 'AIDs', aid);

  if (!fs.existsSync(aidDir)) return false;
  fs.rmSync(aidDir, { recursive: true, force: true });
  return true;
}

// ==================== PKI Cert Probe ====================

/**
 * 从 PKI 拉云端证书，与本地 key.json 公钥比对，判断 AID 是否还能恢复。
 *
 * 返回:
 *   - 'recoverable'      云端公钥 == 本地 key.json，意味着用本地私钥可继续工作（cert.pem 可重下）
 *   - 'unrecoverable'    云端公钥 != 本地 key.json，本地私钥已被服务端弃用
 *   - 'no-key'           本地无 key.json（外部 AID）
 *   - 'no-server-record' 服务端未注册或拉证书失败（视为联系不上对端）
 *   - 'unknown'          网络/证书解析等异常
 */
export type PkiRecoverability =
  | { kind: 'recoverable'; serverCertPubB64: string }
  | { kind: 'unrecoverable'; reason: string }
  | { kind: 'no-key' }
  | { kind: 'no-server-record'; reason: string }
  | { kind: 'unknown'; reason: string };

export async function probePkiRecoverability(
  aid: string,
  opts?: { aunPath?: string; timeoutMs?: number }
): Promise<PkiRecoverability> {
  const aunPath = opts?.aunPath ?? defaultAunPath();
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const keyJsonPath = path.join(aunPath, 'AIDs', aid, 'private', 'key.json');
  if (!fs.existsSync(keyJsonPath)) return { kind: 'no-key' };

  let localPubB64 = '';
  try {
    const kp = JSON.parse(fs.readFileSync(keyJsonPath, 'utf-8'));
    if (typeof kp?.public_key_der_b64 !== 'string' || !kp.public_key_der_b64) {
      return { kind: 'unknown', reason: 'key.json missing public_key_der_b64' };
    }
    localPubB64 = kp.public_key_der_b64;
  } catch (e: any) {
    return { kind: 'unknown', reason: `key.json parse failed: ${String(e?.message || e).slice(0, 80)}` };
  }

  // 1. 发现网关
  let gateway = '';
  try {
    const ctl = AbortSignal.timeout(timeoutMs);
    const gwResp = await fetch(`https://${aid}/.well-known/aun-gateway`, { redirect: 'follow', signal: ctl });
    if (gwResp.ok) {
      const text = (await gwResp.text()).trim();
      try {
        const parsed = JSON.parse(text);
        gateway = parsed?.gateways?.[0]?.url || text;
      } catch { gateway = text; }
    }
  } catch (e: any) {
    return { kind: 'no-server-record', reason: `gateway discovery failed: ${String(e?.message || e).slice(0, 80)}` };
  }
  if (!gateway) return { kind: 'no-server-record', reason: 'no gateway for AID' };

  // 2. 拉云端 cert
  let certPem = '';
  try {
    const parsed = new URL(gateway);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    const certUrl = `${scheme}//${parsed.host}/pki/cert/${encodeURIComponent(aid)}`;
    const ctl = AbortSignal.timeout(timeoutMs);
    const resp = await fetch(certUrl, { redirect: 'follow', signal: ctl });
    if (!resp.ok) {
      return { kind: 'no-server-record', reason: `pki/cert HTTP ${resp.status}` };
    }
    certPem = (await resp.text()).trim();
    if (!certPem.includes('BEGIN CERTIFICATE')) {
      return { kind: 'no-server-record', reason: 'pki/cert returned non-cert content' };
    }
  } catch (e: any) {
    return { kind: 'no-server-record', reason: `pki/cert fetch failed: ${String(e?.message || e).slice(0, 80)}` };
  }

  // 3. 比对公钥
  try {
    const x509 = new crypto.X509Certificate(certPem);
    const certPubDer = x509.publicKey.export({ type: 'spki', format: 'der' });
    const localPubDer = Buffer.from(localPubB64, 'base64');
    if (certPubDer.equals(localPubDer)) {
      return { kind: 'recoverable', serverCertPubB64: certPubDer.toString('base64') };
    }
    return {
      kind: 'unrecoverable',
      reason: 'server has different public key registered, current local private key cannot be used',
    };
  } catch (e: any) {
    return { kind: 'unknown', reason: `cert parse failed: ${String(e?.message || e).slice(0, 80)}` };
  }
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
