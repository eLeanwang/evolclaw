// ── GroupE2EEManager（群组端到端加密 — 浏览器 SubtleCrypto 实现）──
// 所有密码学操作均为异步（SubtleCrypto API 要求）

import {
  E2EEError,
  E2EEGroupSecretMissingError,
} from './errors.js';
import { uint8ToBase64, base64ToUint8, pemToArrayBuffer } from './crypto.js';
import {
  SUITE,
  _concatBytes as concatBytes,
  _ecdsaSignDer as ecdsaSignDer,
  _ecdsaVerifyDer as ecdsaVerifyDer,
  _hkdfDerive as hkdfDerive,
  _aesGcmEncrypt as aesGcmEncrypt,
  _aesGcmDecrypt as aesGcmDecrypt,
  _randomNonce as randomNonce,
  _uuidV4 as uuidV4,
  _fingerprintSpki as fingerprintSpki,
  _importCertPublicKeyEcdsa as importCertPublicKeyEcdsa,
  _importPrivateKeyEcdsa as importPrivateKeyEcdsa,
} from './e2ee.js';
import type { KeyStore } from './keystore/index.js';

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

/** 群组加密模式 */
export const MODE_EPOCH_GROUP_KEY = 'epoch_group_key';

/** AAD 字段定义（群组） */
export const AAD_FIELDS_GROUP = [
  'group_id', 'from', 'message_id', 'timestamp',
  'epoch', 'encryption_mode', 'suite',
] as const;

/** AAD 匹配字段（群组，不含 timestamp） */
export const AAD_MATCH_FIELDS_GROUP = [
  'group_id', 'from', 'message_id',
  'epoch', 'encryption_mode', 'suite',
] as const;

/** 旧 epoch 默认保留时间（秒） */
export const OLD_EPOCH_RETENTION_SECONDS = 7 * 24 * 3600;

// ── 群组 AAD 工具 ────────────────────────────────────────────

/** 群组 AAD 序列化（排序键、紧凑 JSON） */
function aadBytesGroup(aad: Record<string, unknown>): Uint8Array {
  const obj: Record<string, unknown> = {};
  for (const field of AAD_FIELDS_GROUP) {
    obj[field] = aad[field] ?? null;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return _encoder.encode(JSON.stringify(sorted));
}

/** 群组 AAD 字段匹配检查 */
function aadMatchesGroup(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const f of AAD_MATCH_FIELDS_GROUP) {
    if (JSON.stringify(expected[f] ?? null) !== JSON.stringify(actual[f] ?? null)) {
      return false;
    }
  }
  return true;
}

// ── 群消息密钥派生 ────────────────────────────────────────────

/** 从 group_secret 派生单条群消息的加密密钥（异步） */
async function deriveGroupMsgKey(
  groupSecret: Uint8Array, groupId: string, messageId: string,
): Promise<Uint8Array> {
  return hkdfDerive(groupSecret, `aun-group:${groupId}:msg:${messageId}`);
}

// ── 群消息加解密（纯函数）────────────────────────────────────

/**
 * 加密群组消息，返回 e2ee.group_encrypted 信封（异步）。
 *
 * senderPrivateKeyPem: 可选，传入时为密文附加发送方 ECDSA 签名（不可否认性）。
 */
export async function encryptGroupMessage(
  groupId: string,
  epoch: number,
  groupSecret: Uint8Array,
  payload: Record<string, unknown>,
  opts: {
    fromAid: string;
    messageId: string;
    timestamp: number;
    senderPrivateKeyPem?: string | null;
  },
): Promise<Record<string, unknown>> {
  const msgKey = await deriveGroupMsgKey(groupSecret, groupId, opts.messageId);
  const plaintext = _encoder.encode(JSON.stringify(payload));
  const nonce = randomNonce();

  const aad: Record<string, unknown> = {
    group_id: groupId,
    from: opts.fromAid,
    message_id: opts.messageId,
    timestamp: opts.timestamp,
    epoch,
    encryption_mode: MODE_EPOCH_GROUP_KEY,
    suite: SUITE,
  };
  const aadBytes = aadBytesGroup(aad);
  const [ciphertext, tag] = await aesGcmEncrypt(msgKey, nonce, plaintext, aadBytes);

  const envelope: Record<string, unknown> = {
    type: 'e2ee.group_encrypted',
    version: '1',
    encryption_mode: MODE_EPOCH_GROUP_KEY,
    suite: SUITE,
    epoch,
    nonce: uint8ToBase64(nonce),
    ciphertext: uint8ToBase64(ciphertext),
    tag: uint8ToBase64(tag),
    aad,
  };

  // 发送方签名：对 ciphertext + tag + aad_bytes 签名（不可否认性）
  if (opts.senderPrivateKeyPem) {
    try {
      const signKey = await importPrivateKeyEcdsa(opts.senderPrivateKeyPem);
      const signPayload = concatBytes(ciphertext, tag, aadBytes);
      const sig = await ecdsaSignDer(signKey, signPayload);
      envelope.sender_signature = uint8ToBase64(sig);

      // 公钥指纹便于接收方查找证书
      const jwk = await crypto.subtle.exportKey('jwk', signKey);
      const pubJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
      const pubKey = await crypto.subtle.importKey(
        'jwk', pubJwk,
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
      );
      const spki = await crypto.subtle.exportKey('spki', pubKey);
      envelope.sender_cert_fingerprint = await fingerprintSpki(spki);
    } catch (exc) {
      console.warn('群消息发送方签名失败:', exc);
    }
  }

  return envelope;
}

/**
 * 解密群组消息（异步）。
 *
 * groupSecrets: {epoch: groupSecretBytes} 映射。
 * senderCertPem: 发送方证书，用于验证签名。
 * requireSignature: 为 true 时（默认），若消息缺少签名或无证书可验证则拒绝（零信任模式）。
 */
export async function decryptGroupMessage(
  message: Record<string, unknown>,
  groupSecrets: Map<number, Uint8Array>,
  senderCertPem?: string | null,
  opts?: { requireSignature?: boolean },
): Promise<Record<string, unknown> | null> {
  const requireSignature = opts?.requireSignature ?? true;
  const payload = message.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type !== 'e2ee.group_encrypted') return null;

  const epoch = payload.epoch as number | undefined;
  if (epoch === undefined || epoch === null) return null;

  const groupSecret = groupSecrets.get(epoch);
  if (!groupSecret) {
    console.error(`[DEBUG:decryptGroupMessage] no secret for epoch=${epoch}, available=[${[...groupSecrets.keys()].join(',')}]`);
    return null;
  }

  try {
    // 优先从 AAD 读取 group_id 和 message_id（SDK 加密时的原始值）
    const aad = payload.aad as Record<string, unknown> | undefined;
    const outerGroupId = (message.group_id ?? '') as string;
    let groupId: string;
    let messageId: string;
    let aadFrom = '';

    if (aad && typeof aad === 'object') {
      groupId = (aad.group_id ?? outerGroupId) as string;
      messageId = (aad.message_id ?? message.message_id ?? '') as string;
      aadFrom = (aad.from ?? '') as string;

      // 外层路由字段与 AAD 绑定校验
      if (outerGroupId && groupId !== outerGroupId) {
        console.error(`[DEBUG:decryptGroupMessage] AAD group_id mismatch: outer=${outerGroupId} aad=${groupId}`);
        return null;
      }
      if (aadFrom) {
        const outerFrom = (message.from ?? '') as string;
        const outerSender = (message.sender_aid ?? '') as string;
        if (outerFrom && outerFrom !== aadFrom) {
          console.error(`[DEBUG:decryptGroupMessage] AAD from mismatch: outer.from=${outerFrom} aad.from=${aadFrom}`);
          return null;
        }
        if (outerSender && outerSender !== aadFrom) {
          console.error(`[DEBUG:decryptGroupMessage] AAD sender_aid mismatch: outer.sender_aid=${outerSender} aad.from=${aadFrom}`);
          return null;
        }
      }
    } else {
      groupId = outerGroupId;
      messageId = (message.message_id ?? '') as string;
    }

    if (!groupId || !messageId) {
      console.error(`[DEBUG:decryptGroupMessage] missing groupId=${groupId} or messageId=${messageId}`);
      return null;
    }

    const msgKey = await deriveGroupMsgKey(groupSecret, groupId, messageId);
    const nonce = base64ToUint8(payload.nonce as string);
    const ciphertext = base64ToUint8(payload.ciphertext as string);
    const tag = base64ToUint8(payload.tag as string);

    // AAD 校验：直接用 payload 中的 AAD
    const aadBytes = aad ? aadBytesGroup(aad) : new Uint8Array(0);

    const plaintext = await aesGcmDecrypt(msgKey, nonce, ciphertext, tag, aadBytes);
    const decoded = JSON.parse(_decoder.decode(plaintext));

    const result: Record<string, unknown> = {
      ...message,
      payload: decoded,
      encrypted: true,
      e2ee: {
        encryption_mode: MODE_EPOCH_GROUP_KEY,
        suite: SUITE,
        epoch,
        sender_verified: false,
      },
    };

    // 发送方签名验证
    const senderSigB64 = payload.sender_signature as string | undefined;
    if (requireSignature) {
      // 零信任模式：必须有签名且有证书可验证
      if (!senderSigB64) {
        console.warn(`拒绝无发送方签名的群消息（require_signature=true）: group=${groupId} from=${aadFrom}`);
        return null;
      }
      if (!senderCertPem) {
        console.warn(
          `拒绝群消息：有签名但无发送方证书可验证（零信任模式禁止跳过验签）: group=${groupId} from=${aadFrom}`,
        );
        return null;
      }
      const verified = await _verifySenderSigGroup(senderCertPem, senderSigB64, ciphertext, tag, aadBytes);
      if (!verified) {
        console.warn(`群消息发送方签名验证失败: group=${groupId} from=${aadFrom}`);
        return null;
      }
      (result.e2ee as Record<string, unknown>).sender_verified = true;
    } else if (senderCertPem) {
      // 非零信任模式但提供了证书：有证书时强制验签
      if (!senderSigB64) {
        console.warn(`拒绝无发送方签名的群消息: group=${groupId} from=${aadFrom}`);
        return null;
      }
      const verified = await _verifySenderSigGroup(senderCertPem, senderSigB64, ciphertext, tag, aadBytes);
      if (!verified) {
        console.warn(`群消息发送方签名验证失败: group=${groupId} from=${aadFrom}`);
        return null;
      }
      (result.e2ee as Record<string, unknown>).sender_verified = true;
    }

    return result;
  } catch (exc) {
    console.error(`[DEBUG:decryptGroupMessage] decrypt exception:`, exc);
    return null;
  }
}

/** 群消息发送方签名验证内部实现 */
async function _verifySenderSigGroup(
  senderCertPem: string,
  senderSigB64: string,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aadBytes: Uint8Array,
): Promise<boolean> {
  try {
    const senderPub = await importCertPublicKeyEcdsa(senderCertPem);
    const sigBytes = base64ToUint8(senderSigB64);
    const verifyPayload = concatBytes(ciphertext, tag, aadBytes);
    return ecdsaVerifyDer(senderPub, sigBytes, verifyPayload);
  } catch {
    return false;
  }
}

// ── Membership Manifest（成员变更授权证明）──────────────────

/** 构建 Membership Manifest（未签名） */
export function buildMembershipManifest(
  groupId: string,
  epoch: number,
  prevEpoch: number | null,
  memberAids: string[],
  opts?: {
    added?: string[];
    removed?: string[];
    initiatorAid?: string;
  },
): Record<string, unknown> {
  return {
    manifest_version: 1,
    group_id: groupId,
    epoch,
    prev_epoch: prevEpoch,
    member_aids: [...memberAids].sort(),
    added: [...(opts?.added ?? [])].sort(),
    removed: [...(opts?.removed ?? [])].sort(),
    initiator_aid: opts?.initiatorAid ?? '',
    issued_at: Date.now(),
  };
}

/** 序列化 manifest 为签名输入 */
function manifestSignData(manifest: Record<string, unknown>): Uint8Array {
  const fields = [
    String(manifest.manifest_version ?? 1),
    (manifest.group_id ?? '') as string,
    String(manifest.epoch ?? 0),
    String(manifest.prev_epoch ?? ''),
    ((manifest.member_aids as string[]) ?? []).join('|'),
    ((manifest.added as string[]) ?? []).join('|'),
    ((manifest.removed as string[]) ?? []).join('|'),
    (manifest.initiator_aid ?? '') as string,
    String(manifest.issued_at ?? 0),
  ];
  return _encoder.encode(fields.join('\n'));
}

/** 对 Membership Manifest 签名（异步），返回带 signature 字段的新 manifest */
export async function signMembershipManifest(
  manifest: Record<string, unknown>,
  privateKeyPem: string,
): Promise<Record<string, unknown>> {
  const signKey = await importPrivateKeyEcdsa(privateKeyPem);
  const data = manifestSignData(manifest);
  const sig = await ecdsaSignDer(signKey, data);
  return { ...manifest, signature: uint8ToBase64(sig) };
}

/** 验证 Membership Manifest 签名（异步） */
export async function verifyMembershipManifest(
  manifest: Record<string, unknown>,
  initiatorCertPem: string,
): Promise<boolean> {
  const sigB64 = manifest.signature as string | undefined;
  if (!sigB64) return false;
  try {
    const pubKey = await importCertPublicKeyEcdsa(initiatorCertPem);
    const sigBytes = base64ToUint8(sigB64);
    const data = manifestSignData(manifest);
    return ecdsaVerifyDer(pubKey, sigBytes, data);
  } catch {
    return false;
  }
}

// ── Membership Commitment ────────────────────────────────────

/** 计算 Membership Commitment（异步，使用 SubtleCrypto SHA-256） */
export async function computeMembershipCommitment(
  memberAids: string[],
  epoch: number,
  groupId: string,
  groupSecret: Uint8Array,
): Promise<string> {
  const sortedAids = [...memberAids].sort();
  // SHA-256(group_secret)
  const secretHash = await crypto.subtle.digest('SHA-256', groupSecret);
  const secretHex = Array.from(new Uint8Array(secretHash)).map(b => b.toString(16).padStart(2, '0')).join('');
  const data = sortedAids.join('|') + '|' + epoch + '|' + groupId + '|' + secretHex;
  const digest = await crypto.subtle.digest('SHA-256', _encoder.encode(data));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 验证 Membership Commitment（异步） */
export async function verifyMembershipCommitment(
  commitment: string,
  memberAids: string[],
  epoch: number,
  groupId: string,
  myAid: string,
  groupSecret: Uint8Array,
): Promise<boolean> {
  if (!memberAids.includes(myAid)) return false;
  const expected = await computeMembershipCommitment(memberAids, epoch, groupId, groupSecret);
  // 常量时间比较（防时序攻击）
  if (expected.length !== commitment.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ commitment.charCodeAt(i);
  }
  return diff === 0;
}

// ── Group Secret 生命周期管理 ────────────────────────────────

/** 存储 group_secret 到 keystore metadata（异步） */
export async function storeGroupSecret(
  keystore: KeyStore,
  aid: string,
  groupId: string,
  epoch: number,
  groupSecret: Uint8Array,
  commitment: string,
  memberAids: string[],
): Promise<boolean> {
  const metadata = (await keystore.loadMetadata(aid)) ?? {};
  const groupSecrets = (metadata.group_secrets ?? {}) as Record<string, Record<string, unknown>>;
  const existing = groupSecrets[groupId] as Record<string, unknown> | undefined;

  // epoch 降级防护
  if (existing && existing.epoch !== undefined && existing.epoch !== null) {
    if (epoch < (existing.epoch as number)) return false;
  }

  // 旧 epoch 移入 old_epochs
  if (existing && existing.epoch !== epoch) {
    const oldEpochs = (existing.old_epochs ?? []) as Record<string, unknown>[];
    const oldEntry: Record<string, unknown> = {
      epoch: existing.epoch,
      secret: existing.secret,
      commitment: existing.commitment,
      member_aids: existing.member_aids,
      updated_at: existing.updated_at,
    };
    if ('secret_protection' in existing) {
      oldEntry.secret_protection = existing.secret_protection;
    }
    oldEpochs.push(oldEntry);
    existing.old_epochs = oldEpochs;
  }

  const nowMs = Date.now();
  groupSecrets[groupId] = {
    epoch,
    secret: uint8ToBase64(groupSecret),
    commitment,
    member_aids: [...memberAids].sort(),
    updated_at: nowMs,
    old_epochs: (existing ?? {}).old_epochs ?? [],
  };
  metadata.group_secrets = groupSecrets;
  await keystore.saveMetadata(aid, metadata);
  return true;
}

/** 读取 group_secret（异步） */
export async function loadGroupSecret(
  keystore: KeyStore,
  aid: string,
  groupId: string,
  epoch?: number | null,
): Promise<{ epoch: number; secret: Uint8Array; commitment: string; member_aids: string[] } | null> {
  const metadata = (await keystore.loadMetadata(aid)) ?? {};
  const groupSecrets = (metadata.group_secrets ?? {}) as Record<string, Record<string, unknown>>;
  const entry = groupSecrets[groupId] as Record<string, unknown> | undefined;
  if (!entry) return null;

  if (epoch === undefined || epoch === null || entry.epoch === epoch) {
    const secretStr = entry.secret as string | undefined;
    if (!secretStr) return null;
    return {
      epoch: entry.epoch as number,
      secret: base64ToUint8(secretStr),
      commitment: (entry.commitment ?? '') as string,
      member_aids: (entry.member_aids ?? []) as string[],
    };
  }

  // 查 old_epochs
  for (const old of (entry.old_epochs ?? []) as Record<string, unknown>[]) {
    if (old.epoch === epoch) {
      const secretStr = old.secret as string | undefined;
      if (!secretStr) return null;
      return {
        epoch: old.epoch as number,
        secret: base64ToUint8(secretStr),
        commitment: (old.commitment ?? '') as string,
        member_aids: (old.member_aids ?? []) as string[],
      };
    }
  }
  return null;
}

/** 加载某群组所有 epoch 的 group_secret（异步） */
export async function loadAllGroupSecrets(
  keystore: KeyStore,
  aid: string,
  groupId: string,
): Promise<Map<number, Uint8Array>> {
  const metadata = (await keystore.loadMetadata(aid)) ?? {};
  const groupSecrets = (metadata.group_secrets ?? {}) as Record<string, Record<string, unknown>>;
  const entry = groupSecrets[groupId] as Record<string, unknown> | undefined;
  if (!entry) return new Map();

  const result = new Map<number, Uint8Array>();
  const secretStr = entry.secret as string | undefined;
  if (secretStr && entry.epoch !== undefined && entry.epoch !== null) {
    result.set(entry.epoch as number, base64ToUint8(secretStr));
  }
  for (const old of (entry.old_epochs ?? []) as Record<string, unknown>[]) {
    const oldSecret = old.secret as string | undefined;
    if (oldSecret && old.epoch !== undefined && old.epoch !== null) {
      result.set(old.epoch as number, base64ToUint8(oldSecret));
    }
  }
  return result;
}

/** 清理过期的旧 epoch 记录（异步）。返回清理数量。 */
export async function cleanupOldEpochs(
  keystore: KeyStore,
  aid: string,
  groupId: string,
  retentionSeconds: number = OLD_EPOCH_RETENTION_SECONDS,
): Promise<number> {
  const metadata = (await keystore.loadMetadata(aid)) ?? {};
  const groupSecrets = (metadata.group_secrets ?? {}) as Record<string, Record<string, unknown>>;
  const entry = groupSecrets[groupId] as Record<string, unknown> | undefined;
  if (!entry) return 0;

  const oldEpochs = (entry.old_epochs ?? []) as Record<string, unknown>[];
  if (!oldEpochs.length) return 0;

  const cutoffMs = Date.now() - retentionSeconds * 1000;
  const remaining = oldEpochs.filter(e => ((e.updated_at as number) ?? 0) >= cutoffMs);
  const removed = oldEpochs.length - remaining.length;

  if (removed > 0) {
    entry.old_epochs = remaining;
    await keystore.saveMetadata(aid, metadata);
  }
  return removed;
}

// ── Group Key 分发与恢复协议 ────────────────────────────────

/** 生成 32 字节随机 group_secret */
export function generateGroupSecret(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 构建 group key 分发消息 payload（异步） */
export async function buildKeyDistribution(
  groupId: string,
  epoch: number,
  groupSecret: Uint8Array,
  memberAids: string[],
  distributedBy: string,
  manifest?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const commitment = await computeMembershipCommitment(memberAids, epoch, groupId, groupSecret);
  const result: Record<string, unknown> = {
    type: 'e2ee.group_key_distribution',
    group_id: groupId,
    epoch,
    group_secret: uint8ToBase64(groupSecret),
    commitment,
    member_aids: [...memberAids].sort(),
    distributed_by: distributedBy,
    distributed_at: Date.now(),
  };
  if (manifest) result.manifest = manifest;
  return result;
}

/** 处理收到的 group key 分发消息（异步） */
export async function handleKeyDistribution(
  message: Record<string, unknown>,
  keystore: KeyStore,
  aid: string,
  initiatorCertPem?: string | null,
): Promise<boolean> {
  const payload = ('group_id' in message) ? message : (message.payload ?? message) as Record<string, unknown>;

  const groupId = payload.group_id as string | undefined;
  const epoch = payload.epoch as number | undefined;
  const groupSecretB64 = payload.group_secret as string | undefined;
  const commitment = payload.commitment as string | undefined;
  const memberAids = (payload.member_aids ?? []) as string[];

  if (!groupId || epoch === undefined || epoch === null || !groupSecretB64 || !commitment) return false;

  // 验证 Membership Manifest 签名
  const manifest = payload.manifest as Record<string, unknown> | undefined;
  if (initiatorCertPem) {
    if (!manifest) {
      console.warn(`拒绝无 manifest 的密钥分发: group=${groupId} epoch=${epoch}`);
      return false;
    }
    const valid = await verifyMembershipManifest(manifest, initiatorCertPem);
    if (!valid) {
      console.warn(`group key distribution manifest 签名验证失败: group=${groupId} epoch=${epoch}`);
      return false;
    }
    if (manifest.group_id !== groupId || manifest.epoch !== epoch) return false;
    if (JSON.stringify([...(manifest.member_aids as string[])].sort()) !== JSON.stringify([...memberAids].sort())) return false;
  } else if (manifest) {
    if (manifest.group_id !== groupId || manifest.epoch !== epoch) return false;
    if (JSON.stringify([...(manifest.member_aids as string[])].sort()) !== JSON.stringify([...memberAids].sort())) return false;
  }

  const groupSecret = base64ToUint8(groupSecretB64);

  // 验证 commitment
  const commitmentValid = await verifyMembershipCommitment(commitment, memberAids, epoch, groupId, aid, groupSecret);
  if (!commitmentValid) return false;

  return storeGroupSecret(keystore, aid, groupId, epoch, groupSecret, commitment, memberAids);
}

/** 构建密钥请求 payload */
export function buildKeyRequest(
  groupId: string,
  epoch: number,
  requesterAid: string,
): Record<string, unknown> {
  return {
    type: 'e2ee.group_key_request',
    group_id: groupId,
    epoch,
    requester_aid: requesterAid,
  };
}

/** 处理收到的密钥请求（异步） */
export async function handleKeyRequest(
  request: Record<string, unknown>,
  keystore: KeyStore,
  aid: string,
  currentMembers: string[],
): Promise<Record<string, unknown> | null> {
  const payload = ('group_id' in request) ? request : (request.payload ?? request) as Record<string, unknown>;

  const requesterAid = payload.requester_aid as string | undefined;
  const groupId = payload.group_id as string | undefined;
  const epoch = payload.epoch as number | undefined;

  if (!requesterAid || !groupId || epoch === undefined || epoch === null) return null;
  if (!currentMembers.includes(requesterAid)) return null;

  const secretData = await loadGroupSecret(keystore, aid, groupId, epoch);
  if (!secretData) return null;

  let commitment = secretData.commitment;
  const memberAids = secretData.member_aids;
  if (!commitment) {
    commitment = await computeMembershipCommitment(
      memberAids.length ? memberAids : currentMembers, epoch, groupId, secretData.secret,
    );
  }

  return {
    type: 'e2ee.group_key_response',
    group_id: groupId,
    epoch,
    group_secret: uint8ToBase64(secretData.secret),
    commitment,
    member_aids: memberAids.length ? memberAids : [...currentMembers].sort(),
  };
}

/** 处理收到的密钥响应（异步） */
export async function handleKeyResponse(
  response: Record<string, unknown>,
  keystore: KeyStore,
  aid: string,
): Promise<boolean> {
  const payload = ('group_id' in response) ? response : (response.payload ?? response) as Record<string, unknown>;

  const groupId = payload.group_id as string | undefined;
  const epoch = payload.epoch as number | undefined;
  const groupSecretB64 = payload.group_secret as string | undefined;
  const commitment = payload.commitment as string | undefined;
  const memberAids = (payload.member_aids ?? []) as string[];

  if (!groupId || epoch === undefined || epoch === null || !groupSecretB64 || !commitment) return false;

  const groupSecret = base64ToUint8(groupSecretB64);
  const valid = await verifyMembershipCommitment(commitment, memberAids, epoch, groupId, aid, groupSecret);
  if (!valid) return false;

  return storeGroupSecret(keystore, aid, groupId, epoch, groupSecret, commitment, memberAids);
}

/** epoch 降级检查 */
export function checkEpochDowngrade(
  messageEpoch: number,
  localLatestEpoch: number,
  opts?: { allowOldEpoch?: boolean },
): boolean {
  if (messageEpoch >= localLatestEpoch) return true;
  return opts?.allowOldEpoch ?? false;
}

// ── GroupReplayGuard ────────────────────────────────────────

/** 群组消息防重放守卫 */
export class GroupReplayGuard {
  private _seen: Map<string, boolean> = new Map();
  private _maxSize: number;

  constructor(maxSize = 50000) {
    this._maxSize = maxSize;
  }

  /** 检查并记录。返回 true 表示首次（通过），false 表示重放（拒绝）。 */
  checkAndRecord(groupId: string, senderAid: string, messageId: string): boolean {
    const key = `${groupId}:${senderAid}:${messageId}`;
    if (this._seen.has(key)) return false;
    this._seen.set(key, true);
    this._trim();
    return true;
  }

  /** 仅检查是否已记录 */
  isSeen(groupId: string, senderAid: string, messageId: string): boolean {
    return this._seen.has(`${groupId}:${senderAid}:${messageId}`);
  }

  /** 仅记录 */
  record(groupId: string, senderAid: string, messageId: string): void {
    this._seen.set(`${groupId}:${senderAid}:${messageId}`, true);
    this._trim();
  }

  private _trim(): void {
    if (this._seen.size > this._maxSize) {
      const trimCount = this._seen.size - Math.floor(this._maxSize * 0.8);
      const keys = [...this._seen.keys()].slice(0, trimCount);
      for (const k of keys) this._seen.delete(k);
    }
  }

  get size(): number {
    return this._seen.size;
  }
}

// ── GroupKeyRequestThrottle ──────────────────────────────────

/** 群组密钥请求/响应频率限制 */
export class GroupKeyRequestThrottle {
  private _last: Map<string, number> = new Map();
  private _cooldown: number;

  constructor(cooldown = 30.0) {
    this._cooldown = cooldown;
  }

  /** 检查是否允许操作。返回 true 并记录时间戳，或 false 表示被限制。 */
  allow(key: string): boolean {
    const now = Date.now() / 1000;
    const last = this._last.get(key);
    if (last !== undefined && (now - last) < this._cooldown) return false;
    this._last.set(key, now);
    return true;
  }

  reset(key: string): void {
    this._last.delete(key);
  }
}

// ── GroupE2EEManager 主类 ────────────────────────────────────

/**
 * 群组端到端加密管理器 — 浏览器 SubtleCrypto 实现。
 *
 * 与 E2EEManager 平行：所有网络操作（P2P 发送、RPC 调用）由调用方负责。
 * 内置防重放、epoch 降级防护、密钥请求频率限制。
 * 所有密码学操作均为异步。
 */
export class GroupE2EEManager {
  private _identityFn: () => Record<string, unknown>;
  private _keystoreRef: KeyStore;
  private _replayGuard: GroupReplayGuard;
  private _requestThrottle: GroupKeyRequestThrottle;
  private _responseThrottle: GroupKeyRequestThrottle;
  private _senderCertResolver: ((aid: string) => string | null) | null;
  private _initiatorCertResolver: ((aid: string) => string | null) | null;

  constructor(opts: {
    identityFn: () => Record<string, unknown>;
    keystore: KeyStore;
    requestCooldown?: number;
    responseCooldown?: number;
    senderCertResolver?: ((aid: string) => string | null) | null;
    initiatorCertResolver?: ((aid: string) => string | null) | null;
  }) {
    this._identityFn = opts.identityFn;
    this._keystoreRef = opts.keystore;
    this._replayGuard = new GroupReplayGuard();
    this._requestThrottle = new GroupKeyRequestThrottle(opts.requestCooldown ?? 30.0);
    this._responseThrottle = new GroupKeyRequestThrottle(opts.responseCooldown ?? 30.0);
    this._senderCertResolver = opts.senderCertResolver ?? null;
    this._initiatorCertResolver = opts.initiatorCertResolver ?? null;
  }

  // ── 密钥管理 ──────────────────────────────────────

  /** 用当前身份私钥签名 manifest */
  private async _signManifest(manifest: Record<string, unknown>): Promise<Record<string, unknown>> {
    const identity = this._identityFn();
    const pkPem = identity.private_key_pem as string | undefined;
    if (!pkPem) return manifest;
    return signMembershipManifest(manifest, pkPem);
  }

  /** 创建首个 epoch。返回 {epoch, commitment, distributions: [{to, payload}]}。 */
  async createEpoch(
    groupId: string,
    memberAids: string[],
  ): Promise<Record<string, unknown>> {
    const aid = this._currentAid();
    const gs = generateGroupSecret();
    const epoch = 1;
    const commitment = await computeMembershipCommitment(memberAids, epoch, groupId, gs);
    await storeGroupSecret(this._keystoreRef, aid, groupId, epoch, gs, commitment, memberAids);
    const manifest = await this._signManifest(buildMembershipManifest(
      groupId, epoch, null, memberAids, { initiatorAid: aid },
    ));
    const distPayload = await buildKeyDistribution(groupId, epoch, gs, memberAids, aid, manifest);
    return {
      epoch,
      commitment,
      distributions: memberAids.filter(m => m !== aid).map(m => ({ to: m, payload: distPayload })),
    };
  }

  /** 轮换 epoch（踢人/退出后调用） */
  async rotateEpoch(
    groupId: string,
    memberAids: string[],
  ): Promise<Record<string, unknown>> {
    const aid = this._currentAid();
    const current = await loadGroupSecret(this._keystoreRef, aid, groupId);
    const prevEpoch = current ? current.epoch : null;
    const newEpoch = (prevEpoch ?? 0) + 1;
    const gs = generateGroupSecret();
    const commitment = await computeMembershipCommitment(memberAids, newEpoch, groupId, gs);
    await storeGroupSecret(this._keystoreRef, aid, groupId, newEpoch, gs, commitment, memberAids);
    const manifest = await this._signManifest(buildMembershipManifest(
      groupId, newEpoch, prevEpoch, memberAids, { initiatorAid: aid },
    ));
    const distPayload = await buildKeyDistribution(groupId, newEpoch, gs, memberAids, aid, manifest);
    return {
      epoch: newEpoch,
      commitment,
      distributions: memberAids.filter(m => m !== aid).map(m => ({ to: m, payload: distPayload })),
    };
  }

  /** 指定目标 epoch 号轮换（配合服务端 CAS 使用） */
  async rotateEpochTo(
    groupId: string,
    targetEpoch: number,
    memberAids: string[],
  ): Promise<Record<string, unknown>> {
    const aid = this._currentAid();
    const gs = generateGroupSecret();
    const commitment = await computeMembershipCommitment(memberAids, targetEpoch, groupId, gs);
    await storeGroupSecret(this._keystoreRef, aid, groupId, targetEpoch, gs, commitment, memberAids);
    const manifest = await this._signManifest(buildMembershipManifest(
      groupId, targetEpoch, targetEpoch - 1, memberAids, { initiatorAid: aid },
    ));
    const distPayload = await buildKeyDistribution(groupId, targetEpoch, gs, memberAids, aid, manifest);
    return {
      epoch: targetEpoch,
      commitment,
      distributions: memberAids.filter(m => m !== aid).map(m => ({ to: m, payload: distPayload })),
    };
  }

  /** 手动存储 group_secret。返回 false 表示 epoch 降级被拒。 */
  async storeSecret(
    groupId: string,
    epoch: number,
    groupSecretBytes: Uint8Array,
    commitment: string,
    memberAids: string[],
  ): Promise<boolean> {
    return storeGroupSecret(
      this._keystoreRef, this._currentAid(), groupId, epoch,
      groupSecretBytes, commitment, memberAids,
    );
  }

  async loadSecret(groupId: string, epoch?: number | null): Promise<{
    epoch: number; secret: Uint8Array; commitment: string; member_aids: string[];
  } | null> {
    return loadGroupSecret(this._keystoreRef, this._currentAid(), groupId, epoch);
  }

  async loadAllSecrets(groupId: string): Promise<Map<number, Uint8Array>> {
    return loadAllGroupSecrets(this._keystoreRef, this._currentAid(), groupId);
  }

  async cleanup(groupId: string, retentionSeconds = OLD_EPOCH_RETENTION_SECONDS): Promise<number> {
    return cleanupOldEpochs(this._keystoreRef, this._currentAid(), groupId, retentionSeconds);
  }

  // ── 加解密 ────────────────────────────────────────

  /** 加密群消息（含发送方签名）。无密钥时抛 E2EEGroupSecretMissingError。 */
  async encrypt(
    groupId: string,
    payload: Record<string, unknown>,
    opts?: { messageId?: string; timestamp?: number },
  ): Promise<Record<string, unknown>> {
    const aid = this._currentAid();
    const secretData = await loadGroupSecret(this._keystoreRef, aid, groupId);
    if (!secretData) {
      throw new E2EEGroupSecretMissingError(`no group secret for ${groupId}`);
    }
    const identity = this._identityFn();
    const senderPkPem = (identity?.private_key_pem as string | undefined) ?? null;
    return encryptGroupMessage(
      groupId, secretData.epoch, secretData.secret, payload, {
        fromAid: aid,
        messageId: opts?.messageId ?? `gm-${uuidV4()}`,
        timestamp: opts?.timestamp ?? Date.now(),
        senderPrivateKeyPem: senderPkPem,
      },
    );
  }

  /**
   * 解密单条群消息（异步）。内置防重放 + 发送方验签 + 外层字段校验。
   *
   * opts.skipReplay: 跳过防重放检查（用于 group.pull 场景）。
   */
  async decrypt(
    message: Record<string, unknown>,
    opts?: { skipReplay?: boolean },
  ): Promise<Record<string, unknown> | null> {
    const payload = message.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object' || payload.type !== 'e2ee.group_encrypted') {
      return message;
    }
    const groupId = (message.group_id ?? '') as string;
    const sender = (message.from ?? message.sender_aid ?? '') as string;
    const skipReplay = opts?.skipReplay ?? false;

    // 防重放预检：优先使用 AAD 内 message_id
    const aad = payload.aad as Record<string, unknown> | undefined;
    const aadMsgId = aad ? (aad.message_id ?? '') as string : '';
    const msgId = aadMsgId || (message.message_id ?? '') as string;
    if (!skipReplay && groupId && sender && msgId) {
      if (this._replayGuard.isSeen(groupId, sender, msgId)) return message;
    }

    // 解析发送方证书（零信任：无证书则拒绝）
    let senderCertPem: string | null = null;
    if (this._senderCertResolver && sender) {
      senderCertPem = this._senderCertResolver(sender);
    }
    console.error(`[DEBUG:GroupE2EE.decrypt] groupId=${groupId}, sender=${sender}, msgId=${msgId}, hasCert=${!!senderCertPem}, hasResolver=${!!this._senderCertResolver}`);
    if (!senderCertPem) {
      console.warn(
        `拒绝群消息：无法获取发送方 ${sender} 的证书（零信任模式禁止跳过验签）: group=${groupId}`,
      );
      return null;
    }

    const allSecrets = await loadAllGroupSecrets(this._keystoreRef, this._currentAid(), groupId);
    console.error(`[DEBUG:GroupE2EE.decrypt] allSecrets.size=${allSecrets.size}, epochs=[${[...allSecrets.keys()].join(',')}]`);
    if (!allSecrets.size) return null;
    const result = await decryptGroupMessage(message, allSecrets, senderCertPem);
    console.error(`[DEBUG:GroupE2EE.decrypt] decryptGroupMessage result=${result !== null ? 'OK' : 'null'}`);

    // 解密成功后记录防重放
    if (result !== null) {
      const finalMsgId = aadMsgId || (message.message_id ?? '') as string;
      if (groupId && sender && finalMsgId) {
        this._replayGuard.record(groupId, sender, finalMsgId);
      }
    }
    return result;
  }

  /** 批量解密 */
  async decryptBatch(
    messages: Record<string, unknown>[],
    opts?: { skipReplay?: boolean },
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const m of messages) {
      results.push((await this.decrypt(m, opts)) ?? m);
    }
    return results;
  }

  // ── 密钥协议消息处理 ──────────────────────────────

  /**
   * 处理已解密的 P2P 密钥消息（异步）。
   *
   * 返回 "distribution"/"request"/"response" 表示已成功处理。
   * 返回 "distribution_rejected"/"response_rejected" 表示被拒绝。
   * 返回 null 表示不是密钥消息。
   */
  async handleIncoming(payload: Record<string, unknown>): Promise<string | null> {
    if (!payload || typeof payload !== 'object') return null;
    const msgType = (payload.type ?? '') as string;
    const aid = this._currentAid();

    if (msgType === 'e2ee.group_key_distribution') {
      // 解析发起者证书用于 manifest 验证
      let initiatorCert: string | null = null;
      const distributedBy = (payload.distributed_by ?? '') as string;
      if (this._initiatorCertResolver && distributedBy) {
        initiatorCert = this._initiatorCertResolver(distributedBy);
      }
      const ok = await handleKeyDistribution(payload, this._keystoreRef, aid, initiatorCert);
      return ok ? 'distribution' : 'distribution_rejected';
    }
    if (msgType === 'e2ee.group_key_response') {
      const ok = await handleKeyResponse(payload, this._keystoreRef, aid);
      return ok ? 'response' : 'response_rejected';
    }
    if (msgType === 'e2ee.group_key_request') {
      return 'request';
    }
    return null;
  }

  /** 构建恢复请求。返回 {to, payload} 或 null（限流/无目标）。 */
  async buildRecoveryRequest(
    groupId: string,
    epoch: number,
    opts?: { senderAid?: string },
  ): Promise<Record<string, unknown> | null> {
    const aid = this._currentAid();
    if (!this._requestThrottle.allow(`request:${groupId}:${epoch}`)) return null;
    let candidates: string[] = [];
    const secretData = await loadGroupSecret(this._keystoreRef, aid, groupId);
    if (secretData?.member_aids?.length) {
      candidates = secretData.member_aids.filter(m => m !== aid);
    }
    if (!candidates.length && opts?.senderAid && opts.senderAid !== aid) {
      candidates = [opts.senderAid];
    }
    if (!candidates.length) return null;
    return { to: candidates[0], payload: buildKeyRequest(groupId, epoch, aid) };
  }

  /** 处理密钥请求（受频率限制 + 成员资格验证） */
  async handleKeyRequestMsg(
    requestPayload: Record<string, unknown>,
    currentMembers: string[],
  ): Promise<Record<string, unknown> | null> {
    const requester = (requestPayload.requester_aid ?? '') as string;
    const groupId = (requestPayload.group_id ?? '') as string;
    if (!requester || !groupId) return null;
    if (!currentMembers.includes(requester)) {
      console.warn(`拒绝密钥恢复请求：${requester} 不在群 ${groupId} 的当前成员列表中`);
      return null;
    }
    if (!this._responseThrottle.allow(`response:${groupId}:${requester}`)) return null;
    return handleKeyRequest(requestPayload, this._keystoreRef, this._currentAid(), currentMembers);
  }

  // ── 状态查询 ──────────────────────────────────────

  async hasSecret(groupId: string): Promise<boolean> {
    const s = await loadGroupSecret(this._keystoreRef, this._currentAid(), groupId);
    return s !== null;
  }

  async currentEpoch(groupId: string): Promise<number | null> {
    const s = await loadGroupSecret(this._keystoreRef, this._currentAid(), groupId);
    return s ? s.epoch : null;
  }

  async getMemberAids(groupId: string): Promise<string[]> {
    const s = await loadGroupSecret(this._keystoreRef, this._currentAid(), groupId);
    return s ? s.member_aids : [];
  }

  // ── 内部工具 ──────────────────────────────────────

  private _currentAid(): string {
    const identity = this._identityFn();
    const aid = identity.aid;
    if (!aid) throw new E2EEError('AID unavailable');
    return String(aid);
  }
}
