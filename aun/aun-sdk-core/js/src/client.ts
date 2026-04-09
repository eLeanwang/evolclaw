// ── AUNClient（SDK 主入口 — 浏览器完整实现）──────────────────
// 对标 Python client.py，浏览器环境适配：
//   - 所有密码学操作异步（SubtleCrypto）
//   - HTTP 使用 fetch() 而非 Node http
//   - 无文件系统（IndexedDB via keystore）
//   - 后台任务使用 setTimeout/setInterval

import { createConfig, type AUNConfig } from './config.js';
import { EventDispatcher, type EventHandler, type Subscription } from './events.js';
import { GatewayDiscovery } from './discovery.js';
import { RPCTransport } from './transport.js';
import { AuthFlow } from './auth.js';
import { AuthNamespace } from './namespaces/auth.js';
import { CryptoProvider, uint8ToBase64, base64ToUint8, pemToArrayBuffer, p1363ToDer } from './crypto.js';
import { E2EEManager } from './e2ee.js';
import {
  GroupE2EEManager,
  computeMembershipCommitment,
  storeGroupSecret,
  buildKeyDistribution,
  buildMembershipManifest,
  signMembershipManifest,
} from './e2ee-group.js';
import { IndexedDBKeyStore } from './keystore/indexeddb.js';
import type { KeyStore } from './keystore/index.js';
import {
  AUNError,
  AuthError,
  ConnectionError,
  E2EEError,
  PermissionError,
  StateError,
  ValidationError,
} from './errors.js';

/**
 * 递归排序键的 JSON 序列化（Canonical JSON for AUN）
 * 等价于 Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)
 * 非 ASCII 字符直接以 UTF-8 输出。
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return JSON.stringify(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(v => stableStringify(v)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const entries = keys.map(k => stableStringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(obj);
}

/** 内部专用方法（禁止用户直接调用） */
const INTERNAL_ONLY_METHODS = new Set([
  'auth.login1',
  'auth.aid_login1',
  'auth.login2',
  'auth.aid_login2',
  'auth.connect',
  'auth.refresh_token',
  'initialize',
]);

/** 需要客户端签名的关键方法 */
const SIGNED_METHODS = new Set([
  'group.send', 'group.kick', 'group.add_member',
  'group.leave', 'group.remove_member', 'group.update_rules',
]);

/** 默认会话选项 */
const DEFAULT_SESSION_OPTIONS = {
  auto_reconnect: false,
  heartbeat_interval: 30.0,
  token_refresh_before: 60.0,
  retry: {
    initial_delay: 0.5,
    max_delay: 30.0,
  },
  timeouts: {
    connect: 5.0,
    call: 10.0,
    http: 30.0,
  },
};

/** 对端证书缓存 TTL（秒） */
const PEER_CERT_CACHE_TTL = 600;

/** 缓存的对端证书 */
interface CachedPeerCert {
  certPem: string;
  validatedAt: number;
  refreshAfter: number;
}

/**
 * 将 WebSocket URL 转为对应的 HTTP URL
 */
function gatewayHttpUrl(gatewayUrl: string, path: string): string {
  try {
    const parsed = new URL(gatewayUrl);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${scheme}//${parsed.host}${path}`;
  } catch {
    const httpUrl = gatewayUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:');
    const urlObj = new URL(httpUrl);
    urlObj.pathname = path;
    urlObj.search = '';
    urlObj.hash = '';
    return urlObj.toString();
  }
}

/**
 * 跨域时将 Gateway URL 替换为 peer 所在域的 Gateway URL。
 *
 * 例: local=wss://gateway.aid.com:20001/aun, peer=bob.aid.net
 * → wss://gateway.aid.net:20001/aun
 */
function resolvePeerGatewayUrl(localGatewayUrl: string, peerAid: string): string {
  if (!peerAid.includes('.')) return localGatewayUrl;
  const peerIssuer = peerAid.split('.').slice(1).join('.');
  const match = localGatewayUrl.match(/gateway\.([^:/]+)/);
  if (!match) return localGatewayUrl;
  const localIssuer = match[1];
  if (localIssuer === peerIssuer) return localGatewayUrl;
  return localGatewayUrl.replace(`gateway.${localIssuer}`, `gateway.${peerIssuer}`);
}

/**
 * AUN Core SDK 客户端 — 浏览器版本。
 *
 * 职责：
 *   - 连接管理（WebSocket + 自动重连 + 指数退避）
 *   - 认证（token 初始化 / 多策略认证 / token 刷新）
 *   - RPC 调用（JSON-RPC 2.0）
 *   - E2EE 自动编排（加密/解密/密钥管理/group 生命周期）
 *   - 事件分发与管道
 *   - 后台任务（心跳、token 刷新、prekey 轮换、epoch 清理/轮换）
 */
export class AUNClient {
  /** SDK 配置模型 */
  readonly configModel: AUNConfig;
  /** 原始配置字典 */
  readonly config: Record<string, unknown>;

  private _aid: string | null = null;
  private _identity: Record<string, unknown> | null = null;
  private _state: 'idle' | 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'reconnecting' | 'closed' | 'terminal_failed' = 'idle';
  private _gatewayUrl: string | null = null;
  private _closing = false;
  private _sessionParams: Record<string, unknown> | null = null;
  private _sessionOptions = { ...DEFAULT_SESSION_OPTIONS };

  private _dispatcher: EventDispatcher;
  private _discovery: GatewayDiscovery;
  private _keystore: KeyStore;
  private _auth: AuthFlow;
  private _transport: RPCTransport;
  private _e2ee: E2EEManager;
  private _groupE2ee: GroupE2EEManager;

  /** 认证命名空间 */
  readonly auth: AuthNamespace;

  // E2EE 编排状态（内存缓存）
  private _certCache: Map<string, CachedPeerCert> = new Map();

  // 后台任务 handle（浏览器 setInterval/setTimeout）
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _prekeyRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _groupEpochCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _groupEpochRotateTimer: ReturnType<typeof setInterval> | null = null;
  // 重连相关
  private _reconnectActive = false;
  private _reconnectAbort: AbortController | null = null;

  constructor(config?: Partial<AUNConfig> & Record<string, unknown>) {
    const rawConfig = config ?? {};
    this.configModel = createConfig(rawConfig as Partial<AUNConfig>);
    this.config = rawConfig;

    this._dispatcher = new EventDispatcher();
    this._discovery = new GatewayDiscovery();
    this._keystore = (rawConfig.keystore as KeyStore) ?? new IndexedDBKeyStore();
    this._auth = new AuthFlow({
      keystore: this._keystore,
      crypto: (rawConfig.crypto as CryptoProvider) ?? new CryptoProvider(),
      aid: null,
      rootCaPem: this.configModel.rootCaPem,
      verifySsl: this.configModel.verifySsl,
    });
    this._transport = new RPCTransport({
      eventDispatcher: this._dispatcher,
      timeout: DEFAULT_SESSION_OPTIONS.timeouts.call,
      onDisconnect: (error) => this._handleTransportDisconnect(error),
    });
    this._e2ee = new E2EEManager({
      identityFn: () => this._identity ?? {},
      keystore: this._keystore,
      replayWindowSeconds: this.configModel.replayWindowSeconds,
    });
    this._groupE2ee = new GroupE2EEManager({
      identityFn: () => this._identity ?? {},
      keystore: this._keystore,
      // 零信任：只返回经 PKI 验证的内存缓存证书
      senderCertResolver: (aid: string) => this._getVerifiedPeerCert(aid),
      initiatorCertResolver: (aid: string) => this._getVerifiedPeerCert(aid),
    });

    this.auth = new AuthNamespace(this);

    // 内部订阅：推送消息自动解密后 re-publish 给用户
    this._dispatcher.subscribe('_raw.message.received', (data) => {
      this._onRawMessageReceived(data);
    });
    // 群组消息推送：自动解密后 re-publish
    this._dispatcher.subscribe('_raw.group.message_created', (data) => {
      this._onRawGroupMessageCreated(data);
    });
    // 群组变更事件：拦截处理成员变更触发的 epoch 轮换，然后透传
    this._dispatcher.subscribe('_raw.group.changed', (data) => {
      this._onRawGroupChanged(data);
    });
    // 其他事件直接透传
    for (const evt of ['message.recalled', 'message.ack']) {
      this._dispatcher.subscribe(`_raw.${evt}`, (data) => {
        this._dispatcher.publish(evt, data);
      });
    }
  }

  // ── 属性 ──────────────────────────────────────────

  get aid(): string | null {
    return this._aid;
  }

  get state(): string {
    return this._state;
  }

  get gatewayUrl(): string | null {
    return this._gatewayUrl;
  }

  set gatewayUrl(url: string | null) {
    this._gatewayUrl = url;
  }

  get discovery(): GatewayDiscovery {
    return this._discovery;
  }

  get e2ee(): E2EEManager {
    return this._e2ee;
  }

  get groupE2ee(): GroupE2EEManager {
    return this._groupE2ee;
  }

  // ── 生命周期 ──────────────────────────────────────

  /**
   * 连接到 Gateway。
   *
   * @param auth - 认证参数，必须包含 access_token 和 gateway
   * @param options - 可选的会话选项（auto_reconnect, heartbeat_interval 等）
   */
  async connect(
    auth: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<void> {
    if (this._state !== 'idle' && this._state !== 'closed') {
      throw new StateError(`connect not allowed in state ${this._state}`);
    }

    const params = { ...auth, ...options };
    const normalized = this._normalizeConnectParams(params);
    this._sessionParams = normalized;
    this._sessionOptions = this._buildSessionOptions(normalized);
    this._transport.setTimeout(this._sessionOptions.timeouts.call);
    this._closing = false;

    await this._connectOnce(normalized, false);
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    this._closing = true;
    this._stopBackgroundTasks();

    // 取消进行中的重连
    if (this._reconnectAbort) {
      this._reconnectAbort.abort();
      this._reconnectAbort = null;
      this._reconnectActive = false;
    }

    if (this._state === 'idle' || this._state === 'closed') {
      this._state = 'closed';
      return;
    }

    await this._transport.close();
    this._state = 'closed';
    await this._dispatcher.publish('connection.state', { state: this._state });
  }

  // ── RPC ───────────────────────────────────────────

  /**
   * 发起 RPC 调用。
   *
   * 自动拦截内部方法、自动加密 message.send/group.send、
   * 自动解密 message.pull/group.pull、Group E2EE 生命周期编排。
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this._state !== 'connected') {
      throw new ConnectionError('client is not connected');
    }
    if (INTERNAL_ONLY_METHODS.has(method)) {
      throw new PermissionError(`method is internal_only: ${method}`);
    }

    const p = { ...(params ?? {}) };

    // 自动加密：message.send 默认加密（encrypt 默认 true）
    if (method === 'message.send') {
      const encrypt = p.encrypt !== undefined ? p.encrypt : true;
      delete p.encrypt;
      if (encrypt) {
        return this._sendEncrypted(p);
      }
    }

    // 自动加密：group.send 默认加密（encrypt 默认 true）
    if (method === 'group.send') {
      const encrypt = p.encrypt !== undefined ? p.encrypt : true;
      delete p.encrypt;
      if (encrypt) {
        return this._sendGroupEncrypted(p);
      }
    }

    // 关键操作自动附加客户端签名
    if (SIGNED_METHODS.has(method)) {
      await this._signClientOperation(method, p);
    }

    const result = await this._transport.call(method, p);

    // 自动解密：message.pull 返回的消息
    if (method === 'message.pull' && result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      const messages = r.messages;
      if (Array.isArray(messages) && messages.length) {
        r.messages = await this._decryptMessages(messages as Record<string, unknown>[]);
      }
    }

    // 自动解密：group.pull 返回的群消息
    if (method === 'group.pull' && result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      const messages = r.messages;
      if (Array.isArray(messages) && messages.length) {
        r.messages = await this._decryptGroupMessages(messages as Record<string, unknown>[]);
      }
    }

    // ── Group E2EE 自动编排 ────────────────────────────
    if (this.configModel.groupE2ee) {
      // 建群后自动创建 epoch（幂等：已有 secret 时跳过）
      if (method === 'group.create' && result && typeof result === 'object') {
        const group = (result as Record<string, unknown>).group as Record<string, unknown> | undefined;
        const gid = (group?.group_id ?? '') as string;
        if (gid && this._aid && !(await this._groupE2ee.hasSecret(gid))) {
          try {
            await this._groupE2ee.createEpoch(gid, [this._aid]);
            // 同步到服务端：将服务端 epoch 从 0 推到 1
            this._safeAsync(this._syncEpochToServer(gid));
          } catch (exc) {
            this._logE2eeError('create_epoch', gid, '', exc as Error);
          }
        }
      }

      // 加人后自动分发密钥给新成员
      if (method === 'group.add_member') {
        const groupId = (p.group_id ?? '') as string;
        const newAid = (p.aid ?? '') as string;
        if (groupId && newAid) {
          if (this.configModel.rotateOnJoin) {
            this._safeAsync(this._rotateGroupEpoch(groupId));
          } else {
            this._safeAsync(this._distributeKeyToNewMember(groupId, newAid));
          }
        }
      }

      // 踢人后自动轮换 epoch
      if (method === 'group.kick') {
        const groupId = (p.group_id ?? '') as string;
        if (groupId) {
          this._safeAsync(this._rotateGroupEpoch(groupId));
        }
      }

      // 审批通过后自动分发密钥给新成员
      if (method === 'group.review_join_request' && result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (r.approved || r.status === 'approved') {
          const groupId = (p.group_id ?? '') as string;
          const newAid = (p.aid ?? '') as string;
          if (groupId && newAid) {
            this._safeAsync(this._distributeKeyToNewMember(groupId, newAid));
          }
        }
      }

      // 批量审批通过后分发密钥
      if (method === 'group.batch_review_join_request' && result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        const groupId = (p.group_id ?? '') as string;
        const approvedAids = ((r.results ?? []) as Record<string, unknown>[])
          .filter(item => item.ok && item.status === 'approved' && item.aid)
          .map(item => item.aid as string);
        if (groupId && approvedAids.length) {
          if (this.configModel.rotateOnJoin) {
            this._safeAsync(this._rotateGroupEpoch(groupId));
          } else {
            for (const aid of approvedAids) {
              this._safeAsync(this._distributeKeyToNewMember(groupId, aid));
            }
          }
        }
      }
    }

    return result;
  }

  // ── 便利方法 ──────────────────────────────────────

  async ping(params?: Record<string, unknown>): Promise<unknown> {
    return this.call('meta.ping', params ?? {});
  }

  async status(params?: Record<string, unknown>): Promise<unknown> {
    return this.call('meta.status', params ?? {});
  }

  async trustRoots(params?: Record<string, unknown>): Promise<unknown> {
    return this.call('meta.trust_roots', params ?? {});
  }

  // ── 事件 ──────────────────────────────────────────

  /** 订阅事件 */
  on(event: string, handler: EventHandler): Subscription {
    return this._dispatcher.subscribe(event, handler);
  }

  // ── 事件管道：消息解密 ────────────────────────────

  /** 处理 transport 层推送的原始消息：解密后 re-publish 给用户 */
  private _onRawMessageReceived(data: unknown): void {
    this._safeAsync(this._processAndPublishMessage(data));
  }

  /** 实际处理推送消息的异步任务 */
  private async _processAndPublishMessage(data: unknown): Promise<void> {
    try {
      if (!data || typeof data !== 'object') {
        await this._dispatcher.publish('message.received', data);
        return;
      }
      const msg = { ...(data as Record<string, unknown>) };

      // 拦截 P2P 传输的群组密钥分发/请求/响应消息
      if (await this._tryHandleGroupKeyMessage(msg)) {
        return;
      }

      const decrypted = await this._decryptSingleMessage(msg);
      await this._dispatcher.publish('message.received', decrypted);
    } catch (exc) {
      console.debug('消息解密失败:', exc);
    }
  }

  /** 处理群组消息推送：自动解密后 re-publish */
  private _onRawGroupMessageCreated(data: unknown): void {
    this._safeAsync(this._processAndPublishGroupMessage(data));
  }

  /** 处理群组推送消息的异步任务 */
  private async _processAndPublishGroupMessage(data: unknown): Promise<void> {
    try {
      if (!data || typeof data !== 'object') {
        await this._dispatcher.publish('group.message_created', data);
        return;
      }
      const msg = { ...(data as Record<string, unknown>) };
      const decrypted = await this._decryptGroupMessage(msg);
      await this._dispatcher.publish('group.message_created', decrypted);
    } catch (exc) {
      console.debug('群消息解密失败:', exc);
    }
  }

  /**
   * 处理群组变更事件：透传给用户，并在成员离开/被踢时自动触发 epoch 轮换。
   * 按协议，轮换由剩余在线 admin/owner 负责。
   */
  private async _onRawGroupChanged(data: unknown): Promise<void> {
    await this._dispatcher.publish('group.changed', data);

    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (d.action === 'member_left' || d.action === 'member_removed') {
        const groupId = (d.group_id ?? '') as string;
        if (groupId) {
          this._safeAsync(this._rotateGroupEpoch(groupId));
        }
      }
    }
  }

  // ── E2EE 自动加密 ────────────────────────────────

  /** 自动加密并发送 P2P 消息 */
  private async _sendEncrypted(params: Record<string, unknown>): Promise<unknown> {
    const toAid = params.to as string;
    const payload = params.payload as Record<string, unknown>;
    const messageId = (params.message_id as string) ?? _uuidV4();
    const timestamp = (params.timestamp as number) ?? Date.now();

    // 获取对方证书（含完整 PKI 验证）
    const peerCertPem = await this._fetchPeerCert(toAid);

    // 获取对方 prekey
    const prekey = await this._fetchPeerPrekey(toAid);

    const [envelope, encryptResult] = await this._e2ee.encryptOutbound(
      toAid, payload, {
        peerCertPem,
        prekey,
        messageId,
        timestamp,
      },
    );

    if (!encryptResult.encrypted) {
      throw new E2EEError(`failed to encrypt message to ${toAid}`);
    }

    // 严格模式：拒绝无前向保密的降级
    if (this.configModel.requireForwardSecrecy && !encryptResult.forward_secrecy) {
      throw new E2EEError(
        `forward secrecy required but unavailable for ${toAid} (mode=${encryptResult.mode})`,
      );
    }

    // 降级时发布安全事件
    if (encryptResult.degraded) {
      try {
        await this._dispatcher.publish('e2ee.degraded', {
          peer_aid: toAid,
          mode: encryptResult.mode,
          reason: encryptResult.degradation_reason,
        });
      } catch (exc) {
        console.warn('发布 e2ee.degraded 事件失败:', exc);
      }
    }

    const sendParams: Record<string, unknown> = {
      to: toAid,
      payload: envelope,
      type: 'e2ee.encrypted',
      encrypted: true,
      message_id: messageId,
      timestamp,
      persist: params.persist !== undefined ? params.persist : true,
    };
    return this._transport.call('message.send', sendParams);
  }

  /** 自动加密并发送群组消息 */
  private async _sendGroupEncrypted(params: Record<string, unknown>): Promise<unknown> {
    const groupId = params.group_id as string;
    const payload = params.payload as Record<string, unknown>;
    if (!groupId) {
      throw new ValidationError('group.send requires group_id');
    }

    const envelope = await this._groupE2ee.encrypt(groupId, payload);

    const sendParams: Record<string, unknown> = {
      group_id: groupId,
      payload: envelope,
      type: 'e2ee.group_encrypted',
      encrypted: true,
    };
    await this._signClientOperation('group.send', sendParams);
    return this._transport.call('group.send', sendParams);
  }

  // ── E2EE 自动解密 ────────────────────────────────

  /** 解密单条 P2P 消息 */
  private async _decryptSingleMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = message.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return message;
    if (payload.type !== 'e2ee.encrypted') return message;
    if (message.encrypted === false) return message;

    // 确保发送方证书已缓存（签名验证需要）
    const fromAid = (message.from ?? '') as string;
    if (fromAid) {
      const certReady = await this._ensureSenderCertCached(fromAid);
      if (!certReady) {
        console.warn(`无法获取发送方 ${fromAid} 的证书，跳过解密`);
        return message;
      }
    }

    // 密码学解密（E2EEManager.decryptMessage 内含本地防重放）
    const decrypted = await this._e2ee.decryptMessage(message);
    console.error(`[DEBUG:_decryptSingleMessage] from=${fromAid}, mid=${message.message_id}, result=${decrypted ? (decrypted.e2ee ? 'DECRYPTED' : 'NOT_DECRYPTED') : 'null'}`);
    return decrypted ?? message;
  }

  /** 批量解密 P2P 消息（用于 message.pull） */
  private async _decryptMessages(messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const seenInBatch = new Set<string>();
    const result: Record<string, unknown>[] = [];
    for (const msg of messages) {
      const mid = (msg.message_id ?? '') as string;
      if (mid && seenInBatch.has(mid)) continue;
      if (mid) seenInBatch.add(mid);

      const payload = msg.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload === 'object'
        && payload.type === 'e2ee.encrypted'
        && (msg.encrypted === true || !('encrypted' in msg))) {
        const fromAid = (msg.from ?? '') as string;
        if (fromAid) {
          const certReady = await this._ensureSenderCertCached(fromAid);
          if (!certReady) {
            console.warn(`无法获取发送方 ${fromAid} 的证书，跳过解密`);
            result.push(msg);
            continue;
          }
        }
        // Pull 场景：跳过防重放和 timestamp 窗口检查（push 已处理过的消息仍需要能解密）
        const decrypted = await this._e2ee.decryptMessage(msg, { skipReplay: true });
        console.error(`[DEBUG:_decryptMessages] from=${fromAid}, mid=${mid}, ts=${msg.timestamp}, result=${decrypted ? (decrypted.e2ee ? 'DECRYPTED' : 'PASS_THROUGH') : 'null'}`);
        result.push(decrypted ?? msg);
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  /** 解密单条群组消息。opts.skipReplay 用于 pull 场景跳过防重放。 */
  private async _decryptGroupMessage(
    message: Record<string, unknown>,
    opts?: { skipReplay?: boolean },
  ): Promise<Record<string, unknown>> {
    const payload = message.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object' || payload.type !== 'e2ee.group_encrypted') {
      return message;
    }

    // 确保发送方证书已缓存（签名验证需要）
    const senderAid = (message.from ?? message.sender_aid ?? '') as string;
    console.error(`[DEBUG:group-decrypt] senderAid=${senderAid}, group_id=${message.group_id}, message_id=${message.message_id}`);
    if (senderAid) {
      const certOk = await this._ensureSenderCertCached(senderAid);
      if (!certOk) {
        console.warn(`群消息解密跳过：发送方 ${senderAid} 证书不可用`);
        return message;
      }
      console.error(`[DEBUG:group-decrypt] cert cached OK for ${senderAid}, certCache has: ${this._getVerifiedPeerCert(senderAid) ? 'YES' : 'NO'}`);
    }

    // 先尝试直接解密
    const result = await this._groupE2ee.decrypt(message, opts);
    console.error(`[DEBUG:group-decrypt] decrypt result: e2ee=${!!(result as any)?.e2ee}, result===null: ${result === null}, result===message: ${result === message}`);
    if (result !== null && (result as Record<string, unknown>).e2ee) {
      return result;
    }

    // 解密失败，尝试密钥恢复后重试
    const groupId = (message.group_id ?? '') as string;
    const sender = (message.from ?? message.sender_aid ?? '') as string;
    const epoch = payload.epoch as number | undefined;
    if (epoch !== undefined && groupId) {
      const recovery = await this._groupE2ee.buildRecoveryRequest(
        groupId, epoch, { senderAid: sender },
      );
      if (recovery) {
        try {
          await this.call('message.send', {
            to: (recovery as Record<string, unknown>).to,
            payload: (recovery as Record<string, unknown>).payload,
            encrypt: true,
            persist: false,
          });
        } catch (exc) {
          console.debug('密钥恢复请求发送失败:', exc);
        }
      }
    }

    return message;
  }

  /** 批量解密群组消息（用于 group.pull）。跳过防重放检查。 */
  private async _decryptGroupMessages(messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    for (const msg of messages) {
      result.push(await this._decryptGroupMessage(msg, { skipReplay: true }));
    }
    return result;
  }

  /** 尝试处理 P2P 传输的群组密钥消息。返回 true 表示已处理。 */
  private async _tryHandleGroupKeyMessage(message: Record<string, unknown>): Promise<boolean> {
    let actualPayload = message.payload as Record<string, unknown> | undefined;
    if (!actualPayload || typeof actualPayload !== 'object') return false;

    // 先解密 P2P E2EE 外壳
    if (actualPayload.type === 'e2ee.encrypted') {
      const fromAid = (message.from ?? '') as string;
      if (fromAid) {
        await this._ensureSenderCertCached(fromAid);
      }
      const decrypted = await this._e2ee.decryptMessage(message);
      console.error(`[DEBUG:_tryHandleGroupKeyMessage] P2P decrypt result: ${decrypted ? 'OK' : 'null'}, payload.type=${(decrypted?.payload as any)?.type}`);
      if (!decrypted) return false;
      actualPayload = decrypted.payload as Record<string, unknown>;
      if (!actualPayload || typeof actualPayload !== 'object') return false;
    }

    const result = await this._groupE2ee.handleIncoming(actualPayload);
    console.error(`[DEBUG:_tryHandleGroupKeyMessage] handleIncoming result: ${result}`);
    if (result === null) return false;

    if (result === 'request') {
      // 处理密钥请求并回复
      const groupId = (actualPayload.group_id ?? '') as string;
      const requester = (actualPayload.requester_aid ?? '') as string;
      let members = await this._groupE2ee.getMemberAids(groupId);

      // 请求者不在本地成员列表时，回源查询服务端最新成员列表
      if (requester && !members.includes(requester)) {
        try {
          const membersResult = await this.call('group.get_members', { group_id: groupId }) as Record<string, unknown>;
          members = ((membersResult.members ?? []) as Record<string, unknown>[]).map(m => m.aid as string);
          // 更新本地当前 epoch 的 member_aids/commitment
          if (members.includes(requester)) {
            const secretData = await this._groupE2ee.loadSecret(groupId);
            if (secretData && this._aid) {
              const epoch = secretData.epoch;
              const commitment = await computeMembershipCommitment(members, epoch, groupId, secretData.secret);
              await storeGroupSecret(
                this._keystore, this._aid, groupId, epoch,
                secretData.secret, commitment, members,
              );
            }
          }
        } catch (exc) {
          console.warn(`群组 ${groupId} 成员列表回源失败:`, exc);
        }
      }

      const response = await this._groupE2ee.handleKeyRequestMsg(actualPayload, members);
      if (response && requester) {
        try {
          await this.call('message.send', {
            to: requester,
            payload: response,
            encrypt: true,
            persist: false,
          });
        } catch (exc) {
          console.warn(`向 ${requester} 回复群组密钥失败:`, exc);
        }
      }
    }

    return true;
  }

  // ── E2EE 编排：证书与 prekey ──────────────────────

  /**
   * 获取对方证书（带缓存 + 完整 PKI 验证：链 + CRL + OCSP + AID 绑定）。
   * 跨域时自动将请求路由到 peer 所在域的 Gateway。
   */
  private async _fetchPeerCert(aid: string): Promise<string> {
    const cached = this._certCache.get(aid);
    const now = Date.now() / 1000;
    if (cached && now < cached.refreshAfter) {
      return cached.certPem;
    }

    const gatewayUrl = this._gatewayUrl;
    if (!gatewayUrl) {
      throw new ValidationError('gateway url unavailable for e2ee cert fetch');
    }

    // 跨域时用 peer 所在域的 Gateway URL
    const peerGatewayUrl = resolvePeerGatewayUrl(gatewayUrl, aid);
    const certUrl = gatewayHttpUrl(peerGatewayUrl, `/pki/cert/${encodeURIComponent(aid)}`);

    const resp = await fetch(certUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new ValidationError(`failed to fetch peer cert for ${aid}: HTTP ${resp.status}`);
    const certPem = await resp.text();

    // 完整 PKI 验证：链 + CRL + OCSP + AID 绑定
    try {
      await this._auth.verifyPeerCertificate(peerGatewayUrl, certPem, aid);
    } catch (exc) {
      throw new ValidationError(`peer cert verification failed for ${aid}: ${exc}`);
    }

    this._certCache.set(aid, {
      certPem,
      validatedAt: now,
      refreshAfter: now + PEER_CERT_CACHE_TTL,
    });

    // 同步写入 keystore，保证解密时能读到
    try {
      await this._keystore.saveCert(aid, certPem);
    } catch (exc) {
      console.error(`写入证书到 keystore 失败 (aid=${aid}):`, exc);
    }

    return certPem;
  }

  /** 获取对方 prekey（带缓存） */
  private async _fetchPeerPrekey(peerAid: string): Promise<Record<string, unknown> | null> {
    const cached = this._e2ee.getCachedPrekey(peerAid);
    if (cached !== null) return cached;
    try {
      const result = await this._transport.call('message.e2ee.get_prekey', { aid: peerAid }) as Record<string, unknown>;
      if (result && result.found) {
        const prekey = result.prekey as Record<string, unknown>;
        if (prekey) {
          this._e2ee.cachePrekey(peerAid, prekey);
        }
        return prekey ?? null;
      }
    } catch (exc) {
      console.debug('prekey 获取失败:', exc);
    }
    return null;
  }

  /** 生成 prekey 并上传到服务端 */
  private async _uploadPrekey(): Promise<Record<string, unknown>> {
    const prekeyMaterial = await this._e2ee.generatePrekey();
    const result = await this._transport.call('message.e2ee.put_prekey', prekeyMaterial);
    return (result && typeof result === 'object') ? result as Record<string, unknown> : { ok: true };
  }

  /** 确保发送方证书在本地可用且未过期 */
  private async _ensureSenderCertCached(aid: string): Promise<boolean> {
    const cached = this._certCache.get(aid);
    const now = Date.now() / 1000;
    if (cached && now < cached.refreshAfter) return true;
    try {
      const certPem = await this._fetchPeerCert(aid);
      await this._keystore.saveCert(aid, certPem);
      return true;
    } catch (exc) {
      // 刷新失败时：若缓存有 PKI 验证过的证书（2 倍 TTL 内）则继续用
      if (cached && now < cached.validatedAt + PEER_CERT_CACHE_TTL * 2) {
        console.debug(`刷新发送方 ${aid} 证书失败，继续使用已验证的内存缓存:`, exc);
        return true;
      }
      console.warn(`获取发送方 ${aid} 证书失败且无已验证缓存，拒绝信任:`, exc);
      return false;
    }
  }

  /**
   * 获取经过 PKI 验证的 peer 证书（仅信任内存缓存中已验证的证书）。
   * 零信任要求：不直接信任 keystore 中可能由恶意服务端注入的证书。
   */
  private _getVerifiedPeerCert(aid: string): string | null {
    const cached = this._certCache.get(aid);
    const now = Date.now() / 1000;
    if (cached && now < cached.validatedAt + PEER_CERT_CACHE_TTL * 2) {
      return cached.certPem;
    }
    return null;
  }

  // ── 客户端操作签名 ────────────────────────────────

  /**
   * 为关键操作附加客户端 ECDSA 签名（_client_signature 字段）。
   * 使用 SubtleCrypto 异步签名。
   */
  private async _signClientOperation(method: string, params: Record<string, unknown>): Promise<void> {
    const identity = this._identity;
    if (!identity || !identity.private_key_pem) return;

    try {
      const aid = (identity.aid ?? '') as string;
      const ts = String(Math.floor(Date.now() / 1000));

      // 计算 params hash：覆盖所有非 _ 前缀且非 client_signature 的业务字段
      const paramsForHash: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (k !== 'client_signature' && !k.startsWith('_')) {
          paramsForHash[k] = v;
        }
      }
      const paramsJson = stableStringify(paramsForHash);

      // SHA-256 hash
      const paramsHashBuf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(paramsJson),
      );
      const paramsHash = Array.from(new Uint8Array(paramsHashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const signData = new TextEncoder().encode(`${method}|${aid}|${ts}|${paramsHash}`);

      // 导入私钥并签名
      const pkcs8 = pemToArrayBuffer(identity.private_key_pem as string);
      const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', pkcs8,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign'],
      );
      const sigP1363 = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey, signData,
      );

      // P1363 → DER 格式（与 Python 兼容）
      const sigDer = p1363ToDer(new Uint8Array(sigP1363));

      params.client_signature = {
        aid,
        timestamp: ts,
        params_hash: paramsHash,
        signature: uint8ToBase64(sigDer),
      };
    } catch (exc) {
      console.warn('客户端签名失败，继续发送无签名请求:', exc);
    }
  }

  // ── E2EE 编排：Group 生命周期 ─────────────────────

  /** 建群后将本地 epoch 1 同步到服务端 */
  private async _syncEpochToServer(groupId: string): Promise<void> {
    try {
      const rotateParams: Record<string, unknown> = {
        group_id: groupId,
        current_epoch: 0,
      };
      const sigParams = await this._buildRotationSignature(groupId, 0, 1);
      Object.assign(rotateParams, sigParams);
      await this.call('group.e2ee.rotate_epoch', rotateParams);
    } catch (exc) {
      console.debug(`同步 epoch 到服务端失败 (group=${groupId}，可能已同步):`, exc);
    }
  }

  /**
   * 为指定群组轮换 epoch 并分发新密钥。
   * 使用服务端 CAS 保证只有一方成功。
   */
  private async _rotateGroupEpoch(groupId: string): Promise<void> {
    try {
      // 1. 读取服务端当前 epoch
      const epochResult = await this.call('group.e2ee.get_epoch', { group_id: groupId }) as Record<string, unknown>;
      const currentEpoch = (epochResult.epoch ?? 0) as number;

      // 2. CAS 尝试递增（服务端校验角色 + 原子递增）
      const rotateParams: Record<string, unknown> = {
        group_id: groupId,
        current_epoch: currentEpoch,
      };
      const sigParams = await this._buildRotationSignature(groupId, currentEpoch, currentEpoch + 1);
      Object.assign(rotateParams, sigParams);
      const casResult = await this.call('group.e2ee.rotate_epoch', rotateParams) as Record<string, unknown>;
      if (!casResult.success) return; // CAS 失败，放弃

      const newEpoch = casResult.epoch as number;

      // 3. 获取最新成员列表
      const membersResult = await this.call('group.get_members', { group_id: groupId }) as Record<string, unknown>;
      const memberAids = ((membersResult.members ?? []) as Record<string, unknown>[])
        .map(m => m.aid as string);

      // 4. 本地生成密钥 + 存储 + 分发
      const info = await this._groupE2ee.rotateEpochTo(groupId, newEpoch, memberAids);
      const distributions = (info.distributions ?? []) as Array<{ to: string; payload: Record<string, unknown> }>;
      for (const dist of distributions) {
        try {
          await this.call('message.send', {
            to: dist.to,
            payload: dist.payload,
            encrypt: true,
            persist: false,
          });
        } catch (exc) {
          console.debug('密钥分发失败:', exc);
        }
      }
    } catch (exc) {
      this._logE2eeError('rotate_epoch', groupId, '', exc as Error);
    }
  }

  /**
   * 将当前 group_secret 通过 P2P E2EE 分发给新成员。
   * 先拉服务端最新成员列表，更新本地，构建签名 manifest，再分发。
   */
  private async _distributeKeyToNewMember(groupId: string, newMemberAid: string): Promise<void> {
    try {
      const secretData = await this._groupE2ee.loadSecret(groupId);
      if (!secretData || !this._aid) return;

      // 拉服务端最新成员列表
      const membersResult = await this.call('group.get_members', { group_id: groupId }) as Record<string, unknown>;
      const memberAids = ((membersResult.members ?? []) as Record<string, unknown>[])
        .map(m => m.aid as string);

      // 用最新成员列表更新本地当前 epoch
      const epoch = secretData.epoch;
      const commitment = await computeMembershipCommitment(
        memberAids, epoch, groupId, secretData.secret,
      );
      await storeGroupSecret(
        this._keystore, this._aid, groupId, epoch,
        secretData.secret, commitment, memberAids,
      );

      // 构建并签名 manifest
      let manifest = buildMembershipManifest(
        groupId, epoch, epoch, memberAids, {
          added: [newMemberAid],
          removed: [],
          initiatorAid: this._aid,
        },
      );
      const identity = this._identity;
      if (identity && identity.private_key_pem) {
        manifest = await signMembershipManifest(manifest, identity.private_key_pem as string);
      }

      const distPayload = await buildKeyDistribution(
        groupId, epoch, secretData.secret,
        memberAids, this._aid, manifest,
      );
      await this.call('message.send', {
        to: newMemberAid,
        payload: distPayload,
        encrypt: true,
        persist: false,
      });
    } catch (exc) {
      this._logE2eeError('distribute_key', groupId, newMemberAid, exc as Error);
    }
  }

  /** 构建 epoch 轮换签名参数（异步，使用 SubtleCrypto） */
  private async _buildRotationSignature(
    groupId: string,
    currentEpoch: number,
    newEpoch: number,
  ): Promise<Record<string, string>> {
    const identity = this._identity;
    if (!identity || !identity.private_key_pem) return {};

    try {
      const aid = (identity.aid ?? '') as string;
      const ts = String(Math.floor(Date.now() / 1000));
      const signData = new TextEncoder().encode(
        `${groupId}|${currentEpoch}|${newEpoch}|${aid}|${ts}`,
      );

      const pkcs8 = pemToArrayBuffer(identity.private_key_pem as string);
      const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', pkcs8,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign'],
      );
      const sigP1363 = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey, signData,
      );

      const { p1363ToDer } = await import('./crypto.js');
      const sigDer = p1363ToDer(new Uint8Array(sigP1363));

      return {
        rotation_signature: uint8ToBase64(sigDer),
        rotation_timestamp: ts,
      };
    } catch {
      return {};
    }
  }

  // ── 内部：连接 ────────────────────────────────────

  private async _connectOnce(params: Record<string, unknown>, allowReauth: boolean): Promise<void> {
    const gatewayUrl = this._resolveGateway(params);
    this._gatewayUrl = gatewayUrl;

    this._state = 'connecting';
    const challenge = await this._transport.connect(gatewayUrl);

    this._state = 'authenticating';
    if (allowReauth) {
      const authContext = await this._auth.connectSession(
        this._transport,
        challenge,
        gatewayUrl,
        params.access_token as string | undefined,
      );
      if (authContext && typeof authContext === 'object') {
        const identity = (authContext as Record<string, unknown>).identity as Record<string, unknown> | undefined;
        if (identity && typeof identity === 'object') {
          this._identity = identity;
          this._aid = (identity.aid as string) ?? this._aid;
          if (this._sessionParams) {
            this._sessionParams.access_token = (authContext as Record<string, unknown>).token ?? params.access_token;
          }
        }
      }
    } else {
      await this._auth.initializeWithToken(
        this._transport,
        challenge,
        String(params.access_token),
      );
      await this._syncIdentityAfterConnect(String(params.access_token));
    }

    this._state = 'connected';
    await this._dispatcher.publish('connection.state', {
      state: this._state,
      gateway: gatewayUrl,
    });

    this._startBackgroundTasks();

    // 上线后自动上传 prekey
    try {
      await this._uploadPrekey();
    } catch (exc) {
      console.warn('prekey 上传失败:', exc);
    }
  }

  private _resolveGateway(params: Record<string, unknown>): string {
    const topology = params.topology as Record<string, unknown> | undefined;
    if (topology && typeof topology === 'object') {
      const mode = String(topology.mode ?? 'gateway');
      if (mode === 'peer') {
        throw new ValidationError('peer topology is not implemented in the Browser SDK');
      }
      if (mode === 'relay') {
        throw new ValidationError('relay topology is not implemented in the Browser SDK');
      }
    }
    const gateway = String(params.gateway ?? this._gatewayUrl ?? '');
    if (!gateway) throw new StateError('missing gateway in connect params');
    return gateway;
  }

  private async _syncIdentityAfterConnect(accessToken: string): Promise<void> {
    let identity: Record<string, unknown> | null = null;
    try {
      identity = await this._auth.loadIdentityOrNull(this._aid ?? undefined);
    } catch { /* 忽略 */ }
    if (!identity) {
      this._identity = null;
      return;
    }
    identity.access_token = accessToken;
    this._identity = identity;
    this._aid = (identity.aid as string) ?? this._aid;
    if (identity.aid) {
      await this._keystore.saveIdentity(identity.aid as string, identity);
    }
  }

  // ── 内部：参数处理 ────────────────────────────────

  private _normalizeConnectParams(params: Record<string, unknown>): Record<string, unknown> {
    const request = { ...params };
    const accessToken = String(request.access_token ?? '');
    if (!accessToken) throw new StateError('connect requires non-empty access_token');
    const gateway = String(request.gateway ?? this._gatewayUrl ?? '');
    if (!gateway) throw new StateError('connect requires non-empty gateway');
    request.access_token = accessToken;
    request.gateway = gateway;

    if (request.topology !== undefined && typeof request.topology !== 'object') {
      throw new ValidationError('topology must be an object');
    }
    if (request.retry !== undefined && typeof request.retry !== 'object') {
      throw new ValidationError('retry must be an object');
    }
    if (request.timeouts !== undefined && typeof request.timeouts !== 'object') {
      throw new ValidationError('timeouts must be an object');
    }
    return request;
  }

  private _buildSessionOptions(params: Record<string, unknown>): typeof DEFAULT_SESSION_OPTIONS {
    const options = {
      auto_reconnect: DEFAULT_SESSION_OPTIONS.auto_reconnect,
      heartbeat_interval: DEFAULT_SESSION_OPTIONS.heartbeat_interval,
      token_refresh_before: DEFAULT_SESSION_OPTIONS.token_refresh_before,
      retry: { ...DEFAULT_SESSION_OPTIONS.retry },
      timeouts: { ...DEFAULT_SESSION_OPTIONS.timeouts },
    };
    if ('auto_reconnect' in params) {
      options.auto_reconnect = Boolean(params.auto_reconnect);
    }
    if ('heartbeat_interval' in params) {
      options.heartbeat_interval = Number(params.heartbeat_interval);
    }
    if ('token_refresh_before' in params) {
      options.token_refresh_before = Number(params.token_refresh_before);
    }
    if (params.retry && typeof params.retry === 'object') {
      Object.assign(options.retry, params.retry);
    }
    if (params.timeouts && typeof params.timeouts === 'object') {
      Object.assign(options.timeouts, params.timeouts);
    }
    return options;
  }

  // ── 内部：后台任务 ────────────────────────────────

  private _startBackgroundTasks(): void {
    this._startHeartbeat();
    this._startTokenRefresh();
    this._startPrekeyRefresh();
    this._startGroupEpochTasks();
  }

  private _stopBackgroundTasks(): void {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._tokenRefreshTimer !== null) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }
    if (this._prekeyRefreshTimer !== null) {
      clearInterval(this._prekeyRefreshTimer);
      this._prekeyRefreshTimer = null;
    }
    if (this._groupEpochCleanupTimer !== null) {
      clearInterval(this._groupEpochCleanupTimer);
      this._groupEpochCleanupTimer = null;
    }
    if (this._groupEpochRotateTimer !== null) {
      clearInterval(this._groupEpochRotateTimer);
      this._groupEpochRotateTimer = null;
    }
  }

  /** 心跳定时器 */
  private _startHeartbeat(): void {
    if (this._heartbeatTimer !== null) return;
    const interval = this._sessionOptions.heartbeat_interval * 1000;
    if (interval <= 0) return;

    this._heartbeatTimer = setInterval(async () => {
      if (this._state !== 'connected' || this._closing) return;
      try {
        await this._transport.call('meta.ping', {});
      } catch (exc) {
        this._dispatcher.publish('connection.error', { error: exc });
      }
    }, interval);
  }

  /** Token 刷新定时器 */
  private _startTokenRefresh(): void {
    if (this._tokenRefreshTimer !== null) return;

    const scheduleRefresh = () => {
      if (this._closing) return;
      const lead = this._sessionOptions.token_refresh_before;
      const minimumDelay = 1000;

      if (this._state !== 'connected' || !this._gatewayUrl) {
        this._tokenRefreshTimer = globalThis.setTimeout(scheduleRefresh, minimumDelay);
        return;
      }

      let identity = this._identity;
      if (!identity) {
        this._tokenRefreshTimer = globalThis.setTimeout(scheduleRefresh, minimumDelay);
        return;
      }

      const expiresAt = this._auth.getAccessTokenExpiry(identity);
      if (expiresAt === null) {
        this._tokenRefreshTimer = globalThis.setTimeout(scheduleRefresh, minimumDelay);
        return;
      }

      const delay = Math.max((expiresAt - lead) * 1000 - Date.now(), minimumDelay);
      this._tokenRefreshTimer = globalThis.setTimeout(async () => {
        if (this._state !== 'connected' || !this._gatewayUrl || this._closing) {
          scheduleRefresh();
          return;
        }
        try {
          identity = await this._auth.refreshCachedTokens(this._gatewayUrl!, identity!);
          this._identity = identity;
          if (this._sessionParams && identity.access_token) {
            this._sessionParams.access_token = identity.access_token;
          }
          await this._dispatcher.publish('token.refreshed', {
            aid: identity.aid,
            expires_at: identity.access_token_expires_at,
          });
        } catch (exc) {
          if (exc instanceof AuthError) {
            console.debug('token 刷新失败，下次重试:', exc);
          } else {
            this._dispatcher.publish('connection.error', { error: exc });
          }
        }
        scheduleRefresh();
      }, delay);
    };

    scheduleRefresh();
  }

  /** Prekey 轮换定时器 */
  private _startPrekeyRefresh(): void {
    if (this._prekeyRefreshTimer !== null) return;
    const interval = Number((this.config as Record<string, unknown>).prekey_refresh_interval ?? 3600) * 1000;

    this._prekeyRefreshTimer = setInterval(async () => {
      if (this._state !== 'connected' || this._closing) return;
      try {
        await this._uploadPrekey();
      } catch (exc) {
        console.warn('prekey 轮换失败:', exc);
      }
    }, interval);
  }

  /** 群组 epoch 后台任务 */
  private _startGroupEpochTasks(): void {
    if (!this.configModel.groupE2ee) return;

    // 旧 epoch 清理（每小时）
    if (this._groupEpochCleanupTimer === null) {
      this._groupEpochCleanupTimer = setInterval(async () => {
        if (this._state !== 'connected' || this._closing || !this._aid) return;
        try {
          const metadata = await this._keystore.loadMetadata(this._aid!);
          const groupSecrets = (metadata?.group_secrets ?? {}) as Record<string, unknown>;
          const retention = this.configModel.oldEpochRetentionSeconds;
          for (const gid of Object.keys(groupSecrets)) {
            await this._groupE2ee.cleanup(gid, retention);
          }
        } catch (exc) {
          console.debug('epoch 清理失败:', exc);
        }
      }, 3600 * 1000);
    }

    // 定时 epoch 轮换
    const rotateInterval = this.configModel.epochAutoRotateInterval;
    if (rotateInterval > 0 && this._groupEpochRotateTimer === null) {
      this._groupEpochRotateTimer = setInterval(async () => {
        if (this._state !== 'connected' || this._closing || !this._aid) return;
        try {
          const metadata = await this._keystore.loadMetadata(this._aid!);
          const groupSecrets = (metadata?.group_secrets ?? {}) as Record<string, unknown>;
          for (const gid of Object.keys(groupSecrets)) {
            await this._rotateGroupEpoch(gid);
          }
        } catch (exc) {
          console.debug('epoch 定时轮换失败:', exc);
        }
      }, rotateInterval * 1000);
    }
  }

  // ── 内部：断线重连 ────────────────────────────────

  private async _handleTransportDisconnect(error: Error | null): Promise<void> {
    if (this._closing || this._state === 'closed') return;
    this._state = 'disconnected';
    await this._dispatcher.publish('connection.state', {
      state: this._state,
      error,
    });

    if (!this._sessionOptions.auto_reconnect) return;
    if (this._reconnectActive) return;

    this._reconnectActive = true;
    this._reconnectAbort = new AbortController();
    this._safeAsync(this._reconnectLoop());
  }

  /** 指数退避重连循环（无限重试，仅在不可重试错误或 close() 时终止） */
  private async _reconnectLoop(): Promise<void> {
    const retry = { ...this._sessionOptions.retry };
    const initialDelay = retry.initial_delay;
    const maxDelay = retry.max_delay;
    let delay = initialDelay;

    for (let attempt = 1; !this._reconnectAbort?.signal.aborted; attempt++) {
      this._state = 'reconnecting';
      await this._dispatcher.publish('connection.state', {
        state: this._state,
        attempt,
      });

      try {
        await this._sleep(delay * 1000);
        if (this._reconnectAbort?.signal.aborted) {
          this._reconnectActive = false;
          return;
        }
        await this._transport.close();
        if (!this._sessionParams) {
          throw new StateError('missing connect params for reconnect');
        }
        await this._connectOnce(this._sessionParams, true);
        this._reconnectActive = false;
        this._reconnectAbort = null;
        return;
      } catch (exc) {
        await this._dispatcher.publish('connection.error', {
          error: exc,
          attempt,
        });
        if (!this._shouldRetryReconnect(exc as Error)) {
          this._state = 'terminal_failed';
          this._reconnectActive = false;
          this._reconnectAbort = null;
          await this._dispatcher.publish('connection.state', {
            state: this._state,
            error: exc,
            attempt,
          });
          return;
        }
        delay = Math.min(delay * 2, maxDelay);
      }
    }

    this._reconnectActive = false;
    this._reconnectAbort = null;
  }

  /** 判断是否应重试重连 */
  private _shouldRetryReconnect(error: Error): boolean {
    if (error instanceof AuthError || error instanceof PermissionError
      || error instanceof ValidationError || error instanceof StateError) {
      return false;
    }
    if (error instanceof ConnectionError) return true;
    if (error instanceof AUNError) return error.retryable;
    // 网络相关错误默认重试
    return true;
  }

  // ── 内部：工具方法 ────────────────────────────────

  /** 发布 E2EE 编排错误事件 */
  private _logE2eeError(stage: string, groupId: string, aid: string, exc: Error): void {
    try {
      this._dispatcher.publish('e2ee.orchestration_error', {
        stage,
        group_id: groupId,
        aid,
        error: String(exc),
      });
    } catch { /* 日志本身不应阻断主流程 */ }
  }

  /** 安全执行异步操作（不阻塞调用方，错误只打日志） */
  private _safeAsync(promise: Promise<unknown>): void {
    promise.catch((exc) => {
      console.debug('后台任务异常:', exc);
    });
  }

  /** 可取消的 sleep */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    });
  }
}

// ── 内部工具 ────────────────────────────────────────

/** 生成 UUID v4 */
function _uuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
