import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EvolAgentRegistry } from '../../src/core/evolagent-registry.js';
import { IpcServer } from '../../src/ipc.js';
import type { Config } from '../../src/types.js';

/**
 * E2E tests for IpcServer.handleCommand dispatch of evolagent.* commands.
 *
 * The IpcServer constructor signature is:
 *   new IpcServer(socketPath, getStatus, commandExecutor?)
 *
 * `handleCommand` is private; we invoke it via `(server as any).handleCommand(cmd)`.
 * The IpcServer is never `start()`-ed, so no real socket is opened. We're testing
 * the dispatch logic, not the network plumbing.
 *
 * The request shape uses `type` (not `cmd`) as the discriminator field — this matches
 * the actual implementation in src/ipc.ts.
 */
describe('IpcServer evolagent.* dispatch (e2e)', () => {
  let tmpDir: string;
  let agentsDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-ipc-e2e-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    // Use a path inside tmpDir; we never actually listen, but a valid path is harmless.
    socketPath = path.join(tmpDir, 'evolclaw.sock');
  });

  afterEach(() => {
    delete (globalThis as any).__evolclaw_reloadHooks;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, config: any): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.json`), JSON.stringify(config));
  }

  function globalConfig(): Config {
    return {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: {},
      projects: { defaultPath: '/tmp' },
    } as any;
  }

  function buildRegistry(): EvolAgentRegistry {
    writeAgent('review', {
      name: 'review',
      enabled: true,
      agents: { claude: { model: 'opus' } },
      channels: { feishu: [{ name: 'review-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });
    const reg = new EvolAgentRegistry(agentsDir);
    reg.loadAll(globalConfig());
    return reg;
  }

  function buildIpcServer(reg: EvolAgentRegistry | null): IpcServer {
    // getStatus stub — never called by evolagent.* dispatch.
    const getStatus = (): any => ({
      pid: process.pid,
      uptime: 0,
      channels: {},
      queue: { pending: 0, processing: 0 },
    });
    const server = new IpcServer(socketPath, getStatus);
    if (reg) server.setAgentRegistry(reg);
    return server;
  }

  // ---- evolagent.list ----

  it('evolagent.list returns all agents including default', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);

    const response = await (server as any).handleCommand({ type: 'evolagent.list' });

    expect(response.ok).toBe(true);
    expect(response.agents).toBeDefined();
    expect(Array.isArray(response.agents)).toBe(true);
    expect(response.agents.length).toBeGreaterThanOrEqual(2); // review + default
    expect(response.agents.find((a: any) => a.name === 'review')).toBeDefined();
    expect(response.agents.find((a: any) => a.isDefault)).toBeDefined();
  });

  it('evolagent.list returns error when registry not set', async () => {
    const server = buildIpcServer(null); // skip setAgentRegistry

    const response = await (server as any).handleCommand({ type: 'evolagent.list' });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/registry|not available/i);
  });

  // ---- evolagent.show ----

  it('evolagent.show returns single agent info', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);

    const response = await (server as any).handleCommand({
      type: 'evolagent.show',
      name: 'review',
    });

    expect(response.ok).toBe(true);
    expect(response.agent).toBeDefined();
    expect(response.agent.name).toBe('review');
    expect(response.agent.baseagent).toBe('claude');
    expect(response.agent.channels).toContain('review-feishu-review-fs');
  });

  it('evolagent.show returns error for nonexistent agent', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);

    const response = await (server as any).handleCommand({
      type: 'evolagent.show',
      name: 'ghost',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not found/i);
  });

  it('evolagent.show returns error when name missing', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);

    const response = await (server as any).handleCommand({ type: 'evolagent.show' });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/name/i);
  });

  it('evolagent.show returns error when registry not set', async () => {
    const server = buildIpcServer(null);

    const response = await (server as any).handleCommand({
      type: 'evolagent.show',
      name: 'review',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/registry|not available/i);
  });

  // ---- evolagent.reload ----

  it('evolagent.reload calls registry.reload with hooks from globalThis', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);

    const reloadSpy = vi.spyOn(reg, 'reload').mockResolvedValue(undefined);
    const mockHooks = {
      drainChannel: vi.fn(),
      disconnectChannel: vi.fn(),
      startChannel: vi.fn(),
    };
    (globalThis as any).__evolclaw_reloadHooks = mockHooks;

    const response = await (server as any).handleCommand({
      type: 'evolagent.reload',
      name: 'review',
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatch(/review/);
    expect(reloadSpy).toHaveBeenCalledWith('review', mockHooks);
  });

  it('evolagent.reload returns error when hooks not initialized', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);
    delete (globalThis as any).__evolclaw_reloadHooks;

    const response = await (server as any).handleCommand({
      type: 'evolagent.reload',
      name: 'review',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/hook|not initialized/i);
  });

  it('evolagent.reload returns error for nonexistent agent', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);
    (globalThis as any).__evolclaw_reloadHooks = {
      drainChannel: vi.fn(),
      disconnectChannel: vi.fn(),
      startChannel: vi.fn(),
    };

    const response = await (server as any).handleCommand({
      type: 'evolagent.reload',
      name: 'ghost',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not found/i);
  });

  it('evolagent.reload returns error when name missing', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);
    (globalThis as any).__evolclaw_reloadHooks = {
      drainChannel: vi.fn(),
      disconnectChannel: vi.fn(),
      startChannel: vi.fn(),
    };

    const response = await (server as any).handleCommand({ type: 'evolagent.reload' });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/name/i);
  });

  it('evolagent.reload propagates registry.reload errors as response.error', async () => {
    const reg = buildRegistry();
    const server = buildIpcServer(reg);
    vi.spyOn(reg, 'reload').mockRejectedValue(new Error('Channel conflict: foo'));
    (globalThis as any).__evolclaw_reloadHooks = {
      drainChannel: vi.fn(),
      disconnectChannel: vi.fn(),
      startChannel: vi.fn(),
    };

    const response = await (server as any).handleCommand({
      type: 'evolagent.reload',
      name: 'review',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/channel conflict/i);
  });

  it('evolagent.reload returns error when registry not set', async () => {
    const server = buildIpcServer(null);
    (globalThis as any).__evolclaw_reloadHooks = {
      drainChannel: vi.fn(),
      disconnectChannel: vi.fn(),
      startChannel: vi.fn(),
    };

    const response = await (server as any).handleCommand({
      type: 'evolagent.reload',
      name: 'review',
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/registry|not available/i);
  });
});
