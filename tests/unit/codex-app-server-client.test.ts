import { describe, it, expect, vi } from 'vitest';
import { CodexAppServerClient } from '../../src/agents/codex-app-server-client.js';

function makeClient() {
  const client = new CodexAppServerClient({ apiKey: 'test-key', model: 'gpt-5.4', effort: 'high' } as any);
  const request = vi.fn();
  (client as any).request = request;
  return { client, request };
}

describe('CodexAppServerClient extended thread methods', () => {
  it('enables Codex default-mode request user input by default unless disabled', () => {
    const defaultClient = new CodexAppServerClient({ apiKey: 'test-key' } as any);
    expect((defaultClient as any).buildProcessArgs()).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'default_mode_request_user_input',
    ]);

    const disabledClient = new CodexAppServerClient({
      apiKey: 'test-key',
      enableRequestUserInput: false,
    } as any);
    expect((disabledClient as any).buildProcessArgs()).toEqual(['app-server', '--listen', 'stdio://']);

    const enabledClient = new CodexAppServerClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      effort: 'high',
      enableRequestUserInput: true,
    } as any);
    expect((enabledClient as any).buildProcessArgs()).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'default_mode_request_user_input',
      '--config',
      'openai_base_url="https://example.test/v1"',
      '--config',
      'model_reasoning_effort="high"',
    ]);
  });

  it('starts and resumes threads with app-server instructions', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValue({ thread: { id: 'thread-1' } });

    await client.threadStart('/repo', { model: 'gpt-5.5', effort: 'xhigh', developerInstructions: 'dev ctx' });
    await client.threadResume('thread-1', '/repo', { developerInstructions: 'fresh ctx' });

    expect(request).toHaveBeenNthCalledWith(1, 'thread/start', expect.objectContaining({
      cwd: '/repo',
      model: 'gpt-5.5',
      config: { model_reasoning_effort: 'xhigh' },
      developerInstructions: 'dev ctx',
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', expect.objectContaining({
      threadId: 'thread-1',
      cwd: '/repo',
      developerInstructions: 'fresh ctx',
    }));
  });

  it('merges thread config with model effort overrides', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValue({ thread: { id: 'thread-1' } });
    const shellConfig = {
      shell_environment_policy: {
        set: {
          EVOLCLAW_SESSION_ID: 'sess-1',
          EVOLCLAW_HOME: '/home/evolclaw',
        },
      },
    };

    await client.threadStart('/repo', { effort: 'xhigh', config: shellConfig });
    await client.threadResume('thread-1', '/repo', { effort: 'high', config: shellConfig });
    await client.threadFork('thread-1', '/repo', undefined, { effort: 'medium', config: shellConfig });

    expect(request).toHaveBeenNthCalledWith(1, 'thread/start', expect.objectContaining({
      config: {
        ...shellConfig,
        model_reasoning_effort: 'xhigh',
      },
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', expect.objectContaining({
      config: {
        ...shellConfig,
        model_reasoning_effort: 'high',
      },
    }));
    expect(request).toHaveBeenNthCalledWith(3, 'thread/fork', expect.objectContaining({
      config: {
        ...shellConfig,
        model_reasoning_effort: 'medium',
      },
    }));
  });

  it('passes approvalsReviewer to thread start, resume, and fork', async () => {
    const client = new CodexAppServerClient({
      apiKey: 'test-key',
      approvalsReviewer: 'auto_review',
    } as any);
    const request = vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } });
    (client as any).request = request;

    await client.threadStart('/repo');
    await client.threadResume('thread-1', '/repo');
    await client.threadFork('thread-1', '/repo');

    expect(request).toHaveBeenNthCalledWith(1, 'thread/start', expect.objectContaining({
      approvalsReviewer: 'auto_review',
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'thread/resume', expect.objectContaining({
      approvalsReviewer: 'auto_review',
    }));
    expect(request).toHaveBeenNthCalledWith(3, 'thread/fork', expect.objectContaining({
      approvalsReviewer: 'auto_review',
    }));
  });

  it('starts turns with structured user input', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValue({ turn: { id: 'turn-1' } });

    await client.turnStart('thread-1', [{ type: 'text', text: 'hello', text_elements: [] }] as any, {
      cwd: '/repo',
      model: 'gpt-5.5',
      effort: 'high',
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });

    expect(request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      cwd: '/repo',
      model: 'gpt-5.5',
      effort: 'high',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
    });
  });

  it('forks a thread and applies an optional title', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValueOnce({ thread: { id: 'forked-thread' } });
    request.mockResolvedValueOnce({});

    const result = await client.threadFork('source-thread', '/repo', 'fork name');

    expect(result.thread?.id).toBe('forked-thread');
    expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', expect.objectContaining({
      threadId: 'source-thread',
      cwd: '/repo',
      model: 'gpt-5.4',
      config: { model_reasoning_effort: 'high' },
      persistExtendedHistory: false,
    }));
    expect(request).toHaveBeenNthCalledWith(2, 'thread/name/set', { threadId: 'forked-thread', name: 'fork name' });
  });

  it('starts compaction and turn interrupt requests', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValue({});

    await expect(client.threadCompactStart('thread-1')).resolves.toBe(true);
    await expect(client.turnInterrupt('thread-1', 'turn-1')).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'thread-1' });
    expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('resolves compact start when app-server emits thread/compacted', async () => {
    const client = new CodexAppServerClient({ apiKey: 'test-key' } as any);
    const write = vi.fn();
    (client as any).initialized = true;
    (client as any).proc = { stdin: { write } };

    const promise = client.threadCompactStart('thread-1');
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0][0]).toContain('"method":"thread/compact/start"');
    expect((client as any).pending.size).toBe(1);

    (client as any).handleLine(JSON.stringify({
      method: 'thread/compacted',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }));

    await expect(promise).resolves.toBe(true);
    expect((client as any).pending.size).toBe(0);
  });

  it('updates thread metadata without undefined git fields', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValue({});

    await client.threadMetadataUpdate('thread-1', { branch: 'main', commitHash: undefined, repositoryUrl: null });

    expect(request).toHaveBeenCalledWith('thread/metadata/update', {
      threadId: 'thread-1',
      gitInfo: { branch: 'main', repositoryUrl: null },
    });
  });

  it('reads model list and provider capabilities', async () => {
    const { client, request } = makeClient();
    request.mockResolvedValueOnce({ data: [{ id: 'gpt-5.4' }] });
    request.mockResolvedValueOnce({ webSearch: true });

    await expect(client.modelList()).resolves.toEqual({ data: [{ id: 'gpt-5.4' }] });
    await expect(client.modelProviderCapabilitiesRead()).resolves.toEqual({ webSearch: true });

    expect(request).toHaveBeenNthCalledWith(1, 'model/list', { includeHidden: false });
    expect(request).toHaveBeenNthCalledWith(2, 'modelProvider/capabilities/read', {});
  });
});

describe('CodexAppServerClient server requests', () => {
  it('routes server-initiated requests and writes JSON-RPC responses', async () => {
    const handler = vi.fn().mockResolvedValue({ decision: 'approved' });
    const client = new CodexAppServerClient({ apiKey: 'test-key', onServerRequest: handler } as any);
    const write = vi.fn();
    (client as any).proc = { stdin: { write } };

    (client as any).handleLine(JSON.stringify({ id: 'srv-1', method: 'execCommandApproval', params: { command: ['ls'] } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({ id: 'srv-1', method: 'execCommandApproval', params: { command: ['ls'] } });
    expect(write.mock.calls[0][0]).toBe(JSON.stringify({ id: 'srv-1', result: { decision: 'approved' } }) + '\n');
  });

  it('preserves numeric server request ids in JSON-RPC responses', async () => {
    const handler = vi.fn().mockResolvedValue({ decision: 'accept' });
    const client = new CodexAppServerClient({ apiKey: 'test-key', onServerRequest: handler } as any);
    const write = vi.fn();
    (client as any).proc = { stdin: { write } };

    (client as any).handleLine(JSON.stringify({
      id: 0,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: ['pwd'] },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({
      id: 0,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: ['pwd'] },
    });
    expect(write.mock.calls[0][0]).toBe(JSON.stringify({ id: 0, result: { decision: 'accept' } }) + '\n');
  });

  it('routes server-initiated requests before pending response lookup when ids collide', async () => {
    const handler = vi.fn().mockResolvedValue({ decision: 'accept' });
    const client = new CodexAppServerClient({ apiKey: 'test-key', onServerRequest: handler } as any);
    const write = vi.fn();
    const pendingResolve = vi.fn();
    const pendingReject = vi.fn();
    (client as any).proc = { stdin: { write } };
    (client as any).pending.set('1', { resolve: pendingResolve, reject: pendingReject, method: 'turn/start' });

    (client as any).handleLine(JSON.stringify({
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', fileChanges: { 'src/request-check-2.txt': { kind: 'update' } } },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', fileChanges: { 'src/request-check-2.txt': { kind: 'update' } } },
    });
    expect(pendingResolve).not.toHaveBeenCalled();
    expect(pendingReject).not.toHaveBeenCalled();
    expect((client as any).pending.has('1')).toBe(true);
    expect(write.mock.calls[0][0]).toBe(JSON.stringify({ id: 1, result: { decision: 'accept' } }) + '\n');
  });

  it('rejects unsupported server requests when no handler is installed', () => {
    const client = new CodexAppServerClient({ apiKey: 'test-key' } as any);
    const write = vi.fn();
    (client as any).proc = { stdin: { write } };

    (client as any).handleLine(JSON.stringify({ id: 'srv-1', method: 'unknown/request', params: {} }));

    const payload = JSON.parse(write.mock.calls[0][0]);
    expect(payload.id).toBe('srv-1');
    expect(payload.error.message).toContain('Unsupported Codex app-server request');
  });
});
