import { FeishuChannel, AUNChannel } from '../src/channels/index.js';

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

async function testAUN() {
  console.log('Testing AUNChannel...');
  const channel = new AUNChannel({
    domain: 'test.aun',
    agentName: 'test-agent'
  });

  await channel.connect();
  channel.onMessage(async (sessionId, content) => {
    console.log(`Received: ${sessionId} -> ${content}`);
  });
  await channel.disconnect();

  console.log('✓ AUNChannel interface OK');
}

async function main() {
  await testFeishu();
  await testAUN();
  console.log('\n✓ All channel tests passed');
}

main().catch(console.error);
