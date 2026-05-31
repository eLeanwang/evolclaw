/**
 * AID 分类（互斥）:
 *  - mine:      本地可用身份（hasPrivateKey + signVerified=true）
 *  - broken:    有私钥但不可用（公钥不匹配 / 证书过期 / sign 失败）
 *  - peer-cert: 对端 AID（无私钥，有公钥证书，可用于验签/加密）
 *  - no-cert:   无私钥也无证书（仅有 agent.md 或空壳目录，对验签和通信无用，建议清理）
 */
export type AidCategory = 'mine' | 'broken' | 'peer-cert' | 'no-cert';

export interface AidInfo {
  aid: string;
  category: AidCategory;
  hasPrivateKey: boolean;
  hasAgentMd: boolean;
  hasCert: boolean;
  certExpired: boolean;
  /** 私钥与本地 cert.pem 公钥一致：true=匹配, false=不匹配, null=不适用（缺 key 或缺 cert） */
  keyMatchesCert: boolean | null;
  /** 静态推断：私钥 + 证书 + 未过期 + 公钥匹配。仅说明"看起来配套"，不代表能真签出来。 */
  canSign: boolean;
  /** 实测一次本地 sign+verify 的结果：true=成功，false=失败，null=未跑/不适用 */
  signVerified: boolean | null;
  /** signVerified=false 时的原因，便于排查（如 "private key decryption failed"） */
  signError?: string;
}

export interface AidShowResult {
  aid: string;
  hasPrivateKey: boolean;
  hasAgentMd: boolean;
  certExpiresAt: string | null;
  certSubject: string | null;
  certExpired: boolean;
  keyMatchesCert: boolean | null;
  signVerified: boolean | null;
  signError?: string;
  agentMdSignature: 'verified' | 'invalid' | 'unsigned' | 'unknown';
  agentMdSignatureReason?: string;
}

export interface AidLookupResult {
  exists: boolean;
  aid: string;
  gateway: string;
  content?: string;
  error?: string;
}

export interface AidCreateResult {
  aid: string;
  alreadyExisted: boolean;
  gateway: string;
  client: any;  // AUNClient — dynamic import, avoid static dep
  store: any;   // AIDStore — caller must close after client.close()
}
