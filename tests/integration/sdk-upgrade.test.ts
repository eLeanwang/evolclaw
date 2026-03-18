import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunner } from '../../src/core/agent-runner.js';
import { Config } from '../../src/types.js';

// Mock SDK query to capture options
const capturedOptions: any[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }) => {
    capturedOptions.push(options);
    // Return a minimal async iterable
    return (async function* () {
      yield { type: 'result', result: 'test response', session_id: 'test-session-123' };
    })();
  }),
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
}));

describe('SDK Upgrade: settingSources', () => {
  beforeEach(() => {
    capturedOptions.length = 0;
  });

  it('should use settingSources by default (new mode)', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
      // sdk.useSettingSources not set → defaults to true
    };

    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test');

    // Consume stream
    for await (const _ of stream) {}

    expect(capturedOptions.length).toBe(1);
    const opts = capturedOptions[0];
    expect(opts.settingSources).toEqual(['project', 'user']);
    expect(opts.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
    // Should NOT have mcpServers (SDK loads them automatically)
    expect(opts.mcpServers).toBeUndefined();
  });

  it('should pass systemPromptAppend through in new mode', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
    };

    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test', undefined, undefined, 'channel append text');

    for await (const _ of stream) {}

    const opts = capturedOptions[0];
    expect(opts.settingSources).toEqual(['project', 'user']);
    expect(opts.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'channel append text',
    });
  });

  it('should fall back to legacy mode when useSettingSources is false', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
      sdk: { useSettingSources: false },
    };

    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test');

    for await (const _ of stream) {}

    const opts = capturedOptions[0];
    // Legacy mode should NOT have settingSources
    expect(opts.settingSources).toBeUndefined();
  });

  it('should enable agentProgressSummaries by default', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
    };

    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test');

    for await (const _ of stream) {}

    const opts = capturedOptions[0];
    expect(opts.agentProgressSummaries).toBe(true);
  });

  it('should disable agentProgressSummaries when configured', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
      sdk: { agentProgressSummaries: false },
    };

    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test');

    for await (const _ of stream) {}

    const opts = capturedOptions[0];
    expect(opts.agentProgressSummaries).toBeUndefined();
  });

  it('should pass env with API key and base URL', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
    };

    const runner = new AgentRunner('my-api-key', 'opus', undefined, 'https://custom.api.com', config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test');

    for await (const _ of stream) {}

    const opts = capturedOptions[0];
    expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe('my-api-key');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://custom.api.com');
    expect(opts.model).toBe('opus');
  });

  it('should preserve hooks in both modes', async () => {
    const config: Config = {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/tmp/test', autoCreate: false },
    };

    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
    const stream = await runner.runQuery('test-session', 'hello', '/tmp/test');

    for await (const _ of stream) {}

    const opts = capturedOptions[0];
    expect(opts.hooks).toBeDefined();
    expect(opts.hooks.PreCompact).toBeDefined();
    expect(opts.hooks.PreToolUse).toBeDefined();
  });
});
