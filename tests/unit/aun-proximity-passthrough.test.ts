import { describe, it, expect } from 'vitest';
import { aunOptsToInbound, type AUNDispatchOptions } from '../../src/channels/aun.js';

// 回归测试：registerBridge 适配层曾手抄字段漏掉 proximity（sameDevice/sameNetwork/
// sameEgressIp），导致 eck-debug 永远 false。aunOptsToInbound 抽成纯函数后在此锁字段。

function baseOpts(over: Partial<AUNDispatchOptions> = {}): AUNDispatchOptions {
  return {
    channelId: 'peer.agentid.pub',
    content: 'hi',
    chatType: 'private',
    peerId: 'peer.agentid.pub',
    ...over,
  };
}

describe('aunOptsToInbound — proximity passthrough', () => {
  it('forwards all three proximity flags (the regressed bug)', () => {
    const out = aunOptsToInbound(
      baseOpts({ sameDevice: true, sameNetwork: true, sameEgressIp: true }),
      'aun_main',
      'aun',
    );
    expect(out.sameDevice).toBe(true);
    expect(out.sameNetwork).toBe(true);
    expect(out.sameEgressIp).toBe(true);
  });

  it('preserves false vs undefined distinctly (no coercion)', () => {
    const out = aunOptsToInbound(
      baseOpts({ sameDevice: false, sameNetwork: undefined, sameEgressIp: true }),
      'aun_main',
      'aun',
    );
    expect(out.sameDevice).toBe(false);
    expect(out.sameNetwork).toBeUndefined();
    expect(out.sameEgressIp).toBe(true);
  });

  it('leaves proximity undefined when opts omit them', () => {
    const out = aunOptsToInbound(baseOpts(), 'aun_main', 'aun');
    expect(out.sameDevice).toBeUndefined();
    expect(out.sameNetwork).toBeUndefined();
    expect(out.sameEgressIp).toBeUndefined();
  });

  it('carries proximity on the group path too', () => {
    const out = aunOptsToInbound(
      baseOpts({
        chatType: 'group',
        groupId: 'group.agentid.pub/11117',
        sameDevice: true,
        sameNetwork: true,
        sameEgressIp: true,
      }),
      'aun_main',
      'aun',
    );
    expect(out.chatType).toBe('group');
    expect(out.groupId).toBe('group.agentid.pub/11117');
    expect(out.sameDevice).toBe(true);
    expect(out.sameNetwork).toBe(true);
    expect(out.sameEgressIp).toBe(true);
  });

  it('forwards inbound encryption state (true/false/undefined distinctly)', () => {
    const enc = aunOptsToInbound(baseOpts({ encrypted: true }), 'aun_main', 'aun');
    expect(enc.encrypted).toBe(true);

    const plain = aunOptsToInbound(baseOpts({ encrypted: false }), 'aun_main', 'aun');
    expect(plain.encrypted).toBe(false);

    // 非 aun / 未提供加密态：保持 undefined（不强转 false），渲染层据此不显示标注
    const none = aunOptsToInbound(baseOpts(), 'aun_main', 'aun');
    expect(none.encrypted).toBeUndefined();
  });

  it('carries encryption state on the group path too', () => {
    const out = aunOptsToInbound(
      baseOpts({ chatType: 'group', groupId: 'group.agentid.pub/11117', encrypted: true }),
      'aun_main',
      'aun',
    );
    expect(out.chatType).toBe('group');
    expect(out.encrypted).toBe(true);
  });

  it('maps channel/channelType and core envelope fields', () => {
    const out = aunOptsToInbound(
      baseOpts({
        selfAID: 'self.agentid.pub',
        peerName: '墨渊',
        peerType: 'ai',
        messageId: 'm-1',
        threadId: 't-1',
        mentionAids: ['self.agentid.pub'],
        sameNetwork: true,
      }),
      'aun_main',
      'aun',
    );
    expect(out.channel).toBe('aun_main');
    expect(out.channelType).toBe('aun');
    expect(out.channelId).toBe('peer.agentid.pub');
    expect(out.selfAID).toBe('self.agentid.pub');
    expect(out.peerId).toBe('peer.agentid.pub');
    expect(out.peerName).toBe('墨渊');
    expect(out.peerType).toBe('ai');
    expect(out.messageId).toBe('m-1');
    expect(out.threadId).toBe('t-1');
    expect(out.mentionAids).toEqual(['self.agentid.pub']);
  });

  it('defaults chatType to private and peerId to empty string', () => {
    const out = aunOptsToInbound(
      { channelId: 'c', content: 'x', chatType: undefined as any, peerId: undefined as any },
      'aun_main',
      'aun',
    );
    expect(out.chatType).toBe('private');
    expect(out.peerId).toBe('');
  });
});
