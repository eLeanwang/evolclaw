import { describe, it, expect, beforeEach } from 'vitest';
import { InteractiveMode } from '../../src/response-system/modes/interactive/index.js';
import { ProactiveMode } from '../../src/response-system/modes/proactive/index.js';
import { ResponseModeRegistry } from '../../src/response-system/registry.js';
import { registerBuiltinModes } from '../../src/response-system/modes/index.js';
import type { ResponseModeContext, InboundMessage, OutboundPayload } from '../../src/response-system/types.js';

const inbound = (chatType: 'private' | 'group'): InboundMessage => ({
  peerId: 'p1', content: 'hi', chatType,
});

function ctxWith(supportsThought: boolean, modeConfig: any = {}): ResponseModeContext {
  return {
    session: {} as any,
    agentConfig: {} as any,
    modeConfig,
    runner: {} as any,
    channel: {
      type: 'aun',
      capabilities: { supportsThought, supportsInteraction: true, supportsRichText: true, supportsFile: true, supportsImage: true },
      send: async () => {},
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sessionState: new Map(),
    dataDir: '/tmp',
    createAuxiliarySession: async () => { throw new Error('n/a'); },
  };
}

describe('InteractiveMode', () => {
  let mode: InteractiveMode;
  beforeEach(async () => { mode = new InteractiveMode(); await mode.initialize(ctxWith(true)); });

  it('metadata', () => {
    expect(mode.id).toBe('interactive');
    expect(mode.type).toBe('builtin');
    expect(mode.applicableScenes).toContain('private');
  });

  it('inbound always process+enqueue', async () => {
    const d = await mode.handleInbound(inbound('private'));
    expect(d.action).toBe('process');
    expect(d.queueBehavior).toBe('enqueue');
  });

  it('outbound always direct message', async () => {
    const d = await mode.handleOutbound({ kind: 'result.text', text: 'hi', isFinal: true } as OutboundPayload);
    expect(d.method).toBe('direct');
    expect(d.type).toBe('message');
  });

  it('afterProcess delegates file markers to engine', async () => {
    let calledWith: string | undefined;
    const ctx = {
      session: {} as any,
      fullText: 'reply [SEND_FILE:/tmp/a.png] done',
      streamResult: { hasReceivedText: true },
      send: async () => {},
      channelCapabilities: { file: true, thought: false },
      processFileMarkers: async (text: string) => { calledWith = text; return 1; },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    await mode.afterProcess!(ctx as any);
    expect(calledWith).toBe('reply [SEND_FILE:/tmp/a.png] done');
  });
});

describe('ProactiveMode', () => {
  it('inbound carries proactive runtimeState', async () => {
    const mode = new ProactiveMode();
    await mode.initialize(ctxWith(true, { pre_tool_1stmsgchk: true, tool_use_reminder: false }));
    const d = await mode.handleInbound(inbound('group'));
    expect(d.action).toBe('process');
    expect(d.runtimeState?.proactive).toMatchObject({
      firstToolDone: false,
      chatType: 'group',
      preTool1stMsgChk: true,
      toolUseReminder: false,
    });
  });

  it('activity.batch → thought when channel supports it', async () => {
    const mode = new ProactiveMode();
    await mode.initialize(ctxWith(true));
    const d = await mode.handleOutbound({ kind: 'activity.batch', items: [] } as OutboundPayload);
    expect(d.method).toBe('direct');
    expect(d.type).toBe('thought');
  });

  it('activity.batch → suppress when channel lacks thought', async () => {
    const mode = new ProactiveMode();
    await mode.initialize(ctxWith(false));
    const d = await mode.handleOutbound({ kind: 'activity.batch', items: [] } as OutboundPayload);
    expect(d.method).toBe('suppress');
  });

  it('status payload → direct message', async () => {
    const mode = new ProactiveMode();
    await mode.initialize(ctxWith(true));
    const d = await mode.handleOutbound({ kind: 'status.started' } as OutboundPayload);
    expect(d.method).toBe('direct');
    expect(d.type).toBe('message');
  });

  it('defaults pre_tool_1stmsgchk/tool_use_reminder to true', async () => {
    const mode = new ProactiveMode();
    await mode.initialize(ctxWith(true, {}));
    const d = await mode.handleInbound(inbound('private'));
    expect(d.runtimeState?.proactive.preTool1stMsgChk).toBe(true);
    expect(d.runtimeState?.proactive.toolUseReminder).toBe(true);
  });
});

describe('registerBuiltinModes', () => {
  it('registers single-session + interactive + proactive (过渡期并存)', () => {
    const reg = new ResponseModeRegistry();
    registerBuiltinModes(reg);
    expect(reg.get('single-session')?.id).toBe('single-session');
    expect(reg.get('interactive')?.id).toBe('interactive');
    expect(reg.get('proactive')?.id).toBe('proactive');
    // 步骤 7 删除 interactive/proactive 后此数应回落到 1
    expect(reg.list().length).toBe(3);
  });
});
