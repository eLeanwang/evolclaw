// ── RPC Transport（浏览器原生 WebSocket）──────────────────

import { EventDispatcher } from './events.js';
import {
  ConnectionError,
  SerializationError,
  TimeoutError,
  mapRemoteError,
} from './errors.js';

/** 协议事件名映射 */
const EVENT_NAME_MAP: Record<string, string> = {
  'message.received': 'message.received',
  'message.recalled': 'message.recalled',
  'message.ack': 'message.ack',
  'group.changed': 'group.changed',
};

/**
 * JSON-RPC 2.0 传输层 — 基于浏览器原生 WebSocket。
 *
 * 职责：
 * - 连接管理（connect / close）
 * - RPC 调用（call — 请求/响应匹配）
 * - 事件路由（服务端推送 → EventDispatcher）
 */
export class RPCTransport {
  private _dispatcher: EventDispatcher;
  private _timeout: number;
  private _onDisconnect: ((error: Error | null) => Promise<void>) | null;
  private _ws: WebSocket | null = null;
  private _closed = true;
  private _challenge: Record<string, unknown> | null = null;
  private _pending: Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = new Map();

  constructor(opts: {
    eventDispatcher: EventDispatcher;
    timeout?: number;
    onDisconnect?: ((error: Error | null) => Promise<void>) | null;
  }) {
    this._dispatcher = opts.eventDispatcher;
    this._timeout = opts.timeout ?? 10;
    this._onDisconnect = opts.onDisconnect ?? null;
  }

  /** 设置默认超时（秒） */
  setTimeout(timeout: number): void {
    this._timeout = timeout;
  }

  /** 获取连接时收到的 challenge */
  get challenge(): Record<string, unknown> | null {
    return this._challenge;
  }

  /**
   * 连接到 WebSocket URL。
   * 等待首条消息，若为 challenge 则返回，否则进入消息路由。
   */
  async connect(url: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this._ws = ws;
      this._closed = false;
      let initialResolved = false;

      ws.onopen = () => {
        // 连接已建立，等待首条消息
      };

      ws.onerror = (event) => {
        if (!initialResolved) {
          initialResolved = true;
          reject(new ConnectionError(`websocket connection failed to ${url}`));
        }
      };

      ws.onmessage = (event) => {
        if (!initialResolved) {
          // 首条消息：可能是 challenge
          initialResolved = true;
          try {
            const message = this._decodeMessage(event.data);
            if (message.method === 'challenge') {
              this._challenge = message;
              // 切换到正常消息路由
              ws.onmessage = (evt) => this._handleMessage(evt.data);
              ws.onclose = (evt) => this._handleClose(evt);
              ws.onerror = null;
              resolve(message);
            } else {
              // 非 challenge 消息，路由处理后返回 null
              ws.onmessage = (evt) => this._handleMessage(evt.data);
              ws.onclose = (evt) => this._handleClose(evt);
              ws.onerror = null;
              this._routeMessage(message);
              resolve(null);
            }
          } catch (err) {
            reject(err instanceof Error ? err : new ConnectionError(String(err)));
          }
          return;
        }
      };

      ws.onclose = (event) => {
        if (!initialResolved) {
          initialResolved = true;
          reject(new ConnectionError(`websocket closed before initial message: code=${event.code}`));
        }
      };
    });
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    this._closed = true;
    if (this._ws) {
      try {
        this._ws.onclose = null;
        this._ws.onerror = null;
        this._ws.onmessage = null;
        this._ws.close();
      } catch {
        // 忽略关闭异常
      }
      this._ws = null;
    }

    // 拒绝所有待处理的 RPC 调用
    for (const [, pending] of this._pending) {
      pending.reject(new ConnectionError('transport closed'));
    }
    this._pending.clear();
  }

  /**
   * 发起 JSON-RPC 2.0 调用。
   * 返回 result 字段的值；若有 error 字段则抛出映射后的错误。
   */
  async call(
    method: string,
    params?: Record<string, unknown> | null,
    timeout?: number,
  ): Promise<unknown> {
    if (this._closed || !this._ws) {
      throw new ConnectionError('transport not connected');
    }

    // 生成唯一 RPC ID
    const rpcId = `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const effectiveTimeout = (timeout ?? this._timeout) * 1000;

    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this._pending.set(rpcId, { resolve, reject });
    });

    // 发送请求
    try {
      this._ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method,
        params: params ?? {},
      }));
    } catch (exc) {
      this._pending.delete(rpcId);
      throw new ConnectionError(`failed to send rpc ${method}: ${exc}`);
    }

    // 超时控制
    const timeoutPromise = new Promise<never>((_, reject) => {
      globalThis.setTimeout(() => {
        this._pending.delete(rpcId);
        reject(new TimeoutError(`rpc timeout: ${method}`, { retryable: true }));
      }, effectiveTimeout);
    });

    const response = await Promise.race([promise, timeoutPromise]);

    if ('error' in response) {
      throw mapRemoteError(response.error as Record<string, unknown>);
    }
    return response.result;
  }

  // ── 内部消息处理 ──────────────────────────────────

  private _handleMessage(data: unknown): void {
    try {
      const message = this._decodeMessage(data);
      this._routeMessage(message);
    } catch (exc) {
      console.warn('消息解码异常:', exc);
    }
  }

  private _handleClose(event: CloseEvent): void {
    const wasClosed = this._closed;
    this._closed = true;

    // 拒绝所有待处理调用
    for (const [, pending] of this._pending) {
      pending.reject(new ConnectionError(`websocket closed: code=${event.code}`));
    }
    this._pending.clear();

    // 非主动关闭时触发断线回调
    if (!wasClosed) {
      const error = new ConnectionError(`websocket closed: code=${event.code} reason=${event.reason}`);
      this._dispatcher.publish('connection.error', { error });
      if (this._onDisconnect) {
        this._onDisconnect(error).catch(() => {});
      }
    }
  }

  private _routeMessage(message: Record<string, unknown>): void {
    // RPC 响应（有 id 字段）
    if ('id' in message) {
      const rpcId = String(message.id);
      const pending = this._pending.get(rpcId);
      if (pending) {
        this._pending.delete(rpcId);
        pending.resolve(message);
      }
      return;
    }

    const method = String(message.method ?? '');

    // challenge 消息
    if (method === 'challenge') {
      this._challenge = message;
      this._dispatcher.publish('connection.challenge', (message.params ?? {}) as Record<string, unknown>);
      return;
    }

    // 事件推送
    if (method.startsWith('event/')) {
      const protocolEvent = method.slice(6);
      const sdkEvent = EVENT_NAME_MAP[protocolEvent] ?? protocolEvent;
      // 发布为 _raw.{event}，由 AUNClient 处理后再发布用户可见的事件
      this._dispatcher.publish(`_raw.${sdkEvent}`, (message.params ?? {}) as Record<string, unknown>);
      return;
    }

    // 其他通知
    this._dispatcher.publish('notification', message);
  }

  private _decodeMessage(raw: unknown): Record<string, unknown> {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    if (typeof raw !== 'string') {
      throw new SerializationError(`unsupported websocket payload type: ${typeof raw}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new SerializationError('invalid json payload');
    }
  }
}
