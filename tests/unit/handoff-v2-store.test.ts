import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('completes a Feishu group to AUN target round trip through v2 state', async () => {
    const store = makeStore();
    const origin = {
      id: 'meta-feishu-group', channel: 'feishu#self.agentid.pub#main', channelType: 'feishu',
      channelId: 'feishu-group-1', selfAID: 'self.agentid.pub', baseagent: 'codex',
      threadId: 'feishu-thread-1', sessionKey: 'feishu#feishu-group-1#feishu-thread-1',
      chatType: 'group', chatMode: 'interactive', projectPath: '/project',
      metadata: { channelKey: 'feishu#self.agentid.pub#main', peerName: 'Feishu Group' },
      identity: { role: 'member', mode: 'interactive' }, createdAt: 1, updatedAt: 1,
    };
    const target = {
      ...origin,
      id: 'meta-aun-target', channel: 'aun#self.agentid.pub#main', channelType: 'aun',
      channelId: 'target.agentid.pub', threadId: '', sessionKey: 'aun#target.agentid.pub#',
      chatType: 'private', chatMode: 'proactive',
      metadata: { channelKey: 'aun#self.agentid.pub#main', peerId: 'target.agentid.pub' },
      identity: { role: 'member', mode: 'interactive' },
    };
    const getOrCreateSession = vi.fn(async () => target);
    const enqueuePersisted = vi.fn(async (_sessionId, _message, _projectPath, options) => {
      options?.onPersisted?.();
    });
    const sender = vi.fn(async () => ({ ok: true, message_id: 'aun-target-message' }));
    const runtime = new HandoffRuntime({
      getSessionById: async (sessionId: string) => sessionId === origin.id ? origin : target,
      getOrCreateSession,
    } as any, { enqueuePersisted } as any, sender, store);

    const created = await runtime.createOutbound({
      selfAid: 'self.agentid.pub', to: 'target.agentid.pub',
      originSessionId: origin.id, originMessageId: 'feishu-origin-message',
      payload: { type: 'text', text: 'question from Feishu group' }, encrypt: false,
    });
    expect(getOrCreateSession).toHaveBeenCalledWith(
      'aun#self.agentid.pub#main', 'target.agentid.pub', '/project', undefined,
      { channelKey: 'aun#self.agentid.pub#main', peerId: 'target.agentid.pub' },
      undefined, 'target.agentid.pub', 'private', 'codex', 'self.agentid.pub', 'aun', 'agent',
    );
    expect(created).toMatchObject({ crossSession: true, targetSession: { id: target.id } });

    await runtime.dispatcher.drain('self.agentid.pub', target.id);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(store.get('self.agentid.pub', created.handoff!.handoff_id)).toMatchObject({
      state: 'target_sent', target_message_id: 'aun-target-message',
    });

    const persistReply = vi.fn();
    const bound = await runtime.bindReply({
      selfAid: 'self.agentid.pub', targetSessionId: target.id,
      responseMessageId: 'aun-reply-message', refMessageId: 'aun-target-message', persistReply,
    });
    expect(bound).toEqual({ candidate: true, handoffId: created.handoff!.handoff_id });
    expect(persistReply).toHaveBeenCalledTimes(1);
    const targetPrompt = runtime.buildPromptItem({
      channel: target.channel, channelType: 'aun', channelId: target.channelId,
      selfAID: target.selfAID, chatType: 'private', peerId: target.channelId,
      content: 'target answer', messageId: 'aun-reply-message', timestamp: 2,
      handoffDelivery: { direction: 'target', handoffId: created.handoff!.handoff_id },
    });
    expect(targetPrompt).toMatchObject({
      kind: 'handoff',
      handoff: { kind: 'request_to_target', handoffId: created.handoff!.handoff_id },
    });

    const returned = await runtime.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: target.id,
      currentTaskHandoffIds: [created.handoff!.handoff_id], content: 'target answer',
    });
    expect(returned).toMatchObject({ ok: true, selected_by: 'single_current_task_candidate' });
    await vi.waitFor(() => expect(enqueuePersisted).toHaveBeenCalledTimes(1));
    const [originSessionId, originMessage, projectPath] = enqueuePersisted.mock.calls[0];
    expect(originSessionId).toBe(origin.id);
    expect(projectPath).toBe('/project');
    expect(originMessage).toMatchObject({
      channel: origin.channel, channelType: 'feishu', channelId: origin.channelId,
      threadId: origin.threadId, chatType: 'group', content: 'target answer',
      handoffDelivery: { direction: 'origin', handoffId: created.handoff!.handoff_id },
    });
    expect(runtime.buildPromptItem(originMessage)).toMatchObject({
      kind: 'handoff', handoff: { kind: 'response_to_origin' }, content: 'target answer',
    });

    runtime.completeOriginContext('self.agentid.pub', created.handoff!.handoff_id);
    expect(store.get('self.agentid.pub', created.handoff!.handoff_id)?.state).toBe('completed');
  });

  it('persists per-agent snapshots and append-only events', () => {
    const store = makeStore();
    const first = create(store);
    const second = create(store, 'other.agentid.pub');

    expect(store.get('self.agentid.pub', first.handoff_id)?.state).toBe('queued');
    expect(store.get('other.agentid.pub', first.handoff_id)).toBeNull();
    expect(store.get('other.agentid.pub', second.handoff_id)?.state).toBe('queued');
    expect(store.events('self.agentid.pub').map(event => event.event_type)).toEqual(['created']);
    expect(first.handoff_id).toMatch(/^h-[0-9a-f]{8}$/);
  });

  it('lists with bounded filters and traces only the selected handoff', () => {
    const store = makeStore();
    const first = create(store, 'self.agentid.pub', 'meta-one');
    const second = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'other-origin', originMessageId: 'other-message',
      targetSessionId: 'meta-two', payload: { type: 'text', text: 'second' }, encrypt: false, now: 105,
    });
    send(store, first.handoff_id, 'm1');

    expect(store.query('self.agentid.pub', { limit: 1 }).map(item => item.handoff_id)).toEqual([first.handoff_id]);
    expect(store.query('self.agentid.pub', { state: 'queued' }).map(item => item.handoff_id)).toEqual([second.handoff_id]);
    expect(store.query('self.agentid.pub', { sessionId: 'meta-one' }).map(item => item.handoff_id)).toEqual([first.handoff_id]);
    expect(store.query('self.agentid.pub', { sessionId: 'other-origin' }).map(item => item.handoff_id)).toEqual([second.handoff_id]);
    expect(store.trace('self.agentid.pub', first.handoff_id, 2)?.map(event => event.event_type)).toEqual([
      'target_send_started', 'target_send_succeeded',
    ]);
    expect(store.trace('self.agentid.pub', 'h-00000000')).toBeNull();
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

  it('recovers safe queued sends but does not retry an unknown send', async () => {
    const store = makeStore();
    const safe = create(store, 'self.agentid.pub', 'safe-target');
    const unknown = create(store, 'self.agentid.pub', 'unknown-target');
    store.recordSendStarted('self.agentid.pub', unknown.handoff_id, 110);
    const sender = vi.fn(async instance => ({ ok: true, message_id: `m-${instance.handoff_id}` }));
    const runtime = new HandoffRuntime({} as any, {} as any, sender, store);

    await runtime.recover(['self.agentid.pub']);
    await runtime.dispatcher.drain('self.agentid.pub', 'safe-target');

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0].handoff_id).toBe(safe.handoff_id);
    expect(store.get('self.agentid.pub', safe.handoff_id)?.state).toBe('target_sent');
    expect(store.get('self.agentid.pub', unknown.handoff_id)).toMatchObject({
      state: 'queued', attention_required: true, attention_reason: 'TARGET_SEND_OUTCOME_UNKNOWN',
    });
  });

  it('recovers an origin_queued result through durable enqueue', async () => {
    const store = makeStore();
    const instance = create(store);
    send(store, instance.handoff_id);
    store.bindExactReply({
      selfAid: 'self.agentid.pub', targetSessionId: 'meta-target',
      responseMessageId: 'response-message', now: 130,
    });
    store.returnHandoff({
      selfAid: 'self.agentid.pub', currentSessionId: 'meta-target',
      handoffId: instance.handoff_id, content: 'answer', now: 140,
    });
    const origin = {
      id: 'meta-origin', channel: 'aun-main', channelType: 'aun', channelId: 'origin.agentid.pub',
      selfAID: 'self.agentid.pub', baseagent: 'codex', chatType: 'private', projectPath: '/tmp', metadata: {},
    };
    const enqueuePersisted = vi.fn(async (_sessionId, _message, _projectPath, options) => {
      options?.onPersisted?.();
    });
    const runtime = new HandoffRuntime({
      getSessionById: async () => origin,
    } as any, { enqueuePersisted } as any, async () => ({ ok: true }), store);

    await runtime.recover(['self.agentid.pub']);

    expect(enqueuePersisted).toHaveBeenCalledTimes(1);
    expect(store.get('self.agentid.pub', instance.handoff_id)).toMatchObject({
      state: 'origin_delivered',
      origin_delivery_message_id: `origin-deliver:${instance.handoff_id}:meta-origin`,
    });
  });
});
