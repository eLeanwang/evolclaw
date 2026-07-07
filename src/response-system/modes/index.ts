import type { ResponseModeRegistry } from '../registry.js';
import { InteractiveMode } from './interactive/index.js';
import { ProactiveMode } from './proactive/index.js';

export function registerBuiltinModes(registry: ResponseModeRegistry): void {
  registry.registerBuiltin(new InteractiveMode());
  registry.registerBuiltin(new ProactiveMode());
}

export { InteractiveMode } from './interactive/index.js';
export { ProactiveMode } from './proactive/index.js';
