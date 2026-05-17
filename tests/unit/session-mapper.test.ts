import { describe, it, expect } from 'vitest';
import { sessionToFile, fileToSession } from '../../src/core/session/session-mapper.js';
import type { Session } from '../../src/types.js';

describe('session-mapper', () => {
  it('maps Session → SessionFile', () => {
    const session: Session = {
      id: 'meta_20240521_1715740800000',
      channel: 'aun_main',
      channelId: 'alice.agentid.pub',
      agentId: 'claude',
      threadId: '',
      chatType: 'private',
      sessionMode: 'interactive',
      projectPath: '/proj',
      agentSessionId: 'uuid-1',
      name: 'test',
      processingState: '12345:taskId-1',
      metadata: {
        peerId: 'alice.agentid.pub',
        peerName: 'Alice',
        permissionMode: 'auto',
        replyContext: { replyToMessageId: 'm1', replyInThread: false } as any,
        isActive: true,
        channelName: 'aun_main',
      },
      createdAt: 1715740800000,
      updatedAt: 1715783280000,
    };

    const file = sessionToFile(session);
    expect(file.id).toBe(session.id);
    expect(file.agentType).toBe('claude');
    expect(file.chatMode).toBe('interactive');
    expect(file.activeTask).toBe('12345:taskId-1');
    expect(file.permissionMode).toBe('auto');
    expect(file.metadata.peerId).toBe('alice.agentid.pub');
    expect(file.metadata.peerName).toBe('Alice');
    expect(file.metadata.replyContext).toEqual({ replyToMessageId: 'm1', replyInThread: false });

    expect(file.metadata.permissionMode).toBeUndefined();
    expect(file.metadata.isActive).toBeUndefined();
    expect(file.metadata.channelName).toBeUndefined();

    expect(file.createdAtStr).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(file.updatedAtStr).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('maps SessionFile → Session (round-trip preserves core fields)', () => {
    const session: Session = {
      id: 'meta_20240521_1715740800000',
      channel: 'feishu_main',
      channelId: 'oc_xxx',
      agentId: 'codex',
      threadId: 'om_thread_1',
      chatType: 'group',
      sessionMode: 'proactive',
      projectPath: '/proj',
      agentSessionId: 'cdx-uuid',
      name: 'group-session',
      processingState: undefined,
      metadata: {
        peerId: 'ou_aaa',
        peerName: 'Bob',
        permissionMode: 'bypass',
      },
      createdAt: 1715740800000,
      updatedAt: 1715783280000,
    };

    const file = sessionToFile(session);
    const back = fileToSession(file);

    expect(back.id).toBe(session.id);
    expect(back.channel).toBe(session.channel);
    expect(back.channelId).toBe(session.channelId);
    expect(back.agentId).toBe(session.agentId);
    expect(back.threadId).toBe(session.threadId);
    expect(back.chatType).toBe(session.chatType);
    expect(back.sessionMode).toBe(session.sessionMode);
    expect(back.projectPath).toBe(session.projectPath);
    expect(back.agentSessionId).toBe(session.agentSessionId);
    expect(back.name).toBe(session.name);
    expect(back.metadata?.peerId).toBe('ou_aaa');
    expect(back.metadata?.peerName).toBe('Bob');
    expect(back.metadata?.permissionMode).toBe('bypass');
  });

  it('preserves channel-specific metadata fields', () => {
    const session: Session = {
      id: 'meta_20240521_1',
      channel: 'feishu_main',
      channelId: 'oc_x',
      agentId: 'claude',
      threadId: '',
      chatType: 'private',
      sessionMode: 'interactive',
      projectPath: '/p',
      metadata: {
        permissionMode: 'auto',
        agentSessions: { codex: 'cdx-1' },
        resumeAt: 'msg-uuid',
        customField: 'custom-value',
      } as any,
      createdAt: 1,
      updatedAt: 1,
    };

    const file = sessionToFile(session);
    expect(file.metadata.agentSessions).toEqual({ codex: 'cdx-1' });
    expect(file.metadata.resumeAt).toBe('msg-uuid');
    expect(file.metadata.customField).toBe('custom-value');

    const back = fileToSession(file);
    expect(back.metadata?.agentSessions).toEqual({ codex: 'cdx-1' });
    expect(back.metadata?.resumeAt).toBe('msg-uuid');
    expect((back.metadata as any).customField).toBe('custom-value');
  });

  it('handles null fields', () => {
    const session: Session = {
      id: 'meta_x',
      channel: 'c',
      channelId: 'i',
      agentId: 'claude',
      threadId: '',
      chatType: 'private',
      sessionMode: 'interactive',
      projectPath: '/p',
      createdAt: 1,
      updatedAt: 1,
    };
    const file = sessionToFile(session);
    expect(file.agentSessionId).toBeNull();
    expect(file.name).toBeNull();
    expect(file.activeTask).toBeNull();

    const back = fileToSession(file);
    expect(back.agentSessionId).toBeUndefined();
    expect(back.name).toBeUndefined();
    expect(back.processingState).toBeUndefined();
  });
});
