import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendHintAdd, appendHintRemove, consumeHints, peekHints,
} from '../../src/core/message/pending-hints.js';
import { chatDirPath } from '../../src/core/session/session-fs-store.js';

// 观察者插话（v0.3）pending-hints 存储：append-only + 回放 + 一次性消费删文件 + thread 作用域。
// 详见 docs/observer-insert-design.md §1.3 / §1.4。

const SELF = 'agent.agentid.pub';
const PEER = 'peer.agentid.pub';

let dir: string;
function hintsFile(threadAwareSelf = SELF, peer = PEER): string {
  return path.join(chatDirPath(dir, 'aun', peer, threadAwareSelf), 'pending-hints.jsonl');
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('pending-hints: add + consume', () => {
  it('add then consume returns the hint and deletes the file', () => {
    const ok = appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: '语气客气些', ownerAid: 'owner.aid.pub', ts: 1 });
    expect(ok).toBe(true);
    expect(fs.existsSync(hintsFile())).toBe(true);

    const hints = consumeHints(dir, 'aun', PEER, SELF, undefined);
    expect(hints.map(h => h.text)).toEqual(['语气客气些']);
    expect(hints[0].ownerAid).toBe('owner.aid.pub');
    // 一次性：消费后文件删除
    expect(fs.existsSync(hintsFile())).toBe(false);
  });

  it('second consume after delete returns empty (not re-injected)', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'x', ownerAid: 'o', ts: 1 });
    consumeHints(dir, 'aun', PEER, SELF, undefined);
    expect(consumeHints(dir, 'aun', PEER, SELF, undefined)).toEqual([]);
  });

  it('preserves send order across multiple adds', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'first', ownerAid: 'o', ts: 1 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a2', text: 'second', ownerAid: 'o', ts: 2 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a3', text: 'third', ownerAid: 'o', ts: 3 });
    const hints = consumeHints(dir, 'aun', PEER, SELF, undefined);
    expect(hints.map(h => h.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('pending-hints: remove (append-only replay)', () => {
  it('remove by id cancels that add (replay)', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'keep', ownerAid: 'o', ts: 1 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a2', text: 'drop', ownerAid: 'o', ts: 2 });
    appendHintRemove(dir, 'aun', PEER, SELF, { targetId: 'a2', ts: 3 });
    const hints = consumeHints(dir, 'aun', PEER, SELF, undefined);
    expect(hints.map(h => h.text)).toEqual(['keep']);
  });

  it('remove-all (no targetId) clears effective set and deletes file', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'x', ownerAid: 'o', ts: 1 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a2', text: 'y', ownerAid: 'o', ts: 2 });
    appendHintRemove(dir, 'aun', PEER, SELF, { ts: 3 });
    // 有效集归零 → 文件被删
    expect(fs.existsSync(hintsFile())).toBe(false);
    expect(consumeHints(dir, 'aun', PEER, SELF, undefined)).toEqual([]);
  });

  it('remove on missing file is idempotent success', () => {
    expect(appendHintRemove(dir, 'aun', PEER, SELF, { targetId: 'nope', ts: 1 })).toBe(true);
  });
});

describe('pending-hints: thread scope', () => {
  it('main-thread hint is not consumed by a thread-B message', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'main-only', ownerAid: 'o', ts: 1 }); // threadId undefined → ''
    // thread-B 消息消费：不应拿到主线程提示，主线程提示仍在
    expect(consumeHints(dir, 'aun', PEER, SELF, 'thread-B')).toEqual([]);
    expect(fs.existsSync(hintsFile())).toBe(true);
    // 主线程消息才消费它
    expect(consumeHints(dir, 'aun', PEER, SELF, undefined).map(h => h.text)).toEqual(['main-only']);
    expect(fs.existsSync(hintsFile())).toBe(false);
  });

  it('consuming one thread keeps the other thread file intact', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'on-A', threadId: 'A', ownerAid: 'o', ts: 1 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'b1', text: 'on-B', threadId: 'B', ownerAid: 'o', ts: 2 });
    expect(consumeHints(dir, 'aun', PEER, SELF, 'A').map(h => h.text)).toEqual(['on-A']);
    // B 仍在
    expect(fs.existsSync(hintsFile())).toBe(true);
    expect(peekHints(dir, 'aun', PEER, SELF, 'B').map(h => h.text)).toEqual(['on-B']);
    // 消费 B → 文件删
    expect(consumeHints(dir, 'aun', PEER, SELF, 'B').map(h => h.text)).toEqual(['on-B']);
    expect(fs.existsSync(hintsFile())).toBe(false);
  });
});

describe('pending-hints: persistence (survives across reads)', () => {
  it('file persists until consumed (simulates restart)', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'persist', ownerAid: 'o', ts: 1 });
    // 重新读（模拟重启后另一次进程读取）
    expect(peekHints(dir, 'aun', PEER, SELF, undefined).map(h => h.text)).toEqual(['persist']);
    expect(fs.existsSync(hintsFile())).toBe(true);
  });
});

describe('pending-hints: edge cases (A 补强)', () => {
  // A1. 畸形/空行 jsonl：坏行跳过，好行仍生效（readAllJsonlLines 容错）
  it('tolerates malformed/blank lines in jsonl', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'good', ownerAid: 'o', ts: 2 });
    // 手动插入坏行 + 空行
    fs.appendFileSync(hintsFile(), '\n{ not valid json \n\n');
    const hints = peekHints(dir, 'aun', PEER, SELF, undefined);
    expect(hints.map(h => h.text)).toEqual(['good']);
  });

  // A2. 同 ts 多条 add：排序稳定（按插入序 tie-break，不丢条）
  it('keeps all hints with identical ts in insertion order', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'one', ownerAid: 'o', ts: 5 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a2', text: 'two', ownerAid: 'o', ts: 5 });
    const hints = consumeHints(dir, 'aun', PEER, SELF, undefined);
    expect(hints.map(h => h.text)).toEqual(['one', 'two']);
  });

  // A3. remove 指向不存在的 id：有效集不变、文件保留
  it('remove of unknown id leaves effective set + file intact', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'keep', ownerAid: 'o', ts: 1 });
    appendHintRemove(dir, 'aun', PEER, SELF, { targetId: 'nonexistent', ts: 2 });
    expect(fs.existsSync(hintsFile())).toBe(true);
    expect(peekHints(dir, 'aun', PEER, SELF, undefined).map(h => h.text)).toEqual(['keep']);
  });

  // A4. group chat：群 id 作为 peerChannelId，路径与私聊一致解析
  it('works with group id as channelId', () => {
    const GROUP = 'team.group.company.com';
    appendHintAdd(dir, 'aun', GROUP, SELF, { id: 'g1', text: 'group-hint', ownerAid: 'o', ts: 1 });
    const fp = path.join(chatDirPath(dir, 'aun', GROUP, SELF), 'pending-hints.jsonl');
    expect(fs.existsSync(fp)).toBe(true);
    expect(consumeHints(dir, 'aun', GROUP, SELF, undefined).map(h => h.text)).toEqual(['group-hint']);
  });

  // A5. 同 id 二次 add（覆盖语义）：回放取最后一条 text
  it('re-add with same id overrides earlier text', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'v1', ownerAid: 'o', ts: 1 });
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'v2', ownerAid: 'o', ts: 2 });
    const hints = consumeHints(dir, 'aun', PEER, SELF, undefined);
    expect(hints.map(h => h.text)).toEqual(['v2']);
  });

  // A6. peekHints 只读：不删文件、不改状态
  it('peekHints does not consume or delete', () => {
    appendHintAdd(dir, 'aun', PEER, SELF, { id: 'a1', text: 'x', ownerAid: 'o', ts: 1 });
    peekHints(dir, 'aun', PEER, SELF, undefined);
    peekHints(dir, 'aun', PEER, SELF, undefined);
    expect(fs.existsSync(hintsFile())).toBe(true);
    expect(consumeHints(dir, 'aun', PEER, SELF, undefined).map(h => h.text)).toEqual(['x']);
  });
});
