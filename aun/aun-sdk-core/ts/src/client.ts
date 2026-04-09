/**
 * AUNClient — AUN Core SDK 主客户端
 *
 * 完整实现，与 Python SDK client.py 对齐。
 * 功能：
 * - 连接/断线重连/关闭
 * - RPC 调用（含 E2EE 自动加解密编排）
 * - 事件自动解密管线（P2P + 群组）
 * - 后台任务（心跳、token 刷新、prekey 轮换、epoch 清理/轮换）
 * - 客户端签名（关键操作）
 * - 群组 E2EE 全自动编排（建群/加人/踢人/退出）
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

import { configFromMap, type AUNConfig } from './config.js';
import { CryptoProvider } from './crypto.js';
import { GatewayDiscovery } from './discovery.js';
import { E2EEManager } from './e2ee.js';
import {
  GroupE2EEManager,
  computeMembershipCommitment,
  storeGroupSecret,
  buildKeyDistribution,
  buildMembershipManifest,
  signMembershipManifest,
} from './e2ee-group.js';
import {
  AUNError,
  AuthError,
  ConnectionError,
  E2EEError,
  PermissionError,
  StateError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import { EventDispatcher, type Subscription, type EventHandler } from './events.js';
import { FileKeyStore } from './keystore/file.js';
import type { KeyStore } from './keystore/index.js';
import { AuthNamespace } from './namespaces/auth.js';
import { RPCTransport } from './transport.js';
import { AuthFlow } from './auth.js';

// ── 日志辅助 ──────────────────────────────────────────────────

/** 简易日志：前缀 [aun_core.client] */
function _clientLog(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  const formatted = args.reduce<string>((s, a) => s.replace('%s', String(a)), msg);
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [aun_core.client] ${level}: ${formatted}`);
}

/**
 * 递归排序键的 JSON 序列化（Canonical JSON for AUN）
 * 等价于 Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)
 * 非 ASCII 字符直接以 UTF-8 输出，与 AAD 序列化规则一致。
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

// ── 常量 ──────────────────────────────────────────────────────

/** 内部专用方法，禁止外部直接调用 */
const INTERNAL_ONLY_METHODS = new Set([
  'auth.login1',
  'auth.aid_login1',
  'auth.login2',
  'auth.aid_login2',
  'auth.connect',
  'auth.refresh_token',
  'initialize',
]);

/** 默认会话选项 */
const DEFAULT_SESSION_OPTIONS: Record<string, unknown> = {
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

/** 需要客户端签名的关键方法 */
const SIGNED_METHODS = new Set([
  'group.send', 'group.kick', 'group.add_member',
  'group.leave', 'group.remove_member', 'group.update_rules',
]);

/** peer 证书缓存 TTL（10 分钟） */
const PEER_CERT_CACHE_TTL = 600;

// ── 内部类型 ──────────────────────────────────────────────────

interface CachedPeerCert {
  certPem: string;
  validatedAt: number;
  refreshAfter: number;
}

// ── HTTP 辅助 ─────────────────────────────────────────────────

/** 发起 HTTP GET 请求，返回文本内容 */
function _httpGetText(url: string, verifySsl: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = { timeout: 30_000 };
    if (!verifySsl) {
      options.rejectUnauthorized = false;
    }
    const req = mod.get(url, options, (res: http.IncomingMessage) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout fetching ${url}`));
    });
  });
}

/**
 * AUN Core SDK 主客户端
 */
export class AUNClient {
  /** 原始配置 */
  readonly config: Record<string, unknown>;

  /** 解析后的配置模型 */
  private _configModel: AUNConfig;

  /** 当前 AID */
  private _aid: string | null = null;

  /** 当前身份信息（内存缓存） */
  private _identity: Record<string, unknown> | null = null;

  /** 连接状态 */
  private _state: string = 'idle';

  /** Gateway URL */
  private _gatewayUrl: string | null = null;

  /** 是否正在关闭 */
  private _closing = false;

  /** 事件调度器 */
  private _dispatcher: EventDispatcher;

  /** Gateway 发现 */
  private _discovery: GatewayDiscovery;

  /** 传输层 */
  private _transport: RPCTransport;

  /** 认证流程 */
  private _auth: AuthFlow;

  /** 密钥存储 */
  private _keystore: KeyStore;

  /** E2EE 管理器 */
  private _e2ee: E2EEManager;

  /** 群组 E2EE 管理器 */
  private _groupE2ee: GroupE2EEManager;

  /** Auth 命名空间 */
  readonly auth: AuthNamespace;

  /** 会话参数（重连用） */
  private _sessionParams: Record<string, unknown> | null = null;

  /** 会话选项 */
  private _sessionOptions: Record<string, unknown> = { ...DEFAULT_SESSION_OPTIONS };

  /** peer 证书缓存 */
  private _certCache: Map<string, CachedPeerCert> = new Map();

  // ── 后台任务定时器 ──────────────────────────────────────────
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _prekeyRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private _groupEpochCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _groupEpochRotateTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnecting = false;

  constructor(config?: Record<string, unknown>) {
    const rawConfig = { ...(config ?? {}) };
    this.config = rawConfig;
    this._configModel = configFromMap(rawConfig);

    this._dispatcher = new EventDispatcher();
    this._discovery = new GatewayDiscovery({ verifySsl: this._configModel.verifySsl });

    const keystore = (rawConfig.keystore as KeyStore | undefined) ?? new FileKeyStore(
      this._configModel.aunPath,
      {
        secretStore: rawConfig.secret_store as undefined,
        encryptionSeed: this._configModel.encryptionSeed ?? undefined,
      },
    );
    this._keystore = keystore;

    this._auth = new AuthFlow({
      keystore,
      crypto: (rawConfig.crypto as CryptoProvider | undefined) ?? new CryptoProvider(),
      aid: null,
      rootCaPath: rawConfig.root_ca_path as string | undefined,
      verifySsl: this._configModel.verifySsl,
    });

    this._transport = new RPCTransport({
      eventDispatcher: this._dispatcher,
      timeout: 10_000,
      onDisconnect: (err) => this._handleTransportDisconnect(err),
    });

    this._e2ee = new E2EEManager({
      identityFn: () => this._identity ?? {},
      keystore,
      replayWindowSeconds: this._configModel.replayWindowSeconds,
    });

    this._groupE2ee = new GroupE2EEManager({
      identityFn: () => this._identity ?? {},
      keystore,
      senderCertResolver: (aid: string) => this._getVerifiedPeerCert(aid),
      initiatorCertResolver: (aid: string) => this._getVerifiedPeerCert(aid),
    });

    this.auth = new AuthNamespace(this);

    // 内部订阅：推送消息自动解密后 re-publish 给用户
    this._dispatcher.subscribe('_raw.message.received', (data) => this._onRawMessageReceived(data));
    // 群组消息推送：自动解密后 re-publish
    this._dispatcher.subscribe('_raw.group.message_created', (data) => this._onRawGroupMessageCreated(data));
    // 群组变更事件：拦截处理成员变更触发的 epoch 轮换，然后透传
    this._dispatcher.subscribe('_raw.group.changed', (data) => this._onRawGroupChanged(data));
    // 其他事件直接透传
    for (const evt of ['message.recalled', 'message.ack']) {
      this._dispatcher.subscribe(`_raw.${evt}`, (data) => this._dispatcher.publish(evt, data));
    }
  }

  // ── 属性 ──────────────────────────────────────────────────

  /** 当前 AID */
  get aid(): string | null {
    return this._aid;
  }

  /** 连接状态 */
  get state(): string {
    return this._state;
  }

  /** E2EE 管理器 */
  get e2ee(): E2EEManager {
    return this._e2ee;
  }

  /** 群组 E2EE 管理器 */
  get groupE2ee(): GroupE2EEManager {
    return this._groupE2ee;
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /**
   * 连接到 Gateway。
   *
   * @param auth - 认证参数（必须包含 access_token 和 gateway）
   * @param options - 会话选项（auto_reconnect、heartbeat_interval 等）
   */
  async connect(
    auth: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<void> {
    if (this._state !== 'idle' && this._state !== 'closed') {
      throw new StateError(`connect not allowed in state ${this._state}`);
    }
    const params = { ...auth };
    if (options) Object.assign(params, options);
    const normalized = this._normalizeConnectParams(params);
    this._sessionParams = normalized;
    this._sessionOptions = this._buildSessionOptions(normalized);
    const callTimeoutSec = (this._sessionOptions.timeouts as Record<string, number>)?.call;
    this._transport.setTimeout(
      callTimeoutSec != null ? callTimeoutSec * 1000 : 10_000,
    );
    this._closing = false;
    await this._connectOnce(normalized, false);
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    this._closing = true;
    this._stopBackgroundTasks();
    this._stopReconnect();
    if (this._state === 'idle' || this._state === 'closed') {
      this._state = 'closed';
      return;
    }
    await this._transport.close();
    this._state = 'closed';
    await this._dispatcher.publish('connection.state', { state: this._state });
  }

  // ── RPC ───────────────────────────────────────────────────

  /**
   * 发送 JSON-RPC 调用。
   * 自动处理内部方法限制、E2EE 加解密、客户端签名等。
   */
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this._state !== 'connected') {
      throw new ConnectionError('client is not connected');
    }
    if (INTERNAL_ONLY_METHODS.has(method)) {
      throw new PermissionError(`method is internal_only: ${method}`);
    }

    const p = { ...(params ?? {}) };

    // 自动加密：message.send 默认加密（encrypt 默认 True）
    if (method === 'message.send') {
      const encrypt = p.encrypt ?? true;
      delete p.encrypt;
      if (encrypt) {
        return await this._sendEncrypted(p);
      }
    }

    // 自动加密：group.send 默认加密（encrypt 默认 True）
    if (method === 'group.send') {
      const encrypt = p.encrypt ?? true;
      delete p.encrypt;
      if (encrypt) {
        return await this._sendGroupEncrypted(p);
      }
    }

    // 关键操作自动附加客户端签名
    if (SIGNED_METHODS.has(method)) {
      this._signClientOperation(method, p);
    }

    let result = await this._transport.call(method, p) as Record<string, unknown> | unknown;

    // 自动解密：message.pull 返回的消息
    if (method === 'message.pull' && result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      const messages = r.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        r.messages = await this._decryptMessages(messages as Record<string, unknown>[]);
      }
    }

    // 自动解密：group.pull 返回的群消息
    if (method === 'group.pull' && result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      const messages = r.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        r.messages = await this._decryptGroupMessages(messages as Record<string, unknown>[]);
      }
    }

    // ── Group E2EE 自动编排 ────────────────────────────
    if (this._configModel.groupE2ee) {
      // 建群后自动创建 epoch（幂等：已有 secret 时跳过）
      if (method === 'group.create' && result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        const group = (r.group ?? {}) as Record<string, unknown>;
        const gid = String(group.group_id ?? '');
        if (gid && this._aid && !this._groupE2ee.hasSecret(gid)) {
          try {
            this._groupE2ee.createEpoch(gid, [this._aid]);
            // 同步到服务端：将服务端 epoch 从 0 推到 1
            this._syncEpochToServer(gid).catch((exc) =>
              this._logE2eeError('sync_epoch', gid, '', exc as Error),
            );
          } catch (exc) {
            this._logE2eeError('create_epoch', gid, '', exc as Error);
          }
        }
      }

      // 加人后自动分发密钥给新成员
      if (method === 'group.add_member') {
        const groupId = String(p.group_id ?? '');
        const newAid = String(p.aid ?? '');
        if (groupId && newAid) {
          if (this._configModel.rotateOnJoin) {
            this._rotateGroupEpoch(groupId).catch((exc) =>
              this._logE2eeError('rotate_epoch', groupId, '', exc as Error),
            );
          } else {
            this._distributeKeyToNewMember(groupId, newAid).catch((exc) =>
              this._logE2eeError('distribute_key', groupId, newAid, exc as Error),
            );
          }
        }
      }

      // 踢人后自动轮换 epoch
      if (method === 'group.kick') {
        const groupId = String(p.group_id ?? '');
        if (groupId) {
          this._rotateGroupEpoch(groupId).catch((exc) =>
            this._logE2eeError('rotate_epoch', groupId, '', exc as Error),
          );
        }
      }

      // 审批通过后自动分发密钥给新成员
      if (method === 'group.review_join_request' && result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (r.approved || r.status === 'approved') {
          const groupId = String(p.group_id ?? '');
          const newAid = String(p.aid ?? '');
          if (groupId && newAid) {
            this._distributeKeyToNewMember(groupId, newAid).catch((exc) =>
              this._logE2eeError('distribute_key', groupId, newAid, exc as Error),
            );
          }
        }
      }

      // 批量审批通过后分发密钥
      if (method === 'group.batch_review_join_request' && result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        const groupId = String(p.group_id ?? '');
        const approvedAids = ((r.results as Record<string, unknown>[] | undefined) ?? [])
          .filter((item) => item.ok && item.status === 'approved' && item.aid)
          .map((item) => String(item.aid));
        if (groupId && approvedAids.length > 0) {
          if (this._configModel.rotateOnJoin) {
            this._rotateGroupEpoch(groupId).catch((exc) =>
              this._logE2eeError('rotate_epoch', groupId, '', exc as Error),
            );
          } else {
            for (const aid of approvedAids) {
              this._distributeKeyToNewMember(groupId, aid).catch((exc) =>
                this._logE2eeError('distribute_key', groupId, aid, exc as Error),
              );
            }
          }
        }
      }
    }

    return result;
  }

  // ── 便利方法 ──────────────────────────────────────────────

  /** 心跳检测 */
  async ping(params?: Record<string, unknown>): Promise<unknown> {
    return await this.call('meta.ping', params ?? {});
  }

  /** 获取服务端状态 */
  async status(params?: Record<string, unknown>): Promise<unknown> {
    return await this.call('meta.status', params ?? {});
  }

  /** 获取信任根证书列表 */
  async trustRoots(params?: Record<string, unknown>): Promise<unknown> {
    return await this.call('meta.trust_roots', params ?? {});
  }

  // ── 事件 ──────────────────────────────────────────────────

  /** 订阅事件 */
  on(event: string, handler: EventHandler): Subscription {
    return this._dispatcher.subscribe(event, handler);
  }

  // ── E2EE 加密发送 ────────────────────────────────────────

  /** 自动加密并发送 P2P 消息 */
  private async _sendEncrypted(params: Record<string, unknown>): Promise<unknown> {
    const toAid = String(params.to ?? '');
    const payload = params.payload;
    const messageId = String(params.message_id ?? '') || crypto.randomUUID();
    const timestamp = (params.timestamp as number) ?? Date.now();

    // 获取对方证书
    const peerCertPem = await this._fetchPeerCert(toAid);

    // 获取对方 prekey（可能没有）
    const prekey = await this._fetchPeerPrekey(toAid);

    const [envelope, encryptResult] = this._e2ee.encryptOutbound(
      toAid,
      payload as Record<string, unknown>,
      peerCertPem,
      prekey,
      messageId,
      timestamp,
    );
    if (!encryptResult.encrypted) {
      throw new E2EEError(`failed to encrypt message to ${toAid}`);
    }

    // 严格模式：拒绝无前向保密的降级
    if (this._configModel.requireForwardSecrecy && !encryptResult.forward_secrecy) {
      throw new E2EEError(
        `forward secrecy required but unavailable for ${toAid} ` +
        `(mode=${encryptResult.mode})`,
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
        _clientLog('warn', '发布 e2ee.degraded 事件失败: %s', exc);
      }
    }

    const sendParams: Record<string, unknown> = {
      to: toAid,
      payload: envelope,
      type: 'e2ee.encrypted',
      encrypted: true,
      message_id: messageId,
      timestamp,
      persist: params.persist ?? true,
    };
    return await this._transport.call('message.send', sendParams);
  }

  /** 自动加密并发送群组消息 */
  private async _sendGroupEncrypted(params: Record<string, unknown>): Promise<unknown> {
    const groupId = String(params.group_id ?? '');
    const payload = params.payload;
    if (!groupId) {
      throw new ValidationError('group.send requires group_id');
    }

    const envelope = this._groupE2ee.encrypt(groupId, payload);

    const sendParams: Record<string, unknown> = {
      group_id: groupId,
      payload: envelope,
      type: 'e2ee.group_encrypted',
      encrypted: true,
    };
    this._signClientOperation('group.send', sendParams);
    return await this._transport.call('group.send', sendParams);
  }

  // ── 客户端签名 ────────────────────────────────────────────

  /**
   * 为关键操作附加客户端 ECDSA 签名（client_signature 字段）。
   * 签名覆盖所有非 _ 前缀且非 client_signature 的业务字段。
   */
  private _signClientOperation(method: string, params: Record<string, unknown>): void {
    const identity = this._identity;
    if (!identity || !identity.private_key_pem) return;

    try {
      const aid = String(identity.aid ?? '');
      const ts = String(Math.floor(Date.now() / 1000));

      // 计算 params hash — 必须递归排序所有键（与 Python json.dumps(sort_keys=True, separators=(",",":")) 一致）
      const paramsForHash: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (k !== 'client_signature' && !k.startsWith('_')) {
          paramsForHash[k] = v;
        }
      }
      const paramsJson = stableStringify(paramsForHash);
      const paramsHash = crypto.createHash('sha256').update(paramsJson, 'utf-8').digest('hex');

      const signData = Buffer.from(`${method}|${aid}|${ts}|${paramsHash}`, 'utf-8');
      const privateKey = crypto.createPrivateKey(String(identity.private_key_pem));
      const signature = crypto.sign('SHA256', signData, privateKey);

      params.client_signature = {
        aid,
        timestamp: ts,
        params_hash: paramsHash,
        signature: signature.toString('base64'),
      };
    } catch (exc) {
      _clientLog('warn', '客户端签名失败，继续发送无签名请求: %s', exc);
    }
  }

  // ── 事件自动解密管线 ──────────────────────────────────────

  /** 处理 transport 层推送的原始 P2P 消息 */
  private async _onRawMessageReceived(data: unknown): Promise<void> {
    // 异步处理，不阻塞事件调度
    this._processAndPublishMessage(data).catch((exc) => {
      _clientLog('debug', '解密失败: %s', exc);
    });
  }

  /** 实际处理推送消息的异步任务 */
  private async _processAndPublishMessage(data: unknown): Promise<void> {
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
  }

  /** 处理群组消息推送：自动解密后 re-publish */
  private async _onRawGroupMessageCreated(data: unknown): Promise<void> {
    this._processAndPublishGroupMessage(data).catch((exc) => {
      _clientLog('debug', '群消息解密失败: %s', exc);
    });
  }

  /** 处理群组推送消息的异步任务 */
  private async _processAndPublishGroupMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') {
      await this._dispatcher.publish('group.message_created', data);
      return;
    }
    const msg = { ...(data as Record<string, unknown>) };
    const decrypted = await this._decryptGroupMessage(msg);
    await this._dispatcher.publish('group.message_created', decrypted);
  }

  /**
   * 处理群组变更事件：透传给用户，并在成员离开/被踢时自动触发 epoch 轮换。
   * 按协议，轮换由剩余在线 admin/owner 负责。
   */
  private async _onRawGroupChanged(data: unknown): Promise<void> {
    await this._dispatcher.publish('group.changed', data);

    // 成员退出或被踢 → 剩余 admin/owner 自动补位轮换
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (d.action === 'member_left' || d.action === 'member_removed') {
        const groupId = String(d.group_id ?? '');
        if (groupId) {
          this._rotateGroupEpoch(groupId).catch((exc) =>
            this._logE2eeError('rotate_epoch', groupId, '', exc as Error),
          );
        }
      }
    }
  }

  /** 尝试处理 P2P 传输的群组密钥消息。返回 true 表示已处理（不再传播）。 */
  private async _tryHandleGroupKeyMessage(message: Record<string, unknown>): Promise<boolean> {
    const payload = message.payload;
    if (!payload || typeof payload !== 'object') return false;

    const payloadObj = payload as Record<string, unknown>;

    // 先解密 P2P E2EE（如果是加密的）
    // 注意：用 _decrypt_message 而非 decrypt_message，避免消耗 seen set
    let actualPayload = payloadObj;
    if (payloadObj.type === 'e2ee.encrypted') {
      const fromAid = String(message.from ?? '');
      if (fromAid) {
        await this._ensureSenderCertCached(fromAid);
      }
      const decrypted = this._e2ee._decryptMessage(message);
      if (decrypted === null) return false;
      actualPayload = (decrypted.payload ?? {}) as Record<string, unknown>;
      if (!actualPayload || typeof actualPayload !== 'object') return false;
    }

    const result = this._groupE2ee.handleIncoming(actualPayload);
    if (result === null) return false;

    if (result === 'request') {
      // 处理密钥请求并回复
      const groupId = String(actualPayload.group_id ?? '');
      const requester = String(actualPayload.requester_aid ?? '');
      let members = this._groupE2ee.getMemberAids(groupId);

      // 请求者不在本地成员列表时，回源查询服务端最新成员列表
      if (requester && !members.includes(requester)) {
        try {
          const membersResult = await this.call('group.get_members', { group_id: groupId }) as Record<string, unknown>;
          members = ((membersResult.members ?? []) as Record<string, unknown>[]).map(
            (m) => String(m.aid),
          );
          // 更新本地当前 epoch 的 member_aids/commitment
          if (members.includes(requester)) {
            const secretData = this._groupE2ee.loadSecret(groupId);
            if (secretData && this._aid) {
              const epoch = secretData.epoch as number;
              const commitment = computeMembershipCommitment(
                members, epoch, groupId, secretData.secret as Buffer,
              );
              storeGroupSecret(
                this._keystore, this._aid, groupId, epoch,
                secretData.secret as Buffer, commitment, members,
              );
            }
          }
        } catch (exc) {
          _clientLog('warn', '群组 %s 成员列表回源失败: %s', groupId, exc);
        }
      }

      const response = this._groupE2ee.handleKeyRequestMsg(actualPayload, members);
      if (response && requester) {
        try {
          await this.call('message.send', {
            to: requester,
            payload: response,
            encrypt: true,
            persist: false,
          });
        } catch (exc) {
          _clientLog('warn', '向 %s 回复群组密钥失败: %s', requester, exc);
        }
      }
    }

    return true;
  }

  // ── E2EE 编排辅助 ─────────────────────────────────────────

  /**
   * 获取对方证书（带缓存 + 完整 PKI 验证）。
   * 跨域时自动路由到 peer 所在域的 Gateway。
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
    const peerGatewayUrl = AUNClient._resolvePeerGatewayUrl(gatewayUrl, aid);
    const certUrl = AUNClient._buildCertUrl(peerGatewayUrl, aid);
    const certPem = await _httpGetText(certUrl, this._configModel.verifySsl);

    // 完整 PKI 验证
    try {
      await this._auth.verifyPeerCertificate(peerGatewayUrl, certPem, aid);
    } catch (exc) {
      throw new ValidationError(
        `peer cert verification failed for ${aid}: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }

    const nowSec = Date.now() / 1000;
    this._certCache.set(aid, {
      certPem,
      validatedAt: nowSec,
      refreshAfter: nowSec + PEER_CERT_CACHE_TTL,
    });

    // 同步写入 keystore，保证 E2EE 解密时能读到
    try {
      this._keystore.saveCert(aid, certPem);
    } catch (exc) {
      _clientLog('error', '写入证书到 keystore 失败 (aid=%s): %s', aid, exc);
    }

    return certPem;
  }

  /** 获取对方的 prekey（通过 E2EEManager 缓存） */
  private async _fetchPeerPrekey(peerAid: string): Promise<Record<string, unknown> | null> {
    const cached = this._e2ee.getCachedPrekey(peerAid);
    if (cached !== null) return cached;

    try {
      const result = await this._transport.call('message.e2ee.get_prekey', { aid: peerAid }) as Record<string, unknown>;
      if (result && result.found) {
        const prekey = result.prekey as Record<string, unknown> | undefined;
        if (prekey) {
          this._e2ee.cachePrekey(peerAid, prekey);
        }
        return prekey ?? null;
      }
    } catch (exc) {
      _clientLog('debug', 'prekey 获取失败: %s', exc);
    }
    return null;
  }

  /** 生成 prekey 并上传到服务端 */
  private async _uploadPrekey(): Promise<Record<string, unknown>> {
    const prekeyMaterial = this._e2ee.generatePrekey();
    const result = await this._transport.call('message.e2ee.put_prekey', prekeyMaterial);
    return (result && typeof result === 'object') ? result as Record<string, unknown> : { ok: true };
  }

  /**
   * 确保发送方证书在本地 keystore 中可用且未过期。
   * 返回 true 表示证书已就绪（PKI 验证通过），false 表示不可用。
   */
  private async _ensureSenderCertCached(aid: string): Promise<boolean> {
    const cached = this._certCache.get(aid);
    const now = Date.now() / 1000;
    if (cached && now < cached.refreshAfter) {
      return true;
    }
    try {
      const certPem = await this._fetchPeerCert(aid);
      this._keystore.saveCert(aid, certPem);
      return true;
    } catch (exc) {
      // 刷新失败时：若内存缓存有 PKI 验证过的证书（未过期 x2 倍 TTL）则继续用
      if (cached && now < cached.validatedAt + PEER_CERT_CACHE_TTL * 2) {
        _clientLog('debug', '刷新发送方 %s 证书失败，继续使用已验证的内存缓存: %s', aid, exc);
        return true;
      }
      _clientLog('warn', '获取发送方 %s 证书失败且无已验证缓存，拒绝信任: %s', aid, exc);
      return false;
    }
  }

  /**
   * 获取经过 PKI 验证的 peer 证书（仅信任内存缓存中已验证的证书）。
   * 零信任：不直接信任 keystore 中可能由恶意服务端注入的证书。
   */
  private _getVerifiedPeerCert(aid: string): string | null {
    const cached = this._certCache.get(aid);
    const now = Date.now() / 1000;
    if (cached && now < cached.validatedAt + PEER_CERT_CACHE_TTL * 2) {
      return cached.certPem;
    }
    return null;
  }

  /** 解密单条 P2P 消息 */
  private async _decryptSingleMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = message.payload;
    if (!payload || typeof payload !== 'object') return message;
    const payloadObj = payload as Record<string, unknown>;
    if (payloadObj.type !== 'e2ee.encrypted') return message;
    if (message.encrypted === false) return message;

    // 确保发送方证书已缓存到 keystore
    const fromAid = String(message.from ?? '');
    if (fromAid) {
      const certReady = await this._ensureSenderCertCached(fromAid);
      if (!certReady) {
        _clientLog('warn', '无法获取发送方 %s 的证书，跳过解密', fromAid);
        return message;
      }
    }

    // 密码学解密（E2EEManager.decryptMessage 内含本地防重放）
    const decrypted = this._e2ee.decryptMessage(message);
    return decrypted !== null ? decrypted : message;
  }

  /** 批量解密 P2P 消息（用于 message.pull） */
  private async _decryptMessages(messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const seenInBatch = new Set<string>();
    const result: Record<string, unknown>[] = [];
    for (const msg of messages) {
      const mid = String(msg.message_id ?? '');
      if (mid && seenInBatch.has(mid)) continue;
      if (mid) seenInBatch.add(mid);

      const payload = msg.payload;
      if (payload && typeof payload === 'object'
        && (payload as Record<string, unknown>).type === 'e2ee.encrypted'
        && (msg.encrypted === true || !('encrypted' in msg))) {
        const fromAid = String(msg.from ?? '');
        if (fromAid) {
          const certReady = await this._ensureSenderCertCached(fromAid);
          if (!certReady) {
            _clientLog('warn', '无法获取发送方 %s 的证书，跳过解密', fromAid);
            result.push(msg);
            continue;
          }
        }
        // 用 _decryptMessage 而非 decryptMessage，避免消耗 seen set
        const decrypted = this._e2ee._decryptMessage(msg);
        result.push(decrypted !== null ? decrypted : msg);
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  /** 解密单条群组消息 */
  private async _decryptGroupMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = message.payload;
    if (!payload || typeof payload !== 'object') return message;
    const payloadObj = payload as Record<string, unknown>;
    if (payloadObj.type !== 'e2ee.group_encrypted') return message;

    // 确保发送方证书已缓存（签名验证需要）
    const senderAid = String(message.from ?? message.sender_aid ?? '');
    if (senderAid) {
      const certOk = await this._ensureSenderCertCached(senderAid);
      if (!certOk) {
        _clientLog('warn', '群消息解密跳过：发送方 %s 证书不可用', senderAid);
        return message;
      }
    }

    // 先尝试直接解密
    const result = this._groupE2ee.decrypt(message);
    if (result !== null && result.e2ee) {
      return result;
    }

    // 解密失败，尝试密钥恢复后重试
    const groupId = String(message.group_id ?? '');
    const sender = String(message.from ?? message.sender_aid ?? '');
    const epoch = payloadObj.epoch as number | undefined;
    if (epoch != null && groupId) {
      const recovery = this._groupE2ee.buildRecoveryRequest(groupId, epoch, sender);
      if (recovery) {
        try {
          await this.call('message.send', {
            to: recovery.to,
            payload: recovery.payload,
            encrypt: true,
            persist: false,
          });
        } catch (exc) {
          _clientLog('debug', '密钥恢复请求失败: %s', exc);
        }
      }
    }

    return message;
  }

  /** 批量解密群组消息（用于 group.pull） */
  private async _decryptGroupMessages(messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    for (const msg of messages) {
      const decrypted = await this._decryptGroupMessage(msg);
      result.push(decrypted);
    }
    return result;
  }

  // ── Group E2EE 编排 ───────────────────────────────────────

  /** 建群后将本地 epoch 1 同步到服务端（服务端初始为 0） */
  private async _syncEpochToServer(groupId: string): Promise<void> {
    try {
      const rotateParams: Record<string, unknown> = {
        group_id: groupId,
        current_epoch: 0,
      };
      Object.assign(rotateParams, this._buildRotationSignature(groupId, 0, 1));
      await this.call('group.e2ee.rotate_epoch', rotateParams);
    } catch (exc) {
      _clientLog('debug', '同步 epoch 到服务端失败 (group=%s，可能已同步): %s', groupId, exc);
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
      const currentEpoch = (epochResult.epoch as number) ?? 0;

      // 2. CAS 尝试递增
      const rotateParams: Record<string, unknown> = {
        group_id: groupId,
        current_epoch: currentEpoch,
      };
      Object.assign(rotateParams, this._buildRotationSignature(groupId, currentEpoch, currentEpoch + 1));
      const casResult = await this.call('group.e2ee.rotate_epoch', rotateParams) as Record<string, unknown>;
      if (!casResult.success) return; // CAS 失败，放弃

      const newEpoch = casResult.epoch as number;

      // 3. 获取最新成员列表
      const membersResult = await this.call('group.get_members', { group_id: groupId }) as Record<string, unknown>;
      const memberAids = ((membersResult.members ?? []) as Record<string, unknown>[]).map(
        (m) => String(m.aid),
      );

      // 4. 本地生成密钥 + 存储 + 分发
      const info = this._groupE2ee.rotateEpochTo(groupId, newEpoch, memberAids);
      const distributions = (info.distributions ?? []) as { to: string; payload: Record<string, unknown> }[];
      for (const dist of distributions) {
        try {
          await this.call('message.send', {
            to: dist.to,
            payload: dist.payload,
            encrypt: true,
            persist: false,
          });
        } catch (exc) {
          _clientLog('debug', '密钥分发失败: %s', exc);
        }
      }
    } catch (exc) {
      this._logE2eeError('rotate_epoch', groupId, '', exc as Error);
    }
  }

  /** 将当前 group_secret 通过 P2P E2EE 分发给新成员 */
  private async _distributeKeyToNewMember(groupId: string, newMemberAid: string): Promise<void> {
    try {
      const secretData = this._groupE2ee.loadSecret(groupId);
      if (secretData === null) return;

      // 拉服务端最新成员列表
      const membersResult = await this.call('group.get_members', { group_id: groupId }) as Record<string, unknown>;
      const memberAids = ((membersResult.members ?? []) as Record<string, unknown>[]).map(
        (m) => String(m.aid),
      );

      // 用最新成员列表更新本地当前 epoch 的 member_aids/commitment
      const epoch = secretData.epoch as number;
      const commitment = computeMembershipCommitment(
        memberAids, epoch, groupId, secretData.secret as Buffer,
      );
      if (this._aid) {
        storeGroupSecret(
          this._keystore, this._aid, groupId, epoch,
          secretData.secret as Buffer, commitment, memberAids,
        );
      }

      // 构建并签名 manifest
      let manifest = buildMembershipManifest(
        groupId, epoch, epoch, memberAids, {
          added: [newMemberAid],
          removed: [],
          initiatorAid: this._aid ?? '',
        },
      );
      const identity = this._identity;
      if (identity && identity.private_key_pem) {
        manifest = signMembershipManifest(manifest, String(identity.private_key_pem));
      }

      const distPayload = buildKeyDistribution(
        groupId, epoch, secretData.secret as Buffer,
        memberAids, this._aid ?? '',
        manifest,
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

  /** 构建 epoch 轮换签名参数 */
  private _buildRotationSignature(
    groupId: string,
    currentEpoch: number,
    newEpoch: number = 0,
  ): Record<string, string> {
    const identity = this._identity;
    if (!identity || !identity.private_key_pem) return {};

    try {
      const aid = String(identity.aid ?? '');
      const ts = String(Math.floor(Date.now() / 1000));
      const signData = Buffer.from(`${groupId}|${currentEpoch}|${newEpoch}|${aid}|${ts}`, 'utf-8');
      const privateKey = crypto.createPrivateKey(String(identity.private_key_pem));
      const sig = crypto.sign('SHA256', signData, privateKey);
      return {
        rotation_signature: sig.toString('base64'),
        rotation_timestamp: ts,
      };
    } catch {
      return {};
    }
  }

  /** 记录 E2EE 自动编排错误 */
  private _logE2eeError(stage: string, groupId: string, aid: string, exc: Error): void {
    try {
      this._dispatcher.publish('e2ee.orchestration_error', {
        stage, group_id: groupId, aid, error: String(exc),
      }).catch(() => {});
    } catch {
      // 日志本身不应阻断主流程
    }
  }

  // ── URL 辅助 ──────────────────────────────────────────────

  /** 跨域时将 Gateway URL 替换为 peer 所在域的 Gateway URL */
  private static _resolvePeerGatewayUrl(localGatewayUrl: string, peerAid: string): string {
    if (!peerAid.includes('.')) return localGatewayUrl;
    const dotIdx = peerAid.indexOf('.');
    const peerIssuer = peerAid.slice(dotIdx + 1);
    const m = localGatewayUrl.match(/gateway\.([^:/]+)/);
    if (!m) return localGatewayUrl;
    const localIssuer = m[1];
    if (localIssuer === peerIssuer) return localGatewayUrl;
    return localGatewayUrl.replace(`gateway.${localIssuer}`, `gateway.${peerIssuer}`);
  }

  /** 构建证书下载 URL */
  private static _buildCertUrl(gatewayUrl: string, aid: string): string {
    const parsed = new URL(gatewayUrl);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${scheme}//${parsed.host}/pki/cert/${encodeURIComponent(aid)}`;
  }

  // ── 内部：连接 ────────────────────────────────────────────

  /** 执行一次连接流程 */
  private async _connectOnce(params: Record<string, unknown>, allowReauth: boolean): Promise<void> {
    const gatewayUrl = this._resolveGateway(params);
    this._gatewayUrl = gatewayUrl;
    this._state = 'connecting';

    try {
      const challenge = await this._transport.connect(gatewayUrl);
      this._state = 'authenticating';

      if (allowReauth) {
        const authContext = await this._auth.connectSession(
          this._transport,
          challenge,
          gatewayUrl,
          { accessToken: String(params.access_token ?? '') },
        );
        if (authContext && typeof authContext === 'object') {
          const identity = (authContext as Record<string, unknown>).identity as Record<string, unknown> | undefined;
          if (identity && typeof identity === 'object') {
            this._identity = identity;
            this._aid = String(identity.aid ?? this._aid ?? '');
            if (this._sessionParams !== null) {
              this._sessionParams.access_token = (authContext as Record<string, unknown>).token ?? params.access_token;
            }
          }
        }
      } else {
        await this._auth.initializeWithToken(
          this._transport, challenge, String(params.access_token),
        );
        this._syncIdentityAfterConnect(String(params.access_token));
      }

      this._state = 'connected';
      await this._dispatcher.publish('connection.state', { state: this._state, gateway: gatewayUrl });
      this._startBackgroundTasks();

      // 上线后自动上传 prekey
      try {
        await this._uploadPrekey();
      } catch (exc) {
        _clientLog('warn', 'prekey 上传失败: %s', exc);
      }
    } catch (err) {
      this._state = 'idle';
      throw err;
    }
  }

  /** 从参数中解析 Gateway URL */
  private _resolveGateway(params: Record<string, unknown>): string {
    const topology = params.topology;
    if (topology && typeof topology === 'object') {
      const topo = topology as Record<string, unknown>;
      const mode = String(topo.mode ?? 'gateway');
      if (mode === 'peer') {
        throw new ValidationError('peer topology is not implemented in the TypeScript SDK');
      }
      if (mode === 'relay') {
        throw new ValidationError('relay topology is not implemented in the TypeScript SDK');
      }
    }
    const gateway = String(params.gateway ?? '');
    if (!gateway) {
      throw new StateError('missing gateway in connect params');
    }
    return gateway;
  }

  /** 连接后同步身份信息 */
  private _syncIdentityAfterConnect(accessToken: string): void {
    const identity = this._auth.loadIdentityOrNone(this._aid ?? undefined);
    if (identity === null) {
      this._identity = null;
      return;
    }
    identity.access_token = accessToken;
    this._identity = identity;
    this._aid = String(identity.aid ?? this._aid ?? '');
    this._keystore.saveIdentity(String(identity.aid), identity);
  }

  // ── 内部：参数处理 ────────────────────────────────────────

  /** 规范化连接参数 */
  private _normalizeConnectParams(params: Record<string, unknown>): Record<string, unknown> {
    const request = { ...params };
    const accessToken = String(request.access_token ?? '');
    if (!accessToken) throw new StateError('connect requires non-empty access_token');
    const gateway = String(request.gateway ?? this._gatewayUrl ?? '');
    if (!gateway) throw new StateError('connect requires non-empty gateway');
    request.access_token = accessToken;
    request.gateway = gateway;
    if (request.topology != null && typeof request.topology !== 'object') {
      throw new ValidationError('topology must be a dict');
    }
    if ('retry' in request && typeof request.retry !== 'object') {
      throw new ValidationError('retry must be a dict');
    }
    if ('timeouts' in request && typeof request.timeouts !== 'object') {
      throw new ValidationError('timeouts must be a dict');
    }
    return request;
  }

  /** 从参数构建会话选项 */
  private _buildSessionOptions(params: Record<string, unknown>): Record<string, unknown> {
    const options: Record<string, unknown> = {
      auto_reconnect: (DEFAULT_SESSION_OPTIONS as Record<string, unknown>).auto_reconnect,
      heartbeat_interval: (DEFAULT_SESSION_OPTIONS as Record<string, unknown>).heartbeat_interval,
      token_refresh_before: (DEFAULT_SESSION_OPTIONS as Record<string, unknown>).token_refresh_before,
      retry: { ...(DEFAULT_SESSION_OPTIONS as Record<string, Record<string, unknown>>).retry },
      timeouts: { ...(DEFAULT_SESSION_OPTIONS as Record<string, Record<string, unknown>>).timeouts },
    };
    if ('auto_reconnect' in params) options.auto_reconnect = Boolean(params.auto_reconnect);
    if ('heartbeat_interval' in params) options.heartbeat_interval = Number(params.heartbeat_interval);
    if ('token_refresh_before' in params) options.token_refresh_before = Number(params.token_refresh_before);
    if ('retry' in params && typeof params.retry === 'object') {
      Object.assign(options.retry as Record<string, unknown>, params.retry);
    }
    if ('timeouts' in params && typeof params.timeouts === 'object') {
      Object.assign(options.timeouts as Record<string, unknown>, params.timeouts);
    }
    return options;
  }

  // ── 内部：后台任务 ────────────────────────────────────────

  /** 启动所有后台任务 */
  private _startBackgroundTasks(): void {
    this._startHeartbeatTask();
    this._startTokenRefreshTask();
    this._startPrekeyRefreshTask();
    this._startGroupEpochTasks();
  }

  /** 停止所有后台任务 */
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

  /** 启动心跳任务 */
  private _startHeartbeatTask(): void {
    if (this._heartbeatTimer !== null) return;
    const interval = Number(this._sessionOptions.heartbeat_interval ?? 30) * 1000;
    if (interval <= 0) return;
    this._heartbeatTimer = setInterval(() => {
      if (this._closing || this._state !== 'connected') return;
      this._transport.call('meta.ping', {}).catch((exc) => {
        this._dispatcher.publish('connection.error', { error: exc }).catch(() => {});
      });
    }, interval);
    // 允许 Node.js 进程在只剩定时器时退出
    if (this._heartbeatTimer && typeof this._heartbeatTimer === 'object' && 'unref' in this._heartbeatTimer) {
      (this._heartbeatTimer as NodeJS.Timer).unref();
    }
  }

  /** 启动 token 刷新任务 */
  private _startTokenRefreshTask(): void {
    if (this._tokenRefreshTimer !== null) return;
    const lead = Number(this._sessionOptions.token_refresh_before ?? 60);
    const minimumSleep = 1000;

    const scheduleNext = (): void => {
      if (this._closing) return;
      if (this._state !== 'connected' || !this._gatewayUrl) {
        this._tokenRefreshTimer = setTimeout(scheduleNext, minimumSleep);
        this._unrefTimer(this._tokenRefreshTimer);
        return;
      }

      let identity = this._identity ?? this._auth.loadIdentityOrNone() ?? null;
      if (identity === null) {
        this._tokenRefreshTimer = setTimeout(scheduleNext, minimumSleep);
        this._unrefTimer(this._tokenRefreshTimer);
        return;
      }
      this._identity = identity;

      const expiresAt = this._auth.getAccessTokenExpiry(identity);
      if (expiresAt === null) {
        this._tokenRefreshTimer = setTimeout(scheduleNext, minimumSleep);
        this._unrefTimer(this._tokenRefreshTimer);
        return;
      }

      const delay = Math.max((expiresAt - lead - Date.now() / 1000) * 1000, minimumSleep);
      this._tokenRefreshTimer = setTimeout(async () => {
        if (this._closing || this._state !== 'connected' || !this._gatewayUrl) {
          scheduleNext();
          return;
        }
        try {
          identity = await this._auth.refreshCachedTokens(this._gatewayUrl!, identity!);
          this._identity = identity;
          if (this._sessionParams !== null && identity.access_token) {
            this._sessionParams.access_token = identity.access_token;
          }
          await this._dispatcher.publish('token.refreshed', {
            aid: identity.aid,
            expires_at: identity.access_token_expires_at,
          });
        } catch (exc) {
          if (exc instanceof AuthError) {
            _clientLog('debug', 'token 刷新失败，下次重试: %s', exc);
          } else {
            await this._dispatcher.publish('connection.error', { error: exc });
          }
        }
        scheduleNext();
      }, delay);
      this._unrefTimer(this._tokenRefreshTimer);
    };

    scheduleNext();
  }

  /** 启动 prekey 刷新任务 */
  private _startPrekeyRefreshTask(): void {
    if (this._prekeyRefreshTimer !== null) return;
    const interval = Number(this.config.prekey_refresh_interval ?? 3600) * 1000;
    this._prekeyRefreshTimer = setInterval(() => {
      if (this._closing || this._state !== 'connected') return;
      this._uploadPrekey().catch((exc) => {
        _clientLog('warn', 'prekey 轮换失败: %s', exc);
      });
    }, interval);
    this._unrefTimer(this._prekeyRefreshTimer);
  }

  /** 启动群组 epoch 相关后台任务 */
  private _startGroupEpochTasks(): void {
    if (!this._configModel.groupE2ee) return;

    // 旧 epoch 清理（每小时检查一次）
    if (this._groupEpochCleanupTimer === null) {
      this._groupEpochCleanupTimer = setInterval(() => {
        if (this._closing || this._state !== 'connected' || !this._aid) return;
        try {
          const metadata = this._keystore.loadMetadata(this._aid!) ?? {};
          const groupSecrets = (metadata.group_secrets ?? {}) as Record<string, unknown>;
          const retention = this._configModel.oldEpochRetentionSeconds;
          for (const gid of Object.keys(groupSecrets)) {
            this._groupE2ee.cleanup(gid, retention);
          }
        } catch (exc) {
          _clientLog('debug', 'epoch 清理失败: %s', exc);
        }
      }, 3600_000);
      this._unrefTimer(this._groupEpochCleanupTimer);
    }

    // 定时 epoch 轮换
    const rotateInterval = this._configModel.epochAutoRotateInterval;
    if (rotateInterval > 0 && this._groupEpochRotateTimer === null) {
      this._groupEpochRotateTimer = setInterval(() => {
        if (this._closing || this._state !== 'connected' || !this._aid) return;
        try {
          const metadata = this._keystore.loadMetadata(this._aid!) ?? {};
          const groupSecrets = (metadata.group_secrets ?? {}) as Record<string, unknown>;
          for (const gid of Object.keys(groupSecrets)) {
            this._rotateGroupEpoch(gid).catch((exc) =>
              _clientLog('debug', 'epoch 轮换失败: %s', exc),
            );
          }
        } catch (exc) {
          _clientLog('debug', 'epoch 轮换失败: %s', exc);
        }
      }, rotateInterval * 1000);
      this._unrefTimer(this._groupEpochRotateTimer);
    }
  }

  /** 允许 Node.js 进程在只剩定时器时退出 */
  private _unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null): void {
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timer).unref();
    }
  }

  // ── 内部：断线重连 ────────────────────────────────────────

  /** 传输层断线回调 */
  private async _handleTransportDisconnect(error: Error | null): Promise<void> {
    if (this._closing || this._state === 'closed') return;
    this._state = 'disconnected';
    this._stopBackgroundTasks();
    await this._dispatcher.publish('connection.state', { state: this._state, error });

    if (!this._sessionOptions.auto_reconnect) return;
    if (this._reconnecting) return;
    this._startReconnect();
  }

  /** 启动重连循环（无限重试 + 指数退避，仅在不可重试错误或 close() 时终止） */
  private _startReconnect(): void {
    if (this._reconnecting) return;
    this._reconnecting = true;

    const retry = (this._sessionOptions.retry ?? {}) as Record<string, unknown>;
    const initialDelay = Number(retry.initial_delay ?? 0.5) * 1000;
    const maxDelay = Number(retry.max_delay ?? 30.0) * 1000;
    let delay = initialDelay;
    let attempt = 0;

    const tryReconnect = async (): Promise<void> => {
      attempt++;
      if (this._closing) {
        this._reconnecting = false;
        return;
      }

      this._state = 'reconnecting';
      await this._dispatcher.publish('connection.state', {
        state: this._state,
        attempt,
      });

      this._reconnectTimer = setTimeout(async () => {
        try {
          await this._transport.close();
          if (this._sessionParams === null) {
            throw new StateError('missing connect params for reconnect');
          }
          await this._connectOnce(this._sessionParams, true);
          this._reconnecting = false;
          this._reconnectTimer = null;
        } catch (exc) {
          await this._dispatcher.publish('connection.error', {
            error: exc,
            attempt,
          });
          if (!AUNClient._shouldRetryReconnect(exc as Error)) {
            this._state = 'terminal_failed';
            this._reconnecting = false;
            await this._dispatcher.publish('connection.state', {
              state: this._state,
              error: exc,
              attempt,
            });
            return;
          }
          delay = Math.min(delay * 2, maxDelay);
          if (!this._closing) {
            tryReconnect();
          } else {
            this._reconnecting = false;
          }
        }
      }, delay);
      this._unrefTimer(this._reconnectTimer);
    };

    tryReconnect();
  }

  /** 停止重连 */
  private _stopReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
  }

  /** 判断是否应重试重连 */
  private static _shouldRetryReconnect(error: Error): boolean {
    if (error instanceof AuthError || error instanceof PermissionError
      || error instanceof ValidationError || error instanceof StateError) {
      return false;
    }
    if (error instanceof ConnectionError) return true;
    if (error instanceof AUNError) return error.retryable;
    if (error instanceof TimeoutError) return true;
    // 其他网络错误默认重试
    return true;
  }
}
