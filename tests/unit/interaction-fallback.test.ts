import { describe, it, expect } from 'vitest';
import { renderCommandCardAsText, renderActionAsText } from '../../src/core/interaction-fallback.js';
import type { CommandCard, InteractionRequest } from '../../src/types.js';

describe('renderCommandCardAsText', () => {
  it('renders title and buttons with commands', () => {
    const card: CommandCard = {
      kind: 'command-card',
      title: '📂 项目列表',
      buttons: [
        { label: '✓ myproject', command: '/project myproject', style: 'primary', disabled: true },
        { label: 'other', command: '/project other', style: 'default' },
      ],
    };

    const result = renderCommandCardAsText(card);
    expect(result).toContain('📂 项目列表');
    expect(result).toContain('✓ /project myproject');
    expect(result).toContain('  /project other');
    expect(result).toContain('← ✓ myproject');
    expect(result).toContain('← other');
  });

  it('includes body when present', () => {
    const card: CommandCard = {
      kind: 'command-card',
      title: 'Title',
      body: 'Some description',
      buttons: [{ label: 'btn', command: '/cmd' }],
    };

    const result = renderCommandCardAsText(card);
    expect(result).toContain('Some description');
  });

  it('handles empty body', () => {
    const card: CommandCard = {
      kind: 'command-card',
      title: 'Title',
      buttons: [{ label: 'btn', command: '/cmd' }],
    };

    const result = renderCommandCardAsText(card);
    expect(result).toContain('Title');
    expect(result).toContain('/cmd');
  });
});

describe('renderActionAsText', () => {
  it('renders with fallback command and buttons', () => {
    const req: InteractionRequest = {
      type: 'interaction',
      id: 'test-1',
      channelId: 'ch-1',
      sessionId: 'sess-1',
      kind: {
        kind: 'action',
        title: '🔐 权限请求',
        body: '工具：Read\n操作：src/index.ts',
        buttons: [
          { key: 'allow', label: '✅ 允许', style: 'primary' },
          { key: 'deny', label: '❌ 拒绝', style: 'danger' },
        ],
      },
      fallback: { command: 'perm' },
    };

    const result = renderActionAsText(req);
    expect(result).toContain('🔐 权限请求');
    expect(result).toContain('工具：Read');
    expect(result).toContain('/perm allow');
    expect(result).toContain('/perm deny');
    expect(result).toContain('← ✅ 允许');
    expect(result).toContain('← ❌ 拒绝');
  });

  it('uses buttonArgMap when provided', () => {
    const req: InteractionRequest = {
      type: 'interaction',
      id: 'test-2',
      channelId: 'ch-1',
      sessionId: 'sess-1',
      kind: {
        kind: 'action',
        title: '📋 计划审批',
        buttons: [
          { key: 'approve', label: '✅ 批准执行' },
          { key: 'reject', label: '❌ 拒绝' },
        ],
      },
      fallback: {
        command: 'ask',
        buttonArgMap: { approve: '1', reject: '2' },
      },
    };

    const result = renderActionAsText(req);
    expect(result).toContain('/ask 1');
    expect(result).toContain('/ask 2');
    expect(result).toContain('← ✅ 批准执行');
  });

  it('includes freeTextHint when acceptFreeText is true', () => {
    const req: InteractionRequest = {
      type: 'interaction',
      id: 'test-3',
      channelId: 'ch-1',
      sessionId: 'sess-1',
      kind: {
        kind: 'action',
        title: '💬 问题',
        buttons: [{ key: 'opt-0', label: '选项A' }],
      },
      fallback: {
        command: 'ask',
        buttonArgMap: { 'opt-0': '1' },
        acceptFreeText: true,
        freeTextHint: '或回复 /ask <自定义内容>',
      },
    };

    const result = renderActionAsText(req);
    expect(result).toContain('或回复 /ask <自定义内容>');
  });

  it('renders only title and body when no fallback', () => {
    const req: InteractionRequest = {
      type: 'interaction',
      id: 'test-4',
      channelId: 'ch-1',
      sessionId: 'sess-1',
      kind: {
        kind: 'action',
        title: '信息展示',
        body: '这是一条通知',
        buttons: [{ key: 'ok', label: '确认' }],
      },
    };

    const result = renderActionAsText(req);
    expect(result).toContain('信息展示');
    expect(result).toContain('这是一条通知');
    expect(result).not.toContain('/');
    expect(result).not.toContain('回复');
  });

  it('throws when passed a CommandCard', () => {
    const req: InteractionRequest = {
      type: 'interaction',
      id: 'test-5',
      channelId: 'ch-1',
      sessionId: 'sess-1',
      kind: {
        kind: 'command-card',
        title: 'Test',
        buttons: [{ label: 'btn', command: '/cmd' }],
      },
    };

    expect(() => renderActionAsText(req)).toThrow('expected ActionInteraction');
  });
});
