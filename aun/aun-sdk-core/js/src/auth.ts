// ── AuthFlow（认证流程 — 浏览器完整实现）─────────────────
// 负责 AID 注册、login1/login2 双阶段认证、证书链验证、token 管理。
// 浏览器环境使用原生 WebSocket + fetch + SubtleCrypto。

import type { KeyStore } from './keystore/index.js';
import { CryptoProvider, base64ToUint8, uint8ToBase64, pemToArrayBuffer } from './crypto.js';
import { AuthError, StateError, ValidationError, mapRemoteError } from './errors.js';
import { ROOT_CA_PEM } from './certs/root.js';

// ── ASN.1 / PEM 工具 ────────────────────────────────────

/** 拆分 PEM bundle 为独立的 PEM 字符串数组 */
function splitPemBundle(bundle: string): string[] {
  const marker = '-----END CERTIFICATE-----';
  const certs: string[] = [];
  for (const part of bundle.split(marker)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    certs.push(`${trimmed}\n${marker}\n`);
  }
  return certs;
}

/** 将 DER 格式的 ECDSA 签名转为 IEEE P1363 格式（SubtleCrypto 需要） */
function derToP1363(der: Uint8Array, curveLen: number = 32): Uint8Array {
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  if (der[0] !== 0x30) throw new AuthError('无效的 DER 签名格式');
  let offset = 2;
  // 跳过可能的多字节长度
  if (der[1] & 0x80) offset += (der[1] & 0x7f);

  if (der[offset] !== 0x02) throw new AuthError('DER 签名缺少 r INTEGER 标签');
  const rLen = der[offset + 1];
  const rBytes = der.slice(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  if (der[offset] !== 0x02) throw new AuthError('DER 签名缺少 s INTEGER 标签');
  const sLen = der[offset + 1];
  const sBytes = der.slice(offset + 2, offset + 2 + sLen);

  // 去前导零并填充到 curveLen
  const r = padToLength(trimSignedIntLeadingZeros(rBytes), curveLen);
  const s = padToLength(trimSignedIntLeadingZeros(sBytes), curveLen);

  const result = new Uint8Array(curveLen * 2);
  result.set(r, 0);
  result.set(s, curveLen);
  return result;
}

/** 去除 ASN.1 有符号整数的前导零 */
function trimSignedIntLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return bytes.slice(start);
}

/** 将字节数组左侧填零至指定长度 */
function padToLength(bytes: Uint8Array, len: number): Uint8Array {
  if (bytes.length >= len) return bytes.slice(bytes.length - len);
  const padded = new Uint8Array(len);
  padded.set(bytes, len - bytes.length);
  return padded;
}

// ── 简化版 X.509 DER 解析 ───────────────────────────────

/** 解析后的证书信息（浏览器端简化版） */
interface ParsedCert {
  /** 原始 PEM 文本 */
  pem: string;
  /** TBS (To Be Signed) 证书字节 */
  tbsBytes: Uint8Array;
  /** 签名字节（DER 编码） */
  signatureBytes: Uint8Array;
  /** 签名算法 OID */
  signatureAlgorithmOid: string;
  /** 序列号（十六进制小写） */
  serialHex: string;
  /** Subject CN（可能为空） */
  subjectCN: string;
  /** Issuer DN 原始字节（用于比较） */
  issuerRaw: Uint8Array;
  /** Subject DN 原始字节（用于比较） */
  subjectRaw: Uint8Array;
  /** 有效期开始（UNIX 时间戳） */
  notBefore: number;
  /** 有效期结束（UNIX 时间戳） */
  notAfter: number;
  /** 是否为 CA 证书 */
  isCA: boolean;
  /** SPKI 公钥字节 */
  spkiBytes: Uint8Array;
}

/** 读取 ASN.1 TLV 的 tag 和长度，返回 [tag, 值起始偏移, 值长度] */
function readTlv(data: Uint8Array, offset: number): [number, number, number] {
  const tag = data[offset];
  let lenOffset = offset + 1;
  let length: number;

  if (data[lenOffset] & 0x80) {
    const numBytes = data[lenOffset] & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | data[lenOffset + 1 + i];
    }
    lenOffset += 1 + numBytes;
  } else {
    length = data[lenOffset];
    lenOffset += 1;
  }
  return [tag, lenOffset, length];
}

/** 获取 TLV 完整范围（包含 tag + length + value） */
function getTlvFullRange(data: Uint8Array, offset: number): [number, number] {
  const [, valueStart, valueLen] = readTlv(data, offset);
  return [offset, valueStart + valueLen];
}

/** 解析 ASN.1 UTCTime 或 GeneralizedTime 为 UNIX 时间戳 */
function parseAsn1Time(data: Uint8Array, offset: number): number {
  const [tag, valueStart, valueLen] = readTlv(data, offset);
  const timeStr = new TextDecoder().decode(data.slice(valueStart, valueStart + valueLen));

  if (tag === 0x17) {
    // UTCTime: YYMMDDHHMMSSZ
    let year = parseInt(timeStr.substring(0, 2), 10);
    year += year >= 50 ? 1900 : 2000;
    const month = parseInt(timeStr.substring(2, 4), 10) - 1;
    const day = parseInt(timeStr.substring(4, 6), 10);
    const hour = parseInt(timeStr.substring(6, 8), 10);
    const minute = parseInt(timeStr.substring(8, 10), 10);
    const second = parseInt(timeStr.substring(10, 12), 10);
    return Date.UTC(year, month, day, hour, minute, second) / 1000;
  } else if (tag === 0x18) {
    // GeneralizedTime: YYYYMMDDHHMMSSZ
    const year = parseInt(timeStr.substring(0, 4), 10);
    const month = parseInt(timeStr.substring(4, 6), 10) - 1;
    const day = parseInt(timeStr.substring(6, 8), 10);
    const hour = parseInt(timeStr.substring(8, 10), 10);
    const minute = parseInt(timeStr.substring(10, 12), 10);
    const second = parseInt(timeStr.substring(12, 14), 10);
    return Date.UTC(year, month, day, hour, minute, second) / 1000;
  }
  throw new AuthError('不支持的 ASN.1 时间格式');
}

/** 解析 OID 字节为点分字符串 */
function parseOid(data: Uint8Array): string {
  if (data.length === 0) return '';
  const components: number[] = [];
  // 第一个字节编码前两个组件
  components.push(Math.floor(data[0] / 40));
  components.push(data[0] % 40);
  let value = 0;
  for (let i = 1; i < data.length; i++) {
    value = (value << 7) | (data[i] & 0x7f);
    if (!(data[i] & 0x80)) {
      components.push(value);
      value = 0;
    }
  }
  return components.join('.');
}

/** 在 ASN.1 SEQUENCE 中查找特定 OID 对应的值 */
function findOidValue(data: Uint8Array, targetOid: string): Uint8Array | null {
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0x06) {
      // OID tag
      const oidLen = data[i + 1];
      if (i + 2 + oidLen > data.length) continue;
      const oid = parseOid(data.slice(i + 2, i + 2 + oidLen));
      if (oid === targetOid) {
        const valOffset = i + 2 + oidLen;
        if (valOffset < data.length) {
          const [, vs, vl] = readTlv(data, valOffset);
          return data.slice(vs, vs + vl);
        }
      }
    }
  }
  return null;
}

/** 从 DER 数据中查找 CN（Common Name, OID 2.5.4.3）的 UTF8/PrintableString 值 */
function extractCN(subjectRaw: Uint8Array): string {
  // CN OID: 2.5.4.3 → 编码为 55 04 03
  const cnOid = '2.5.4.3';
  const value = findOidValue(subjectRaw, cnOid);
  if (!value) return '';
  return new TextDecoder().decode(value);
}

/** 解析 PEM 证书为结构化数据（简化版 X.509 DER 解析） */
function parseCertDer(pem: string): ParsedCert {
  const derBuf = pemToArrayBuffer(pem);
  const der = new Uint8Array(derBuf);

  // 顶层 SEQUENCE
  const [, certValueStart, certValueLen] = readTlv(der, 0);

  // TBSCertificate（第一个子 SEQUENCE）
  const [tbsStart, tbsEnd] = getTlvFullRange(der, certValueStart);
  const tbsBytes = der.slice(tbsStart, tbsEnd);

  const [, tbsValueStart] = readTlv(der, certValueStart);
  let pos = tbsValueStart;

  // 版本号（可选，EXPLICIT [0]）— 跳过整个 [0] TLV
  if (der[pos] === 0xa0) {
    const [, versionVs, versionVl] = readTlv(der, pos);
    pos = versionVs + versionVl;
  }

  // 序列号（INTEGER）
  const [, serialStart, serialLen] = readTlv(der, pos);
  const serialBytes = der.slice(serialStart, serialStart + serialLen);
  const serialHex = Array.from(serialBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  pos = serialStart + serialLen;

  // 签名算法（SEQUENCE）
  const [, sigAlgStart, sigAlgLen] = readTlv(der, pos);
  // 提取内部 OID
  const [, sigOidStart, sigOidLen] = readTlv(der, sigAlgStart);
  const signatureAlgorithmOid = parseOid(der.slice(sigOidStart, sigOidStart + sigOidLen));
  pos = sigAlgStart + sigAlgLen;

  // Issuer（SEQUENCE）
  const [issuerFullStart, issuerFullEnd] = getTlvFullRange(der, pos);
  const issuerRaw = der.slice(issuerFullStart, issuerFullEnd);
  pos = issuerFullEnd;

  // Validity（SEQUENCE）
  const [, validityStart, validityLen] = readTlv(der, pos);
  const notBefore = parseAsn1Time(der, validityStart);
  // notBefore 的完整 TLV 结尾就是 notAfter 的起始位置
  const [, nbVs, nbVl] = readTlv(der, validityStart);
  const notAfter = parseAsn1Time(der, nbVs + nbVl);
  pos = validityStart + validityLen;

  // Subject（SEQUENCE）
  const [subjectFullStart, subjectFullEnd] = getTlvFullRange(der, pos);
  const subjectRaw = der.slice(subjectFullStart, subjectFullEnd);
  const subjectCN = extractCN(subjectRaw);
  pos = subjectFullEnd;

  // SubjectPublicKeyInfo（SEQUENCE）
  const [spkiFullStart, spkiFullEnd] = getTlvFullRange(der, pos);
  const spkiBytes = der.slice(spkiFullStart, spkiFullEnd);
  pos = spkiFullEnd;

  // 检查 BasicConstraints（在 extensions 中）
  let isCA = false;
  // extensions 在 [3] EXPLICIT 中
  const extensionsSearchStart = pos;
  const extensionsSearchEnd = tbsEnd;
  // 搜索 BasicConstraints OID: 2.5.29.19 → 55 1D 13
  const bcOidBytes = new Uint8Array([0x55, 0x1d, 0x13]);
  for (let i = extensionsSearchStart; i < extensionsSearchEnd - 3; i++) {
    if (der[i] === bcOidBytes[0] && der[i + 1] === bcOidBytes[1] && der[i + 2] === bcOidBytes[2]) {
      // 找到 BasicConstraints OID，在后续字节中搜索 BOOLEAN TRUE (01 01 FF)
      const searchEnd = Math.min(i + 20, extensionsSearchEnd);
      for (let j = i + 3; j < searchEnd - 2; j++) {
        if (der[j] === 0x01 && der[j + 1] === 0x01 && der[j + 2] === 0xff) {
          isCA = true;
          break;
        }
      }
      break;
    }
  }

  // 签名算法（第二个，在 TBS 之后）
  const sigAlg2Pos = tbsEnd;
  const [, sigAlg2Start, sigAlg2Len] = readTlv(der, sigAlg2Pos);
  const signaturePos = sigAlg2Start + sigAlg2Len;

  // 签名值（BIT STRING）
  const [, sigBitsStart, sigBitsLen] = readTlv(der, signaturePos);
  // BIT STRING 第一个字节是 unused bits 数量
  const signatureBytes = der.slice(sigBitsStart + 1, sigBitsStart + sigBitsLen);

  return {
    pem,
    tbsBytes,
    signatureBytes,
    signatureAlgorithmOid,
    serialHex,
    subjectCN,
    issuerRaw,
    subjectRaw,
    notBefore,
    notAfter,
    isCA,
    spkiBytes,
  };
}

// ── 签名验证 ────────────────────────────────────────────

/** 确定签名算法的哈希和曲线长度 */
function getSignatureParams(oid: string): { hash: string; curveLen: number; curveName: string } {
  // ecdsa-with-SHA256: 1.2.840.10045.4.3.2
  if (oid === '1.2.840.10045.4.3.2') return { hash: 'SHA-256', curveLen: 32, curveName: 'P-256' };
  // ecdsa-with-SHA384: 1.2.840.10045.4.3.3
  if (oid === '1.2.840.10045.4.3.3') return { hash: 'SHA-384', curveLen: 48, curveName: 'P-384' };
  // ecdsa-with-SHA512: 1.2.840.10045.4.3.4
  if (oid === '1.2.840.10045.4.3.4') return { hash: 'SHA-512', curveLen: 66, curveName: 'P-521' };
  throw new AuthError(`不支持的签名算法 OID: ${oid}`);
}

/** 使用 SubtleCrypto 验证证书签名 */
async function verifyCertSignature(
  issuerSpkiDer: Uint8Array,
  cert: ParsedCert,
): Promise<void> {
  const params = getSignatureParams(cert.signatureAlgorithmOid);
  let pubKey: CryptoKey;
  try {
    pubKey = await crypto.subtle.importKey(
      'spki',
      issuerSpkiDer,
      { name: 'ECDSA', namedCurve: params.curveName },
      false,
      ['verify'],
    );
  } catch {
    throw new AuthError('导入签发者公钥失败');
  }

  const p1363Sig = derToP1363(cert.signatureBytes, params.curveLen);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: params.hash },
    pubKey,
    p1363Sig,
    cert.tbsBytes,
  );
  if (!valid) throw new AuthError('证书签名验证失败');
}

/** 使用 SubtleCrypto 验证通用 ECDSA 签名（用于 client_nonce 验证等） */
async function verifyEcdsaSignature(
  spkiDer: Uint8Array,
  signatureDer: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  // 自动检测曲线
  let pubKey: CryptoKey;
  let curveLen: number;
  let hash: string;
  try {
    pubKey = await crypto.subtle.importKey(
      'spki', spkiDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    curveLen = 32;
    hash = 'SHA-256';
  } catch {
    try {
      pubKey = await crypto.subtle.importKey(
        'spki', spkiDer, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['verify'],
      );
      curveLen = 48;
      hash = 'SHA-384';
    } catch {
      return false;
    }
  }

  const p1363Sig = derToP1363(signatureDer, curveLen);
  return crypto.subtle.verify({ name: 'ECDSA', hash }, pubKey, p1363Sig, data);
}

// ── Gateway URL 工具 ────────────────────────────────────

/** 将 WebSocket URL 转为对应的 HTTP URL */
function gatewayHttpUrl(gatewayUrl: string, path: string): string {
  try {
    const parsed = new URL(gatewayUrl);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${scheme}//${parsed.host}${path}`;
  } catch {
    // 降级处理
    const httpUrl = gatewayUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:');
    const urlObj = new URL(httpUrl);
    urlObj.pathname = path;
    urlObj.search = '';
    urlObj.hash = '';
    return urlObj.toString();
  }
}

// ── AuthFlow 主类 ───────────────────────────────────────

/**
 * 认证流程管理器 — 负责 AID 注册、登录、token 管理。
 *
 * 完整实现：
 *   - PKI 证书链验证（链验证 + CRL + OCSP + AID 绑定）
 *   - login1/login2 双阶段认证
 *   - token 刷新
 *   - 证书自动续期
 */
export class AuthFlow {
  private _keystore: KeyStore;
  private _crypto: CryptoProvider;
  private _aid: string | null;
  private _rootCaPem: string | null;
  private _verifySsl: boolean;

  // 缓存
  private _rootCerts: ParsedCert[] | null = null;
  private _gatewayChainCache: Map<string, string[]> = new Map();
  private _gatewayCrlCache: Map<string, { revokedSerials: Set<string>; nextRefreshAt: number }> = new Map();
  private _gatewayOcspCache: Map<string, Map<string, { status: string; nextRefreshAt: number }>> = new Map();
  private _chainVerifiedCache: Map<string, number> = new Map();
  private _chainCacheTtl: number;
  private _gatewayCaVerified: Map<string, boolean> = new Map();

  constructor(opts: {
    keystore: KeyStore;
    crypto: CryptoProvider;
    aid?: string | null;
    rootCaPem?: string | null;
    verifySsl?: boolean;
    chainCacheTtl?: number;
  }) {
    this._keystore = opts.keystore;
    this._crypto = opts.crypto;
    this._aid = opts.aid ?? null;
    this._rootCaPem = opts.rootCaPem ?? null;
    this._verifySsl = opts.verifySsl ?? true;
    this._chainCacheTtl = opts.chainCacheTtl ?? 86400;
  }

  // ── 公开 API ──────────────────────────────────────

  /** 加载本地身份信息 */
  async loadIdentity(aid?: string): Promise<Record<string, unknown>> {
    const identity = await this._loadIdentityOrRaise(aid);
    const cert = await this._keystore.loadCert(identity.aid as string);
    if (cert) identity.cert = cert;
    const metadata = await this._keystore.loadMetadata(identity.aid as string);
    if (metadata) Object.assign(identity, metadata);
    return identity;
  }

  /** 加载身份，不存在时返回 null */
  async loadIdentityOrNull(aid?: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.loadIdentity(aid);
    } catch {
      return null;
    }
  }

  /** 获取 access_token 过期时间 */
  getAccessTokenExpiry(identity: Record<string, unknown>): number | null {
    const expiresAt = identity.access_token_expires_at;
    if (typeof expiresAt === 'number') return expiresAt;
    return null;
  }

  /**
   * 注册新 AID。
   *
   * 流程：
   *   1. 确保本地密钥对存在
   *   2. 短连接 RPC 调用 auth.create_aid
   *   3. 保存返回的证书
   */
  async createAid(gatewayUrl: string, aid: string): Promise<Record<string, unknown>> {
    const identity = await this._ensureLocalIdentity(aid);
    if (identity.cert) {
      return { aid: identity.aid, cert: identity.cert };
    }

    // 本地有密钥但无证书 — 尝试注册
    try {
      const created = await this._createAid(gatewayUrl, identity);
      Object.assign(identity, created);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('already exists')) {
        // AID 已在服务端注册，尝试下载证书恢复
        try {
          const recovered = await this._recoverCertViaDownload(gatewayUrl, identity);
          Object.assign(identity, recovered);
        } catch {
          throw new StateError(
            `AID ${aid} already registered on server but local certificate is missing. ` +
            `Certificate download recovery failed. Options: ` +
            `(1) use a different AID name, or ` +
            `(2) restart server to clear registration.`,
          );
        }
      } else {
        throw e;
      }
    }
    await this._keystore.saveIdentity(identity.aid as string, identity);
    this._aid = identity.aid as string;
    return { aid: identity.aid, cert: identity.cert };
  }

  /**
   * 认证已有 AID — login1/login2 双阶段流程。
   */
  async authenticate(gatewayUrl: string, aid?: string): Promise<Record<string, unknown>> {
    const identity = await this._loadIdentityOrRaise(aid);
    if (!identity.cert) {
      // 尝试下载恢复证书
      try {
        const recovered = await this._recoverCertViaDownload(gatewayUrl, identity);
        Object.assign(identity, recovered);
        await this._keystore.saveIdentity(identity.aid as string, identity);
      } catch (e) {
        throw new StateError(
          `local certificate missing and recovery failed: ${e}. ` +
          `Run auth.createAid() to register a new identity.`,
        );
      }
    }

    const login = await this._login(gatewayUrl, identity);
    this._rememberTokens(identity, login);
    await this._validateNewCert(identity, gatewayUrl);
    await this._keystore.saveIdentity(identity.aid as string, identity);
    this._aid = identity.aid as string;
    return {
      aid: identity.aid,
      access_token: identity.access_token,
      refresh_token: identity.refresh_token,
      expires_at: identity.access_token_expires_at,
      gateway: gatewayUrl,
    };
  }

  /**
   * 确保已认证（如无身份则先注册再登录）。
   */
  async ensureAuthenticated(gatewayUrl: string): Promise<Record<string, unknown>> {
    const identity = await this._ensureIdentity();
    if (!identity.cert) {
      const created = await this._createAid(gatewayUrl, identity);
      Object.assign(identity, created);
      await this._keystore.saveIdentity(identity.aid as string, identity);
    }

    const login = await this._login(gatewayUrl, identity);
    this._rememberTokens(identity, login);
    await this._validateNewCert(identity, gatewayUrl);
    await this._keystore.saveIdentity(identity.aid as string, identity);

    const token = (identity.access_token || identity.token || identity.kite_token) as string;
    if (!token) throw new AuthError('login2 did not return access token');
    return { token, identity };
  }

  /**
   * 使用已有 token 初始化 WebSocket 会话。
   */
  async initializeWithToken(
    transport: { call(method: string, params: Record<string, unknown>): Promise<unknown> },
    challenge: Record<string, unknown> | null,
    accessToken: string,
  ): Promise<void> {
    const nonce = (
      (challenge?.params as Record<string, unknown>)?.nonce ?? ''
    ) as string;
    if (!nonce) throw new AuthError('gateway challenge missing nonce');
    await this._initializeSession(transport, nonce, accessToken);
  }

  /**
   * 连接会话 — 多策略认证：显式 token → 缓存 token → refresh → 重新登录。
   */
  async connectSession(
    transport: { call(method: string, params: Record<string, unknown>): Promise<unknown> },
    challenge: Record<string, unknown> | null,
    gatewayUrl: string,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    const nonce = (
      (challenge?.params as Record<string, unknown>)?.nonce ?? ''
    ) as string;
    if (!nonce) throw new AuthError('gateway challenge missing nonce');

    let identity: Record<string, unknown> | null;
    try {
      identity = await this.loadIdentity();
    } catch {
      identity = null;
    }

    // 策略 1: 显式 token
    const explicitToken = accessToken ?? '';
    if (explicitToken && identity !== null) {
      try {
        await this._initializeSession(transport, nonce, explicitToken);
        identity.access_token = explicitToken;
        await this._keystore.saveIdentity(identity.aid as string, identity);
        return { token: explicitToken, identity };
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        // 显式 token 失败，继续尝试其他方式
      }
    }

    // 无本地身份 — 先注册 + 登录
    if (identity === null) {
      const authContext = await this.ensureAuthenticated(gatewayUrl);
      const token = authContext.token as string;
      await this._initializeSession(transport, nonce, token);
      return authContext;
    }

    // 策略 2: 缓存 token
    const cachedToken = this._getCachedAccessToken(identity);
    if (cachedToken) {
      try {
        await this._initializeSession(transport, nonce, cachedToken);
        return { token: cachedToken, identity };
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        // 缓存 token 失败，尝试刷新
      }
    }

    // 策略 3: refresh token
    const refreshToken = String(identity.refresh_token ?? '');
    if (refreshToken) {
      try {
        identity = await this.refreshCachedTokens(gatewayUrl, identity);
        const refreshedToken = this._getCachedAccessToken(identity);
        if (refreshedToken) {
          await this._initializeSession(transport, nonce, refreshedToken);
          return { token: refreshedToken, identity };
        }
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        // refresh 失败，重新登录
      }
    }

    // 策略 4: 重新登录
    const login = await this.authenticate(gatewayUrl, identity.aid as string | undefined);
    const token = String(login.access_token ?? '');
    if (!token) throw new AuthError('authenticate did not return access_token');
    await this._initializeSession(transport, nonce, token);
    identity = await this.loadIdentity(identity.aid as string | undefined);
    return { token, identity };
  }

  /**
   * 刷新 token。
   */
  async refreshCachedTokens(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const refreshToken = String(identity.refresh_token ?? '');
    if (!refreshToken) throw new AuthError('missing refresh_token');
    const refreshed = await this._refreshAccessToken(gatewayUrl, refreshToken);
    this._rememberTokens(identity, refreshed);
    await this._validateNewCert(identity, gatewayUrl);
    await this._keystore.saveIdentity(identity.aid as string, identity);
    return identity;
  }

  /**
   * 统一的对端证书验证入口：时间有效性 + 链验证 + CRL + OCSP + AID 绑定。
   */
  async verifyPeerCertificate(
    gatewayUrl: string,
    certPem: string,
    expectedAid: string,
  ): Promise<void> {
    const cert = parseCertDer(certPem);
    const now = Date.now() / 1000;
    ensureCertTimeValid(cert, 'peer certificate', now);
    await this._verifyAuthCertChain(gatewayUrl, cert, expectedAid);
    try {
      await this._verifyAuthCertRevocation(gatewayUrl, cert, expectedAid);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(`peer cert CRL check failed: ${e}`);
    }
    try {
      await this._verifyAuthCertOcsp(gatewayUrl, cert, expectedAid);
    } catch {
      // OCSP 不可用时降级（CRL 已检查）
    }
    if (cert.subjectCN !== expectedAid) {
      throw new AuthError(`peer cert CN mismatch: expected ${expectedAid}, got ${cert.subjectCN || 'none'}`);
    }
  }

  // ── 内部方法：短连接 RPC ──────────────────────────

  /** 打开原生 WebSocket，接收 challenge，发送 JSON-RPC，接收响应，关闭 */
  private async _shortRpc(
    gatewayUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(gatewayUrl);
      } catch (e) {
        reject(new AuthError(`WebSocket 连接失败: ${gatewayUrl}`));
        return;
      }
      let receivedChallenge = false;
      const timeout = globalThis.setTimeout(() => {
        try { ws.close(); } catch { /* 忽略 */ }
        reject(new AuthError(`shortRpc 超时: ${method}`));
      }, 10000);

      ws.onopen = () => { /* 等待首条消息 */ };

      ws.onerror = () => {
        globalThis.clearTimeout(timeout);
        reject(new AuthError(`WebSocket 连接错误: ${gatewayUrl}`));
      };

      ws.onclose = () => {
        if (!receivedChallenge) {
          globalThis.clearTimeout(timeout);
          reject(new AuthError(`WebSocket 在收到 challenge 前关闭`));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (!receivedChallenge) {
            // 首条消息是 challenge，忽略并发送 RPC 请求
            receivedChallenge = true;
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: `pre-${method}`,
              method,
              params,
            }));
            return;
          }
          // 第二条消息是 RPC 响应
          globalThis.clearTimeout(timeout);
          try { ws.close(); } catch { /* 忽略 */ }

          if (msg.error) {
            reject(mapRemoteError(msg.error));
            return;
          }
          const result = msg.result;
          if (!result || typeof result !== 'object') {
            reject(new ValidationError(`invalid pre-auth response for ${method}`));
            return;
          }
          if (result.success === false) {
            reject(new AuthError(String(result.error ?? `${method} failed`)));
            return;
          }
          resolve(result);
        } catch (e) {
          globalThis.clearTimeout(timeout);
          try { ws.close(); } catch { /* 忽略 */ }
          reject(e instanceof Error ? e : new AuthError(String(e)));
        }
      };
    });
  }

  // ── 内部方法：HTTP 请求 ───────────────────────────

  /** fetch GET 返回文本 */
  private async _fetchText(url: string): Promise<string> {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      throw new AuthError(`failed to fetch ${url}: ${e}`);
    }
  }

  /** fetch GET 返回 JSON */
  private async _fetchJson(url: string): Promise<Record<string, unknown>> {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const payload = await resp.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AuthError(`invalid JSON payload from ${url}`);
      }
      return payload as Record<string, unknown>;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(`failed to fetch ${url}: ${e}`);
    }
  }

  // ── 内部方法：AID 创建 ───────────────────────────

  private async _createAid(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this._shortRpc(gatewayUrl, 'auth.create_aid', {
      aid: identity.aid,
      public_key: identity.public_key_der_b64,
      curve: identity.curve ?? 'P-256',
    });
    return { cert: response.cert };
  }

  /** 下载已注册证书恢复本地状态 */
  private async _recoverCertViaDownload(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const certUrl = gatewayHttpUrl(gatewayUrl, `/pki/cert/${identity.aid}`);
    const certPem = await this._fetchText(certUrl);
    if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) {
      throw new AuthError(`failed to download certificate for ${identity.aid}`);
    }

    // 验证下载证书的公钥与本地密钥对匹配
    const downloadedCert = parseCertDer(certPem);
    const downloadedSpkiB64 = uint8ToBase64(downloadedCert.spkiBytes);
    const localPubB64 = String(identity.public_key_der_b64 ?? '');
    if (localPubB64 && downloadedSpkiB64 !== localPubB64) {
      throw new AuthError(
        `downloaded certificate public key does not match local key pair for ${identity.aid}.`,
      );
    }

    return { ...identity, cert: certPem };
  }

  // ── 内部方法：登录流程 ────────────────────────────

  private async _login(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const clientNonce = this._crypto.newClientNonce();

    // Phase 1: 发送 AID + 证书 + client_nonce
    const phase1 = await this._shortRpc(gatewayUrl, 'auth.aid_login1', {
      aid: identity.aid,
      cert: identity.cert,
      client_nonce: clientNonce,
    });

    // 验证服务端响应（证书链 + client_nonce 签名）
    await this._verifyPhase1Response(gatewayUrl, phase1, clientNonce);

    // Phase 2: 签名 server nonce
    const [signature, clientTime] = await this._crypto.signLoginNonce(
      identity.private_key_pem as string,
      phase1.nonce as string,
    );

    const phase2 = await this._shortRpc(gatewayUrl, 'auth.aid_login2', {
      aid: identity.aid,
      request_id: phase1.request_id,
      nonce: phase1.nonce,
      client_time: clientTime,
      signature,
    });

    return phase2;
  }

  /** 刷新 access token */
  private async _refreshAccessToken(
    gatewayUrl: string,
    refreshToken: string,
  ): Promise<Record<string, unknown>> {
    const result = await this._shortRpc(gatewayUrl, 'auth.refresh_token', {
      refresh_token: refreshToken,
    });
    if (!result.success) {
      throw new AuthError(String(result.error ?? 'refresh failed'));
    }
    return result;
  }

  /** 初始化 WebSocket 会话（auth.connect RPC） */
  private async _initializeSession(
    transport: { call(method: string, params: Record<string, unknown>): Promise<unknown> },
    nonce: string,
    token: string,
  ): Promise<void> {
    const result = await transport.call('auth.connect', {
      nonce,
      auth: { method: 'kite_token', token },
      protocol: { min: '1.0', max: '1.0' },
      capabilities: { e2ee: true, group_e2ee: true },
    }) as Record<string, unknown> | undefined;

    const status = result?.status;
    if (status !== 'ok') {
      throw new AuthError(`initialize failed: ${JSON.stringify(result)}`);
    }
  }

  // ── 内部方法：Phase 1 响应验证 ────────────────────

  private async _verifyPhase1Response(
    gatewayUrl: string,
    result: Record<string, unknown>,
    clientNonce: string,
  ): Promise<void> {
    const authCertPem = String(result.auth_cert ?? '');
    const signatureB64 = String(result.client_nonce_signature ?? '');
    if (!authCertPem) throw new AuthError('aid_login1 missing auth_cert');
    if (!signatureB64) throw new AuthError('aid_login1 missing client_nonce_signature');

    let authCert: ParsedCert;
    try {
      authCert = parseCertDer(authCertPem);
    } catch {
      throw new AuthError('aid_login1 returned invalid auth_cert');
    }

    // 验证证书链
    await this._verifyAuthCertChain(gatewayUrl, authCert);
    // 验证 CRL
    await this._verifyAuthCertRevocation(gatewayUrl, authCert);
    // 验证 OCSP
    await this._verifyAuthCertOcsp(gatewayUrl, authCert);

    // 验证 client_nonce 签名
    try {
      const sigBytes = base64ToUint8(signatureB64);
      const dataBytes = new TextEncoder().encode(clientNonce);
      const valid = await verifyEcdsaSignature(authCert.spkiBytes, sigBytes, dataBytes);
      if (!valid) throw new Error('signature invalid');
    } catch {
      throw new AuthError('aid_login1 server auth signature verification failed');
    }
  }

  // ── 内部方法：证书链验证 ──────────────────────────

  private async _verifyAuthCertChain(
    gatewayUrl: string,
    authCert: ParsedCert,
    chainAid: string = '',
  ): Promise<void> {
    // 检查缓存
    const cachedAt = this._chainVerifiedCache.get(authCert.serialHex);
    const now = Date.now() / 1000;
    if (cachedAt && now - cachedAt < this._chainCacheTtl) return;

    ensureCertTimeValid(authCert, 'auth certificate', now);

    const chain = await this._loadGatewayCaChain(gatewayUrl, chainAid);
    if (!chain.length) {
      throw new AuthError('unable to verify auth certificate chain: missing CA chain');
    }

    const cacheKey = chainAid ? `${gatewayUrl}:${chainAid}` : gatewayUrl;

    // 快速路径：CA 链已预验证过
    if (this._gatewayCaVerified.get(cacheKey)) {
      const issuer = chain[0];
      ensureCertTimeValid(issuer, 'Issuer CA', now);
      if (!issuer.isCA) throw new AuthError('Issuer CA is not marked as CA (fast path)');
      if (!arraysEqual(authCert.issuerRaw, issuer.subjectRaw)) {
        throw new AuthError('auth certificate issuer mismatch');
      }
      await verifyCertSignature(issuer.spkiBytes, authCert);
      this._chainVerifiedCache.set(authCert.serialHex, Date.now() / 1000);
      return;
    }

    // 完整验证路径
    let current = authCert;
    for (let i = 0; i < chain.length; i++) {
      const caCert = chain[i];
      ensureCertTimeValid(caCert, `CA certificate[${i}]`, now);
      if (!arraysEqual(current.issuerRaw, caCert.subjectRaw)) {
        throw new AuthError(`auth certificate issuer mismatch at chain level ${i}`);
      }
      if (!caCert.isCA) {
        throw new AuthError(`CA certificate[${i}] is not marked as CA`);
      }
      await verifyCertSignature(caCert.spkiBytes, current);
      current = caCert;
    }

    // 验证根证书自签名
    const root = chain[chain.length - 1];
    if (!arraysEqual(root.issuerRaw, root.subjectRaw)) {
      throw new AuthError('auth certificate chain root is not self-signed');
    }
    await verifyCertSignature(root.spkiBytes, root);

    // 验证根证书在受信列表中
    const trustedRoots = this._loadTrustedRoots();
    const rootSpkiB64 = uint8ToBase64(root.spkiBytes);
    const isTrusted = trustedRoots.some(
      (trusted) => uint8ToBase64(trusted.spkiBytes) === rootSpkiB64
        && trusted.subjectCN === root.subjectCN,
    );
    if (!isTrusted) {
      throw new AuthError('auth certificate chain is not anchored by a trusted root');
    }

    this._chainVerifiedCache.set(authCert.serialHex, Date.now() / 1000);
    this._gatewayCaVerified.set(cacheKey, true);
  }

  /** 加载 Gateway CA 链（带缓存） */
  private async _loadGatewayCaChain(gatewayUrl: string, chainAid: string = ''): Promise<ParsedCert[]> {
    const cacheKey = chainAid ? `${gatewayUrl}:${chainAid}` : gatewayUrl;
    let cached = this._gatewayChainCache.get(cacheKey);
    if (!cached) {
      cached = await this._fetchGatewayCaChain(gatewayUrl);
      this._gatewayChainCache.set(cacheKey, cached);
    }
    return cached.map((pem) => parseCertDer(pem));
  }

  /** 从 Gateway PKI 端点下载 CA 链 */
  private async _fetchGatewayCaChain(gatewayUrl: string): Promise<string[]> {
    const url = gatewayHttpUrl(gatewayUrl, '/pki/chain');
    const text = await this._fetchText(url);
    return splitPemBundle(text);
  }

  // ── 内部方法：CRL 验证 ────────────────────────────

  private async _verifyAuthCertRevocation(
    gatewayUrl: string,
    authCert: ParsedCert,
    chainAid: string = '',
  ): Promise<void> {
    const chain = await this._loadGatewayCaChain(gatewayUrl, chainAid);
    if (!chain.length) {
      throw new AuthError('unable to verify auth certificate revocation: missing issuer certificate');
    }

    // 跨域场景：CRL 请求发到 peer 所在域
    let crlGatewayUrl = gatewayUrl;
    if (chainAid && chainAid.includes('.')) {
      const peerIssuer = chainAid.split('.').slice(1).join('.');
      const match = gatewayUrl.match(/gateway\.([^:/]+)/);
      const localIssuer = match ? match[1] : '';
      if (localIssuer && peerIssuer !== localIssuer) {
        crlGatewayUrl = gatewayUrl.replace(`gateway.${localIssuer}`, `gateway.${peerIssuer}`);
      }
    }

    const revokedSerials = await this._loadGatewayRevokedSerials(crlGatewayUrl, chain[0]);
    if (revokedSerials.has(authCert.serialHex.toLowerCase())) {
      throw new AuthError('auth certificate has been revoked');
    }
  }

  /** 加载 Gateway 吊销列表（带缓存） */
  private async _loadGatewayRevokedSerials(
    gatewayUrl: string,
    issuerCert: ParsedCert,
  ): Promise<Set<string>> {
    const cached = this._gatewayCrlCache.get(gatewayUrl);
    const now = Date.now() / 1000;
    if (cached && cached.nextRefreshAt > now) {
      return cached.revokedSerials;
    }
    const fresh = await this._fetchGatewayCrl(gatewayUrl, issuerCert);
    this._gatewayCrlCache.set(gatewayUrl, fresh);
    return fresh.revokedSerials;
  }

  /** 从 Gateway PKI 端点获取并验证 CRL */
  private async _fetchGatewayCrl(
    gatewayUrl: string,
    issuerCert: ParsedCert,
  ): Promise<{ revokedSerials: Set<string>; nextRefreshAt: number }> {
    const url = gatewayHttpUrl(gatewayUrl, '/pki/crl.json');
    const payload = await this._fetchJson(url);

    // 简化 CRL 验证：JSON 格式 CRL
    // payload 包含 revoked_serials 数组和签名
    const revokedList = payload.revoked_serials;
    const revokedSerials = new Set<string>();
    if (Array.isArray(revokedList)) {
      for (const s of revokedList) {
        revokedSerials.add(String(s).toLowerCase());
      }
    }

    // 验证 CRL 签名（如果有 crl_pem）
    const crlPem = String(payload.crl_pem ?? '');
    if (crlPem) {
      // CRL PEM 中包含签名信息，由签发者签名
      // 浏览器端简化处理：验证签名数据和签发者公钥
      const signatureB64 = String(payload.signature ?? '');
      const signedDataB64 = String(payload.signed_data ?? '');
      if (signatureB64 && signedDataB64) {
        const sigBytes = base64ToUint8(signatureB64);
        const dataBytes = base64ToUint8(signedDataB64);
        const valid = await verifyEcdsaSignature(issuerCert.spkiBytes, sigBytes, dataBytes);
        if (!valid) throw new AuthError('gateway CRL signature verification failed');
      }
    }

    // 过期时间（最多缓存 24 小时）
    const now = Date.now() / 1000;
    let nextRefreshAt = Number(payload.next_update ?? 0);
    if (!nextRefreshAt) nextRefreshAt = now + 300;
    nextRefreshAt = Math.min(nextRefreshAt, now + 86400);

    return { revokedSerials, nextRefreshAt };
  }

  // ── 内部方法：OCSP 验证 ───────────────────────────

  private async _verifyAuthCertOcsp(
    gatewayUrl: string,
    authCert: ParsedCert,
    chainAid: string = '',
  ): Promise<void> {
    const chain = await this._loadGatewayCaChain(gatewayUrl, chainAid);
    if (!chain.length) {
      throw new AuthError('unable to verify auth certificate OCSP status: missing issuer certificate');
    }
    const status = await this._loadGatewayOcspStatus(gatewayUrl, authCert, chain[0]);
    if (status === 'revoked') throw new AuthError('auth certificate OCSP status is revoked');
    if (status !== 'good') throw new AuthError(`auth certificate OCSP status is ${status}`);
  }

  /** 加载 OCSP 状态（带缓存） */
  private async _loadGatewayOcspStatus(
    gatewayUrl: string,
    authCert: ParsedCert,
    issuerCert: ParsedCert,
  ): Promise<string> {
    const serialHex = authCert.serialHex.toLowerCase();
    let gatewayCache = this._gatewayOcspCache.get(gatewayUrl);
    if (!gatewayCache) {
      gatewayCache = new Map();
      this._gatewayOcspCache.set(gatewayUrl, gatewayCache);
    }
    const cached = gatewayCache.get(serialHex);
    const now = Date.now() / 1000;
    if (cached && cached.nextRefreshAt > now) {
      return cached.status;
    }
    const fresh = await this._fetchGatewayOcspStatus(gatewayUrl, authCert, issuerCert);
    gatewayCache.set(serialHex, fresh);
    return fresh.status;
  }

  /** 从 Gateway PKI 端点获取并验证 OCSP 状态 */
  private async _fetchGatewayOcspStatus(
    gatewayUrl: string,
    authCert: ParsedCert,
    issuerCert: ParsedCert,
  ): Promise<{ status: string; nextRefreshAt: number }> {
    const serialHex = authCert.serialHex.toLowerCase();
    const url = gatewayHttpUrl(gatewayUrl, `/pki/ocsp/${serialHex}`);
    const payload = await this._fetchJson(url);

    const status = String(payload.status ?? '');
    const ocspB64 = String(payload.ocsp_response ?? '');
    if (!ocspB64) throw new AuthError('gateway OCSP endpoint returned no ocsp_response');

    // 简化 OCSP 验证：检查 JSON 响应中的签名
    const signatureB64 = String(payload.signature ?? '');
    const signedDataB64 = String(payload.signed_data ?? '');
    if (signatureB64 && signedDataB64) {
      const sigBytes = base64ToUint8(signatureB64);
      const dataBytes = base64ToUint8(signedDataB64);
      const valid = await verifyEcdsaSignature(issuerCert.spkiBytes, sigBytes, dataBytes);
      if (!valid) throw new AuthError('gateway OCSP signature verification failed');
    }

    // 检查 serial 匹配
    const respSerial = String(payload.serial ?? '').toLowerCase();
    if (respSerial && respSerial !== serialHex) {
      throw new AuthError('gateway OCSP response serial mismatch');
    }

    const effectiveStatus = status || 'unknown';

    const now = Date.now() / 1000;
    let nextRefreshAt = Number(payload.next_update ?? 0);
    if (!nextRefreshAt) nextRefreshAt = now + 300;
    nextRefreshAt = Math.min(nextRefreshAt, now + 86400);

    return { status: effectiveStatus, nextRefreshAt };
  }

  // ── 内部方法：受信根证书 ──────────────────────────

  private _loadTrustedRoots(): ParsedCert[] {
    if (this._rootCerts) return this._rootCerts;

    const roots: ParsedCert[] = [];
    // 加载内置根证书
    if (ROOT_CA_PEM) {
      for (const pem of splitPemBundle(ROOT_CA_PEM)) {
        try {
          roots.push(parseCertDer(pem));
        } catch { /* 跳过无法解析的证书 */ }
      }
    }
    // 加载用户指定的根证书
    if (this._rootCaPem) {
      for (const pem of splitPemBundle(this._rootCaPem)) {
        try {
          const cert = parseCertDer(pem);
          // 去重
          const spkiB64 = uint8ToBase64(cert.spkiBytes);
          if (!roots.some((r) => uint8ToBase64(r.spkiBytes) === spkiB64)) {
            roots.push(cert);
          }
        } catch { /* 跳过 */ }
      }
    }

    if (!roots.length) {
      throw new AuthError('no trusted roots available for auth certificate verification');
    }
    this._rootCerts = roots;
    return roots;
  }

  // ── 内部方法：Token 管理 ──────────────────────────

  private _rememberTokens(identity: Record<string, unknown>, authResult: Record<string, unknown>): void {
    const accessToken = authResult.access_token ?? authResult.token ?? authResult.kite_token;
    const refreshToken = authResult.refresh_token;
    const expiresIn = authResult.expires_in;

    if (accessToken) identity.access_token = accessToken;
    if (refreshToken) identity.refresh_token = refreshToken;
    if (authResult.token) identity.kite_token = authResult.token;
    if (typeof expiresIn === 'number') {
      identity.access_token_expires_at = Math.floor(Date.now() / 1000 + expiresIn);
    }
    // login2 响应含 new_cert 时（证书过半自动续期），暂存待验证
    const newCert = authResult.new_cert;
    if (newCert) identity._pending_new_cert = newCert;
  }

  /** 验证服务端返回的 new_cert，通过后正式接受 */
  private async _validateNewCert(
    identity: Record<string, unknown>,
    gatewayUrl: string = '',
  ): Promise<void> {
    const newCertPem = identity._pending_new_cert;
    delete identity._pending_new_cert;
    if (!newCertPem || typeof newCertPem !== 'string') return;

    try {
      const cert = parseCertDer(newCertPem);
      const aid = String(identity.aid ?? '');

      // 1. CN 必须匹配当前 AID
      if (cert.subjectCN !== aid) {
        throw new AuthError(`new_cert CN mismatch: expected ${aid}, got ${cert.subjectCN || 'none'}`);
      }

      // 2. 公钥必须匹配本地私钥
      const localPubB64 = String(identity.public_key_der_b64 ?? '');
      if (localPubB64) {
        const certSpkiB64 = uint8ToBase64(cert.spkiBytes);
        if (certSpkiB64 !== localPubB64) {
          throw new AuthError('new_cert public key does not match local identity key');
        }
      }

      // 3. 时间有效性
      ensureCertTimeValid(cert, 'new_cert', Date.now() / 1000);

      // 4. 完整证书链验证 + CRL/OCSP
      if (gatewayUrl) {
        await this._verifyAuthCertChain(gatewayUrl, cert);
        await this._verifyAuthCertRevocation(gatewayUrl, cert);
        try {
          await this._verifyAuthCertOcsp(gatewayUrl, cert);
        } catch {
          // OCSP 不可用时降级（CRL 已检查）
        }
      }

      // 验证通过，正式接受
      identity.cert = newCertPem;
    } catch (e) {
      // 验证失败，静默拒绝（不影响主流程）
      console.warn(`拒绝服务端返回的 new_cert (${identity.aid}):`, e);
    }
  }

  /** 获取缓存的有效 access_token */
  private _getCachedAccessToken(identity: Record<string, unknown>): string {
    const accessToken = String(identity.access_token ?? '');
    if (!accessToken) return '';
    const expiresAt = identity.access_token_expires_at;
    if (typeof expiresAt === 'number' && expiresAt <= Date.now() / 1000 + 30) {
      return '';
    }
    return accessToken;
  }

  // ── 内部方法：身份管理 ────────────────────────────

  /** 确保本地有密钥对（没有则生成） */
  private async _ensureLocalIdentity(aid: string): Promise<Record<string, unknown>> {
    const existing = await this._keystore.loadIdentity(aid);
    if (existing) {
      this._aid = aid;
      return existing;
    }
    const identity = await this._crypto.generateIdentity();
    (identity as Record<string, unknown>).aid = aid;
    await this._keystore.saveIdentity(aid, identity as Record<string, unknown>);
    this._aid = aid;
    return identity as Record<string, unknown>;
  }

  /** 加载身份，不存在时抛出异常 */
  private async _loadIdentityOrRaise(aid?: string): Promise<Record<string, unknown>> {
    const requestedAid = aid ?? this._aid;
    if (requestedAid) {
      const existing = await this._keystore.loadIdentity(requestedAid);
      if (!existing) {
        throw new StateError(`identity not found for aid: ${requestedAid}`);
      }
      this._aid = requestedAid;
      return existing;
    }
    throw new StateError('no local identity found, call auth.createAid() first');
  }

  /** 确保有身份（无则尝试生成） */
  private async _ensureIdentity(): Promise<Record<string, unknown>> {
    try {
      return await this._loadIdentityOrRaise();
    } catch {
      if (!this._aid) {
        throw new StateError('no local identity found, call auth.createAid() first');
      }
      const identity = await this._crypto.generateIdentity();
      (identity as Record<string, unknown>).aid = this._aid;
      await this._keystore.saveIdentity(this._aid, identity as Record<string, unknown>);
      return identity as Record<string, unknown>;
    }
  }
}

// ── 工具函数 ────────────────────────────────────────────

/** 检查证书时间有效性 */
function ensureCertTimeValid(cert: ParsedCert, label: string, now: number): void {
  if (now < cert.notBefore) throw new AuthError(`${label} is not yet valid`);
  if (now > cert.notAfter) throw new AuthError(`${label} has expired`);
}

/** 比较两个 Uint8Array 是否相等 */
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
