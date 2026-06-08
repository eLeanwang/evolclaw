/**
 * WatchSource — 统一数据源抽象。
 *
 * 三个 watch 视图（aid / msg / session）各实现一遍：
 * - snapshot(params): 当前全量快照
 * - subscribe(params, push): 注册变更回调，返回取消订阅函数
 *
 * aid/cache 走 IPC 轮询（无推送），msg/session 走 fs.watch 文件监听。
 */

export type ViewKind = 'aid' | 'msg' | 'session' | 'cache' | 'control';

export interface WatchSource {
  readonly kind: ViewKind;
  snapshot(params?: Record<string, any>): Promise<any>;
  subscribe(params: Record<string, any>, push: (data: any) => void): () => void;
}
