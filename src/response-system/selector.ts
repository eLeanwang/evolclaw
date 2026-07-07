import type { ResponseMode, ResponseModeContext } from './types.js';
import type { ResponseModeRegistry } from './registry.js';

export interface ResponseModeInstance {
  id: string;
  engineType: 'v1' | 'v2';
  mode: ResponseMode | unknown;
}

/**
 * New response-system selector. It is intentionally small while V1 migration is
 * in progress; V2 modes can be added without changing user-facing mode ids.
 */
export class ResponseModeSelector {
  constructor(private registry: ResponseModeRegistry) {}

  async select(modeId: string, context: ResponseModeContext): Promise<ResponseModeInstance> {
    const mode = this.registry.get(modeId);
    if (!mode) {
      throw new Error(`[ResponseModeSelector] mode not found: ${modeId}`);
    }
    await mode.initialize(context);
    context.logger.debug('[ResponseSystem] selector selected mode=' + mode.id + ' engine=' + ((mode as any).engineType ?? 'v1'));
    return {
      id: mode.id,
      engineType: (mode as any).engineType ?? 'v1',
      mode,
    };
  }
}
