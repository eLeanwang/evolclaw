// 测试表格转换后的飞书渲染效果
import lark from '@larksuiteoapi/node-sdk';
import { markdownToFeishuPost } from '../dist/utils/markdown-to-feishu.js';

const client = new lark.Client({
  appId: 'cli_a927d1717e78dcce',
  appSecret: 'aUxpkNyIG0pBd3oBasCqybLW85bdWepQ',
});

const chatId = 'oc_8b0b9a38aab019168cf1a9b99827a5bc';

const markdown = `## 三、关键设计决策

| 决策 | 方案 | 理由 |
| --- | --- | --- |
| 图片传给 Agent 的方式 | base64 via Message.images | 与飞书一致，SDK 原生支持多模态 |
| 文件传给 Agent 的方式 | 保存到 uploads + prompt 提示 | 与飞书一致，文件可能很大 |
| CDN 地址 | novac2c.cdn.weixin.qq.com/c2c | SDK v2.0.1 源码确认 |

## 四、依赖

- 零外部依赖：只用 node:crypto（已有）+ fetch()（全局可用）
- 文件大小限制：100MB（与 SDK 一致）

## 五、改动文件清单

| 文件 | 改动 |
| --- | --- |
| src/channels/wechat.ts | 扩展类型、CDN 下载/上传、sendFile、改造 handleInboundMessage |
| src/index.ts | wechatAdapter 加 sendFile、wechatOptions 加 marker、onMessage 传 images |
| src/types.ts | 无需改动（Message.images 已存在） |`;

const post = markdownToFeishuPost(markdown, '表格转换测试');
console.log('Converted content:', JSON.stringify(post, null, 2));

const res = await client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: { receive_id: chatId, msg_type: 'post', content: JSON.stringify(post) }
});

console.log('Response code:', res.code, res.msg);
