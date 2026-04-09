// ── SecretStore 接口定义（浏览器版 — 全异步）──────────────

/**
 * 密钥保护存储接口。
 *
 * 浏览器环境下所有方法均为异步（SubtleCrypto / IndexedDB 要求），
 * 与 Python SDK 的同步接口不同。
 */
export interface SecretStore {
  /** 保护（加密）敏感数据 */
  protect(scope: string, name: string, plaintext: Uint8Array): Promise<Record<string, unknown>>;
  /** 还原（解密）敏感数据 */
  reveal(scope: string, name: string, record: Record<string, unknown>): Promise<Uint8Array | null>;
  /** 清除保护记录 */
  clear(scope: string, name: string): Promise<void>;
}

/**
 * 创建默认 SecretStore 实例。
 *
 * 浏览器环境下使用 IndexedDBSecretStore（基于 PBKDF2 + AES-256-GCM）。
 */
export async function createDefaultSecretStore(
  encryptionSeed?: string | null,
): Promise<SecretStore> {
  // 延迟导入，避免循环依赖
  const { IndexedDBSecretStore } = await import('./indexeddb-store.js');
  return new IndexedDBSecretStore(encryptionSeed ?? undefined);
}
