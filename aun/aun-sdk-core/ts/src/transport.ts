/**
 * RPC 传输层
 *
 * 基于 WebSocket（ws 包）的 JSON-RPC 2.0 传输层。
 * 与 Python SDK 的 RPCTransport 完全对齐：
 * - connect → 接收初始 challenge
 * - call → 请求/响应匹配
 * - 事件路由 → EventDispatcher
 */

import WebSocket from 'ws';

import { ConnectionError, SerializationError, TimeoutError, mapRemoteError } from './errors.js';
import type { EventDispatcher } from './events.js';

/** 协议事件名映射 */
const EVENT_NAME_MAP: Record<string, string> = {
  'message.received': 'message.received',
  'message.recalled': 'message.recalled',
  'message.ack': 'message.ack',
  'group.changed': 'group.changed',
};

/** 断线回调 */
export type DisconnectCallback = (error: Error | null) => void | Promise<void>;

/**
 * WebSocket JSON-RPC 2.0 传输层
 */
export class RPCTransport {
  private _dispatcher: EventDispatcher;
  private _timeout: number;
  private _onDisconnect: DisconnectCallback | null;
  private _ws: WebSocket | null = null;
  private _closed = true;
  private _challenge: Record<string, unknown> | null = null;
  private _pending: Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private _idCounter = 0;

  constructor(opts: {
    eventDispatcher: EventDispatcher;
    timeout?: number;
    onDisconnect?: DisconnectCallback | null;
  }) {
    this._dispatcher = opts.eventDispatcher;
    this._timeout = opts.timeout ?? 10_000;
    this._onDisconnect = opts.onDisconnect ?? null;
  }

  /** 设置默认 RPC 超时（毫秒） */
  setTimeout(timeout: number): void {
    this._timeout = timeout;
  }

  /** 获取上次连接的 challenge 消息 */
  get challenge(): Record<string, unknown> | null {
    return this._challenge;
  }

  /**
   * 连接到 Gateway WebSocket 端点。
   * 返回初始 challenge 消息（如果有）。
   */
  async connect(url: string): Promise<Record<string, unknown> | null> {
    return new Promise<Record<string, unknown> | null>((resolve, reject) => {
      const ws = new WebSocket(url);
      let initialResolved = false;

      ws.on('error', (err) => {
        if (!initialResolved) {
          initialResolved = true;
          reject(new ConnectionError(`websocket connect failed: ${err.message}`));
        }
      });

      ws.on('open', () => {
        this._ws = ws;
        this._closed = false;
        // 等待第一条消息作为 challenge
      });

      ws.on('message', (data) => {
        if (!initialResolved) {
          // 第一条消息：尝试解析为 challenge
          initialResolved = true;
          try {
            const message = this._decodeMessage(data);
            if (message.method === 'challenge') {
              this._challenge = message;
              this._setupListeners(ws);
              resolve(message);
            } else {
              this._challenge = null;
              this._setupListeners(ws);
              // 非 challenge 消息，路由处理后返回 null
              this._routeMessage(message);
              resolve(null);
            }
          } catch (err) {
            reject(err instanceof Error ? err : new SerializationError(String(err)));
          }
          return;
        }
        // 后续消息由 _setupListeners 处理
      });

      // 连接超时处理
      const connectTimeout = setTimeout(() => {
        if (!initialResolved) {
          initialResolved = true;
          ws.close();
          reject(new ConnectionError('websocket connect timeout'));
        }
      }, 10_000);

      ws.on('open', () => clearTimeout(connectTimeout));
    });
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    this._closed = true;
    // 取消所有待处理的 RPC
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionError('transport closed'));
    }
    this._pending.clear();

    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      return new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        try {
          ws.close();
        } catch {
          resolve();
        }
        // 超时强制解析
        setTimeout(() => resolve(), 3_000);
      });
    }
  }

  /**
   * 发送 JSON-RPC 2.0 请求并等待响应。
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
    timeout?: number,
  ): Promise<unknown> {
    if (this._closed || !this._ws) {
      throw new ConnectionError('transport not connected');
    }

    const rpcId = `rpc-${String(++this._idCounter).padStart(5, '0')}`;
    const effectiveTimeout = timeout ?? this._timeout;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(rpcId);
        reject(new TimeoutError(`rpc timeout: ${method}`, { retryable: true }));
      }, effectiveTimeout);

      this._pending.set(rpcId, {
        resolve: (response) => {
          clearTimeout(timer);
          if ('error' in response) {
            reject(mapRemoteError(response.error as Record<string, unknown>));
          } else {
            resolve(response.result);
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method,
        params: params ?? {},
      });

      try {
        this._ws!.send(payload);
      } catch (err) {
        this._pending.delete(rpcId);
        clearTimeout(timer);
        reject(
          new ConnectionError(
            `failed to send rpc ${method}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  // ── 内部方法 ────────────────────────────────────────────

  /** 设置 WebSocket 监听器（首条消息已处理后调用） */
  private _setupListeners(ws: WebSocket): void {
    ws.on('message', (data) => {
      try {
        const message = this._decodeMessage(data);
        this._routeMessage(message);
      } catch (err) {
        // 解析异常，发布错误事件
        this._dispatcher.publish('connection.error', { error: err });
      }
    });

    ws.on('close', () => {
      const wasClosed = this._closed;
      this._closed = true;
      if (!wasClosed && this._onDisconnect) {
        const cb = this._onDisconnect;
        Promise.resolve(cb(null)).catch(() => {});
      }
    });

    ws.on('error', (err) => {
      if (!this._closed) {
        this._dispatcher.publish('connection.error', { error: err });
      }
    });
  }

  /** 路由消息：RPC 响应 / challenge / 事件 / 通知 */
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

    // Challenge 消息
    if (method === 'challenge') {
      this._challenge = message;
      this._dispatcher.publish('connection.challenge', message.params ?? {});
      return;
    }

    // 事件消息（event/ 前缀）
    if (method.startsWith('event/')) {
      const protocolEvent = method.slice('event/'.length);
      const sdkEvent = EVENT_NAME_MAP[protocolEvent] ?? protocolEvent;
      // 发布为 _raw.{event}，由 AUNClient 处理后再发布用户可见的事件
      this._dispatcher.publish(`_raw.${sdkEvent}`, message.params ?? {});
      return;
    }

    // 其他通知
    this._dispatcher.publish('notification', message);
  }

  /** 解码 WebSocket 消息为 JSON 对象 */
  private _decodeMessage(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof ArrayBuffer)) {
      return raw as Record<string, unknown>;
    }
    let str: string;
    if (Buffer.isBuffer(raw)) {
      str = raw.toString('utf-8');
    } else if (raw instanceof ArrayBuffer) {
      str = Buffer.from(raw).toString('utf-8');
    } else if (typeof raw === 'string') {
      str = raw;
    } else {
      throw new SerializationError(`unsupported websocket payload type: ${typeof raw}`);
    }
    try {
      return JSON.parse(str);
    } catch {
      throw new SerializationError('invalid json payload');
    }
  }
}
