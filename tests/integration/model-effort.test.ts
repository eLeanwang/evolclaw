import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRunner } from '../../src/core/agent-runner.js';
import { CommandHandler } from '../../src/core/command-handler.js';
import { Config } from '../../src/types.js';

function makeRunner(effort?: string) {
  const config: Config = {
    agents: { anthropic: { effort: effort as any } },
    projects: { defaultPath: '/tmp' }
  };
  const runner = new AgentRunner('test-key', 'sonnet', undefined, undefined, config);
  if (effort) runner.setEffort(effort as any);
  return { runner, config };
}

function makeMockSessionManager() {
  return {
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'test-session', channel: 'test', channelId: 'test-ch',
      projectPath: '/tmp', isActive: true,
    }),
    getOrCreateSession: vi.fn().mockResolvedValue({
      id: 'test-session', channel: 'test', channelId: 'test-ch',
      projectPath: '/tmp', isActive: true,
    }),
  };
}

function makeHandler(runner: AgentRunner, config: Config) {
  return new CommandHandler(makeMockSessionManager() as any, runner, config, null as any);
}

async function cmd(handler: CommandHandler, input: string) {
  return handler.handle(input, 'test', 'test-ch', undefined, undefined, undefined);
}

describe('/model effort 集成测试', () => {
  it('初始状态无 effort 显示 auto', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model');
    expect(result).toContain('auto (SDK默认)');
    expect(runner.getEffort()).toBeUndefined();
  });

  it('初始 effort=high 时正确显示', async () => {
    const { runner, config } = makeRunner('high');
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model');
    expect(result).toContain('high ◆◆◆◇');
  });

  it('/model high 切换 effort', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    await cmd(h, '/model high');
    expect(runner.getEffort()).toBe('high');
    const result = await cmd(h, '/model');
    expect(result).toContain('high ◆◆◆◇');
  });

  it('/model sonnet low 同时切换 model+effort', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model sonnet low');
    expect(result).toContain('模型: sonnet');
    expect(result).toContain('推理强度: low ◆◇◇◇');
    expect(runner.getModel()).toBe('sonnet');
    expect(runner.getEffort()).toBe('low');
  });

  it('/model sonnet max 在非 opus 时返回警告且不切换', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model sonnet max');
    expect(result).toContain('⚠️');
    expect(runner.getEffort()).toBeUndefined();  // 未切换
    expect(runner.getModel()).toBe('sonnet');    // model 也未切换
  });

  it('/model opus max 成功切换', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model opus max');
    expect(result).toContain('模型: opus');
    expect(result).toContain('推理强度: max ◆◆◆◆');
    expect(runner.getModel()).toBe('opus');
    expect(runner.getEffort()).toBe('max');
  });

  it('/model auto 清除 effort 恢复未设置状态', async () => {
    const { runner, config } = makeRunner('high');
    const h = makeHandler(runner, config);
    await cmd(h, '/model auto');
    expect(runner.getEffort()).toBeUndefined();
    const result = await cmd(h, '/model');
    expect(result).toContain('auto (SDK默认)');
  });

  it('/model 无效参数返回错误', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model foobar');
    expect(result).toContain('❌');
  });

  it('/model 无效 effort 参数返回错误', async () => {
    const { runner, config } = makeRunner();
    const h = makeHandler(runner, config);
    const result = await cmd(h, '/model sonnet ultra');
    expect(result).toContain('❌');
  });
});
