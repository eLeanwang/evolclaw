import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './src/config.js';

async function testMention() {
  const config = loadConfig();

  if (!config.channels?.feishu?.appId || !config.channels?.feishu?.appSecret) {
    console.error('Feishu credentials not configured');
    return;
  }

  const client = new lark.Client({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
  });

  console.log('Listening for messages... Send a message in the group to test @mention');

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const msg = data.message;
      const chatId = msg.chat_id;
      const userId = data.sender?.sender_id?.open_id;

      console.log(`\nReceived message from user: ${userId}`);
      console.log(`Chat ID: ${chatId}`);

      if (!userId) {
        console.log('No user ID found, skipping');
        return;
      }

      // 构造带 @ 的富文本消息
      const postContent = {
        zh_cn: {
          title: '',
          content: [
            [
              { tag: 'at', user_id: userId },
              { tag: 'text', text: ' 收到你的消息了！这是一条测试 @ 功能的回复' }
            ]
          ]
        }
      };

      try {
        const res = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'post',
            content: JSON.stringify(postContent)
          }
        });

        console.log('✓ Message with @mention sent successfully');
        console.log('Response:', JSON.stringify(res.data, null, 2));
        process.exit(0);
      } catch (error) {
        console.error('✗ Failed to send message:', error);
        process.exit(1);
      }
    }
  });

  const wsClient = new lark.WSClient({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
  });

  await wsClient.start({ eventDispatcher });
}

testMention().catch(console.error);
