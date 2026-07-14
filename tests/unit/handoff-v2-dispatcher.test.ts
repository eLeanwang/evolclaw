import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffDispatcher } from '../../src/core/handoff/dispatcher.js';
import { KeyedFairMutex } from '../../src/core/handoff/mutex.js';
import { HandoffStore } from '../../src/core/handoff/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('HandoffDispatcher', () => {
  it('sends queued instances in order and retries only the current head', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatcher-'));
    roots.push(root);
    const store = new HandoffStore(root);
    const first = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om1', targetSessionId: 't',
      payload: { type: 'text', text: 'one' }, encrypt: false, now: 1,
    });
    const second = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om2', targetSessionId: 't',
      payload: { type: 'text', text: 'two' }, encrypt: false, now: 2,
    });
    const calls: string[] = [];
    let firstAttempts = 0;
    const dispatcher = new HandoffDispatcher(store, new KeyedFairMutex(), async instance => {
      calls.push(instance.handoff_id);
      if (instance.handoff_id === first.handoff_id && firstAttempts++ === 0) return { ok: false, error: 'temporary' };
      return { ok: true, message_id: `m-${instance.handoff_id}` };
    }, { maxAttempts: 2, retryDelaysMs: [0] });

    await dispatcher.drain('self.agentid.pub', 't');
    expect(calls).toEqual([first.handoff_id, first.handoff_id, second.handoff_id]);
    expect(store.get('self.agentid.pub', first.handoff_id)?.state).toBe('target_sent');
    expect(store.get('self.agentid.pub', second.handoff_id)?.state).toBe('target_sent');
  });

  it('stops the head with attention after retries are exhausted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatcher-'));
    roots.push(root);
    const store = new HandoffStore(root);
    const first = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om1', targetSessionId: 't',
      payload: { type: 'text', text: 'one' }, encrypt: false,
    });
    const second = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om2', targetSessionId: 't',
      payload: { type: 'text', text: 'two' }, encrypt: false,
    });
    const calls: string[] = [];
    const dispatcher = new HandoffDispatcher(store, new KeyedFairMutex(), async instance => {
      calls.push(instance.handoff_id);
      return { ok: false, error: 'failed' };
    }, { maxAttempts: 2, retryDelaysMs: [0] });

    await dispatcher.drain('self.agentid.pub', 't');
    expect(calls).toEqual([first.handoff_id, first.handoff_id]);
    expect(store.get('self.agentid.pub', first.handoff_id)).toMatchObject({
      state: 'queued', attention_required: true, attention_reason: 'TARGET_SEND_RETRIES_EXHAUSTED',
    });
    expect(store.get('self.agentid.pub', second.handoff_id)?.state).toBe('queued');
  });

  it('does not resend after the transport succeeded but persistence failed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatcher-'));
    roots.push(root);
    const store = new HandoffStore(root);
    const instance = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om1', targetSessionId: 't',
      payload: { type: 'text', text: 'one' }, encrypt: false,
    });
    const sender = vi.fn(async () => ({ ok: true, message_id: 'external-message' }));
    vi.spyOn(store, 'recordSendSucceeded').mockImplementation(() => { throw new Error('snapshot failed'); });
    const dispatcher = new HandoffDispatcher(store, new KeyedFairMutex(), sender, {
      maxAttempts: 3, retryDelaysMs: [0],
    });

    await dispatcher.drain('self.agentid.pub', 't');

    expect(sender).toHaveBeenCalledTimes(1);
    expect(store.get('self.agentid.pub', instance.handoff_id)).toMatchObject({
      state: 'queued', attention_required: true, attention_reason: 'STORE_CONFLICT',
    });
  });

  it('fails closed when a successful send has no target message id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatcher-'));
    roots.push(root);
    const store = new HandoffStore(root);
    const instance = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om1', targetSessionId: 't',
      payload: { type: 'text', text: 'one' }, encrypt: false,
    });
    const sender = vi.fn(async () => ({ ok: true }));
    const dispatcher = new HandoffDispatcher(store, new KeyedFairMutex(), sender, {
      maxAttempts: 3, retryDelaysMs: [0],
    });

    await dispatcher.drain('self.agentid.pub', 't');

    expect(sender).toHaveBeenCalledTimes(1);
    expect(store.get('self.agentid.pub', instance.handoff_id)).toMatchObject({
      state: 'queued', attention_required: true, attention_reason: 'TARGET_SEND_OUTCOME_UNKNOWN',
    });
  });

  it('pauses after the current send and resumes the queued backlog', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatcher-'));
    roots.push(root);
    const store = new HandoffStore(root);
    const first = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om1', targetSessionId: 't',
      payload: { type: 'text', text: 'one' }, encrypt: false, now: 1,
    });
    const second = store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om2', targetSessionId: 't',
      payload: { type: 'text', text: 'two' }, encrypt: false, now: 2,
    });
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>(resolve => { releaseFirst = resolve; });
    const calls: string[] = [];
    const dispatcher = new HandoffDispatcher(store, new KeyedFairMutex(), async instance => {
      calls.push(instance.handoff_id);
      if (instance.handoff_id === first.handoff_id) await firstSend;
      return { ok: true, message_id: `m-${instance.handoff_id}` };
    });

    dispatcher.notify('self.agentid.pub', 't');
    await vi.waitFor(() => expect(calls).toEqual([first.handoff_id]));
    dispatcher.pauseAgent('self.agentid.pub');
    const drained = dispatcher.drainAgent('self.agentid.pub', 1000);
    releaseFirst();
    await drained;

    expect(dispatcher.isAgentPaused('self.agentid.pub')).toBe(true);
    expect(store.get('self.agentid.pub', first.handoff_id)?.state).toBe('target_sent');
    expect(store.get('self.agentid.pub', second.handoff_id)?.state).toBe('queued');
    expect(calls).toEqual([first.handoff_id]);

    dispatcher.resumeAgent('self.agentid.pub');
    await dispatcher.drain('self.agentid.pub', 't');
    expect(calls).toEqual([first.handoff_id, second.handoff_id]);
    expect(store.get('self.agentid.pub', second.handoff_id)?.state).toBe('target_sent');
  });

  it('aborts drain on timeout and keeps the agent paused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatcher-'));
    roots.push(root);
    const store = new HandoffStore(root);
    store.create({
      selfAid: 'self.agentid.pub', originSessionId: 'o', originMessageId: 'om1', targetSessionId: 't',
      payload: { type: 'text', text: 'one' }, encrypt: false,
    });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const sender = vi.fn(async () => {
      await blocked;
      return { ok: true, message_id: 'm1' };
    });
    const dispatcher = new HandoffDispatcher(store, new KeyedFairMutex(), sender);

    dispatcher.notify('self.agentid.pub', 't');
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
    await expect(dispatcher.drainAgent('self.agentid.pub', 20)).rejects.toThrow('Handoff drain timeout');
    expect(dispatcher.isAgentPaused('self.agentid.pub')).toBe(true);

    release();
    await dispatcher.drainAgent('self.agentid.pub', 1000);
  });
});
