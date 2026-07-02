import { describe, it, expect } from 'vitest';
import path from 'path';
import { renderMessageBody } from '../../src/eck/message-renderer.js';
import { getPackageRoot } from '../../src/paths.js';
import type { SubMessage } from '../../src/types.js';

// 加密态跟随：入站每条消息的 encrypted 经 message-renderer 在信封头标注，
// 模型据此对 msg send / group send 显式带 --encrypt / --no-encrypt。
// 三态：true=🔒密文 / false=✉️明文 / undefined(非 aun)=不标注。

const sessionVars = {
  selfAid: 'agent.aid.pub',
  timezone: 'UTC',
  KITS_MESSAGE_FRAGMENTS: path.join(getPackageRoot(), 'kits', 'templates', 'message-fragments'),
};

function render(over: Partial<SubMessage>, vars: Record<string, unknown> = {}): string {
  const item: SubMessage = {
    peerId: 'alice.aid.pub', content: 'hi', timestamp: 1700000000000, ...over,
  };
  return renderMessageBody([item], { ...sessionVars, ...vars }, 'sess').body;
}

describe('renderMessageBody: 入站加密态标注（三态）', () => {
  it('encrypted=true → 🔒密文', () => {
    const body = render({ encrypted: true }, { chatType: 'private' });
    expect(body).toContain('🔒密文');
    expect(body).not.toContain('明文');
  });

  it('encrypted=false → ✉️明文', () => {
    const body = render({ encrypted: false }, { chatType: 'private' });
    expect(body).toContain('✉️明文');
    expect(body).not.toContain('密文');
  });

  it('encrypted=undefined（非 aun 渠道）→ 不标注任何加密态', () => {
    const body = render({ encrypted: undefined }, { chatType: 'private' });
    expect(body).not.toContain('密文');
    expect(body).not.toContain('明文');
  });

  it('群聊路径同样标注', () => {
    const body = render(
      { encrypted: true },
      { chatType: 'group', groupId: 'g.aid.pub/1', groupLabel: 'g.aid.pub/1' },
    );
    expect(body).toContain('🔒密文');
  });

  it('合并批次逐条独立标注（密文条与明文条各自显示）', () => {
    const items: SubMessage[] = [
      { peerId: 'a.aid.pub', content: '密文消息', timestamp: 1700000000000, encrypted: true },
      { peerId: 'b.aid.pub', content: '明文消息', timestamp: 1700000000001, encrypted: false },
    ];
    const { body } = renderMessageBody(items, { ...sessionVars, chatType: 'private' }, 'sess-merge');
    expect(body).toContain('🔒密文');
    expect(body).toContain('✉️明文');
    // 正文都在
    expect(body).toContain('密文消息');
    expect(body).toContain('明文消息');
  });
});
