/**
 * WatchSource — 统一的数据源抽象。
 *
 * 三个 watch 视图（aid / msg / session）各实现一遍：
 * - snapshot(params): 返回当前全量快照（首次订阅 / 切换选择时）
 * - subscribe(params, push): 注册变更回调，返回取消订阅的函数
 *
 * aid 走 IPC 轮询（无推送能力），msg/session 走 fs.watch 文件监听。
 */

export type ViewKind = 'aid' | 'msg' | 'session';

export interface WatchSource {
  readonly kind: ViewKind;
  /** 全量快照 */
  snapshot(params?: Record<string, any>): Promise<any>;
  /** 订阅变更；push 在数据变化时被调用，返回取消订阅函数 */
  subscribe(params: Record<string, any>, push: (data: any) => void): () => void;
}
