import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { EventBus } from '../../src/core/event-bus.js';

// 真实文件系统的端到端会话选择验证（无 mock、无网络）。
// 验证设计文档 §1.2 的"支点"：observer 插话用 target.channel_id 选会话时，
// 命中的正是 "agent↔对端" 会话 —— 与对端自己发消息命中的同一个 session，
// 且与 "agent↔owner" 会话是两个不同的 session。
// 这是"对端无感 + 共享 agentSessionId"的根基；若选错会话，整个机制失效。

const AGENT = 'agent.agentid.pub';
const PEER = 'peer.agentid.pub';
const OWNER = 'owner.agentid.pub';

describe('observer insert — real session selection (e2e, filesystem)', () => {
  let dir: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'evolclaw-inject-'));
    sm = new SessionManager(dir, new EventBus());
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('inject(target=peer) hits the SAME session as a real peer message', async () => {
    // 1) 对端真实发消息 → 命中 agent↔peer 会话
    const peerSession = await sm.getOrCreateSession(
      'aun', PEER, '/proj', undefined, undefined, undefined,
      PEER, 'private', undefined, AGENT, 'aun', 'human',
    );

    // 2) owner 插话：以 target.channel_id = PEER 选会话（这正是 channel 层 dispatch 用 channelId=targetChannelId 的效果）
    const injectSession = await sm.getOrCreateSession(
      'aun', PEER, '/proj', undefined, undefined, undefined,
      PEER, 'private', undefined, AGENT, 'aun', 'human',
    );

    // 关键断言：插话命中的就是 agent↔peer 那个 session（共享 agentSessionId 的根基）
    expect(injectSession.id).toBe(peerSession.id);
    expect(injectSession.channelId).toBe(PEER);
    expect(injectSession.selfAID).toBe(AGENT);
  });

  it('agent↔peer session is DISTINCT from agent↔owner session', async () => {
    // 对端会话
    const peerSession = await sm.getOrCreateSession(
      'aun', PEER, '/proj', undefined, undefined, undefined,
      PEER, 'private', undefined, AGENT, 'aun', 'human',
    );
    // owner 私聊会话（若 owner 普通发消息会命中这个）—— 必须与对端会话不同
    const ownerSession = await sm.getOrCreateSession(
      'aun', OWNER, '/proj', undefined, undefined, undefined,
      OWNER, 'private', undefined, AGENT, 'aun', 'human',
    );

    expect(ownerSession.id).not.toBe(peerSession.id);
    expect(ownerSession.channelId).toBe(OWNER);
    expect(peerSession.channelId).toBe(PEER);
    // 二者落在不同目录（sessions/aun/<agent>/<channelId>/）
    expect(sm.getChatDir(ownerSession)).not.toBe(sm.getChatDir(peerSession));
  });

  it('inject session and peer session share the same agentSessionId once set', async () => {
    const peerSession = await sm.getOrCreateSession(
      'aun', PEER, '/proj', undefined, undefined, undefined,
      PEER, 'private', undefined, AGENT, 'aun', 'human',
    );
    // 模拟 baseagent 回写 agentSessionId
    await sm.updateSession(peerSession.id, { agentSessionId: 'claude-session-xyz' });

    // 插话再选会话 → 拿到同一 session，agentSessionId 已带上（共享上下文）
    const injectSession = await sm.getOrCreateSession(
      'aun', PEER, '/proj', undefined, undefined, undefined,
      PEER, 'private', undefined, AGENT, 'aun', 'human',
    );
    expect(injectSession.id).toBe(peerSession.id);
    expect(injectSession.agentSessionId).toBe('claude-session-xyz');
  });

  it('group inject(target=groupId) hits the agent↔group session', async () => {
    const GROUP = 'grp_team_alpha';
    const groupSession = await sm.getOrCreateSession(
      'aun', GROUP, '/proj', undefined, undefined, undefined,
      'sommemember.agentid.pub', 'group', undefined, AGENT, 'aun', 'agent',
    );
    const injectSession = await sm.getOrCreateSession(
      'aun', GROUP, '/proj', undefined, undefined, undefined,
      GROUP, 'group', undefined, AGENT, 'aun', 'human',
    );
    expect(injectSession.id).toBe(groupSession.id);
    expect(injectSession.channelId).toBe(GROUP);
  });
});
