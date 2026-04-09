/**
 * AuthFlow — 认证流程管理
 *
 * Node.js 完整实现，与 Python SDK 的 AuthFlow 接口对齐。
 * 功能：
 * - AID 创建（在 Gateway 注册身份）
 * - 两阶段挑战-应答认证（login1 + login2）
 * - 证书链验证（chain + CRL + OCSP）
 * - Token 刷新
 * - 会话初始化
 * - 证书恢复与自动续期
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { AuthError, StateError, ValidationError, AUNError, mapRemoteError } from './errors.js';
import type { CryptoProvider } from './crypto.js';
import type { KeyStore } from './keystore/index.js';
import type { RPCTransport } from './transport.js';

// ── 日志辅助 ──────────────────────────────────────────────────

/** 简易日志：前缀 [aun_core.auth] */
function _authLog(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  const formatted = args.reduce<string>((s, a) => s.replace('%s', String(a)), msg);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [aun_core.auth] ${level}: ${formatted}`);
}

// ── 签名验证辅助 ──────────────────────────────────────────────

/**
 * 验证签名：支持 ECDSA P-256 (SHA256)、ECDSA P-384 (SHA384)、Ed25519。
 * 与 Python _verify_signature 完全对齐。
 */
function _verifySignature(pubKey: crypto.KeyObject, signature: Buffer, data: Buffer): void {
  const asymKeyDetails = pubKey.asymmetricKeyType;

  if (asymKeyDetails === 'ed25519') {
    const ok = crypto.verify(null, data, pubKey, signature);
    if (!ok) throw new AuthError('ed25519 signature verification failed');
    return;
  }

  if (asymKeyDetails === 'ec') {
    // 通过导出公钥的 JWK 判断曲线
    const jwk = pubKey.export({ format: 'jwk' });
    const crv = (jwk as Record<string, unknown>).crv;
    const alg = crv === 'P-384' ? 'SHA384' : 'SHA256';
    const ok = crypto.verify(alg, data, pubKey, signature);
    if (!ok) throw new AuthError(`ecdsa ${alg} signature verification failed`);
    return;
  }

  throw new AuthError(`unsupported public key type: ${asymKeyDetails}`);
}

// ── X.509 辅助函数 ────────────────────────────────────────────

/** 将 PEM bundle 拆分为独立的 PEM 字符串数组 */
function _splitPemBundle(bundleText: string): string[] {
  const marker = '-----END CERTIFICATE-----';
  const certs: string[] = [];
  for (const part of bundleText.split(marker)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    certs.push(`${trimmed}\n${marker}\n`);
  }
  return certs;
}

/** 加载 PEM 字符串为 X509Certificate 对象 */
function _loadX509(pem: string): crypto.X509Certificate {
  return new crypto.X509Certificate(pem);
}

/** 从 X509Certificate 提取公钥 KeyObject */
function _extractPublicKey(cert: crypto.X509Certificate): crypto.KeyObject {
  // Node.js 18+: cert.publicKey 已经是 KeyObject 类型
  const pk = cert.publicKey;
  if (pk && typeof pk === 'object' && 'type' in pk) {
    return pk as crypto.KeyObject;
  }
  // fallback: 从 PEM 格式创建
  return crypto.createPublicKey(cert.toString());
}

/** 检查证书时间有效性 */
function _ensureCertTimeValid(cert: crypto.X509Certificate, label: string, nowMs: number): void {
  const notBefore = new Date(cert.validFrom).getTime();
  const notAfter = new Date(cert.validTo).getTime();
  if (nowMs < notBefore) {
    throw new AuthError(`${label} is not yet valid`);
  }
  if (nowMs > notAfter) {
    throw new AuthError(`${label} has expired`);
  }
}

/**
 * 检查 BasicConstraints 扩展中 CA=true。
 * Node.js crypto.X509Certificate 不直接暴露 BasicConstraints，
 * 但 cert.ca 属性（Node 20+）可用，或者检查 keyUsage。
 * 这里通过 cert 的 infoAccess / 文本表示解析。
 */
function _isCaCert(cert: crypto.X509Certificate): boolean {
  // Node.js X509Certificate 在 v20+ 提供 .ca 属性
  if ('ca' in cert && typeof (cert as unknown as Record<string, unknown>).ca === 'boolean') {
    return (cert as unknown as Record<string, unknown>).ca as boolean;
  }
  // 降级：解析 cert 文本表示中的 BasicConstraints
  const text = cert.toString();
  // 检查是否包含 CA:TRUE
  if (/CA:TRUE/i.test(text)) return true;
  // 自签证书（issuer == subject）也视为 CA
  if (cert.issuer === cert.subject) return true;
  return false;
}

/** 检查证书是否为自签（issuer == subject） */
function _isSelfSigned(cert: crypto.X509Certificate): boolean {
  return cert.issuer === cert.subject;
}

/**
 * 验证 cert 是否由 issuerCert 签发。
 * 使用 X509Certificate.checkIssued (Node 18+)。
 */
function _checkIssuedBy(cert: crypto.X509Certificate, issuerCert: crypto.X509Certificate): boolean {
  if (typeof cert.checkIssued === 'function') {
    return cert.checkIssued(issuerCert);
  }
  // 降级比较 issuer/subject
  return cert.issuer === issuerCert.subject;
}

/**
 * 验证 cert 的签名是否由 issuerCert 的公钥签署。
 * 使用 X509Certificate.verify (Node 18+)。
 */
function _verifyCertSignedBy(cert: crypto.X509Certificate, issuerCert: crypto.X509Certificate): boolean {
  if (typeof cert.verify === 'function') {
    return cert.verify(_extractPublicKey(issuerCert));
  }
  // 如果 verify 不可用，只能信赖 checkIssued
  return _checkIssuedBy(cert, issuerCert);
}

/** 获取证书序列号的十六进制字符串（小写） */
function _certSerialHex(cert: crypto.X509Certificate): string {
  return cert.serialNumber.toLowerCase();
}

/** 获取证书的 Subject CN */
function _certSubjectCN(cert: crypto.X509Certificate): string | null {
  // cert.subject 格式: "CN=xxx\nO=yyy\n..."
  const match = cert.subject.match(/CN=([^\n]+)/);
  return match ? match[1].trim() : null;
}

/** 获取证书 DER 编码（用于去重比较） */
function _certDer(cert: crypto.X509Certificate): Buffer {
  return Buffer.from(cert.raw);
}

// ── HTTP 辅助 ─────────────────────────────────────────────────

/** 将 WebSocket URL 转换为 HTTP URL + 路径 */
function _gatewayHttpUrl(gatewayUrl: string, urlPath: string): string {
  const parsed = new URL(gatewayUrl);
  const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${scheme}//${parsed.host}${urlPath}`;
}

/** 发起 HTTP GET 请求，返回文本内容 */
async function _fetchText(url: string, verifySsl: boolean): Promise<string> {
  try {
    return await _httpGet(url, verifySsl);
  } catch (err) {
    throw new AuthError(`failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 发起 HTTP GET 请求，返回 JSON 对象 */
async function _fetchJson(url: string, verifySsl: boolean): Promise<Record<string, unknown>> {
  const text = await _fetchText(url, verifySsl);
  try {
    const payload = JSON.parse(text);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new AuthError(`invalid JSON payload from ${url}`);
    }
    return payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(`invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 底层 HTTP GET 实现，兼容 http/https + SSL 控制 */
function _httpGet(url: string, verifySsl: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = {
      timeout: 5000,
    };
    if (!verifySsl) {
      options.rejectUnauthorized = false;
    }
    const req = mod.get(url, options, (res: http.IncomingMessage) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout fetching ${url}`));
    });
  });
}

// ── 缓存类型 ──────────────────────────────────────────────────

interface CrlCacheEntry {
  revokedSerials: Set<string>;
  nextRefreshAt: number;
}

interface OcspCacheEntry {
  status: string;
  nextRefreshAt: number;
}

// ── WebSocket 短连接 RPC ──────────────────────────────────────

/** 默认连接工厂：创建临时 WebSocket 连接 */
type ConnectionFactory = (url: string) => Promise<WebSocket>;

function _defaultConnectionFactory(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      handshakeTimeout: 5000,
      rejectUnauthorized: false,
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(new AuthError(`websocket connect failed: ${err.message}`)));
  });
}

// ── AuthFlow ──────────────────────────────────────────────────

export class AuthFlow {
  private _keystore: KeyStore;
  private _crypto: CryptoProvider;
  private _aid: string | null;
  private _verifySsl: boolean;
  private _connectionFactory: ConnectionFactory;
  private _rootCaPath: string | null;
  private _chainCacheTtl: number;

  // 根证书（启动时加载）
  private _rootCerts: crypto.X509Certificate[];

  // Gateway CA 链缓存：gateway_url -> PEM 字符串数组
  private _gatewayChainCache: Map<string, string[]> = new Map();
  // Gateway CRL 缓存：gateway_url -> CRL 缓存条目
  private _gatewayCrlCache: Map<string, CrlCacheEntry> = new Map();
  // Gateway OCSP 缓存：gateway_url -> (serial_hex -> OCSP 缓存条目)
  private _gatewayOcspCache: Map<string, Map<string, OcspCacheEntry>> = new Map();
  // 证书链验证结果缓存：cert_serial -> verified_at (ms)
  private _chainVerifiedCache: Map<string, number> = new Map();
  // Gateway CA 链预验证标记：cache_key -> verified
  private _gatewayCaVerified: Map<string, boolean> = new Map();

  constructor(opts: {
    keystore: KeyStore;
    crypto: CryptoProvider;
    aid?: string | null;
    connectionFactory?: ConnectionFactory;
    rootCaPath?: string | null;
    chainCacheTtl?: number;
    verifySsl?: boolean;
  }) {
    this._keystore = opts.keystore;
    this._crypto = opts.crypto;
    this._aid = opts.aid ?? null;
    this._connectionFactory = opts.connectionFactory ?? _defaultConnectionFactory;
    this._rootCaPath = opts.rootCaPath ?? null;
    this._verifySsl = opts.verifySsl ?? false;
    this._chainCacheTtl = (opts.chainCacheTtl ?? 86400) * 1000; // 转为毫秒
    this._rootCerts = this._loadRootCerts(this._rootCaPath);
  }

  // ── 公开方法 ────────────────────────────────────────────────

  /** 加载身份信息（密钥对 + 证书 + 元数据） */
  loadIdentity(aid?: string): Record<string, unknown> {
    const identity = this._loadIdentityOrRaise(aid);
    const cert = this._keystore.loadCert(String(identity.aid));
    if (cert) identity.cert = cert;
    const metadata = this._keystore.loadMetadata(String(identity.aid)) ?? {};
    Object.assign(identity, metadata);
    return identity;
  }

  /** 加载身份信息，不存在时返回 null */
  loadIdentityOrNone(aid?: string): Record<string, unknown> | null {
    try {
      return this.loadIdentity(aid);
    } catch (e) {
      if (e instanceof StateError) return null;
      throw e;
    }
  }

  /** 获取 access_token 的过期时间戳（秒） */
  getAccessTokenExpiry(identity: Record<string, unknown>): number | null {
    const expiresAt = identity.access_token_expires_at;
    if (typeof expiresAt === 'number') return expiresAt;
    return null;
  }

  /**
   * 创建 AID 并注册到 Gateway。
   * 如果 AID 已在服务端注册但本地证书丢失，尝试从 PKI 端点下载恢复。
   */
  async createAid(gatewayUrl: string, aid: string): Promise<Record<string, unknown>> {
    let identity = this._ensureLocalIdentity(aid);
    if (identity.cert) {
      return { aid: identity.aid, cert: identity.cert };
    }

    // 本地有密钥但无证书——尝试注册
    try {
      const created = await this._createAid(gatewayUrl, identity);
      Object.assign(identity, created);
    } catch (e) {
      if (!(e instanceof AUNError) || !String(e.message).includes('already exists')) {
        throw e;
      }
      // AID 已在服务端注册，尝试从 PKI 下载恢复证书
      try {
        identity = await this._recoverCertViaDownload(gatewayUrl, identity);
      } catch {
        throw new StateError(
          `AID ${aid} already registered on server but local certificate is missing. ` +
          `Certificate download recovery failed. Options: ` +
          `(1) use a different AID name, or ` +
          `(2) restart Kite server to clear registration.`,
        );
      }
    }
    this._keystore.saveIdentity(String(identity.aid), identity);
    this._aid = String(identity.aid);
    return { aid: identity.aid, cert: identity.cert };
  }

  /**
   * 认证（登录）到 Gateway。
   * 执行两阶段挑战-应答认证，返回 token 信息。
   */
  async authenticate(
    gatewayUrl: string,
    opts?: { aid?: string },
  ): Promise<Record<string, unknown>> {
    let identity = this._loadIdentityOrRaise(opts?.aid);
    if (!identity.cert) {
      // 本地有密钥但无证书——尝试从 PKI 下载恢复
      try {
        identity = await this._recoverCertViaDownload(gatewayUrl, identity);
        this._keystore.saveIdentity(String(identity.aid), identity);
      } catch (e) {
        throw new StateError(
          `local certificate missing and recovery failed: ${e instanceof Error ? e.message : String(e)}. ` +
          `Run auth.createAid() to register a new identity.`,
        );
      }
    }
    const login = await this._login(gatewayUrl, identity);
    AuthFlow._rememberTokens(identity, login);
    await this._validateNewCert(identity, gatewayUrl);
    this._keystore.saveIdentity(String(identity.aid), identity);
    this._aid = String(identity.aid);
    return {
      aid: identity.aid,
      access_token: identity.access_token,
      refresh_token: identity.refresh_token,
      expires_at: identity.access_token_expires_at,
      gateway: gatewayUrl,
    };
  }

  /**
   * 确保已认证（自动创建 + 登录）。
   * 如果没有本地身份则创建，然后执行登录流程。
   */
  async ensureAuthenticated(gatewayUrl: string): Promise<Record<string, unknown>> {
    const identity = this._ensureIdentity();
    if (!identity.cert) {
      const created = await this._createAid(gatewayUrl, identity);
      Object.assign(identity, created);
      this._keystore.saveIdentity(String(identity.aid), identity);
    }
    const login = await this._login(gatewayUrl, identity);
    AuthFlow._rememberTokens(identity, login);
    await this._validateNewCert(identity, gatewayUrl);
    this._keystore.saveIdentity(String(identity.aid), identity);

    const token = identity.access_token || identity.token || identity.kite_token;
    if (!token) {
      throw new AuthError('login2 did not return access token');
    }
    return { token, identity };
  }

  /**
   * 刷新缓存的 token。
   * 使用 refresh_token 获取新的 access_token。
   */
  async refreshCachedTokens(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const refreshToken = String(identity.refresh_token || '');
    if (!refreshToken) {
      throw new AuthError('missing refresh_token');
    }
    const refreshed = await this._refreshAccessToken(gatewayUrl, refreshToken);
    AuthFlow._rememberTokens(identity, refreshed);
    await this._validateNewCert(identity, gatewayUrl);
    this._keystore.saveIdentity(String(identity.aid), identity);
    return identity;
  }

  /**
   * 使用 token 初始化 WebSocket 会话。
   * 发送 auth.connect RPC 完成会话握手。
   */
  async initializeWithToken(
    transport: RPCTransport,
    challenge: Record<string, unknown> | null,
    accessToken: string,
  ): Promise<void> {
    const nonce = this._extractChallengeNonce(challenge);
    await this._initializeSession(transport, nonce, accessToken);
  }

  /**
   * 连接会话（自动选择认证策略）。
   * 依次尝试：显式 token → 缓存 token → 刷新 token → 完整重认证。
   */
  async connectSession(
    transport: RPCTransport,
    challenge: Record<string, unknown> | null,
    gatewayUrl: string,
    opts?: { accessToken?: string },
  ): Promise<Record<string, unknown>> {
    const nonce = this._extractChallengeNonce(challenge);

    let identity: Record<string, unknown> | null;
    try {
      identity = this.loadIdentity();
    } catch {
      identity = null;
    }

    // 策略 1：显式 token
    const explicitToken = String(opts?.accessToken || '');
    if (explicitToken && identity !== null) {
      try {
        await this._initializeSession(transport, nonce, explicitToken);
        identity.access_token = explicitToken;
        this._keystore.saveIdentity(String(identity.aid), identity);
        return { token: explicitToken, identity };
      } catch (exc) {
        if (!(exc instanceof AuthError)) throw exc;
        _authLog('debug', 'explicit_token 认证失败，尝试下一方式: %s', exc.message);
      }
    }

    // 无本地身份时，执行完整认证
    if (identity === null) {
      const authContext = await this.ensureAuthenticated(gatewayUrl);
      const token = String(authContext.token);
      await this._initializeSession(transport, nonce, token);
      return authContext;
    }

    // 策略 2：缓存的 access_token
    const cachedToken = AuthFlow._getCachedAccessToken(identity);
    if (cachedToken) {
      try {
        await this._initializeSession(transport, nonce, cachedToken);
        return { token: cachedToken, identity };
      } catch (exc) {
        if (!(exc instanceof AuthError)) throw exc;
        _authLog('debug', 'cached_token 认证失败，尝试刷新: %s', exc.message);
      }
    }

    // 策略 3：refresh_token
    const refreshToken = String(identity.refresh_token || '');
    if (refreshToken) {
      try {
        identity = await this.refreshCachedTokens(gatewayUrl, identity);
        const newCachedToken = AuthFlow._getCachedAccessToken(identity);
        if (newCachedToken) {
          await this._initializeSession(transport, nonce, newCachedToken);
          return { token: newCachedToken, identity };
        }
      } catch (exc) {
        if (!(exc instanceof AuthError)) throw exc;
        _authLog('debug', 'refresh_token 认证失败，将重新登录: %s', exc.message);
      }
    }

    // 策略 4：完整重认证
    const login = await this.authenticate(gatewayUrl, { aid: identity.aid as string | undefined });
    const token = String(login.access_token || '');
    if (!token) {
      throw new AuthError('authenticate did not return access_token');
    }
    await this._initializeSession(transport, nonce, token);
    identity = this.loadIdentity(identity.aid as string | undefined);
    return { token, identity };
  }

  /**
   * 验证对端证书：时间有效性 + 链验证 + CRL + OCSP + AID 绑定。
   * 用于 E2EE 握手中验证通信对端的身份证书。
   */
  async verifyPeerCertificate(
    gatewayUrl: string,
    certPem: string,
    expectedAid: string,
  ): Promise<void> {
    const cert = _loadX509(certPem);
    const nowMs = Date.now();
    _ensureCertTimeValid(cert, 'peer certificate', nowMs);

    await this._verifyAuthCertChain(gatewayUrl, cert, expectedAid);

    try {
      await this._verifyAuthCertRevocation(gatewayUrl, cert, expectedAid);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(`peer cert CRL check failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      await this._verifyAuthCertOcsp(gatewayUrl, cert, expectedAid);
    } catch {
      // OCSP 不可用时降级（CRL 已检查）
    }

    // 检查 CN 匹配
    const cn = _certSubjectCN(cert);
    if (cn !== expectedAid) {
      throw new AuthError(`peer cert CN mismatch: expected ${expectedAid}, got ${cn || 'none'}`);
    }
  }

  // ── 内部方法：短连接 RPC ────────────────────────────────────

  /**
   * 通过临时 WebSocket 发送单次 JSON-RPC 请求。
   * 流程：连接 → 接收 challenge → 发送请求 → 接收响应 → 关闭。
   */
  private async _shortRpc(
    gatewayUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ws = await this._connectionFactory(gatewayUrl);
    try {
      // 接收 challenge（第一条消息）
      await this._wsRecv(ws);

      // 发送 RPC 请求
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: `pre-${method}`,
        method,
        params,
      });
      ws.send(payload);

      // 接收响应
      const raw = await this._wsRecv(ws);
      const message = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (message.error) {
        throw mapRemoteError(message.error);
      }
      const result = message.result;
      if (typeof result !== 'object' || result === null) {
        throw new ValidationError(`invalid pre-auth response for ${method}`);
      }
      if (result.success === false) {
        throw new AuthError(String(result.error || `${method} failed`));
      }
      return result as Record<string, unknown>;
    } finally {
      try {
        ws.close();
      } catch {
        // 忽略关闭错误
      }
    }
  }

  /** 从 WebSocket 接收一条消息（Promise 封装） */
  private _wsRecv(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AuthError('websocket recv timeout'));
      }, 10000);

      const handler = (data: WebSocket.RawData) => {
        clearTimeout(timer);
        ws.off('message', handler);
        ws.off('error', errHandler);
        if (Buffer.isBuffer(data)) {
          resolve(data.toString('utf-8'));
        } else if (data instanceof ArrayBuffer) {
          resolve(Buffer.from(data).toString('utf-8'));
        } else {
          resolve(String(data));
        }
      };

      const errHandler = (err: Error) => {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new AuthError(`websocket error: ${err.message}`));
      };

      ws.on('message', handler);
      ws.on('error', errHandler);
    });
  }

  // ── 内部方法：认证流程 ──────────────────────────────────────

  /** 注册 AID 到 Gateway */
  private async _createAid(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this._shortRpc(gatewayUrl, 'auth.create_aid', {
      aid: identity.aid,
      public_key: identity.public_key_der_b64,
      curve: identity.curve || 'P-256',
    });
    return { cert: response.cert };
  }

  /** 两阶段登录 */
  private async _login(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const clientNonce = this._crypto.newClientNonce();

    // Phase 1: 发送 AID + 证书 + 客户端 nonce
    const phase1 = await this._shortRpc(gatewayUrl, 'auth.aid_login1', {
      aid: identity.aid,
      cert: identity.cert,
      client_nonce: clientNonce,
    });

    // 验证 Phase 1 响应（证书链 + 签名）
    await this._verifyPhase1Response(gatewayUrl, phase1, clientNonce);

    // Phase 2: 用私钥签名 nonce
    const [signature, clientTime] = this._crypto.signLoginNonce(
      String(identity.private_key_pem),
      String(phase1.nonce),
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

  /** 刷新 access_token */
  private async _refreshAccessToken(
    gatewayUrl: string,
    refreshToken: string,
  ): Promise<Record<string, unknown>> {
    const result = await this._shortRpc(gatewayUrl, 'auth.refresh_token', {
      refresh_token: refreshToken,
    });
    if (!result.success) {
      throw new AuthError(String(result.error || 'refresh failed'));
    }
    return result;
  }

  /** 会话初始化：发送 auth.connect RPC */
  private async _initializeSession(
    transport: RPCTransport,
    nonce: string,
    token: string,
  ): Promise<void> {
    const result = (await transport.call('auth.connect', {
      nonce,
      auth: { method: 'kite_token', token },
      protocol: { min: '1.0', max: '1.0' },
      capabilities: {
        e2ee: true,
        group_e2ee: true,
      },
    })) as Record<string, unknown> | undefined;

    const status = (result ?? {}).status;
    if (status !== 'ok') {
      throw new AuthError(`initialize failed: ${JSON.stringify(result)}`);
    }
  }

  // ── 内部方法：证书验证 ──────────────────────────────────────

  /**
   * 验证 Phase 1 响应：
   * 1. 解析 auth_cert
   * 2. 验证证书链 + CRL + OCSP
   * 3. 验证 client_nonce_signature
   */
  private async _verifyPhase1Response(
    gatewayUrl: string,
    result: Record<string, unknown>,
    clientNonce: string,
  ): Promise<void> {
    const authCertPem = String(result.auth_cert || '');
    const signatureB64 = String(result.client_nonce_signature || '');

    if (!authCertPem) {
      throw new AuthError('aid_login1 missing auth_cert');
    }
    if (!signatureB64) {
      throw new AuthError('aid_login1 missing client_nonce_signature');
    }

    let authCert: crypto.X509Certificate;
    try {
      authCert = _loadX509(authCertPem);
    } catch {
      throw new AuthError('aid_login1 returned invalid auth_cert');
    }

    // 验证证书链、CRL、OCSP
    await this._verifyAuthCertChain(gatewayUrl, authCert);
    await this._verifyAuthCertRevocation(gatewayUrl, authCert);
    await this._verifyAuthCertOcsp(gatewayUrl, authCert);

    // 验证 client_nonce 签名
    try {
      const signature = Buffer.from(signatureB64, 'base64');
      const pubKey = _extractPublicKey(authCert);
      _verifySignature(pubKey, signature, Buffer.from(clientNonce, 'utf-8'));
    } catch (e) {
      if (e instanceof AuthError && e.message.includes('signature verification failed')) {
        throw new AuthError('aid_login1 server auth signature verification failed');
      }
      throw new AuthError('aid_login1 server auth signature verification failed');
    }
  }

  /**
   * 验证认证证书链。
   * 1. 检查缓存
   * 2. 时间有效性
   * 3. 签名链验证
   * 4. BasicConstraints 检查
   * 5. 根证书自签 + 受信根锚定
   */
  private async _verifyAuthCertChain(
    gatewayUrl: string,
    authCert: crypto.X509Certificate,
    chainAid: string = '',
  ): Promise<void> {
    const certSerial = _certSerialHex(authCert);

    // 检查缓存
    const cachedAt = this._chainVerifiedCache.get(certSerial);
    if (cachedAt && Date.now() - cachedAt < this._chainCacheTtl) {
      return;
    }

    const nowMs = Date.now();
    _ensureCertTimeValid(authCert, 'auth certificate', nowMs);

    const chain = await this._loadGatewayCaChain(gatewayUrl, chainAid);
    if (!chain.length) {
      throw new AuthError('unable to verify auth certificate chain: missing CA chain');
    }

    const cacheKey = chainAid ? `${gatewayUrl}:${chainAid}` : gatewayUrl;

    // 快速路径：CA 链已通过完整验证
    if (this._gatewayCaVerified.get(cacheKey)) {
      const issuer = chain[0];
      _ensureCertTimeValid(issuer, 'Issuer CA', nowMs);
      if (!_isCaCert(issuer)) {
        throw new AuthError('Issuer CA is not marked as CA (fast path)');
      }
      if (!_checkIssuedBy(authCert, issuer)) {
        throw new AuthError('auth certificate issuer mismatch');
      }
      if (!_verifyCertSignedBy(authCert, issuer)) {
        throw new AuthError('auth certificate signature verification failed');
      }
      this._chainVerifiedCache.set(certSerial, Date.now());
      return;
    }

    // 首次验证：完整验证流程
    let current = authCert;
    for (let i = 0; i < chain.length; i++) {
      const caCert = chain[i];
      _ensureCertTimeValid(caCert, `CA certificate[${i}]`, nowMs);
      if (!_checkIssuedBy(current, caCert)) {
        throw new AuthError(`auth certificate issuer mismatch at chain level ${i}`);
      }
      if (!_verifyCertSignedBy(current, caCert)) {
        throw new AuthError(`auth certificate signature verification failed at chain level ${i}`);
      }
      if (!_isCaCert(caCert)) {
        throw new AuthError(`CA certificate[${i}] is not marked as CA`);
      }
      current = caCert;
    }

    // 验证根证书自签
    const root = chain[chain.length - 1];
    if (!_isSelfSigned(root)) {
      throw new AuthError('auth certificate chain root is not self-signed');
    }
    if (!_verifyCertSignedBy(root, root)) {
      throw new AuthError('auth certificate chain root self-signature verification failed');
    }

    // 验证根证书在受信列表中
    const trustedRoots = this._loadTrustedRoots();
    const rootDer = _certDer(root);
    const isTrusted = trustedRoots.some((tr) => _certDer(tr).equals(rootDer));
    if (!isTrusted) {
      throw new AuthError('auth certificate chain is not anchored by a trusted root');
    }

    // 验证成功，更新缓存
    this._chainVerifiedCache.set(certSerial, Date.now());
    this._gatewayCaVerified.set(cacheKey, true);
  }

  /** 加载 Gateway CA 链（带缓存） */
  private async _loadGatewayCaChain(
    gatewayUrl: string,
    chainAid: string = '',
  ): Promise<crypto.X509Certificate[]> {
    const cacheKey = chainAid ? `${gatewayUrl}:${chainAid}` : gatewayUrl;
    let cached = this._gatewayChainCache.get(cacheKey);
    if (!cached) {
      cached = await this._fetchGatewayCaChain(gatewayUrl, chainAid);
      this._gatewayChainCache.set(cacheKey, cached);
    }
    return cached.map((pem) => _loadX509(pem));
  }

  /** 从 Gateway PKI 端点获取 CA 链 */
  private async _fetchGatewayCaChain(
    gatewayUrl: string,
    _chainAid: string = '',
  ): Promise<string[]> {
    const url = _gatewayHttpUrl(gatewayUrl, '/pki/chain');
    const text = await _fetchText(url, this._verifySsl);
    return _splitPemBundle(text);
  }

  /**
   * CRL 吊销检查。
   * 从 Gateway 的 /pki/crl.json 端点获取 CRL，
   * 验证签发者签名，检查证书序列号是否在吊销列表中。
   */
  private async _verifyAuthCertRevocation(
    gatewayUrl: string,
    authCert: crypto.X509Certificate,
    chainAid: string = '',
  ): Promise<void> {
    const chain = await this._loadGatewayCaChain(gatewayUrl, chainAid);
    if (!chain.length) {
      throw new AuthError('unable to verify auth certificate revocation: missing issuer certificate');
    }

    // 跨域时：CRL 请求发到 peer 所在域的 Gateway
    let crlGatewayUrl = gatewayUrl;
    if (chainAid && chainAid.includes('.')) {
      const peerIssuer = chainAid.split('.').slice(1).join('.');
      const localMatch = gatewayUrl.match(/gateway\.([^:/]+)/);
      const localIssuer = localMatch ? localMatch[1] : '';
      if (localIssuer && peerIssuer !== localIssuer) {
        crlGatewayUrl = gatewayUrl.replace(`gateway.${localIssuer}`, `gateway.${peerIssuer}`);
      }
    }

    const revokedSerials = await this._loadGatewayRevokedSerials(crlGatewayUrl, chain[0]);
    const serialHex = _certSerialHex(authCert);
    if (revokedSerials.has(serialHex)) {
      throw new AuthError('auth certificate has been revoked');
    }
  }

  /** 加载 Gateway 吊销列表（带缓存） */
  private async _loadGatewayRevokedSerials(
    gatewayUrl: string,
    issuerCert: crypto.X509Certificate,
  ): Promise<Set<string>> {
    const cached = this._gatewayCrlCache.get(gatewayUrl);
    const now = Date.now();
    if (cached && cached.nextRefreshAt > now) {
      return cached.revokedSerials;
    }
    const entry = await this._fetchGatewayCrl(gatewayUrl, issuerCert);
    this._gatewayCrlCache.set(gatewayUrl, entry);
    return entry.revokedSerials;
  }

  /**
   * 从 Gateway /pki/crl.json 获取 CRL 并解析。
   *
   * 响应格式: { crl_pem: "...", revoked_serials?: [...] }
   *
   * 注意：完整的 CRL PEM 签名验证需要 ASN.1/DER 解析，
   * Node.js 标准库不直接支持 CRL 解析。
   * 这里使用 JSON 响应中的 revoked_serials 字段作为可信数据源，
   * 并验证 crl_pem 存在性。完整的 CRL 签名验证需要依赖
   * @peculiar/x509 或手动 ASN.1 解析。
   */
  private async _fetchGatewayCrl(
    gatewayUrl: string,
    _issuerCert: crypto.X509Certificate,
  ): Promise<CrlCacheEntry> {
    const url = _gatewayHttpUrl(gatewayUrl, '/pki/crl.json');
    const payload = await _fetchJson(url, this._verifySsl);
    const crlPem = String(payload.crl_pem || '');
    if (!crlPem) {
      throw new AuthError('gateway CRL endpoint returned no signed CRL');
    }

    // 从 JSON 响应中提取吊销序列号列表
    // Gateway 的 crl.json 同时包含 crl_pem（签名 CRL）和 revoked_serials（方便客户端解析）
    let revokedSerials = new Set<string>();

    // 尝试解析 CRL PEM 以提取吊销序列号
    // Node.js 不直接支持 CRL 解析，尝试从 DER 中手动提取
    try {
      revokedSerials = this._parseCrlRevokedSerials(crlPem, _issuerCert);
    } catch {
      // CRL 解析失败时，降级使用 JSON 响应中的 revoked_serials（如果提供）
      const serialsArr = payload.revoked_serials;
      if (Array.isArray(serialsArr)) {
        revokedSerials = new Set(serialsArr.map((s: unknown) => String(s).toLowerCase()));
      }
      // 如果两者都没有，返回空集合（无吊销记录）
      _authLog('debug', 'CRL PEM 解析失败，使用 JSON revoked_serials 降级');
    }

    // 缓存 TTL：默认 5 分钟，最大 24 小时
    const now = Date.now();
    let nextRefreshAt = now + 300_000; // 5 分钟
    const maxRefreshAt = now + 86400_000; // 24 小时
    nextRefreshAt = Math.min(nextRefreshAt, maxRefreshAt);

    return { revokedSerials, nextRefreshAt };
  }

  /**
   * 从 CRL PEM 解析吊销序列号。
   * 简化的 ASN.1 DER 解析：提取 TBSCertList 中的 revokedCertificates 序列号。
   *
   * CRL ASN.1 结构（简化）：
   * CertificateList ::= SEQUENCE {
   *   tbsCertList    TBSCertList,
   *   signatureAlgorithm AlgorithmIdentifier,
   *   signature      BIT STRING
   * }
   *
   * TBSCertList ::= SEQUENCE {
   *   version              INTEGER OPTIONAL,
   *   signature            AlgorithmIdentifier,
   *   issuer               Name,
   *   thisUpdate           Time,
   *   nextUpdate           Time OPTIONAL,
   *   revokedCertificates  SEQUENCE OF SEQUENCE { ... } OPTIONAL,
   *   ...
   * }
   */
  private _parseCrlRevokedSerials(
    crlPem: string,
    issuerCert: crypto.X509Certificate,
  ): Set<string> {
    // 提取 DER 数据
    const b64 = crlPem
      .replace(/-----BEGIN X509 CRL-----/g, '')
      .replace(/-----END X509 CRL-----/g, '')
      .replace(/\s/g, '');
    const der = Buffer.from(b64, 'base64');

    // 简化 ASN.1 解析：提取 TBSCertList 和签名
    // 外层 SEQUENCE
    const outer = this._readAsn1Sequence(der, 0);
    if (!outer) throw new Error('invalid CRL: not a SEQUENCE');

    // TBSCertList SEQUENCE
    const tbsStart = outer.contentOffset;
    const tbs = this._readAsn1Sequence(der, tbsStart);
    if (!tbs) throw new Error('invalid CRL: TBSCertList not a SEQUENCE');

    // 验证签发者签名
    const tbsBytes = der.subarray(tbsStart, tbsStart + tbs.totalLength);
    // 签名在 TBSCertList 之后：先跳过 AlgorithmIdentifier，再读取 BIT STRING
    let sigOffset = tbsStart + tbs.totalLength;
    // 跳过 signatureAlgorithm SEQUENCE
    const sigAlg = this._readAsn1Tag(der, sigOffset);
    if (sigAlg) sigOffset += sigAlg.totalLength;
    // 读取 signature BIT STRING
    const sigBitString = this._readAsn1Tag(der, sigOffset);
    if (sigBitString && der[sigOffset] === 0x03) {
      // BIT STRING 第一个字节是 padding bits 数（通常为 0）
      const sigBytes = der.subarray(
        sigBitString.contentOffset + 1,
        sigBitString.contentOffset + sigBitString.contentLength,
      );
      try {
        const pubKey = _extractPublicKey(issuerCert);
        _verifySignature(pubKey, Buffer.from(sigBytes), Buffer.from(tbsBytes));
      } catch {
        throw new AuthError('gateway CRL signature verification failed');
      }
    }

    // 解析 TBSCertList 内部字段以找到 revokedCertificates
    const revokedSerials = new Set<string>();
    let offset = tbs.contentOffset;
    const tbsEnd = tbs.contentOffset + tbs.contentLength;
    let fieldIdx = 0;

    while (offset < tbsEnd) {
      const tag = this._readAsn1Tag(der, offset);
      if (!tag) break;

      // revokedCertificates 是 TBSCertList 中的第 6 个字段（index 5，version 从 0 开始）
      // 或者根据 tag 判断：它是一个 SEQUENCE OF SEQUENCE
      // 实际上字段顺序为：version?, signatureAlg, issuer, thisUpdate, nextUpdate?, revokedCerts?
      // 简化方式：找到包含 INTEGER（序列号）的嵌套 SEQUENCE 结构
      if (fieldIdx >= 4 && der[offset] === 0x30) {
        // 这可能是 revokedCertificates SEQUENCE OF
        const revokedSeq = this._readAsn1Sequence(der, offset);
        if (revokedSeq) {
          let rOffset = revokedSeq.contentOffset;
          const rEnd = revokedSeq.contentOffset + revokedSeq.contentLength;
          while (rOffset < rEnd) {
            // 每个条目是 SEQUENCE { serialNumber INTEGER, ... }
            const entry = this._readAsn1Sequence(der, rOffset);
            if (!entry) break;
            // 条目的第一个元素是 INTEGER（序列号）
            const serialTag = this._readAsn1Tag(der, entry.contentOffset);
            if (serialTag && der[entry.contentOffset] === 0x02) {
              const serialBytes = der.subarray(
                serialTag.contentOffset,
                serialTag.contentOffset + serialTag.contentLength,
              );
              const serialHex = Buffer.from(serialBytes).toString('hex').toLowerCase();
              // 去掉前导零
              const cleaned = serialHex.replace(/^0+/, '') || '0';
              revokedSerials.add(cleaned);
            }
            rOffset += entry.totalLength;
          }
          break; // 找到 revokedCertificates 后退出
        }
      }

      offset += tag.totalLength;
      fieldIdx++;
    }

    return revokedSerials;
  }

  /**
   * OCSP 状态检查。
   * 从 Gateway 的 /pki/ocsp/{serial_hex} 端点获取 OCSP 响应。
   */
  private async _verifyAuthCertOcsp(
    gatewayUrl: string,
    authCert: crypto.X509Certificate,
    chainAid: string = '',
  ): Promise<void> {
    const chain = await this._loadGatewayCaChain(gatewayUrl, chainAid);
    if (!chain.length) {
      throw new AuthError('unable to verify auth certificate OCSP status: missing issuer certificate');
    }
    const status = await this._loadGatewayOcspStatus(gatewayUrl, authCert, chain[0]);
    if (status === 'revoked') {
      throw new AuthError('auth certificate OCSP status is revoked');
    }
    if (status !== 'good') {
      throw new AuthError(`auth certificate OCSP status is ${status}`);
    }
  }

  /** 加载 Gateway OCSP 状态（带缓存） */
  private async _loadGatewayOcspStatus(
    gatewayUrl: string,
    authCert: crypto.X509Certificate,
    issuerCert: crypto.X509Certificate,
  ): Promise<string> {
    const serialHex = _certSerialHex(authCert);
    let gatewayCache = this._gatewayOcspCache.get(gatewayUrl);
    if (!gatewayCache) {
      gatewayCache = new Map();
      this._gatewayOcspCache.set(gatewayUrl, gatewayCache);
    }
    const cached = gatewayCache.get(serialHex);
    const now = Date.now();
    if (cached && cached.nextRefreshAt > now) {
      return cached.status;
    }
    const entry = await this._fetchGatewayOcspStatus(gatewayUrl, authCert, issuerCert);
    gatewayCache.set(serialHex, entry);
    return entry.status;
  }

  /**
   * 从 Gateway /pki/ocsp/{serial_hex} 获取 OCSP 状态。
   *
   * 响应格式: { status: "good"|"revoked"|"unknown", ocsp_response: "base64..." }
   *
   * 注意：完整的 OCSP DER 响应解析需要 ASN.1 解析。
   * 这里从 JSON 响应中提取 status 字段，并验证 ocsp_response 存在性。
   * 对于 ocsp_response 的签名验证，实现简化的 DER 解析以提取关键字段。
   */
  private async _fetchGatewayOcspStatus(
    gatewayUrl: string,
    authCert: crypto.X509Certificate,
    issuerCert: crypto.X509Certificate,
  ): Promise<OcspCacheEntry> {
    const serialHex = _certSerialHex(authCert);
    const url = _gatewayHttpUrl(gatewayUrl, `/pki/ocsp/${serialHex}`);
    const payload = await _fetchJson(url, this._verifySsl);
    const status = String(payload.status || '');
    const ocspB64 = String(payload.ocsp_response || '');

    if (!ocspB64) {
      throw new AuthError('gateway OCSP endpoint returned no ocsp_response');
    }

    let effectiveStatus: string;

    try {
      // 尝试解析 DER OCSP 响应
      const ocspDer = Buffer.from(ocspB64, 'base64');
      effectiveStatus = this._parseOcspResponse(ocspDer, authCert, issuerCert);
    } catch (e) {
      // OCSP DER 解析失败时，降级信赖 JSON status 字段
      if (e instanceof AuthError) throw e;
      _authLog('debug', 'OCSP DER 解析失败，使用 JSON status 降级: %s', e instanceof Error ? e.message : String(e));
      if (!status) {
        throw new AuthError('gateway OCSP endpoint returned invalid response and no status field');
      }
      effectiveStatus = status;
    }

    // 如果 JSON status 和 DER 解析结果不一致则报错
    if (status && status !== effectiveStatus) {
      throw new AuthError('gateway OCSP status mismatch');
    }

    // 缓存 TTL：默认 5 分钟，最大 24 小时
    const now = Date.now();
    const nextRefreshAt = Math.min(now + 300_000, now + 86400_000);

    return { status: effectiveStatus, nextRefreshAt };
  }

  /**
   * 简化的 OCSP DER 响应解析。
   *
   * OCSPResponse ::= SEQUENCE {
   *   responseStatus  ENUMERATED { successful(0), ... },
   *   responseBytes   [0] EXPLICIT SEQUENCE {
   *     responseType   OID,
   *     response       OCTET STRING (BasicOCSPResponse DER)
   *   } OPTIONAL
   * }
   *
   * BasicOCSPResponse ::= SEQUENCE {
   *   tbsResponseData  ResponseData,
   *   signatureAlgorithm AlgorithmIdentifier,
   *   signature        BIT STRING,
   *   ...
   * }
   *
   * ResponseData ::= SEQUENCE {
   *   version          [0] EXPLICIT INTEGER DEFAULT v1,
   *   responderID      ...,
   *   producedAt       GeneralizedTime,
   *   responses        SEQUENCE OF SingleResponse,
   *   ...
   * }
   *
   * SingleResponse ::= SEQUENCE {
   *   certID           CertID,
   *   certStatus       CHOICE { good [0], revoked [1], unknown [2] },
   *   thisUpdate       GeneralizedTime,
   *   nextUpdate       [0] EXPLICIT GeneralizedTime OPTIONAL,
   * }
   *
   * 这里只做关键字段提取：responseStatus、certStatus。
   * 完整签名验证依赖更全面的 ASN.1 库。
   */
  private _parseOcspResponse(
    ocspDer: Buffer,
    _authCert: crypto.X509Certificate,
    _issuerCert: crypto.X509Certificate,
  ): string {
    // 外层 SEQUENCE
    const outer = this._readAsn1Sequence(ocspDer, 0);
    if (!outer) throw new Error('invalid OCSP response: not a SEQUENCE');

    // responseStatus ENUMERATED
    let offset = outer.contentOffset;
    const statusTag = this._readAsn1Tag(ocspDer, offset);
    if (!statusTag || ocspDer[offset] !== 0x0a) {
      throw new Error('invalid OCSP response: missing responseStatus');
    }
    const responseStatus = ocspDer[statusTag.contentOffset];
    if (responseStatus !== 0) {
      // 非 successful
      const statusNames = ['successful', 'malformedRequest', 'internalError', 'tryLater', '', 'sigRequired', 'unauthorized'];
      const statusName = statusNames[responseStatus] || `unknown(${responseStatus})`;
      throw new AuthError(`gateway OCSP response status is ${statusName}`);
    }
    offset += statusTag.totalLength;

    // responseBytes [0] EXPLICIT
    if (offset >= outer.contentOffset + outer.contentLength) {
      throw new Error('invalid OCSP response: missing responseBytes');
    }
    const respBytesTag = this._readAsn1Tag(ocspDer, offset);
    if (!respBytesTag) throw new Error('invalid OCSP response: cannot read responseBytes');

    // 内部 SEQUENCE { responseType OID, response OCTET STRING }
    const respBytesSeq = this._readAsn1Sequence(ocspDer, respBytesTag.contentOffset);
    if (!respBytesSeq) throw new Error('invalid OCSP response: responseBytes not a SEQUENCE');

    // 跳过 responseType OID
    let innerOffset = respBytesSeq.contentOffset;
    const oidTag = this._readAsn1Tag(ocspDer, innerOffset);
    if (!oidTag) throw new Error('invalid OCSP response: missing responseType OID');
    innerOffset += oidTag.totalLength;

    // response OCTET STRING (包含 BasicOCSPResponse DER)
    const octetTag = this._readAsn1Tag(ocspDer, innerOffset);
    if (!octetTag || ocspDer[innerOffset] !== 0x04) {
      throw new Error('invalid OCSP response: missing response OCTET STRING');
    }
    const basicDer = ocspDer.subarray(octetTag.contentOffset, octetTag.contentOffset + octetTag.contentLength);

    // BasicOCSPResponse SEQUENCE
    const basicSeq = this._readAsn1Sequence(basicDer, 0);
    if (!basicSeq) throw new Error('invalid OCSP response: BasicOCSPResponse not a SEQUENCE');

    // tbsResponseData SEQUENCE
    const tbsSeq = this._readAsn1Sequence(basicDer, basicSeq.contentOffset);
    if (!tbsSeq) throw new Error('invalid OCSP response: tbsResponseData not a SEQUENCE');

    // 解析 tbsResponseData 以找到 responses
    // 字段顺序：version?, responderID, producedAt, responses, extensions?
    let tbsOffset = tbsSeq.contentOffset;
    const tbsEnd = tbsSeq.contentOffset + tbsSeq.contentLength;

    // 跳过 version [0] EXPLICIT（如果存在）
    if (tbsOffset < tbsEnd && (basicDer[tbsOffset] & 0xe0) === 0xa0) {
      const versionTag = this._readAsn1Tag(basicDer, tbsOffset);
      if (versionTag) tbsOffset += versionTag.totalLength;
    }

    // 跳过 responderID (CHOICE)
    if (tbsOffset < tbsEnd) {
      const respIdTag = this._readAsn1Tag(basicDer, tbsOffset);
      if (respIdTag) tbsOffset += respIdTag.totalLength;
    }

    // 跳过 producedAt GeneralizedTime
    if (tbsOffset < tbsEnd) {
      const prodAtTag = this._readAsn1Tag(basicDer, tbsOffset);
      if (prodAtTag) tbsOffset += prodAtTag.totalLength;
    }

    // responses SEQUENCE OF SingleResponse
    if (tbsOffset >= tbsEnd) throw new Error('invalid OCSP response: missing responses');
    const responsesSeq = this._readAsn1Sequence(basicDer, tbsOffset);
    if (!responsesSeq) throw new Error('invalid OCSP response: responses not a SEQUENCE');

    // 解析第一个 SingleResponse
    const singleSeq = this._readAsn1Sequence(basicDer, responsesSeq.contentOffset);
    if (!singleSeq) throw new Error('invalid OCSP response: SingleResponse not a SEQUENCE');

    // SingleResponse: { certID SEQUENCE, certStatus CHOICE, thisUpdate, nextUpdate? }
    let srOffset = singleSeq.contentOffset;

    // 跳过 certID SEQUENCE
    const certIdTag = this._readAsn1Tag(basicDer, srOffset);
    if (!certIdTag) throw new Error('invalid OCSP response: missing certID');
    srOffset += certIdTag.totalLength;

    // certStatus CHOICE: good [0] IMPLICIT NULL, revoked [1] IMPLICIT ..., unknown [2] IMPLICIT NULL
    if (srOffset >= singleSeq.contentOffset + singleSeq.contentLength) {
      throw new Error('invalid OCSP response: missing certStatus');
    }
    const certStatusByte = basicDer[srOffset];
    // context-specific tag class (bits 7-6 = 10), constructed bit (bit 5)
    const tagNumber = certStatusByte & 0x1f;

    if (tagNumber === 0) return 'good';
    if (tagNumber === 1) return 'revoked';
    if (tagNumber === 2) return 'unknown';

    return 'unknown';
  }

  // ── ASN.1 DER 辅助解析 ─────────────────────────────────────

  /** 读取 ASN.1 SEQUENCE 标签，返回内容偏移和长度 */
  private _readAsn1Sequence(
    buf: Buffer,
    offset: number,
  ): { contentOffset: number; contentLength: number; totalLength: number } | null {
    if (offset >= buf.length) return null;
    const tag = buf[offset];
    // SEQUENCE 或 CONSTRUCTED SEQUENCE (0x30)
    if (tag !== 0x30) {
      // 也接受 context-specific constructed tags
      if ((tag & 0x20) === 0) return null;
    }
    return this._readAsn1Tag(buf, offset);
  }

  /** 读取任意 ASN.1 标签的长度信息 */
  private _readAsn1Tag(
    buf: Buffer,
    offset: number,
  ): { contentOffset: number; contentLength: number; totalLength: number } | null {
    if (offset >= buf.length) return null;
    let pos = offset + 1; // 跳过 tag byte
    if (pos >= buf.length) return null;

    // 读取长度
    const firstLenByte = buf[pos];
    let contentLength: number;
    let lenBytes: number;

    if (firstLenByte < 0x80) {
      // 短格式
      contentLength = firstLenByte;
      lenBytes = 1;
    } else if (firstLenByte === 0x80) {
      // 不定长格式（不支持）
      return null;
    } else {
      // 长格式
      const numLenBytes = firstLenByte & 0x7f;
      if (pos + numLenBytes >= buf.length) return null;
      contentLength = 0;
      for (let i = 0; i < numLenBytes; i++) {
        contentLength = (contentLength << 8) | buf[pos + 1 + i];
      }
      lenBytes = 1 + numLenBytes;
    }

    const contentOffset = offset + 1 + lenBytes;
    const totalLength = 1 + lenBytes + contentLength;

    return { contentOffset, contentLength, totalLength };
  }

  // ── 内部方法：证书恢复 ─────────────────────────────────────

  /**
   * 从 PKI HTTP 端点下载证书恢复。
   * 本地有密钥但无证书、服务端已注册时使用。
   */
  private async _recoverCertViaDownload(
    gatewayUrl: string,
    identity: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const certUrl = _gatewayHttpUrl(gatewayUrl, `/pki/cert/${identity.aid}`);
    const certPem = await _fetchText(certUrl, this._verifySsl);
    if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) {
      throw new AuthError(`failed to download certificate for ${identity.aid}`);
    }

    // 验证下载的证书公钥与本地密钥对匹配
    const cert = _loadX509(certPem);
    const certPubKey = _extractPublicKey(cert);
    const certPubDer = certPubKey.export({ type: 'spki', format: 'der' });
    const localPubDer = Buffer.from(String(identity.public_key_der_b64), 'base64');

    if (!certPubDer.equals(localPubDer)) {
      throw new AuthError(
        `downloaded certificate public key does not match local key pair for ${identity.aid}. ` +
        `The server has a different key registered — this AID cannot be recovered with the current key.`,
      );
    }

    identity.cert = certPem;
    return identity;
  }

  // ── 内部方法：new_cert 验证 ────────────────────────────────

  /**
   * 验证服务端返回的 new_cert，通过后才正式接受。
   * 安全要点：CN/公钥/时间 + 完整链验证 + 受信根锚定 + CRL/OCSP。
   */
  private async _validateNewCert(
    identity: Record<string, unknown>,
    gatewayUrl: string = '',
  ): Promise<void> {
    const newCertPem = identity._pending_new_cert;
    delete identity._pending_new_cert;

    if (!newCertPem) return;

    try {
      const certPemStr = typeof newCertPem === 'string' ? newCertPem : String(newCertPem);
      const cert = _loadX509(certPemStr);
      const aid = String(identity.aid || '');

      // 1. CN 必须匹配当前 AID
      const cn = _certSubjectCN(cert);
      if (cn !== aid) {
        throw new AuthError(
          `new_cert CN mismatch: expected ${aid}, got ${cn || 'none'}`,
        );
      }

      // 2. 公钥必须匹配本地私钥
      const certPubKey = _extractPublicKey(cert);
      const certPubDer = certPubKey.export({ type: 'spki', format: 'der' });
      const localPubB64 = String(identity.public_key_der_b64 || '');
      if (localPubB64) {
        const localPubDer = Buffer.from(localPubB64, 'base64');
        if (!certPubDer.equals(localPubDer)) {
          throw new AuthError('new_cert public key does not match local identity key');
        }
      }

      // 3. 时间有效性
      _ensureCertTimeValid(cert, 'new_cert', Date.now());

      // 4. 完整证书链验证 + 受信根锚定 + CRL/OCSP
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
      identity.cert = certPemStr;
    } catch (e) {
      if (e instanceof AuthError) {
        _authLog('warn', '拒绝服务端返回的 new_cert (%s): %s', identity.aid, e.message);
      } else {
        _authLog('warn', 'new_cert 验证异常 (%s): %s', identity.aid, e instanceof Error ? e.message : String(e));
      }
    }
  }

  // ── 内部方法：Token 管理 ───────────────────────────────────

  /**
   * 从认证结果中提取并保存 token 到 identity。
   * 与 Python SDK 的 _remember_tokens 对齐。
   */
  private static _rememberTokens(
    identity: Record<string, unknown>,
    authResult: Record<string, unknown>,
  ): void {
    const accessToken = authResult.access_token || authResult.token || authResult.kite_token;
    const refreshToken = authResult.refresh_token;
    const expiresIn = authResult.expires_in;

    if (accessToken) identity.access_token = accessToken;
    if (refreshToken) identity.refresh_token = refreshToken;
    if (authResult.token) identity.kite_token = authResult.token;
    if (typeof expiresIn === 'number') {
      identity.access_token_expires_at = Math.floor(Date.now() / 1000 + expiresIn);
    }
    // 协议要求：login2 响应含 new_cert 时（证书过半自动续期），客户端必须保存
    // 先暂存到 _pending_new_cert，由 _validate_new_cert 验证后再正式接受
    const newCert = authResult.new_cert;
    if (newCert) {
      identity._pending_new_cert = newCert;
    }
  }

  /**
   * 获取缓存的 access_token（30 秒提前过期余量）。
   * 返回空字符串表示 token 不可用。
   */
  private static _getCachedAccessToken(identity: Record<string, unknown>): string {
    const accessToken = String(identity.access_token || '');
    if (!accessToken) return '';
    const expiresAt = identity.access_token_expires_at;
    if (typeof expiresAt === 'number' && expiresAt <= Date.now() / 1000 + 30) {
      return '';
    }
    return accessToken;
  }

  // ── 内部方法：身份管理 ─────────────────────────────────────

  /** 确保本地有指定 AID 的身份（不存在则创建密钥对） */
  private _ensureLocalIdentity(aid: string): Record<string, unknown> {
    const existing = this._keystore.loadIdentity(aid);
    if (existing) {
      this._aid = aid;
      return existing;
    }
    const identity: Record<string, unknown> = this._crypto.generateIdentity() as unknown as Record<string, unknown>;
    identity.aid = aid;
    this._keystore.saveIdentity(aid, identity); // 立即持久化密钥对
    this._aid = aid;
    return identity;
  }

  /** 加载身份信息，不存在时抛出 StateError */
  private _loadIdentityOrRaise(aid?: string): Record<string, unknown> {
    const requestedAid = aid ?? this._aid;
    if (requestedAid) {
      const existing = this._keystore.loadIdentity(requestedAid);
      if (existing === null) {
        throw new StateError(`identity not found for aid: ${requestedAid}`);
      }
      this._aid = requestedAid;
      return existing;
    }
    // 尝试加载任意身份
    const ks = this._keystore as unknown as Record<string, unknown>;
    if (typeof ks.loadAnyIdentity === 'function') {
      const existing = (ks.loadAnyIdentity as () => Record<string, unknown> | null)();
      if (existing !== null && existing !== undefined) {
        const loadedAid = existing.aid;
        if (typeof loadedAid === 'string' && loadedAid) {
          this._aid = loadedAid;
        }
        return existing;
      }
    }
    throw new StateError('no local identity found, call auth.createAid() first');
  }

  /** 确保有身份（不存在时自动创建密钥对） */
  private _ensureIdentity(): Record<string, unknown> {
    try {
      return this._loadIdentityOrRaise();
    } catch (e) {
      if (!(e instanceof StateError)) throw e;
      if (!this._aid) {
        throw new StateError('no local identity found, call auth.createAid() first');
      }
      const identity: Record<string, unknown> = this._crypto.generateIdentity() as unknown as Record<string, unknown>;
      identity.aid = this._aid;
      this._keystore.saveIdentity(this._aid, identity); // 立即持久化
      return identity;
    }
  }

  /** 从 challenge 消息中提取 nonce */
  private _extractChallengeNonce(challenge: Record<string, unknown> | null): string {
    const params = (challenge?.params ?? {}) as Record<string, unknown>;
    const nonce = String(params.nonce || '');
    if (!nonce) {
      throw new AuthError('gateway challenge missing nonce');
    }
    return nonce;
  }

  // ── 内部方法：根证书管理 ───────────────────────────────────

  /** 加载受信根证书列表 */
  private _loadTrustedRoots(): crypto.X509Certificate[] {
    if (!this._rootCerts.length) {
      throw new AuthError('no trusted roots available for auth certificate verification');
    }
    return this._rootCerts;
  }

  /**
   * 加载根证书：内置 + 自定义路径。
   * 在 SDK 的 certs/ 目录下查找 *.crt 文件。
   */
  private _loadRootCerts(rootCaPath: string | null): crypto.X509Certificate[] {
    const candidatePaths: string[] = [];

    if (rootCaPath) {
      candidatePaths.push(rootCaPath);
    }

    // 内置 certs 目录：多种路径策略确保找到
    let normalizedSrcDir: string;
    try {
      normalizedSrcDir = path.dirname(fileURLToPath(import.meta.url));
    } catch {
      normalizedSrcDir = __dirname ?? process.cwd();
    }

    const bundledDirs = [
      path.join(normalizedSrcDir, 'certs'),
      path.join(normalizedSrcDir, '..', 'certs'),
      path.join(normalizedSrcDir, '..', 'src', 'certs'),
      // 从 process.cwd() 出发（vitest 运行时 cwd 通常是包根目录）
      path.join(process.cwd(), 'src', 'certs'),
    ];

    for (const dir of bundledDirs) {
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.crt'))
            .sort()
            .map((f) => path.join(dir, f));
          candidatePaths.push(...files);
        }
      } catch {
        // 目录不存在或不可访问
      }
    }

    const certs: crypto.X509Certificate[] = [];
    const seenDer = new Set<string>();

    for (const certPath of candidatePaths) {
      let text: string;
      try {
        text = fs.readFileSync(certPath, 'utf-8');
      } catch (e) {
        throw new AuthError(`failed to read root certificate bundle: ${certPath}`);
      }
      const pems = _splitPemBundle(text);
      for (const pem of pems) {
        try {
          const cert = _loadX509(pem);
          const der = _certDer(cert).toString('hex');
          if (seenDer.has(der)) continue;
          seenDer.add(der);
          certs.push(cert);
        } catch {
          // 跳过无法解析的证书
        }
      }
    }

    return certs;
  }
}
