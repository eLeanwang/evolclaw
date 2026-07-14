import type { ResponseModeRegistry } from '../registry.js';
import { SingleSessionMode } from './single-session/index.js';

export function registerBuiltinModes(registry: ResponseModeRegistry): void {
  // single-session 为首选响应模式（responseMode 解析链的最终兜底）。
  // 合并了原 interactive/proactive——投递方式由 chatMode 参数决定，不再是独立模式。
  registry.registerBuiltin(new SingleSessionMode(), true);
}

export { SingleSessionMode } from './single-session/index.js';
