import { query } from '@anthropic-ai/claude-agent-sdk';

async function test() {
  console.log('测试 Claude Code SDK with custom baseUrl...');

  // 设置环境变量
  process.env.ANTHROPIC_BASE_URL = 'https://mg.aid.pub/claude-proxy';
  process.env.ANTHROPIC_API_KEY = 'sk-ccb8a491-fd64-478e-851e-d901b9dea308';

  try {
    const result = query({
      prompt: '你好，请回复"测试成功"',
      options: {
        cwd: './projects/default',
        env: {
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
          PATH: process.env.PATH
        }
      }
    });

    let response = '';
    let hasError = false;
    let eventCount = 0;
    for await (const event of result) {
      eventCount++;
      console.log(`\n事件 #${eventCount}:`, JSON.stringify(event, null, 2).substring(0, 500));

      if (event.type === 'text_delta') {
        response += event.text;
        process.stdout.write(event.text);
      }
      if (event.type === 'error') {
        hasError = true;
        console.error('\n错误事件:', JSON.stringify(event, null, 2));
      }
    }

    if (hasError) {
      console.log('\n✗ 测试失败：收到错误事件');
    } else if (response) {
      console.log('\n\n✓ 测试完成，响应:', response.substring(0, 100));
    } else {
      console.log('\n\n⚠ 测试完成但没有响应');
    }
  } catch (error) {
    console.error('✗ 测试失败:', error);
    if (error instanceof Error) {
      console.error('错误堆栈:', error.stack);
    }
  }
}

test();
