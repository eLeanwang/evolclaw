import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendHintAdd, appendHintRemove, consumeHints,
  hintsToSubMessages, composeHintFallback,
} from '../../src/core/message/pending-hints.js';
import { renderMessageBody } from '../../src/agents/message-renderer.js';
import { chatDirPath } from '../../src/core/session/session-fs-store.js';
import { getPackageRoot } from '../../src/paths.js';
import type { SubMessage } from '../../src/types.js';

// 观察者插话（v0.3）端到端串联（F）：落提示 → 模拟"下一条对端消息" → 消费 + 渲染。
// 复现 message-processor 的 consumeOwnerHints + renderMessageBody 接线（用真实纯函数）。

const SELF = 'agent.agentid.pub';
const PEER = 'peer.agentid.pub';
const OWNER = 'owner.agentid.pub';

let dir: string;
const sessionVars = () => ({
  selfAid: SELF, timezone: 'UTC',
  KITS_MESSAGE_FRAGMENTS: path.join(getPackageRoot(), 'kits', 'templates', 'message-fragments'),
});
function hintsFile(peer = PEER): string {
  return path.join(chatDirPath(dir, 'aun', peer, SELF), 'pending-hints.jsonl');
}

// 复现 processor：消费 (对端,thread) 提示 → owner-hint items 排在对端 item 前 → 渲染
function simulateInbound(peerChannelId: string, threadId: string | undefined, peerContent: string, chatType = 'private') {
  const hints = consumeHints(dir, 'aun', peerChannelId, SELF, threadId);
  const hintItems = hintsToSubMessages(hints);
  const peerItems: SubMessage[] = [{ peerId: peerChannelId, content: peerContent, timestamp: 1700000000000 }];
  const renderItems = hintItems.length > 0 ? [...hintItems, ...peerItems] : peerItems;
  const { body } = renderMessageBody(renderItems, { ...sessionVars(), chatType }, 'sess');
  return { body, hintItems, consumedCount: hints.length };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phe2e-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('F1: add → next peer message consumes + injects, file deleted', () => {
  it('renders inject header + hint + peer text, then deletes file', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'h1', text: '别答应折扣', ownerAid: OWNER, ts: 1700000000000 });
    expect(fs.existsSync(hintsFile())).toBe(true);

    const { body, consumedCount } = simulateInbound(PEER, undefined, '能便宜点吗');
    expect(consumedCount).toBe(1);
    expect(body).toContain('owner');         // inject 信封头
    expect(body).toContain('别答应折扣');      // 提示正文
    expect(body).toContain('能便宜点吗');      // 对端原文
    // 提示在对端消息之前
    expect(body.indexOf('别答应折扣')).toBeLessThan(body.indexOf('能便宜点吗'));
    // 一次性：文件已删
    expect(fs.existsSync(hintsFile())).toBe(false);
  });

  it('second peer message no longer injects the hint', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'h1', text: 'ONCE', ownerAid: OWNER, ts: 1 });
    simulateInbound(PEER, undefined, 'msg1');
    const { body, consumedCount } = simulateInbound(PEER, undefined, 'msg2');
    expect(consumedCount).toBe(0);
    expect(body).not.toContain('ONCE');
    expect(body).toContain('msg2');
  });
});

describe('F2: thread isolation end-to-end', () => {
  it('thread-A hint not consumed by thread-B message; consumed by thread-A message', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'h1', text: 'ON-A', threadId: 'A', ownerAid: OWNER, ts: 1 });

    // thread-B 消息：不消费
    const b = simulateInbound(PEER, 'B', 'msg-on-B');
    expect(b.consumedCount).toBe(0);
    expect(b.body).not.toContain('ON-A');
    expect(fs.existsSync(hintsFile())).toBe(true);

    // thread-A 消息：消费
    const a = simulateInbound(PEER, 'A', 'msg-on-A');
    expect(a.consumedCount).toBe(1);
    expect(a.body).toContain('ON-A');
    expect(fs.existsSync(hintsFile())).toBe(false);
  });
});

describe('F3: add → remove → peer message sees nothing', () => {
  it('removed hint is not injected', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'h1', text: 'TORM', ownerAid: OWNER, ts: 1 });
    appendHintRemove(dir, 'aun', PEER, SELF, { targetId: 'h1', ts: 2 });
    const { body, consumedCount } = simulateInbound(PEER, undefined, 'hello');
    expect(consumedCount).toBe(0);
    expect(body).not.toContain('TORM');
    expect(body).toContain('hello');
  });
});

describe('F4: render-failure fallback keeps consumed hints', () => {
  it('composeHintFallback prepends already-consumed hints when render path is bypassed', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'h1', text: 'SAFEHINT', ownerAid: OWNER, ts: 1 });
    const hints = consumeHints(dir, 'aun', PEER, SELF, undefined);
    const hintItems = hintsToSubMessages(hints);
    // 模拟渲染抛错 → 走 composeHintFallback 兜底
    const fallback = composeHintFallback(hintItems, 'peer-raw');
    expect(fallback).toContain('SAFEHINT');
    expect(fallback).toContain('peer-raw');
    // 文件已在消费时删除 — 提示不可恢复，但兜底已拼回，不丢
    expect(fs.existsSync(hintsFile())).toBe(false);
  });
});
