import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  checkDangerousCommand,
  checkHClassWrite,
  checkReadonly,
  PermissionGateway,
  requestDangerousCommandPermission,
} from '../../src/core/permission.js';
import {
  normalizePermissionMode,
  PUBLIC_PERMISSION_MODES,
} from '../../src/core/permission-mode.js';
import {
  buildGeminiAdminPolicy,
  buildGeminiPermissionArgs,
  GeminiRunner,
  resolveGeminiPermissionProfile,
} from '../../src/agents/gemini-runner.js';
import {
  _resetSandboxRuntimeCache,
  buildBubblewrapCommand,
  buildHClassGuardCommand,
} from '../../src/core/sandbox-runtime.js';
import {
  buildCodexHClassFilesystemRules,
  getExistingHClassMaskTargets,
  getHClassSandboxPatterns,
} from '../../src/core/protected-paths.js';

const capturedClaudeOptions: any[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }) => {
    capturedClaudeOptions.push(options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'ok' };
    })();
  }),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
}));

describe('permission mode contract', () => {
  it('exposes only the four public modes and safely migrates legacy values', () => {
    expect(PUBLIC_PERMISSION_MODES).toEqual(['readonly', 'auto', 'request', 'bypass']);
    expect(normalizePermissionMode('edit')).toMatchObject({ mode: 'request', migratedFrom: 'edit' });
    expect(normalizePermissionMode('noask')).toMatchObject({ mode: 'readonly', migratedFrom: 'noask' });
    expect(normalizePermissionMode('plan')).toMatchObject({ mode: 'readonly', workflow: 'plan' });
    expect(normalizePermissionMode('unexpected')).toEqual({ mode: 'readonly' });
  });

  it('advertises only public permission modes in the session context template', () => {
    const template = fs.readFileSync(
      path.join(process.cwd(), 'kits', 'templates', 'system-fragments', 'session.md'),
      'utf8',
    );
    expect(template).toContain('# readonly / auto / request / bypass');
    expect(template).not.toMatch(/permissionMode:.*\b(?:edit|plan|noask)\b/);
  });

  it('keeps runner fallbacks readonly until a resolved per-call mode arrives', async () => {
    const { AgentRunner } = await import('../../src/agents/claude-runner.js');
    const claude = new AgentRunner('test-key', 'sonnet');
    const gemini = new GeminiRunner({
      agents: { gemini: { apiKey: 'test', model: 'gemini-2.5-pro', cliPath: 'gemini' } },
    } as any, { onSessionIdUpdate: vi.fn() } as any);

    expect(claude.getMode()).toBe('readonly');
    expect(gemini.getMode()).toBe('readonly');
  });

  it('makes readonly allow-list based and rejects every write including temp files', () => {
    expect(checkReadonly('Read', { file_path: '/repo/src/index.ts' }, '/repo')).toEqual({ behavior: 'allow' });
    expect(checkReadonly('Write', { file_path: '/repo/.evolclaw/tmp/report.txt' }, '/repo').behavior).toBe('deny');
    expect(checkReadonly('Bash', { command: 'git status' }, '/repo').behavior).toBe('deny');
    expect(checkReadonly('mcp_custom_lookup', {}, '/repo').behavior).toBe('deny');
  });

  it('blocks H-class writes through Bash, Codex FileChange, and permission profiles', () => {
    expect(checkHClassWrite('Bash', {
      command: 'printf "%s" value > agents/demo/config.json',
    }).behavior).toBe('deny');
    expect(checkHClassWrite('Read', {
      file_path: 'agents/demo/contact.json',
    }).behavior).toBe('deny');
    expect(checkHClassWrite('Bash', {
      command: 'cat agents/demo/contact.json',
    }).behavior).toBe('deny');
    expect(checkHClassWrite('FileChange', {
      fileChanges: { 'agents/demo/relations/aun%23peer/config.json': { kind: 'update' } },
    }).behavior).toBe('deny');
    expect(checkHClassWrite('FileChange', {
      fileChanges: [{ path: 'agents/demo/config.json', kind: { type: 'update' }, diff: 'redacted' }],
    }).behavior).toBe('deny');
    expect(checkHClassWrite('FileChange', {
      fileChanges: [{ path: 'README.md', kind: { type: 'update', move_path: '.env' }, diff: 'redacted' }],
    }).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: { fileSystem: { write: ['/home/evolclaw/.env'] } },
    }).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: { network: { enabled: true } },
    }, { projectPath: '/home/evolclaw', root: '/home/evolclaw' })).toEqual({ behavior: 'allow' });
    expect(checkHClassWrite('Bash', {
      command: 'npm install',
      additionalPermissions: { network: { enabled: true } },
    }, { projectPath: '/home/evolclaw', root: '/home/evolclaw' })).toEqual({ behavior: 'allow' });
    expect(checkHClassWrite('FileChange', {
      fileChanges: { 'src/index.ts': { kind: 'update' } },
    })).toEqual({ behavior: 'allow' });
  });

  it('bounds Codex expansion of unbounded H-class deny globs', () => {
    const rules = buildCodexHClassFilesystemRules('/home/evolclaw');
    expect(rules.glob_scan_max_depth).toBeGreaterThanOrEqual(32);
    expect(rules['/home/evolclaw/**/*.json_']).toBe('deny');
    expect(rules['/home/evolclaw/agents/*/contact.json']).toBe('deny');
  });

  it('uses the canonical EvolClaw root for sandbox rules and protects legacy config.json', () => {
    if (process.platform === 'win32') return;
    const realRoot = fs.mkdtempSync(path.join(process.env.EVOLCLAW_HOME!, 'canonical-root-'));
    const linkedRoot = `${realRoot}-link`;
    fs.symlinkSync(realRoot, linkedRoot, 'dir');
    try {
      const patterns = getHClassSandboxPatterns(linkedRoot);
      expect(patterns).toContain(path.join(realRoot, 'evolclaw.json'));
      expect(patterns).toContain(path.join(realRoot, 'config.json'));
      expect(patterns).toContain(path.join(realRoot, 'agents', '*', 'contact.json'));
      expect(patterns).not.toContain(path.join(linkedRoot, 'evolclaw.json'));
    } finally {
      fs.rmSync(linkedRoot, { force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('blocks symlink, parent, relative, glob, and special-root H-class grants', () => {
    const root = process.env.EVOLCLAW_HOME!;
    const projectPath = path.join(root, 'projects', 'default');
    const agentPath = path.join(root, 'agents', 'demo');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=value\n');
    const linkedSecret = path.join(projectPath, 'visible.txt');
    fs.symlinkSync(path.join(root, '.env'), linkedSecret);

    const context = { projectPath, root };
    expect(checkHClassWrite('Read', { file_path: linkedSecret }, context).behavior).toBe('deny');
    expect(checkHClassWrite('Write', { file_path: path.join(projectPath, 'agent-link', 'config.json') }, context).behavior).toBe('allow');
    fs.symlinkSync(agentPath, path.join(projectPath, 'agent-link'));
    expect(checkHClassWrite('Write', { file_path: path.join(projectPath, 'agent-link', 'config.json') }, context).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: { fileSystem: { write: ['.'] } },
    }, context).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: { fileSystem: { write: [path.join(root, '**')] } },
    }, context).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: {
        fileSystem: {
          entries: [{ access: 'write', path: { type: 'special', value: { kind: 'root' } } }],
        },
      },
    }, context).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: {
        fileSystem: {
          entries: [{ access: 'read', path: { type: 'special', value: { kind: 'project_roots', subpath: '../../.env' } } }],
        },
      },
    }, context).behavior).toBe('deny');
    expect(checkHClassWrite('PermissionGrant', {
      permissions: {
        fileSystem: {
          entries: [{ access: 'read', path: { type: 'special', value: { kind: 'unknown', path: root, subpath: '.env' } } }],
        },
      },
    }, context).behavior).toBe('deny');
  });

  it('fails closed when a dangerous operation has no approval gateway', async () => {
    await expect(requestDangerousCommandPermission(
      undefined,
      'session-1',
      'Bash',
      { command: 'sudo apt update' },
      undefined,
    )).resolves.toEqual({ matched: true, decision: 'deny' });
  });

  it.each([
    'rm -fr ./dist',
    'rm -r -f ./dist',
    'rm --force --recursive ./dist',
    '/bin/rm --recursive --force ./dist',
  ])('recognizes equivalent recursive forced remove syntax: %s', (command) => {
    expect(checkDangerousCommand('Bash', { command })).toMatchObject({
      isDangerous: true,
      kind: 'rm-rf',
    });
  });

  it('scopes a 30-minute grant to one session and exact stable input', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new PermissionGateway();
      const sendPrompt = vi.fn().mockResolvedValue(undefined);
      const input = { command: 'npm test', cwd: '/repo' };
      const context = { userId: 'user-1', channelId: 'user-1' };
      const first = gateway.requestPermission('s1', 'Bash', input, sendPrompt, context);
      await vi.advanceTimersByTimeAsync(0);
      gateway.resolvePermission('s1', gateway.getPendingRequests('s1')[0], 'always', 'user-1');
      await expect(first).resolves.toBe('allow');

      sendPrompt.mockClear();
      await expect(gateway.requestPermission('s1', 'Bash', { cwd: '/repo', command: 'npm test' }, sendPrompt, context))
        .resolves.toBe('allow');
      expect(sendPrompt).not.toHaveBeenCalled();

      await expect(gateway.requestPermission('s1', 'Bash', input, sendPrompt)).resolves.toBe('deny');
      expect(sendPrompt).toHaveBeenCalledWith('当前操作需要授权，但无法验证申请人身份。');
      sendPrompt.mockClear();

      const different = gateway.requestPermission('s1', 'Bash', { command: 'npm run build', cwd: '/repo' }, sendPrompt, context);
      const otherSession = gateway.requestPermission('s2', 'Bash', input, sendPrompt, context);
      await vi.advanceTimersByTimeAsync(0);
      expect(gateway.getPendingRequests('s1')).toHaveLength(1);
      expect(gateway.getPendingRequests('s2')).toHaveLength(1);
      gateway.cancelAll('s1');
      gateway.cancelAll('s2');
      await expect(different).resolves.toBe('deny');
      await expect(otherSession).resolves.toBe('deny');

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      const expired = gateway.requestPermission('s1', 'Bash', input, sendPrompt, context);
      await vi.advanceTimersByTimeAsync(0);
      expect(gateway.getPendingRequests('s1')).toHaveLength(1);
      gateway.cancelAll('s1');
      await expect(expired).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces bypass danger approval in Claude PreToolUse with SDK default mode', async () => {
    capturedClaudeOptions.length = 0;
    const { AgentRunner } = await import('../../src/agents/claude-runner.js');
    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
      projects: { defaultPath: '/tmp/test' },
    } as any);
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setPermissionGateway(gateway as any);
    runner.setSendPrompt(vi.fn());

    const stream = await runner.runQuery(
      'sess-hook',
      'hello',
      '/tmp/test',
      undefined,
      undefined,
      undefined,
      undefined,
      { permissionMode: 'bypass' },
    );
    for await (const _event of stream) {
      // Drain mocked SDK stream.
    }

    const options = capturedClaudeOptions.at(-1);
    const preToolUse = options.hooks.PreToolUse[0].hooks[0];
    expect(options.permissionMode).toBe('default');
    await expect(preToolUse({ tool_name: 'Bash', tool_input: { command: 'sudo apt update' } }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'sess-hook',
      'dangerous:Bash:sudo',
      expect.objectContaining({ command: 'sudo apt update' }),
      expect.any(Function),
      undefined,
      '⚠️ sudo apt update',
      '以超级用户权限执行命令',
      'claude:bypass',
    );
  });

  it('fails closed for Claude MCP and unknown tools outside the local sandbox boundary', async () => {
    capturedClaudeOptions.length = 0;
    const { AgentRunner } = await import('../../src/agents/claude-runner.js');
    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
      projects: { defaultPath: '/tmp/test' },
    } as any);
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setPermissionGateway(gateway as any);
    runner.setSendPrompt(vi.fn());

    const runWithMode = async (sessionId: string, permissionMode: string) => {
      const stream = await runner.runQuery(
        sessionId,
        'hello',
        '/tmp/test',
        undefined,
        undefined,
        undefined,
        undefined,
        { permissionMode },
      );
      for await (const _event of stream) {
        // Drain mocked SDK stream.
      }
      return capturedClaudeOptions.at(-1);
    };

    const autoOptions = await runWithMode('sess-external-auto', 'auto');
    expect(autoOptions.mcpServers).toEqual({});
    const autoPreToolUse = autoOptions.hooks.PreToolUse[0].hooks[0];
    await expect(autoPreToolUse({ tool_name: 'mcp__payments__charge', tool_input: { cents: 100 } }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await expect(autoOptions.canUseTool('FutureExternalTool', { action: 'mutate' }, {
      signal: new AbortController().signal,
      toolUseID: 'tool-auto',
    })).resolves.toMatchObject({ behavior: 'deny', decisionClassification: 'user_reject' });
    expect(gateway.requestPermission).not.toHaveBeenCalled();

    const bypassOptions = await runWithMode('sess-external-bypass', 'bypass');
    const bypassPreToolUse = bypassOptions.hooks.PreToolUse[0].hooks[0];
    await expect(bypassPreToolUse({ tool_name: 'FutureExternalTool', tool_input: { action: 'mutate' } }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(gateway.requestPermission).toHaveBeenLastCalledWith(
      'sess-external-bypass',
      'FutureExternalTool',
      { action: 'mutate' },
      expect.any(Function),
      undefined,
      expect.any(String),
      '外部或未知工具不受 Claude 本地 sandbox 的完整约束',
      expect.stringMatching(/^claude:bypass:external:[a-f0-9]{64}$/),
    );

    const requestOptions = await runWithMode('sess-external-request', 'request');
    const requestPreToolUse = requestOptions.hooks.PreToolUse[0].hooks[0];
    await expect(requestPreToolUse({ tool_name: 'mcp__payments__charge', tool_input: { cents: 100 } }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(gateway.requestPermission).toHaveBeenLastCalledWith(
      'sess-external-request',
      'mcp__payments__charge',
      { cents: 100 },
      expect.any(Function),
      undefined,
      expect.any(String),
      '外部或未知工具不受 Claude 本地 sandbox 的完整约束',
      expect.stringMatching(/^claude:request:external:[a-f0-9]{64}$/),
    );
  });

  it('keeps Claude approval prompt delivery bound to the originating session', async () => {
    capturedClaudeOptions.length = 0;
    const { AgentRunner } = await import('../../src/agents/claude-runner.js');
    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
      projects: { defaultPath: '/tmp/test' },
    } as any);
    const sharedPrompt = vi.fn();
    const sessionPrompt = vi.fn();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setSendPrompt(sharedPrompt);
    runner.setPermissionGateway(gateway as any);
    runner.setPermissionContext('sess-bound-prompt', {
      userId: 'owner.agentid.pub',
      sendPrompt: sessionPrompt,
    } as any);

    const stream = await runner.runQuery(
      'sess-bound-prompt',
      'hello',
      '/tmp/test',
      undefined,
      undefined,
      undefined,
      undefined,
      { permissionMode: 'bypass' },
    );
    for await (const _event of stream) {
      // Drain mocked SDK stream.
    }

    const preToolUse = capturedClaudeOptions.at(-1).hooks.PreToolUse[0].hooks[0];
    await preToolUse({ tool_name: 'Bash', tool_input: { command: 'sudo apt update' } });
    expect(gateway.requestPermission.mock.calls[0][3]).toBe(sessionPrompt);
    expect(gateway.requestPermission.mock.calls[0][3]).not.toBe(sharedPrompt);
  });

  it('blocks on-disk Claude hooks and inline skill shells while preserving host callbacks', async () => {
    capturedClaudeOptions.length = 0;
    const { AgentRunner } = await import('../../src/agents/claude-runner.js');
    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
      projects: { defaultPath: '/tmp/test' },
    } as any);

    const stream = await runner.runQuery('sess-hooks', 'hello', '/tmp/test');
    for await (const _event of stream) {
    }

    const options = capturedClaudeOptions.at(-1);
    expect(options.managedSettings).toEqual({
      allowManagedHooksOnly: true,
      disableSkillShellExecution: true,
      allowedHttpHookUrls: [],
      allowManagedPermissionRulesOnly: true,
    });
    expect(options.settingSources).toEqual(['project', 'user']);
    expect(options.hooks.PreToolUse[0].hooks[0]).toEqual(expect.any(Function));

    const legacyRunner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
      agents: { claude: { useSettingSources: false } },
      projects: { defaultPath: '/tmp/test' },
    } as any);
    const legacyStream = await legacyRunner.runQuery('sess-hooks-legacy', 'hello', '/tmp/test');
    for await (const _event of legacyStream) {
    }
    expect(capturedClaudeOptions.at(-1).settingSources).toEqual([]);

    (runner as any).runSessionCommand('/compact', 'sdk-session', '/tmp/test');
    expect(capturedClaudeOptions.at(-1)).toMatchObject({
      tools: [],
      skills: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      managedSettings: { allowManagedHooksOnly: true },
    });
  });

  it('enables the Claude SDK sandbox with H-class read/write denies', async () => {
    capturedClaudeOptions.length = 0;
    const root = process.env.EVOLCLAW_HOME!;
    const fakeBwrap = path.join(root, 'bwrap');
    fs.writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.EVOLCLAW_BWRAP_PATH = fakeBwrap;
    _resetSandboxRuntimeCache();
    try {
      const { AgentRunner } = await import('../../src/agents/claude-runner.js');
      const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
        projects: { defaultPath: root },
      } as any);
      const stream = await runner.runQuery('sess-sandbox', 'hello', root);
      for await (const _event of stream) {
        // Drain mocked SDK stream.
      }

      const sandbox = capturedClaudeOptions.at(-1)?.sandbox;
      expect(capturedClaudeOptions.at(-1)?.strictMcpConfig).toBe(true);
      expect(sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: {
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
      });
      expect(sandbox.filesystem.denyRead).toContain(path.join(root, '.env'));
      expect(sandbox.filesystem.denyWrite).toContain(path.join(root, 'agents', '*', 'config.json'));
    } finally {
      delete process.env.EVOLCLAW_BWRAP_PATH;
      _resetSandboxRuntimeCache();
    }
  });

  it('keeps Claude session identity per-call under concurrent runs', async () => {
    capturedClaudeOptions.length = 0;
    const { AgentRunner } = await import('../../src/agents/claude-runner.js');
    const root = process.env.EVOLCLAW_HOME!;
    const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, {
      projects: { defaultPath: root },
    } as any);

    const [first, second] = await Promise.all([
      runner.runQuery('session-a', 'first', root),
      runner.runQuery('session-b', 'second', root),
    ]);
    for await (const _event of first) {
      // Drain mocked SDK stream.
    }
    for await (const _event of second) {
      // Drain mocked SDK stream.
    }

    const sessionIds = capturedClaudeOptions.slice(-2).map(options => options.env.EVOLCLAW_SESSION_ID);
    expect(sessionIds).toEqual(['session-a', 'session-b']);
  });

  it('builds a full workspace sandbox with H-class masks', () => {
    const root = process.env.EVOLCLAW_HOME!;
    const projectPath = path.join(root, 'projects', 'default');
    const fakeBwrap = path.join(root, 'bwrap');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=value\n');
    fs.writeFileSync(path.join(root, 'agents', 'demo', 'contact.json'), '{}\n');
    fs.writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.EVOLCLAW_BWRAP_PATH = fakeBwrap;
    _resetSandboxRuntimeCache();
    try {
      const command = buildBubblewrapCommand('gemini', ['-p', 'hello'], { projectPath, root });
      expect(command?.command).toBe(fakeBwrap);
      expect(command?.args).toEqual(expect.arrayContaining([
        '--ro-bind', '/', '/',
        '--bind', projectPath, projectPath,
        '--ro-bind', '/dev/null', path.join(root, '.env'),
        '--ro-bind', '/dev/null', path.join(root, 'agents', 'demo', 'contact.json'),
        '--tmpfs', '/run',
        '--chdir', projectPath,
        '--', 'gemini', '-p', 'hello',
      ]));

      const codexGuard = buildHClassGuardCommand('codex', ['app-server', '--listen', 'stdio://'], root);
      expect(codexGuard?.command).toBe(fakeBwrap);
      expect(codexGuard?.args).toEqual(expect.arrayContaining([
        '--bind', '/', '/',
        '--tmpfs', '/run',
        '--', 'codex', 'app-server', '--listen', 'stdio://',
      ]));
    } finally {
      delete process.env.EVOLCLAW_BWRAP_PATH;
      _resetSandboxRuntimeCache();
    }
  });
});

describe('Gemini headless permission mapping', () => {
  it('supports readonly/auto and safely degrades callback-dependent modes', () => {
    expect(resolveGeminiPermissionProfile('readonly')).toEqual({ mode: 'readonly', approvalMode: 'plan' });
    expect(resolveGeminiPermissionProfile('auto')).toEqual({ mode: 'auto', approvalMode: 'auto_edit' });
    expect(resolveGeminiPermissionProfile('request')).toEqual({
      mode: 'readonly',
      approvalMode: 'plan',
      degradedFrom: 'request',
    });
    expect(resolveGeminiPermissionProfile('bypass')).toEqual({
      mode: 'readonly',
      approvalMode: 'plan',
      degradedFrom: 'bypass',
    });
  });

  it('generates an admin-tier deny boundary instead of using yolo', () => {
    const readonlyPolicy = buildGeminiAdminPolicy(resolveGeminiPermissionProfile('readonly'));
    expect(readonlyPolicy).toContain('toolName = "*"');
    expect(readonlyPolicy).toContain('decision = "deny"');
    expect(readonlyPolicy).toContain('toolName = ["read_file"');
    expect(readonlyPolicy).toContain('agents[/\\\\][^/\\\\"]+[/\\\\]contact\\.json');

    const autoPolicy = buildGeminiAdminPolicy(resolveGeminiPermissionProfile('auto'));
    expect(autoPolicy).toContain('run_shell_command');
    expect(autoPolicy).toContain('toolName = "run_shell_command"\ndecision = "deny"');
    expect(autoPolicy).toContain('"write_file","replace","web_fetch"');
    expect(autoPolicy).toContain('decision = "allow"');
  });

  it('uses external bubblewrap without nesting Gemini sandbox flags', () => {
    const profile = resolveGeminiPermissionProfile('auto');
    expect(buildGeminiPermissionArgs(profile, '/tmp/policy.toml', false)).toEqual([
      '--admin-policy', '/tmp/policy.toml', '--sandbox', '--approval-mode=auto_edit',
    ]);
    expect(buildGeminiPermissionArgs(profile, '/tmp/policy.toml', true)).toEqual([
      '--admin-policy', '/tmp/policy.toml', '--approval-mode=auto_edit',
    ]);
  });

  it('only opens identity-authorized ctl operations in Gemini policy', () => {
    const profile = resolveGeminiPermissionProfile('readonly');
    const sendOnly = buildGeminiAdminPolicy(profile, { ctlSend: true, ctlFile: false });
    expect(sendOnly).toContain('ctl[ ]+send');
    expect(sendOnly).not.toContain('ctl[ ]+file');

    const fileOnly = buildGeminiAdminPolicy(profile, { ctlSend: false, ctlFile: true });
    expect(fileOnly).not.toContain('ctl[ ]+send');
    expect(fileOnly).toContain('ctl[ ]+file');
  });

  it('advertises request and bypass as unavailable without ACP', () => {
    const runner = new GeminiRunner({
      agents: { gemini: { apiKey: 'test', model: 'gemini-2.5-pro', cliPath: 'gemini' } },
    } as any, { onSessionIdUpdate: vi.fn() } as any);
    const modes = runner.listModes();
    expect(modes.map(mode => mode.key)).toEqual(['readonly', 'auto', 'request', 'bypass']);
    expect(modes.find(mode => mode.key === 'request')).toMatchObject({ available: false });
    expect(modes.find(mode => mode.key === 'bypass')).toMatchObject({ available: false });
    runner.setMode('noask');
    expect(runner.getMode()).toBe('readonly');
  });
});
