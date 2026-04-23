import { describe, it, expect } from 'vitest';

// ── Helpers mirroring AUNChannel's internal logic ────────────────────────────
// We test the logic in isolation without instantiating AUNChannel (which
// requires network access). Extract pure functions to test them directly.

function buildContent(text: string, fileParts: string[]): string {
  if (fileParts.length === 0) return text;
  const parts: string[] = [];
  if (text) parts.push(text);
  parts.push(...fileParts);
  parts.push('请使用 Read 工具读取文件内容。');
  return parts.join('\n\n');
}

function extractAttachments(payload: unknown): any[] {
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray((payload as any).attachments)
    ? (payload as any).attachments
    : [];
}

// ── Content composition tests ─────────────────────────────────────────────────
describe('AUN file reception: content composition', () => {
  it('纯文本消息不变', () => {
    const result = buildContent('hello', []);
    expect(result).toBe('hello');
  });

  it('纯附件（无 text）组合', () => {
    const result = buildContent('', ['[文件: a.py → /proj/.evolclaw/uploads/a.py]']);
    expect(result).toBe('[文件: a.py → /proj/.evolclaw/uploads/a.py]\n\n请使用 Read 工具读取文件内容。');
  });

  it('text + 单附件组合', () => {
    const result = buildContent('请看这个', ['[文件: a.py → /proj/.evolclaw/uploads/a.py]']);
    expect(result).toBe('请看这个\n\n[文件: a.py → /proj/.evolclaw/uploads/a.py]\n\n请使用 Read 工具读取文件内容。');
  });

  it('多附件均出现在提示中', () => {
    const result = buildContent('', [
      '[文件: a.py → /proj/.evolclaw/uploads/a.py]',
      '[文件: b.md → /proj/.evolclaw/uploads/b.md]',
    ]);
    expect(result).toContain('[文件: a.py');
    expect(result).toContain('[文件: b.md');
    expect(result).toContain('请使用 Read 工具读取文件内容。');
  });

  it('所有附件下载失败时回退到原始 text', () => {
    const result = buildContent('原始文本', []);
    expect(result).toBe('原始文本');
  });
});

// ── Attachment extraction tests ───────────────────────────────────────────────
describe('AUN file reception: attachment extraction', () => {
  it('有效 payload 提取附件列表', () => {
    const payload = {
      text: '📎 file.py',
      attachments: [
        { owner_aid: 'alice.agentid.pub', object_key: 'shared/uuid/file.py', filename: 'file.py', sha256: 'abc' },
      ],
    };
    expect(extractAttachments(payload)).toHaveLength(1);
    expect(extractAttachments(payload)[0].filename).toBe('file.py');
  });

  it('无附件字段返回空数组', () => {
    expect(extractAttachments({ text: 'hello' })).toHaveLength(0);
  });

  it('attachments 不是数组时返回空数组', () => {
    expect(extractAttachments({ text: 'hello', attachments: 'wrong' })).toHaveLength(0);
  });

  it('字符串 payload 返回空数组', () => {
    expect(extractAttachments('plain text')).toHaveLength(0);
  });

  it('null payload 返回空数组', () => {
    expect(extractAttachments(null)).toHaveLength(0);
  });
});

// ── Group message empty-text guard ────────────────────────────────────────────
describe('AUN file reception: group message guard', () => {
  function shouldDispatch(strippedText: string, hasAttachments: boolean): boolean {
    return !(!strippedText && !hasAttachments);
  }

  it('有文本 → dispatch', () => {
    expect(shouldDispatch('hello', false)).toBe(true);
  });

  it('有附件无文本 → dispatch', () => {
    expect(shouldDispatch('', true)).toBe(true);
  });

  it('有文本有附件 → dispatch', () => {
    expect(shouldDispatch('hello', true)).toBe(true);
  });

  it('无文本无附件 → 不 dispatch', () => {
    expect(shouldDispatch('', false)).toBe(false);
  });
});
