/**
 * E2EEManager — 端到端加密管理器
 *
 * 加密策略：prekey_ecdh_v2（四路 ECDH）→ long_term_key（二路 ECDH）两层降级。
 * I/O（获取 prekey、证书）由调用方（AUNClient）负责。
 * 内置本地防重放（seen set），裸 WebSocket 开发者无需额外实现。
 */

import * as crypto from 'node:crypto';
import type { KeyStore } from './keystore/index.js';
import { E2EEError, E2EEDecryptFailedError } from './errors.js';

// ── 常量 ───────────────────────────────────────────────────────

export const SUITE = 'P256_HKDF_SHA256_AES_256_GCM';

/** 四路 ECDH：prekey + identity */
export const MODE_PREKEY_ECDH_V2 = 'prekey_ecdh_v2';
/** 降级：长期公钥加密 */
export const MODE_LONG_TERM_KEY = 'long_term_key';

/** 离线消息 AAD 字段 */
export const AAD_FIELDS_OFFLINE: readonly string[] = [
  'from', 'to', 'message_id', 'timestamp',
  'encryption_mode', 'suite', 'ephemeral_public_key',
  'recipient_cert_fingerprint', 'sender_cert_fingerprint',
  'prekey_id',
] as const;

/** 离线消息 AAD 匹配字段（不含 timestamp） */
export const AAD_MATCH_FIELDS_OFFLINE: readonly string[] = [
  'from', 'to', 'message_id',
  'encryption_mode', 'suite', 'ephemeral_public_key',
  'recipient_cert_fingerprint', 'sender_cert_fingerprint',
  'prekey_id',
] as const;

/** prekey 私钥本地保留时间（秒）— 7 天 */
const PREKEY_RETENTION_SECONDS = 7 * 24 * 3600;

// ── 工具函数 ───────────────────────────────────────────────────

/** 将 PEM 证书/公钥转为 KeyObject */
function pemToCertPublicKey(certPem: string | Buffer): crypto.KeyObject {
  const pem = typeof certPem === 'string' ? certPem : certPem.toString('utf-8');
  const x509 = new crypto.X509Certificate(pem);
  return x509.publicKey;
}

/** ECDH 共享密钥计算 */
function ecdhShared(privateKey: crypto.KeyObject, publicKey: crypto.KeyObject): Buffer {
  return crypto.diffieHellman({ privateKey, publicKey });
}

/** HKDF-SHA256 派生密钥 */
function hkdfDeriveSync(ikm: Buffer, info: Buffer, length: number): Buffer {
  // Node.js crypto.hkdfSync 在 v16+ 可用
  const derived = crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, length);
  return Buffer.from(derived);
}

/** AES-256-GCM 加密，返回 {ciphertext, tag, nonce} */
function aesGcmEncrypt(
  key: Buffer, plaintext: Buffer, aad: Buffer,
): { ciphertext: Buffer; tag: Buffer; nonce: Buffer } {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: encrypted, tag, nonce };
}

/** AES-256-GCM 解密 */
function aesGcmDecrypt(
  key: Buffer, ciphertext: Buffer, tag: Buffer, nonce: Buffer, aad: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** ECDSA-SHA256 签名 */
function ecdsaSign(privateKeyPem: string, data: Buffer): Buffer {
  const signer = crypto.createSign('SHA256');
  signer.update(data);
  signer.end();
  return signer.sign(privateKeyPem);
}

/** ECDSA-SHA256 验签 */
function ecdsaVerify(publicKey: crypto.KeyObject, signature: Buffer, data: Buffer): boolean {
  const verifier = crypto.createVerify('SHA256');
  verifier.update(data);
  verifier.end();
  return verifier.verify(publicKey, signature);
}

/** 生成 ECDSA P-256 密钥对 */
function generateECKeyPair(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/** 公钥 → DER SPKI 指纹 */
function fingerprintPublicKeyDer(derBytes: Buffer): string {
  const hash = crypto.createHash('sha256').update(derBytes).digest();
  return `sha256:${hash.toString('hex')}`;
}

/** KeyObject 公钥 → 指纹 */
function fingerprintKeyObject(pubKey: crypto.KeyObject): string {
  const der = pubKey.export({ type: 'spki', format: 'der' });
  return fingerprintPublicKeyDer(der as Buffer);
}

/** PEM 证书 → 公钥指纹 */
function fingerprintCertPem(certPem: string | Buffer): string {
  const pubKey = pemToCertPublicKey(certPem);
  return fingerprintKeyObject(pubKey);
}

/** 公钥 KeyObject → 未压缩点（0x04 || x || y，65 字节） */
function publicKeyToUncompressedPoint(pubKey: crypto.KeyObject): Buffer {
  // 用 JWK 提取 x, y
  const jwk = pubKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

/** 未压缩点 → KeyObject */
function uncompressedPointToPublicKey(point: Buffer): crypto.KeyObject {
  // 构造 JWK
  if (point[0] !== 0x04 || point.length !== 65) {
    throw new E2EEError('无效的未压缩公钥点格式');
  }
  const x = point.subarray(1, 33).toString('base64url');
  const y = point.subarray(33, 65).toString('base64url');
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x, y },
    format: 'jwk',
  });
}

/** 离线消息 AAD → 排序紧凑 JSON bytes */
function aadBytesOffline(aad: Record<string, unknown>): Buffer {
  const obj: Record<string, unknown> = {};
  for (const field of AAD_FIELDS_OFFLINE) {
    obj[field] = aad[field] ?? null;
  }
  // sorted keys, compact JSON — 与 Python json.dumps(sort_keys=True, separators=(",",":")) 一致
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return Buffer.from(JSON.stringify(sorted), 'utf-8');
}

/** AAD 匹配检查 */
function aadMatchesOffline(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const field of AAD_MATCH_FIELDS_OFFLINE) {
    if (String(expected[field] ?? '') !== String(actual[field] ?? '')) {
      return false;
    }
  }
  return true;
}

// ── E2EEManager 类 ────────────────────────────────────────────

export class E2EEManager {
  private _identityFn: () => Record<string, unknown>;
  private _keystore: KeyStore;
  /** 本地防重放 seen set */
  private _seenMessages = new Map<string, boolean>();
  private _seenMaxSize = 50000;
  /** 对方 prekey 内存缓存（TTL） */
  private _prekeyCache = new Map<string, { prekey: Record<string, unknown>; expireAt: number }>();
  private _prekeyCacheTtl: number;
  /** 本地 prekey 私钥内存缓存 {prekeyId: privateKeyPem} */
  private _localPrekeyCache = new Map<string, string>();
  /** 防重放时间窗口（秒） */
  private _replayWindowSeconds: number;

  constructor(opts: {
    identityFn: () => Record<string, unknown>;
    keystore: KeyStore;
    prekeyCacheTtl?: number;
    replayWindowSeconds?: number;
  }) {
    this._identityFn = opts.identityFn;
    this._keystore = opts.keystore;
    this._prekeyCacheTtl = opts.prekeyCacheTtl ?? 3600;
    this._replayWindowSeconds = opts.replayWindowSeconds ?? 300;
  }

  // ── 便利方法 ──────────────────────────────────────────────

  /**
   * 加密消息（便利方法）。
   * 有 prekey 时用 prekey_ecdh_v2（四路 ECDH），无 prekey 时降级为 long_term_key。
   */
  encryptMessage(
    toAid: string,
    payload: Record<string, unknown>,
    opts: {
      peerCertPem: string;
      prekey?: Record<string, unknown> | null;
      messageId?: string;
      timestamp?: number;
    },
  ): [Record<string, unknown>, Record<string, unknown>] {
    const messageId = opts.messageId ?? crypto.randomUUID();
    const timestamp = opts.timestamp ?? Math.floor(Date.now());
    return this.encryptOutbound(
      toAid, payload, opts.peerCertPem,
      opts.prekey ?? null, messageId, timestamp,
    );
  }

  // ── 加密 ─────────────────────────────────────────────────

  /**
   * 加密出站消息：有 prekey → prekey_ecdh_v2（四路 ECDH），无 prekey → long_term_key。
   * 返回 [envelope, resultInfo]。
   */
  encryptOutbound(
    peerAid: string,
    payload: unknown,
    peerCertPem: string,
    prekey: Record<string, unknown> | null,
    messageId: string,
    timestamp: number,
  ): [Record<string, unknown>, Record<string, unknown>] {
    // 传入 prekey → 缓存；传入 null → 查缓存
    if (prekey != null) {
      this.cachePrekey(peerAid, prekey);
    } else {
      prekey = this.getCachedPrekey(peerAid);
    }

    if (prekey) {
      try {
        const envelope = this._encryptWithPrekey(
          peerAid, payload as Record<string, unknown>, prekey,
          peerCertPem, messageId, timestamp,
        );
        return [envelope, {
          encrypted: true,
          forward_secrecy: true,
          mode: MODE_PREKEY_ECDH_V2,
          degraded: false,
        }];
      } catch (exc) {
        // prekey 加密失败，降级到 long_term_key
      }
    }

    const envelope = this._encryptWithLongTermKey(
      peerAid, payload as Record<string, unknown>,
      peerCertPem, messageId, timestamp,
    );
    const degraded = prekey != null;
    return [envelope, {
      encrypted: true,
      forward_secrecy: false,
      mode: MODE_LONG_TERM_KEY,
      degraded,
      degradation_reason: degraded ? 'prekey_encrypt_failed' : 'no_prekey_available',
    }];
  }

  /** 使用对方 prekey 加密（prekey_ecdh_v2 模式，四路 ECDH + 发送方签名） */
  private _encryptWithPrekey(
    peerAid: string,
    payload: Record<string, unknown>,
    prekey: Record<string, unknown>,
    peerCertPem: string,
    messageId: string,
    timestamp: number,
  ): Record<string, unknown> {
    const peerIdentityPublic = pemToCertPublicKey(peerCertPem);

    // 验证 prekey 签名
    const createdAt = prekey.created_at as number | undefined;
    let signData: Buffer;
    if (createdAt != null) {
      signData = Buffer.from(`${prekey.prekey_id}|${prekey.public_key}|${createdAt}`, 'utf-8');
      // 检查 prekey 年龄（默认 30 天）
      const ageMs = Date.now() - Number(createdAt);
      if (ageMs > 30 * 24 * 3600 * 1000) {
        throw new E2EEError(`prekey too old: ${Math.floor(ageMs / 1000)}s`);
      }
    } else {
      signData = Buffer.from(`${prekey.prekey_id}|${prekey.public_key}`, 'utf-8');
    }
    const sigBytes = Buffer.from(prekey.signature as string, 'base64');
    if (!ecdsaVerify(peerIdentityPublic, sigBytes, signData)) {
      throw new E2EEError('prekey signature verification failed');
    }

    // 导入对方 prekey 公钥（DER SPKI）
    const peerPrekeyDer = Buffer.from(prekey.public_key as string, 'base64');
    const peerPrekeyPublic = crypto.createPublicKey({ key: peerPrekeyDer, format: 'der', type: 'spki' });

    // 加载发送方自己的 identity 私钥
    const senderIdentityPrivate = this._loadSenderIdentityPrivate();

    // 生成临时 ECDH 密钥对
    const { privateKey: ephemeralPrivate, publicKey: ephemeralPublic } = generateECKeyPair();
    const ephemeralPublicBytes = publicKeyToUncompressedPoint(ephemeralPublic);

    // 四路 ECDH + HKDF
    const dh1 = ecdhShared(ephemeralPrivate, peerPrekeyPublic);
    const dh2 = ecdhShared(ephemeralPrivate, peerIdentityPublic);
    const dh3 = ecdhShared(senderIdentityPrivate, peerPrekeyPublic);
    const dh4 = ecdhShared(senderIdentityPrivate, peerIdentityPublic);
    const combined = Buffer.concat([dh1, dh2, dh3, dh4]);
    const messageKey = hkdfDeriveSync(
      combined, Buffer.from(`aun-prekey-v2:${prekey.prekey_id}`, 'utf-8'), 32,
    );

    // AES-GCM 加密
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
    const senderFingerprint = this._localIdentityFingerprint();
    const recipientFingerprint = fingerprintCertPem(peerCertPem);
    const ephemeralPkB64 = ephemeralPublicBytes.toString('base64');

    const aad: Record<string, unknown> = {
      from: this._currentAid(),
      to: peerAid,
      message_id: messageId,
      timestamp,
      encryption_mode: MODE_PREKEY_ECDH_V2,
      suite: SUITE,
      ephemeral_public_key: ephemeralPkB64,
      recipient_cert_fingerprint: recipientFingerprint,
      sender_cert_fingerprint: senderFingerprint,
      prekey_id: prekey.prekey_id,
    };
    const aadBytes = aadBytesOffline(aad);
    const { ciphertext, tag, nonce } = aesGcmEncrypt(messageKey, plaintext, aadBytes);

    const envelope: Record<string, unknown> = {
      type: 'e2ee.encrypted',
      version: '1',
      encryption_mode: MODE_PREKEY_ECDH_V2,
      suite: SUITE,
      prekey_id: prekey.prekey_id,
      ephemeral_public_key: ephemeralPkB64,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
      aad,
    };

    // 发送方签名：对 ciphertext + tag + aad_bytes 签名（不可否认性）
    const signPayload = Buffer.concat([ciphertext, tag, aadBytes]);
    envelope.sender_signature = this._signBytes(signPayload);
    envelope.sender_cert_fingerprint = senderFingerprint;
    return envelope;
  }

  /** 使用 2DH 加密（long_term_key 模式 + 发送方签名） */
  private _encryptWithLongTermKey(
    peerAid: string,
    payload: Record<string, unknown>,
    peerCertPem: string,
    messageId: string,
    timestamp: number,
  ): Record<string, unknown> {
    const peerPublicKey = pemToCertPublicKey(peerCertPem);
    const senderIdentityPrivate = this._loadSenderIdentityPrivate();

    // 生成临时密钥对
    const { privateKey: ephemeralPrivate, publicKey: ephemeralPublic } = generateECKeyPair();
    const ephemeralPublicBytes = publicKeyToUncompressedPoint(ephemeralPublic);

    // 2DH + HKDF
    const dh1 = ecdhShared(ephemeralPrivate, peerPublicKey);
    const dh2 = ecdhShared(senderIdentityPrivate, peerPublicKey);
    const combined = Buffer.concat([dh1, dh2]);
    const messageKey = hkdfDeriveSync(
      combined, Buffer.from('aun-longterm-v2', 'utf-8'), 32,
    );

    const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
    const senderFingerprint = this._localIdentityFingerprint();
    const recipientFingerprint = fingerprintCertPem(peerCertPem);
    const ephemeralPkB64 = ephemeralPublicBytes.toString('base64');

    const aad: Record<string, unknown> = {
      from: this._currentAid(),
      to: peerAid,
      message_id: messageId,
      timestamp,
      encryption_mode: MODE_LONG_TERM_KEY,
      suite: SUITE,
      ephemeral_public_key: ephemeralPkB64,
      recipient_cert_fingerprint: recipientFingerprint,
      sender_cert_fingerprint: senderFingerprint,
    };
    const aadBytes = aadBytesOffline(aad);
    const { ciphertext, tag, nonce } = aesGcmEncrypt(messageKey, plaintext, aadBytes);

    const envelope: Record<string, unknown> = {
      type: 'e2ee.encrypted',
      version: '1',
      encryption_mode: MODE_LONG_TERM_KEY,
      suite: SUITE,
      ephemeral_public_key: ephemeralPkB64,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
      aad,
    };

    // 发送方签名（不可否认性）
    const signPayload = Buffer.concat([ciphertext, tag, aadBytes]);
    envelope.sender_signature = this._signBytes(signPayload);
    envelope.sender_cert_fingerprint = senderFingerprint;
    return envelope;
  }

  // ── 解密 ─────────────────────────────────────────────────

  /** 解密单条消息（便利方法，内置本地防重放 + timestamp 窗口） */
  decryptMessage(message: Record<string, unknown>): Record<string, unknown> | null {
    const payload = message.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return message;
    if (payload.type !== 'e2ee.encrypted') return message;
    if (message.encrypted === false) return message;
    if (!this._shouldDecryptForCurrentAid(message, payload)) return message;

    // timestamp 窗口检查
    const ts = (message.timestamp ?? (payload.aad as Record<string, unknown> | undefined)?.timestamp) as number | undefined;
    if (typeof ts === 'number' && this._replayWindowSeconds > 0) {
      const nowMs = Date.now();
      const diffS = Math.abs(nowMs - ts) / 1000;
      if (diffS > this._replayWindowSeconds) {
        return null;
      }
    }

    // 本地防重放
    const messageId = message.message_id as string || '';
    const fromAid = message.from as string || '';
    if (messageId && fromAid) {
      const seenKey = `${fromAid}:${messageId}`;
      if (this._seenMessages.has(seenKey)) return null;
      this._seenMessages.set(seenKey, true);
      this._trimSeenSet();
    }

    return this._decryptMessage(message);
  }

  /** 解密入站消息（不消耗 seen set，用于 pull 场景） */
  _decryptMessage(message: Record<string, unknown>): Record<string, unknown> | null {
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload === 'object' && !this._shouldDecryptForCurrentAid(message, payload)) {
      return message;
    }
    const encryptionMode = (payload.encryption_mode as string) || '';

    // 验证发送方签名（适用于所有模式）
    try {
      this._verifySenderSignature(payload, message);
    } catch {
      return null;
    }

    if (encryptionMode === MODE_PREKEY_ECDH_V2) {
      return this._decryptMessagePrekeyV2(message);
    } else if (encryptionMode === MODE_LONG_TERM_KEY) {
      return this._decryptMessageLongTerm(message);
    }
    return null;
  }

  /** 解密 prekey_ecdh_v2 模式的消息（四路 ECDH） */
  private _decryptMessagePrekeyV2(message: Record<string, unknown>): Record<string, unknown> | null {
    const payload = message.payload as Record<string, unknown>;
    try {
      const ephemeralPublicBytes = Buffer.from(payload.ephemeral_public_key as string, 'base64');
      const prekeyId = (payload.prekey_id as string) || '';
      const nonce = Buffer.from(payload.nonce as string, 'base64');
      const ciphertext = Buffer.from(payload.ciphertext as string, 'base64');
      const tag = Buffer.from(payload.tag as string, 'base64');

      // 加载 prekey 私钥
      const prekeyPrivateKey = this._loadPrekeyPrivateKey(prekeyId);
      if (!prekeyPrivateKey) {
        throw new E2EEError(`prekey not found: ${prekeyId}`);
      }

      // 加载接收方自己的 identity 私钥
      const myAid = this._currentAid();
      if (!myAid) throw new E2EEError('AID unavailable');
      const keyPair = this._keystore.loadKeyPair(myAid);
      if (!keyPair || !keyPair.private_key_pem) {
        throw new E2EEError('Identity private key not found');
      }
      const myIdentityPrivate = crypto.createPrivateKey(keyPair.private_key_pem as string);

      // 获取发送方公钥
      const fromAid = (message.from ?? (payload.aad as Record<string, unknown> | undefined)?.from) as string;
      const senderPublicKey = this._loadSenderPublicKey(fromAid);
      if (!senderPublicKey) {
        throw new E2EEError(`sender public key not found for ${fromAid}`);
      }

      // 四路 ECDH + HKDF
      const ephemeralPublic = uncompressedPointToPublicKey(ephemeralPublicBytes);
      const dh1 = ecdhShared(prekeyPrivateKey, ephemeralPublic);
      const dh2 = ecdhShared(myIdentityPrivate, ephemeralPublic);
      const dh3 = ecdhShared(prekeyPrivateKey, senderPublicKey);
      const dh4 = ecdhShared(myIdentityPrivate, senderPublicKey);
      const combined = Buffer.concat([dh1, dh2, dh3, dh4]);
      const messageKey = hkdfDeriveSync(
        combined, Buffer.from(`aun-prekey-v2:${prekeyId}`, 'utf-8'), 32,
      );

      // 验证 AAD 并解密
      const aad = payload.aad as Record<string, unknown> | undefined;
      let aadBytes: Buffer;
      if (aad && typeof aad === 'object') {
        const expectedAad = this._buildInboundAadOffline(message, payload);
        if (!aadMatchesOffline(expectedAad, aad)) {
          throw new E2EEDecryptFailedError('aad mismatch');
        }
        aadBytes = aadBytesOffline(aad);
      } else {
        aadBytes = Buffer.alloc(0);
      }
      const plaintext = aesGcmDecrypt(messageKey, ciphertext, tag, nonce, aadBytes);
      const decoded = JSON.parse(plaintext.toString('utf-8'));

      return {
        ...message,
        payload: decoded,
        encrypted: true,
        e2ee: {
          encryption_mode: MODE_PREKEY_ECDH_V2,
          suite: (payload.suite as string) || SUITE,
          prekey_id: prekeyId,
        },
      };
    } catch {
      return null;
    }
  }

  /** 解密 long_term_key 模式的消息（2DH） */
  private _decryptMessageLongTerm(message: Record<string, unknown>): Record<string, unknown> | null {
    const payload = message.payload as Record<string, unknown>;
    try {
      const ephemeralPublicBytes = Buffer.from(payload.ephemeral_public_key as string, 'base64');
      const nonce = Buffer.from(payload.nonce as string, 'base64');
      const ciphertext = Buffer.from(payload.ciphertext as string, 'base64');
      const tag = Buffer.from(payload.tag as string, 'base64');

      const myAid = this._currentAid();
      if (!myAid) throw new E2EEError('AID unavailable');
      const keyPair = this._keystore.loadKeyPair(myAid);
      if (!keyPair || !keyPair.private_key_pem) {
        throw new E2EEError('Private key not found');
      }
      const privateKey = crypto.createPrivateKey(keyPair.private_key_pem as string);

      // 获取发送方公钥
      const fromAid = (message.from ?? (payload.aad as Record<string, unknown> | undefined)?.from) as string;
      const senderPublicKey = this._loadSenderPublicKey(fromAid);
      if (!senderPublicKey) {
        throw new E2EEError(`sender public key not found for ${fromAid}`);
      }

      // 2DH + HKDF
      const ephemeralPublic = uncompressedPointToPublicKey(ephemeralPublicBytes);
      const dh1 = ecdhShared(privateKey, ephemeralPublic);
      const dh2 = ecdhShared(privateKey, senderPublicKey);
      const combined = Buffer.concat([dh1, dh2]);
      const messageKey = hkdfDeriveSync(
        combined, Buffer.from('aun-longterm-v2', 'utf-8'), 32,
      );

      const aad = payload.aad as Record<string, unknown> | undefined;
      let aadBytes: Buffer;
      if (aad && typeof aad === 'object') {
        const expectedAad = this._buildInboundAadOffline(message, payload);
        if (!aadMatchesOffline(expectedAad, aad)) {
          throw new E2EEDecryptFailedError('aad mismatch');
        }
        aadBytes = aadBytesOffline(aad);
      } else {
        aadBytes = Buffer.alloc(0);
      }
      const plaintext = aesGcmDecrypt(messageKey, ciphertext, tag, nonce, aadBytes);
      const decoded = JSON.parse(plaintext.toString('utf-8'));

      return {
        ...message,
        payload: decoded,
        encrypted: true,
        e2ee: {
          encryption_mode: MODE_LONG_TERM_KEY,
          suite: payload.suite as string,
        },
      };
    } catch {
      return null;
    }
  }

  // ── 发送方签名验证 ─────────────────────────────────────────

  private _verifySenderSignature(payload: Record<string, unknown>, message: Record<string, unknown>): void {
    const senderSigB64 = payload.sender_signature as string | undefined;
    if (!senderSigB64) {
      throw new E2EEDecryptFailedError('sender_signature missing: 拒绝无发送方签名的消息');
    }

    const fromAid = (message.from ?? (payload.aad as Record<string, unknown> | undefined)?.from) as string;
    if (!fromAid) {
      throw new E2EEDecryptFailedError('from_aid missing in message');
    }

    const senderCertPem = this._getSenderCert(fromAid);
    if (!senderCertPem) {
      throw new E2EEDecryptFailedError(`sender cert not found for ${fromAid}`);
    }

    const senderPublicKey = pemToCertPublicKey(senderCertPem);

    // 重建签名载荷
    const ciphertextBuf = Buffer.from(payload.ciphertext as string, 'base64');
    const tagBuf = Buffer.from(payload.tag as string, 'base64');
    const aad = payload.aad as Record<string, unknown> | undefined;
    const aadBytes = (aad && typeof aad === 'object') ? aadBytesOffline(aad) : Buffer.alloc(0);
    const signPayload = Buffer.concat([ciphertextBuf, tagBuf, aadBytes]);

    const sigBytes = Buffer.from(senderSigB64, 'base64');
    if (!ecdsaVerify(senderPublicKey, sigBytes, signPayload)) {
      throw new E2EEDecryptFailedError('sender signature verification failed');
    }
  }

  // ── Prekey 缓存 ────────────────────────────────────────────

  /** 缓存对方的 prekey */
  cachePrekey(peerAid: string, prekey: Record<string, unknown>): void {
    this._prekeyCache.set(peerAid, {
      prekey,
      expireAt: Date.now() / 1000 + this._prekeyCacheTtl,
    });
  }

  /** 获取缓存的 prekey（过期返回 null） */
  getCachedPrekey(peerAid: string): Record<string, unknown> | null {
    const cached = this._prekeyCache.get(peerAid);
    if (!cached) return null;
    if (Date.now() / 1000 >= cached.expireAt) {
      this._prekeyCache.delete(peerAid);
      return null;
    }
    return cached.prekey;
  }

  /** 使指定 peer 的 prekey 缓存失效 */
  invalidatePrekeyCahce(peerAid: string): void {
    this._prekeyCache.delete(peerAid);
  }

  // ── Prekey 生成 ──────────────────────────────────────────

  /**
   * 生成 prekey 材料并保存私钥到本地 keystore。
   * 返回 {prekey_id, public_key, signature, created_at}，可直接用于 RPC 上传。
   */
  generatePrekey(): Record<string, unknown> {
    const aid = this._currentAid();
    if (!aid) throw new E2EEError('AID unavailable for prekey generation');

    // 生成新 prekey
    const { privateKey, publicKey } = generateECKeyPair();
    const publicDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const prekeyId = crypto.randomUUID();
    const publicKeyB64 = publicDer.toString('base64');
    const nowMs = Date.now();

    // 签名：prekey_id|public_key|created_at
    const signDataBuf = Buffer.from(`${prekeyId}|${publicKeyB64}|${nowMs}`, 'utf-8');
    const signature = this._signBytes(signDataBuf);

    // 保存私钥到本地 keystore
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const metadata = this._keystore.loadMetadata(aid) ?? {};
    const localPrekeys = (metadata.e2ee_prekeys as Record<string, Record<string, unknown>>) ?? {};
    localPrekeys[prekeyId] = {
      private_key_pem: privateKeyPem,
      created_at: nowMs,
    };
    metadata.e2ee_prekeys = localPrekeys;
    this._keystore.saveMetadata(aid, metadata);

    // 内存缓存私钥
    this._localPrekeyCache.set(prekeyId, privateKeyPem);

    // 清理过期的旧 prekey 私钥
    this._cleanupExpiredPrekeys(aid);

    return {
      prekey_id: prekeyId,
      public_key: publicKeyB64,
      signature,
      created_at: nowMs,
    };
  }

  /** 清理本地过期的 prekey 私钥 */
  private _cleanupExpiredPrekeys(aid: string): void {
    const metadata = this._keystore.loadMetadata(aid) ?? {};
    const localPrekeys = metadata.e2ee_prekeys as Record<string, Record<string, unknown>> | undefined;
    if (!localPrekeys) return;

    const nowMs = Date.now();
    const cutoffMs = nowMs - PREKEY_RETENTION_SECONDS * 1000;
    const expired: string[] = [];
    for (const [pid, data] of Object.entries(localPrekeys)) {
      if (((data.created_at as number) || 0) < cutoffMs) {
        expired.push(pid);
      }
    }
    if (expired.length > 0) {
      for (const pid of expired) {
        delete localPrekeys[pid];
        this._localPrekeyCache.delete(pid);
      }
      metadata.e2ee_prekeys = localPrekeys;
      this._keystore.saveMetadata(aid, metadata);
    }
  }

  /** 从内存缓存或 keystore 加载 prekey 私钥 */
  private _loadPrekeyPrivateKey(prekeyId: string): crypto.KeyObject | null {
    // 优先从内存缓存获取
    const cachedPem = this._localPrekeyCache.get(prekeyId);
    if (cachedPem) {
      return crypto.createPrivateKey(cachedPem);
    }

    const aid = this._currentAid();
    if (!aid) return null;
    const metadata = this._keystore.loadMetadata(aid) ?? {};
    const prekeys = metadata.e2ee_prekeys as Record<string, Record<string, unknown>> | undefined;
    if (!prekeys) return null;
    const prekeyData = prekeys[prekeyId];
    if (!prekeyData) return null;
    const privateKeyPem = prekeyData.private_key_pem as string | undefined;
    if (!privateKeyPem) return null;

    try {
      const pk = crypto.createPrivateKey(privateKeyPem);
      this._localPrekeyCache.set(prekeyId, privateKeyPem);
      return pk;
    } catch {
      return null;
    }
  }

  // ── 证书指纹工具 ────────────────────────────────────────

  /** 从 PEM 证书计算公钥指纹 */
  static fingerprintCertPem(certPem: string): string {
    return fingerprintCertPem(certPem);
  }

  /** 公钥 DER bytes → 指纹 */
  static fingerprintDerPublicKey(derBytes: Buffer): string {
    return fingerprintPublicKeyDer(derBytes);
  }

  // ── 内部工具 ─────────────────────────────────────────────

  /** 仅解密发给当前 AID 的消息 */
  private _shouldDecryptForCurrentAid(
    message: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): boolean {
    const currentAid = this._currentAid();
    if (!currentAid) return true;
    const targetAid =
      (message.to as string) ||
      (payload.aad as Record<string, unknown> | undefined)?.to as string ||
      (payload.to as string);
    if (!targetAid) return true;
    return String(targetAid) === String(currentAid);
  }

  /** LRU 裁剪 seen set */
  private _trimSeenSet(): void {
    if (this._seenMessages.size > this._seenMaxSize) {
      const trimCount = this._seenMessages.size - Math.floor(this._seenMaxSize * 0.8);
      const iter = this._seenMessages.keys();
      for (let i = 0; i < trimCount; i++) {
        const next = iter.next();
        if (next.done) break;
        this._seenMessages.delete(next.value);
      }
    }
  }

  /** 获取当前 AID */
  private _currentAid(): string | null {
    const identity = this._identityFn();
    const aid = identity.aid;
    return aid ? String(aid) : null;
  }

  /** 获取发送方证书 */
  private _getSenderCert(aid: string): string | null {
    return this._keystore.loadCert(aid);
  }

  /** 获取发送方的 identity 公钥（从本地证书缓存） */
  private _loadSenderPublicKey(aid: string | null): crypto.KeyObject | null {
    if (!aid) return null;
    const certPem = this._getSenderCert(aid);
    if (!certPem) return null;
    try {
      return pemToCertPublicKey(certPem);
    } catch {
      return null;
    }
  }

  /** 用当前身份私钥签名 */
  private _signBytes(data: Buffer): string {
    const identity = this._identityFn();
    const privateKeyPem = identity.private_key_pem as string | undefined;
    if (!privateKeyPem) {
      throw new E2EEError('identity private key unavailable');
    }
    return ecdsaSign(privateKeyPem, data).toString('base64');
  }

  /** 加载发送方自己的 identity 私钥 */
  private _loadSenderIdentityPrivate(): crypto.KeyObject {
    const identity = this._identityFn();
    const privateKeyPem = identity.private_key_pem as string | undefined;
    if (!privateKeyPem) {
      throw new E2EEError('sender identity private key unavailable');
    }
    return crypto.createPrivateKey(privateKeyPem);
  }

  /** 本地 identity 指纹 */
  private _localIdentityFingerprint(): string {
    const identity = this._identityFn();
    const publicKeyDerB64 = identity.public_key_der_b64 as string | undefined;
    if (publicKeyDerB64) {
      return fingerprintPublicKeyDer(Buffer.from(publicKeyDerB64, 'base64'));
    }
    const cert = identity.cert as string | undefined;
    if (cert) {
      return fingerprintCertPem(cert);
    }
    const privateKeyPem = identity.private_key_pem as string | undefined;
    if (privateKeyPem) {
      const pk = crypto.createPrivateKey(privateKeyPem);
      const pubKey = crypto.createPublicKey(pk);
      return fingerprintKeyObject(pubKey);
    }
    throw new E2EEError('identity fingerprint unavailable');
  }

  /** 本地证书指纹（与 _localIdentityFingerprint 相同） */
  private _localCertFingerprint(): string {
    return this._localIdentityFingerprint();
  }

  /** 构建接收端 AAD */
  private _buildInboundAadOffline(
    message: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const aad = payload.aad as Record<string, unknown> | undefined;
    return {
      from: message.from,
      to: message.to,
      message_id: message.message_id,
      timestamp: message.timestamp,
      encryption_mode: payload.encryption_mode,
      suite: (payload.suite as string) || SUITE,
      ephemeral_public_key: payload.ephemeral_public_key,
      recipient_cert_fingerprint: this._localCertFingerprint(),
      sender_cert_fingerprint: (payload.sender_cert_fingerprint ?? aad?.sender_cert_fingerprint) as string | undefined,
      prekey_id: (payload.prekey_id ?? aad?.prekey_id) as string | undefined,
    };
  }
}
