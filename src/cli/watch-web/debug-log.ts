/**
 * watch-web 调试日志 — 写入 $EVOLCLAW_HOME/logs/watch-web.log。
 *
 * cmdWatchWeb 启动时清空该文件并调用 setDebugLog 注入 writer，
 * 各 source / server 通过 dlog() 写调试信息，建立「运行→看日志→定位」的闭环。
 */

type Writer = (line: string) => void;

let _writer: Writer | null = null;

export function setDebugLog(writer: Writer | null): void {
  _writer = writer;
}

export function dlog(line: string): void {
  if (_writer) {
    try { _writer(line); } catch { /* ignore */ }
  }
}
