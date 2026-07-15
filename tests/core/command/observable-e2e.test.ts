import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../../src/ipc.js', () => ({
  ipcQuery: vi.fn().mockRejectedValue(new Error('daemon offline')),
}));

import { agentGet, agentSet } from '../../../src/cli/agent.js';
import { saveAgent, saveEvolclawConfig } from '../../../src/config-store.js';
import { _resetRoot, resolvePaths } from '../../../src/paths.js';
import { _resetSchemaCache } from '../../../src/config/schema-registry.js';
import { EvolAgentRegistry } from '../../../src/core/evolagent-registry.js';
import { CommandHandler } from '../../../src/core/command/command-handler.js';
import { MessageBridge } from '../../../src/core/message/message-bridge.js';
import { EventBus } from '../../../src/core/event-bus.js';
import type {
  AgentConfig,
  ChannelAdapter,
  InboundMessage,
  OutboundEnvelope,
  OutboundPayload,
} from '../../../src/types.js';

const AGENT_AID = 'observable-e2e.agentid.pub';
const OWNER_AID = 'owner.agentid.pub';
const ADMIN_AID = 'admin.agentid.pub';
const INTRUDER_AID = 'intruder.agentid.pub';

const originalHome = process.env.HOME;
const originalEvolclawHome = process.env.EVOLCLAW_HOME;
const originalAunHome = process.env.AUN_HOME;

let root: string;
let channelKey: string;
let registry: EvolAgentRegistry;
let handler: CommandHandler;
let sessionManager: ReturnType<typeof makeSessionManager>;

function readAgentConfig(): AgentConfig {
  return JSON.parse(fs.readFileSync(path.join(root, 'agents', AGENT_AID, 'config.json'), 'utf8'));
}

function makeSessionManager() {
  return {
    getActiveSession: vi.fn().mockResolvedValue(null),
    getActiveSessionSync: vi.fn().mockReturnValue(null),
    getThreadSession: vi.fn().mockResolvedValue(null),
    resolveIdentity: vi.fn((_channel: string, userId?: string) => ({
      role: userId === OWNER_AID ? 'owner' : userId === ADMIN_AID ? 'admin' : 'visitor',
      mode: 'interactive',
    })),
  } as any;
}

function setupRuntime() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-observable-e2e-'));
  process.env.HOME = root;
  process.env.EVOLCLAW_HOME = root;
  process.env.AUN_HOME = path.join(root, '.aun');
  _resetRoot();
  _resetSchemaCache();

  const projectPath = path.join(root, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  saveEvolclawConfig({ $schema_version: 1, owners: [OWNER_AID] });
  saveAgent({
    $schema_version: 3,
    aid: AGENT_AID,
    owners: [OWNER_AID],
    admins: [ADMIN_AID],
    channels: [],
    projects: { defaultPath: projectPath },
    active_baseagent: 'claude',
    baseagents: { claude: {} },
  });

  registry = new EvolAgentRegistry(resolvePaths().agentsDir);
  registry.loadAll();
  const agent = registry.get(AGENT_AID);
  expect(agent).not.toBeNull();
  channelKey = agent!.channelInstanceNames()[0];
  expect(registry.resolveByChannel(channelKey)?.aid).toBe(AGENT_AID);

  const runner = {
    name: 'claude',
    hasActiveStream: vi.fn().mockReturnValue(false),
    interrupt: vi.fn().mockResolvedValue(undefined),
  } as any;
  sessionManager = makeSessionManager();
  handler = new CommandHandler(
    sessionManager,
    runner,
    { getCount: vi.fn().mockReturnValue(0), hasMessages: vi.fn().mockReturnValue(false) } as any,
    new EventBus(),
  );
  handler.setAgentRegistry(registry);
  handler.setMessageQueue({ isProcessing: vi.fn().mockReturnValue(false) } as any);
  handler.registerChannel(channelKey, {}, 'aun');
}

function makeBridge() {
  const adapterSend = vi.fn().mockResolvedValue(undefined);
  const adapter: ChannelAdapter = {
    channelName: channelKey,
    channelKey,
    sendText: vi.fn().mockResolvedValue(undefined),
    send: adapterSend,
  };
  const processor = {
    getChannelInfo: vi.fn((name: string) => name === channelKey ? { adapter } : undefined),
  } as any;
  const bridge = new MessageBridge(
    path.join(root, 'project'),
    sessionManager,
    processor,
    {} as any,
    handler,
    new EventBus(),
    0,
  );
  bridge.setAgentRegistry(registry);

  let inboundHandler: ((message: InboundMessage) => Promise<void>) | undefined;
  bridge.register(
    channelKey,
    callback => { inboundHandler = callback; },
    vi.fn().mockResolvedValue(undefined),
    adapter,
    'aun',
  );

  const send = async (content: string) => {
    if (!inboundHandler) throw new Error('bridge handler was not registered');
    await inboundHandler({
      channel: channelKey,
      channelType: 'aun',
      channelId: OWNER_AID,
      selfAID: AGENT_AID,
      peerId: OWNER_AID,
      chatType: 'private',
      msgType: 'custom',
      content,
    });
  };

  return { adapterSend, send };
}

function lastPayload(send: ReturnType<typeof vi.fn>): OutboundPayload {
  const call = send.mock.calls.at(-1) as [OutboundEnvelope, OutboundPayload] | undefined;
  if (!call) throw new Error('no outbound payload');
  return call[1];
}

function lastMenuResponse(send: ReturnType<typeof vi.fn>): any {
  const payload = lastPayload(send);
  expect(payload.kind).toBe('custom');
  const response = (payload as any).payload;
  return typeof response === 'string' ? JSON.parse(response) : response;
}

beforeEach(() => {
  setupRuntime();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalEvolclawHome === undefined) delete process.env.EVOLCLAW_HOME;
  else process.env.EVOLCLAW_HOME = originalEvolclawHome;
  if (originalAunHome === undefined) delete process.env.AUN_HOME;
  else process.env.AUN_HOME = originalAunHome;
  _resetRoot();
  _resetSchemaCache();
});

describe('observable end-to-end', () => {
  it('runs raw agent-channel Menu and Slash messages through MessageBridge to disk', async () => {
    const agent = registry.get(AGENT_AID)!;
    const bridge = makeBridge();

    await bridge.send(JSON.stringify({
      type: 'menu.query', id: 'q1', name: 'observable',
    }));
    expect(lastMenuResponse(bridge.adapterSend)).toMatchObject({
      id: 'q1', name: 'observable', data: { observable: false, source: 'builtin' },
    });

    await bridge.send(JSON.stringify({
      type: 'menu.update', id: 'u1', name: 'observable', value: 'true',
    }));
    expect(lastMenuResponse(bridge.adapterSend)).toMatchObject({
      id: 'u1', name: 'observable', data: { observable: true },
    });
    expect(agent.getObservable()).toBe(true);
    expect(readAgentConfig().observable).toBe(true);

    await bridge.send(JSON.stringify({ type: 'menu.list', id: 'l1' }));
    const menu = lastMenuResponse(bridge.adapterSend).data as Array<{ commands: any[] }>;
    const observable = menu.flatMap(group => group.commands).find(item => item.cmd === '/observable');
    expect(observable.next.items.map((item: any) => item.value)).toEqual(['true', 'false']);

    await bridge.send('/observable false');
    expect(lastPayload(bridge.adapterSend)).toMatchObject({
      kind: 'command.result', text: expect.stringContaining('观察者模式: false'),
    });
    expect(agent.getObservable()).toBe(false);
    expect(readAgentConfig().observable).toBeUndefined();
  });

  it('routes ECWeb and Control requests by top-level agent using the real registry', async () => {
    const agent = registry.get(AGENT_AID)!;

    const webUpdate = await handler.execMenuForEcweb({
      type: 'menu.update', id: 'web-u1', name: 'observable', agent: AGENT_AID, value: 'true',
    });
    expect(webUpdate.data).toEqual({ observable: true });
    expect(agent.getObservable()).toBe(true);
    expect(readAgentConfig().observable).toBe(true);

    const controlQuery = await handler.execMenuForControl({
      type: 'menu.query', id: 'ctl-q1', name: 'observable', agent: AGENT_AID,
    }, OWNER_AID);
    expect(controlQuery.data).toEqual({ observable: true, source: 'agent' });

    const compatQuery = await handler.execMenuForControl({
      type: 'menu.query', id: 'ctl-q2', cmd: '/observable', agent: AGENT_AID,
    }, OWNER_AID);
    expect(compatQuery.data).toMatchObject({ observable: true });

    const controlUpdate = await handler.execMenuForControl({
      type: 'menu.update', id: 'ctl-u1', name: 'observable', agent: AGENT_AID, value: 'false',
    }, OWNER_AID);
    expect(controlUpdate.data).toEqual({ observable: false });
    expect(agent.getObservable()).toBe(false);
    expect(readAgentConfig().observable).toBeUndefined();

    const missingAgent = await handler.execMenuForEcweb({
      type: 'menu.query', id: 'web-missing', name: 'observable',
    });
    expect(missingAgent.error?.code).toBe('INVALID_ARGUMENT');

    const unknownAgent = await handler.execMenuForControl({
      type: 'menu.query', id: 'ctl-missing', name: 'observable', agent: 'missing.agentid.pub',
    }, OWNER_AID);
    expect(unknownAgent.error?.code).toBe('NOT_FOUND');

    const intruder = await handler.execMenuForControl({
      type: 'menu.query', id: 'ctl-forbidden', name: 'observable', agent: AGENT_AID,
    }, INTRUDER_AID);
    expect(intruder.error?.code).toBe('ROLE_ACCESS_DENIED');

    const adminQuery = await handler.execMenuQuery(
      '/observable', channelKey, ADMIN_AID, ADMIN_AID,
    ) as any;
    expect(adminQuery.code).toBe('NO_PERMISSION');
  });

  it('persists native booleans through the existing CLI get/set path', async () => {
    const initial = await agentGet(AGENT_AID, 'observable');
    expect(initial).toMatchObject({ ok: true, value: undefined });

    const enabled = await agentSet(AGENT_AID, 'observable', 'true');
    expect(enabled).toMatchObject({ ok: true, value: true });
    expect((await agentGet(AGENT_AID, 'observable'))).toMatchObject({ ok: true, value: true });
    expect(readAgentConfig().observable).toBe(true);

    const disabled = await agentSet(AGENT_AID, 'observable', 'false');
    expect(disabled).toMatchObject({ ok: true, value: false });
    expect((await agentGet(AGENT_AID, 'observable'))).toMatchObject({ ok: true, value: false });
    expect(readAgentConfig().observable).toBe(false);
  });
});
