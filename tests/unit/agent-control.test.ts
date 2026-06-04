import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/cli/agent.js', () => ({
  agentCreateNonInteractive: vi.fn(),
  agentDelete: vi.fn(),
  agentEnable: vi.fn(),
  agentDisable: vi.fn(),
  agentList: vi.fn(),
  agentShow: vi.fn(),
  agentSet: vi.fn(),
}));

// 隔离构建进度文件写盘——本测聚焦控制流，进度写入在 create-status.test.ts 单独覆盖
vi.mock('../../src/core/message/create-status.js', () => ({
  CreateStatusWriter: class {
    begin() {} done() {} warn() {} finishReady() {} finishFailed() {}
  },
  readCreateStatus: vi.fn(() => null),
}));

import * as cliAgent from '../../src/cli/agent.js';
import { execAgentAction } from '../../src/core/message/command-handler-agent-control.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('execAgentAction create (accepted-return)', () => {
  it('rejects missing required args synchronously', async () => {
    const r = await execAgentAction('create', { name: 'X', baseagent: 'claude' }, 'peer.agentid.pub');
    expect('error' in r).toBe(true);
    expect((r as any).code).toBe('INVALID_ARGS');
  });

  it('rejects missing project (no fallback)', async () => {
    const r = await execAgentAction('create', { aid: 'x.agentid.pub', name: 'X', baseagent: 'claude' }, 'peer.agentid.pub');
    expect((r as any).code).toBe('INVALID_ARGS');
  });

  it('returns accepted immediately and fires create in background', async () => {
    (cliAgent.agentCreateNonInteractive as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', configPath: '/c', aidCreated: true });
    const r = await execAgentAction('create',
      { aid: 'x.agentid.pub', name: 'X', baseagent: 'claude', project: '/tmp/x' }, 'peer.agentid.pub');
    expect((r as any).data.accepted).toBe(true);
    expect((r as any).data.aid).toBe('x.agentid.pub');
    // 让后台 promise 跑一拍
    await new Promise(r => setImmediate(r));
    expect((cliAgent.agentCreateNonInteractive as any).mock.calls[0][0].owner).toBe('peer.agentid.pub');
  });

  it('applies model/chatmode via agentSet in background (D2)', async () => {
    (cliAgent.agentCreateNonInteractive as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', configPath: '/c', aidCreated: true });
    (cliAgent.agentSet as any).mockResolvedValue({ ok: true });
    await execAgentAction('create',
      { aid: 'x.agentid.pub', name: 'X', baseagent: 'claude', project: '/tmp/x', model: 'sonnet', chatmode: { private: 'interactive' } },
      'peer.agentid.pub');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const setKeys = (cliAgent.agentSet as any).mock.calls.map((c: any[]) => c[1]);
    expect(setKeys).toContain('models.default');
    expect(setKeys).toContain('chatmode');
  });
});

describe('execAgentAction delete/enable/disable', () => {
  it('maps NOT_FOUND on delete of missing agent', async () => {
    (cliAgent.agentDelete as any).mockResolvedValue({ ok: false, error: 'Agent "x" not found' });
    const r = await execAgentAction('delete', { aid: 'x.agentid.pub' }, 'peer.agentid.pub');
    expect((r as any).code).toBe('NOT_FOUND');
  });

  it('returns data on enable success', async () => {
    (cliAgent.agentEnable as any).mockResolvedValue({ ok: true, aid: 'x.agentid.pub', enabled: true, reloaded: true });
    const r = await execAgentAction('enable', { aid: 'x.agentid.pub' }, 'peer.agentid.pub');
    expect((r as any).data.enabled).toBe(true);
  });

  it('rejects unknown action', async () => {
    const r = await execAgentAction('frobnicate', { aid: 'x.agentid.pub' }, 'peer.agentid.pub');
    expect((r as any).code).toBe('INVALID_ARGS');
  });
});
