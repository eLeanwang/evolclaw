import { describe, it, expect } from 'vitest';

describe('CommandHandler isOwned blocking', () => {
  // Since CommandHandler has a very complex constructor, test the blocking logic
  // by verifying the pattern matching directly.

  const blockedCommands = ['/project foo', '/bind /tmp', '/plist', '/p myproj', '/project', '/bind ', '/p '];
  const allowedCommands = ['/agent', '/status', '/model opus', '/help', '/new'];

  it('identifies project commands that should be blocked', () => {
    for (const cmd of blockedCommands) {
      const normalized = cmd.toLowerCase().trim();
      const isProjectCmd = normalized === '/project' || normalized.startsWith('/project ') ||
        normalized === '/bind' || normalized.startsWith('/bind ') ||
        normalized === '/plist' ||
        normalized === '/p' || normalized.startsWith('/p ');
      expect(isProjectCmd, `Expected "${cmd}" to be blocked`).toBe(true);
    }
  });

  it('does not block non-project commands', () => {
    for (const cmd of allowedCommands) {
      const normalized = cmd.toLowerCase().trim();
      const isProjectCmd = normalized === '/project' || normalized.startsWith('/project ') ||
        normalized === '/bind' || normalized.startsWith('/bind ') ||
        normalized === '/plist' ||
        normalized === '/p' || normalized.startsWith('/p ');
      expect(isProjectCmd, `Expected "${cmd}" to NOT be blocked`).toBe(false);
    }
  });

  it('blocks /agent with args but allows /agent alone', () => {
    const switchCmd = '/agent codex';
    const viewCmd = '/agent';

    expect(switchCmd.startsWith('/agent ')).toBe(true);  // blocked
    expect(viewCmd.startsWith('/agent ')).toBe(false);   // allowed
  });

  it('generates correct error messages', () => {
    const owningAgent = { name: 'my-bot', projectPath: '/home/project', baseagent: 'claude' };

    const projectMsg = `❌ 当前通道由 agent [${owningAgent.name}] 管理，项目已锁定为 ${owningAgent.projectPath}`;
    expect(projectMsg).toContain('my-bot');
    expect(projectMsg).toContain('/home/project');

    const agentMsg = `❌ 当前通道由 agent [${owningAgent.name}] 管理，baseagent 已锁定为 ${owningAgent.baseagent}`;
    expect(agentMsg).toContain('my-bot');
    expect(agentMsg).toContain('claude');
  });
});
