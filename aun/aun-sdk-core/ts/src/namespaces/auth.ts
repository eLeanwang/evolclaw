/**
 * Auth 命名空间
 *
 * 提供 auth.createAid / auth.authenticate 等高层方法，
 * 内部通过 AUNClient 的 transport、auth、discovery 完成实际流程。
 *
 * 与 Python SDK 的 AuthNamespace 完全对齐。
 */

import { ValidationError } from '../errors.js';
import type { AUNClient } from '../client.js';

export class AuthNamespace {
  private _client: AUNClient;

  constructor(client: AUNClient) {
    this._client = client;
  }

  /**
   * 解析 Gateway URL。
   * 优先使用已预置的 _gatewayUrl，否则基于 AID 自动发现。
   *
   * 发现流程：
   * 1. 若 _gatewayUrl 已预置，直接返回
   * 2. https://{aid}/.well-known/aun-gateway（泛域名 nameservice）
   * 3. https://gateway.{issuer}/.well-known/aun-gateway（Gateway 直连）
   */
  async _resolveGateway(aid?: string): Promise<string> {
    // 访问内部属性
    const client = this._client as unknown as Record<string, unknown>;
    const gatewayUrl = client._gatewayUrl as string | null;
    if (gatewayUrl) return gatewayUrl;

    const resolvedAid = aid ?? (client._aid as string | null);
    if (resolvedAid) {
      const parts = resolvedAid.split('.');
      const issuerDomain = parts.length > 1 ? parts.slice(1).join('.') : resolvedAid;

      const configModel = client._configModel as Record<string, unknown>;
      const port = configModel.discoveryPort as number | null;
      const portSuffix = port ? `:${port}` : '';

      const primaryUrl = `https://${resolvedAid}${portSuffix}/.well-known/aun-gateway`;
      const discovery = client._discovery as { discover: (url: string) => Promise<string> };

      try {
        return await discovery.discover(primaryUrl);
      } catch {
        // 主路径失败，尝试 fallback
      }

      const fallbackUrl = `https://gateway.${issuerDomain}${portSuffix}/.well-known/aun-gateway`;
      return await discovery.discover(fallbackUrl);
    }

    throw new ValidationError(
      "unable to resolve gateway: set client._gatewayUrl or provide 'aid' for auto-discovery",
    );
  }

  /** 创建新 AID */
  async createAid(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const aid = String(params?.aid ?? '');
    if (!aid) throw new Error("auth.create_aid requires 'aid'");

    const client = this._client as unknown as Record<string, unknown>;
    const gatewayUrl = await this._resolveGateway(aid);
    client._gatewayUrl = gatewayUrl;

    const auth = client._auth as { createAid: (url: string, aid: string) => Promise<Record<string, unknown>>; loadIdentityOrNone: (aid: string) => Record<string, unknown> | null };
    const result = await auth.createAid(gatewayUrl, aid);
    client._aid = result.aid;
    client._identity = auth.loadIdentityOrNone(String(result.aid));

    return {
      aid: result.aid,
      cert_pem: result.cert,
      gateway: gatewayUrl,
    };
  }

  /** 认证（登录） */
  async authenticate(params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = { ...(params ?? {}) };
    const aid = request.aid as string | undefined;

    const client = this._client as unknown as Record<string, unknown>;
    const gatewayUrl = await this._resolveGateway(aid);
    client._gatewayUrl = gatewayUrl;

    const auth = client._auth as { authenticate: (url: string, opts?: { aid?: string }) => Promise<Record<string, unknown>>; loadIdentityOrNone: (aid: string) => Record<string, unknown> | null };
    const result = await auth.authenticate(gatewayUrl, { aid });
    client._aid = result.aid;
    client._identity = auth.loadIdentityOrNone(String(result.aid));

    return result;
  }

  /** 下载证书 */
  async downloadCert(params?: Record<string, unknown>): Promise<unknown> {
    return await this._client.call('auth.download_cert', params ?? {});
  }

  /** 请求签发证书 */
  async requestCert(params: Record<string, unknown>): Promise<unknown> {
    return await this._client.call('auth.request_cert', params);
  }

  /** 续期证书 */
  async renewCert(params?: Record<string, unknown>): Promise<unknown> {
    return await this._client.call('auth.renew_cert', params ?? {});
  }

  /** 密钥轮换 */
  async rekey(params?: Record<string, unknown>): Promise<unknown> {
    return await this._client.call('auth.rekey', params ?? {});
  }

  /** 获取信任根证书列表 */
  async trustRoots(params?: Record<string, unknown>): Promise<unknown> {
    return await this._client.call('meta.trust_roots', params ?? {});
  }
}
