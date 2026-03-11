import { SessionManager } from '../src/session-manager.js';
import { AgentRunner } from '../src/agent-runner.js';
import { loadConfig } from '../src/config.js';
import fs from 'fs';

async function testSessionPersistence() {
  console.log('测试 Session ID 持久化功能...\n');

  // 清理测试数据库
  const testDbPath = './data/test-sessions.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const config = loadConfig();
  const sessionManager = new SessionManager(testDbPath);

  // 创建带持久化回调的 AgentRunner
  const agentRunner = new AgentRunner(
    config.anthropic.apiKey,
    async (sessionId, claudeSessionId) => {
      console.log(`✓ 持久化回调触发: ${sessionId} -> ${claudeSessionId}`);
      // 从 sessionId 解析 channel 和 channelId
      // 格式: feishu-test-chat-123-1772985089750
      const parts = sessionId.split('-');
      if (parts.length >= 3) {
        const channel = parts[0] as 'feishu' | 'acp';
        // channelId 是中间部分（去掉 channel 和最后的时间戳）
        const channelId = parts.slice(1, -1).join('-');
        console.log(`   解析: channel=${channel}, channelId=${channelId}`);
        await sessionManager.updateClaudeSessionId(channel, channelId, claudeSessionId);
      }
    }
  );

  try {
    // 1. 创建会话
    console.log('1. 创建新会话...');
    const session = await sessionManager.getOrCreateSession('feishu', 'test-chat-123', './projects/default');
    console.log(`   会话 ID: ${session.id}`);
    console.log(`   Claude Session ID: ${session.claudeSessionId || '(未设置)'}\n`);

    // 2. 模拟第一次查询
    console.log('2. 模拟第一次查询（会提取 session ID）...');
    const stream1 = await agentRunner.runQuery(
      session.id,
      '你好',
      session.projectPath,
      session.claudeSessionId
    );

    let claudeSessionId: string | undefined;
    for await (const event of stream1) {
      if (event.session_id) {
        claudeSessionId = event.session_id;
        agentRunner.updateSessionId(session.id, event.session_id);
        console.log(`   提取到 Claude Session ID: ${claudeSessionId}`);
        break; // 只需要第一个事件
      }
    }

    // 3. 验证数据库中的 session ID
    console.log('\n3. 验证数据库持久化...');
    const updatedSession = await sessionManager.getSession('feishu', 'test-chat-123');
    console.log(`   数据库中的 Claude Session ID: ${updatedSession?.claudeSessionId || '(未找到)'}`);

    if (updatedSession?.claudeSessionId === claudeSessionId) {
      console.log('   ✓ Session ID 已成功持久化到数据库！');
    } else {
      console.log('   ✗ Session ID 持久化失败');
    }

    // 4. 测试 /new 命令（清除 session ID）
    console.log('\n4. 测试清除 session ID...');
    await sessionManager.clearClaudeSessionId('feishu', 'test-chat-123');
    await agentRunner.closeSession(session.id);

    const clearedSession = await sessionManager.getSession('feishu', 'test-chat-123');
    console.log(`   清除后的 Claude Session ID: ${clearedSession?.claudeSessionId || '(null)'}`);

    if (!clearedSession?.claudeSessionId) {
      console.log('   ✓ Session ID 已成功清除！');
    } else {
      console.log('   ✗ Session ID 清除失败');
    }

    // 5. 测试项目切换时清除 session
    console.log('\n5. 测试项目切换...');
    await sessionManager.updateClaudeSessionId('feishu', 'test-chat-123', 'test-session-id-123');
    console.log('   设置测试 Session ID: test-session-id-123');

    await sessionManager.updateProjectPath('feishu', 'test-chat-123', './projects/new-project');
    await sessionManager.clearClaudeSessionId('feishu', 'test-chat-123');

    const switchedSession = await sessionManager.getSession('feishu', 'test-chat-123');
    console.log(`   切换后的项目路径: ${switchedSession?.projectPath}`);
    console.log(`   切换后的 Claude Session ID: ${switchedSession?.claudeSessionId || '(null)'}`);

    if (switchedSession?.projectPath === './projects/new-project' && !switchedSession?.claudeSessionId) {
      console.log('   ✓ 项目切换和 Session 清除成功！');
    }

    console.log('\n✓ 所有测试通过！');

  } catch (error) {
    console.error('\n✗ 测试失败:', error);
    process.exit(1);
  } finally {
    sessionManager.close();
    // 清理测试数据库
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  }
}

testSessionPersistence();
