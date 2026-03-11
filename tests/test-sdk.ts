import { query } from '@anthropic-ai/claude-agent-sdk';

async function test() {
  console.log('测试 Claude Code SDK...');

  const result = query({
    prompt: '你好',
    options: {
      cwd: './projects/default',
      env: {
        ANTHROPIC_API_KEY: 'sk-ccb8a491-fd64-478e-851e-d901b9dea308',
        PATH: process.env.PATH
      }
    }
  });

  for await (const event of result) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text);
    }
    if (event.type === 'error') {
      console.error('错误:', event);
    }
  }
  console.log('\n完成');
}

test().catch(console.error);
