import fs from 'fs';
import path from 'path';
import type { AIDStore } from '@agentunion/fastaun';
import { getAidStore, loadAid, SLOT } from './store.js';
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

/** Normalize an SDK verification result to the local union type. */
function normalizeVerification(v: { status: string; reason?: string }): AgentmdGetResult['verification'] {
  const status = v.status === 'verified' ? 'verified' : v.status === 'unsigned' ? 'unsigned' : 'invalid';
  return { status, ...(v.reason ? { reason: String(v.reason) } : {}) };
}

/**
 * Verify locally-cached agent.md content offline via the AID value object.
 * Loads the peer cert through the store (no network, no private key required).
 */
function verifyLocal(store: AIDStore, aid: string, content: string): AgentmdGetResult['verification'] {
  if (!content.includes('AUN-SIGNATURE')) {
    return { status: 'unsigned' };
  }
  try {
    const aidObj = loadAid(store, aid);
    const r = aidObj.verifyAgentMd(content);
    if (!r.ok) return { status: 'invalid', reason: r.error.message };
    return normalizeVerification(r.data);
  } catch (e: any) {
    // loadAid throws AidLoadError when the peer cert is missing/invalid.
    return { status: 'invalid', reason: `certificate not available: ${String(e?.message || e).slice(0, 100)}` };
  }
}

/**
 * Get agent.md content with optional verification.
 *
 * Flow (fastaun 0.4.6):
 * 1. store.downloadAgentMd — pulls cert + agent.md and verifies the signature
 * 2. On network failure, fall back to the local file (verify offline via loadAid)
 */
export async function agentmdGet(aid: string, opts?: { store?: AIDStore; aunPath?: string }): Promise<string>;
export async function agentmdGet(aid: string, opts: { store?: AIDStore; aunPath?: string; withVerification: true }): Promise<AgentmdGetResult>;
export async function agentmdGet(aid: string, opts?: { store?: AIDStore; aunPath?: string; withVerification?: boolean }): Promise<string | AgentmdGetResult> {
  const aunPath = opts?.aunPath ?? resolveRoot();
  const store = opts?.store ?? await getAidStore({ slotId: SLOT.cli, aunPath });
  const ownStore = !opts?.store;
  const localPath = agentMdPath(aid);

  try {
    let content: string;
    let verification: AgentmdGetResult['verification'] | undefined;

    const r = await store.downloadAgentMd(aid);
    if (r.ok) {
      content = r.data.content;
      verification = normalizeVerification(r.data.verification);
    } else {
      // Network/fetch failed — fall back to local file.
      if (!fs.existsSync(localPath)) {
        throw new Error(`fetch agent.md failed for ${aid}: ${r.error.message}`);
      }
      content = fs.readFileSync(localPath, 'utf-8');
      if (opts?.withVerification) {
        verification = verifyLocal(store, aid, content);
      }
    }

    if (!opts?.withVerification) return content;
    return { content, verification: verification ?? { status: 'unsigned' } };
  } finally {
    if (ownStore) try { store.close(); } catch { /* ignore */ }
  }
}

/**
 * Upload agent.md: write local file → store.uploadAgentMd (auto-auth + sign + upload).
 *
 * fastaun 0.4.7: uploadAgentMd moved from AUNClient to AIDStore; the store builds
 * its own LocalTokenStore + AuthFlow internally, so no AUNClient/authenticate needed.
 */
export async function agentmdPut(content: string, opts: { aid: string; store?: AIDStore; aunPath?: string }): Promise<void> {
  const aunPath = opts.aunPath ?? resolveRoot();
  const store = opts.store ?? await getAidStore({ slotId: SLOT.cli, aunPath });
  const ownStore = !opts.store;

  const dir = aidLocalDir(opts.aid);
  const filePath = path.join(dir, 'agent.md');
  const existed = fs.existsSync(filePath);

  // 先写本地文件（与旧行为一致：本地内容更新应在上传失败时仍保留）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');

  try {
    const r = await store.uploadAgentMd(opts.aid, content);
    if (!r.ok) throw new Error(`upload agent.md failed for ${opts.aid}: ${r.error.message}`);
  } catch (e) {
    // 上传失败：仅当文件原本不存在（本次新建）时回滚，避免留下孤儿文件；
    // 已存在的文件保留新内容（旧语义）。
    if (!existed) try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw e;
  } finally {
    if (ownStore) try { store.close(); } catch { /* ignore */ }
  }
}

/**
 * Check if agent.md is up-to-date (30-day TTL), fetch if changed.
 * Returns changed=true + content when a new version was downloaded.
 *
 * verification 透传 SDK 的验签结果：
 * - downloaded（changed=true）时为 SDK downloadAgentMd 的 verification
 * - 命中本地缓存或网络失败 fallback 时为 undefined（调用方需自行离线验签或视为未验证）
 *
 * Note: store.checkAgentMd tracks freshness via the store's in-memory cache,
 * so a freshly-built store reports local_found=false and will fetch.
 */
export async function agentmdSync(
  aid: string,
  opts?: { store?: AIDStore; aunPath?: string }
): Promise<{ changed: boolean; content?: string; verification?: AgentmdGetResult['verification'] }> {
  const aunPath = opts?.aunPath ?? resolveRoot();
  const store = opts?.store ?? await getAidStore({ slotId: SLOT.cli, aunPath });
  const ownStore = !opts?.store;
  const localPath = agentMdPath(aid);

  try {
    const check = await store.checkAgentMd(aid, 30);

    // In sync (cache fresh) — return local file content with cached verification status.
    if (check.ok && !check.data.needs_update && check.data.local_found) {
      const content = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : undefined;
      const verification = check.data.verify_status
        ? normalizeVerification({ status: check.data.verify_status, reason: check.data.verify_error || undefined })
        : undefined;
      return { changed: false, content, verification };
    }

    // Needs update (or check failed) — fetch fresh content.
    // SDK's downloadAgentMd persists to disk internally (AgentMdManager.saveRecord → writeContent).
    const fetched = await store.downloadAgentMd(aid);
    if (fetched.ok) {
      return { changed: true, content: fetched.data.content, verification: normalizeVerification(fetched.data.verification) };
    }

    // Fetch failed (network) — fall back to local file if present.
    const content = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : undefined;
    return { changed: false, content };
  } finally {
    if (ownStore) try { store.close(); } catch { /* ignore */ }
  }
}
