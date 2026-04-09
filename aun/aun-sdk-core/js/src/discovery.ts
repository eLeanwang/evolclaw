// ── Gateway 发现（浏览器 fetch API）──────────────────────

import { ConnectionError, ValidationError } from './errors.js';

/**
 * Gateway 发现服务 — 通过 .well-known 端点发现 Gateway WebSocket URL。
 *
 * 使用浏览器 fetch() API，不依赖任何 Node.js 模块。
 */
export class GatewayDiscovery {
  /**
   * 从 well-known URL 发现 Gateway WebSocket 地址。
   *
   * 响应格式: { gateways: [{ url: "wss://...", priority: 1 }, ...] }
   * 选择 priority 最小的网关。
   */
  async discover(wellKnownUrl: string, timeout = 5000): Promise<string> {
    let payload: Record<string, unknown>;
    try {
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), timeout);

      const response = await fetch(wellKnownUrl, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      payload = (await response.json()) as Record<string, unknown>;
    } catch (exc) {
      throw new ConnectionError(
        `gateway discovery failed for ${wellKnownUrl}: ${exc}`,
        { retryable: true },
      );
    }

    const gateways = payload.gateways;
    if (!Array.isArray(gateways) || gateways.length === 0) {
      throw new ValidationError('well-known returned empty gateways');
    }

    // 按 priority 排序（低优先级数字 = 高优先级）
    const sorted = [...gateways].sort(
      (a: Record<string, unknown>, b: Record<string, unknown>) =>
        (Number(a.priority ?? 999)) - (Number(b.priority ?? 999)),
    );

    const url = sorted[0]?.url;
    if (!url) {
      throw new ValidationError('well-known missing gateway url');
    }

    return String(url);
  }
}
