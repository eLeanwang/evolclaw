// ── AuthNamespace（认证命名空间 — 完整实现）──────────────────

import type { AUNClient } from '../client.js';
import { ValidationError } from '../errors.js';

/**
 * 认证命名空间 — 提供 AID 注册、登录认证等高级操作。
 * 通过 AUNClient 内部的 AuthFlow 完成完整的 PKI 注册和两阶段认证。
 */
export class AuthNamespace {
  private _client: AUNClient;

  constructor(client: AUNClient) {
    this._client = client;
  }

  /**
   * 解析 gateway URL。
   * 优先使用已预置的 gatewayUrl，否则基于 AID 自动发现。
   *
   * 发现流程：
   * 1. 若 gatewayUrl 已预置，直接返回
   * 2. https://{aid}/.well-known/aun-gateway（泛域名 nameservice）
   * 3. https://gateway.{issuer}/.well-known/aun-gateway（Gateway 直连）
   */
  private async _resolveGateway(aid?: string): Promise<string> {
    if (this._client.gatewayUrl) {
      return this._client.gatewayUrl;
    }

    const resolvedAid = aid ?? this._client.aid;
    if (resolvedAid) {
      const parts = resolvedAid.split('.');
      const issuerDomain = parts.length > 1 ? parts.slice(1).join('.') : resolvedAid;
      const port = this._client.configModel.discoveryPort;
      const portSuffix = port ? `:${port}` : '';

      // 尝试 nameservice 发现
      const primaryUrl = `https://${resolvedAid}${portSuffix}/.well-known/aun-gateway`;
      try {
        return await this._client.discovery.discover(primaryUrl);
      } catch {
        // 降级到 Gateway 直连
      }

      const fallbackUrl = `https://gateway.${issuerDomain}${portSuffix}/.well-known/aun-gateway`;
      return await this._client.discovery.discover(fallbackUrl);
    }

    throw new ValidationError(
      "unable to resolve gateway: set client.gatewayUrl or provide 'aid' for auto-discovery",
    );
  }

  /** 内部访问 client 私有属性 */
  private get _internal(): Record<string, any> {
    return this._client as unknown as Record<string, any>;
  }

  /**
   * 注册新 AID。
   * 通过 well-known 发现 gateway → 调用 AuthFlow.createAid 注册。
   */
  async createAid(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const aid = String(params?.aid ?? '');
    if (!aid) throw new ValidationError("auth.createAid requires 'aid'");

    const gatewayUrl = await this._resolveGateway(aid);
    this._client.gatewayUrl = gatewayUrl;

    const auth = this._internal._auth;
    const result = await auth.createAid(gatewayUrl, aid);
    this._internal._aid = result.aid;
    this._internal._identity = await auth.loadIdentityOrNull(String(result.aid));

    return {
      aid: result.aid,
      cert_pem: result.cert,
      gateway: gatewayUrl,
    };
  }

  /**
   * 认证已有 AID（login1 + login2 两阶段认证）。
   * 通过 well-known 发现 gateway → 调用 AuthFlow.authenticate。
   */
  async authenticate(params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = { ...(params ?? {}) };
    const aid = request.aid as string | undefined;

    const gatewayUrl = await this._resolveGateway(aid);
    this._client.gatewayUrl = gatewayUrl;

    const auth = this._internal._auth;
    const result = await auth.authenticate(gatewayUrl, aid);
    this._internal._aid = result.aid;
    this._internal._identity = await auth.loadIdentityOrNull(String(result.aid));

    return result; // 包含 aid, access_token, refresh_token, expires_at, gateway
  }

  /** 下载证书（透传 RPC） */
  async downloadCert(params?: Record<string, unknown>): Promise<unknown> {
    return this._client.call('auth.download_cert', params ?? {});
  }

  /** 请求签发证书（透传 RPC） */
  async requestCert(params: Record<string, unknown>): Promise<unknown> {
    return this._client.call('auth.request_cert', params);
  }

  /** 续期证书（透传 RPC） */
  async renewCert(params?: Record<string, unknown>): Promise<unknown> {
    return this._client.call('auth.renew_cert', params ?? {});
  }

  /** 密钥轮换（透传 RPC） */
  async rekey(params?: Record<string, unknown>): Promise<unknown> {
    return this._client.call('auth.rekey', params ?? {});
  }

  /** 获取信任根（透传 RPC） */
  async trustRoots(params?: Record<string, unknown>): Promise<unknown> {
    return this._client.call('meta.trust_roots', params ?? {});
  }
}
