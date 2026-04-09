/**
 * AUN SDK 事件调度器
 *
 * 与 Python SDK 的 EventDispatcher 完全对齐：订阅、取消订阅、发布。
 */

export type EventHandler = (payload: unknown) => void | Promise<void>;

/**
 * 订阅句柄，调用 unsubscribe() 取消订阅。
 */
export class Subscription {
  private _dispatcher: EventDispatcher;
  private _event: string;
  private _handler: EventHandler;
  private _active = true;

  /** @internal */
  constructor(dispatcher: EventDispatcher, event: string, handler: EventHandler) {
    this._dispatcher = dispatcher;
    this._event = event;
    this._handler = handler;
  }

  /** 取消该订阅 */
  unsubscribe(): void {
    if (!this._active) return;
    this._dispatcher.unsubscribe(this._event, this._handler);
    this._active = false;
  }
}

/**
 * 事件调度器：管理事件处理器的注册与派发。
 */
export class EventDispatcher {
  private _handlers: Map<string, EventHandler[]> = new Map();

  /** 订阅指定事件，返回 Subscription 句柄 */
  subscribe(event: string, handler: EventHandler): Subscription {
    let handlers = this._handlers.get(event);
    if (!handlers) {
      handlers = [];
      this._handlers.set(event, handlers);
    }
    handlers.push(handler);
    return new Subscription(this, event, handler);
  }

  /** 移除指定事件的指定处理器 */
  unsubscribe(event: string, handler: EventHandler): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    const filtered = handlers.filter((h) => h !== handler);
    if (filtered.length === 0) {
      this._handlers.delete(event);
    } else {
      this._handlers.set(event, filtered);
    }
  }

  /** 发布事件，按注册顺序调用所有处理器（支持异步） */
  async publish(event: string, payload: unknown): Promise<void> {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    // 复制列表，防止迭代期间修改
    const snapshot = [...handlers];
    for (const handler of snapshot) {
      try {
        const result = handler(payload);
        // 如果返回了 Promise，等待其完成
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result;
        }
      } catch (exc) {
        // 与 Python SDK 一致：处理器异常不阻断其他处理器
        console.warn(
          `事件 ${event} 处理器 ${handler.name || '<anonymous>'} 执行异常:`,
          exc,
        );
      }
    }
  }
}
