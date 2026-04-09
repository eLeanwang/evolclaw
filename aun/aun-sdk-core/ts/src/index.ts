/**
 * @aun/core-node — AUN Protocol Core SDK for Node.js
 *
 * 包入口：统一导出所有公开 API。
 */

export const VERSION = '0.2.0';

// ── 主客户端 ─────────────────────────────────────────────────
export { AUNClient } from './client.js';

// ── 配置 ─────────────────────────────────────────────────────
export { getDeviceId, type AUNConfig, defaultConfig, configFromMap } from './config.js';

// ── 错误类型 ─────────────────────────────────────────────────
export {
  AUNError,
  ConnectionError,
  TimeoutError,
  AuthError,
  PermissionError,
  ValidationError,
  NotFoundError,
  RateLimitError,
  StateError,
  SerializationError,
  SessionError,
  GroupError,
  GroupNotFoundError,
  GroupStateError,
  E2EEError,
  E2EEDecryptFailedError,
  E2EEGroupSecretMissingError,
  E2EEGroupEpochMismatchError,
  E2EEGroupCommitmentInvalidError,
  E2EEGroupNotMemberError,
  E2EEGroupDecryptFailedError,
  CertificateRevokedError,
  E2EEDegradedError,
  ClientSignatureError,
  mapRemoteError,
} from './errors.js';

// ── 事件 ─────────────────────────────────────────────────────
export { EventDispatcher, Subscription, type EventHandler } from './events.js';

// ── 类型 ─────────────────────────────────────────────────────
export type { Message, SendResult, AckResult, PullResult } from './types.js';

// ── 密码学 ───────────────────────────────────────────────────
export { CryptoProvider, type IdentityKeyPair } from './crypto.js';

// ── KeyStore ─────────────────────────────────────────────────
export type { KeyStore } from './keystore/index.js';
export { FileKeyStore } from './keystore/file.js';

// ── SecretStore ──────────────────────────────────────────────
export type { SecretStore } from './secret-store/index.js';
export { createDefaultSecretStore } from './secret-store/index.js';
export { FileSecretStore } from './secret-store/file-store.js';

// ── 传输层 ───────────────────────────────────────────────────
export { RPCTransport } from './transport.js';

// ── Gateway 发现 ─────────────────────────────────────────────
export { GatewayDiscovery } from './discovery.js';

// ── 认证流程 ─────────────────────────────────────────────────
export { AuthFlow } from './auth.js';

// ── E2EE ─────────────────────────────────────────────────────
export {
  E2EEManager,
  SUITE, MODE_PREKEY_ECDH_V2, MODE_LONG_TERM_KEY,
  AAD_FIELDS_OFFLINE, AAD_MATCH_FIELDS_OFFLINE,
} from './e2ee.js';
export {
  GroupE2EEManager,
  GroupReplayGuard,
  GroupKeyRequestThrottle,
  encryptGroupMessage,
  decryptGroupMessage,
  computeMembershipCommitment,
  verifyMembershipCommitment,
  buildMembershipManifest,
  signMembershipManifest,
  verifyMembershipManifest,
  storeGroupSecret,
  loadGroupSecret,
  loadAllGroupSecrets,
  cleanupOldEpochs,
  generateGroupSecret,
  buildKeyDistribution,
  handleKeyDistribution,
  buildKeyRequest,
  handleKeyRequest,
  handleKeyResponse,
} from './e2ee-group.js';
