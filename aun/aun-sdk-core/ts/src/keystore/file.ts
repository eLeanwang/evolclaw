/**
 * 基于文件系统的 KeyStore 实现
 *
 * 与 Python SDK 的 FileKeyStore 完全对齐：
 * - 目录结构：{root}/AIDs/{safeAid}/private/key.json, public/cert.pem, tokens/meta.json
 * - safeAid：将 /, \, : 替换为 _
 * - 敏感字段（access_token, refresh_token, kite_token）通过 SecretStore 保护
 * - e2ee_prekeys 的 private_key_pem 通过 SecretStore 保护
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { KeyStore } from './index.js';
import type { SecretStore } from '../secret-store/index.js';
import { createDefaultSecretStore } from '../secret-store/index.js';

/** 需要通过 SecretStore 保护的 token 字段 */
const SENSITIVE_TOKEN_FIELDS = ['access_token', 'refresh_token', 'kite_token'] as const;

/** 关键 metadata 键（防御性合并） */
const CRITICAL_METADATA_KEYS = ['e2ee_prekeys', 'e2ee_sessions', 'group_secrets'] as const;

/** 在 Unix 系统上将文件权限设为 0o600（仅属主可读写） */
function secureFilePermissions(path: string): void {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // 平台兼容 fallback
    }
  }
}

export class FileKeyStore implements KeyStore {
  private _root: string;
  private _aidsRoot: string;
  private _secretStore: SecretStore;

  constructor(
    root?: string,
    opts?: {
      secretStore?: SecretStore;
      encryptionSeed?: string;
    },
  ) {
    const preferred = root ?? join(homedir(), '.aun');
    const fallback = join(process.cwd(), '.aun');
    const resolvedRoot = this._prepareRoot(preferred, fallback);

    this._secretStore = opts?.secretStore ?? createDefaultSecretStore(resolvedRoot, opts?.encryptionSeed);
    this._root = resolvedRoot;
    this._aidsRoot = join(this._root, 'AIDs');
    mkdirSync(this._aidsRoot, { recursive: true });
  }

  // ── 公开接口 ────────────────────────────────────────────

  loadIdentity(aid: string): Record<string, unknown> | null {
    // 优先从拆分文件加载
    const identity = this._loadIdentityFromSplitFiles(aid);
    if (identity !== null) return identity;
    return null;
  }

  saveIdentity(aid: string, identity: Record<string, unknown>): void {
    // 保存密钥对
    const keyPairKeys = ['private_key_pem', 'public_key_der_b64', 'curve'] as const;
    const keyPair: Record<string, unknown> = {};
    let hasKeyPair = false;
    for (const k of keyPairKeys) {
      if (k in identity) {
        keyPair[k] = identity[k];
        hasKeyPair = true;
      }
    }
    if (hasKeyPair) this.saveKeyPair(aid, keyPair);

    // 保存证书
    const cert = identity.cert;
    if (typeof cert === 'string' && cert) this.saveCert(aid, cert);

    // 合并 metadata 而非覆盖
    const excludeKeys = new Set(['private_key_pem', 'public_key_der_b64', 'curve', 'cert']);
    const newFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(identity)) {
      if (!excludeKeys.has(key)) newFields[key] = value;
    }
    const existing = this.loadMetadata(aid) ?? {};
    Object.assign(existing, newFields);
    this.saveMetadata(aid, existing);
  }

  deleteIdentity(aid: string): void {
    const scope = FileKeyStore._safeAid(aid);
    this._secretStore.clear(scope, 'identity/private_key');
    this.deleteKeyPair(aid);

    const certPath = this._certPath(aid);
    if (existsSync(certPath)) unlinkSync(certPath);

    const metaPath = this._metadataPath(aid);
    if (existsSync(metaPath)) unlinkSync(metaPath);

    const identityDir = this._identityDir(aid);
    if (existsSync(identityDir)) {
      rmSync(identityDir, { recursive: true, force: true });
    }
  }

  loadKeyPair(aid: string): Record<string, unknown> | null {
    const path = this._keyPairPath(aid);
    if (existsSync(path)) {
      const keyPair = JSON.parse(readFileSync(path, 'utf-8'));
      return this._restoreKeyPair(aid, keyPair);
    }
    return null;
  }

  saveKeyPair(aid: string, keyPair: Record<string, unknown>): void {
    const path = this._keyPairPath(aid);
    mkdirSync(join(path, '..'), { recursive: true });

    // 深拷贝后保护私钥
    const protected_ = { ...keyPair };
    const scope = FileKeyStore._safeAid(aid);
    const privateKeyPem = protected_.private_key_pem;
    delete protected_.private_key_pem;

    if (typeof privateKeyPem === 'string' && privateKeyPem) {
      const protection = this._secretStore.protect(
        scope,
        'identity/private_key',
        Buffer.from(privateKeyPem, 'utf-8'),
      );
      if (!protection.persisted) {
        throw new Error(
          `SecretStore 无法持久化私钥 (scheme=${protection.scheme})。` +
          `私钥必须能跨进程重启保留，请检查密钥存储配置。`,
        );
      }
      protected_.private_key_protection = protection;
    } else if (!('private_key_protection' in protected_)) {
      this._secretStore.clear(scope, 'identity/private_key');
    }

    writeFileSync(path, JSON.stringify(protected_, null, 2), 'utf-8');
    secureFilePermissions(path);
  }

  loadCert(aid: string): string | null {
    const path = this._certPath(aid);
    if (existsSync(path)) return readFileSync(path, 'utf-8');
    return null;
  }

  saveCert(aid: string, certPem: string): void {
    const path = this._certPath(aid);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, certPem, 'utf-8');
  }

  loadMetadata(aid: string): Record<string, unknown> | null {
    const path = this._metadataPath(aid);
    if (existsSync(path)) {
      return this._restoreMetadata(aid, JSON.parse(readFileSync(path, 'utf-8')));
    }
    return null;
  }

  saveMetadata(aid: string, metadata: Record<string, unknown>): void {
    const path = this._metadataPath(aid);
    mkdirSync(join(path, '..'), { recursive: true });

    // 防御性合并：磁盘上已有关键数据而传入缺失时自动恢复
    if (existsSync(path)) {
      try {
        const existing = this._restoreMetadata(
          aid,
          JSON.parse(readFileSync(path, 'utf-8')),
        );
        for (const key of CRITICAL_METADATA_KEYS) {
          if (existing[key] && !(key in metadata)) {
            console.warn(
              `save_metadata: 传入数据缺少 '${key}' (aid=${aid})，自动合并磁盘已有数据`,
            );
            metadata[key] = existing[key];
          }
        }
      } catch {
        // 解析失败忽略
      }
    }

    const protected_ = this._protectMetadata(aid, metadata);
    writeFileSync(path, JSON.stringify(protected_, null, 2), 'utf-8');
    secureFilePermissions(path);
  }

  deleteKeyPair(aid: string): void {
    const path = this._keyPairPath(aid);
    if (existsSync(path)) unlinkSync(path);
  }

  /**
   * 扫描所有已存储的身份，返回第一个可用的。
   */
  loadAnyIdentity(): Record<string, unknown> | null {
    if (!existsSync(this._aidsRoot)) return null;
    const candidates: string[] = [];
    try {
      for (const entry of readdirSync(this._aidsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(entry.name);
      }
    } catch {
      return null;
    }
    for (const aid of candidates.sort()) {
      const identity = this.loadIdentity(aid);
      if (identity !== null) return identity;
    }
    return null;
  }

  // ── 路径计算 ────────────────────────────────────────────

  static _safeAid(aid: string): string {
    return aid.replace(/[/\\:]/g, '_');
  }

  private _identityDir(aid: string): string {
    return join(this._aidsRoot, FileKeyStore._safeAid(aid));
  }

  private _keyPairPath(aid: string): string {
    return join(this._identityDir(aid), 'private', 'key.json');
  }

  private _certPath(aid: string): string {
    return join(this._identityDir(aid), 'public', 'cert.pem');
  }

  private _metadataPath(aid: string): string {
    return join(this._identityDir(aid), 'tokens', 'meta.json');
  }

  // ── 内部辅助 ────────────────────────────────────────────

  private _loadIdentityFromSplitFiles(aid: string): Record<string, unknown> | null {
    const keyPair = this.loadKeyPair(aid);
    const cert = this.loadCert(aid);
    const metadata = this.loadMetadata(aid);
    if (keyPair === null && cert === null && metadata === null) return null;

    const identity: Record<string, unknown> = {};
    if (metadata) Object.assign(identity, metadata);
    if (keyPair) Object.assign(identity, keyPair);
    if (cert) identity.cert = cert;
    return identity;
  }

  private _restoreKeyPair(aid: string, keyPair: Record<string, unknown>): Record<string, unknown> {
    const restored = { ...keyPair };
    const scope = FileKeyStore._safeAid(aid);
    const record = restored.private_key_protection;
    if (record && typeof record === 'object') {
      const value = this._secretStore.reveal(scope, 'identity/private_key', record as Record<string, unknown>);
      if (value !== null) {
        restored.private_key_pem = value.toString('utf-8');
      } else {
        delete restored.private_key_pem;
      }
    }
    return restored;
  }

  private _protectMetadata(aid: string, metadata: Record<string, unknown>): Record<string, unknown> {
    const protected_: Record<string, unknown> = { ...metadata };
    const scope = FileKeyStore._safeAid(aid);

    // 保护 token 字段
    for (const field of SENSITIVE_TOKEN_FIELDS) {
      const value = protected_[field];
      delete protected_[field];
      if (typeof value === 'string' && value) {
        protected_[`${field}_protection`] = this._secretStore.protect(scope, field, Buffer.from(value, 'utf-8'));
      } else if (!(`${field}_protection` in protected_)) {
        this._secretStore.clear(scope, field);
      }
    }

    // 保护 e2ee_sessions 中的 key
    const sessions = protected_.e2ee_sessions;
    if (Array.isArray(sessions)) {
      const sanitized: Record<string, unknown>[] = [];
      for (const raw of sessions) {
        if (!raw || typeof raw !== 'object') continue;
        const session = { ...(raw as Record<string, unknown>) };
        const secretName = this._sessionSecretName(session);
        const key = session.key;
        delete session.key;
        if (typeof key === 'string' && key && secretName) {
          session.key_protection = this._secretStore.protect(scope, secretName, Buffer.from(key, 'utf-8'));
        } else if (secretName && !('key_protection' in session)) {
          this._secretStore.clear(scope, secretName);
        }
        sanitized.push(session);
      }
      protected_.e2ee_sessions = sanitized;
    }

    // 保护 prekey 私钥
    const prekeys = protected_.e2ee_prekeys;
    if (prekeys && typeof prekeys === 'object' && !Array.isArray(prekeys)) {
      const sanitized: Record<string, Record<string, unknown>> = {};
      for (const [prekeyId, prekeyData] of Object.entries(prekeys as Record<string, unknown>)) {
        if (!prekeyData || typeof prekeyData !== 'object') continue;
        const prekey = { ...(prekeyData as Record<string, unknown>) };
        const secretName = `e2ee_prekeys/${prekeyId}/private_key`;
        const val = prekey.private_key_pem;
        delete prekey.private_key_pem;
        if (typeof val === 'string' && val) {
          prekey.private_key_protection = this._secretStore.protect(scope, secretName, Buffer.from(val, 'utf-8'));
        } else if (!('private_key_protection' in prekey)) {
          this._secretStore.clear(scope, secretName);
        }
        sanitized[prekeyId] = prekey;
      }
      protected_.e2ee_prekeys = sanitized;
    }

    // 保护 group_secret
    const groupSecrets = protected_.group_secrets;
    if (groupSecrets && typeof groupSecrets === 'object' && !Array.isArray(groupSecrets)) {
      const sanitized: Record<string, Record<string, unknown>> = {};
      for (const [groupId, groupData] of Object.entries(groupSecrets as Record<string, unknown>)) {
        if (!groupData || typeof groupData !== 'object') continue;
        const group = { ...(groupData as Record<string, unknown>) };
        const secretName = `group_secrets/${groupId}/secret`;
        const val = group.secret;
        delete group.secret;
        if (typeof val === 'string' && val) {
          group.secret_protection = this._secretStore.protect(scope, secretName, Buffer.from(val, 'utf-8'));
        } else if (!('secret_protection' in group)) {
          this._secretStore.clear(scope, secretName);
        }

        // 保护 old_epochs 中的 secret
        const oldEpochs = group.old_epochs;
        if (Array.isArray(oldEpochs)) {
          const sanitizedOld: Record<string, unknown>[] = [];
          for (const oldData of oldEpochs) {
            if (!oldData || typeof oldData !== 'object') continue;
            const old = { ...(oldData as Record<string, unknown>) };
            const oldEpoch = old.epoch ?? '?';
            const oldSecretName = `group_secrets/${groupId}/old/${oldEpoch}`;
            const oldValue = old.secret;
            delete old.secret;
            if (typeof oldValue === 'string' && oldValue) {
              old.secret_protection = this._secretStore.protect(scope, oldSecretName, Buffer.from(oldValue, 'utf-8'));
            } else if (!('secret_protection' in old)) {
              this._secretStore.clear(scope, oldSecretName);
            }
            sanitizedOld.push(old);
          }
          group.old_epochs = sanitizedOld;
        }
        sanitized[groupId] = group;
      }
      protected_.group_secrets = sanitized;
    }

    return protected_;
  }

  private _restoreMetadata(aid: string, metadata: Record<string, unknown>): Record<string, unknown> {
    const restored: Record<string, unknown> = { ...metadata };
    const scope = FileKeyStore._safeAid(aid);

    // 恢复 token 字段
    for (const field of SENSITIVE_TOKEN_FIELDS) {
      const record = restored[`${field}_protection`];
      if (record && typeof record === 'object') {
        const value = this._secretStore.reveal(scope, field, record as Record<string, unknown>);
        if (value !== null) {
          restored[field] = value.toString('utf-8');
        } else {
          delete restored[field];
        }
      }
    }

    // 恢复 e2ee_sessions 中的 key
    const sessions = restored.e2ee_sessions;
    if (Array.isArray(sessions)) {
      for (const raw of sessions) {
        if (!raw || typeof raw !== 'object') continue;
        const session = raw as Record<string, unknown>;
        const record = session.key_protection;
        const secretName = this._sessionSecretName(session);
        if (record && typeof record === 'object' && secretName) {
          const value = this._secretStore.reveal(scope, secretName, record as Record<string, unknown>);
          if (value !== null) {
            session.key = value.toString('utf-8');
          } else {
            delete session.key;
          }
        }
      }
    }

    // 恢复 prekey 私钥
    const prekeys = restored.e2ee_prekeys;
    if (prekeys && typeof prekeys === 'object' && !Array.isArray(prekeys)) {
      for (const [prekeyId, prekeyData] of Object.entries(prekeys as Record<string, Record<string, unknown>>)) {
        if (!prekeyData || typeof prekeyData !== 'object') continue;
        const record = prekeyData.private_key_protection;
        const secretName = `e2ee_prekeys/${prekeyId}/private_key`;
        if (record && typeof record === 'object') {
          const value = this._secretStore.reveal(scope, secretName, record as Record<string, unknown>);
          if (value !== null) {
            prekeyData.private_key_pem = value.toString('utf-8');
          } else {
            delete prekeyData.private_key_pem;
          }
        }
      }
    }

    // 恢复 group_secret
    const groupSecrets = restored.group_secrets;
    if (groupSecrets && typeof groupSecrets === 'object' && !Array.isArray(groupSecrets)) {
      for (const [groupId, groupData] of Object.entries(groupSecrets as Record<string, Record<string, unknown>>)) {
        if (!groupData || typeof groupData !== 'object') continue;
        const record = groupData.secret_protection;
        const secretName = `group_secrets/${groupId}/secret`;
        if (record && typeof record === 'object') {
          const value = this._secretStore.reveal(scope, secretName, record as Record<string, unknown>);
          if (value !== null) {
            groupData.secret = value.toString('utf-8');
          } else {
            delete groupData.secret;
          }
        }

        // 恢复 old_epochs 中的 secret
        const oldEpochs = groupData.old_epochs;
        if (Array.isArray(oldEpochs)) {
          for (const oldData of oldEpochs) {
            if (!oldData || typeof oldData !== 'object') continue;
            const old = oldData as Record<string, unknown>;
            const oldRecord = old.secret_protection;
            const oldEpoch = old.epoch ?? '?';
            const oldSecretName = `group_secrets/${groupId}/old/${oldEpoch}`;
            if (oldRecord && typeof oldRecord === 'object') {
              const oldValue = this._secretStore.reveal(scope, oldSecretName, oldRecord as Record<string, unknown>);
              if (oldValue !== null) {
                old.secret = oldValue.toString('utf-8');
              } else {
                delete old.secret;
              }
            }
          }
        }
      }
    }

    return restored;
  }

  private _sessionSecretName(session: Record<string, unknown>): string | null {
    const sessionId = String(session.session_id ?? '');
    if (!sessionId) return null;
    return `e2ee_sessions/${sessionId}/key`;
  }

  private _prepareRoot(preferred: string, fallback: string): string {
    try {
      mkdirSync(preferred, { recursive: true });
      return preferred;
    } catch {
      mkdirSync(fallback, { recursive: true });
      return fallback;
    }
  }
}
