// ── IndexedDB SecretStore 实现 ──────────────────────────

import type { SecretStore } from './index.js';
import { uint8ToBase64, base64ToUint8 } from '../crypto.js';

const SECRET_DB_NAME = 'aun-secret-store';
const SECRET_DB_VERSION = 1;
const STORE_SECRETS = 'secrets';
const STORE_MASTER = 'master';

/** 打开 secret store 数据库 */
function openSecretDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SECRET_DB_NAME, SECRET_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SECRETS)) {
        db.createObjectStore(STORE_SECRETS);
      }
      if (!db.objectStoreNames.contains(STORE_MASTER)) {
        db.createObjectStore(STORE_MASTER);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 读取 */
async function secretGet(storeName: string, key: string): Promise<unknown> {
  const db = await openSecretDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** 写入 */
async function secretPut(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await openSecretDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** 删除 */
async function secretDelete(storeName: string, key: string): Promise<void> {
  const db = await openSecretDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * 基于 IndexedDB + SubtleCrypto 的 SecretStore。
 *
 * 使用 PBKDF2 从种子派生主密钥，AES-256-GCM 加解密。
 * 主密钥存储在 IndexedDB 的 'master' 仓库中（首次自动生成）。
 */
export class IndexedDBSecretStore implements SecretStore {
  private _encryptionSeed: string | undefined;
  private _masterKeyPromise: Promise<CryptoKey> | null = null;

  constructor(encryptionSeed?: string) {
    this._encryptionSeed = encryptionSeed;
  }

  /** 获取或生成主密钥（惰性初始化，只初始化一次） */
  private _getMasterKey(): Promise<CryptoKey> {
    if (!this._masterKeyPromise) {
      this._masterKeyPromise = this._initMasterKey();
    }
    return this._masterKeyPromise;
  }

  private async _initMasterKey(): Promise<CryptoKey> {
    // 如果提供了 encryptionSeed，通过 PBKDF2 派生
    if (this._encryptionSeed) {
      return this._deriveKeyFromSeed(this._encryptionSeed);
    }

    // 否则尝试从 IndexedDB 加载已有的种子
    const storedSeed = await secretGet(STORE_MASTER, 'seed');
    if (typeof storedSeed === 'string' && storedSeed) {
      return this._deriveKeyFromSeed(storedSeed);
    }

    // 首次使用：生成随机种子并持久化
    const seedBytes = new Uint8Array(32);
    crypto.getRandomValues(seedBytes);
    const seed = uint8ToBase64(seedBytes);
    await secretPut(STORE_MASTER, 'seed', seed);
    return this._deriveKeyFromSeed(seed);
  }

  private async _deriveKeyFromSeed(seed: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(seed),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('aun-secret-store-salt'),
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /** 加密并存储 */
  async protect(
    scope: string,
    name: string,
    plaintext: Uint8Array,
  ): Promise<Record<string, unknown>> {
    const masterKey = await this._getMasterKey();
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      plaintext,
    );

    const record = {
      scheme: 'indexeddb_aes_gcm',
      name,
      iv: uint8ToBase64(iv),
      ciphertext: uint8ToBase64(new Uint8Array(ciphertext)),
      persisted: true,
    };

    const storeKey = `${scope}:${name}`;
    await secretPut(STORE_SECRETS, storeKey, record);

    return record;
  }

  /** 解密还原 */
  async reveal(
    scope: string,
    name: string,
    record: Record<string, unknown>,
  ): Promise<Uint8Array | null> {
    if (record.scheme !== 'indexeddb_aes_gcm') return null;
    if (String(record.name ?? '') !== name) return null;

    const ivB64 = record.iv as string;
    const ctB64 = record.ciphertext as string;
    if (!ivB64 || !ctB64) return null;

    try {
      const masterKey = await this._getMasterKey();
      const iv = base64ToUint8(ivB64);
      const ciphertext = base64ToUint8(ctB64);

      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        masterKey,
        ciphertext,
      );

      return new Uint8Array(plaintext);
    } catch {
      return null;
    }
  }

  /** 清除 */
  async clear(scope: string, name: string): Promise<void> {
    const storeKey = `${scope}:${name}`;
    await secretDelete(STORE_SECRETS, storeKey);
  }
}
