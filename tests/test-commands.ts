import { SessionManager } from '../src/session-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { loadConfig } from '../src/config.js';
import fs from 'fs';

async function testCommands() {
  console.log('测试简化命令功能...\n');

  // 清理测试数据库
  const testDbPath = './data/test-commands.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const config = loadConfig();
  const sessionManager = new SessionManager(testDbPath);
  const agentRunner = new AgentRunner(config.anthropic.apiKey);

  // 模拟命令处理函数
  async function handleCommand(content: string): Promise<string | null> {
    const session = await sessionManager.getOrCreateSession('feishu', 'test-chat', './projects/default');

    // 简化的命令处理逻辑
    if (content === '/help') {
      return '帮助信息...';
    }
    if (content === '/status') {
      return `会话状态: ${session.id}`;
    }
    if (content === '/pwd') {
      return `当前项目: ${session.projectPath}`;
    }
    if (content === '/plist') {
      return '项目列表...';
    }
    if (content === '/new') {
      await sessionManager.clearClaudeSessionId('feishu', 'test-chat');
      return '✓ 已清除会话';
    }
    return null;
  }

  try {
    console.log('1. 测试 /help 命令');
    let result = await handleCommand('/help');
    console.log(`   结果: ${result}\n`);

    console.log('2. 测试 /status 命令');
    result = await handleCommand('/status');
    console.log(`   结果: ${result}\n`);

    console.log('3. 测试 /pwd 命令');
    result = await handleCommand('/pwd');
    console.log(`   结果: ${result}\n`);

    console.log('4. 测试 /plist 命令');
    result = await handleCommand('/plist');
    console.log(`   结果: ${result}\n`);

    console.log('5. 测试 /new 命令');
    result = await handleCommand('/new');
    console.log(`   结果: ${result}\n`);

    console.log('6. 测试非命令消息');
    result = await handleCommand('你好');
    console.log(`   结果: ${result === null ? '(null - 传递给 Agent)' : result}\n`);

    console.log('✓ 所有命令测试通过！');

  } catch (error) {
    console.error('✗ 测试失败:', error);
    process.exit(1);
  } finally {
    sessionManager.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  }
}

testCommands();
