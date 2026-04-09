/**
 * SecretStore 接口定义 + 默认工厂函数
 *
 * 与 Python SDK 的 SecretStore Protocol 完全对齐。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from './file-store.js';

/** 密钥保护/恢复接口 */
export interface SecretStore {
  /**
   * 保护明文数据，返回加密记录（可持久化）。
   */
  protect(scope: string, name: string, plaintext: Buffer): Record<string, unknown>;

  /**
   * 从加密记录恢复明文数据。
   * 解密失败或格式不匹配返回 null。
   */
  reveal(scope: string, name: string, record: Record<string, unknown>): Buffer | null;

  /**
   * 清除指定作用域/名称的密钥数据。
   */
  clear(scope: string, name: string): void;
}

/**
 * 创建默认的 SecretStore 实例。
 *
 * TypeScript SDK 统一使用 FileSecretStore（AES-256-GCM），
 * 不区分平台原生方案（与 Python SDK v0.2.0+ 对齐：写入统一用 file_aes）。
 */
export function createDefaultSecretStore(root?: string, encryptionSeed?: string): SecretStore {
  const storeRoot = root ?? join(homedir(), '.aun');
  return new FileSecretStore(storeRoot, encryptionSeed);
}
