// 直接测试飞书 md tag 对 markdown 表格的渲染
import lark from '@larksuiteoapi/node-sdk';

const client = new lark.Client({
  appId: 'cli_a927d1717e78dcce',
  appSecret: 'aUxpkNyIG0pBd3oBasCqybLW85bdWepQ',
});

const chatId = 'oc_8b0b9a38aab019168cf1a9b99827a5bc';

const mdContent = `## 测试：md tag 表格渲染

### 标准 Markdown 表格

| 决策 | 方案 | 理由 |
| --- | --- | --- |
| 图片传给 Agent | base64 via images | SDK 原生支持 |
| 文件传给 Agent | uploads + prompt | 文件可能很大 |

### 表格后的内容

这行文字应该正常显示。

- 列表项1
- 列表项2`;

const content = JSON.stringify({
  zh_cn: {
    title: 'md tag 表格渲染测试',
    content: [[{ tag: 'md', text: mdContent }]]
  }
});

console.log('Sending post message with md tag containing table...');
console.log('Content:', content);

const res = await client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: { receive_id: chatId, msg_type: 'post', content }
});

console.log('Response:', JSON.stringify(res, null, 2));
