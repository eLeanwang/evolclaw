import type { CapabilityContext, CapabilityProvider, CapabilityRawItem, CapabilityType, CapabilityTypeState } from '../types.js';

export class GeminiCapabilityProvider implements CapabilityProvider {
  readonly baseagent = 'gemini';

  getSupport(type: CapabilityType): CapabilityTypeState {
    void type;
    return { mode: 'inherit', canUpdate: false, reason: 'Gemini capability 管理尚未接入' };
  }

  async discover(_ctx: CapabilityContext, _type: CapabilityType): Promise<CapabilityRawItem[]> {
    return [];
  }
}
