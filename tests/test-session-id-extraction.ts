import { AgentRunner } from '../src/agent-runner.js';
import { loadConfig } from '../src/config.js';

async function testSessionIdExtraction() {
  console.log('测试 Session ID 提取逻辑...\n');

  const config = loadConfig();
  const agentRunner = new AgentRunner(config.anthropic.apiKey);
  const testSessionId = 'test-session-' + Date.now();
  const projectPath = './projects/default';

  try {
    console.log(`会话 ID: ${testSessionId}`);
    console.log(`项目路径: ${projectPath}\n`);

    const stream = await agentRunner.runQuery(
      testSessionId,
      '你好，请简单回复一下',
      projectPath
    );

    let response = '';
    let extractedSessionId: string | undefined;

    for await (const event of stream) {
      // 提取 session ID
      if (event.session_id) {
        extractedSessionId = event.session_id;
        console.log(`✓ 提取到 Claude Session ID: ${extractedSessionId}`);
        agentRunner.updateSessionId(testSessionId, event.session_id);
      }

      if (event.type === 'text_delta') {
        response += event.text;
      }
    }

    console.log(`\n响应: ${response}\n`);

    // 验证第二次查询是否使用了 resume
    console.log('测试 resume 功能...');
    const stream2 = await agentRunner.runQuery(
      testSessionId,
      '你还记得我刚才说了什么吗？',
      projectPath
    );

    let response2 = '';
    for await (const event of stream2) {
      if (event.type === 'text_delta') {
        response2 += event.text;
      }
    }

    console.log(`\n第二次响应: ${response2}\n`);
    console.log('✓ Session ID 提取和 resume 功能测试完成！');

  } catch (error) {
    console.error('测试失败:', error);
    process.exit(1);
  }
}

testSessionIdExtraction();
