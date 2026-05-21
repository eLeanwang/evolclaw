import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUNChannel } from '../../src/channels/aun.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChannel(aid = 'bot.agentid.pub') {
  const ch = new AUNChannel({ aid }) as any;
  ch._aid = aid;
  ch.connected = true;
  ch.acknowledgeImmediately = vi.fn();
  ch.fetchPeerInfo = vi.fn().mockResolvedValue({ type: 'human', name: 'Tester' });
  ch.downloadAttachment = vi.fn().mockResolvedValue('/uploads/file.pdf');
  return ch;
}

// ── extractTextPayload tests ─────────────────────────────────────────────────

describe('AUNChannel extractTextPayload - merge type', () => {
  let ch: any;

  beforeEach(() => {
    ch = makeChannel();
  });

  it('formats merge with title and items', () => {
    const payload = {
      type: 'merge',
      title: '项目讨论',
      items: [
        { sender_display: 'Alice', type: 'text', text: '先确认接口' },
        { sender_display: 'Bob', type: 'text', text: '我来补测试' },
      ],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('项目讨论');
    expect(result).toContain('Alice: 先确认接口');
    expect(result).toContain('Bob: 我来补测试');
    expect(result).toContain('---');
  });

  it('formats merge items with image attachments', () => {
    const payload = {
      type: 'merge',
      title: '截图分享',
      items: [
        { sender_display: 'Carol', type: 'image', text: '流程图', attachments: [{ filename: 'flow.png', content_type: 'image/png' }] },
      ],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('Carol: 流程图 [图片: flow.png]');
  });

  it('formats merge items with file attachments', () => {
    const payload = {
      type: 'merge',
      title: '文档',
      items: [
        { sender_display: 'Dave', type: 'file', attachments: [{ filename: 'report.pdf', content_type: 'application/pdf' }] },
      ],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('Dave: [文件: report.pdf]');
  });

  it('formats merge items with video attachments', () => {
    const payload = {
      type: 'merge',
      title: '视频',
      items: [
        { sender_display: 'Eve', type: 'video', attachments: [{ filename: 'demo.mp4', content_type: 'video/mp4' }] },
      ],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('Eve: [视频: demo.mp4]');
  });

  it('handles empty items gracefully', () => {
    const payload = { type: 'merge', title: '空消息' };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('空消息');
    expect(result).toContain('---');
  });

  it('includes summary when present', () => {
    const payload = {
      type: 'merge',
      title: '讨论',
      summary: '包含 3 条消息',
      items: [{ sender_display: 'A', text: 'hi' }],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('[摘要] 包含 3 条消息');
  });

  it('handles items without sender_display', () => {
    const payload = {
      type: 'merge',
      title: '匿名',
      items: [{ type: 'text', text: '匿名消息' }],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('匿名消息');
    expect(result).not.toContain(': 匿名消息');
  });

  it('handles items with unknown type and no text/attachments', () => {
    const payload = {
      type: 'merge',
      title: '混合',
      items: [{ sender_display: 'X', type: 'location' }],
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('X: [location]');
  });
});

describe('AUNChannel extractTextPayload - quote type', () => {
  let ch: any;

  beforeEach(() => {
    ch = makeChannel();
  });

  it('formats quote with text only', () => {
    const payload = {
      type: 'quote',
      text: '我同意',
      quote: { text: '方案 A 如何？', sender_display: 'Bob' },
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('> Bob: 方案 A 如何？');
    expect(result).toContain('我同意');
  });

  it('formats quote with image attachment', () => {
    const payload = {
      type: 'quote',
      text: '这张图不对',
      quote: {
        text: '流程图',
        sender_display: 'Carol',
        attachments: [{ filename: 'flow.png', content_type: 'image/png' }],
      },
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('> Carol: 流程图');
    expect(result).toContain('[图片: flow.png]');
    expect(result).toContain('这张图不对');
  });

  it('formats quote with file attachment and no text', () => {
    const payload = {
      type: 'quote',
      text: '看看这个文件',
      quote: {
        sender_display: 'Dave',
        attachments: [{ filename: 'spec.pdf', content_type: 'application/pdf' }],
      },
    };
    const result = ch.extractTextPayload(payload);
    expect(result).toContain('[文件: spec.pdf]');
    expect(result).toContain('看看这个文件');
  });

  it('sender prefix only on first line of multi-line quote', () => {
    const payload = {
      type: 'quote',
      text: '回复',
      quote: { text: '第一行\n第二行', sender_display: 'Eve' },
    };
    const result = ch.extractTextPayload(payload);
    const lines = result.split('\n');
    const quotedLines = lines.filter((l: string) => l.startsWith('>'));
    expect(quotedLines[0]).toContain('Eve: ');
    // Second line should NOT have the sender prefix
    expect(quotedLines[1]).not.toContain('Eve: ');
  });

  it('handles quote with empty quote object', () => {
    const payload = {
      type: 'quote',
      text: '回复内容',
      quote: {},
    };
    const result = ch.extractTextPayload(payload);
    // Falls through to text return since quoteParts is empty
    expect(result).toBe('回复内容');
  });
});

describe('AUNChannel collectAllAttachments', () => {
  let ch: any;

  beforeEach(() => {
    ch = makeChannel();
  });

  it('collects top-level attachments', () => {
    const payload = {
      type: 'file',
      attachments: [{ url: 'aun://a', object_key: 'a.pdf' }],
    };
    const result = ch.collectAllAttachments(payload);
    expect(result).toHaveLength(1);
    expect(result[0].object_key).toBe('a.pdf');
  });

  it('collects merge items attachments', () => {
    const payload = {
      type: 'merge',
      title: 'test',
      items: [
        { type: 'image', attachments: [{ url: 'aun://img1', filename: 'a.png' }] },
        { type: 'file', attachments: [{ url: 'aun://file1', filename: 'b.pdf' }] },
      ],
    };
    const result = ch.collectAllAttachments(payload);
    expect(result).toHaveLength(2);
  });

  it('collects quote.quote attachments', () => {
    const payload = {
      type: 'quote',
      text: 'reply',
      quote: {
        text: 'original',
        attachments: [{ url: 'aun://quoted', filename: 'q.png' }],
      },
    };
    const result = ch.collectAllAttachments(payload);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('q.png');
  });

  it('deduplicates by url', () => {
    const payload = {
      type: 'merge',
      title: 'test',
      attachments: [{ url: 'aun://same', filename: 'top.pdf' }],
      items: [
        { type: 'file', attachments: [{ url: 'aun://same', filename: 'nested.pdf' }] },
      ],
    };
    const result = ch.collectAllAttachments(payload);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('top.pdf'); // top-level wins
  });

  it('deduplicates by object_key when url is absent', () => {
    const payload = {
      type: 'merge',
      title: 'test',
      attachments: [{ object_key: 'docs/a.pdf' }],
      items: [
        { type: 'file', attachments: [{ object_key: 'docs/a.pdf' }] },
      ],
    };
    const result = ch.collectAllAttachments(payload);
    expect(result).toHaveLength(1);
  });

  it('does not deduplicate when both url and object_key are missing', () => {
    const payload = {
      type: 'merge',
      title: 'test',
      items: [
        { type: 'file', attachments: [{ filename: 'a.pdf' }, { filename: 'b.pdf' }] },
      ],
    };
    const result = ch.collectAllAttachments(payload);
    expect(result).toHaveLength(2);
  });

  it('returns empty for non-object payload', () => {
    expect(ch.collectAllAttachments('')).toEqual([]);
    expect(ch.collectAllAttachments(null)).toEqual([]);
    expect(ch.collectAllAttachments(undefined)).toEqual([]);
  });
});
