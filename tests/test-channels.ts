import { FeishuChannel, ACPChannel } from '../src/channels/index.js';

async function testFeishu() {
  console.log('Testing FeishuChannel...');
  const channel = new FeishuChannel({
    appId: 'test-app-id',
    appSecret: 'test-secret'
  });

  channel.onMessage(async (chatId, content) => {
    console.log(`Received: ${chatId} -> ${content}`);
  });

  console.log('✓ FeishuChannel interface OK');
}

async function testACP() {
  console.log('Testing ACPChannel...');
  const channel = new ACPChannel({
    domain: 'test.acp',
    agentName: 'test-agent'
  });

  await channel.connect();
  channel.onMessage(async (sessionId, content) => {
    console.log(`Received: ${sessionId} -> ${content}`);
  });
  await channel.disconnect();

  console.log('✓ ACPChannel interface OK');
}

async function main() {
  await testFeishu();
  await testACP();
  console.log('\n✓ All channel tests passed');
}

main().catch(console.error);
