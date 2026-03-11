import { SessionManager } from '../src/session-manager.js';
import fs from 'fs';

async function testMultiSession() {
  console.log('测试多会话管理功能...\n');

  // 清理测试数据库
  const testDbPath = './data/test-multi-session.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const sessionManager = new SessionManager(testDbPath);

  try {
    // 测试 1：多聊天独立会话
    console.log('1. 测试多聊天独立会话');
    const groupA = await sessionManager.getOrCreateSession('feishu', 'group-A', '/home/user/evolclaw');
    const groupB = await sessionManager.getOrCreateSession('feishu', 'group-B', '/home/user/backend');
    const dmA = await sessionManager.getOrCreateSession('feishu', 'dm-A', '/home/user/frontend');

    console.log(`   群聊 A: ${groupA.projectPath}, 活跃: ${groupA.isActive}`);
    console.log(`   群聊 B: ${groupB.projectPath}, 活跃: ${groupB.isActive}`);
    console.log(`   私聊 A: ${dmA.projectPath}, 活跃: ${dmA.isActive}`);

    if (!groupA.isActive || !groupB.isActive || !dmA.isActive) {
      throw new Error('新建会话应该是活跃状态');
    }
    console.log('   ✓ 通过\n');

    // 测试 2：单聊天多项目切换
    console.log('2. 测试单聊天多项目切换');
    console.log('   初始状态: 群聊 A 在 evolclaw 项目');

    // 模拟 Claude Session ID
    await sessionManager.updateClaudeSessionId('feishu', 'group-A', 'session-aaa');
    let session = await sessionManager.getSession('feishu', 'group-A');
    console.log(`   Claude Session ID: ${session?.claudeSessionId}`);

    // 切换到 backend 项目
    console.log('   切换到 backend 项目...');
    const switched = await sessionManager.switchProject('feishu', 'group-A', '/home/user/backend');
    console.log(`   新会话: ${switched.projectPath}, Claude Session: ${switched.claudeSessionId || '(null)'}`);

    // 验证旧会话被保留但不活跃
    const allSessions = await sessionManager.listSessions('feishu', 'group-A');
    console.log(`   群聊 A 的所有会话数: ${allSessions.length}`);
    const evolclession = allSessions.find(s => s.projectPath === '/home/user/evolclaw');
    const backendSession = allSessions.find(s => s.projectPath === '/home/user/backend');

    if (!evolclession || evolclession.isActive) {
      throw new Error('evolclaw 会话应该存在但不活跃');
    }
    if (!backendSession || !backendSession.isActive) {
      throw new Error('backend 会话应该存在且活跃');
    }
    if (evolclession.claudeSessionId !== 'session-aaa') {
      throw new Error('evolclaw 会话的 Claude Session ID 应该被保留');
    }
    console.log('   ✓ 通过\n');

    // 测试 3：会话恢复
    console.log('3. 测试会话恢复');
    await sessionManager.updateClaudeSessionId('feishu', 'group-A', 'session-bbb');

    // 切换回 evolclaw
    console.log('   切换回 evolclaw 项目...');
    const restored = await sessionManager.switchProject('feishu', 'group-A', '/home/user/evolclaw');
    console.log(`   恢复的会话: ${restored.projectPath}, Claude Session: ${restored.claudeSessionId}`);

    if (restored.claudeSessionId !== 'session-aaa') {
      throw new Error('应该恢复之前的 Claude Session ID');
    }
    if (!restored.isActive) {
      throw new Error('恢复的会话应该是活跃状态');
    }

    // 验证 backend 会话被保留
    const allSessions2 = await sessionManager.listSessions('feishu', 'group-A');
    const backendSession2 = allSessions2.find(s => s.projectPath === '/home/user/backend');
    if (!backendSession2 || backendSession2.isActive) {
      throw new Error('backend 会话应该存在但不活跃');
    }
    if (backendSession2.claudeSessionId !== 'session-bbb') {
      throw new Error('backend 会话的 Claude Session ID 应该被保留');
    }
    console.log('   ✓ 通过\n');

    // 测试 4：/new 命令只影响活跃会话
    console.log('4. 测试 /new 命令只影响活跃会话');
    await sessionManager.clearActiveSession('feishu', 'group-A');

    const activeSession = await sessionManager.getSession('feishu', 'group-A');
    if (activeSession?.claudeSessionId) {
      throw new Error('活跃会话的 Claude Session ID 应该被清除');
    }

    const allSessions3 = await sessionManager.listSessions('feishu', 'group-A');
    const backendSession3 = allSessions3.find(s => s.projectPath === '/home/user/backend');
    if (backendSession3?.claudeSessionId !== 'session-bbb') {
      throw new Error('非活跃会话的 Claude Session ID 不应该被清除');
    }
    console.log('   ✓ 通过\n');

    // 测试 5：数据库约束
    console.log('5. 测试数据库约束');
    try {
      // 尝试创建重复的 (channel, channel_id, project_path) 组合
      await sessionManager.switchProject('feishu', 'group-A', '/home/user/backend');
      await sessionManager.switchProject('feishu', 'group-A', '/home/user/backend');
      console.log('   ✓ 通过（允许切换到同一项目）\n');
    } catch (error) {
      throw new Error('应该允许切换到同一项目');
    }

    // 测试 6：列出所有会话
    console.log('6. 测试列出所有会话');
    const groupASessions = await sessionManager.listSessions('feishu', 'group-A');
    console.log(`   群聊 A 的会话:`);
    for (const s of groupASessions) {
      console.log(`     - ${s.projectPath} (活跃: ${s.isActive}, Claude: ${s.claudeSessionId || '(null)'})`);
    }
    console.log('   ✓ 通过\n');

    console.log('✓ 所有多会话管理测试通过！');

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

testMultiSession();
