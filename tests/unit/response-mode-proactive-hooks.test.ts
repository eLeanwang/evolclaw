import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProactiveMode } from '../../src/response-modes/core/proactive.js';
import type {
  ResponseModeContext, InboundMessage, ProcessContext, ToolUseContext,
  CompleteContext, AfterProcessContext,
} from '../../src/response-modes/types.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function modeWithCtx(modeConfig: any = {}): ProactiveMode {
  const mode = new ProactiveMode();
  mode.initialize({
    session: {} as any, agentConfig: {} as any, modeConfig,
    runner: {} as any,
    channel: { type: 'aun', capabilities: { supportsThought: true, supportsInteraction: true, supportsRichText: true, supportsFile: true, supportsImage: true }, send: async () => {} },
    logger, sessionState: new Map(), dataDir: '/tmp',
    createAuxiliarySession: async () => { throw new Error('n/a'); },
  } as ResponseModeContext);
  return mode;
}

const inbound = (chatType: 'private' | 'group', source?: string, peerType?: string): InboundMessage =>
  ({ peerId: 'p1', content: 'hi', chatType, source, peerType });

function procCtx(message: InboundMessage, state: Map<string, any>, isSendCommand = (_: string, __: any) => false, modeConfig: any = {}): ProcessContext {
  return { session: {} as any, message, modeConfig, state, isSendCommand, logger };
}

describe('ProactiveMode.beforeProcess (迁移点1: runtimeState)', () => {
  it('writes proactive state to ctx.state', () => {
    const mode = modeWithCtx({ pre_tool_1stmsgchk: true, tool_use_reminder: false });
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('group'), state, undefined, { pre_tool_1stmsgchk: true, tool_use_reminder: false }));
    expect(state.get('proactive')).toMatchObject({
      firstToolDone: false, toolCount: 0, chatType: 'group',
      preTool1stMsgChk: true, toolUseReminder: false,
      firstSendRequired: true, toolReportRequired: false,
    });
  });

  it('defaults preTool1stMsgChk/toolUseReminder to true', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private', undefined, 'human'), state, undefined, {}));
    expect(state.get('proactive').preTool1stMsgChk).toBe(true);
    expect(state.get('proactive').toolUseReminder).toBe(true);
    expect(state.get('proactive').firstSendRequired).toBe(true);
  });
});

describe('ProactiveMode.configureRun (迁移点2: policyHook 首工具表态)', () => {
  it('no policyHook when first-send and tool-report policies are both off', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private', undefined, 'human'), state, undefined, { pre_tool_1stmsgchk: false, tool_use_reminder: false }));
    const cfg = mode.configureRun(procCtx(inbound('private', undefined, 'human'), state, undefined, { pre_tool_1stmsgchk: false, tool_use_reminder: false }));
    expect(cfg).toBeUndefined();
  });

  it('first non-send tool is blocked', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('group'), state, (name) => name === 'EcSend', { pre_tool_1stmsgchk: true });
    mode.beforeProcess(ctx);
    const cfg = mode.configureRun(ctx)!;
    const result = cfg.policyHook!('Bash', {});
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('ec group send');
    expect(state.get('proactive').firstToolDone).toBe(false);
  });

  it('first send-command tool is allowed', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('private', undefined, 'human'), state, (name) => name === 'EcSend', { pre_tool_1stmsgchk: true });
    mode.beforeProcess(ctx);
    const cfg = mode.configureRun(ctx)!;
    expect(cfg.policyHook!('EcSend', {})).toBeUndefined();
    expect(state.get('proactive').firstToolDone).toBe(true);
  });

  it('does not enforce first-send when only tool-report policy is enabled', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('private', undefined, 'human'), state, () => false, { pre_tool_1stmsgchk: false, tool_use_reminder: true });
    mode.beforeProcess(ctx);
    const cfg = mode.configureRun(ctx)!;
    expect(cfg.policyHook!('Bash', {})).toBeUndefined();
  });

  it('keeps blocking non-send tools until a send command succeeds', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('private', undefined, 'human'), state, (name) => name === 'EcSend', { pre_tool_1stmsgchk: true });
    mode.beforeProcess(ctx);
    const cfg = mode.configureRun(ctx)!;
    expect(cfg.policyHook!('Bash', {})?.block).toBe(true);
    expect(state.get('proactive').firstToolDone).toBe(false);
    expect(cfg.policyHook!('Bash', {})?.block).toBe(true);
    expect(cfg.policyHook!('EcSend', {})).toBeUndefined();
    expect(state.get('proactive').firstToolDone).toBe(true);
    expect(cfg.policyHook!('Bash', {})).toBeUndefined();
  });

  it('trigger source exempt from first-tool enforcement', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('group', 'trigger', 'human'), state, () => false, { pre_tool_1stmsgchk: true });
    mode.beforeProcess(ctx);
    expect(mode.configureRun(ctx)).toBeUndefined();
  });

  it('private non-human peers are exempt from first-tool enforcement', () => {
    const mode = modeWithCtx();
    for (const peerType of ['ai', 'system', 'unknown', undefined]) {
      const state = new Map();
      const ctx = procCtx(inbound('private', undefined, peerType), state, () => false, { pre_tool_1stmsgchk: true });
      mode.beforeProcess(ctx);
      expect(mode.configureRun(ctx)).toBeUndefined();
    }
  });

  it('blocks non-send tools while a progress report is pending', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('group'), state, (name) => name === 'EcSend', {});
    mode.beforeProcess(ctx);
    const cfg = mode.configureRun(ctx)!;

    expect(cfg.policyHook!('EcSend', {})).toBeUndefined();
    for (let i = 0; i < 10; i++) {
      mode.onToolUse({ session: {} as any, state, toolName: 'Bash', toolInput: {}, injectToModel: () => {}, getQueueLength: () => 0, isSendCommand: () => false, logger });
    }

    expect(state.get('proactive').toolReportPending).toBe(true);
    const blocked = cfg.policyHook!('Bash', {});
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain('工具调用已达到 10 次');
    expect(cfg.policyHook!('EcSend', {})).toBeUndefined();
    expect(state.get('proactive').toolReportPending).toBe(false);
    expect(cfg.policyHook!('Bash', {})).toBeUndefined();
  });
});

describe('ProactiveMode.onToolUse (迁移点4: 工具汇报提醒)', () => {
  function toolCtx(state: Map<string, any>, toolName: string, queueLen: number, isSendCommand = (_: string, __: any) => false): { ctx: ToolUseContext; injected: string[] } {
    const injected: string[] = [];
    return {
      injected,
      ctx: { session: {} as any, state, toolName, toolInput: {}, injectToModel: (t) => injected.push(t), getQueueLength: () => queueLen, isSendCommand, logger },
    };
  }

  it('injects queue reminder when unread > 0', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private'), state, undefined, {}));
    const { ctx, injected } = toolCtx(state, 'Bash', 3);
    mode.onToolUse(ctx);
    expect(injected.some(m => m.includes('3 条消息未读'))).toBe(true);
  });

  it('queue reminder escalates at >= 5', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private'), state, undefined, {}));
    const { ctx, injected } = toolCtx(state, 'Bash', 6);
    mode.onToolUse(ctx);
    expect(injected.some(m => m.includes('尽快完成当前任务'))).toBe(true);
  });

  it('counts non-send tools, warns at 10th', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('group'), state, undefined, {}));
    const injected: string[] = [];
    for (let i = 0; i < 10; i++) {
      mode.onToolUse({ session: {} as any, state, toolName: 'Bash', toolInput: {}, injectToModel: (t) => injected.push(t), getQueueLength: () => 0, isSendCommand: () => false, logger });
    }
    expect(state.get('proactive').toolCount).toBe(10);
    expect(state.get('proactive').toolReportPending).toBe(true);
    expect(injected.some(m => m.includes('工具调用已达到 10 次'))).toBe(true);
  });

  it('repeats tool report reminders every interval', () => {
    const mode = modeWithCtx();
    const state = new Map();
    const ctx = procCtx(inbound('group'), state, (name) => name === 'EcSend', {});
    mode.beforeProcess(ctx);
    const cfg = mode.configureRun(ctx)!;
    cfg.policyHook!('EcSend', {});
    const injected: string[] = [];
    for (let i = 0; i < 10; i++) {
      mode.onToolUse({ session: {} as any, state, toolName: 'Bash', toolInput: {}, injectToModel: (t) => injected.push(t), getQueueLength: () => 0, isSendCommand: () => false, logger });
    }
    cfg.policyHook!('EcSend', {});
    for (let i = 0; i < 10; i++) {
      mode.onToolUse({ session: {} as any, state, toolName: 'Bash', toolInput: {}, injectToModel: (t) => injected.push(t), getQueueLength: () => 0, isSendCommand: () => false, logger });
    }
    expect(injected.some(m => m.includes('工具调用已达到 10 次'))).toBe(true);
    expect(injected.some(m => m.includes('工具调用已达到 20 次'))).toBe(true);
  });

  it('keeps queue reminders but skips tool reports for private non-human peers', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private', undefined, 'ai'), state, undefined, {}));
    const injected: string[] = [];
    for (let i = 0; i < 10; i++) {
      mode.onToolUse({ session: {} as any, state, toolName: 'Bash', toolInput: {}, injectToModel: (t) => injected.push(t), getQueueLength: () => (i === 0 ? 2 : 0), isSendCommand: () => false, logger });
    }
    expect(injected.some(m => m.includes('2 条消息未读'))).toBe(true);
    expect(injected.some(m => m.includes('工具调用已达到'))).toBe(false);
  });

  it('send commands not counted', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private', undefined, 'human'), state, undefined, {}));
    mode.onToolUse({ session: {} as any, state, toolName: 'EcSend', toolInput: {}, injectToModel: () => {}, getQueueLength: () => 0, isSendCommand: (n) => n === 'EcSend', logger });
    expect(state.get('proactive').toolCount).toBe(0);
  });

  it('no reminder when toolUseReminder false', () => {
    const mode = modeWithCtx();
    const state = new Map();
    mode.beforeProcess(procCtx(inbound('private'), state, undefined, { tool_use_reminder: false }));
    const { ctx, injected } = toolCtx(state, 'Bash', 3);
    mode.onToolUse(ctx);
    expect(injected).toHaveLength(0);
  });
});

describe('ProactiveMode.onComplete (迁移点5: 标志位检查)', () => {
  function completeCtx(lastReplyText: string): { ctx: CompleteContext; patches: any[] } {
    const patches: any[] = [];
    return {
      patches,
      ctx: { session: {} as any, state: new Map(), lastReplyText, updateSessionMeta: async (p) => { patches.push(p); }, logger },
    };
  }

  it('sets lastProactiveFlag when REPLY_CONFIRMED_SENT present', async () => {
    const mode = modeWithCtx();
    const { ctx, patches } = completeCtx('done [PROACTIVE:REPLY_CONFIRMED_SENT]');
    await mode.onComplete(ctx);
    expect(patches).toEqual([{ lastProactiveFlag: true }]);
  });

  it('sets flag for REPLY_CONFIRMED_NONE too', async () => {
    const mode = modeWithCtx();
    const { ctx, patches } = completeCtx('[PROACTIVE:REPLY_CONFIRMED_NONE]');
    await mode.onComplete(ctx);
    expect(patches).toEqual([{ lastProactiveFlag: true }]);
  });

  it('no flag when marker absent', async () => {
    const mode = modeWithCtx();
    const { ctx, patches } = completeCtx('just a normal reply');
    await mode.onComplete(ctx);
    expect(patches).toHaveLength(0);
  });
});

describe('ProactiveMode.afterProcess (迁移点6: Unknown skill 兜底)', () => {
  function afterCtx(fullText: string, hasReceivedText: boolean): { ctx: AfterProcessContext; sent: any[] } {
    const sent: any[] = [];
    return {
      sent,
      ctx: { session: {} as any, fullText, streamResult: { hasReceivedText }, send: async (p) => { sent.push(p); }, channelCapabilities: { file: true, thought: true }, processFileMarkers: async () => 0, logger },
    };
  }

  it('sends fallback when Unknown skill + no text received', async () => {
    const mode = modeWithCtx();
    const { ctx, sent } = afterCtx('Unknown skill: foobar', false);
    await mode.afterProcess(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('result.text');
  });

  it('no fallback when text was received', async () => {
    const mode = modeWithCtx();
    const { ctx, sent } = afterCtx('Unknown skill: foobar', true);
    await mode.afterProcess(ctx);
    expect(sent).toHaveLength(0);
  });

  it('no fallback for normal text', async () => {
    const mode = modeWithCtx();
    const { ctx, sent } = afterCtx('normal reply', false);
    await mode.afterProcess(ctx);
    expect(sent).toHaveLength(0);
  });
});
