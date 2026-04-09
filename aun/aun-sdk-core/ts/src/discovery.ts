/**
 * Gateway 发现
 *
 * 通过 HTTPS GET 请求 well-known URL 获取 Gateway 列表，
 * 按优先级排序后返回最优 Gateway 的 WebSocket URL。
 *
 * 与 Python SDK 的 GatewayDiscovery 完全对齐。
 */

import { ConnectionError, ValidationError } from './errors.js';

export class GatewayDiscovery {
  private _verifySsl: boolean;

  constructor(opts?: { verifySsl?: boolean }) {
    this._verifySsl = opts?.verifySsl ?? true;
  }

  /**
   * 从 well-known URL 发现 Gateway。
   *
   * @param wellKnownUrl - well-known 发现端点（如 https://alice.aid.com/.well-known/aun-gateway）
   * @param timeout - 请求超时（毫秒，默认 5000）
   * @returns Gateway WebSocket URL
   */
  async discover(wellKnownUrl: string, timeout = 5_000): Promise<string> {
    let payload: Record<string, unknown>;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      // 使用 Node.js 内置 fetch（18+ 支持）
      // 注意：verify_ssl=false 时需要设置 NODE_TLS_REJECT_UNAUTHORIZED=0 环境变量
      // 或通过自定义 Agent。这里仅标记，实际禁用需在应用层处理。
      const response = await fetch(wellKnownUrl, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      payload = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      throw new ConnectionError(
        `gateway discovery failed for ${wellKnownUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    }

    const gateways = payload.gateways;
    if (!Array.isArray(gateways) || gateways.length === 0) {
      throw new ValidationError('well-known returned empty gateways');
    }

    // 按 priority 排序（数值越小优先级越高）
    const sorted = [...gateways].sort(
      (a, b) => (Number(a?.priority ?? 999)) - (Number(b?.priority ?? 999)),
    );

    const url = sorted[0]?.url;
    if (!url || typeof url !== 'string') {
      throw new ValidationError('well-known missing gateway url');
    }
    return url;
  }
}
