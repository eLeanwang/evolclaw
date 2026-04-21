import { AUNClient, FileSecretStore, type JsonObject } from '@eleans/aun-core-sdk';
import fs from 'fs';
import path from 'path';
import { logger, localTimestamp } from '../utils/logger.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config, ReplyContext, AunChannelConfig } from '../types.js';
import { normalizeChannelInstances } from '../config.js';
import { resolvePaths } from '../paths.js';

export interface AUNConfig {
  aid: string;
  keystorePath?: string;
  gatewayPort?: number;
  gatewayUrl?: string;    // 兼容旧配置，优先级高于 gatewayPort
  accessToken?: string;
  flushDelay?: number;
  encryptionSeed?: string;
  aunTrace?: boolean;     // 启用数据追踪日志
}

export interface AUNMessageHandler {
  (options: {
    channelId: string;
    content: string;
    chatType: 'private' | 'group';
    peerId: string;
    peerName?: string;
    messageId?: string;
    threadId?: string;
    mentions?: Array<{ userId: string; name?: string }>;
    replyContext?: ReplyContext;
  }): Promise<void>;
}

export class AUNChannel {
  private client: AUNClient | null = null;
  private messageHandler?: AUNMessageHandler;
  private connected = false;
  private traceStream: fs.WriteStream | null = null;

  private trace(dir: 'IN' | 'OUT', event: string, data: unknown): void {
    if (!this.traceStream) return;
    const line = JSON.stringify({ ts: localTimestamp(), dir, event, data });
    this.traceStream.write(line + '\n');
  }

  /** 判断 channelId 是否为群组 ID（g-xxx.agentid.pub 或 grp_ 前缀） */
  private isGroupId(id: string): boolean {
    return id.startsWith('grp_') || (id.startsWith('g-') && id.includes('.'));
  }

  private getShortAid(aid?: string): string | undefined {
    if (!aid) return undefined;
    const trimmed = aid.trim();
    if (!trimmed) return undefined;
    return trimmed.split('.')[0] || trimmed;
  }

  private extractTextPayload(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const text = (payload as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
      return JSON.stringify(payload);
    }
    return '';
  }

  private hasExplicitMention(text: string, target: string): boolean {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,!?;:，。！？；：]|[\\u4e00-\\u9fff])`).test(text);
  }

  private stripTriggerMentions(text: string, selfAid?: string): string {
    let result = text;
    if (selfAid) {
      const escapedAid = selfAid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`(^|\\s)@${escapedAid}(?=$|\\s|[.,!?;:，。！？；：]|[\\u4e00-\\u9fff])`, 'g'), '$1');
    }
    result = result.replace(/(^|\s)@all(?=$|\s|[.,!?;:，。！？；：]|[\u4e00-\u9fff])/gi, '$1');
    return result.replace(/[ \t]+/g, ' ').trim();
  }

  private buildGroupReplyContext(taskId: string | undefined, senderAid: string): ReplyContext {
    const replyContext: ReplyContext = {};
    if (taskId) replyContext.threadId = taskId;
    replyContext.peerId = senderAid;
    return replyContext;
  }

  private acknowledgeImmediately(messageId: string | undefined, seq?: number): void {
    if (seq != null && this.client) {
      this.client.call('message.ack', { seq }).catch(e => {
        logger.debug(`[AUN] Immediate ack failed: ${e}`);
      });
    }
    if (messageId) this.messageSeqMap.delete(messageId);
  }
  private _aid?: string;
  private seenMessages = new Map<string, number>();
  private messageSeqMap = new Map<string, number>();  // messageId → seq (for ack)
  private sentCount = new Map<string, number>();  // channelId → 已发消息计数（用于判断最终回复）

  // Reconnect state (TS-layer fallback, on top of SDK auto_reconnect)
  private intentionalDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_DELAYS = [60, 120, 300, 600];  // seconds
  private onChannelDown?: () => void;

  constructor(private config: AUNConfig) {
    if (config.aunTrace) {
      const logPath = path.join(resolvePaths().logs, 'aun-trace.log');
      this.traceStream = fs.createWriteStream(logPath, { flags: 'a' });
      logger.info(`[AUN] Trace logging enabled: ${logPath}`);
    }
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectAttempt = 0;
    await this.initClient();
  }

  private async initClient(): Promise<void> {
    // Clean up existing client if any
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this.connected = false;

    const aunPath = this.config.keystorePath || `${process.env.HOME || '~'}/.aun`;
    const aidName = this.config.aid;
    const encryptionSeed = this.config.encryptionSeed || process.env.AUN_ENCRYPTION_SEED || undefined;

    // Gateway URL: 旧配置 gatewayUrl 优先，否则从 AID 推导
    let gateway = this.config.gatewayUrl || '';
    if (!gateway) {
      const parts = aidName.split('.');
      if (parts.length >= 3) {
        const domain = parts.slice(1).join('.');  // alice.agentid.pub → agentid.pub
        const port = this.config.gatewayPort || 443;
        gateway = `wss://gateway.${domain}:${port}/aun`;
      }
    }

    if (!gateway) {
      logger.error('[AUN] Cannot derive gateway URL from AID');
      return;
    }

    logger.info(`[AUN] Initializing: aid=${aidName}, gateway=${gateway}, aun_path=${aunPath}`);

    // Create client with FileSecretStore (AES-256-GCM)
    // 不传 encryption_seed 时，SDK 自动从 {aun_path}/.seed 文件派生密钥（与 aun_cli.py 对齐）
    const rootCaPath = `${aunPath}/CA/root/root.crt`;
    this.client = new AUNClient({
      aun_path: aunPath,
      root_ca_path: rootCaPath,
      ...(encryptionSeed && { encryption_seed: encryptionSeed }),
    });
    // Set gateway URL (internal property, same as Python SDK)
    (this.client as any)._gatewayUrl = gateway;

    // Register event handlers before connecting
    this.client.on('message.received', (data: unknown) => {
      this.trace('IN', 'message.received', data);
      const kind = (data && typeof data === 'object') ? (data as any).kind ?? '' : '';
      const keys = (data && typeof data === 'object') ? Object.keys(data as any).join(',') : typeof data;
      logger.info(`[AUN][DIAG] message.received: kind=${kind} keys=${keys}`);
      this.handleIncomingPrivateMessage(data);
    });
    this.client.on('group.message_created', (data: unknown) => {
      this.trace('IN', 'group.message_created', data);
      const gid = (data && typeof data === 'object') ? (data as any).group_id ?? '' : '';
      const sender = (data && typeof data === 'object') ? (data as any).sender_aid ?? '' : '';
      logger.info(`[AUN][DIAG] group.message_created: group_id=${gid} sender=${sender}`);
      this.handleIncomingGroupMessage(data);
    });
    this.client.on('connection.state', (data: unknown) => {
      this.trace('IN', 'connection.state', data);
      this.handleConnectionState(data);
    });

    // Authenticate
    // Workaround: SDK 0.3.x _loadIdentityOrRaise doesn't set identity.aid from requested aid,
    // causing gateway "missing aid" error. Patch to backfill aid on loaded identity.
    const authFlow = (this.client as any)._auth;
    if (authFlow && typeof authFlow._loadIdentityOrRaise === 'function') {
      const origLoad = authFlow._loadIdentityOrRaise.bind(authFlow);
      authFlow._loadIdentityOrRaise = (aid?: string) => {
        const identity = origLoad(aid);
        if (identity && !identity.aid) identity.aid = aid ?? authFlow._aid;
        return identity;
      };
    }

    let accessToken: string;
    try {
      logger.info(`[AUN] Authenticating as ${aidName}...`);
      const auth = await this.client.auth.authenticate(aidName ? { aid: aidName } : undefined);
      this.trace('IN', 'auth.result', { aid: auth.aid, gateway: auth.gateway, hasToken: !!auth.access_token });
      accessToken = auth.access_token as string;
      const resolvedGateway = (auth.gateway as string) || gateway;
      (this.client as any)._gatewayUrl = resolvedGateway;
      logger.info(`[AUN] Authenticated as ${auth.aid ?? '?'}, gateway=${resolvedGateway}`);
    } catch (e: any) {
      const errMsg = e.message || String(e);
      const errName = e.constructor?.name || 'Error';
      logger.error(`[AUN] Authentication failed (${errName}): ${errMsg}`);
      if (e.stack) logger.debug(`[AUN] Auth stack: ${e.stack}`);
      // Fallback: try direct token from env/config (legacy)
      accessToken = this.config.accessToken || process.env.AUN_ACCESS_TOKEN || '';
      if (!accessToken) {
        logger.error(`[AUN] No accessToken fallback available, scheduling retry`);
        this.scheduleReconnect();
        return;
      }
      logger.warn(`[AUN] Using accessToken fallback`);
    }

    // Connect (SDK auto_reconnect handles transient failures)
    try {
      await this.client.connect(
        { access_token: accessToken, gateway: (this.client as any)._gatewayUrl },
        { auto_reconnect: true, retry: { max_attempts: 5, initial_delay: 1.0, max_delay: 30.0 } },
      );
      this._aid = this.client.aid ?? undefined;
      this.connected = true;
      this.reconnectAttempt = 0;

      // Workaround: SDK e2ee uses _identity.cert for sender_cert_fingerprint;
      // if cert is missing, it falls back to public key SPKI fingerprint which
      // causes peer cert lookup failures. Backfill from keystore if needed.
      const clientAny = this.client as any;
      if (clientAny._identity && !clientAny._identity.cert) {
        const cert = clientAny._keystore?.loadCert?.(aidName);
        if (cert) {
          clientAny._identity.cert = cert;
          logger.info('[AUN] Backfilled identity.cert from keystore for e2ee fingerprint');
        }
      }

      logger.info(`[AUN] Connected as ${this._aid}`);
    } catch (e) {
      logger.error(`[AUN] Connection failed: ${e}`);
      this.scheduleReconnect();
      return;
    }
  }

  // ── Event handlers ──────────────────────────────────────────

  private async handleIncomingPrivateMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const fromAid = msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload);
    const taskId = msg.task_id;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Detect @mentions
    const mentions: string[] = [];
    if (this._aid && text.includes(`@${this._aid}`)) {
      mentions.push(this._aid);
    }

    this.dispatchMessage({
      channelId: fromAid,
      userId: fromAid,
      text,
      chatType: 'private',
      messageId,
      seq,
      taskId,
      mentions,
    });
  }

  private async handleIncomingGroupMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const groupId = msg.group_id ?? '';
    const senderAid = msg.sender_aid ?? msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload);
    const taskId = msg.task_id;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Extract structured mentions from payload (e.g. payload.mentions: ["evolai.agentid.pub"])
    const payloadMentions: string[] = Array.isArray((payload as any)?.mentions)
      ? (payload as any).mentions.filter((m: unknown) => typeof m === 'string')
      : [];

    logger.info(`[AUN][DIAG-GRP] full_msg=${JSON.stringify(msg).substring(0, 500)}`);

    if (!groupId || !senderAid) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    if (this._aid && senderAid === this._aid) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const mentionedSelf = this._aid
      ? (this.hasExplicitMention(text, this._aid) || payloadMentions.includes(this._aid))
      : false;
    const mentionedAll = this.hasExplicitMention(text, 'all') || payloadMentions.includes('all');
    if (!mentionedSelf && !mentionedAll) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const strippedText = this.stripTriggerMentions(text, this._aid);
    if (!strippedText) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const mentions: string[] = mentionedAll ? ['all'] : (this._aid ? [this._aid] : []);

    this.dispatchMessage({
      channelId: groupId,
      userId: senderAid,
      peerName: this.getShortAid(senderAid),
      text: strippedText,
      chatType: 'group',
      messageId,
      seq,
      taskId,
      mentions,
      replyContext: this.buildGroupReplyContext(taskId, senderAid),
    });
  }

  private dispatchMessage(event: {
    channelId: string; userId: string; text: string;
    chatType: 'private' | 'group'; messageId: string;
    peerName?: string;
    seq?: number; taskId?: string; mentions?: string[];
    replyContext?: ReplyContext;
  }): void {
    // Dedup
    if (event.messageId) {
      if (this.seenMessages.has(event.messageId)) return;
      this.seenMessages.set(event.messageId, Date.now());
      setTimeout(() => this.seenMessages.delete(event.messageId), 5 * 60 * 1000);
      // Track seq for acknowledge
      if (event.seq != null) {
        this.messageSeqMap.set(event.messageId, event.seq);
      }
    }

    if (!this.messageHandler) return;

    const mentionObjects = event.mentions?.map(aid => ({ userId: aid }));

    // Use caller-supplied replyContext (group path builds mentionUserIds);
    // fall back to simple threadId-only context for private messages
    let replyContext: ReplyContext | undefined = event.replyContext;
    if (!replyContext && event.taskId) {
      replyContext = { threadId: event.taskId };
    }

    this.messageHandler({
      channelId: event.channelId || '',
      content: event.text || '',
      chatType: event.chatType,
      peerId: event.userId || event.channelId || '',
      peerName: event.peerName,
      messageId: event.messageId,
      threadId: event.taskId,
      mentions: mentionObjects,
      replyContext,
    }).catch(err => {
      logger.error('[AUN] Message handler error:', err);
    });
  }

  private handleConnectionState(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const state = (data as Record<string, any>).state ?? '';

    if (state === 'connected') {
      this.connected = true;
      this.reconnectAttempt = 0;
      logger.info('[AUN] Connected');
    } else if (state === 'disconnected') {
      this.connected = false;
      logger.warn(`[AUN] Disconnected: ${(data as Record<string, any>).error ?? 'unknown'}`);
    } else if (state === 'reconnecting') {
      logger.info(`[AUN] SDK reconnecting (attempt ${(data as Record<string, any>).attempt})`);
    } else if (state === 'terminal_failed') {
      this.connected = false;
      logger.error(`[AUN] Terminal failure: ${(data as Record<string, any>).error ?? 'unknown'}`);
      // SDK auto_reconnect exhausted; fall back to TS-layer reconnect
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    }
  }

  // ── Public API (same interface as before) ───────────────────

  onMessage(handler: AUNMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendMessage(channelId: string, text: string, context?: ReplyContext): Promise<void> {
    if (!this.connected || !this.client) {
      logger.warn('[AUN] Cannot send: not connected');
      return;
    }

    if (!text?.trim()) {
      logger.warn('[AUN] Attempted to send empty message, skipping');
      return;
    }

    let finalText = text;
    // 多轮工具调用后的最终回复：仅在已有中间消息时添加前缀
    if (context?.title && (this.sentCount.get(channelId) || 0) > 0) {
      finalText = '最终回复\n' + text;
    }
    this.sentCount.set(channelId, (this.sentCount.get(channelId) || 0) + 1);

    // 群聊 @ 兜底：提示词已告知 agent 要 @，但如果 agent 没写，系统自动补上
    if (this.isGroupId(channelId) && context?.peerId) {
      if (!finalText.includes(`@${context.peerId}`)) {
        finalText = `@${context.peerId} ` + finalText;
      }
    }

    const params: Record<string, any> = { payload: { text: finalText }, encrypt: true };
    if (context?.threadId) params.task_id = context.threadId;

    try {
      if (this.isGroupId(channelId)) {
        params.group_id = channelId;
        this.trace('OUT', 'group.send', params);
        await this.client.call('group.send', params);
      } else {
        params.to = channelId;
        this.trace('OUT', 'message.send', params);
        await this.client.call('message.send', params);
      }
    } catch (e) {
      this.trace('OUT', 'send.error', { channelId, error: String(e) });
      logger.error(`[AUN] Send failed to ${channelId}: ${e}`);
    }
  }

  acknowledge(messageId: string): void {
    // Gateway auto-delivery-ack is sufficient; skip explicit message.ack RPC
    // to avoid duplicate "已送达" at the sender CLI
    this.messageSeqMap.delete(messageId);
  }

  sendProcessingStatus(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, context?: ReplyContext): void {
    if (status === 'start') this.sentCount.delete(channelId);  // 新任务开始，重置计数
    if (!this.client || !this.connected) return;

    const payload = {
      type: 'processing',
      status,
      sessionId,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const params: Record<string, any> = {
      payload,
      encrypt: true,
    };
    if (context?.threadId) params.task_id = context.threadId;

    if (this.isGroupId(channelId)) {
      params.group_id = channelId;
      this.trace('OUT', 'group.send.status', params);
      this.client.call('group.send', params).catch(e => {
        logger.debug(`[AUN] Processing status failed: ${e}`);
      });
    } else {
      params.to = channelId;
      this.trace('OUT', 'message.send.status', params);
      this.client.call('message.send', params).catch(e => {
        logger.debug(`[AUN] Processing status failed: ${e}`);
      });
    }
  }

  sendCustomPayload(channelId: string, payload: string): void {
    if (!this.client || !this.connected) return;

    // SDK 0.3.0 E2EE requires payload to be an object
    let payloadObj: JsonObject;
    try {
      const parsed = JSON.parse(payload);
      payloadObj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed as JsonObject : { text: payload };
    } catch { payloadObj = { text: payload }; }

    const sendParams = {
      to: channelId, payload: payloadObj,
      encrypt: true,
    };
    this.trace('OUT', 'message.send.custom', sendParams);
    this.client.call('message.send', sendParams).catch(e => {
      logger.debug(`[AUN] Custom payload failed: ${e}`);
    });
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this.connected = false;
    if (this.traceStream) {
      this.traceStream.end();
      this.traceStream = null;
    }
    logger.info('[AUN] Disconnected');
  }

  // ── TS-layer reconnect (fallback when SDK auto_reconnect exhausted) ──

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;

    const delays = AUNChannel.RECONNECT_DELAYS;
    if (this.reconnectAttempt >= delays.length) {
      logger.error(`[AUN] All ${delays.length} reconnect attempts exhausted, giving up`);
      this.onChannelDown?.();
      return;
    }

    const delay = delays[this.reconnectAttempt];
    this.reconnectAttempt++;
    logger.info(`[AUN] Scheduling reconnect #${this.reconnectAttempt}/${delays.length} in ${delay}s`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        logger.info(`[AUN] Reconnect #${this.reconnectAttempt} starting...`);
        await this.initClient();
        logger.info(`[AUN] Reconnect #${this.reconnectAttempt} succeeded`);
      } catch (err) {
        logger.error(`[AUN] Reconnect #${this.reconnectAttempt} failed:`, err);
        this.scheduleReconnect();
      }
    }, delay * 1000);
  }

  /** Manually trigger reconnect (e.g. from /check reconnect command) */
  async reconnect(): Promise<string> {
    if (this.connected) return '已连接，无需重连';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    try {
      await this.initClient();
      return `重连成功 (${this._aid})`;
    } catch (err) {
      this.scheduleReconnect();
      return `重连失败: ${err}，已安排自动重试`;
    }
  }

  /** Set callback for when all reconnect attempts are exhausted */
  setOnChannelDown(callback: () => void): void {
    this.onChannelDown = callback;
  }

  /** Get current connection status */
  getStatus(): { connected: boolean; aid?: string; reconnectAttempt: number; maxAttempts: number } {
    return {
      connected: this.connected,
      aid: this._aid,
      reconnectAttempt: this.reconnectAttempt,
      maxAttempts: AUNChannel.RECONNECT_DELAYS.length,
    };
  }
}

// Plugin implementation
export class AUNChannelPlugin implements ChannelPlugin {
  readonly name = 'aun';

  isEnabled(config: Config): boolean {
    const raw = config.channels?.aun;
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some(inst => inst.enabled !== false && !!inst.aid);
    }
    return raw.enabled !== false && !!raw.aid;
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const instances = normalizeChannelInstances<AunChannelConfig>(
      config.channels?.aun,
      'aun',
    );

    const result: ChannelInstance[] = [];
    for (const inst of instances) {
      if (inst.enabled === false || !inst.aid) continue;

      const channel = new AUNChannel({
        aid: inst.aid,
        keystorePath: inst.keystorePath,
        gatewayPort: inst.gatewayPort,
        gatewayUrl: inst.gatewayUrl,
        accessToken: inst.accessToken,
        flushDelay: inst.flushDelay,
        encryptionSeed: inst.encryptionSeed,
        aunTrace: config.debug?.aunTrace,
      });

      const adapter = {
        channelName: inst.name,
        sendText: (id: string, text: string, context?: ReplyContext) => channel.sendMessage(id, text, context),
        acknowledge: (messageId: string) => { channel.acknowledge(messageId); return Promise.resolve(); },
        sendProcessingStatus: (id: string, status: 'start' | 'done', sessionId: string, context?: ReplyContext) => channel.sendProcessingStatus(id, status, sessionId, context),
        sendCustomPayload: (id: string, payload: string) => channel.sendCustomPayload(id, payload),
      };

      const policy = {
        canSwitchProject: (chatType: string, identity: string) => identity === 'owner',
        canListProjects: (chatType: string, identity: string) => identity === 'owner',
        canCreateSession: (chatType: string, identity: string) => true,
        canDeleteSession: (chatType: string, identity: string) => true,
        canImportCliSession: (chatType: string, identity: string) => identity === 'owner',
        messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
        showMiddleResult: (chatType: string, identity: string) => {
          const mode = inst.showActivities ?? config.showActivities ?? 'all';
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        showIdleMonitor: (chatType: string, identity: string) => {
          const mode = inst.showActivities ?? config.showActivities ?? 'all';
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        accumulateErrors: (chatType: string, identity: string) => true,
      };

      const options = {
        flushDelay: inst.flushDelay ?? 3,
        fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
      };

      result.push({
        channelType: 'aun',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
      });
    }

    return result;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const instances = await this.createChannels(config);
    if (instances.length === 0) {
      throw new Error('AUN config missing (aid required, e.g. "mybot.agentid.pub")');
    }
    return instances[0];
  }
}
