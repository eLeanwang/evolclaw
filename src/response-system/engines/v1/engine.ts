import type { ResponseMode, ResponseModeContext, InboundMessage, InboundDecision, OutboundPayload, OutboundDecision } from '../../types.js';
import { ResponseModeRegistry } from '../../registry.js';

/**
 * V1 engine wraps the existing response-mode contract inside the new
 * response-system layout. It is intentionally thin: V1 modes still own their
 * inbound/outbound decisions and hooks.
 */
export class V1Engine {
  private registry = new ResponseModeRegistry();
  private currentMode?: ResponseMode;

  register(mode: ResponseMode): void {
    if (mode.type === 'builtin') {
      this.registry.registerBuiltin(mode);
    } else {
      this.registry.registerExtension(mode);
    }
  }

  getMode(id: string): ResponseMode | undefined {
    return this.registry.get(id);
  }

  listModes(scene?: 'private' | 'group'): ResponseMode[] {
    return this.registry.list(scene);
  }

  async selectMode(modeId: string, context: ResponseModeContext): Promise<ResponseMode> {
    const mode = this.registry.get(modeId);
    if (!mode) {
      throw new Error(`[V1Engine] mode not found: ${modeId}`);
    }
    await mode.initialize(context);
    this.currentMode = mode;
    return mode;
  }

  async processInbound(message: InboundMessage): Promise<InboundDecision> {
    if (!this.currentMode) {
      throw new Error('[V1Engine] no mode selected');
    }
    return this.currentMode.handleInbound(message);
  }

  async processOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    if (!this.currentMode) {
      throw new Error('[V1Engine] no mode selected');
    }
    return this.currentMode.handleOutbound(payload);
  }
}
