import { AUNClient, FileSecretStore, GatewayDiscovery, E2EEError, type JsonObject } from '@agentunion/fastaun';
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
  aunSdkLog?: boolean;    // 启用 AUN SDK 内部日志（写入 ~/.aun/logs/ts-sdk-YYYYMMDD.log）
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
  private traceHourTag: string = '';  // 当前 trace 文件对应的小时标识 (YYYYMMDD-HH)

  private trace(dir: 'IN' | 'OUT', event: string, data: unknown): void {
    if (!this.config.aunTrace) return;
    this.rotateTraceIfNeeded();
    if (!this.traceStream) return;

    // 自动从 data 推断顶层字段（self_aid / peer_aid / group_id / task_id / chatmode），
    // 便于 jq 过滤：`jq 'select(.task_id == "task-xxx")'`
    const d = (data && typeof data === 'object') ? data as any : {};
    const payload = d.payload ?? {};
    const topContext: Record<string, any> = {
      self_aid: this._aid ?? this.config.aid,
    };
    // peer / group 识别
    const peerAid = d.to ?? d.from ?? d.sender_aid ?? payload.to;
    if (peerAid) topContext.peer_aid = peerAid;
    const groupId = d.group_id ?? payload.group_id;
    if (groupId) topContext.group_id = groupId;
    // task_id / chatmode（message.send / thought.put / status 都可能有）
    const taskId = payload.task_id ?? d.context?.id ?? d.data?.task_id;
    if (taskId) topContext.task_id = taskId;
    const chatmode = payload.chatmode;
    if (chatmode) topContext.chatmode = chatmode;

    const line = JSON.stringify({ ts: localTimestamp(), dir, event, ...topContext, data });
    this.traceStream.write(line + '\n');
  }

  /** 日志前缀（含 self aid 简称，多实例可识别） */
  private logPrefix(): string {
    const aid = this._aid ?? this.config.aid;
    if (!aid) return '[AUN]';
    const short = aid.split('.')[0] || aid;
    return `[AUN ${short}]`;
  }

  /**
   * 统一的 RPC 调用包装：自动记录 OUT 发送、.ok 结果、.error 错误（含 trace + evolclaw.log 失败日志）。
   * 所有 client.call() 都应通过此方法调用，保证 aun-trace 里每个 OUT 调用都有"发+收/错"成对记录。
   */
  private async callAndTrace<T = any>(method: string, params: Record<string, any>, opts?: { silentOk?: boolean }): Promise<T> {
    this.trace('OUT', method, params);
    // [DIAG-STALE] 记录调用瞬间 SDK 内部 _state，证明是否在 reconnecting 中误发
    const sdkStateBefore = (this.client as any)?._state ?? 'no-client';
    if (sdkStateBefore !== 'connected') {
      logger.warn(`[AUN][DIAG-STALE] callAndTrace ${method} on non-connected SDK: sdk_state=${sdkStateBefore} evolclaw_connected=${this.connected}`);
    }
    try {
      const result = await this.client!.call(method, params);
      if (!opts?.silentOk) {
        const r = result as any;
        const snap = r && typeof r === 'object'
          ? { message_id: r.message_id, ok: r.ok, thought_id: r.thought_id }
          : undefined;
        this.trace('OUT', `${method}.ok`, snap ?? {});
      }
      return result as T;
    } catch (e: any) {
      this.trace('OUT', `${method}.error`, {
        error: e?.message ?? String(e),
        code: e?.code,
        name: e?.name,
      });
      // [DIAG-STALE] 失败时再记录一次 SDK _state，看错误类型是否为 ConnectionError
      const sdkStateAfter = (this.client as any)?._state ?? 'no-client';
      logger.warn(`[AUN][DIAG-STALE] callAndTrace ${method} FAILED: err_name=${e?.name ?? '?'} err_code=${e?.code ?? '?'} sdk_state_before=${sdkStateBefore} sdk_state_after=${sdkStateAfter} evolclaw_connected=${this.connected}`);
      logger.warn(`${this.logPrefix()} rpc ${method} failed: ${e?.name ?? ''}(${e?.code ?? ''}) ${e?.message ?? e}`);
      throw e;
    }
  }

  private static readonly AUN_TRACE_RE = /^aun-\d{8}-\d{2}\.log$/;
  private static readonly AUN_RETAIN_HOURS = 12;

  private rotateTraceIfNeeded(): void {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hourTag = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}`;
    if (this.traceHourTag === hourTag && this.traceStream) return;
    if (this.traceStream) {
      this.traceStream.end();
      this.traceStream = null;
    }
    this.traceHourTag = hourTag;
    const logPath = path.join(resolvePaths().logs, `aun-${hourTag}.log`);
    this.traceStream = fs.createWriteStream(logPath, { flags: 'a' });
    this.cleanupOldTraceLogs();
  }

  private cleanupOldTraceLogs(): void {
    const logsDir = resolvePaths().logs;
    const cutoff = Date.now() - AUNChannel.AUN_RETAIN_HOURS * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(logsDir)) {
        if (!AUNChannel.AUN_TRACE_RE.test(name)) continue;
        try {
          const full = path.join(logsDir, name);
          if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        } catch {}
      }
    } catch {}
  }

  /** 判断 channelId 是否为群组 ID
   *  - 新格式：group.{issuer}/{group_no|group_name}
   *  - 数字群号：{group_no}.{issuer}（如 11117.agentid.pub）
   *  - 兼容旧格式：grp_xxx、g-xxx.agentid.pub
   */
  private isGroupId(id: string): boolean {
    return (id.startsWith('group.') && id.includes('/'))
      || /^\d+\./.test(id)
      || id.startsWith('grp_')
      || (id.startsWith('g-') && id.includes('.'));
  }

  private getShortAid(aid?: string): string | undefined {
    if (!aid) return undefined;
    const trimmed = aid.trim();
    if (!trimmed) return undefined;
    return trimmed.split('.')[0] || trimmed;
  }

  /** 同步获取对端显示名（仅从缓存，不触发网络请求）。用于日志中补充对端标识。
   *  返回 `shortAid(displayName)` 或 `shortAid`，若 aid 为空返回 '?'
   */
  private peerLabel(aid?: string): string {
    if (!aid) return '?';
    const bareAid = aid.includes(':') ? aid.substring(0, aid.indexOf(':')) : aid;
    const short = this.getShortAid(bareAid) ?? bareAid;
    const cached = this.peerInfoCache.get(bareAid);
    const name = cached?.name;
    return name && name !== short ? `${short}(${name})` : short;
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

  private extractMentionAids(mentions: unknown[]): string[] {
    const aids: string[] = [];
    for (const m of mentions) {
      if (typeof m === 'string') aids.push(m);
      else if (m && typeof m === 'object' && typeof (m as any).aid === 'string') aids.push((m as any).aid);
    }
    return aids;
  }

  private hasMentionAll(mentions: unknown[]): boolean {
    for (const m of mentions) {
      if (m === 'all') return true;
      if (m && typeof m === 'object' && (m as any).scope === 'all') return true;
    }
    return false;
  }

  /** 从正文提取 @aid（AID 格式：至少三段域名），用于出站填充 payload.mentions */
  private static readonly MENTION_AID_RE = /@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?){2,})/g;
  private extractMentionAidsFromText(text: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(AUNChannel.MENTION_AID_RE)) {
      const aid = m[1];
      if (!seen.has(aid)) { seen.add(aid); out.push(aid); }
    }
    return out;
  }

  private buildGroupReplyContext(taskId: string | undefined, senderAid: string, encrypted: boolean): ReplyContext {
    const replyContext: ReplyContext = { metadata: { encrypted } };
    if (taskId) replyContext.threadId = taskId;
    replyContext.peerId = senderAid;
    return replyContext;
  }

  private acknowledgeImmediately(messageId: string | undefined, seq?: number): void {
    if (seq != null && this.client) {
      this.client.call('message.ack', { seq }).catch(e => {
        logger.debug(`${this.logPrefix()} Immediate ack failed: ${e}`);
      });
    }
    if (messageId) this.messageSeqMap.delete(messageId);
  }

  private shouldEncrypt(peerId: string): boolean {
    const cached = this.peerE2ee.get(peerId);
    if (!cached) return true;
    if (Date.now() - cached.ts > AUNChannel.E2EE_PROBE_TTL) {
      this.peerE2ee.delete(peerId);
      return true;
    }
    return cached.ok;
  }
  private _aid?: string;
  private _selfName?: string;  // 本地 agent.md 中的 name，首次 connect 时读取
  private _chatId = '';  // aid:device_id:slot_id — 多实例回声过滤
  private seenMessages = new Map<string, number>();
  private peerInfoCache = new Map<string, { type: 'human' | 'ai'; name?: string }>();
  private messageSeqMap = new Map<string, number>();  // messageId → seq (for ack)
  private sentCount = new Map<string, number>();  // channelId → 已发消息计数（用于判断最终回复）
  private peerE2ee = new Map<string, { ok: boolean; ts: number }>();
  private static readonly E2EE_PROBE_TTL = 10 * 60 * 1000; // 10min
  private plaintextRecv = 0;
  private sessionModeResolver?: (channelId: string) => Promise<string | undefined>;

  private static readonly PROACTIVE_ALLOW_TYPES = new Set([
    'text', 'quote', 'image', 'video', 'voice', 'file', 'json',
    'merge', 'link', 'location', 'personal_card',
  ]);

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
      logger.info(`${this.logPrefix()} Trace logging enabled (hourly rotation, 12h retention): ${resolvePaths().logs}/aun-YYYYMMDD-HH.log`);
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
      this.trace('OUT', 'client.close', { reason: 'initClient' });
      try {
        await this.client.close();
        this.trace('OUT', 'client.close.ok', { reason: 'initClient' });
      } catch (e) {
        this.trace('OUT', 'client.close.error', { reason: 'initClient', error: String(e) });
      }
      this.client = null;
    }
    this.connected = false;

    const aunPath = this.config.keystorePath || path.join(os.homedir(), '.aun');
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
        logger.info(`${this.logPrefix()} Gateway discovered: ${gateway}`);
      } catch (e) {
        logger.warn(`${this.logPrefix()} Well-known discovery failed (${e}), no fallback available`);
      }
    }

    if (!gateway) {
      logger.error(`${this.logPrefix()} Cannot resolve gateway URL from AID`);
      throw new Error('Cannot resolve gateway URL from AID');
    }

    logger.info(`${this.logPrefix()} Initializing: aid=${aidName}, gateway=${gateway}, aun_path=${aunPath}`);

    // Create client with FileSecretStore (AES-256-GCM)
    // 不传 encryption_seed 时，SDK 自动从 {aun_path}/.seed 文件派生密钥（与 aun_cli.py 对齐）
    const rootCaPath = path.join(aunPath, 'CA', 'root', 'root.crt');
    this.client = new AUNClient({
      aun_path: aunPath,
      root_ca_path: rootCaPath,
      ...(encryptionSeed && { encryption_seed: encryptionSeed }),
    }, this.config.aunSdkLog ?? true);
    // Set gateway URL (internal property, same as Python SDK)
    (this.client as any)._gatewayUrl = gateway;

    // Register event handlers before connecting
    this.client.on('message.received', (data: unknown) => {
      this.trace('IN', 'message.received', data);
      const kind = (data && typeof data === 'object') ? (data as any).kind ?? '' : '';
      const keys = (data && typeof data === 'object') ? Object.keys(data as any).join(',') : typeof data;
      logger.debug(`${this.logPrefix()}[DIAG] message.received: kind=${kind} keys=${keys}`);
      this.handleIncomingPrivateMessage(data);
    });
    this.client.on('group.message_created', (data: unknown) => {
      this.trace('IN', 'group.message_created', data);
      const gid = (data && typeof data === 'object') ? (data as any).group_id ?? '' : '';
      const sender = (data && typeof data === 'object') ? (data as any).sender_aid ?? '' : '';
      logger.debug(`${this.logPrefix()}[DIAG] group.message_created: group_id=${gid} sender=${sender}`);
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
              logger.info(`${this.logPrefix()} Message recalled: ${id}`);
              this.recallHandler?.(id);
            }
          }
        }
      }
    });
    this.client.on('message.undecryptable', (data: unknown) => {
      this.trace('IN', 'message.undecryptable', data);
      const d = data as Record<string, any>;
      logger.warn(`${this.logPrefix()} Message undecryptable: from=${d.from} mid=${d.message_id} err=${d._decrypt_error}`);
    });
    this.client.on('group.message_undecryptable', (data: unknown) => {
      this.trace('IN', 'group.message_undecryptable', data);
      const d = data as Record<string, any>;
      logger.warn(`${this.logPrefix()} Group message undecryptable: group=${d.group_id} from=${d.from} mid=${d.message_id} err=${d._decrypt_error}`);
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
      logger.info(`${this.logPrefix()} Authenticating as ${aidName}...`);
      this.trace('OUT', 'auth.authenticate', { aid: aidName });
      const auth = await this.client.auth.authenticate(aidName ? { aid: aidName } : undefined);
      this.trace('OUT', 'auth.authenticate.ok', { aid: auth.aid, gateway: auth.gateway, hasToken: !!auth.access_token });
      this.trace('IN', 'auth.result', { aid: auth.aid, gateway: auth.gateway, hasToken: !!auth.access_token });
      accessToken = auth.access_token as string;
      const resolvedGateway = (auth.gateway as string) || gateway;
      (this.client as any)._gatewayUrl = resolvedGateway;
      logger.info(`${this.logPrefix()} Authenticated as ${auth.aid ?? '?'}, gateway=${resolvedGateway}`);
    } catch (e: any) {
      const errMsg = e.message || String(e);
      const errName = e.constructor?.name || 'Error';
      this.trace('OUT', 'auth.authenticate.error', { error: errMsg, name: errName });
      logger.error(`${this.logPrefix()} Authentication failed (${errName}): ${errMsg}`);
      if (e.stack) logger.debug(`${this.logPrefix()} Auth stack: ${e.stack}`);
      // Fallback: try direct token from env/config (legacy)
      accessToken = this.config.accessToken || process.env.AUN_ACCESS_TOKEN || '';
      if (!accessToken) {
        logger.error(`${this.logPrefix()} No accessToken fallback available, scheduling retry`);
        this.scheduleReconnect();
        throw new Error('Authentication failed and no accessToken fallback available');
      }
      logger.warn(`${this.logPrefix()} Using accessToken fallback`);
    }

    // Connect (SDK auto_reconnect handles transient failures)
    try {
      this.trace('OUT', 'client.connect', { gateway: (this.client as any)._gatewayUrl });
      await this.client.connect(
        { access_token: accessToken, gateway: (this.client as any)._gatewayUrl },
        { auto_reconnect: true, retry: { max_attempts: 5, initial_delay: 1.0, max_delay: 30.0 } },
      );
      this.trace('OUT', 'client.connect.ok', { aid: this.client.aid });
      this._aid = this.client.aid ?? undefined;
      const deviceId = (this.client as any)._device_id ?? '';
      this._chatId = this._aid ? `${this._aid}:${deviceId}:` : '';
      this._selfName = this.loadSelfName(aidName);
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
          logger.info(`${this.logPrefix()} Backfilled identity.cert from keystore for e2ee fingerprint`);
        }
      }

      logger.info(`${this.logPrefix()} Connected as ${this._aid}`);

      // Send welcome message to owner after first connection
      await this.sendWelcomeMessage();
    } catch (e) {
      this.trace('OUT', 'client.connect.error', { error: String(e) });
      logger.error(`${this.logPrefix()} Connection failed: ${e}`);
      this.scheduleReconnect();
      throw e;
    }
  }

  private async sendWelcomeMessage(): Promise<void> {
    try {
      const owner = this.config.owner;
      if (!owner) {
        logger.info(`${this.logPrefix()} No owner configured, skipping welcome message`);
        return;
      }

      // Check agent.md initialized field
      const aid = this.config.aid;
      const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
      const agentMdPath = path.join(os.homedir(), '.aun', 'AIDs', aidName, 'agent.md');

      if (!fs.existsSync(agentMdPath)) {
        logger.warn(`${this.logPrefix()} agent.md not found, skipping welcome message`);
        return;
      }

      const agentMdContent = fs.readFileSync(agentMdPath, 'utf-8');
      const match = agentMdContent.match(/^---\n([\s\S]*?)\n---/);
      if (!match) {
        logger.warn(`${this.logPrefix()} agent.md frontmatter not found`);
        return;
      }

      const frontmatter = match[1];
      const initializedMatch = frontmatter.match(/^initialized:\s*(true|false)/m);
      if (!initializedMatch || initializedMatch[1] === 'true') {
        logger.info(`${this.logPrefix()} Agent already initialized, skipping welcome message`);
        return;
      }

      // Fetch owner's agent.md to derive name and validate type
      const ownerInfo = await this.fetchPeerInfo(owner);
      if (ownerInfo.type !== null && ownerInfo.type !== 'human') {
        logger.warn(`${this.logPrefix()} Owner ${owner} type is "${ownerInfo.type}" (not human). Consider using a human AID as owner.`);
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
      logger.info(`${this.logPrefix()} Updated agent.md with initialized=true`);

      // Publish to AUN network via auth.uploadAgentMd
      try {
        await (this.client as any).auth.uploadAgentMd(newAgentMd);
        logger.info(`${this.logPrefix()} Published agent.md to AUN network`);
      } catch (e) {
        logger.warn(`${this.logPrefix()} Failed to publish agent.md: ${e}`);
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

      // First contact with Owner races against Owner's async cert fetch from
      // gateway PKI; a 3s pause lets the cert propagate. persist_required asks
      // the gateway to durably store the message so Owner can recover it via
      // pull if the initial E2EE push still arrives before the cert resolves.
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (!this.client) {
        logger.warn(`${this.logPrefix()} Client disconnected before welcome message could be sent`);
        return;
      }
      await this.callAndTrace('message.send', {
        to: owner,
        payload: { type: 'text', text: welcomeText },
        encrypt: true,
        persist_required: true,
      });
      logger.info(`${this.logPrefix()} Welcome message sent to owner: ${owner}`);
    } catch (e) {
      logger.warn(`${this.logPrefix()} Failed to send welcome message: ${e}`);
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
      logger.warn(`${this.logPrefix()} Attachment missing object_key, skipping`);
      return null;
    }

    let downloadUrl: string;
    try {
      const ticket = await this.callAndTrace<Record<string, unknown>>('storage.create_download_ticket', {
        owner_aid: ownerAid,
        object_key: objectKey,
      });
      downloadUrl = (ticket.download_url as string) || '';
      if (!downloadUrl) {
        logger.warn(`${this.logPrefix()} No download_url for attachment: ${filename}`);
        return null;
      }
    } catch (e) {
      logger.warn(`${this.logPrefix()} create_download_ticket failed for ${filename}: ${e}`);
      return null;
    }

    let buffer: Buffer;
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        logger.warn(`${this.logPrefix()} Download failed for ${filename}: HTTP ${res.status}`);
        return null;
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      logger.warn(`${this.logPrefix()} Download error for ${filename}: ${e}`);
      return null;
    }

    if (att.sha256) {
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== att.sha256) {
        logger.warn(`${this.logPrefix()} SHA256 mismatch for ${filename}: expected ${att.sha256.slice(0, 8)}… got ${actual.slice(0, 8)}…`);
        return null;
      }
    }

    const projectPath = this.projectPathProvider
      ? await this.projectPathProvider(channelId)
      : process.cwd();

    try {
      const result = saveToUploads(buffer, filename, projectPath);
      logger.info(`${this.logPrefix()} Saved attachment: ${result.filePath} (${result.size} bytes)`);
      return result.filePath;
    } catch (e) {
      logger.warn(`${this.logPrefix()} saveToUploads failed for ${filename}: ${e}`);
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
      logger.debug(`${this.logPrefix()} P2P dropped: echo from self (from=${fromAid} mid=${messageId})`);
      return;
    }

    // 记录入站消息加密状态，透传到出站 ReplyContext
    const msgEncrypted = !!(msg.e2ee);
    if (!msgEncrypted) this.plaintextRecv++;

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

    // 详细 dispatch 决策日志：记录消息为何被路由到 agent
    const p2pPayloadType = (payload && typeof payload === 'object') ? (payload as any).type ?? '' : '';
    logger.info(`${this.logPrefix()} P2P dispatch decision: mid=${messageId} from=${shortAid}(${displayName}) peerType=${peerInfo.type || 'unknown'} payloadType=${p2pPayloadType} chatId=${chatId} encrypt=${msgEncrypted} textPreview=${JSON.stringify(text.slice(0, 80))}`);

    logger.info(`${this.logPrefix()} P2P dispatched: from=${shortAid}(${displayName}) mid=${messageId} encrypt=${msgEncrypted} text=${finalText.slice(0, 60)}`);
    const replyContext: ReplyContext = { metadata: { encrypted: msgEncrypted } };
    if (taskId) replyContext.threadId = taskId;
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
      replyContext,
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

    logger.debug(`${this.logPrefix()}[DIAG-GRP] full_msg=${JSON.stringify(msg).substring(0, 500)}`);

    if (!groupId || !senderAid) {
      this.acknowledgeImmediately(messageId, seq);
      logger.debug(`${this.logPrefix()} Group dropped: missing groupId or senderAid (mid=${messageId})`);
      return;
    }

    if (this._aid && senderAid === this._aid) {
      this.acknowledgeImmediately(messageId, seq);
      logger.debug(`${this.logPrefix()} Group dropped: own message (group=${groupId} mid=${messageId})`);
      return;
    }

    // ── proactive 模式入站白名单 ──
    if (this.sessionModeResolver) {
      const sessionMode = await this.sessionModeResolver(groupId).catch(() => undefined);
      if (sessionMode === 'proactive') {
        const payloadObj = (payload && typeof payload === 'object') ? payload as Record<string, any> : null;
        const payloadType: string = payloadObj?.type ?? '';

        if (!AUNChannel.PROACTIVE_ALLOW_TYPES.has(payloadType)) {
          this.acknowledgeImmediately(messageId, seq);
          logger.info(`${this.logPrefix()} Group dropped (proactive deny): type=${payloadType} group=${groupId} sender=${senderAid} mid=${messageId}`);
          return;
        }

        const rawText: string = typeof payloadObj?.text === 'string' ? payloadObj.text : '';
        const rawMentions: unknown[] = Array.isArray(payloadObj?.mentions) ? payloadObj.mentions : [];

        const mentionAids = this.extractMentionAids(rawMentions);
        const mentionsSelf = !!this._aid && (
          this.hasExplicitMention(rawText, this._aid) || mentionAids.includes(this._aid)
        );
        // @all 仅认结构化 mentions（payload.mentions），不扫描正文 — 避免引述性 "@all" 误判
        const mentionsAll = this.hasMentionAll(rawMentions);

        if (!mentionsSelf && !mentionsAll) {
          this.acknowledgeImmediately(messageId, seq);
          logger.info(`${this.logPrefix()} Group dropped (proactive whitelist): type=${payloadType} group=${groupId} sender=${senderAid} mid=${messageId} textPreview=${JSON.stringify(rawText.slice(0, 80))}`);
          return;
        }
      }
    }

    // 记录入站消息加密状态，透传到出站 ReplyContext
    const msgEncrypted = !!(msg.e2ee);
    if (!msgEncrypted) this.plaintextRecv++;

    // dispatch_mode from server tells agent how to work in this group
    const dispatchMode: string = msg.dispatch_mode ?? (payload as any)?.dispatch_mode ?? 'mention';

    const mentionedSelf = this._aid
      ? (this.hasExplicitMention(text, this._aid) || payloadMentions.includes(this._aid))
      : false;
    // @all 仅认结构化 mentions（payload.mentions），不扫描正文 — 避免引述性 "@all" 误判
    const mentionedAll = payloadMentions.includes('all');

    // In mention mode, only respond when explicitly mentioned; in broadcast mode, respond to all
    if (dispatchMode === 'mention' && !mentionedSelf && !mentionedAll) {
      this.acknowledgeImmediately(messageId, seq);
      logger.info(`${this.logPrefix()} Group dropped: unmentioned in mention-mode (group=${groupId} sender=${senderAid} mid=${messageId} textPreview=${JSON.stringify(text.slice(0, 80))})`);
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
      logger.debug(`${this.logPrefix()} Group dropped: empty text and no attachments (group=${groupId} sender=${senderAid} mid=${messageId})`);
      return;
    }

    const mentions: string[] = mentionedAll
      ? ['all']
      : mentionedSelf && this._aid ? [this._aid] : [];

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

    // 详细 dispatch 决策日志：记录消息为何被路由到 agent
    const payloadType = (payload && typeof payload === 'object') ? (payload as any).type ?? '' : '';
    const textMentionSelf = this._aid ? this.hasExplicitMention(text, this._aid) : false;
    const textMentionAll = this.hasExplicitMention(text, 'all');
    const structMentionSelf = this._aid ? payloadMentions.includes(this._aid) : false;
    const structMentionAll = payloadMentions.includes('all');
    const reason = mentionedAll
      ? 'mention.all(struct)'
      : mentionedSelf
        ? (structMentionSelf ? 'mention.self(struct)' : 'mention.self(text)')
        : `${dispatchMode}.no-mention`;
    logger.info(`${this.logPrefix()} Group dispatch decision: mid=${messageId} group=${groupId} sender=${shortAid}(${displayName}) peerType=${peerInfo.type || 'unknown'} payloadType=${payloadType} dispatchMode=${dispatchMode} reason=${reason} structMentions=${JSON.stringify(payloadMentions)} textMentionSelf=${textMentionSelf} textMentionAll=${textMentionAll} structMentionSelf=${structMentionSelf} structMentionAll=${structMentionAll} encrypt=${msgEncrypted} textPreview=${JSON.stringify(text.slice(0, 80))}`);

    logger.info(`${this.logPrefix()} Group dispatched: group=${groupId} sender=${shortAid}(${displayName}) mode=${dispatchMode} mid=${messageId} text=${finalText.slice(0, 60)}`);
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
      replyContext: this.buildGroupReplyContext(taskId, senderAid, msgEncrypted),
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
      logger.error(`${this.logPrefix()} Message handler error:`, err);
    });
  }

  private handleConnectionState(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const state = (data as Record<string, any>).state ?? '';

    // [DIAG-STALE] 记录状态切换瞬间 evolclaw 的 connected 标志和 SDK 的内部 _state，
    // 用于证明"reconnecting 时 connected 保持 true，导致 sendMessage 误放行"的假设
    const sdkState = (this.client as any)?._state ?? 'no-client';
    const connectedBefore = this.connected;
    logger.info(`[AUN][DIAG-STALE] connection.state event: state=${state} attempt=${(data as any).attempt ?? '-'} | connected_before=${connectedBefore} sdk_state=${sdkState}`);

    if (state === 'connected') {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastReconnectLogTime = 0;
      this.lastReconnectLogAttempt = 0;
      this.trace('IN', 'connection.state', data);
      logger.info(`${this.logPrefix()} Connected`);
    } else if (state === 'disconnected') {
      this.connected = false;
      this.trace('IN', 'connection.state', data);
      logger.warn(`${this.logPrefix()} Disconnected: ${(data as Record<string, any>).error ?? 'unknown'}`);
    } else if (state === 'reconnecting') {
      this.connected = false;
      const attempt = (data as Record<string, any>).attempt ?? 0;
      const now = Date.now();

      // Throttled logging: first attempt, every N attempts, or every M seconds
      const isFirst = attempt <= 1;
      const isStep = attempt - this.lastReconnectLogAttempt >= AUNChannel.RECONNECT_LOG_STEP;
      const isInterval = now - this.lastReconnectLogTime >= AUNChannel.RECONNECT_LOG_INTERVAL;
      if (isFirst || isStep || isInterval) {
        const suppressed = attempt - this.lastReconnectLogAttempt - 1;
        const suffix = suppressed > 0 ? `, ${suppressed} suppressed since last log` : '';
        logger.info(`${this.logPrefix()} SDK reconnecting (attempt ${attempt}${suffix})`);
        this.lastReconnectLogTime = now;
        this.lastReconnectLogAttempt = attempt;
        this.trace('IN', 'connection.state', data);
      }

      // Detect runaway SDK reconnect loop: force disconnect and use TS-layer backoff
      if (attempt >= AUNChannel.SDK_RECONNECT_GIVEUP && !this.intentionalDisconnect) {
        logger.warn(`${this.logPrefix()} SDK reconnect stuck at attempt ${attempt}, forcing TS-layer reconnect with backoff`);
        this.connected = false;
        if (this.client) {
          this.trace('OUT', 'client.close', { reason: 'sdk_reconnect_stuck' });
          this.client.close().catch(() => {});
          this.client = null;
        }
        this.scheduleReconnect();
      }
    } else if (state === 'terminal_failed') {
      this.connected = false;
      this.trace('IN', 'connection.state', data);
      const reason = (data as Record<string, any>).reason ?? '';
      logger.error(`${this.logPrefix()} Terminal failure: ${(data as Record<string, any>).error ?? 'unknown'}${reason ? ` (${reason})` : ''}`);
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

  setSessionModeResolver(resolver: (channelId: string) => Promise<string | undefined>): void {
    this.sessionModeResolver = resolver;
  }

  onRecall(handler: (messageId: string) => void): void {
    this.recallHandler = handler;
  }

  async sendMessage(channelId: string, text: string, context?: ReplyContext): Promise<void> {
    // [DIAG-STALE] 进入 sendMessage 时记录 evolclaw connected 标志和 SDK _state，
    // 用于检测两者是否一致：若 connected=true 但 sdk_state != 'connected'，即为 stale 状态
    const sdkStateOnEntry = (this.client as any)?._state ?? 'no-client';
    if (this.connected !== (sdkStateOnEntry === 'connected')) {
      logger.warn(`[AUN][DIAG-STALE] sendMessage entry MISMATCH: connected=${this.connected} sdk_state=${sdkStateOnEntry} channel=${channelId} text=${text.slice(0, 40)}`);
    } else {
      logger.debug(`[AUN][DIAG-STALE] sendMessage entry: connected=${this.connected} sdk_state=${sdkStateOnEntry} channel=${channelId}`);
    }

    if (!this.connected || !this.client) {
      logger.warn(`${this.logPrefix()} Cannot send: not connected`);
      return;
    }

    if (!text?.trim()) {
      logger.warn(`${this.logPrefix()} Attempted to send empty message, skipping`);
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
    // 出站群消息：从正文提取 @aid 填入结构化 mentions（与 aun CLI 对齐，方便对端按 mentions 过滤）
    if (this.isGroupId(channelId)) {
      const extracted = this.extractMentionAidsFromText(finalText);
      if (extracted.length > 0) payload.mentions = extracted;
    }
    if (context?.threadId) payload.thread_id = context.threadId;
    if (context?.metadata?.taskId) payload.task_id = context.metadata.taskId;
    if (context?.metadata?.chatmode) payload.chatmode = context.metadata.chatmode;
    const isGroup = this.isGroupId(channelId);

    // Multi-instance routing: channelId may be "aid:device_id:slot_id"
    const colonIdx = channelId.indexOf(':');
    const targetAid = colonIdx > 0 ? channelId.substring(0, colonIdx) : channelId;
    if (colonIdx > 0) {
      payload.chat_id = channelId;
    }

    const encryptTarget = isGroup ? channelId : targetAid;
    const encrypt = context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(encryptTarget);
    const params: Record<string, any> = { payload, encrypt };

    try {
      if (isGroup) {
        params.group_id = channelId;
        const result = await this.callAndTrace<any>('group.send', params);
        if (!result || !result.message_id) {
          const dispatchStatus = result?.message_dispatch?.status;
          if (dispatchStatus === 'debounced' || dispatchStatus === 'dispatched') {
            logger.info(`${this.logPrefix()} group.send ok (${dispatchStatus}): group=${channelId} encrypt=${encrypt} text=${finalText.slice(0, 60)}`);
          } else {
            logger.warn(`${this.logPrefix()} group.send returned no message_id: ${JSON.stringify(result)}`);
          }
        } else {
          logger.info(`${this.logPrefix()} group.send ok: group=${channelId} mid=${result.message_id} encrypt=${encrypt} text=${finalText.slice(0, 60)}`);
        }
      } else {
        params.to = targetAid;
        const result = await this.callAndTrace<any>('message.send', params);
        if (!result || !result.message_id) {
          logger.warn(`${this.logPrefix()} message.send returned no message_id: ${JSON.stringify(result)}`);
        } else {
          logger.info(`${this.logPrefix()} message.send ok: to=${this.peerLabel(targetAid)} mid=${result.message_id} encrypt=${encrypt} text=${finalText.slice(0, 60)}`);
        }
      }
    } catch (e) {
      if (encrypt && e instanceof E2EEError) {
        this.peerE2ee.set(encryptTarget, { ok: false, ts: Date.now() });
        logger.warn(`${this.logPrefix()} E2EE send failed to ${channelId}, retrying plaintext: ${e}`);
        params.encrypt = false;
        try {
          if (isGroup) {
            this.trace('OUT', 'group.send.fallback', params);
            const result = await this.client.call('group.send', params);
            this.trace('OUT', 'group.send.fallback.ok', { message_id: (result as any)?.message_id });
            if (!result || !(result as any).message_id) {
              logger.warn(`${this.logPrefix()} group.send fallback returned no message_id: ${JSON.stringify(result)}`);
            }
          } else {
            this.trace('OUT', 'message.send.fallback', params);
            const result = await this.client.call('message.send', params);
            this.trace('OUT', 'message.send.fallback.ok', { message_id: (result as any)?.message_id });
            if (!result || !(result as any).message_id) {
              logger.warn(`${this.logPrefix()} message.send fallback returned no message_id: ${JSON.stringify(result)}`);
            }
          }
        } catch (e2) {
          this.trace('OUT', 'send.fallback.error', { channelId, error: String(e2) });
          logger.error(`${this.logPrefix()} Plaintext fallback also failed to ${channelId}: ${e2}`);
        }
      } else {
        this.trace('OUT', 'send.error', { channelId, error: String(e) });
        logger.error(`${this.logPrefix()} Send failed to ${channelId}: ${e}`);
      }
    }
  }

  /**
   * 发送 thought 内容（Proactive 模式可观测）
   * 群聊：调用 group.thought.put
   * 单聊：调用 message.thought.put
   *
   * selector 使用 context: { type: 'task', id: taskId }
   * 存储键：group_id/peer_aid + sender_aid + context.type + context.id
   */
  async sendThought(channelId: string, taskId: string, payload: object, context?: ReplyContext): Promise<void> {
    if (!this.connected || !this.client) return;
    if (!taskId) return;

    // Multi-instance routing
    const colonIdx = channelId.indexOf(':');
    const targetId = colonIdx > 0 ? channelId.substring(0, colonIdx) : channelId;

    const encrypt = context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(targetId);
    const params: Record<string, any> = {
      context: { type: 'task', id: taskId },
      payload,
      encrypt,
    };

    try {
      const stage = (payload as any)?.stage ?? 'unknown';
      if (this.isGroupId(channelId)) {
        params.group_id = targetId;
        await this.callAndTrace('group.thought.put', params);
        logger.info(`${this.logPrefix()} thought.put ok group=${targetId} task=${taskId} stage=${stage} encrypt=${encrypt}`);
      } else {
        params.to = targetId;
        await this.callAndTrace('message.thought.put', params);
        logger.info(`${this.logPrefix()} thought.put ok p2p=${this.peerLabel(targetId)} task=${taskId} stage=${stage} encrypt=${encrypt}`);
      }
    } catch (e) {
      const err = e as any;
      logger.debug(`${this.logPrefix()} thought.put failed to ${channelId}: ${err?.name}(${err?.code})=${err?.message}`);
    }
  }

  async sendFile(channelId: string, filePath: string, context?: ReplyContext): Promise<void> {
    if (!this.connected || !this.client) {
      logger.warn(`${this.logPrefix()} Cannot sendFile: not connected`);
      return;
    }

    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      logger.warn(`${this.logPrefix()} sendFile: file not found: ${absPath}`);
      return;
    }
    const stat = fs.statSync(absPath);
    if (stat.size === 0) {
      logger.warn(`${this.logPrefix()} sendFile: file is empty`);
      return;
    }
    if (stat.size > 10 * 1024 * 1024) {
      logger.warn(`${this.logPrefix()} sendFile: file too large (${formatSize(stat.size)}, max 10 MB)`);
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
        await this.callAndTrace('storage.put_object', {
          object_key: objectKey,
          content: fileData.toString('base64'),
          content_type: contentType,
          is_private: false,
          overwrite: true,
        });
      } else {
        // Ticket upload for large files
        const session = await this.callAndTrace<Record<string, unknown>>('storage.create_upload_session', {
          object_key: objectKey,
          size_bytes: stat.size,
          content_type: contentType,
        });
        const uploadUrl = session.upload_url as string;
        if (!uploadUrl) throw new Error('No upload_url in session response');
        this.trace('OUT', 'http.put.upload_url', { object_key: objectKey, size: stat.size });
        const uploadResp = await fetch(uploadUrl, { method: 'PUT', body: fileData });
        this.trace('OUT', uploadResp.ok ? 'http.put.upload_url.ok' : 'http.put.upload_url.error', { status: uploadResp.status });
        if (!uploadResp.ok) throw new Error(`HTTP upload failed: ${uploadResp.status}`);
        await this.callAndTrace('storage.complete_upload', {
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
      if (context?.metadata?.taskId) filePayload.task_id = context.metadata.taskId;
      if (context?.metadata?.chatmode) filePayload.chatmode = context.metadata.chatmode;
      const isGroup = this.isGroupId(channelId);

      // Multi-instance routing
      const fileColonIdx = channelId.indexOf(':');
      const fileTargetAid = fileColonIdx > 0 ? channelId.substring(0, fileColonIdx) : channelId;
      if (fileColonIdx > 0) {
        filePayload.chat_id = channelId;
      }

      const encryptTarget = isGroup ? channelId : fileTargetAid;
      const encrypt = context?.metadata?.encrypted != null
        ? !!(context.metadata.encrypted)
        : this.shouldEncrypt(encryptTarget);
      const params: Record<string, any> = { payload: filePayload, encrypt };

      try {
        if (isGroup) {
          params.group_id = channelId;
          this.trace('OUT', 'group.send.file', params);
          const result = await this.client.call('group.send', params);
          this.trace('OUT', 'group.send.file.ok', { message_id: (result as any)?.message_id });
          if (!result || !(result as any).message_id) {
            logger.warn(`${this.logPrefix()} group.send.file returned no message_id: ${JSON.stringify(result)}`);
          }
        } else {
          params.to = fileTargetAid;
          this.trace('OUT', 'message.send.file', params);
          const result = await this.client.call('message.send', params);
          this.trace('OUT', 'message.send.file.ok', { message_id: (result as any)?.message_id });
          if (!result || !(result as any).message_id) {
            logger.warn(`${this.logPrefix()} message.send.file returned no message_id: ${JSON.stringify(result)}`);
          }
        }
      } catch (sendErr) {
        this.trace('OUT', isGroup ? 'group.send.file.error' : 'message.send.file.error', {
          error: (sendErr as any)?.message ?? String(sendErr),
          code: (sendErr as any)?.code,
        });
        if (encrypt && sendErr instanceof E2EEError) {
          this.peerE2ee.set(encryptTarget, { ok: false, ts: Date.now() });
          logger.warn(`${this.logPrefix()} E2EE sendFile failed to ${channelId}, retrying plaintext: ${sendErr}`);
          params.encrypt = false;
          if (isGroup) {
            this.trace('OUT', 'group.send.file.fallback', params);
            const result = await this.client.call('group.send', params);
            this.trace('OUT', 'group.send.file.fallback.ok', { message_id: (result as any)?.message_id });
            if (!result || !(result as any).message_id) {
              logger.warn(`${this.logPrefix()} group.send.file fallback returned no message_id: ${JSON.stringify(result)}`);
            }
          } else {
            this.trace('OUT', 'message.send.file.fallback', params);
            const result = await this.client.call('message.send', params);
            this.trace('OUT', 'message.send.file.fallback.ok', { message_id: (result as any)?.message_id });
            if (!result || !(result as any).message_id) {
              logger.warn(`${this.logPrefix()} message.send.file fallback returned no message_id: ${JSON.stringify(result)}`);
            }
          }
        } else {
          throw sendErr;
        }
      }
      logger.info(`${this.logPrefix()} File sent: ${filename} (${formatSize(stat.size)}) → ${channelId}`);
    } catch (e) {
      this.trace('OUT', 'sendFile.error', { channelId, filePath, error: String(e) });
      logger.error(`${this.logPrefix()} sendFile failed for ${channelId}: ${e}`);
    }
  }

  acknowledge(messageId: string): void {
    // Gateway auto-delivery-ack is sufficient; skip explicit message.ack RPC
    // to avoid duplicate "已送达" at the sender CLI
    this.messageSeqMap.delete(messageId);
  }

  sendProcessingStatus(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, taskId: string, context?: ReplyContext): void {
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
      data: { task_id: taskId, session_id: sessionId },
      severity: status === 'error' || status === 'timeout' ? 'error' : 'info',
    };
    if (context?.threadId) payload.thread_id = context.threadId;

    const isGroup = this.isGroupId(channelId);

    // Multi-instance routing
    const statusColonIdx = channelId.indexOf(':');
    const statusTargetAid = statusColonIdx > 0 ? channelId.substring(0, statusColonIdx) : channelId;
    if (statusColonIdx > 0) {
      payload.chat_id = channelId;
    }

    const encryptTarget = isGroup ? channelId : statusTargetAid;
    const encrypt = context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(encryptTarget);
    const params: Record<string, any> = { payload, encrypt };

    const sendWithFallback = (method: string) => {
      this.client!.call(method, params).catch(e => {
        if (encrypt && e instanceof E2EEError) {
          this.peerE2ee.set(encryptTarget, { ok: false, ts: Date.now() });
          logger.warn(`${this.logPrefix()} E2EE status send failed to ${channelId}, retrying plaintext`);
          params.encrypt = false;
          this.client!.call(method, params).catch(e2 => {
            logger.debug(`${this.logPrefix()} Processing status fallback failed: ${e2}`);
          });
        } else {
          logger.debug(`${this.logPrefix()} Processing status failed: ${e}`);
        }
      });
    };

    if (isGroup) {
      params.group_id = channelId;
      this.trace('OUT', 'group.send.status', params);
      sendWithFallback('group.send');
    } else {
      params.to = statusTargetAid;
      this.trace('OUT', 'message.send.status', params);
      sendWithFallback('message.send');
    }
    // 群聊显示 group id 简称，P2P 显示 peer label；从 context.metadata 读取 chatmode
    const targetLabel = this.isGroupId(channelId) ? channelId : this.peerLabel(channelId);
    const chatmode = context?.metadata?.chatmode ?? '?';
    logger.info(`${this.logPrefix()} task.${status} task=${taskId} session=${sessionId} chatmode=${chatmode} encrypt=${encrypt} target=${targetLabel}`);
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
    this.client.call('message.send', sendParams).then((result: any) => {
      this.trace('OUT', 'message.send.custom.ok', { message_id: result?.message_id });
    }).catch(e => {
      this.trace('OUT', 'message.send.custom.error', { error: String(e) });
      logger.warn(`${this.logPrefix()} Custom payload failed: ${e}`);
    });
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.trace('OUT', 'client.close', { reason: 'disconnect' });
      try {
        await this.client.close();
        this.trace('OUT', 'client.close.ok', { reason: 'disconnect' });
      } catch (e) {
        this.trace('OUT', 'client.close.error', { reason: 'disconnect', error: String(e) });
      }
      this.client = null;
    }
    this.connected = false;
    logger.info(`${this.logPrefix()} Disconnected`);
    if (this.traceStream) {
      this.traceStream.end();
      this.traceStream = null;
    }
    logger.info(`${this.logPrefix()} Disconnected`);
  }

  // ── TS-layer reconnect (fallback when SDK auto_reconnect exhausted) ──

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;

    const delays = AUNChannel.RECONNECT_DELAYS;
    if (this.reconnectAttempt >= delays.length) {
      logger.error(`${this.logPrefix()} All ${delays.length} reconnect attempts exhausted, giving up`);
      this.onChannelDown?.();
      return;
    }

    const delay = delays[this.reconnectAttempt];
    this.reconnectAttempt++;
    logger.info(`${this.logPrefix()} Scheduling reconnect #${this.reconnectAttempt}/${delays.length} in ${delay}s`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        logger.info(`${this.logPrefix()} Reconnect #${this.reconnectAttempt} starting...`);
        this.trace('OUT', 'reconnect.start', { attempt: this.reconnectAttempt });
        await this.initClient();
        this.trace('OUT', 'reconnect.ok', { attempt: this.reconnectAttempt });
        logger.info(`${this.logPrefix()} Reconnect #${this.reconnectAttempt} succeeded`);
      } catch (err) {
        this.trace('OUT', 'reconnect.error', { attempt: this.reconnectAttempt, error: String(err) });
        logger.error(`${this.logPrefix()} Reconnect #${this.reconnectAttempt} failed:`, err);
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
  getStatus(): { connected: boolean; aid?: string; reconnectAttempt: number; maxAttempts: number; plaintextRecv: number } {
    return {
      connected: this.connected,
      aid: this._aid,
      reconnectAttempt: this.reconnectAttempt,
      maxAttempts: AUNChannel.RECONNECT_DELAYS.length,
      plaintextRecv: this.plaintextRecv,
    };
  }

  /** 读取本地 agent.md 中的 name（用于身份上下文展示） */
  private loadSelfName(aid: string): string | undefined {
    try {
      const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
      const agentMdPath = path.join(os.homedir(), '.aun', 'AIDs', aidName, 'agent.md');
      if (!fs.existsSync(agentMdPath)) return undefined;
      const content = fs.readFileSync(agentMdPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return undefined;
      const nameMatch = fmMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
      return nameMatch?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  getSelfName(): string | undefined {
    return this._selfName;
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
    } catch (e) {
      logger.debug(`${this.logPrefix()} fetchPeerInfo failed for ${aid}: ${e}`);
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
        aunSdkLog: config.debug?.aunSdkLog,
      });

      const adapter = {
        channelName: inst.name,
        sendText: (id: string, text: string, context?: ReplyContext) => channel.sendMessage(id, text, context),
        sendFile: (id: string, filePath: string, context?: ReplyContext) => channel.sendFile(id, filePath, context),
        acknowledge: (messageId: string) => { channel.acknowledge(messageId); return Promise.resolve(); },
        sendProcessingStatus: (id: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, taskId: string, context?: ReplyContext) => channel.sendProcessingStatus(id, status, sessionId, taskId, context),
        sendCustomPayload: (id: string, payload: string) => channel.sendCustomPayload(id, payload),
        uploadAgentMd: (content: string) => channel.uploadAgentMd(content),
        downloadAgentMd: (aid: string) => channel.downloadAgentMd(aid),
        putThought: (id: string, taskId: string, payload: object, context?: ReplyContext) =>
          channel.sendThought(id, taskId, payload, context),
        _selfAid: () => channel.getStatus().aid,
        _selfName: () => channel.getSelfName(),
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
