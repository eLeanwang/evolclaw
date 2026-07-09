import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import { ResponseModeCoordinator } from '../../src/response-modes/coordinator.js';
import { ResponseModeRegistry } from '../../src/response-modes/registry.js';
import { registerBuiltinModes } from '../../src/response-modes/core/index.js';
import type { CoordinatorInboundDeps } from '../../src/response-modes/coordinator.js';
import type { InboundMessage } from '../../src/response-modes/types.js';
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

  it('falls back to session.chatMode when no config', async () => {
    const r = await coord.resolveInbound(msg('private'), makeDeps(), 'proactive');
    expect(r?.modeId).toBe('proactive'); // session.chatMode 回落
  });

  it('uses system default when no config and no chatMode', async () => {
    const r = await coord.resolveInbound(msg('private'), makeDeps(), undefined);
    expect(r?.modeId).toBe('interactive'); // private 系统兜底
    const g = await coord.resolveInbound(msg('group'), makeDeps(), undefined);
    expect(g?.modeId).toBe('proactive'); // group 系统兜底
  });

  it('response_modes default has priority over chatMode fallback', async () => {
    const deps = makeDeps({ response_modes: { default_private: 'interactive' } });
    const r = await coord.resolveInbound(msg('private'), deps, 'proactive');
    expect(r?.modeId).toBe('interactive');
  });

  it('relation override remains higher priority than session.chatMode', async () => {
    const deps = makeDeps({ response_modes: { overrides: { 'aun#p1': { mode: 'interactive' } } } }, 'aun#p1');
    const r = await coord.resolveInbound(msg('private'), deps, 'proactive');
    expect(r?.modeId).toBe('interactive');
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
