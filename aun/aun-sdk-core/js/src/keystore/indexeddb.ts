// ── IndexedDB KeyStore 实现 ──────────────────────────────

import type { KeyStore } from './index.js';

/** AID 安全化（替换路径分隔符） */
function safeAid(aid: string): string {
  return aid.replace(/[/\\:]/g, '_');
}

// ── IndexedDB 工具 ──────────────────────────────────────

const DB_NAME = 'aun-keystore';
const DB_VERSION = 1;

/** 对象仓库名称 */
const STORE_KEY_PAIRS = 'key_pairs';
const STORE_CERTS = 'certs';
const STORE_METADATA = 'metadata';

/** 打开或升级数据库 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_KEY_PAIRS)) {
        db.createObjectStore(STORE_KEY_PAIRS);
      }
      if (!db.objectStoreNames.contains(STORE_CERTS)) {
        db.createObjectStore(STORE_CERTS);
      }
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 从指定仓库读取一条记录 */
async function idbGet(storeName: string, key: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** 向指定仓库写入一条记录 */
async function idbPut(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** 从指定仓库删除一条记录 */
async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// ── 保护字段常量 ──────────────────────────────────────────
const SENSITIVE_TOKEN_FIELDS = ['access_token', 'refresh_token', 'kite_token'];

/**
 * 基于 IndexedDB 的密钥存储实现。
 *
 * 数据库: 'aun-keystore'
 * 仓库:
 *   - key_pairs: 密钥对（key = safeAid(aid)）
 *   - certs: 证书 PEM（key = safeAid(aid)）
 *   - metadata: 会话/token 等元数据（key = safeAid(aid)）
 */
export class IndexedDBKeyStore implements KeyStore {

  // ── 密钥对 ──────────────────────────────────────────

  async loadKeyPair(aid: string): Promise<Record<string, unknown> | null> {
    const data = await idbGet(STORE_KEY_PAIRS, safeAid(aid));
    if (data && typeof data === 'object') {
      return data as Record<string, unknown>;
    }
    return null;
  }

  async saveKeyPair(aid: string, keyPair: Record<string, unknown>): Promise<void> {
    await idbPut(STORE_KEY_PAIRS, safeAid(aid), keyPair);
  }

  async deleteKeyPair(aid: string): Promise<void> {
    await idbDelete(STORE_KEY_PAIRS, safeAid(aid));
  }

  // ── 证书 ──────────────────────────────────────────

  async loadCert(aid: string): Promise<string | null> {
    const data = await idbGet(STORE_CERTS, safeAid(aid));
    if (typeof data === 'string') return data;
    return null;
  }

  async saveCert(aid: string, certPem: string): Promise<void> {
    await idbPut(STORE_CERTS, safeAid(aid), certPem);
  }

  // ── Metadata ──────────────────────────────────────

  async loadMetadata(aid: string): Promise<Record<string, unknown> | null> {
    const data = await idbGet(STORE_METADATA, safeAid(aid));
    if (data && typeof data === 'object') {
      return data as Record<string, unknown>;
    }
    return null;
  }

  async saveMetadata(aid: string, metadata: Record<string, unknown>): Promise<void> {
    // 防御性合并：保护关键 metadata 字段不被意外覆盖
    const existing = await this.loadMetadata(aid);
    if (existing) {
      for (const key of ['e2ee_prekeys', 'e2ee_sessions', 'group_secrets']) {
        if (key in existing && existing[key] && !(key in metadata)) {
          console.warn(`save_metadata: 传入数据缺少 '${key}' (aid=${aid})，自动合并已有数据`);
          metadata[key] = existing[key];
        }
      }
    }
    await idbPut(STORE_METADATA, safeAid(aid), metadata);
  }

  // ── 身份信息（组合操作） ──────────────────────────

  async loadIdentity(aid: string): Promise<Record<string, unknown> | null> {
    const keyPair = await this.loadKeyPair(aid);
    const cert = await this.loadCert(aid);
    const metadata = await this.loadMetadata(aid);

    if (!keyPair && !cert && !metadata) return null;

    const identity: Record<string, unknown> = {};
    if (metadata) Object.assign(identity, metadata);
    if (keyPair) Object.assign(identity, keyPair);
    if (cert) identity['cert'] = cert;
    return identity;
  }

  async saveIdentity(aid: string, identity: Record<string, unknown>): Promise<void> {
    // 拆分保存：密钥对、证书、metadata 各存各的仓库
    const keyPairFields: Record<string, unknown> = {};
    for (const key of ['private_key_pem', 'public_key_der_b64', 'curve']) {
      if (key in identity) keyPairFields[key] = identity[key];
    }
    if (Object.keys(keyPairFields).length > 0) {
      await this.saveKeyPair(aid, keyPairFields);
    }

    const cert = identity['cert'];
    if (typeof cert === 'string' && cert) {
      await this.saveCert(aid, cert);
    }

    // metadata = identity 中排除密钥对和证书的其他字段
    const metadataFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(identity)) {
      if (!['private_key_pem', 'public_key_der_b64', 'curve', 'cert'].includes(key)) {
        metadataFields[key] = value;
      }
    }
    // 合并已有 metadata
    const existing = await this.loadMetadata(aid);
    if (existing) {
      for (const [key, value] of Object.entries(metadataFields)) {
        existing[key] = value;
      }
      await this.saveMetadata(aid, existing);
    } else {
      await this.saveMetadata(aid, metadataFields);
    }
  }

  async deleteIdentity(aid: string): Promise<void> {
    await this.deleteKeyPair(aid);
    await idbDelete(STORE_CERTS, safeAid(aid));
    await idbDelete(STORE_METADATA, safeAid(aid));
  }
}
