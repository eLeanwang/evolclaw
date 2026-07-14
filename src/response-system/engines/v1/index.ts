/**
 * V1 引擎 —— 单会话处理行为的载体。
 *
 * 对外只暴露 flowForChatMode：按 chatMode 取对应流（interactive / proactive）。
 * chatMode 分流收拢于此，模式层（modes/single-session）与调用方不再散布分支。
 */

import type { V1Flow } from './types.js';
import { interactiveFlow } from './interactive-flow.js';
import { proactiveFlow } from './proactive-flow.js';

const FLOWS: Record<'interactive' | 'proactive', V1Flow> = {
  interactive: interactiveFlow,
  proactive: proactiveFlow,
};

/** 按 chatMode 取处理流。 */
export function flowForChatMode(chatMode: 'interactive' | 'proactive'): V1Flow {
  const flow = FLOWS[chatMode];
  if (!flow) throw new Error(`[V1Engine] unknown chatMode: ${chatMode}`);
  return flow;
}

export { interactiveFlow } from './interactive-flow.js';
export { proactiveFlow } from './proactive-flow.js';
export type { V1Flow } from './types.js';
export type { ProactiveState } from './proactive-flow.js';
