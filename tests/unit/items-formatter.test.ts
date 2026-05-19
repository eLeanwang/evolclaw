import { describe, it, expect } from 'vitest';
import { formatItemsAsText } from '../../src/core/message/items-formatter.js';
import type { ThoughtItem } from '../../src/types.js';

describe('formatItemsAsText', () => {
  it('空 items 返回空字符串', () => {
    expect(formatItemsAsText([])).toBe('');
  });

  it('thinking item 返回纯文本', () => {
    expect(formatItemsAsText([{ kind: 'thinking', text: 'hello' }])).toBe('hello');
  });

  it('reasoning item 加 💭 前缀', () => {
    expect(formatItemsAsText([{ kind: 'reasoning', text: 'pondering' }])).toBe('💭 pondering');
  });

  it('tool_call 带描述', () => {
    const items: ThoughtItem[] = [
      { kind: 'tool_call', call_id: 'c1', name: 'Read', text: 'Read: ./README.md' },
    ];
    expect(formatItemsAsText(items)).toBe('🔧 Read: Read: ./README.md');
  });

  it('tool_call 无描述时仅显示工具名', () => {
    expect(formatItemsAsText([{ kind: 'tool_call', call_id: 'c1', name: 'Bash' }])).toBe('🔧 Bash');
  });

  it('tool_call 从 arguments 推断描述', () => {
    const items: ThoughtItem[] = [
      { kind: 'tool_call', call_id: 'c1', name: 'Read', arguments: { file_path: '/tmp/x.md' } },
    ];
    expect(formatItemsAsText(items)).toBe('🔧 Read: /tmp/x.md');
  });

  it('tool_result(ok) 显示 ✅', () => {
    expect(formatItemsAsText([{ kind: 'tool_result', call_id: 'c1', name: 'Read', ok: true }])).toBe('✅ Read');
  });

  it('tool_result(error) 显示 ⚠️ + error', () => {
    expect(formatItemsAsText([
      { kind: 'tool_result', call_id: 'c1', name: 'Read', ok: false, error: '权限被拒' },
    ])).toBe('⚠️ Read: 权限被拒');
  });

  it('progress 显示 ⏳', () => {
    expect(formatItemsAsText([{ kind: 'progress', text: '处理中' }])).toBe('⏳ 处理中');
  });

  it('notice severity=warn 显示 ⚠️', () => {
    expect(formatItemsAsText([{ kind: 'notice', text: 'boom', severity: 'warn' }])).toBe('⚠️ boom');
  });

  it('notice severity=info 不加前缀', () => {
    expect(formatItemsAsText([{ kind: 'notice', text: 'compacted', severity: 'info' }])).toBe('compacted');
  });

  it('summary 默认无前缀', () => {
    expect(formatItemsAsText([{ kind: 'summary', text: 'final' }])).toBe('final');
  });

  it('summary is_error=true 显示 ❌', () => {
    expect(formatItemsAsText([{ kind: 'summary', text: 'failed', is_error: true }])).toBe('❌ failed');
  });

  it('多 item 用换行连接', () => {
    const items: ThoughtItem[] = [
      { kind: 'tool_call', call_id: 'c1', name: 'Read', text: 'Read a' },
      { kind: 'tool_result', call_id: 'c1', name: 'Read', ok: true },
      { kind: 'thinking', text: '继续...' },
    ];
    expect(formatItemsAsText(items)).toBe('🔧 Read: Read a\n✅ Read\n继续...');
  });
});
