import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import { ResponseModeCoordinator } from '../../src/response-system/coordinator.js';
import { ResponseModeRegistry } from '../../src/response-system/registry.js';
import { registerBuiltinModes } from '../../src/response-system/modes/index.js';
import type { CoordinatorInboundDeps } from '../../src/response-system/coordinator.js';
import type { InboundMessage } from '../../src/response-system/types.js';
import type { EffectiveAgentConfig } from '../../src/types.js';

function makeDeps(agentConfig: Partial<EffectiveAgentConfig> = {}, peerKey?: string): CoordinatorInboundDeps {
  return {
    session: { id: 's1' } as any,
    agentConfig: { $schema_version: 1, aid: 'bot', channels: [], ...agentConfig } as EffectiveAgentConfig,
    peerKey,
    contextDeps: {
      session: { id: 's1' } as any,
      agentConfig: {} as any,
      runner: {} as any,
      channel: {
        type: 'aun',
        capabilities: { supportsThought: true, supportsInteraction: true, supportsRichText: true, supportsFile: true, supportsImage: true },
        send: async () => {},
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      agentDir: os.tmpdir(),
    },
  };
}

const msg = (chatType: 'private' | 'group'): InboundMessage => ({ peerId: 'p1', content: 'hi', chatType });

describe('ResponseModeCoordinator', () => {
  let coord: ResponseModeCoordinator;
  beforeEach(() => {
    const reg = new ResponseModeRegistry();
    registerBuiltinModes(reg);
    coord = new ResponseModeCoordinator(reg);
  });

  // 解耦后（步骤 4）：resolveInbound 恒解析到 single-session（无 response_modes 配置时兜底），
  // chatMode 不再决定「用哪个模式」而是注入 modeConfig；modeId 恒为 single-session。
  it('无配置时兜底 single-session，chatMode 注入 modeConfig', async () => {
    const r = await coord.resolveInbound(msg('private'), makeDeps(), 'proactive');
    expect(r?.modeId).toBe('single-session');
    expect((r?.context as any).modeConfig?.chatMode).toBe('proactive');
  });

  it('私聊/群聊均兜底 single-session（chatMode 缺省不影响选模式）', async () => {
    const r = await coord.resolveInbound(msg('private'), makeDeps(), undefined);
    expect(r?.modeId).toBe('single-session');
    const g = await coord.resolveInbound(msg('group'), makeDeps(), undefined);
    expect(g?.modeId).toBe('single-session');
  });

  it('response_modes.default 指定的模式优先于兜底', async () => {
    const deps = makeDeps({ response_modes: { default_private: 'single-session' } });
    const r = await coord.resolveInbound(msg('private'), deps, 'proactive');
    expect(r?.modeId).toBe('single-session');
    expect((r?.context as any).modeConfig?.chatMode).toBe('proactive');
  });

  it('relation override 选模式优先级最高；chatMode 仍按注入', async () => {
    const deps = makeDeps({ response_modes: { overrides: { 'aun#p1': { mode: 'single-session' } } } }, 'aun#p1');
    const r = await coord.resolveInbound(msg('private'), deps, 'proactive');
    expect(r?.modeId).toBe('single-session');
    expect((r?.context as any).modeConfig?.chatMode).toBe('proactive');
  });

  it('config 显式 chatMode 覆盖注入值', async () => {
    const deps = makeDeps({ response_modes: { default_private: 'single-session', configs: { 'single-session': { chatMode: 'interactive' } } } });
    const r = await coord.resolveInbound(msg('private'), deps, 'proactive');
    expect((r?.context as any).modeConfig?.chatMode).toBe('interactive');
  });

  it('proactive inbound carries runtimeState', async () => {
    const r = await coord.resolveInbound(msg('group'), makeDeps(), 'proactive');
    expect(r?.decision.runtimeState?.proactive).toMatchObject({ chatType: 'group', firstToolDone: false });
  });

  it('resolveOutbound: proactive activity.batch → thought', async () => {
    const r = await coord.resolveInbound(msg('group'), makeDeps(), 'proactive');
    const d = await coord.resolveOutbound(r!, { kind: 'activity.batch', items: [] } as any);
    expect(d.method).toBe('direct');
    expect(d.type).toBe('thought');
  });

  it('resolveOutbound: interactive result.text → direct message', async () => {
    const r = await coord.resolveInbound(msg('private'), makeDeps(), 'interactive');
    const d = await coord.resolveOutbound(r!, { kind: 'result.text', text: 'hi', isFinal: true } as any);
    expect(d.method).toBe('direct');
    expect(d.type).toBe('message');
  });
});
