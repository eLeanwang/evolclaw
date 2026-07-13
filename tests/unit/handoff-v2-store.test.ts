import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { HandoffStore } from '../../src/core/handoff/store.js';
import { HandoffRuntime } from '../../src/core/handoff/runtime.js';

const roots: string[] = [];

function makeStore(): HandoffStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-handoff-v2-'));
  roots.push(root);
  return new HandoffStore(root);
}

function create(store: HandoffStore, selfAid = 'self.agentid.pub', target = 'meta-target') {
  return store.create({
    selfAid,
    originSessionId: 'meta-origin',
    originMessageId: 'origin-message',
    targetSessionId: target,
    payload: { type: 'text', text: 'question' },
    encrypt: false,
    now: 100,
  });
}

function send(store: HandoffStore, handoffId: string, messageId = 'target-message') {
  store.recordSendStarted('self.agentid.pub', handoffId, 110);
  return store.recordSendSucceeded('self.agentid.pub', handoffId, messageId, 120);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('HandoffStore', () => {
  it('persists per-agent snapshots and append-only events', () => {
    const store = makeStore();
    const first = create(store);
    const second = create(store, 'other.agentid.pub');

    expect(store.get('self.agentid.pub', first.handoff_id)?.state).toBe('queued');
    expect(store.get('other.agentid.pub', first.handoff_id)).toBeNull();
    expect(store.get('other.agentid.pub', second.handoff_id)?.state).toBe('queued');
    expect(store.events('self.agentid.pub').map(event => event.event_type)).toEqual(['created']);
  });

  it('binds exact refs and infers only a unique unreferenced candidate', () => {
    const store = makeStore();
    const first = create(store);
    const second = create(store);
    send(store, first.handoff_id, 'm1');
    send(store, second.handoff_id, 'm2');

    const exact = store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'r1', refMessageId: 'm2', now: 130,
    });
    expect(exact?.handoff_id).toBe(second.handoff_id);
    expect(store.get('self.agentid.pub', first.handoff_id)?.state).toBe('target_sent');

    const missedRef = store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'r2', refMessageId: 'unknown', now: 140,
    });
    expect(missedRef).toBeNull();

    const inferred = store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'r3', now: 150,
    });
    expect(inferred?.handoff_id).toBe(first.handoff_id);
    expect(store.events('self.agentid.pub').at(-1)).toMatchObject({
      event_type: 'reply_bound', from_version: 2, to_version: 3,
    });
  });

  it('does not infer when multiple unreferenced candidates remain', () => {
    const store = makeStore();
    const first = create(store);
    const second = create(store);
    send(store, first.handoff_id, 'm1');
    send(store, second.handoff_id, 'm2');

    expect(store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'r1', now: 130,
    })).toBeNull();
    expect(store.get('self.agentid.pub', first.handoff_id)?.state).toBe('target_sent');
    expect(store.get('self.agentid.pub', second.handoff_id)?.state).toBe('target_sent');
  });

  it('authorizes return by persisted target binding and handles idempotency', () => {
    const store = makeStore();
    const instance = create(store);
    send(store, instance.handoff_id);
    store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'r1', refMessageId: 'target-message', now: 130,
    });

    const mismatch = store.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: 'meta-wrong',
      handoffId: instance.handoff_id, content: 'answer', now: 140,
    });
    expect(mismatch).toMatchObject({ ok: false, code: 'HANDOFF_TARGET_SESSION_MISMATCH' });

    const accepted = store.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: 'meta-target',
      handoffId: instance.handoff_id, content: 'answer\r\n', now: 150,
    });
    expect(accepted).toMatchObject({
      ok: true, code: 'HANDOFF_RETURN_ACCEPTED', state: 'origin_queued', idempotent: false,
    });
    expect(store.get('self.agentid.pub', instance.handoff_id)?.return_content).toBe('answer');

    const repeated = store.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: 'meta-target',
      handoffId: instance.handoff_id, content: 'answer\n', now: 160,
    });
    expect(repeated).toMatchObject({
      ok: true, code: 'HANDOFF_RETURN_ALREADY_APPLIED', idempotent: true,
    });

    const conflict = store.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: 'meta-target',
      handoffId: instance.handoff_id, content: 'different', now: 170,
    });
    expect(conflict).toMatchObject({ ok: false, code: 'HANDOFF_RETURN_CONFLICT' });
  });

  it('supports current-task shorthand and completes at origin context consumption', () => {
    const store = makeStore();
    const instance = create(store);
    send(store, instance.handoff_id);
    store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'r1', now: 130,
    });
    const accepted = store.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: 'meta-target',
      currentTaskHandoffIds: [instance.handoff_id], content: 'answer', now: 140,
    });
    expect(accepted).toMatchObject({ ok: true, selected_by: 'single_current_task_candidate' });

    const messageId = `origin-deliver:${instance.handoff_id}:meta-origin`;
    expect(store.recordOriginEnqueued('self.agentid.pub', instance.handoff_id, messageId, 150).state).toBe('origin_delivered');
    expect(store.completeOriginContext('self.agentid.pub', instance.handoff_id, 160)).toMatchObject({
      state: 'completed', completed_at: 160,
    });
  });

  it('fails closed when history is ahead of the snapshot during recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-handoff-v2-'));
    roots.push(root);
    const store = new HandoffStore(root);
    const instance = create(store);
    fs.appendFileSync(path.join(root, 'self.agentid.pub', 'history.jsonl'), `${JSON.stringify({
      event_id: 'ev-crash-window',
      event_type: 'target_send_succeeded',
      handoff_id: instance.handoff_id,
      from_version: 1,
      to_version: 2,
      created_at: 110,
    })}\n`);
    const runtime = new HandoffRuntime({} as any, {} as any, async () => ({ ok: true }), store);

    await runtime.recover(['self.agentid.pub']);

    expect(store.get('self.agentid.pub', instance.handoff_id)).toMatchObject({
      state: 'queued', attention_required: true, attention_reason: 'STORE_CONFLICT',
    });
  });
});
