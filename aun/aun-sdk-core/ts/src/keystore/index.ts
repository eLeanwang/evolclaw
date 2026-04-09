/**
 * KeyStore 接口定义
 *
 * 与 Python SDK 的 KeyStore Protocol 完全对齐。
 */

export interface KeyStore {
  /** 加载密钥对 */
  loadKeyPair(aid: string): Record<string, unknown> | null;
  /** 保存密钥对 */
  saveKeyPair(aid: string, keyPair: Record<string, unknown>): void;
  /** 加载证书 */
  loadCert(aid: string): string | null;
  /** 保存证书 */
  saveCert(aid: string, certPem: string): void;
  /** 加载元数据 */
  loadMetadata(aid: string): Record<string, unknown> | null;
  /** 保存元数据 */
  saveMetadata(aid: string, metadata: Record<string, unknown>): void;
  /** 删除密钥对 */
  deleteKeyPair(aid: string): void;
  /** 加载完整身份信息 */
  loadIdentity(aid: string): Record<string, unknown> | null;
  /** 保存完整身份信息 */
  saveIdentity(aid: string, identity: Record<string, unknown>): void;
  /** 删除完整身份信息 */
  deleteIdentity(aid: string): void;
}
