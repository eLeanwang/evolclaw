// ── KeyStore 接口定义 ──────────────────────────────────────

/**
 * 密钥存储接口（浏览器版本 — 所有方法均为异步）。
 *
 * 与 Python SDK 的 KeyStore Protocol 等价，但由于 IndexedDB
 * 的异步特性，所有方法返回 Promise。
 */
export interface KeyStore {
  /** 加载密钥对 */
  loadKeyPair(aid: string): Promise<Record<string, unknown> | null>;
  /** 保存密钥对 */
  saveKeyPair(aid: string, keyPair: Record<string, unknown>): Promise<void>;
  /** 加载证书 PEM */
  loadCert(aid: string): Promise<string | null>;
  /** 保存证书 PEM */
  saveCert(aid: string, certPem: string): Promise<void>;
  /** 加载 metadata */
  loadMetadata(aid: string): Promise<Record<string, unknown> | null>;
  /** 保存 metadata */
  saveMetadata(aid: string, metadata: Record<string, unknown>): Promise<void>;
  /** 删除密钥对 */
  deleteKeyPair(aid: string): Promise<void>;
  /** 加载完整身份信息 */
  loadIdentity(aid: string): Promise<Record<string, unknown> | null>;
  /** 保存完整身份信息 */
  saveIdentity(aid: string, identity: Record<string, unknown>): Promise<void>;
  /** 删除完整身份信息 */
  deleteIdentity(aid: string): Promise<void>;
}
