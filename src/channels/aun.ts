import { AUNClient, FileSecretStore, GatewayDiscovery, type JsonObject } from '@agentunion/fastaun';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger, localTimestamp } from '../utils/logger.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config, ReplyContext, AunChannelConfig } from '../types.js';
import { normalizeChannelInstances, getChannelShowActivities } from '../config.js';
import { resolvePaths } from '../paths.js';
import { saveToUploads, sanitizeFileName } from '../utils/media-cache.js';

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
    '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.xml': 'application/xml', '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
  };
  return map[ext] || 'application/octet-stream';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export interface AUNConfig {
  aid: string;
  keystorePath?: string;
  gatewayUrl?: string;    // well-known 自动发现失败时的 fallback URL
  accessToken?: string;
  flushDelay?: number;
  encryptionSeed?: string;
  aunTrace?: boolean;     // 启用数据追踪日志
  owner?: string;         // Owner AID，用于发送欢迎消息
}

export interface AUNMessageHandler {
  (options: {
    channelId: string;
    content: string;
    chatType: 'private' | 'group';
    peerId: string;
    peerName?: string;
    peerType?: string;
    messageId?: string;
    threadId?: string;
    mentions?: Array<{ userId: string; name?: string }>;
    replyContext?: ReplyContext;
  }): Promise<void>;
}

export class AUNChannel {
  private client: AUNClient | null = null;
  private projectPathProvider?: (channelId: string) => Promise<string>;
  private messageHandler?: AUNMessageHandler;
  private recallHandler?: (messageId: string) => void;
  private connected = false;
  private traceStream: fs.WriteStream | null = null;
  private traceDate: string = '';  // 当前 trace 文件对应的日期 (YYYYMMDD)

  private trace(dir: 'IN' | 'OUT', event: string, data: unknown): void {
    if (!this.config.aunTrace) return;
    this.rotateTraceIfNeeded();
    if (!this.traceStream) return;
    const line = JSON.stringify({ ts: localTimestamp(), dir, event, data });
    this.traceStream.write(line + '\n');
  }

  private rotateTraceIfNeeded(): void {
    const d = new Date();
    const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    if (this.traceDate === today && this.traceStream) return;
    if (this.traceStream) {
      this.traceStream.end();
      this.traceStream = null;
    }
    this.traceDate = today;
    const logPath = path.join(resolvePaths().logs, `aun-${today}.log`);
    this.traceStream = fs.createWriteStream(logPath, { flags: 'a' });
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

  private stripSelfMentionIfOnly(text: string, selfAid?: string): string {
    if (!selfAid) return text;
    const mentions = text.match(/@[\w.-]+/g) || [];
    if (mentions.length !== 1) return text;
    const escapedAid = selfAid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
      .replace(new RegExp(`(^|\\s)@${escapedAid}(?=$|\\s|[.,!?;:，。！？；：]|[\\u4e00-\\u9fff])`, 'g'), '$1')
      .replace(/[ \t]+/g, ' ')
      .trim();
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
  private _chatId = '';  // aid:device_id:slot_id — 多实例回声过滤
  private seenMessages = new Map<string, number>();
  private peerInfoCache = new Map<string, { type: 'human' | 'ai'; name?: string }>();
  private messageSeqMap = new Map<string, number>();  // messageId → seq (for ack)
  private sentCount = new Map<string, number>();  // channelId → 已发消息计数（用于判断最终回复）

  // Reconnect state (TS-layer fallback, on top of SDK auto_reconnect)
  private intentionalDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_DELAYS = [60, 120, 300, 600];  // seconds
  private onChannelDown?: () => void;

  // SDK reconnect throttling — avoid log spam when SDK enters tight reconnect loop
  private lastReconnectLogTime = 0;
  private lastReconnectLogAttempt = 0;
  private static readonly RECONNECT_LOG_INTERVAL = 60_000;  // log at most every 60s
  private static readonly RECONNECT_LOG_STEP = 100;         // or every 100 attempts
  private static readonly SDK_RECONNECT_GIVEUP = 50;        // force TS-layer fallback after this many SDK attempts

  constructor(private config: AUNConfig) {
    if (config.aunTrace) {
      this.rotateTraceIfNeeded();
      logger.info(`[AUN] Trace logging enabled (daily rotation): ${resolvePaths().logs}/aun-YYYYMMDD.log`);
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

    // Gateway URL 解析：优先用配置的 gatewayUrl，否则通过 well-known 自动发现
    let gateway = this.config.gatewayUrl || '';
    if (!gateway) {
      // AID 本身即域名（如 evolai.agentid.pub），用其查询 well-known，与 Python SDK 行为对齐
      const wellKnownUrl = `https://${aidName}/.well-known/aun-gateway`;
      try {
        const discovery = new GatewayDiscovery({});
        gateway = await discovery.discover(wellKnownUrl);
        logger.info(`[AUN] Gateway discovered: ${gateway}`);
      } catch (e) {
        logger.warn(`[AUN] Well-known discovery failed (${e}), no fallback available`);
      }
    }

    if (!gateway) {
      logger.error('[AUN] Cannot resolve gateway URL from AID');
      throw new Error('Cannot resolve gateway URL from AID');
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
      // trace is handled inside handleConnectionState with throttling
      this.handleConnectionState(data);
    });
    this.client.on('message.recalled', (data: unknown) => {
      this.trace('IN', 'message.recalled', data);
      if (data && typeof data === 'object') {
        const ids = (data as any).message_ids;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id === 'string') {
              logger.info(`[AUN] Message recalled: ${id}`);
              this.recallHandler?.(id);
            }
          }
        }
      }
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
        throw new Error('Authentication failed and no accessToken fallback available');
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
      const deviceId = (this.client as any)._device_id ?? '';
      this._chatId = this._aid ? `${this._aid}:${deviceId}:` : '';
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

      // Send welcome message to owner after first connection
      await this.sendWelcomeMessage();
    } catch (e) {
      logger.error(`[AUN] Connection failed: ${e}`);
      this.scheduleReconnect();
      throw e;
    }
  }

  private async sendWelcomeMessage(): Promise<void> {
    try {
      const owner = this.config.owner;
      if (!owner) {
        logger.info('[AUN] No owner configured, skipping welcome message');
        return;
      }

      // Check agent.md initialized field
      const aid = this.config.aid;
      const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
      const agentMdPath = path.join(os.homedir(), '.aun', 'AIDs', aidName, 'agent.md');

      if (!fs.existsSync(agentMdPath)) {
        logger.warn('[AUN] agent.md not found, skipping welcome message');
        return;
      }

      const agentMdContent = fs.readFileSync(agentMdPath, 'utf-8');
      const match = agentMdContent.match(/^---\n([\s\S]*?)\n---/);
      if (!match) {
        logger.warn('[AUN] agent.md frontmatter not found');
        return;
      }

      const frontmatter = match[1];
      const initializedMatch = frontmatter.match(/^initialized:\s*(true|false)/m);
      if (!initializedMatch || initializedMatch[1] === 'true') {
        logger.info('[AUN] Agent already initialized, skipping welcome message');
        return;
      }

      // Fetch owner's agent.md to derive name and validate type
      const ownerInfo = await this.fetchPeerInfo(owner);
      if (ownerInfo.type !== null && ownerInfo.type !== 'human') {
        logger.warn(`[AUN] Owner ${owner} type is "${ownerInfo.type}" (not human). Consider using a human AID as owner.`);
      }

      // Name: prefer existing agent.md name if user has customized it,
      // otherwise generate "{ownerName}的Evol助手 ({aidLabel})" for disambiguation
      const ownerAidClean = owner.startsWith('@') ? owner.slice(1) : owner;
      let ownerDisplayName: string;
      if (ownerInfo.name) {
        ownerDisplayName = ownerInfo.name.slice(0, 12);
      } else {
        ownerDisplayName = ownerAidClean.split('.')[0].slice(0, 12);
      }

      // Check if init wrote a meaningful name (vs just the aid first label default)
      const currentNameMatch = frontmatter.match(/^name:\s*"?([^"\n]+)/m);
      const currentName = currentNameMatch?.[1]?.trim();
      const aidLabel = aidName.split('.')[0];

      let agentDisplayName: string;
      if (currentName && currentName !== aidLabel) {
        // User or previous init set a custom name — keep it
        agentDisplayName = currentName;
      } else {
        agentDisplayName = `${ownerDisplayName}的Evol助手 (${aidLabel})`;
      }

      // Generate new agent.md with proper fields
      const newAgentMd = `---
aid: "${aid}"
name: "${agentDisplayName}"
type: "codeagent"
version: "1.0.0"
description: "EvolClaw AI Agent Gateway - 连接 Claude/Codex 到消息通道"
tags:
  - evolclaw
  - ai-agent
  - gateway
initialized: true
---

# ${agentDisplayName}

EvolClaw AI Agent 网关，支持多项目会话管理和多 AI 后端切换。
`;

      // Write locally
      fs.writeFileSync(agentMdPath, newAgentMd, 'utf-8');
      logger.info('[AUN] Updated agent.md with initialized=true');

      // Publish to AUN network via auth.uploadAgentMd
      try {
        await (this.client as any).auth.uploadAgentMd(newAgentMd);
        logger.info('[AUN] Published agent.md to AUN network');
      } catch (e) {
        logger.warn(`[AUN] Failed to publish agent.md: ${e}`);
      }

      // Send welcome message
      const welcomeText = `🎉 欢迎使用 EvolClaw！

我是您的 AI Agent 网关，已成功连接到 AUN 网络。

📋 **日常使用方法**：

1. **绑定项目**：发送 \`/bind <项目路径>\` 绑定工作目录
2. **查看帮助**：发送 \`/help\` 查看所有可用命令
3. **切换项目**：发送 \`/project <项目名>\` 切换到其他项目
4. **查看状态**：发送 \`/status\` 查看当前会话状态
5. **查看 Agent 信息**：发送 \`/agentmd\` 查看 agent.md 内容
6. **会话管理**：发送 \`/session\` 查看和切换会话

💡 **提示**：
- 直接发送消息即可与 Claude/Codex 对话
- 支持多项目会话管理，每个项目独立会话
- 所有命令以 \`/\` 开头

现在，请先使用 \`/bind\` 命令绑定您的项目目录，然后就可以开始工作了！`;

      await this.sendMessage(owner, welcomeText);
      logger.info(`[AUN] Welcome message sent to owner: ${owner}`);
    } catch (e) {
      logger.warn(`[AUN] Failed to send welcome message: ${e}`);
    }
  }

  // ── Event handlers ──────────────────────────────────────────

  private async downloadAttachment(
    att: { owner_aid?: string; object_key: string; filename?: string; sha256?: string },
    channelId: string
  ): Promise<string | null> {
    const ownerAid = att.owner_aid || this._aid || '';
    const objectKey = att.object_key;
    const filename = att.filename || objectKey.split('/').pop() || 'unknown';

    if (!objectKey) {
      logger.warn('[AUN] Attachment missing object_key, skipping');
      return null;
    }

    let downloadUrl: string;
    try {
      const ticket = await this.client!.call('storage.create_download_ticket', {
        owner_aid: ownerAid,
        object_key: objectKey,
      }) as Record<string, unknown>;
      downloadUrl = (ticket.download_url as string) || '';
      if (!downloadUrl) {
        logger.warn(`[AUN] No download_url for attachment: ${filename}`);
        return null;
      }
    } catch (e) {
      logger.warn(`[AUN] create_download_ticket failed for ${filename}: ${e}`);
      return null;
    }

    let buffer: Buffer;
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        logger.warn(`[AUN] Download failed for ${filename}: HTTP ${res.status}`);
        return null;
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      logger.warn(`[AUN] Download error for ${filename}: ${e}`);
      return null;
    }

    if (att.sha256) {
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== att.sha256) {
        logger.warn(`[AUN] SHA256 mismatch for ${filename}: expected ${att.sha256.slice(0, 8)}… got ${actual.slice(0, 8)}…`);
        return null;
      }
    }

    const projectPath = this.projectPathProvider
      ? await this.projectPathProvider(channelId)
      : process.cwd();

    try {
      const result = saveToUploads(buffer, filename, projectPath);
      logger.info(`[AUN] Saved attachment: ${result.filePath} (${result.size} bytes)`);
      return result.filePath;
    } catch (e) {
      logger.warn(`[AUN] saveToUploads failed for ${filename}: ${e}`);
      return null;
    }
  }

  private async handleIncomingPrivateMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const fromAid = msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload);
    const taskId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // 回声过滤：自己发出的消息会被 gateway fanout 回来，
    // 只有 from_aid == self 且 chat_id 不匹配时才丢弃（说明是其它实例发的）
    const msgChatId = typeof payload === 'object' && payload !== null && (payload as any).chat_id;
    if (this._aid && fromAid === this._aid && (!msgChatId || !this._chatId || msgChatId !== this._chatId)) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    // Detect @mentions
    const mentions: string[] = [];
    if (this._aid && text.includes(`@${this._aid}`)) {
      mentions.push(this._aid);
    }

    // Process attachments
    const rawAttachments: any[] = Array.isArray((payload as any)?.attachments)
      ? (payload as any).attachments
      : [];

    let finalText = text;
    if (rawAttachments.length > 0 && this.client) {
      const fileParts: string[] = [];
      for (const att of rawAttachments) {
        const filePath = await this.downloadAttachment(att, fromAid);
        if (filePath) {
          const name = sanitizeFileName(att.filename || att.object_key?.split('/').pop() || 'file');
          fileParts.push(`[文件: ${name} → ${filePath}]`);
        }
      }
      if (fileParts.length > 0) {
        const parts: string[] = [];
        if (text) parts.push(text);
        parts.push(...fileParts);
        parts.push('请使用 Read 工具读取文件内容。');
        finalText = parts.join('\n\n');
      }
    }

    // Extract chat_id from payload for multi-instance routing (falls back to fromAid)
    const chatId = (typeof payload === 'object' && payload !== null && (payload as any).chat_id)
      ? String((payload as any).chat_id)
      : fromAid;

    const peerInfo = await this.fetchPeerInfo(fromAid);
    const shortAid = this.getShortAid(fromAid);
    const displayName = peerInfo.name || shortAid;
    this.dispatchMessage({
      channelId: chatId,
      userId: fromAid,
      text: finalText,
      chatType: 'private',
      messageId,
      seq,
      taskId,
      mentions,
      peerName: displayName || undefined,
      peerType: peerInfo.type || 'unknown',
    });
  }

  private async handleIncomingGroupMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const groupId = msg.group_id ?? '';
    const senderAid = msg.sender_aid ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload);
    const taskId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
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

    const strippedText = this.stripSelfMentionIfOnly(text, this._aid);

    // Detect attachments before the empty-text guard
    const rawAttachments: any[] = Array.isArray((payload as any)?.attachments)
      ? (payload as any).attachments
      : [];
    const hasAttachments = rawAttachments.length > 0;

    // Allow through if there's text OR attachments; both-empty messages are silently dropped
    if (!strippedText && !hasAttachments) {
      this.acknowledgeImmediately(messageId, seq);
      return;
    }

    const mentions: string[] = mentionedAll ? ['all'] : (this._aid ? [this._aid] : []);

    // Process attachments
    let finalText = strippedText;
    if (hasAttachments && this.client) {
      const fileParts: string[] = [];
      for (const att of rawAttachments) {
        const filePath = await this.downloadAttachment(att, groupId);
        if (filePath) {
          const name = sanitizeFileName(att.filename || att.object_key?.split('/').pop() || 'file');
          fileParts.push(`[文件: ${name} → ${filePath}]`);
        }
      }
      if (fileParts.length > 0) {
        const parts: string[] = [];
        if (strippedText) parts.push(strippedText);
        parts.push(...fileParts);
        parts.push('请使用 Read 工具读取文件内容。');
        finalText = parts.join('\n\n');
      }
    }

    const peerInfo = await this.fetchPeerInfo(senderAid);
    const shortAid = this.getShortAid(senderAid);
    const displayName = peerInfo.name || shortAid;
    this.dispatchMessage({
      channelId: groupId,
      userId: senderAid,
      peerName: displayName || undefined,
      peerType: peerInfo.type || 'unknown',
      text: finalText,
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
    peerName?: string; peerType?: string;
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
      peerType: event.peerType,
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
      this.lastReconnectLogTime = 0;
      this.lastReconnectLogAttempt = 0;
      logger.info('[AUN] Connected');
    } else if (state === 'disconnected') {
      this.connected = false;
      logger.warn(`[AUN] Disconnected: ${(data as Record<string, any>).error ?? 'unknown'}`);
    } else if (state === 'reconnecting') {
      const attempt = (data as Record<string, any>).attempt ?? 0;
      const now = Date.now();

      // Throttled logging: first attempt, every N attempts, or every M seconds
      const isFirst = attempt <= 1;
      const isStep = attempt - this.lastReconnectLogAttempt >= AUNChannel.RECONNECT_LOG_STEP;
      const isInterval = now - this.lastReconnectLogTime >= AUNChannel.RECONNECT_LOG_INTERVAL;
      if (isFirst || isStep || isInterval) {
        const suppressed = attempt - this.lastReconnectLogAttempt - 1;
        const suffix = suppressed > 0 ? `, ${suppressed} suppressed since last log` : '';
        logger.info(`[AUN] SDK reconnecting (attempt ${attempt}${suffix})`);
        this.lastReconnectLogTime = now;
        this.lastReconnectLogAttempt = attempt;
        this.trace('IN', 'connection.state', data);
      }

      // Detect runaway SDK reconnect loop: force disconnect and use TS-layer backoff
      if (attempt >= AUNChannel.SDK_RECONNECT_GIVEUP && !this.intentionalDisconnect) {
        logger.warn(`[AUN] SDK reconnect stuck at attempt ${attempt}, forcing TS-layer reconnect with backoff`);
        this.connected = false;
        if (this.client) {
          this.client.close().catch(() => {});
          this.client = null;
        }
        this.scheduleReconnect();
      }
    } else if (state === 'terminal_failed') {
      this.connected = false;
      const reason = (data as Record<string, any>).reason ?? '';
      logger.error(`[AUN] Terminal failure: ${(data as Record<string, any>).error ?? 'unknown'}${reason ? ` (${reason})` : ''}`);
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    }
  }

  // ── Public API (same interface as before) ───────────────────

  onProjectPathRequest(provider: (channelId: string) => Promise<string>): void {
    this.projectPathProvider = provider;
  }

  onMessage(handler: AUNMessageHandler): void {
    this.messageHandler = handler;
  }

  onRecall(handler: (messageId: string) => void): void {
    this.recallHandler = handler;
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

    const payload: Record<string, any> = { type: 'text', text: finalText };
    if (context?.threadId) payload.thread_id = context.threadId;
    const params: Record<string, any> = { payload, encrypt: true };

    // Multi-instance routing: channelId may be "aid:device_id:slot_id"
    const colonIdx = channelId.indexOf(':');
    const targetAid = colonIdx > 0 ? channelId.substring(0, colonIdx) : channelId;
    if (colonIdx > 0) {
      params.payload.chat_id = channelId;
    }

    try {
      if (this.isGroupId(channelId)) {
        params.group_id = channelId;
        this.trace('OUT', 'group.send', params);
        await this.client.call('group.send', params);
      } else {
        params.to = targetAid;
        this.trace('OUT', 'message.send', params);
        await this.client.call('message.send', params);
      }
    } catch (e) {
      this.trace('OUT', 'send.error', { channelId, error: String(e) });
      logger.error(`[AUN] Send failed to ${channelId}: ${e}`);
    }
  }

  /**
   * 发送 thought 内容（Proactive 模式可观测）
   * 群聊：调用 group.thought.put
   * 单聊：调用 message.thought.put（协议命名推断，实际以服务端为准）
   */
  async sendThought(channelId: string, replyToMessageId: string, payload: object): Promise<void> {
    if (!this.connected || !this.client) return;
    if (!replyToMessageId) return;

    // Multi-instance routing
    const colonIdx = channelId.indexOf(':');
    const targetId = colonIdx > 0 ? channelId.substring(0, colonIdx) : channelId;

    const params: Record<string, any> = {
      reply_to: { message_id: replyToMessageId },
      payload,
      encrypt: true,
    };

    try {
      if (this.isGroupId(channelId)) {
        params.group_id = targetId;
        this.trace('OUT', 'group.thought.put', params);
        await this.client.call('group.thought.put', params);
      } else {
        params.to = targetId;
        this.trace('OUT', 'message.thought.put', params);
        await this.client.call('message.thought.put', params);
      }
    } catch (e) {
      this.trace('OUT', 'thought.put.error', { channelId, error: String(e) });
      logger.debug(`[AUN] thought.put failed to ${channelId}: ${e}`);
    }
  }

  async sendFile(channelId: string, filePath: string, context?: ReplyContext): Promise<void> {
    if (!this.connected || !this.client) {
      logger.warn('[AUN] Cannot sendFile: not connected');
      return;
    }

    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      logger.warn(`[AUN] sendFile: file not found: ${absPath}`);
      return;
    }
    const stat = fs.statSync(absPath);
    if (stat.size === 0) {
      logger.warn('[AUN] sendFile: file is empty');
      return;
    }
    if (stat.size > 10 * 1024 * 1024) {
      logger.warn(`[AUN] sendFile: file too large (${formatSize(stat.size)}, max 10 MB)`);
      return;
    }

    const filename = path.basename(absPath);
    const fileData = fs.readFileSync(absPath);
    const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');
    const contentType = guessMime(filename);
    const objectKey = `shared/${crypto.randomUUID()}/${filename}`;

    try {
      // Upload to storage
      if (stat.size <= 64 * 1024) {
        // Inline upload for small files (≤64KB)
        await this.client.call('storage.put_object', {
          object_key: objectKey,
          content: fileData.toString('base64'),
          content_type: contentType,
          is_private: false,
          overwrite: true,
        });
      } else {
        // Ticket upload for large files
        const session = await this.client.call('storage.create_upload_session', {
          object_key: objectKey,
          size_bytes: stat.size,
          content_type: contentType,
        }) as Record<string, unknown>;
        const uploadUrl = session.upload_url as string;
        if (!uploadUrl) throw new Error('No upload_url in session response');
        const uploadResp = await fetch(uploadUrl, { method: 'PUT', body: fileData });
        if (!uploadResp.ok) throw new Error(`HTTP upload failed: ${uploadResp.status}`);
        await this.client.call('storage.complete_upload', {
          object_key: objectKey,
          sha256,
          content_type: contentType,
          is_private: false,
          size_bytes: stat.size,
        });
      }

      // Send message with attachment
      const attachment = {
        owner_aid: this._aid || '',
        object_key: objectKey,
        filename,
        size_bytes: stat.size,
        sha256,
        content_type: contentType,
      };
      const filePayload: Record<string, any> = {
        type: 'file',
        text: `📎 ${filename} (${formatSize(stat.size)})`,
        attachments: [attachment],
      };
      if (context?.threadId) filePayload.thread_id = context.threadId;
      const params: Record<string, any> = { payload: filePayload, encrypt: true };

      // Multi-instance routing
      const fileColonIdx = channelId.indexOf(':');
      const fileTargetAid = fileColonIdx > 0 ? channelId.substring(0, fileColonIdx) : channelId;
      if (fileColonIdx > 0) {
        params.payload.chat_id = channelId;
      }

      if (this.isGroupId(channelId)) {
        params.group_id = channelId;
        this.trace('OUT', 'group.send.file', params);
        await this.client.call('group.send', params);
      } else {
        params.to = fileTargetAid;
        this.trace('OUT', 'message.send.file', params);
        await this.client.call('message.send', params);
      }
      logger.info(`[AUN] File sent: ${filename} (${formatSize(stat.size)}) → ${channelId}`);
    } catch (e) {
      this.trace('OUT', 'sendFile.error', { channelId, filePath, error: String(e) });
      logger.error(`[AUN] sendFile failed for ${channelId}: ${e}`);
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

    const eventMap: Record<string, string> = {
      start: 'task.started',
      done: 'task.completed',
      interrupted: 'task.interrupted',
      error: 'task.error',
      timeout: 'task.timeout',
    };
    const payload: Record<string, any> = {
      type: 'event',
      event: eventMap[status] ?? `task.${status}`,
      data: { session_id: sessionId },
      severity: status === 'error' || status === 'timeout' ? 'error' : 'info',
    };
    if (context?.threadId) payload.thread_id = context.threadId;

    const params: Record<string, any> = { payload, encrypt: true };

    // Multi-instance routing
    const statusColonIdx = channelId.indexOf(':');
    const statusTargetAid = statusColonIdx > 0 ? channelId.substring(0, statusColonIdx) : channelId;
    if (statusColonIdx > 0) {
      payload.chat_id = channelId;
    }

    if (this.isGroupId(channelId)) {
      params.group_id = channelId;
      this.trace('OUT', 'group.send.status', params);
      this.client.call('group.send', params).catch(e => {
        logger.debug(`[AUN] Processing status failed: ${e}`);
      });
    } else {
      params.to = statusTargetAid;
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

    // Multi-instance routing
    const customColonIdx = channelId.indexOf(':');
    const customTargetAid = customColonIdx > 0 ? channelId.substring(0, customColonIdx) : channelId;
    if (customColonIdx > 0) {
      payloadObj.chat_id = channelId;
    }

    const sendParams = {
      to: customTargetAid, payload: payloadObj,
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

  async fetchPeerInfo(aid: string): Promise<{ type: 'human' | 'ai' | null; name?: string }> {
    const cached = this.peerInfoCache.get(aid);
    if (cached !== undefined) return cached;
    if (!this.client) return { type: null };
    try {
      const md = await this.client.auth.downloadAgentMd(aid);
      const typeMatch = md.match(/^type:\s*["']?(\w+)["']?/m);
      const nameMatch = md.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const type: 'human' | 'ai' = typeMatch?.[1] === 'human' ? 'human' : 'ai';
      const name = nameMatch?.[1]?.trim() || undefined;
      const info = { type, name };
      this.peerInfoCache.set(aid, info);
      setTimeout(() => this.peerInfoCache.delete(aid), 30 * 60 * 1000);
      return info;
    } catch {
      return { type: null };  // no agent.md → unknown
    }
  }

  async uploadAgentMd(content: string): Promise<void> {
    if (!this.client) throw new Error('not connected');
    await this.client.auth.uploadAgentMd(content);
  }

  async downloadAgentMd(aid: string): Promise<string> {
    if (!this.client) throw new Error('not connected');
    return this.client.auth.downloadAgentMd(aid);
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
        gatewayUrl: inst.gatewayUrl,
        accessToken: inst.accessToken,
        flushDelay: inst.flushDelay,
        encryptionSeed: inst.encryptionSeed,
        owner: inst.owner,
        aunTrace: config.debug?.aunTrace,
      });

      const adapter = {
        channelName: inst.name,
        sendText: (id: string, text: string, context?: ReplyContext) => channel.sendMessage(id, text, context),
        sendFile: (id: string, filePath: string, context?: ReplyContext) => channel.sendFile(id, filePath, context),
        acknowledge: (messageId: string) => { channel.acknowledge(messageId); return Promise.resolve(); },
        sendProcessingStatus: (id: string, status: 'start' | 'done', sessionId: string, context?: ReplyContext) => channel.sendProcessingStatus(id, status, sessionId, context),
        sendCustomPayload: (id: string, payload: string) => channel.sendCustomPayload(id, payload),
        uploadAgentMd: (content: string) => channel.uploadAgentMd(content),
        downloadAgentMd: (aid: string) => channel.downloadAgentMd(aid),
        putThought: (id: string, replyToMessageId: string, payload: object) =>
          channel.sendThought(id, replyToMessageId, payload),
        _selfAid: () => channel.getStatus().aid,
      };

      const policy = {
        canSwitchProject: (chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        canListProjects: (chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        canCreateSession: (chatType: string, identity: string) => true,
        canDeleteSession: (chatType: string, identity: string) => true,
        canImportCliSession: (chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
        showMiddleResult: (chatType: string, identity: string) => {
          const mode = getChannelShowActivities(config, inst.name);
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        showIdleMonitor: (chatType: string, identity: string) => {
          const mode = getChannelShowActivities(config, inst.name);
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
        sessionMode: inst.sessionMode,
      };

      result.push({
        channelType: 'aun',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: (channelId: string) =>
          Promise.resolve(config.projects?.defaultPath || process.cwd()),
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
