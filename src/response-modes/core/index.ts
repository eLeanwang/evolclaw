/**
 * 内置响应模式注册。
 *
 * 提供 registerBuiltinModes()：把所有内置模式注册到给定 registry。
 * 当前内置模式（现有机制的插件化迁移）：
 *   - interactive：交互模式（人机单聊默认）
 *   - proactive：主动模式（Agent 对话默认）
 *
 * 未来的扩展模式（dual-session/workflow 等）逐个独立实现后在此追加。
 */

import type { ResponseModeRegistry } from '../registry.js';
import { InteractiveMode } from './interactive.js';
import { ProactiveMode } from './proactive.js';

export function registerBuiltinModes(registry: ResponseModeRegistry): void {
  registry.registerBuiltin(new InteractiveMode());
  registry.registerBuiltin(new ProactiveMode());
}

export { InteractiveMode } from './interactive.js';
export { ProactiveMode } from './proactive.js';
