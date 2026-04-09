/**
 * 基于文件的 SecretStore（AES-256-GCM 加密）
 *
 * 密钥派生：
 *   - 传入 encryptionSeed → 从 seed 字符串派生
 *   - 未传 → 从 {root}/.seed 文件派生（首次自动生成）
 *
 * 与 Python SDK 的 FileSecretStore 完全对齐。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SecretStore } from './index.js';

export class FileSecretStore implements SecretStore {
  private _root: string;
  private _masterKey: Buffer;

  constructor(root: string, encryptionSeed?: string) {
    this._root = root;
    mkdirSync(this._root, { recursive: true });

    let seedBytes: Buffer;
    if (encryptionSeed) {
      seedBytes = Buffer.from(encryptionSeed, 'utf-8');
    } else {
      seedBytes = this._loadOrCreateSeed();
    }

    // PBKDF2 派生主密钥，与 Python SDK 参数完全一致
    this._masterKey = pbkdf2Sync(
      seedBytes,
      'aun_file_secret_store_v1',
      100_000,
      32,
      'sha256',
    );
  }

  protect(scope: string, name: string, plaintext: Buffer): Record<string, unknown> {
    const key = this._deriveKey(scope, name);
    const nonce = randomBytes(12);

    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      scheme: 'file_aes',
      name,
      persisted: true,
      nonce: nonce.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  reveal(scope: string, name: string, record: Record<string, unknown>): Buffer | null {
    if (record.scheme !== 'file_aes') return null;
    if (String(record.name ?? '') !== name) return null;

    const nonceB64 = String(record.nonce ?? '');
    const ctB64 = String(record.ciphertext ?? '');
    const tagB64 = String(record.tag ?? '');
    if (!nonceB64 || !ctB64 || !tagB64) return null;

    const key = this._deriveKey(scope, name);

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64')),
        decipher.final(),
      ]);
      return decrypted;
    } catch {
      return null;
    }
  }

  clear(_scope: string, _name: string): void {
    // 与 Python SDK 一致：file_aes 方案不需要额外清理
    return;
  }

  /** 使用 HMAC-SHA256 从主密钥派生子密钥 */
  private _deriveKey(scope: string, name: string): Buffer {
    return createHmac('sha256', this._masterKey)
      .update(`aun:${scope}:${name}\x01`)
      .digest();
  }

  /** 加载或创建种子文件 */
  private _loadOrCreateSeed(): Buffer {
    const seedPath = join(this._root, '.seed');
    if (existsSync(seedPath)) {
      return readFileSync(seedPath);
    }
    const seed = randomBytes(32);
    writeFileSync(seedPath, seed);
    if (process.platform !== 'win32') {
      try {
        chmodSync(seedPath, 0o600);
      } catch {
        // 平台兼容 fallback
      }
    }
    return seed;
  }
}
