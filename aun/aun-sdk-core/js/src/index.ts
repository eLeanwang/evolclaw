// ── @aun/core-browser 包入口 ──────────────────────────────

export const __version__ = '0.2.0';

// 客户端
export { AUNClient } from './client.js';

// 配置
export { getDeviceId, createConfig, type AUNConfig } from './config.js';

// 错误类型
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

// 类型
export type { Message, SendResult, AckResult, PullResult, JsonValue } from './types.js';

// 事件
export { EventDispatcher, Subscription, type EventHandler } from './events.js';

// 密码学
export { CryptoProvider } from './crypto.js';

// 传输层
export { RPCTransport } from './transport.js';

// 发现
export { GatewayDiscovery } from './discovery.js';

// 密钥存储
export type { KeyStore } from './keystore/index.js';
export { IndexedDBKeyStore } from './keystore/indexeddb.js';

// 密钥保护存储
export type { SecretStore } from './secret-store/index.js';
export { createDefaultSecretStore } from './secret-store/index.js';
export { IndexedDBSecretStore } from './secret-store/indexeddb-store.js';

// 认证
export { AuthFlow } from './auth.js';
export { AuthNamespace } from './namespaces/auth.js';

// E2EE — P2P
export { E2EEManager, SUITE, MODE_PREKEY_ECDH_V2, MODE_LONG_TERM_KEY } from './e2ee.js';
export type { EncryptResult } from './e2ee.js';

// E2EE — 群组
export {
  GroupE2EEManager, MODE_EPOCH_GROUP_KEY,
  GroupReplayGuard, GroupKeyRequestThrottle,
  encryptGroupMessage, decryptGroupMessage,
  buildMembershipManifest, signMembershipManifest, verifyMembershipManifest,
  computeMembershipCommitment, verifyMembershipCommitment,
  storeGroupSecret, loadGroupSecret, loadAllGroupSecrets, cleanupOldEpochs,
  generateGroupSecret, buildKeyDistribution,
  handleKeyDistribution, handleKeyRequest, handleKeyResponse,
  buildKeyRequest, checkEpochDowngrade,
} from './e2ee-group.js';

// 根证书
export { ROOT_CA_PEM } from './certs/root.js';
