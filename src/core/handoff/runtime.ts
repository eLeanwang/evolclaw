import type { Message, Session, SubMessage } from '../../types.js';
import type { SessionManager } from '../session/session-manager.js';
import type { MessageQueue } from '../message/message-queue.js';
import { classifyAunPayloadForLog } from '../message/message-log.js';
import { HandoffDispatcher, type HandoffTargetSender } from './dispatcher.js';
import { KeyedFairMutex } from './mutex.js';
import { HandoffStore } from './store.js';
import type { HandoffInstance, HandoffReturnResponse, HandoffStatusResponse } from './types.js';

export interface CreateOutboundHandoffInput {
  selfAid: string;
  to: string;
  originSessionId: string;
  originMessageId: string;
  payload: Record<string, unknown>;
  encrypt: boolean;
  thread?: string;
  explicitReturnPolicy?: 'required' | 'none';
}

export interface CreateOutboundHandoffResult {
  crossSession: boolean;
  handoff?: HandoffInstance;
  targetSession: Session;
}

export class HandoffRuntime {
  readonly store: HandoffStore;
  readonly mutexes = new KeyedFairMutex();
  readonly dispatcher: HandoffDispatcher;

  constructor(
    private sessionManager: SessionManager,
    private messageQueue: MessageQueue,
    sender: HandoffTargetSender,
    store = new HandoffStore(),
  ) {
    this.store = store;
    this.dispatcher = new HandoffDispatcher(store, this.mutexes, sender);
  }

  async createOutbound(input: CreateOutboundHandoffInput): Promise<CreateOutboundHandoffResult> {
    if (input.explicitReturnPolicy === 'none') {
      throw Object.assign(new Error('return policy none is not supported in handoff v2 phase 1'), {
        code: 'HANDOFF_RETURN_POLICY_UNSUPPORTED',
      });
    }
    const origin = await this.sessionManager.getSessionById(input.originSessionId);
    if (!origin || origin.selfAID !== input.selfAid) throw new Error('origin session not found');
    const target = await this.sessionManager.getOrCreateSession(
      origin.channel,
      input.to,
      origin.projectPath,
      input.thread,
      { channelKey: origin.metadata?.channelKey, peerId: input.to },
      undefined,
      input.to,
      'private',
      origin.baseagent,
      input.selfAid,
      origin.channelType || 'aun',
      'agent',
    );
    if (target.id === origin.id) {
      if (input.explicitReturnPolicy) {
        throw Object.assign(new Error('return policy requires a cross-session target'), {
          code: 'RETURN_POLICY_REQUIRES_CROSS_SESSION',
        });
      }
      return { crossSession: false, targetSession: target };
    }
    const handoff = this.store.create({
      selfAid: input.selfAid,
      originSessionId: origin.id,
      originMessageId: input.originMessageId,
      targetSessionId: target.id,
      payload: input.payload,
      encrypt: input.encrypt,
    });
    this.dispatcher.notify(input.selfAid, target.id);
    return { crossSession: true, handoff, targetSession: target };
  }

  hasOpenTarget(selfAid: string, targetSessionId: string): boolean {
    return this.store.listByTarget(selfAid, targetSessionId, 'target_sent').length > 0;
  }

  async bindReply(input: {
    selfAid: string;
    targetSessionId: string;
    responseMessageId: string;
    refMessageId?: string | null;
    persistReply: () => void;
  }): Promise<{ candidate: boolean; handoffId?: string }> {
    const key = `${input.selfAid}\u0000${input.targetSessionId}`;
    return this.mutexes.forKey(key).runExclusive(async () => {
      if (!this.hasOpenTarget(input.selfAid, input.targetSessionId)) return { candidate: false };
      input.persistReply();
      const bound = this.store.bindExactReply({
        selfAid: input.selfAid,
        targetSessionId: input.targetSessionId,
        responseMessageId: input.responseMessageId,
        refMessageId: input.refMessageId,
      });
      return { candidate: true, ...(bound ? { handoffId: bound.handoff_id } : {}) };
    });
  }

  markBindingIncomplete(selfAid: string, handoffId: string): void {
    const instance = this.store.get(selfAid, handoffId);
    if (instance && !instance.attention_required) {
      this.store.markAttention(selfAid, handoffId, 'REPLY_BINDING_INCOMPLETE');
    }
  }

  async returnHandoff(input: {
    selfAid: string;
    currentSessionId: string;
    handoffId?: string;
    currentTaskHandoffIds?: string[];
    content: string;
  }): Promise<HandoffReturnResponse> {
    const response = this.store.returnHandoff(input);
    if (response.ok && !response.idempotent) void this.enqueueOrigin(input.selfAid, response.handoff_id);
    return response;
  }

  async enqueueOrigin(selfAid: string, handoffId: string): Promise<void> {
    const instance = this.store.get(selfAid, handoffId);
    if (!instance || instance.state !== 'origin_queued' || !instance.return_content) return;
    const origin = await this.sessionManager.getSessionById(instance.origin_session_id);
    if (!origin) {
      this.store.recordOriginEnqueueFailed(selfAid, handoffId, 'origin session not found');
      return;
    }
    const messageId = `origin-deliver:${handoffId}:${origin.id}`;
    const message: Message = {
      channel: origin.channel,
      channelType: origin.channelType,
      channelId: origin.channelId,
      selfAID: origin.selfAID,
      baseagent: origin.baseagent,
      threadId: origin.threadId || undefined,
      chatType: origin.chatType === 'group' ? 'group' : 'private',
      peerId: origin.channelId,
      peerName: origin.metadata?.peerName || origin.channelId,
      peerType: (origin.metadata as { peerType?: string } | undefined)?.peerType,
      content: instance.return_content,
      messageId,
      timestamp: Date.now(),
      source: 'handoff',
      handoffDelivery: { direction: 'origin', handoffId },
    };
    try {
      await this.messageQueue.enqueuePersisted(origin.id, message, origin.projectPath, {
        interruptible: false,
        interruptSamePeer: false,
        agentName: selfAid,
        role: origin.chatType === 'group' ? (origin.identity?.role ?? 'none') : undefined,
        sessionKeyField: origin.sessionKey,
        selfAID: origin.selfAID,
        onPersisted: () => this.store.recordOriginEnqueued(selfAid, handoffId, messageId),
      });
    } catch (error) {
      this.store.recordOriginEnqueueFailed(selfAid, handoffId, error instanceof Error ? error.message : String(error));
    }
  }

  buildPromptItem(message: Message): SubMessage | null {
    const delivery = message.handoffDelivery;
    const selfAid = message.selfAID;
    if (!delivery || !selfAid) return null;
    const instance = this.store.get(selfAid, delivery.handoffId);
    if (!instance) return null;
    return {
      kind: 'handoff',
      peerId: message.peerId,
      peerName: message.peerName,
      peerType: message.peerType,
      content: message.content,
      timestamp: message.timestamp,
      handoff: {
        kind: delivery.direction === 'target' ? 'request_to_target' : 'response_to_origin',
        handoffId: instance.handoff_id,
        previousContent: this.requestSummary(instance),
        previousMessageId: instance.target_message_id,
      },
    };
  }

  completeOriginContext(selfAid: string, handoffId: string): void {
    const instance = this.store.get(selfAid, handoffId);
    if (instance?.state === 'origin_delivered') this.store.completeOriginContext(selfAid, handoffId);
  }

  status(selfAid: string, handoffId: string): HandoffStatusResponse | null {
    return this.store.status(selfAid, handoffId);
  }

  async recover(selfAids: string[]): Promise<void> {
    const originEnqueues: Promise<void>[] = [];
    for (const selfAid of selfAids) {
      const events = this.store.events(selfAid);
      const lastSendEvent = new Map<string, string>();
      for (const event of events) {
        if (event.handoff_id && event.event_type.startsWith('target_send_')) {
          lastSendEvent.set(event.handoff_id, event.event_type);
        }
      }
      for (const instance of this.store.list(selfAid)) {
        const versionedEvents = events.filter(event =>
          event.handoff_id === instance.handoff_id && event.to_version !== undefined);
        const latestEventVersion = versionedEvents.reduce(
          (latest, event) => Math.max(latest, event.to_version ?? 0), 0);
        if (latestEventVersion !== instance.version) {
          if (!instance.attention_required) {
            this.store.markAttention(selfAid, instance.handoff_id, 'STORE_CONFLICT');
          }
          continue;
        }
        if (instance.state === 'queued') {
          if (lastSendEvent.get(instance.handoff_id) === 'target_send_started') {
            this.store.markAttention(selfAid, instance.handoff_id, 'TARGET_SEND_OUTCOME_UNKNOWN');
          } else {
            this.dispatcher.notify(selfAid, instance.target_session_id);
          }
        } else if (instance.state === 'origin_queued') {
          originEnqueues.push(this.enqueueOrigin(selfAid, instance.handoff_id));
        }
      }
    }
    await Promise.all(originEnqueues);
  }

  private requestSummary(instance: HandoffInstance): string {
    return classifyAunPayloadForLog(instance.request.payload).content || '[payload]';
  }
}
