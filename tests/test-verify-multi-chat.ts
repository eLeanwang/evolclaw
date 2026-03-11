import { SessionManager } from '../src/session-manager.js';
import fs from 'fs';

async function testMultiChatMultiProject() {
  console.log('验证：同一渠道+项目可以有多个有效会话\n');

  const testDbPath = './data/test-verify.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const sessionManager = new SessionManager(testDbPath);

  try {
    // 场景：4个不同的聊天，每个都在 evolclaw 项目工作
    console.log('场景：4个聊天同时在 evolclaw 项目工作\n');

    const groupA = await sessionManager.getOrCreateSession('feishu', 'group-A', '/home/user/evolclaw');
    const groupB = await sessionManager.getOrCreateSession('feishu', 'group-B', '/home/user/evolclaw');
    const dmA = await sessionManager.getOrCreateSession('feishu', 'dm-A', '/home/user/evolclaw');
    const dmB = await sessionManager.getOrCreateSession('feishu', 'dm-B', '/home/user/evolclaw');

    console.log('创建的会话：');
    console.log(`  群聊 A: ${groupA.id}, 项目: ${groupA.projectPath}, 活跃: ${groupA.isActive}`);
    console.log(`  群聊 B: ${groupB.id}, 项目: ${groupB.projectPath}, 活跃: ${groupB.isActive}`);
    console.log(`  私聊 A: ${dmA.id}, 项目: ${dmA.projectPath}, 活跃: ${dmA.isActive}`);
    console.log(`  私聊 B: ${dmB.id}, 项目: ${dmB.projectPath}, 活跃: ${dmB.isActive}`);

    // 验证：4个不同的会话 ID
    const ids = new Set([groupA.id, groupB.id, dmA.id, dmB.id]);
    if (ids.size !== 4) {
      throw new Error('应该有4个不同的会话');
    }
    console.log('\n✓ 4个聊天有4个独立的会话\n');

    // 模拟每个聊天都有自己的 Claude Session ID
    await sessionManager.updateClaudeSessionId('feishu', 'group-A', 'session-groupA');
    await sessionManager.updateClaudeSessionId('feishu', 'group-B', 'session-groupB');
    await sessionManager.updateClaudeSessionId('feishu', 'dm-A', 'session-dmA');
    await sessionManager.updateClaudeSessionId('feishu', 'dm-B', 'session-dmB');

    // 验证：每个聊天的 Claude Session ID 独立
    const groupA2 = await sessionManager.getSession('feishu', 'group-A');
    const groupB2 = await sessionManager.getSession('feishu', 'group-B');
    const dmA2 = await sessionManager.getSession('feishu', 'dm-A');
    const dmB2 = await sessionManager.getSession('feishu', 'dm-B');

    console.log('每个聊天的 Claude Session ID：');
    console.log(`  群聊 A: ${groupA2?.claudeSessionId}`);
    console.log(`  群聊 B: ${groupB2?.claudeSessionId}`);
    console.log(`  私聊 A: ${dmA2?.claudeSessionId}`);
    console.log(`  私聊 B: ${dmB2?.claudeSessionId}`);

    if (groupA2?.claudeSessionId !== 'session-groupA' ||
        groupB2?.claudeSessionId !== 'session-groupB' ||
        dmA2?.claudeSessionId !== 'session-dmA' ||
        dmB2?.claudeSessionId !== 'session-dmB') {
      throw new Error('每个聊天应该有独立的 Claude Session ID');
    }
    console.log('\n✓ 每个聊天的会话完全独立\n');

    // 场景2：群聊 A 切换到 backend 项目，不影响其他聊天
    console.log('场景2：群聊 A 切换到 backend 项目\n');
    await sessionManager.switchProject('feishu', 'group-A', '/home/user/backend');

    const groupA3 = await sessionManager.getSession('feishu', 'group-A');
    const groupB3 = await sessionManager.getSession('feishu', 'group-B');

    console.log(`  群聊 A: 项目=${groupA3?.projectPath}, Claude Session=${groupA3?.claudeSessionId || '(null)'}`);
    console.log(`  群聊 B: 项目=${groupB3?.projectPath}, Claude Session=${groupB3?.claudeSessionId}`);

    if (groupA3?.projectPath !== '/home/user/backend') {
      throw new Error('群聊 A 应该切换到 backend 项目');
    }
    if (groupB3?.projectPath !== '/home/user/evolclaw' || groupB3?.claudeSessionId !== 'session-groupB') {
      throw new Error('群聊 B 不应该受影响');
    }
    console.log('\n✓ 群聊 A 切换项目不影响其他聊天\n');

    // 验证：群聊 A 的 evolclaw 会话被保留
    const groupASessions = await sessionManager.listSessions('feishu', 'group-A');
    console.log(`群聊 A 的所有会话（${groupASessions.length}个）：`);
    for (const s of groupASessions) {
      console.log(`  - ${s.projectPath} (活跃: ${s.isActive}, Claude: ${s.claudeSessionId || '(null)'})`);
    }

    const evolclession = groupASessions.find(s => s.projectPath === '/home/user/evolclaw');
    if (!evolclession || evolclession.claudeSessionId !== 'session-groupA') {
      throw new Error('群聊 A 的 evolclaw 会话应该被保留');
    }
    console.log('\n✓ 群聊 A 的 evolclaw 会话被保留\n');

    console.log('✅ 验证通过：同一渠道+项目可以有多个有效会话！');
    console.log('   - 群聊 A、群聊 B、私聊 A、私聊 B 完全独立');
    console.log('   - 每个聊天可以在多个项目间切换');
    console.log('   - 会话历史完整保留');

  } catch (error) {
    console.error('✗ 验证失败:', error);
    process.exit(1);
  } finally {
    sessionManager.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  }
}

testMultiChatMultiProject();
