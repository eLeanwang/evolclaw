import type { ResponseModeRegistry } from '../registry.js';
import { InteractiveMode } from './interactive/index.js';
import { ProactiveMode } from './proactive/index.js';
import { SingleSessionMode } from './single-session/index.js';

export function registerBuiltinModes(registry: ResponseModeRegistry): void {
  registry.registerBuiltin(new SingleSessionMode());
  // 过渡期并存：interactive/proactive 在步骤 7 删除
  registry.registerBuiltin(new InteractiveMode());
  registry.registerBuiltin(new ProactiveMode());
}

export { SingleSessionMode } from './single-session/index.js';
export { InteractiveMode } from './interactive/index.js';
export { ProactiveMode } from './proactive/index.js';
