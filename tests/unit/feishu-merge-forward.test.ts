import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from '../../src/channels/feishu.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChannel() {
  const ch = new FeishuChannel({} as any) as any;
  ch.client = {
    im: {
      message: {
        get: vi.fn(),
      },
      messageResource: {
        get: vi.fn(),
      },
    },
  };
  ch.projectPathProvider = vi.fn().mockResolvedValue('/tmp/test-project');
  // Mock downloadAndSaveImage to return base64 data
  ch.downloadAndSaveImage = vi.fn().mockResolvedValue({
    data: 'base64data',
    mimeType: 'image/png',
  });
  return ch;
}

// ── extractMergeForwardContent tests ─────────────────────────────────────────

describe('FeishuChannel extractMergeForwardContent', () => {
  let ch: any;

  beforeEach(() => {
    ch = makeChannel();
  });

  it('extracts text sub-messages', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'text', message_id: 'msg-1', body: { content: JSON.stringify({ text: '你好' }) } },
          { msg_type: 'text', message_id: 'msg-2', body: { content: JSON.stringify({ text: '世界' }) } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_1', 'chat_1');
    expect(result.text).toContain('你好');
    expect(result.text).toContain('世界');
    expect(result.text).toContain('以下是用户转发的合并消息');
    expect(result.text).toContain('---');
    expect(result.images).toHaveLength(0);
  });

  it('extracts image sub-messages', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'image', message_id: 'msg-img', body: { content: JSON.stringify({ image_key: 'img_key_1' }) } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_2', 'chat_1');
    expect(result.text).toContain('[图片]');
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe('base64data');
    expect(ch.downloadAndSaveImage).toHaveBeenCalledWith('img_key_1', 'chat_1', 'msg-img', '/tmp/test-project');
  });

  it('skips image when image_key is missing', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'image', message_id: 'msg-img', body: { content: JSON.stringify({}) } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_3', 'chat_1');
    expect(result.images).toHaveLength(0);
    expect(ch.downloadAndSaveImage).not.toHaveBeenCalled();
  });

  it('extracts post sub-messages with inline images', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          {
            msg_type: 'post',
            message_id: 'msg-post',
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: '公告',
                  content: [
                    [
                      { text: '请看图：' },
                      { tag: 'img', image_key: 'img_post_1' },
                    ],
                  ],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_4', 'chat_1');
    expect(result.text).toContain('公告');
    expect(result.text).toContain('请看图：');
    expect(result.images).toHaveLength(1);
    expect(ch.downloadAndSaveImage).toHaveBeenCalledWith('img_post_1', 'chat_1', 'msg-post', '/tmp/test-project');
  });

  it('extracts file sub-messages as text labels', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'file', message_id: 'msg-file', body: { content: JSON.stringify({ file_key: 'fk_1', file_name: 'report.pdf' }) } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_5', 'chat_1');
    expect(result.text).toContain('[文件: report.pdf]');
    expect(result.images).toHaveLength(0);
  });

  it('handles unknown message types gracefully', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'sticker', message_id: 'msg-stk', body: { content: '{}' } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_6', 'chat_1');
    expect(result.text).toContain('[sticker]');
  });

  it('returns empty when no sub-messages', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: { items: [] },
    });

    const result = await ch.extractMergeForwardContent('om_merge_7', 'chat_1');
    expect(result.text).toBe('');
    expect(result.images).toHaveLength(0);
  });

  it('returns empty when API returns no data', async () => {
    ch.client.im.message.get.mockResolvedValue({ data: null });

    const result = await ch.extractMergeForwardContent('om_merge_8', 'chat_1');
    expect(result.text).toBe('');
  });

  it('returns empty when API throws', async () => {
    ch.client.im.message.get.mockRejectedValue(new Error('API error'));

    const result = await ch.extractMergeForwardContent('om_merge_9', 'chat_1');
    expect(result.text).toBe('');
    expect(result.images).toHaveLength(0);
  });

  it('skips items with missing body.content', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'text', message_id: 'msg-1', body: { content: JSON.stringify({ text: '有内容' }) } },
          { msg_type: 'text', message_id: 'msg-2', body: null },
          { msg_type: 'text', message_id: 'msg-3' },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_10', 'chat_1');
    expect(result.text).toContain('有内容');
    // Should not crash, just skip the bad items
  });

  it('handles malformed JSON in sub-message content', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'text', message_id: 'msg-1', body: { content: 'not-json' } },
          { msg_type: 'text', message_id: 'msg-2', body: { content: JSON.stringify({ text: '正常' }) } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_11', 'chat_1');
    expect(result.text).toContain('[text: 解析失败]');
    expect(result.text).toContain('正常');
  });

  it('respects MAX_IMAGES limit', async () => {
    // Create 12 image items
    const items = Array.from({ length: 12 }, (_, i) => ({
      msg_type: 'image',
      message_id: `msg-img-${i}`,
      body: { content: JSON.stringify({ image_key: `key_${i}` }) },
    }));

    ch.client.im.message.get.mockResolvedValue({ data: { items } });

    const result = await ch.extractMergeForwardContent('om_merge_12', 'chat_1');
    expect(result.images).toHaveLength(10); // MAX_IMAGES = 10
    expect(ch.downloadAndSaveImage).toHaveBeenCalledTimes(10);
  });

  it('mixed content: text + images + files', async () => {
    ch.client.im.message.get.mockResolvedValue({
      data: {
        items: [
          { msg_type: 'text', message_id: 'msg-1', body: { content: JSON.stringify({ text: '开始讨论' }) } },
          { msg_type: 'image', message_id: 'msg-2', body: { content: JSON.stringify({ image_key: 'k1' }) } },
          { msg_type: 'file', message_id: 'msg-3', body: { content: JSON.stringify({ file_key: 'fk', file_name: 'doc.pdf' }) } },
          { msg_type: 'text', message_id: 'msg-4', body: { content: JSON.stringify({ text: '结束' }) } },
        ],
      },
    });

    const result = await ch.extractMergeForwardContent('om_merge_13', 'chat_1');
    expect(result.text).toContain('开始讨论');
    expect(result.text).toContain('[图片]');
    expect(result.text).toContain('[文件: doc.pdf]');
    expect(result.text).toContain('结束');
    expect(result.images).toHaveLength(1);
  });
});
