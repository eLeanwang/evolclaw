import { AUNClient, GatewayDiscovery, E2EEError, type JsonObject } from '@agentunion/fastaun';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger, localTimestamp } from '../utils/logger.js';
import { LogWriter } from '../utils/log-writer.js';
import type { ChannelPlugin, ChannelInstance, ChannelBuildContext, BridgeHookContext } from '../core/channel-loader.js';
import { resolveShowActivities, showActivitiesPolicy } from '../core/channel-loader.js';
import type { MessageBridge } from '../core/message/message-bridge.js';
import type { ReplyContext, AunChannelInstance as AunInst, AidConnectionState, AidStatus, AidKickDetail, InteractionResponse, ActionInteraction, CommandCard, InboundMessage } from '../types.js';
import { resolvePaths, getPackageRoot, agentMdPath as agentMdPathFn, agentDir as agentDirPath, resolveRoot } from '../paths.js';
import { saveToUploads, sanitizeFileName, bufferToInboundImage, type InboundImage } from '../utils/media-cache.js';
import { appendAidEvent } from '../utils/instance-registry.js';
import { appendMessageLog, buildOutboundEntry, buildInboundEntry } from '../core/message/message-log.js';
import { chatDirPath } from '../core/session/session-fs-store.js';
import { appendHintAdd, appendHintRemove, parseInjectRequest } from '../core/message/pending-hints.js';
import { appendAidLifecycle } from '../aun/aid/identity.js';
import { getAidStore, loadClient, SLOT } from '../aun/aid/store.js';
import type { AIDStore } from '@agentunion/fastaun';
import type { AidStatsCollector } from '../utils/stats.js';
import { loadAgent, saveAgent } from '../config-store.js';
import { getProcessStartTime } from '../utils/process-introspect.js';
import * as outbox from '../aun/outbox.js';
import { guessMime, formatSize } from '../utils/media-cache.js';
import { PeerIdentityCache } from '../core/relation/peer-identity.js';

/**
 * 构造 connect extra_info：自描述本进程身份。
 *
 * 用途：另一个进程踢掉本连接时，本进程会从 SDK 'gateway.disconnect' 事件的
 * detail.new_extra_info 里看到对方的 extra_info；同时 detail.self_extra_info
 * 是本进程当时连接时上报的内容。把双方信息打到日志便于诊断"谁踢了谁"。
 *
 * 字段需保持稳定（被踢方靠它分辨对方身份）。
 */
function buildConnectExtraInfo(opts: { aid: string; agentName?: string; channelName?: string }): Record<string, unknown> {
  const startedAt = getProcessStartTime(process.pid) ?? Date.now();
  return {
    app: 'evolclaw',
    version: getEvolclawVersion(),
    pid: process.pid,
    started_at: startedAt,
    started_at_iso: new Date(startedAt).toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    node_version: process.version,
    evolclaw_home: process.env.EVOLCLAW_HOME || '',
    launched_by: process.env.EVOLCLAW_LAUNCHED_BY || '',
    aid: opts.aid,
    agent_name: opts.agentName ?? '',
    channel_name: opts.channelName ?? '',
  };
}

let _cachedVersion: string | null = null;
function getEvolclawVersion(): string {
  if (_cachedVersion !== null) return _cachedVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(getPackageRoot(), 'package.json'), 'utf-8'));
    _cachedVersion = String(pkg.version ?? '');
  } catch {
    _cachedVersion = '';
  }
  return _cachedVersion;
}

export interface AUNConfig {
  aid: string;
  keystorePath?: string;
  gatewayUrl?: string;    // well-known 自动发现失败时的 fallback URL
  accessToken?: string;
  flushDelay?: number;
  aunTrace?: boolean;     // 启用数据追踪日志
  aunSdkLog?: boolean;    // 启用 AUN SDK 内部日志（写入 ~/.aun/logs/ts-sdk-YYYYMMDD.log）
  owner?: string;         // Owner AID，用于发送欢迎消息
  agentName?: string;     // self-agent 的 AID（用于 status 表格识别归属）
  channelName?: string;   // channel 实例名（用于日志/状态聚合）
  pureIdentity?: boolean;  // 纯身份模式：跳过 evolagent onboarding（welcome / agent.md 上传 / 自身 agent.md 拉取 / group 监听）
}

/** AUNChannel.dispatchMessage 投递给 bridge 的统一入站载荷（含网络邻近性 proximity）。 */
export interface AUNDispatchOptions {
  channelId: string;
  channelType?: string;
  content: string;
  selfAID?: string;
  groupId?: string;
  chatType: 'private' | 'group';
  peerId: string;
  peerName?: string;
  peerType?: string;
  sameDevice?: boolean;
  sameNetwork?: boolean;
  sameEgressIp?: boolean;
  messageId?: string;
  threadId?: string;
  mentions?: Array<{ userId: string; name?: string }>;
  mentionAids?: string[];
  replyContext?: ReplyContext;
  source?: 'user' | 'card-trigger';
  images?: Array<{ data: string; mimeType: string }>;
  /** 群聊分发模式（mention/broadcast），透传到上下文注入。 */
  dispatchMode?: string;
}

export interface AUNMessageHandler {
  (options: AUNDispatchOptions): Promise<void>;
}

/**
 * 把 AUNChannel 投递的 opts 映射成渠道无关的 InboundMessage。
 *
 * registerBridge 适配回调用它替代手抄字段——历史上手抄漏掉了
 * sameDevice/sameNetwork/sameEgressIp，proximity 在此被吞，eck-debug 永远 false。
 * 抽成纯函数后可单测锁字段，杜绝再漏。
 */
export function aunOptsToInbound(
  opts: AUNDispatchOptions,
  channel: string,
  channelType: string,
): InboundMessage {
  return {
    channel,
    channelType,
    channelId: opts.channelId,
    selfAID: opts.selfAID,
    groupId: opts.groupId,
    content: opts.content,
    chatType: opts.chatType || 'private',
    peerId: opts.peerId || '',
    peerName: opts.peerName,
    peerType: opts.peerType,
    sameDevice: opts.sameDevice,
    sameNetwork: opts.sameNetwork,
    sameEgressIp: opts.sameEgressIp,
    messageId: opts.messageId,
    mentions: opts.mentions,
    mentionAids: opts.mentionAids,
    threadId: opts.threadId,
    replyContext: opts.replyContext,
    source: opts.source,
    images: opts.images,
    dispatchMode: opts.dispatchMode,
  };
}


export class AUNChannel {
  private client: AUNClient | null = null;
  private store: AIDStore | null = null;
  /** 实际连接的网关 URL（来自 authenticate() 返回值 / connection.state 事件），替代旧 (client as any)._gatewayUrl。 */
  private gatewayUrl: string = '';
  private projectPathProvider?: (channelId: string) => Promise<string>;
  private messageHandler?: AUNMessageHandler;
  private recallHandler?: (messageId: string) => void;
  private connected = false;
  private traceWriter: LogWriter | null = null;
  private eventBus: any = null;
  private ownerBoundHandler: ((event: any) => void) | null = null;
  private queuedHandler: ((event: any) => void) | null = null;
  private pendingEchoMessages = new Map<string, { text: string; channelId: string; context?: ReplyContext; receiveTs: number }>();
  private isEchoSending = false;
  private agentDir: string;
  private trace(dir: 'IN' | 'OUT', event: string, data: unknown): void {
    if (!this.config.aunTrace) return;
    if (!this.traceWriter) return;

    // 自动从 data 推断顶层字段（self_aid / peer_aid / group_id / task_id / chatmode），
    // 便于 jq 过滤：`jq 'select(.task_id == "task-xxx")'`
    const d = (data && typeof data === 'object') ? data as any : {};
    const payload = d.payload ?? {};
    // 入站事件（IN）路由字段在 d.envelope.*（SDK 0.5.*）；出站 params（OUT）字段在顶层。两者兼顾。
    const env = (d.envelope && typeof d.envelope === 'object') ? d.envelope : {};
    const topContext: Record<string, any> = {
      self_aid: this._aid ?? this.config.aid,
    };
    // peer / group 识别
    const peerAid = env.to ?? env.from ?? d.to ?? d.from ?? d.sender_aid ?? payload.to;
    if (peerAid) topContext.peer_aid = peerAid;
    const groupId = env.group_id ?? d.group_id ?? payload.group_id;
    if (groupId) topContext.group_id = groupId;
    // task_id / chatmode（message.send / thought.put / status 都可能有）
    const taskId = payload.task_id ?? d.context?.id ?? d.data?.task_id;
    if (taskId) topContext.task_id = taskId;
    const chatmode = payload.chatmode;
    if (chatmode) topContext.chatmode = chatmode;

    const line = JSON.stringify({ ts: localTimestamp(), dir, event, ...topContext, data });
    this.traceWriter.write(line);
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
      logger.warn(`${this.logPrefix()} rpc ${method} failed: ${e?.name ?? ''}(${e?.code ?? ''}) ${e?.message ?? e}`);
      throw e;
    }
  }


  /** 判断 channelId 是否为群组 ID
   *  - 新格式：group.{issuer}/{group_no|group_name}
   *  - 数字群号：{group_no}.{issuer}（如 11117.agentid.pub）
   *  - 兼容旧格式：grp_xxx、g-xxx.agentid.pub
   */
  /** 判断 channelId 是否群组 ID（public：plugin adapter 闭包需调用） */
  isGroupId(id: string): boolean {
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

  private extractTextPayload(payload: unknown, channelId?: string, senderAid?: string): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      const text = typeof obj.text === 'string' ? obj.text : '';

      // action_card_reply：卡片交互回复，触发 interactionCallback，不分发给 agent
      if (obj.type === 'action_card_reply') {
        const cardMsgId = typeof obj.ref_message_id === 'string' ? obj.ref_message_id
          : typeof obj.card_message_id === 'string' ? obj.card_message_id : '';
        const cardInfo = cardMsgId ? this.cardMessageIdMap.get(cardMsgId) : undefined;
        if (cardInfo) {
          const actionValue = typeof obj.value === 'string' ? obj.value
            : typeof obj.action_value === 'string' ? obj.action_value : text;

          // 卡片点击者身份：只信认证信封（senderAid 参数，由调用方从 msg.from / msg.sender_aid 提取）。
          // payload 自报字段（from / sender_aid / user_id）不可信，可被客户端伪造，不读取。
          // 两类卡片共用：CommandCard → 伪入站消息的 peerId，ActionInteraction → operatorId。
          const cardClickerAid = senderAid || channelId || '';

          if (cardInfo.isCommandCard) {
            // CommandCard：action_value 是完整 slash 命令，构造伪入站消息
            this.cardMessageIdMap.delete(cardMsgId);
            if (this.messageHandler && actionValue.startsWith('/')) {
              const chatType = channelId ? (this.isGroupId(channelId) ? 'group' : 'private') : 'private';
              // Initiator 校验：仅群聊需要（私聊信道一对一，点击者恒为对端 = initiator）。
              // 身份只信认证信封提取的 cardClickerAid，非 payload 自报。
              if (chatType === 'group' && cardInfo.initiatorAid && cardClickerAid
                && cardClickerAid !== cardInfo.initiatorAid) {
                logger.info(`${this.logPrefix()} CommandCard rejected: clicker=${cardClickerAid} initiator=${cardInfo.initiatorAid} mid=${cardMsgId}`);
                return '';
              }

              this.messageHandler({
                channelId: channelId || '',
                chatType,
                content: actionValue,
                peerId: cardClickerAid,
                peerName: typeof obj.label === 'string' ? obj.label : typeof obj.action_label === 'string' ? obj.action_label : undefined,
                messageId: `card-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                source: 'card-trigger',
              });
            }
          } else {
            // ActionInteraction：走 interactionCallback → InteractionRouter
            // callback 未注册时保留 map entry（TTL 清理），给 router 留重试机会
            if (this.interactionCallback) {
              this.cardMessageIdMap.delete(cardMsgId);
              this.interactionCallback({
                type: 'interaction.response',
                id: cardInfo.requestId,
                action: actionValue,
                values: { text, action_label: obj.label ?? obj.action_label, behavior: obj.behavior },
                operatorId: cardClickerAid || undefined,
              });
            }
          }
        } else {
          logger.debug(`${this.logPrefix()} action_card_reply dropped: cardMsgId=${cardMsgId} hasCallback=${!!this.interactionCallback}`);
        }
        // 始终返回空字符串，阻止消息分发给 agent
        return '';
      }

      // quote 类型：拼接被引用内容（支持 text / image / file attachments）
      if (obj.type === 'quote' && obj.quote && typeof obj.quote === 'object') {
        const q = obj.quote as Record<string, unknown>;
        const quotedText = typeof q.text === 'string' ? q.text : '';
        const sender = typeof q.sender_display === 'string' ? q.sender_display : '';
        const prefix = sender ? `${sender}: ` : '';

        // 构建引用内容：文本 + 附件描述
        const quoteParts: string[] = [];
        if (quotedText) quoteParts.push(quotedText);
        if (Array.isArray(q.attachments)) {
          for (const att of q.attachments as any[]) {
            if (att && typeof att === 'object') {
              const ct = typeof att.content_type === 'string' ? att.content_type : '';
              const fn = typeof att.filename === 'string' ? att.filename : '';
              if (ct.startsWith('image/')) {
                quoteParts.push(fn ? `[图片: ${fn}]` : '[图片]');
              } else {
                quoteParts.push(fn ? `[文件: ${fn}]` : '[文件]');
              }
            }
          }
        }

        if (quoteParts.length > 0) {
          const lines = quoteParts.join('\n').split('\n');
          const quoted = lines.map((line, i) => `> ${i === 0 ? prefix : ''}${line}`).join('\n');
          return text ? `${quoted}\n\n${text}` : quoted;
        }
      }

      // merge 类型：合并转发消息，展开子消息为可读文本
      if (obj.type === 'merge') {
        const title = typeof obj.title === 'string' ? obj.title : '合并转发消息';
        const parts: string[] = [`以下是转发的合并消息「${title}」：\n---`];
        if (Array.isArray(obj.items)) {
          for (const item of obj.items) {
            if (item && typeof item === 'object') {
              const sender = typeof item.sender_display === 'string' ? item.sender_display : '';
              const itemText = typeof item.text === 'string' ? item.text : '';
              const itemType = typeof item.type === 'string' ? item.type : '';

              // 根据子消息类型构建展示
              const lineParts: string[] = [];
              if (itemText) lineParts.push(itemText);

              // 子消息附件（image/file）
              if (Array.isArray(item.attachments)) {
                for (const att of item.attachments) {
                  if (att && typeof att === 'object') {
                    const ct = typeof att.content_type === 'string' ? att.content_type : '';
                    const fn = typeof att.filename === 'string' ? att.filename : '';
                    if (ct.startsWith('image/') || itemType === 'image') {
                      lineParts.push(fn ? `[图片: ${fn}]` : '[图片]');
                    } else if (ct.startsWith('video/') || itemType === 'video') {
                      lineParts.push(fn ? `[视频: ${fn}]` : '[视频]');
                    } else {
                      lineParts.push(fn ? `[文件: ${fn}]` : '[文件]');
                    }
                  }
                }
              }

              const content = lineParts.join(' ') || `[${itemType || '未知类型'}]`;
              parts.push(sender ? `${sender}: ${content}` : content);
            }
          }
        }
        if (typeof obj.summary === 'string' && obj.summary) {
          parts.push(`\n[摘要] ${obj.summary}`);
        }
        parts.push('---');
        return parts.join('\n');
      }

      if (typeof obj.text === 'string') return text;
      return JSON.stringify(payload);
    }
    return '';
  }

  /** 收集 payload 中所有需要下载的 attachments（顶层 + merge.items + quote.quote），按 url 去重 */
  private collectAllAttachments(payload: unknown): any[] {
    if (!payload || typeof payload !== 'object') return [];
    const obj = payload as Record<string, unknown>;
    const result: any[] = [];
    const seen = new Set<string>();

    const add = (att: any) => {
      if (!att || typeof att !== 'object') return;
      const key = att.url || att.object_key || '';
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      result.push(att);
    };

    // 顶层 attachments
    if (Array.isArray(obj.attachments)) {
      for (const att of obj.attachments) add(att);
    }

    // merge.items 中的子消息 attachments
    if (obj.type === 'merge' && Array.isArray(obj.items)) {
      for (const item of obj.items) {
        if (item && typeof item === 'object' && Array.isArray(item.attachments)) {
          for (const att of item.attachments) add(att);
        }
      }
    }

    // quote.quote 中的 attachments
    if (obj.type === 'quote' && obj.quote && typeof obj.quote === 'object') {
      const q = obj.quote as Record<string, unknown>;
      if (Array.isArray(q.attachments)) {
        for (const att of q.attachments) add(att);
      }
    }

    return result;
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

  private buildGroupReplyContext(threadId: string | undefined, senderAid: string, encrypted: boolean, messageId?: string, chatmode?: string): ReplyContext {
    const replyContext: ReplyContext = { metadata: { encrypted, chatmode } };
    if (threadId) replyContext.threadId = threadId;
    replyContext.peerId = senderAid;
    if (messageId) replyContext.replyToMessageId = messageId;
    return replyContext;
  }

  private acknowledgeImmediately(messageId: string | undefined, _seq?: number): void {
    // SDK internally manages seq tracking and ack — do not call message.ack RPC directly,
    // as it corrupts the SDK's seqTracker state and breaks V2 e2ee message pull.
    if (messageId) this.messageSeqMap.delete(messageId);
  }

  private shouldEncrypt(_peerId: string): boolean {
    // Default to plaintext; only encrypt when session is explicitly marked encrypted
    return false;
  }
  private _aid?: string;
  private _selfName?: string;  // 本地 agent.md 中的 name，首次 connect 时读取
  private _chatId = '';  // aid:device_id:slot_id — 多实例回声过滤
  private seenMessages = new Map<string, number>();
  private groupNameCache = new Map<string, string>();  // groupId → 群显示名（进程内缓存，群名极少变）
  private peerInfoCache = new Map<string, { type: 'human' | 'ai'; name?: string }>();
  private messageSeqMap = new Map<string, number>();  // messageId → seq (for ack)
  private sentCount = new Map<string, number>();  // channelId → 已发消息计数（用于判断最终回复）
  private peerE2ee = new Map<string, { ok: boolean; ts: number }>();
  private static readonly E2EE_PROBE_TTL = 10 * 60 * 1000; // 10min
  private plaintextRecv = 0;
  interactionCallback?: (response: InteractionResponse) => void;
  // action_card message_id → { requestId, isCommandCard }（用于关联 action_card_reply）
  cardMessageIdMap = new Map<string, { requestId: string; isCommandCard: boolean; initiatorAid?: string }>();
  private dispatchModeResolver?: (channelId: string) => Promise<string | undefined>;

  private static readonly PROACTIVE_ALLOW_TYPES = new Set([
    'text', 'quote', 'image', 'video', 'voice', 'file', 'json',
    'merge', 'link', 'location', 'personal_card',
  ]);

  /** Menu protocol 请求类型：自定义消息快速路径，绕过白名单直接分发到 bridge */
  private static readonly MENU_REQUEST_TYPES = new Set([
    'menu.list', 'menu.query', 'menu.options', 'menu.update', 'menu.action',
  ]);

  /** 观察者插话请求类型（owner → agent.AID）。详见 docs/observer-insert-design.md。 */
  private static readonly INJECT_REQUEST_TYPE = 'observer.inject';

  // Reconnect state
  // SDK 自己跑无限指数退避（1s → 5min）；TS 层只在 SDK 够不到的两类场景下接管：
  //  1. flap：短命 connected 反复出现（SDK 不记忆跨轮 base delay，会从 1s 重新开始）
  //  2. terminal_failed with kick reason：直接 5min 后重试，不刷屏
  private intentionalDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectGeneration = 0;  // 防止并发 initClient：每次 takeoverReconnect 递增，回调中校验
  private onChannelDown?: () => void;

  // initClient concurrency guard: 防止多个 initClient 并发执行
  private initInProgress = false;

  // Flap detection: 连接寿命 < FLAP_WINDOW_MS 累计 FLAP_THRESHOLD 次，判定为持续被踢
  private connectedAt = 0;
  private flapCount = 0;
  private static readonly FLAP_WINDOW_MS = 30_000;
  private static readonly FLAP_THRESHOLD = 3;

  // 接管后的统一退避时间（kicked / flap / terminal_failed）
  private static readonly TAKEOVER_DELAY_MS = 5 * 60 * 1000;  // 5min
  // 一般 terminal_failed（非 kick）的兜底退避
  private static readonly FALLBACK_DELAY_MS = 60 * 1000;  // 1min

  // SDK reconnect logging throttle（避免 attempt 自增刷屏）
  private lastReconnectLogTime = 0;
  private lastReconnectLogAttempt = 0;
  private static readonly RECONNECT_LOG_INTERVAL = 60_000;
  private static readonly RECONNECT_LOG_STEP = 100;

  // AID 连接状态（供 status 命令聚合展示）
  private aidState: AidConnectionState;
  private aidStatsCollector?: AidStatsCollector;

  constructor(private config: AUNConfig) {
    this.agentDir = agentDirPath(config.aid);
    if (config.aunTrace) {
      this.traceWriter = new LogWriter({
        baseName: 'aun',
        logDir: resolvePaths().logs,
        rotation: 'hourly',
        retention: { hours: 12 },
      });
      logger.info(`${this.logPrefix()} Trace logging enabled (hourly rotation, 12h retention): ${this.traceWriter.activePath()}`);
    }
    this.aidState = {
      aid: config.aid,
      agentName: config.agentName ?? '<unknown>',
      channelName: config.channelName ?? 'aun',
      status: 'disabled',
      reconnectCount: 0,
      flapCount: 0,
    };
  }

  /** Snapshot of AID connection state for status / IPC aggregation */
  getAidState(): AidConnectionState {
    return { ...this.aidState, flapCount: this.flapCount };
  }

  setAidStatsCollector(collector: AidStatsCollector): void {
    this.aidStatsCollector = collector;
  }

  private setAidStatus(status: AidStatus, extra?: Partial<AidConnectionState>): void {
    this.aidState.status = status;
    if (extra) Object.assign(this.aidState, extra);
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.flapCount = 0;
    this.connectedAt = 0;
    this.setAidStatus('reconnecting', { lastAttemptAt: Date.now() });
    await this.initClient();
    this.startOutboxTimer();
  }


  private async initClient(): Promise<void> {
    // 防止并发 initClient（sendMessage 触发 + timer 触发同时进入）
    if (this.initInProgress) {
      logger.info(`${this.logPrefix()} initClient already in progress, skipping`);
      return;
    }
    this.initInProgress = true;
    try {
      await this._initClientInner();
    } finally {
      this.initInProgress = false;
    }
  }

  private async _initClientInner(): Promise<void> {
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
    if (this.store) {
      try { this.store.close(); } catch { /* ignore */ }
      this.store = null;
    }
    this.connected = false;

    const aunPath = this.config.keystorePath || resolveRoot();
    const aidName = this.config.aid;
    // encryptionSeed 由 getAidStore 内部解析（config / env / 'evol'）

    // Migration from ~/.aun is handled by ensureDataDirs() at startup with a marker file.

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

    // 构造 AIDStore（slot=evolclaw daemon，与 cli/netcheck 共享 evolclaw 隔离键）
    // encryptionSeed / rootCaPath 由 getAidStore 内部注入
    const store = await getAidStore({
      slotId: SLOT.daemon,
      aunPath,
      debug: this.config.aunSdkLog ?? false,
    });
    this.store = store;
    const client = await loadClient(store, aidName);
    this.client = client;
    // 记录应用层发现的 gateway 作为初始值（authenticate 后会用权威值覆盖）
    this.gatewayUrl = gateway;

    // Register event handlers before connecting
    client.on('message.received', (data: unknown) => {
      this.trace('IN', 'message.received', data);
      const kind = (data && typeof data === 'object') ? (data as any).kind ?? '' : '';
      const keys = (data && typeof data === 'object') ? Object.keys(data as any).join(',') : typeof data;
      logger.debug(`${this.logPrefix()}[DIAG] message.received: kind=${kind} keys=${keys}`);
      this.handleIncomingPrivateMessage(data);
    });
    // pureIdentity（控制 AID）：协议层不接群消息，不注册 group 创建监听
    if (!this.config.pureIdentity) {
      client.on('group.message_created', (data: unknown) => {
        this.trace('IN', 'group.message_created', data);
        const env = (data && typeof data === 'object') ? (data as any).envelope ?? {} : {};
        const gid = env.group_id ?? '';
        const sender = env.from ?? '';
        logger.debug(`${this.logPrefix()}[DIAG] group.message_created: group_id=${gid} sender=${sender}`);
        this.handleIncomingGroupMessage(data);
      });
    }
    client.on('connection.state', (data: unknown) => {
      // trace is handled inside handleConnectionState with throttling
      this.handleConnectionState(data);
    });
    // gateway 被踢/服务端主动断开（含同槽位互踢的 self/new extra_info）
    client.on('gateway.disconnect', (data: unknown) => {
      this.trace('IN', 'gateway.disconnect', data);
      this.handleGatewayDisconnect(data);
    });
    client.on('message.recalled', (data: unknown) => {
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
    client.on('message.undecryptable', (data: unknown) => {
      this.trace('IN', 'message.undecryptable', data);
      const d = data as Record<string, any>;
      const env = (d.envelope && typeof d.envelope === 'object') ? d.envelope : {};
      logger.warn(`${this.logPrefix()} Message undecryptable: from=${env.from} mid=${d.message_id} err=${d._decrypt_error}`);
    });
    // pureIdentity（控制 AID）：不注册 group 解密失败监听
    if (!this.config.pureIdentity) {
      client.on('group.message_undecryptable', (data: unknown) => {
        this.trace('IN', 'group.message_undecryptable', data);
        const d = data as Record<string, any>;
        const env = (d.envelope && typeof d.envelope === 'object') ? d.envelope : {};
        logger.warn(`${this.logPrefix()} Group message undecryptable: group=${env.group_id} from=${env.from} mid=${d.message_id} err=${d._decrypt_error}`);
      });
      // 群消息撤回（SDK 0.4.10 在线 push 通道）：与私聊 message.recalled 同构，
      // 逐个 message_id 交给 recallHandler → msgBridge.cancel（排队中删除 / 处理中中断）。
      client.on('group.message_recalled', (data: unknown) => {
        this.trace('IN', 'group.message_recalled', data);
        if (data && typeof data === 'object') {
          const d = data as any;
          const env = (d.envelope && typeof d.envelope === 'object') ? d.envelope : {};
          const ids = d.message_ids;
          if (Array.isArray(ids)) {
            for (const id of ids) {
              if (typeof id === 'string') {
                logger.info(`${this.logPrefix()} Group message recalled: group=${env.group_id ?? ''} mid=${id}`);
                this.recallHandler?.(id);
              }
            }
          }
        }
      });
    }

    // Authenticate（拿权威 gateway 用于日志/状态；connect 内部也会复用 token）
    try {
      logger.info(`${this.logPrefix()} Authenticating as ${aidName}...`);
      this.trace('OUT', 'auth.authenticate', { aid: aidName });
      const auth = await client.authenticate();
      this.trace('OUT', 'auth.authenticate.ok', { aid: client.aid, gateway: auth?.gateway, hasToken: !!auth?.access_token });
      this.trace('IN', 'auth.result', { aid: client.aid, gateway: auth?.gateway, hasToken: !!auth?.access_token });
      const resolvedGateway = String(auth?.gateway ?? gateway);
      this.gatewayUrl = resolvedGateway;
      logger.info(`${this.logPrefix()} Authenticated as ${client.aid ?? '?'}, gateway=${resolvedGateway}`);
    } catch (e: any) {
      const errMsg = e.message || String(e);
      const errName = e.constructor?.name || 'Error';
      this.trace('OUT', 'auth.authenticate.error', { error: errMsg, name: errName });
      logger.error(`${this.logPrefix()} Authentication failed (${errName}): ${errMsg}`);
      if (e.stack) logger.debug(`${this.logPrefix()} Auth stack: ${e.stack}`);
      this.setAidStatus('failed', { lastError: `${errName}: ${errMsg}`.slice(0, 80) });
      this.scheduleReconnect();
      throw new Error(`Authentication failed: ${errName}: ${errMsg}`);
    }

    // Connect (SDK auto_reconnect handles transient failures)
    try {
      const extraInfo = buildConnectExtraInfo({
        aid: this.config.aid,
        agentName: this.config.agentName,
        channelName: this.config.channelName,
      });
      this.trace('OUT', 'client.connect', { gateway: this.gatewayUrl, extra_info: extraInfo });
      await client.connect(
        {
          // connection_kind 默认 long；slot 已由 AID 携带（evolclaw daemon）
          // extra_info：互踢诊断名片（0.4.3 公开 connect 已支持透传）
          extra_info: extraInfo as JsonObject,
          // max_attempts=0 = 无限重试（与 Go/Python 对齐），交由 SDK 自己跑指数退避
          // initial_delay=1s，max_delay=300s（5min 封顶）
          auto_reconnect: true,
          retry_max_attempts: 0,
          retry_initial_delay: 1.0,
          retry_max_delay: 300.0,
        },
      );
      this.trace('OUT', 'client.connect.ok', { aid: client.aid });
      this._aid = this.client.aid ?? undefined;
      const deviceId = (this.client as any)._device_id ?? '';
      this._chatId = this._aid ? `${this._aid}:${deviceId}:` : '';
      // pureIdentity（控制 AID）：无 agent.md，跳过自身 agent.md 拉取，省一次 404
      this._selfName = this.config.pureIdentity ? undefined : this.loadSelfName(aidName);
      if (this._selfName && this.aidStatsCollector) this.aidStatsCollector.setSelfName(this.config.aid, this._selfName);
      this.connected = true;
      this.connectedAt = Date.now();
      this.setAidStatus('connected', { lastConnectedAt: Date.now(), lastError: undefined, gatewayUrl: this.gatewayUrl });

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
      appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'connected', aid: this.config.aid, gateway: this.gatewayUrl });
      appendAidLifecycle({ ts: Date.now(), iso: new Date().toISOString(), event: 'connected', aid: this.config.aid, gateway: this.gatewayUrl });

      // Send welcome message to owner after first connection
      // pureIdentity（控制 AID）：跳过 evolagent onboarding（根除 warn 噪声 + 永不 agentmdPut）
      if (!this.config.pureIdentity) {
        await this.sendWelcomeMessage();
      }
    } catch (e) {
      this.trace('OUT', 'client.connect.error', { error: String(e) });
      logger.error(`${this.logPrefix()} Connection failed: ${e}`);
      this.setAidStatus('failed', { lastError: String(e).slice(0, 80) });
      this.scheduleReconnect();
      throw e;
    }
  }

  private async sendWelcomeMessage(): Promise<void> {
    try {
      const aid = this.config.aid;
      const aidName = aid.startsWith('@') ? aid.slice(1) : aid;

      // Read initialized + owners from per-agent config.json
      // (config.json 是 owner 的真相来源——auto-bind 后会更新这里，但 this.config 是
      // channel 启动时的快照，不会自动同步)
      const agentConfig = loadAgent(aidName);
      if (!agentConfig) {
        logger.warn(`${this.logPrefix()} agent config not found for ${aidName}, skipping welcome message`);
        return;
      }
      if (agentConfig.initialized === true) {
        logger.info(`${this.logPrefix()} Agent already initialized, skipping welcome message`);
        return;
      }

      const owner = agentConfig.owners?.[0] ?? this.config.owner;
      if (!owner) {
        logger.info(`${this.logPrefix()} No owner configured, skipping welcome message (will retry after auto-bind)`);
        return;
      }

      const agentMdLocalPath = agentMdPathFn(aidName);
      const existingAgentMd = fs.existsSync(agentMdLocalPath) ? fs.readFileSync(agentMdLocalPath, 'utf-8') : '';
      const existingFrontmatterMatch = existingAgentMd.match(/^---\n([\s\S]*?)\n---/);
      const existingFrontmatter = existingFrontmatterMatch?.[1] ?? '';

      // Fetch owner's agent.md to derive name and validate type
      const ownerInfo = await this.fetchPeerInfo(owner);
      if (ownerInfo.type !== null && ownerInfo.type !== 'human') {
        logger.warn(`${this.logPrefix()} Owner ${owner} type is "${ownerInfo.type}" (not human). Consider using a human AID as owner.`);
      }

      // Name: prefer existing agent.md name if user has customized it,
      // otherwise generate "{ownerName}的Evol助手 ({aidLabel})" for disambiguation
      const ownerAidClean = owner.startsWith('@') ? owner.slice(1) : owner;
      const ownerDisplayName = (ownerInfo.name || ownerAidClean.split('.')[0]).slice(0, 12);

      const currentNameMatch = existingFrontmatter.match(/^name:\s*"?([^"\n]+)/m);
      const currentName = currentNameMatch?.[1]?.trim().replace(/"$/, '');
      const aidLabel = aidName.split('.')[0];

      let agentDisplayName: string;
      if (currentName && currentName !== aidLabel) {
        agentDisplayName = currentName;
      } else {
        agentDisplayName = `${ownerDisplayName}的Evol助手 (${aidLabel})`;
      }

      // Preserve user-provided description (from `agent new --description`), fallback to default
      const currentDescMatch = existingFrontmatter.match(/^description:\s*"?([^"\n]*)/m);
      const currentDesc = currentDescMatch?.[1]?.trim().replace(/"$/, '');
      const agentDescription = currentDesc
        ? currentDesc
        : 'EvolClaw AI Agent Gateway - 连接 Claude/Codex 到消息通道';

      // Generate new agent.md (no `initialized` frontmatter — that's now in config.json)
      const newAgentMd = `---
aid: "${aid}"
name: "${agentDisplayName}"
type: "codeagent"
version: "1.0.0"
description: "${agentDescription}"
tags:
  - evolclaw
  - ai-agent
  - gateway
---

# ${agentDisplayName}

EvolClaw AI Agent 网关，支持多项目会话管理和多 AI 后端切换。
`;

      // Write locally and publish to AUN network (auto-sign)
      try {
        const { agentmdPut } = await import('../aun/aid/agentmd.js');
        await agentmdPut(newAgentMd, { aid: aidName, store: this.store! });
        logger.info(`${this.logPrefix()} Published agent.md to AUN network`);
      } catch (e) {
        logger.warn(`${this.logPrefix()} Failed to publish agent.md: ${e}`);
      }

      // Send welcome message
      const welcomeText = `🎉 欢迎使用 EvolClaw！

我是您的 AI Agent 网关，已成功连接到 AUN 网络。

📋 **日常使用方法**：

1. **查看帮助**：发送 \`/help\` 查看所有可用命令
2. **查看状态**：发送 \`/status\` 查看当前会话状态
3. **会话管理**：发送 \`/session\` 查看和切换会话

💡 **提示**：
- 直接发送消息即可与 Claude/Codex 对话
- 支持多会话管理，每个会话独立上下文
- 所有命令以 \`/\` 开头

现在就可以开始工作了！`;

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

      // Send binding credential for Evol App to persist locally
      await this.sendBindingCredential(owner, agentDisplayName, agentConfig.active_baseagent || 'claude').catch(e =>
        logger.warn(`${this.logPrefix()} Binding credential failed: ${e}`)
      );

      // Mark agent as initialized in config.json (replaces old agent.md frontmatter flag)
      try {
        const fresh = loadAgent(aidName);
        if (fresh) {
          fresh.initialized = true;
          saveAgent(fresh);
          logger.info(`${this.logPrefix()} Marked ${aidName} as initialized in config.json`);
        }
      } catch (e) {
        logger.warn(`${this.logPrefix()} Failed to update initialized flag in config.json: ${e}`);
      }
    } catch (e) {
      logger.warn(`${this.logPrefix()} Failed to send welcome message: ${e}`);
    }
  }

  private async sendBindingCredential(owner: string, name: string, baseagent: string): Promise<void> {
    if (!this.client) return;
    await this.callAndTrace('message.send', {
      to: owner,
      payload: { type: 'binding', aid: this.config.aid, name, owner, baseagent },
      encrypt: true,
      persist_required: true,
    });
    logger.info(`${this.logPrefix()} Binding credential sent to owner: ${owner}`);
  }

  // ── Event handlers ──────────────────────────────────────────

  /**
   * 统一处理入站附件：下载 → 图片识别+base64 注入 → 拼接文本。
   *
   * - 图片：base64 注入视觉通道（不再追加 [文件: …] 文本行，避免冗余）
   * - 非图片：拼 [文件: name → path]，并提示用 Read 工具读取
   *
   * @param baseText 已解析的正文（私聊 text / 群聊 strippedText）
   * @param channelId 下载归属（私聊 fromAid / 群聊 groupId）
   * @param preCollected 已收集的附件（群聊路径会提前 collect，避免重复）
   */
  private async processAttachments(
    payload: unknown,
    baseText: string,
    channelId: string,
    preCollected?: any[],
  ): Promise<{ finalText: string; images: InboundImage[] }> {
    const rawAttachments = preCollected ?? this.collectAllAttachments(payload);
    const images: InboundImage[] = [];
    let finalText = baseText;
    if (rawAttachments.length === 0 || !this.client) {
      return { finalText, images };
    }

    const fileParts: string[] = [];
    for (const att of rawAttachments) {
      const filePath = await this.downloadAttachment(att, channelId);
      if (!filePath) continue;
      const name = sanitizeFileName(att.filename || att.object_key?.split('/').pop() || 'file');
      let img: InboundImage | null = null;
      try {
        const { readFileSync } = await import('node:fs');
        img = await bufferToInboundImage(readFileSync(filePath), {
          contentType: att.content_type, mimeType: att.mime_type, filename: name,
        });
      } catch { /* read failed, treat as non-image file */ }
      if (img) {
        images.push(img);
        // 图片已注入视觉通道，不追加 [文件: …] 文本行
      } else {
        fileParts.push(`[文件: ${name} → ${filePath}]`);
      }
    }

    const parts: string[] = [];
    if (baseText) parts.push(baseText);
    if (fileParts.length > 0) {
      parts.push(...fileParts);
      parts.push('请使用 Read 工具读取文件内容。');
    }
    if (parts.length > 0) finalText = parts.join('\n\n');
    logger.info(`${this.logPrefix()} [attachments] count=${rawAttachments.length} images=${images.length} files=${fileParts.length}`);
    return { finalText, images };
  }

  private async downloadAttachment(
    att: { owner_aid?: string; object_key: string; filename?: string; sha256?: string; url?: string },
    channelId: string
  ): Promise<string | null> {
    const ownerAid = att.owner_aid || this._aid || '';
    const objectKey = att.object_key;

    if (!objectKey) {
      logger.warn(`${this.logPrefix()} Attachment missing object_key, skipping`);
      return null;
    }

    const filename = att.filename || objectKey.split('/').pop() || 'unknown';

    // 安全：始终通过受信任的 ticket 路径获取下载 URL。
    // 不信任 att.url（来自对端消息 payload，可被构造为内网/元数据地址，SSRF）。
    let downloadUrl = '';
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

    // SDK 0.5.* 移除了顶层 from/to/group_id/encrypted 等别名，统一从 msg.envelope.* 读取。
    // message_id / seq / payload / same_* 等仍是顶层独立字段，不在 envelope 内。
    const env = (msg.envelope && typeof msg.envelope === 'object') ? msg.envelope as Record<string, any> : {};
    const fromAid = env.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload, fromAid, fromAid);
    const threadId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Observer forward (inbound)：在所有过滤之前转发原始明文 payload。
    // forwardInbound 内部排除 self-echo 与 from-owner。
    // 显式排除 observer.inject：它是 owner 对本 agent 的控制消息，不应镜像给观察者
    // （即便日后 from-owner 排除规则调整，也不会泄漏）。
    const inboundType = (payload && typeof payload === 'object') ? (payload as any).type : undefined;
    if (inboundType !== AUNChannel.INJECT_REQUEST_TYPE) {
      this.forwardInbound(msg);
    }

    // 回声过滤：自己发出的消息会被 gateway fanout 回来，
    // 只有 from_aid == self 且 chat_id 不匹配时才丢弃（说明是其它实例发的）
    const msgChatId = typeof payload === 'object' && payload !== null && (payload as any).chat_id;
    if (this._aid && fromAid === this._aid && (!msgChatId || !this._chatId || msgChatId !== this._chatId)) {
      this.acknowledgeImmediately(messageId, seq);
      logger.debug(`${this.logPrefix()} P2P dropped: echo from self (from=${fromAid} mid=${messageId})`);
      return;
    }

    // 记录入站消息加密状态，透传到出站 ReplyContext
    const msgEncrypted = !!env.encrypted;
    if (!msgEncrypted) this.plaintextRecv++;

    // Detect @mentions
    const mentions: string[] = [];
    if (this._aid && text.includes(`@${this._aid}`)) {
      mentions.push(this._aid);
    }

    // Process attachments (顶层 + 嵌套在 merge.items / quote.quote 中的)
    const { finalText, images: inboundImages } = await this.processAttachments(payload, text, fromAid);

    // 私聊 channelId = 对端 AID（不再读 payload.chat_id 含 device 三段式）
    // device_id 仅 SDK 内部多实例去重用，evolclaw session 层面跨端共享会话
    const chatId = fromAid;

    // 解析对端身份（30天缓存）
    const selfAgentDir = path.join(resolvePaths().agentsDir, this.config.aid);
    const peerIdentity = await PeerIdentityCache.resolve('aun', fromAid, selfAgentDir, this.store!, false);
    const shortAid = this.getShortAid(fromAid);
    const displayName = peerIdentity.name || shortAid;

    // 详细 dispatch 决策日志：记录消息为何被路由到 agent
    const p2pPayloadType = (payload && typeof payload === 'object') ? (payload as any).type ?? '' : '';
    logger.info(`${this.logPrefix()} P2P dispatch decision: mid=${messageId} from=${shortAid}(${displayName}) peerType=${peerIdentity.type} payloadType=${p2pPayloadType} chatId=${chatId} encrypt=${msgEncrypted} textPreview=${JSON.stringify(text.slice(0, 80))}`);

    // action_card_reply 已在 extractTextPayload 中消费，不分发给 agent
    if (p2pPayloadType === 'action_card_reply') return;
    // menu.* 协议：自定义消息快速路径，需要原始 payload JSON 传递给 bridge
    if (AUNChannel.MENU_REQUEST_TYPES.has(p2pPayloadType)) {
      this.acknowledgeImmediately(messageId, seq);
      this.dispatchMessage({
        channelId: chatId, userId: fromAid,
        text: JSON.stringify(payload),
        chatType: 'private', messageId, seq,
        peerName: displayName || undefined,
        peerType: peerIdentity.type,
      });
      return;
    }
    // observer.inject：owner 插话。鉴权 from∈owners 后，以 target.channel_id 选 agent↔对端 会话，
    // observer 插话（v0.3）：只落盘到 pending-hints，不进 Agent、不回 owner。详见 docs/observer-insert-design.md。
    if (p2pPayloadType === AUNChannel.INJECT_REQUEST_TYPE) {
      this.acknowledgeImmediately(messageId, seq);
      this.handleObserverInject(fromAid, payload, displayName, peerIdentity.type);
      return;
    }
    // payload 类型白名单：信号类消息（status / event / thought 等）不进 Agent
    if (p2pPayloadType && !AUNChannel.PROACTIVE_ALLOW_TYPES.has(p2pPayloadType)) {
      this.acknowledgeImmediately(messageId, seq);
      logger.info(`${this.logPrefix()} P2P dropped (type deny): type=${p2pPayloadType} from=${shortAid}(${displayName}) mid=${messageId}`);
      return;
    }
    const msgChatmode = (payload && typeof payload === 'object') ? (payload as any).chatmode : undefined;
    logger.info(`${this.logPrefix()} P2P dispatched: from=${shortAid}(${displayName}) mid=${messageId} encrypt=${msgEncrypted} chatmode=${msgChatmode ?? 'none'} text=${finalText.slice(0, 60)}`);
    appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'message_in', aid: this.config.aid, from: fromAid, msgId: messageId, kind: 'text', len: finalText.length });
    const isSystemP2P = p2pPayloadType === 'event';
    this.aidStatsCollector?.recordInbound(this.config.aid, fromAid, Buffer.byteLength(finalText, 'utf-8'), finalText, isSystemP2P, msgEncrypted, msgChatmode);
    const replyContext: ReplyContext = { metadata: { encrypted: msgEncrypted, chatmode: msgChatmode } };
    if (threadId) replyContext.threadId = threadId;
    this.dispatchMessage({
      channelId: chatId,
      userId: fromAid,
      text: finalText,
      chatType: 'private',
      messageId,
      seq,
      threadId,
      mentions,
      peerName: displayName || undefined,
      peerType: peerIdentity.type,
      sameDevice: msg.same_device === true || undefined,
      sameNetwork: msg.same_network === true || undefined,
      sameEgressIp: msg.same_egress_ip === true || undefined,
      replyContext,
      images: inboundImages.length > 0 ? inboundImages : undefined,
    });
  }

  private async handleIncomingGroupMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    // SDK 0.5.* 移除了顶层 from/sender_aid/group_id/encrypted 等别名，统一从 msg.envelope.* 读取。
    // message_id / seq / payload / same_* / dispatch_mode 等仍是顶层独立字段，不在 envelope 内。
    const env = (msg.envelope && typeof msg.envelope === 'object') ? msg.envelope as Record<string, any> : {};
    const groupId = env.group_id ?? '';
    const senderAid = env.from ?? '';
    const payload = msg.payload ?? '';
    const text = this.extractTextPayload(payload, groupId, senderAid);
    const threadId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
    const messageId = msg.message_id ?? '';

    const seq = msg.seq;

    // Observer forward (inbound)：群聊消息在所有过滤之前转发原始明文 payload。
    // forwardInbound 内部排除 self-echo 与 from-owner。
    this.forwardInbound(msg);

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

    // 短 echo 快速通道：连通性测试要尽量低延迟，命中后绕过所有 await（后续 mention 过滤）
    {
      const firstLineFast = text.split('\n')[0] || '';
      const hasEvolClawTrace = /\[EvolClaw\.(receive|reply|agent)\]/.test(text);
      if (/echo/i.test(firstLineFast) && firstLineFast.trim().length <= 10 && !hasEvolClawTrace) {
        this.acknowledgeImmediately(messageId, seq);
        const msgEncryptedFast = !!env.encrypted;
        const msgChatmodeFast = (payload && typeof payload === 'object') ? (payload as any).chatmode : undefined;
        const peerInfo = this.peerInfoCached(senderAid);
        const shortAid = this.getShortAid(senderAid);
        const displayName = peerInfo?.name || shortAid;
        const createdAt = (data as any).created_at as number | undefined;
        if (!peerInfo) this.prefetchPeerInfo(senderAid);
        this.handleEcho({
          channelId: groupId,
          userId: senderAid,
          text,
          chatType: 'group',
          messageId,
          peerName: displayName,
          peerType: peerInfo?.type || 'unknown',
          seq,
          replyContext: this.buildGroupReplyContext(undefined, senderAid, msgEncryptedFast, messageId, msgChatmodeFast),
          createdAt,
        });
        return;
      }
    }

    // action_card_reply 已在 extractTextPayload 中消费，不分发给 agent
    {
      const payloadType = (payload && typeof payload === 'object') ? (payload as any).type ?? '' : '';
      if (payloadType === 'action_card_reply') return;
    }

    // ── payload 类型白名单（所有模式生效） ──
    // 信号类消息（status / event / thought / task.update 等）不进 Agent
    {
      const payloadObj = (payload && typeof payload === 'object') ? payload as Record<string, any> : null;
      const payloadType: string = payloadObj?.type ?? '';
      // menu.* 协议：自定义消息快速路径
      if (AUNChannel.MENU_REQUEST_TYPES.has(payloadType)) {
        this.acknowledgeImmediately(messageId, seq);
        this.dispatchMessage({
          channelId: groupId, userId: senderAid,
          text: JSON.stringify(payload),
          chatType: 'group', messageId, seq, groupId,
        });
        return;
      }
      if (payloadType && !AUNChannel.PROACTIVE_ALLOW_TYPES.has(payloadType)) {
        this.acknowledgeImmediately(messageId, seq);
        logger.info(`${this.logPrefix()} Group dropped (type deny): type=${payloadType} group=${groupId} sender=${senderAid} mid=${messageId}`);
        return;
      }
    }

    // 记录入站消息加密状态，透传到出站 ReplyContext
    const msgEncrypted = !!env.encrypted;
    if (!msgEncrypted) this.plaintextRecv++;

    // dispatch_mode: 本地设置优先，fallback 到服务器参数
    const serverDispatchMode: string = msg.dispatch_mode ?? (payload as any)?.dispatch_mode ?? 'mention';
    const localDispatchMode = this.dispatchModeResolver
      ? await this.dispatchModeResolver(groupId).catch(() => undefined)
      : undefined;
    const dispatchMode = localDispatchMode || serverDispatchMode;

    const mentionedSelf = this._aid
      ? (this.hasExplicitMention(text, this._aid) || payloadMentions.includes(this._aid))
      : false;
    // @all 仅认结构化 mentions（payload.mentions），不扫描正文 — 避免引述性 "@all" 误判
    const mentionedAll = payloadMentions.includes('all');

    // Echo 机制优先于 mention 过滤：消息第一行包含 echo 时触发
    // 包含 [EvolClaw.xxx] trace 说明已被本系统处理过，是回声的回声，丢弃防止链式爆炸
    const firstLineGroup = text.split('\n')[0] || '';
    const hasEvolClawTraceGroup = /\[EvolClaw\.(receive|reply|agent)\]/.test(text);
    if (/echo/i.test(firstLineGroup) && !hasEvolClawTraceGroup) {
      // 短 echo（≤10 字符）已在前面的快速通道命中并 return，这里只处理长 echo
      // >10 字符：追加 trace,存 pending echo,跳过 mention 过滤继续走 Agent 流程
      const echoTs = () => {
        const d = new Date();
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
      };
      let echoText = text;
      echoText += `\n${echoTs()} [EvolClaw.receive] from=${senderAid} mid=${messageId} chat=group self=${this._aid || 'unknown'} conn_uptime=${this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) + 's' : 'unknown'}`;
      const msgChatmodeEcho = (payload && typeof payload === 'object') ? (payload as any).chatmode : undefined;
      this.pendingEchoMessages.set(messageId, {
        text: echoText,
        channelId: groupId,
        context: this.buildGroupReplyContext(undefined, senderAid, msgEncrypted, messageId, msgChatmodeEcho),
        receiveTs: Date.now(),
      });
      // 继续走正常 Agent 流程（下面的代码会 dispatch）
    } else if (/echo/i.test(firstLineGroup) && hasEvolClawTraceGroup) {
      // 回声炸弹：已被任何 EvolClaw 节点 trace 过的 echo，直接丢弃
      this.acknowledgeImmediately(messageId, seq);
      logger.info(`${this.logPrefix()} Group dropped: echo bomb (already-traced group=${groupId} sender=${senderAid} mid=${messageId})`);
      return;
    } else {
      // 非 echo 消息：正常 mention 过滤
      if (dispatchMode === 'mention' && !mentionedSelf && !mentionedAll) {
        this.acknowledgeImmediately(messageId, seq);
        logger.info(`${this.logPrefix()} Group dropped: unmentioned in mention-mode (group=${groupId} sender=${senderAid} mid=${messageId} textPreview=${JSON.stringify(text.slice(0, 80))})`);
        return;
      }
    }

    const strippedText = this.stripSelfMentionIfOnly(text, this._aid);

    // Detect attachments before the empty-text guard (顶层 + 嵌套)
    const rawAttachments: any[] = this.collectAllAttachments(payload);
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
    const { finalText, images: inboundImages } = await this.processAttachments(
      payload, strippedText, groupId, rawAttachments,
    );

    const selfAgentDir = path.join(resolvePaths().agentsDir, this.config.aid);
    const peerIdentity = await PeerIdentityCache.resolve('aun', senderAid, selfAgentDir, this.store!, false);
    const shortAid = this.getShortAid(senderAid);
    const displayName = peerIdentity.name || shortAid;

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
    logger.info(`${this.logPrefix()} Group dispatch decision: mid=${messageId} group=${groupId} sender=${shortAid}(${displayName}) peerType=${peerIdentity.type} payloadType=${payloadType} dispatchMode=${dispatchMode} reason=${reason} structMentions=${JSON.stringify(payloadMentions)} textMentionSelf=${textMentionSelf} textMentionAll=${textMentionAll} structMentionSelf=${structMentionSelf} structMentionAll=${structMentionAll} encrypt=${msgEncrypted} textPreview=${JSON.stringify(text.slice(0, 80))}`);

    // action_card_reply 已在 extractTextPayload 中消费，不分发给 agent
    if (payloadType === 'action_card_reply') return;
    const msgChatmode = (payload && typeof payload === 'object') ? (payload as any).chatmode : undefined;
    logger.info(`${this.logPrefix()} Group dispatched: group=${groupId} sender=${shortAid}(${displayName}) mode=${dispatchMode} mid=${messageId} chatmode=${msgChatmode ?? 'none'} text=${finalText.slice(0, 60)}`);
    appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'message_in', aid: this.config.aid, from: senderAid, msgId: messageId, kind: 'text', len: finalText.length, groupId });
    this.aidStatsCollector?.recordInbound(this.config.aid, senderAid, Buffer.byteLength(finalText, 'utf-8'), finalText, payloadType === 'event', msgEncrypted, msgChatmode);
    // 渲染用完整 @ 列表：结构化 payload.mentions + 正文 @aid 兜底，去重（含 self / "all"）。
    // 与上面用于过滤/回复的精简 mentions 独立——这份不丢任何被 @ 的 AID。
    const renderMentionAids = Array.from(new Set([
      ...payloadMentions,
      ...this.extractMentionAidsFromText(text),
    ]));

    this.dispatchMessage({
      channelId: groupId,
      groupId,
      userId: senderAid,
      peerName: displayName || undefined,
      peerType: peerIdentity.type,
      sameDevice: msg.same_device === true || undefined,
      sameNetwork: msg.same_network === true || undefined,
      sameEgressIp: msg.same_egress_ip === true || undefined,
      text: finalText,
      chatType: 'group',
      messageId,
      seq,
      threadId,
      mentions,
      mentionAids: renderMentionAids.length > 0 ? renderMentionAids : undefined,
      replyContext: this.buildGroupReplyContext(threadId, senderAid, msgEncrypted, messageId, msgChatmode),
      dispatchMode,
      images: inboundImages.length > 0 ? inboundImages : undefined,
    });
  }

  private dispatchMessage(event: {
    channelId: string; userId: string; text: string;
    chatType: 'private' | 'group'; messageId: string;
    peerName?: string; peerType?: string;
    sameDevice?: boolean; sameNetwork?: boolean; sameEgressIp?: boolean;
    seq?: number; threadId?: string; mentions?: string[];
    mentionAids?: string[];
    replyContext?: ReplyContext;
    groupId?: string;
    source?: 'user' | 'card-trigger';
    dispatchMode?: string;
    images?: Array<{ data: string; mimeType: string }>;
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

    // Echo 机制：消息第一行包含 "echo"（不区分大小写）且原始内容 ≤10 字符时，直接回声
    // 包含 [EvolClaw.xxx] trace 说明已被本系统处理过，是回声的回声，丢弃防止链式爆炸
    const firstLine = event.text.split('\n')[0] || '';
    const hasEvolClawTracePrivate = /\[EvolClaw\.(receive|reply|agent)\]/.test(event.text);
    if (/echo/i.test(firstLine) && firstLine.trim().length <= 10 && !hasEvolClawTracePrivate) {
      this.handleEcho(event);
      return;
    }

    // 回声炸弹：已被任何 EvolClaw 节点 trace 过的 echo，直接丢弃（防止多 agent 间无限回声）
    if (/echo/i.test(firstLine) && hasEvolClawTracePrivate) {
      logger.info(`${this.logPrefix()} Dropped: echo bomb (already-traced mid=${event.messageId} chat=${event.chatType})`);
      return;
    }

    // 长 echo（>10 字符）：存 pending,继续交给 agent 处理
    if (/echo/i.test(firstLine) && firstLine.trim().length > 10 && !hasEvolClawTracePrivate) {
      const echoTs = () => {
        const d = new Date();
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
      };
      let echoText = event.text;
      echoText += `\n${echoTs()} [EvolClaw.receive] from=${event.userId}${event.peerName ? `(${event.peerName})` : ''} mid=${event.messageId} chat=${event.chatType} self=${this._aid || 'unknown'} conn_uptime=${this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) + 's' : 'unknown'}`;
      this.pendingEchoMessages.set(event.messageId, {
        text: echoText,
        channelId: event.channelId,
        context: event.replyContext ? { metadata: event.replyContext.metadata } : undefined,
        receiveTs: Date.now(),
      });
      logger.info(`${this.logPrefix()} [Echo] long echo stored: mid=${event.messageId} channelId=${event.channelId}`);
    }

    if (!this.messageHandler) return;

    const mentionObjects = event.mentions?.map(aid => ({ userId: aid }));

    // Use caller-supplied replyContext (group path builds mentionUserIds);
    // fall back to simple threadId-only context for private messages
    let replyContext: ReplyContext | undefined = event.replyContext;
    if (!replyContext && event.threadId) {
      replyContext = { threadId: event.threadId };
    }

    this.messageHandler({
      channelId: event.channelId || '',
      channelType: 'aun',
      content: event.text || '',
      selfAID: this._aid,
      groupId: event.groupId,
      chatType: event.chatType,
      peerId: event.userId || event.channelId || '',
      peerName: event.peerName,
      peerType: event.peerType,
      sameDevice: event.sameDevice,
      sameNetwork: event.sameNetwork,
      sameEgressIp: event.sameEgressIp,
      messageId: event.messageId,
      threadId: event.threadId,
      mentions: mentionObjects,
      mentionAids: event.mentionAids,
      replyContext,
      source: event.source,
      dispatchMode: event.dispatchMode,
      images: event.images,
    }).catch(err => {
      logger.error(`${this.logPrefix()} Message handler error:`, err);
    });
  }

  // ── 观察者模式（Observer Mode） ──────────────────────────────
  //
  // observable=true 时，Agent 收发的每条 AUN 消息（原始信封 + 解密后明文
  // payload）镜像一份给 owners[]。入站在所有过滤之前转发；出站在真实发送
  // 成功后转发。外层一律明文。详见 docs/observer-mode-design.md。

  // observable / owners 不在此处缓存——由 daemon 注入 resolver，从 EvolAgent 的
  // in-memory merged config（启动/重启/热重载时统一更新的唯一缓存）读取，避免重复缓存。
  private observerConfigResolver?: () => { observable: boolean; owners: string[] };

  /** 注入观察者配置读取器（daemon 侧从 EvolAgent merged config 读）。 */
  setObserverConfigResolver(fn: () => { observable: boolean; owners: string[] }): void {
    this.observerConfigResolver = fn;
  }

  /** 读取 observable 开关 + owners；无 resolver（如未接入 daemon）时视为关闭。 */
  private getObserverConfig(): { observable: boolean; owners: string[] } {
    return this.observerConfigResolver?.() ?? { observable: false, owners: [] };
  }

  /**
   * 入站转发：到达本 AID 的消息全部转发，排除 self-echo。
   * 若消息发送方本身是 owner，则不转发给该 owner，但仍转发给其他 owner。
   * 调用点须在所有过滤逻辑之前，payload 为 SDK 解密后的明文。
   */
  /**
   * 入站转发：把对端发来的消息原样转发给 owner。
   * data 为 SDK message.received / group.message_created 回调的整个对象，
   * 不拆解、不重组——SDK 信封结构变化不影响此处。
   */
  private forwardInbound(data: Record<string, any>): void {
    if (!this.connected || !this.client) return;
    const { observable, owners } = this.getObserverConfig();
    if (!observable || owners.length === 0) return;
    const env = (data?.envelope && typeof data.envelope === 'object') ? data.envelope : {};
    const from = env.from ?? '';
    if (this._aid && from === this._aid) return;   // self-echo：已在出站转过
    // 排除来源 owner（不把"owner A 发来的"再转回 A），但仍转给其他 owner。
    const recipientOwners = owners.filter(o => o !== from);
    if (recipientOwners.length === 0) return;
    this.emitForward('inbound', data, recipientOwners);
  }

  /**
   * 出站转发：Agent 经 AUN 真实发出的消息原样转发给 owner。
   * result 为 SDK message.send / group.send 的 SendResult（已 attach envelope + payload）。
   * 若对端本身是 owner，排除该 owner（不把"回复 A"转发给 A 自己）。
   */
  private forwardOutbound(result: Record<string, any>): void {
    if (!this.connected || !this.client) return;
    const { observable, owners } = this.getObserverConfig();
    if (!observable || owners.length === 0) return;
    const env = (result?.envelope && typeof result.envelope === 'object') ? result.envelope : {};
    const to = env.to ?? env.group_id ?? '';
    // 过滤：若对端本身是 owner，不转发给该 owner（避免"回复你"转给你自己）；
    // 但仍转发给其他 owner。
    const recipientOwners = owners.filter(o => o !== to);
    if (recipientOwners.length === 0) return;
    this.emitForward('outbound', result, recipientOwners);
  }

  /**
   * 实际投递 observer.forward 给每个 owner，外层一律明文。
   * original 为 SDK 给到的原始对象（入站回调 data / 出站 SendResult），整体透传，
   * 不挑字段、不改字段——SDK 加任何字段都会自动一并转发给 owner。
   */
  private emitForward(
    direction: 'inbound' | 'outbound',
    original: unknown,
    owners: string[],
  ): void {
    const forwardPayload = {
      type: 'observer.forward',
      direction,
      agent_aid: this.config.aid,
      original,
    };
    for (const ownerAid of owners) {
      this.callAndTrace('message.send', { to: ownerAid, payload: forwardPayload, encrypt: false })
        .catch(e => logger.debug(`${this.logPrefix()} observer.forward to ${ownerAid} failed: ${e}`));
    }
  }

  // ── 观察者插话（Observer Insert，v0.3 待用上下文提示） ──────────────
  //
  // owner 经 message.send 给 agent 自身 AID 发 observer.inject（payload 为对象）。
  // 鉴权 from∈owners 后，把提示【只落盘】到 agent↔对端 会话的 pending-hints.jsonl
  // （不 dispatch、不跑 LLM、不回 owner）；下一条对端消息到达时由 message-processor
  // 回放消费、注入渲染层。action=add 加提示 / remove 撤销。
  // 详见 docs/observer-insert-design.md 第一部分。

  /** 回 observer.inject.ack 给 owner（明文）。accepted 在成功写盘之后发出。 */
  private emitInjectAck(
    ownerAid: string,
    injectId: string | undefined,
    data?: { status: 'accepted' | 'rejected'; action?: 'add' | 'remove' },
    error?: { code: string; message: string },
  ): void {
    if (!this.connected || !this.client) return;
    const ackPayload: Record<string, any> = { type: 'observer.inject.ack' };
    if (injectId) ackPayload.id = injectId;
    if (data) ackPayload.data = data;
    if (error) ackPayload.error = error;
    this.callAndTrace('message.send', { to: ownerAid, payload: ackPayload, encrypt: false })
      .catch(e => logger.debug(`${this.logPrefix()} observer.inject.ack to ${ownerAid} failed: ${e}`));
  }

  /** 处理 observer.inject：鉴权 + 校验 + 只落盘到 pending-hints（不触发处理、不回 owner）。 */
  private handleObserverInject(
    fromAid: string,
    payload: unknown,
    displayName?: string,
    peerType?: string,
  ): void {
    void peerType;
    const { owners } = this.getObserverConfig();
    const ts = Date.now();
    const req = parseInjectRequest(payload, fromAid, owners, ts);

    if (req.kind === 'reject') {
      logger.warn(`${this.logPrefix()} observer.inject rejected: ${this.getShortAid(fromAid)} ${req.code}`);
      this.emitInjectAck(fromAid, req.injectId, { status: 'rejected', action: req.action }, { code: req.code, message: req.message });
      return;
    }

    const selfAID = this.config.aid;
    const sessionsDir = resolvePaths().sessionsDir;

    let ok: boolean;
    if (req.kind === 'remove') {
      ok = appendHintRemove(sessionsDir, 'aun', req.channelId, selfAID, { targetId: req.targetId, threadId: req.threadId, ts });
    } else {
      ok = appendHintAdd(sessionsDir, 'aun', req.channelId, selfAID, { id: req.id, text: req.text, threadId: req.threadId, ownerAid: req.ownerAid, ts });
    }

    if (!ok) {
      this.emitInjectAck(fromAid, req.injectId, { status: 'rejected', action: req.kind }, { code: 'STORE_FAILED', message: '提示落盘失败' });
      return;
    }

    logger.info(`${this.logPrefix()} observer.inject ${req.kind} stored: from=${this.getShortAid(fromAid)}(${displayName}) target=${req.channelId} chatType=${req.chatType} thread=${req.threadId ?? 'main'}${req.kind === 'add' ? ` textLen=${req.text.length}` : `${req.targetId ? ` targetId=${req.targetId}` : ' (clear-all)'}`}`);
    this.emitInjectAck(fromAid, req.injectId, { status: 'accepted', action: req.kind });

    // 记录到 watch（被观察的 agent↔对端 会话），带 owner-inject 标记区分对端真实消息。
    // v0.3：只记"提示已添加/已撤销"，不触发处理、不产生 agent→owner 回应。
    const watchText = req.kind === 'remove' ? `[撤销提示]${req.targetId ? ` id=${req.targetId}` : '（全部）'}` : req.text;
    const synthId = `inject-${req.injectId || ts}`;
    this.recordInjectWatch('in', fromAid, req.channelId, req.chatType, synthId, watchText);
  }

  /**
   * 把 observer 插话 / 对插话的回应记录到 watch（被观察的 agent↔对端 会话），
   * 带 source='owner-inject' 标记，与对端真实消息区分。
   * 写三处：messages.jsonl（watch msg）、appendAidEvent（watch aid 事件流）、aidStatsCollector（统计）。
   * @param dir 'in'=owner→agent 插话；'out'=agent→owner 对插话的回应
   * @param peerChannelId 被观察会话的对端（agent↔对端），日志落点 = sessions/aun/<self>/<peerChannelId>/
   */
  private recordInjectWatch(
    dir: 'in' | 'out',
    ownerAid: string,
    peerChannelId: string,
    chatType: 'private' | 'group',
    msgId: string,
    text: string,
  ): void {
    try {
      const selfAID = this.config.aid;
      const isGroup = chatType === 'group';
      const chatDir = chatDirPath(resolvePaths().sessionsDir, 'aun', peerChannelId, selfAID);
      const entry = dir === 'in'
        ? buildInboundEntry({
            from: ownerAid, to: selfAID, chatType,
            groupId: isGroup ? peerChannelId : null, msgId, content: text,
            permMode: 'owner', source: 'owner-inject',
          })
        : buildOutboundEntry({
            from: selfAID, to: ownerAid, chatType,
            groupId: isGroup ? peerChannelId : null, msgId, content: text,
            source: 'owner-inject',
          });
      appendMessageLog(chatDir, entry);
    } catch (e) {
      logger.debug(`${this.logPrefix()} recordInjectWatch(msg) failed: ${e}`);
    }
    // watch aid：事件流 + 统计（标 inject，便于过滤）
    try {
      const len = Buffer.byteLength(text, 'utf-8');
      if (dir === 'in') {
        appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'message_in', aid: this.config.aid, from: ownerAid, msgId, kind: 'text', len, inject: true });
        this.aidStatsCollector?.recordInbound(this.config.aid, ownerAid, len, text, false, false, 'inject');
      } else {
        appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'message_out', aid: this.config.aid, to: ownerAid, msgId, kind: 'text', len, inject: true });
        this.aidStatsCollector?.recordOutbound(this.config.aid, ownerAid, len, text, false, false, 'inject');
      }
    } catch (e) {
      logger.debug(`${this.logPrefix()} recordInjectWatch(aid) failed: ${e}`);
    }
  }

  private handleEcho(event: {
    channelId: string; userId: string; text: string;
    chatType: 'private' | 'group'; messageId: string;
    peerName?: string; peerType?: string;
    seq?: number; replyContext?: ReplyContext;
    createdAt?: number;
  }): void {
    const ts = () => {
      const d = new Date();
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    };

    // 在收到的消息文本末尾追加 trace 行（只追加,不修改原文）
    let echoText = event.text;
    echoText += `\n${ts()} [EvolClaw.receive] from=${event.userId}${event.peerName ? `(${event.peerName})` : ''} mid=${event.messageId} chat=${event.chatType} self=${this._aid || 'unknown'} conn_uptime=${this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) + 's' : 'unknown'}`;
    echoText += `\n${ts()} [EvolClaw.reply] echo回声发出 conn_uptime=${this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) + 's' : 'unknown'}`;
    if (Buffer.byteLength(echoText, 'utf-8') > 4096) {
      echoText += `\n[TRUNCATED]`;
    }

    const replyTarget = event.channelId;
    // 不传 peerId,避免 sendMessage 在头部追加 @peer
    const context: ReplyContext = { metadata: event.replyContext?.metadata };

    const sendStart = Date.now();
    this.isEchoSending = true;
    this.sendMessage(replyTarget, echoText, context).then(() => {
      this.isEchoSending = false;
      const elapsed = Date.now() - sendStart;
      logger.info(`${this.logPrefix()} Echo reply sent to ${replyTarget} (${elapsed}ms)`);
    }).catch(e => {
      this.isEchoSending = false;
      logger.error(`${this.logPrefix()} Echo reply failed: ${e}`);
    });
  }

  /**
   * 处理 SDK 'gateway.disconnect' 事件 — 服务端主动断开（含同槽位互踢）。
   *
   * 当另一个进程用同 AID + 同 slot 抢连接时，老连接会被踢，detail 字段含：
   *   - self_extra_info: 本进程当时 connect 上报的内容（可证明"是我自己被踢了"）
   *   - new_extra_info:  挤掉本连接的新进程上报的内容（指出"谁踢的我"）
   *
   * 把这些信息打到 logger.warn，便于通过 evolclaw watch / 日志查看。
   */
  private handleGatewayDisconnect(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, any>;
    const code = d.code;
    const reason = d.reason ?? '';
    const detail = (d.detail && typeof d.detail === 'object' && !Array.isArray(d.detail)) ? d.detail : {};
    const selfExtra = detail.self_extra_info;
    const newExtra = detail.new_extra_info;

    const fmtExtra = (e: unknown): string => {
      if (!e || typeof e !== 'object') return '<none>';
      const obj = e as Record<string, unknown>;
      const parts: string[] = [];
      const keys = ['app', 'version', 'pid', 'started_at_iso', 'hostname', 'launched_by', 'evolclaw_home', 'agent_name', 'channel_name'];
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== '') parts.push(`${k}=${String(obj[k])}`);
      }
      return parts.length ? parts.join(' ') : JSON.stringify(obj);
    };

    if (selfExtra || newExtra) {
      logger.warn(`${this.logPrefix()} 🥊 Kicked by another connection (code=${code} reason=${reason})`);
      logger.warn(`${this.logPrefix()}   ↳ me  : ${fmtExtra(selfExtra)}`);
      logger.warn(`${this.logPrefix()}   ↳ them: ${fmtExtra(newExtra)}`);
    } else {
      logger.warn(`${this.logPrefix()} Server-initiated disconnect: code=${code} reason=${reason} detail=${JSON.stringify(detail)}`);
    }
  }

  private handleConnectionState(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const state = (data as Record<string, any>).state ?? '';

    if (state === 'connected') {
      this.connected = true;
      this.connectedAt = Date.now();
      this.lastReconnectLogTime = 0;
      this.lastReconnectLogAttempt = 0;
      // connection.state 事件 payload 带实际连接的 gateway，更新本地缓存
      const evtGateway = (data as Record<string, any>).gateway;
      if (typeof evtGateway === 'string' && evtGateway) this.gatewayUrl = evtGateway;
      this.setAidStatus('connected', { lastConnectedAt: Date.now(), lastError: undefined, gatewayUrl: this.gatewayUrl });
      this.trace('IN', 'connection.state', data);
      logger.info(`${this.logPrefix()} Connected`);
      // 不在这里清 flapCount —— 短命连接一上来就会触发本分支，
      // 必须等 disconnected 时根据 lifetime 决定是否清零
      this.drainOutbox();
    } else if (state === 'disconnected' || state === 'reconnecting') {
      const wasConnected = this.connected;
      this.connected = false;
      this.aidState.reconnectCount++;
      this.aidState.lastAttemptAt = Date.now();
      this.setAidStatus('reconnecting');

      // Flap 检测：仅在从 connected 状态过渡时统计
      if (wasConnected && this.connectedAt > 0) {
        const lifetime = Date.now() - this.connectedAt;
        this.connectedAt = 0;
        if (lifetime < AUNChannel.FLAP_WINDOW_MS) {
          this.flapCount++;
          logger.warn(`${this.logPrefix()} Flap #${this.flapCount}/${AUNChannel.FLAP_THRESHOLD}: connection lived ${lifetime}ms (< ${AUNChannel.FLAP_WINDOW_MS}ms)`);
          if (this.flapCount >= AUNChannel.FLAP_THRESHOLD && !this.intentionalDisconnect) {
            logger.error(`${this.logPrefix()} Persistent kick detected (${this.flapCount} flaps), taking over from SDK with ${AUNChannel.TAKEOVER_DELAY_MS / 1000}s backoff`);
            this.flapCount = 0;
            this.takeoverReconnect(AUNChannel.TAKEOVER_DELAY_MS, 'flap');
            return;
          }
        } else {
          // 连接稳定过 ≥ FLAP_WINDOW_MS，重置 flap 计数
          if (this.flapCount > 0) {
            logger.info(`${this.logPrefix()} Stable connection (lived ${lifetime}ms), resetting flap counter`);
          }
          this.flapCount = 0;
        }
      }

      if (state === 'disconnected') {
        this.trace('IN', 'connection.state', data);
        logger.warn(`${this.logPrefix()} Disconnected: ${(data as Record<string, any>).error ?? 'unknown'}`);
      } else {
        // reconnecting：节流日志（SDK 自己已经在跑指数退避，不刷屏）
        const attempt = (data as Record<string, any>).attempt ?? 0;
        const now = Date.now();
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
      }
    } else if (state === 'terminal_failed') {
      this.connected = false;
      this.connectedAt = 0;
      this.trace('IN', 'connection.state', data);
      const d = data as Record<string, any>;
      const reason: string = d.reason ?? '';
      const error = d.error ?? 'unknown';
      const code: number = d.code ?? d.detail?.code ?? 0;
      const detail = (d.detail && typeof d.detail === 'object') ? d.detail : {};

      if (this.intentionalDisconnect) return;

      if (this.isKickReason(reason) || code >= 4001) {
        // @ts-ignore — methods defined below in same class
        const kickDetail = this.buildKickDetail(code, reason, detail);
        // @ts-ignore — methods defined below in same class
        const action = this.classifyKickAction(code);

        appendAidEvent({
          ts: Date.now(), iso: new Date().toISOString(),
          event: 'kicked', aid: this.config.aid,
          code, reason, action,
          evictedBy: kickDetail.evictedBy,
          quotaKind: kickDetail.quotaKind,
        });
        appendAidLifecycle({
          ts: Date.now(), iso: new Date().toISOString(),
          event: 'kicked', aid: this.config.aid,
          code, reason, action,
          evictedBy: kickDetail.evictedBy,
          newExtra: kickDetail.newExtra,
          quotaKind: kickDetail.quotaKind,
        });

        if (action === 'no_retry') {
          logger.error(`${this.logPrefix()} Kicked (code=${code}): ${reason} — will NOT retry`);
          this.setAidStatus('kicked_no_retry', { lastError: `kicked(${code}): ${reason}`.slice(0, 80), kickDetail });
        } else if (action === 'retry_once') {
          logger.warn(`${this.logPrefix()} Kicked (code=${code}): ${reason} — retrying once after ${AUNChannel.FALLBACK_DELAY_MS / 1000}s`);
          this.setAidStatus('kicked', { lastError: `kicked(${code}): ${reason}`.slice(0, 80), kickDetail });
          this.takeoverReconnect(AUNChannel.FALLBACK_DELAY_MS, 'kicked');
        } else {
          logger.warn(`${this.logPrefix()} Kicked (code=${code}): ${reason} — retrying after ${AUNChannel.TAKEOVER_DELAY_MS / 1000}s`);
          this.setAidStatus('kicked', { lastError: `kicked(${code}): ${reason}`.slice(0, 80), kickDetail });
          this.takeoverReconnect(AUNChannel.TAKEOVER_DELAY_MS, 'kicked');
        }
      } else {
        logger.error(`${this.logPrefix()} Terminal failure: ${error}${reason ? ` (${reason})` : ''}, retrying in ${AUNChannel.FALLBACK_DELAY_MS / 1000}s`);
        this.setAidStatus('failed', { lastError: `${error}`.slice(0, 80) });
        this.takeoverReconnect(AUNChannel.FALLBACK_DELAY_MS, 'terminal');
      }
    }
  }

  /** 判断 terminal_failed 的 reason 是否属于"被踢"类 */
  private isKickReason(reason: string): boolean {
    if (!reason) return false;
    const r = reason.toLowerCase();
    if (r.includes('kicked') || r.includes('kick')) return true;
    if (/close code 40\d{2}/.test(r)) return true;
    return false;
  }

  /**
   * 根据 close code 决定重试策略：
   * - 'no_retry': 不重试（被挤掉、AID 无效、ACL 拒绝、长连接已存在、配额超限）
   * - 'retry_once': 重试一次（auth 失败可能 token 刚过期、nonce 无效）
   * - 'retry_delay': 延迟重试（短连接容量超限、空闲超时）
   */
  private classifyKickAction(code: number): 'no_retry' | 'retry_once' | 'retry_delay' {
    switch (code) {
      case 4003: // AID 无效
      case 4009: // 服务端主动踢
      case 4011: // ACL 拒绝
      case 4012: // 长连接已存在（自己另一个实例在线）
      case 4015: // 被新连接挤掉
        return 'no_retry';
      case 4001: // auth 失败（token 可能刚过期）
      case 4010: // nonce 无效
        return 'retry_once';
      case 4008: // auth 超时
      case 4013: // 短连接容量超限
      case 4014: // 短连接空闲超时
        return 'retry_delay';
      default:
        return 'retry_delay';
    }
  }

  private buildKickDetail(code: number, reason: string, detail: Record<string, any>): AidKickDetail {
    const evictedByRaw = detail.evicted_by || detail.new_extra_info;
    let evictedBy: AidKickDetail['evictedBy'];
    if (evictedByRaw && typeof evictedByRaw === 'object') {
      evictedBy = {
        aid: evictedByRaw.aid,
        deviceId: evictedByRaw.device_id,
        slotId: evictedByRaw.slot_id,
        app: evictedByRaw.app,
        hostname: evictedByRaw.hostname,
      };
    }
    return {
      code,
      reason,
      ts: Date.now(),
      evictedBy,
      quotaKind: detail.quota_kind,
      limit: detail.limit,
      selfExtra: detail.self_extra_info,
      newExtra: detail.new_extra_info,
    };
  }

  /**
   * TS 层接管重连：force close 当前 SDK client，安排 delayMs 后重新 initClient。
   * 用于 flap / kicked / terminal_failed 三类场景，统一退避路径。
   */
  private takeoverReconnect(delayMs: number, reason: 'flap' | 'kicked' | 'terminal'): void {
    if (this.intentionalDisconnect) return;

    // 递增 generation，使任何正在进行的旧 initClient 回调失效
    const gen = ++this.reconnectGeneration;

    // 清掉已有 timer，避免叠加
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Force close SDK client，中断它内部的重连循环
    if (this.client) {
      this.trace('OUT', 'client.close', { reason: `takeover_${reason}` });
      this.client.close().catch(() => {});
      this.client = null;
    }
    this.connected = false;

    const delaySec = Math.round(delayMs / 1000);
    logger.info(`${this.logPrefix()} Scheduling TS-layer reconnect (${reason}) in ${delaySec}s`);
    this.trace('OUT', 'reconnect.scheduled', { reason, delayMs, generation: gen });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // 如果在等待期间又触发了新的 takeoverReconnect，本次作废
      if (gen !== this.reconnectGeneration) {
        logger.info(`${this.logPrefix()} TS-layer reconnect (${reason}) cancelled: generation stale (${gen} vs ${this.reconnectGeneration})`);
        return;
      }
      try {
        logger.info(`${this.logPrefix()} TS-layer reconnect (${reason}) starting...`);
        this.trace('OUT', 'reconnect.start', { reason, generation: gen });
        await this.initClient();
        // initClient 完成后再次校验 generation，防止 initClient 期间被新的 takeover 取代
        if (gen !== this.reconnectGeneration) {
          logger.info(`${this.logPrefix()} TS-layer reconnect (${reason}) succeeded but generation stale, closing stale client`);
          if (this.client) { this.client.close().catch(() => {}); this.client = null; }
          this.connected = false;
          return;
        }
        this.trace('OUT', 'reconnect.ok', { reason, generation: gen });
        logger.info(`${this.logPrefix()} TS-layer reconnect (${reason}) succeeded`);
      } catch (err) {
        this.trace('OUT', 'reconnect.error', { reason, error: String(err), generation: gen });
        logger.error(`${this.logPrefix()} TS-layer reconnect (${reason}) failed: ${err}`);
        // initClient 内部已经在失败路径触发 scheduleReconnect 了，这里不重复
      }
    }, delayMs);
  }

  // ── Public API (same interface as before) ───────────────────

  setEventBus(bus: any): void {
    // 重新订阅前先解掉旧的——避免 reload/重连后 listener 累积
    if (this.eventBus && this.ownerBoundHandler && typeof this.eventBus.unsubscribe === 'function') {
      this.eventBus.unsubscribe('channel:owner-bound', this.ownerBoundHandler);
    }
    if (this.eventBus && this.queuedHandler && typeof this.eventBus.unsubscribe === 'function') {
      this.eventBus.unsubscribe('task:queued', this.queuedHandler);
    }
    this.ownerBoundHandler = null;
    this.queuedHandler = null;
    this.eventBus = bus;
    if (bus && typeof bus.subscribe === 'function') {
      const handler = (event: any) => {
        if (event.channelName !== this.config.channelName) return;
        // sendWelcomeMessage 内部读 config.json 中最新的 owners[0]，并幂等检查 initialized
        // 自身做 client 健康检查后再发
        if (!this.client) {
          logger.info(`${this.logPrefix()} owner-bound event received but client not connected; skip welcome retry`);
          return;
        }
        this.sendWelcomeMessage().catch(e => {
          logger.warn(`${this.logPrefix()} owner-bound welcome retry failed: ${e}`);
        });
      };
      bus.subscribe('channel:owner-bound', handler);
      this.ownerBoundHandler = handler;

      const queuedHandler = (event: any) => {
        if (event.channel !== this.config.channelName) return;
        this.sendProcessingStatus(event.channelId, 'queued', '', '', event.replyContext);
      };
      bus.subscribe('task:queued', queuedHandler);
      this.queuedHandler = queuedHandler;
    }
  }

  onProjectPathRequest(provider: (channelId: string) => Promise<string>): void {
    this.projectPathProvider = provider;
  }

  onMessage(handler: AUNMessageHandler): void {
    this.messageHandler = handler;
  }


  setDispatchModeResolver(resolver: (channelId: string) => Promise<string | undefined>): void {
    this.dispatchModeResolver = resolver;
  }

  onRecall(handler: (messageId: string) => void): void {
    this.recallHandler = handler;
  }

  async sendMessage(channelId: string, text: string, context?: ReplyContext): Promise<void> {
    if (!text?.trim()) {
      logger.warn(`${this.logPrefix()} Attempted to send empty message, skipping`);
      return;
    }

    // 长 echo: agent 首次回复前先发 echo trace（echo 自身发送时跳过）
    if (!this.isEchoSending) {
      await this.flushPendingEcho(channelId);
    }

    let finalText = text;
    this.sentCount.set(channelId, (this.sentCount.get(channelId) || 0) + 1);

    if (this.isGroupId(channelId) && context?.peerId) {
      if (!finalText.includes(`@${context.peerId}`)) {
        finalText = `@${context.peerId} ` + finalText;
      }
    }

    // Write-ahead: persist to outbox before attempting send
    const entry = outbox.enqueue(this.config.aid, {
      channelId,
      type: 'text',
      text: finalText,
      context,
    });
    logger.debug(`${this.logPrefix()} Outbox enqueued: id=${entry.id} channel=${channelId} text=${finalText.slice(0, 40)}`);

    if (!this.connected || !this.client) {
      logger.warn(`${this.logPrefix()} Not connected, message queued in outbox (id=${entry.id}). Triggering reconnect.`);
      if (!this.reconnectTimer && !this.client) {
        this.initClient().catch(e => logger.error(`${this.logPrefix()} Reconnect from sendMessage failed: ${e}`));
      }
      return;
    }

    // Attempt immediate delivery
    const ok = await this.deliverTextEntry(entry);
    if (ok) {
      outbox.remove(this.config.aid, entry.id);
    }
  }

  private async flushPendingEcho(channelId: string): Promise<void> {
    // 查找该 channelId 是否有 pending echo（长 echo 等待 agent 首次回复）
    for (const [key, echo] of this.pendingEchoMessages) {
      if (echo.channelId === channelId) {
        this.pendingEchoMessages.delete(key);
        logger.info(`${this.logPrefix()} [Echo] flushPendingEcho triggered: key=${key} channelId=${channelId} pendingCount=${this.pendingEchoMessages.size}`);
        const ts = () => {
          const d = new Date();
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
        };
        const agentDuration = Date.now() - echo.receiveTs;
        let echoText = echo.text;
        echoText += `\n${ts()} [EvolClaw.agent] duration=${agentDuration}ms`;
        echoText += `\n${ts()} [EvolClaw.reply] echo回声发出 conn_uptime=${this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) + 's' : 'unknown'}`;

        if (Buffer.byteLength(echoText, 'utf-8') > 4096) {
          echoText += `\n[TRUNCATED]`;
        }

        // 直接投递 echo trace（不经过 sendMessage 避免 @peer 前缀和递归）
        if (this.connected && this.client) {
          const echoEntry: outbox.OutboxEntry = {
            id: `echo-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            ts: Date.now(),
            aid: this.config.aid,
            channelId,
            type: 'text',
            text: echoText,
            ttl: 300_000,
          };
          const ok = await this.deliverTextEntry(echoEntry);
          if (!ok) {
            outbox.enqueue(this.config.aid, { channelId, type: 'text', text: echoText });
          }
          logger.info(`${this.logPrefix()} [Echo] long echo trace delivered=${ok} to ${channelId} (agent ${agentDuration}ms)`);
        } else {
          outbox.enqueue(this.config.aid, { channelId, type: 'text', text: echoText });
          logger.warn(`${this.logPrefix()} [Echo] not connected, echo trace queued in outbox`);
        }
        break;
      }
    }
  }

  private async deliverTextEntry(entry: outbox.OutboxEntry): Promise<boolean> {
    const channelId = entry.channelId;
    const finalText = entry.text!;
    const context = entry.context;

    // 从 context.metadata.source 读取 source，默认为 'daemon'
    const source = (context?.metadata?.source as 'daemon' | 'cli' | 'msg' | 'ctl' | undefined) ?? 'daemon';

    const payload: Record<string, any> = { type: 'text', text: finalText };
    if (this.isGroupId(channelId)) {
      const extracted = this.extractMentionAidsFromText(finalText);
      if (extracted.length > 0) payload.mentions = extracted;
    }
    if (context?.threadId) payload.thread_id = context.threadId;
    if (context?.metadata?.taskId) payload.task_id = context.metadata.taskId;
    if (context?.metadata?.chatmode) payload.chatmode = context.metadata.chatmode;

    // 诊断日志：记录 payload 构造结果（含 task_id / thread_id / chatmode）
    logger.info(`${this.logPrefix()} deliverTextEntry: channelId=${channelId} thread_id=${payload.thread_id ?? 'none'} task_id=${payload.task_id ?? 'none'} chatmode=${payload.chatmode ?? 'none'} source=${source} textLen=${finalText.length}`);

    const isGroup = this.isGroupId(channelId);
    const targetAid = channelId;

    const encryptTarget = isGroup ? channelId : targetAid;
    const encrypt = context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(encryptTarget);
    const params: Record<string, any> = { payload, encrypt };

    try {
      if (isGroup) {
        params.group_id = channelId;
        const result = await this.callAndTrace<any>('group.send', params);
        const mid = result?.message?.message_id ?? result?.message_id ?? null;
        if (!mid) {
          const dispatchStatus = result?.message_dispatch?.status;
          if (dispatchStatus === 'debounced' || dispatchStatus === 'dispatched') {
            logger.info(`${this.logPrefix()} group.send ok (${dispatchStatus}): group=${channelId} encrypt=${encrypt} text=${finalText.slice(0, 60)}`);
          } else {
            logger.warn(`${this.logPrefix()} group.send returned no message_id: ${JSON.stringify(result)}`);
          }
        } else {
          logger.info(`${this.logPrefix()} group.send ok: group=${channelId} mid=${mid} encrypt=${encrypt} text=${finalText.slice(0, 60)}`);
          appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'message_out', aid: this.config.aid, to: channelId, msgId: mid, kind: 'text', len: finalText.length, groupId: channelId });
          this.aidStatsCollector?.recordOutbound(this.config.aid, channelId, Buffer.byteLength(finalText, 'utf-8'), finalText, false, encrypt, context?.metadata?.chatmode as string | undefined);
          this.appendOutboundJsonl(channelId, finalText, mid, encrypt, context, true, 'text', source);
          // Observer forward: outbound (group) — 原样转发 SDK SendResult（含 envelope + payload）
          this.forwardOutbound(result);
        }
      } else {
        params.to = targetAid;
        const result = await this.callAndTrace<any>('message.send', params);
        if (!result || !result.message_id) {
          logger.warn(`${this.logPrefix()} message.send returned no message_id: ${JSON.stringify(result)}`);
        } else {
          logger.info(`${this.logPrefix()} message.send ok: to=${this.peerLabel(targetAid)} mid=${result.message_id} encrypt=${encrypt} text=${finalText.slice(0, 60)}`);
          appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'message_out', aid: this.config.aid, to: targetAid, msgId: result.message_id, kind: 'text', len: finalText.length });
          this.aidStatsCollector?.recordOutbound(this.config.aid, targetAid, Buffer.byteLength(finalText, 'utf-8'), finalText, false, encrypt, context?.metadata?.chatmode as string | undefined);
          this.appendOutboundJsonl(targetAid, finalText, result.message_id, encrypt, context, false, 'text', source);
          // Observer forward: outbound (private) — 原样转发 SDK SendResult（含 envelope + payload）
          this.forwardOutbound(result);
        }
      }
      return true;
    } catch (e) {
      if (encrypt && e instanceof E2EEError) {
        this.peerE2ee.set(encryptTarget, { ok: false, ts: Date.now() });
        logger.warn(`${this.logPrefix()} E2EE send failed to ${channelId}, retrying plaintext: ${e}`);
        params.encrypt = false;
        try {
          if (isGroup) {
            this.trace('OUT', 'group.send.fallback', params);
            const result = await this.client!.call('group.send', params);
            this.trace('OUT', 'group.send.fallback.ok', { message_id: (result as any)?.message?.message_id ?? (result as any)?.message_id });
            if (!result || !(result as any).message_id) {
              logger.warn(`${this.logPrefix()} group.send fallback returned no message_id: ${JSON.stringify(result)}`);
            }
            this.forwardOutbound(result as any);
          } else {
            this.trace('OUT', 'message.send.fallback', params);
            const result = await this.client!.call('message.send', params);
            this.trace('OUT', 'message.send.fallback.ok', { message_id: (result as any)?.message_id });
            if (!result || !(result as any).message_id) {
              logger.warn(`${this.logPrefix()} message.send fallback returned no message_id: ${JSON.stringify(result)}`);
            }
            this.forwardOutbound(result as any);
          }
          return true;
        } catch (e2) {
          this.trace('OUT', 'send.fallback.error', { channelId, error: String(e2) });
          logger.error(`${this.logPrefix()} Plaintext fallback also failed to ${channelId}: ${e2}`);
          return false;
        }
      } else {
        this.trace('OUT', 'send.error', { channelId, error: String(e) });
        logger.error(`${this.logPrefix()} Send failed to ${channelId} (outbox id=${entry.id}): ${e}`);
        return false;
      }
    }
  }

  /** 出站消息写入 messages.jsonl（message.send/group.send/thought.put 成功后调用） */
  private appendOutboundJsonl(channelId: string, text: string, msgId: string, encrypt: boolean, context?: ReplyContext, isGroup?: boolean, msgType: 'text' | 'thought' = 'text', source: 'daemon' | 'cli' | 'msg' | 'ctl' = 'daemon'): void {
    try {
      const sessionsDir = resolvePaths().sessionsDir;
      const selfAID = this.config.aid;
      const chatDir = chatDirPath(sessionsDir, 'aun', channelId, selfAID);
      const chatmode = context?.metadata?.chatmode as string | undefined;
      appendMessageLog(chatDir, buildOutboundEntry({
        from: selfAID,
        to: channelId,
        chatType: isGroup ? 'group' : 'private',
        groupId: isGroup ? channelId : null,
        msgId,
        content: text,
        replyTo: null,
        agent: null,
        model: null,
        durationMs: null,
        encrypt,
        chatmode,
        msgType,
        source,
      }));
    } catch (e) {
      logger.debug(`${this.logPrefix()} appendOutboundJsonl failed: ${e}`);
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

    // 私聊 channelId = 对端 AID（不含 device_id）
    const targetId = channelId;

    const encrypt = context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(targetId);
    const params: Record<string, any> = {
      context: { type: 'task', id: taskId },
      payload,
      encrypt,
    };

    try {
      const itemCount = Array.isArray((payload as any)?.items) ? (payload as any).items.length : 0;
      const stage = (payload as any)?.stage ?? `items=${itemCount}`;
      // 提取 thought 文本（只对 kind=text 的 item 写 jsonl，过滤 tool_use/tool_result 等结构化项）
      const items = (payload as any)?.items;
      let thoughtText: string | undefined;
      if (Array.isArray(items) && items.length > 0) {
        const lastItem = items[items.length - 1];
        // 优先 text 字段（kind=text 的 item），否则 content
        if (lastItem?.kind === 'text' && lastItem.text) {
          thoughtText = lastItem.text;
        } else if (lastItem?.text) {
          thoughtText = lastItem.text;
        } else if (lastItem?.content) {
          thoughtText = lastItem.content;
        } else if (typeof lastItem === 'string') {
          thoughtText = lastItem;
        }
      }
      if (this.isGroupId(channelId)) {
        params.group_id = targetId;
        const putRes = await this.callAndTrace<any>('group.thought.put', params);
        const tid = putRes?.thought_id;
        logger.info(`${this.logPrefix()} thought.put ok group=${targetId} task=${taskId} stage=${stage} encrypt=${encrypt} tid=${tid ?? '?'}`);
        this.eventBus?.publish?.({ type: 'message:thought-put', agentName: this.config.aid, channelId, taskId, text: thoughtText });
        this.forwardOutbound(putRes);
        if (thoughtText) {
          this.aidStatsCollector?.recordOutbound(this.config.aid, channelId, Buffer.byteLength(thoughtText, 'utf-8'), thoughtText, false, encrypt, context?.metadata?.chatmode as string | undefined ?? 'proactive');
          this.appendOutboundJsonl(channelId, thoughtText, tid ?? `thought-${Date.now()}`, encrypt, context, true, 'thought', 'daemon');
        }
      } else {
        params.to = targetId;
        const putRes = await this.callAndTrace<any>('message.thought.put', params);
        const tid = putRes?.thought_id;
        logger.info(`${this.logPrefix()} thought.put ok p2p=${this.peerLabel(targetId)} task=${taskId} stage=${stage} encrypt=${encrypt} tid=${tid ?? '?'}`);
        this.eventBus?.publish?.({ type: 'message:thought-put', agentName: this.config.aid, channelId, taskId, text: thoughtText });
        this.forwardOutbound(putRes);
        if (thoughtText) {
          this.aidStatsCollector?.recordOutbound(this.config.aid, targetId, Buffer.byteLength(thoughtText, 'utf-8'), thoughtText, false, encrypt, context?.metadata?.chatmode as string | undefined ?? 'proactive');
          this.appendOutboundJsonl(channelId, thoughtText, tid ?? `thought-${Date.now()}`, encrypt, context, false, 'thought', 'daemon');
        }
      }
    } catch (e) {
      const err = e as any;
      logger.debug(`${this.logPrefix()} thought.put failed to ${channelId}: ${err?.name}(${err?.code})=${err?.message}`);
    }
  }

  /**
   * 发送结构化 payload（type='thought' 等）作为消息历史持久化。
   * 与 sendThought（thought.put）配对：thought.put 用于前端实时渲染（不入消息历史），
   * sendStructured 用于把同一内容写入消息历史。
   * 返回服务端分配的 message_id（失败时返回 null）。
   */
  async sendStructured(channelId: string, payload: Record<string, any>, context?: ReplyContext): Promise<string | null> {
    if (!this.connected || !this.client) return null;
    const isGroup = this.isGroupId(channelId);
    const targetAid = channelId;
    const encryptTarget = isGroup ? channelId : targetAid;
    const encrypt = context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(encryptTarget);

    const finalPayload: Record<string, any> = { ...payload };
    if (context?.threadId && !finalPayload.thread_id) finalPayload.thread_id = context.threadId;

    const params: Record<string, any> = { payload: finalPayload, encrypt };
    try {
      if (isGroup) {
        params.group_id = channelId;
        const result = await this.callAndTrace<any>('group.send', params);
        const mid = result?.message?.message_id ?? result?.message_id ?? null;
        logger.info(`${this.logPrefix()} group.send (${payload.type}) ok: group=${channelId} mid=${mid} encrypt=${encrypt}`);
        this.forwardOutbound(result);
        return mid;
      } else {
        params.to = targetAid;
        const result = await this.callAndTrace<any>('message.send', params);
        logger.info(`${this.logPrefix()} message.send (${payload.type}) ok: to=${this.peerLabel(targetAid)} mid=${result?.message_id} encrypt=${encrypt}`);
        this.forwardOutbound(result);
        return result?.message_id ?? null;
      }
    } catch (e) {
      const err = e as any;
      logger.warn(`${this.logPrefix()} sendStructured failed (${payload.type}) to ${channelId}: ${err?.name}(${err?.code})=${err?.message}`);
      return null;
    }
  }

  async sendFile(channelId: string, filePath: string, context?: ReplyContext): Promise<void> {
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

    // Write-ahead: persist to outbox
    const entry = outbox.enqueue(this.config.aid, {
      channelId,
      type: 'file',
      filePath: absPath,
      context,
    });
    logger.debug(`${this.logPrefix()} Outbox enqueued file: id=${entry.id} channel=${channelId} file=${absPath}`);

    if (!this.connected || !this.client) {
      logger.warn(`${this.logPrefix()} Not connected, file send queued in outbox (id=${entry.id}). Triggering reconnect.`);
      if (!this.reconnectTimer && !this.client) {
        this.initClient().catch(e => logger.error(`${this.logPrefix()} Reconnect from sendFile failed: ${e}`));
      }
      return;
    }

    const ok = await this.deliverFileEntry(entry);
    if (ok) {
      outbox.remove(this.config.aid, entry.id);
    }
  }

  private async deliverFileEntry(entry: outbox.OutboxEntry): Promise<boolean> {
    const channelId = entry.channelId;
    const absPath = entry.filePath!;
    const context = entry.context;

    if (!fs.existsSync(absPath)) {
      logger.warn(`${this.logPrefix()} deliverFileEntry: file gone: ${absPath}`);
      return true; // remove from outbox, file no longer exists
    }

    const filename = path.basename(absPath);
    const fileData = fs.readFileSync(absPath);
    const stat = fs.statSync(absPath);
    const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');
    const contentType = guessMime(filename);
    const objectKey = `shared/${crypto.randomUUID()}/${filename}`;

    try {
      if (stat.size <= 64 * 1024) {
        await this.callAndTrace('storage.put_object', {
          object_key: objectKey,
          content: fileData.toString('base64'),
          content_type: contentType,
          is_private: false,
          overwrite: true,
        });
      } else {
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
      const fileTargetAid = channelId;

      const encryptTarget = isGroup ? channelId : fileTargetAid;
      const encrypt = context?.metadata?.encrypted != null
        ? !!(context.metadata.encrypted)
        : this.shouldEncrypt(encryptTarget);
      const params: Record<string, any> = { payload: filePayload, encrypt };

      let sendResult: any = null;
      try {
        if (isGroup) {
          params.group_id = channelId;
          this.trace('OUT', 'group.send.file', params);
          const result = await this.client!.call('group.send', params);
          sendResult = result;
          const fileMid = (result as any)?.message?.message_id ?? (result as any)?.message_id;
          this.trace('OUT', 'group.send.file.ok', { message_id: fileMid });
          if (!fileMid) {
            logger.warn(`${this.logPrefix()} group.send.file returned no message_id: ${JSON.stringify(result)}`);
          }
        } else {
          params.to = fileTargetAid;
          this.trace('OUT', 'message.send.file', params);
          const result = await this.client!.call('message.send', params);
          sendResult = result;
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
            const result = await this.client!.call('group.send', params);
            sendResult = result;
            const fbMid = (result as any)?.message?.message_id ?? (result as any)?.message_id;
            this.trace('OUT', 'group.send.file.fallback.ok', { message_id: fbMid });
            if (!fbMid) {
              logger.warn(`${this.logPrefix()} group.send.file fallback returned no message_id: ${JSON.stringify(result)}`);
            }
          } else {
            this.trace('OUT', 'message.send.file.fallback', params);
            const result = await this.client!.call('message.send', params);
            sendResult = result;
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
      if (sendResult) this.forwardOutbound(sendResult);
      return true;
    } catch (e) {
      this.trace('OUT', 'sendFile.error', { channelId, filePath: absPath, error: String(e) });
      logger.error(`${this.logPrefix()} sendFile failed for ${channelId} (outbox id=${entry.id}): ${e}`);
      return false;
    }
  }

  // ── Outbox drain ───────────────────────────────────────────

  private outboxTimer: ReturnType<typeof setInterval> | null = null;

  private startOutboxTimer(): void {
    if (this.outboxTimer) return;
    this.outboxTimer = setInterval(() => {
      if (this.connected && this.client && outbox.hasPending(this.config.aid)) {
        this.drainOutbox();
      }
    }, 30_000);
  }

  stopOutboxTimer(): void {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
  }

  private async drainOutbox(): Promise<void> {
    if (!this.connected || !this.client) return;
    if (!outbox.hasPending(this.config.aid)) return;

    logger.info(`${this.logPrefix()} Draining outbox...`);
    const result = await outbox.drain(this.config.aid, async (entry) => {
      if (entry.type === 'text') {
        return this.deliverTextEntry(entry);
      } else if (entry.type === 'file') {
        return this.deliverFileEntry(entry);
      }
      return true; // unknown type, discard
    });

    if (result.sent > 0 || result.expired > 0) {
      logger.info(`${this.logPrefix()} Outbox drained: sent=${result.sent} expired=${result.expired} failed=${result.failed}`);
    }
  }

  acknowledge(messageId: string): void {
    // Gateway auto-delivery-ack is sufficient; skip explicit message.ack RPC
    // to avoid duplicate "已送达" at the sender CLI
    this.messageSeqMap.delete(messageId);
  }

  sendProcessingStatus(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout' | 'queued' | 'progress', sessionId: string, taskId: string, context?: ReplyContext, extraMeta?: Record<string, unknown>): void {
    if (status === 'start') this.sentCount.delete(channelId);  // 新任务开始，重置计数
    if (!this.client || !this.connected) return;

    const severity = status === 'error' || status === 'timeout' ? 'error' : 'info';
    const stateMap: Record<string, string> = {
      start: 'started',
      done: 'completed',
      interrupted: 'interrupted',
      error: 'error',
      timeout: 'timeout',
      queued: 'queued',
      progress: 'progress',
    };
    const statusPayload: Record<string, any> = {
      type: 'status',
      state: stateMap[status] ?? status,
      task_id: taskId,
      session_id: sessionId,
      severity,
      ...(extraMeta && Object.keys(extraMeta).length > 0 && { metadata: extraMeta }),
    };
    if (context?.threadId) statusPayload.thread_id = context.threadId;
    if (context?.peerId) statusPayload.initiator = context.peerId;
    if (context?.replyToMessageId) statusPayload.ref_message_id = context.replyToMessageId;

    const isGroup = this.isGroupId(channelId);
    // 私聊 channelId = 对端 AID（不含 device_id）
    const statusTargetAid = channelId;
    const encryptTarget = isGroup ? channelId : statusTargetAid;

    const computeEncrypt = (): boolean => context?.metadata?.encrypted != null
      ? !!(context.metadata.encrypted)
      : this.shouldEncrypt(encryptTarget);

    const sendOne = (method: string, payload: Record<string, any>, label: string): Promise<any> => {
      const c = this.client;
      if (!c) {
        logger.debug(`${this.logPrefix()} ${label} skipped: client gone`);
        return Promise.resolve(null);
      }
      const encrypt = computeEncrypt();
      const params: Record<string, any> = { payload, encrypt };
      if (isGroup) params.group_id = channelId;
      else params.to = statusTargetAid;
      this.trace('OUT', `${method}.task_${label}`, params);
      return c.call(method, params).catch((e: any) => {
        if (encrypt && e instanceof E2EEError) {
          this.peerE2ee.set(encryptTarget, { ok: false, ts: Date.now() });
          logger.warn(`${this.logPrefix()} E2EE task_${label} send failed to ${channelId}, retrying plaintext`);
          const c2 = this.client;
          if (!c2) return null;
          const fallbackParams = { ...params, encrypt: false };
          return c2.call(method, fallbackParams).catch((e2: any) => {
            logger.debug(`${this.logPrefix()} task_${label} fallback failed: ${e2}`);
            return null;
          });
        }
        logger.debug(`${this.logPrefix()} task_${label} failed: ${e}`);
        return null;
      });
    };

    const method = isGroup ? 'group.send' : 'message.send';
    sendOne(method, statusPayload, 'status').then(result => {
      if (result) this.forwardOutbound(result as any);
    }).catch(() => {});

    this.aidStatsCollector?.recordOutbound(this.config.aid, channelId, JSON.stringify(statusPayload).length, undefined, true);
    // 群聊显示 group id 简称，P2P 显示 peer label；从 context.metadata 读取 chatmode
    const targetLabel = this.isGroupId(channelId) ? channelId : this.peerLabel(channelId);
    const chatmode = context?.metadata?.chatmode ?? '?';
    const initiator = statusPayload.initiator ?? '';
    const refMsgId = statusPayload.ref_message_id ?? '';
    const metaStr = statusPayload.metadata ? ` meta=${JSON.stringify(statusPayload.metadata)}` : '';
    logger.info(`${this.logPrefix()} task.${status} task=${taskId} session=${sessionId} chatmode=${chatmode} target=${targetLabel} initiator=${initiator} ref_msg=${refMsgId}${metaStr}`);
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

    // 私聊 channelId = 对端 AID（不含 device_id）
    const customTargetAid = channelId;


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
    if (this.store) {
      try { this.store.close(); } catch { /* ignore */ }
      this.store = null;
    }
    this.connected = false;
    appendAidEvent({ ts: Date.now(), iso: new Date().toISOString(), event: 'disconnected', aid: this.config.aid, reason: 'intentional' });
    appendAidLifecycle({ ts: Date.now(), iso: new Date().toISOString(), event: 'disconnected', aid: this.config.aid, reason: 'intentional' });
    this.setAidStatus('disabled');
    if (this.traceWriter) {
      this.traceWriter.close();
      this.traceWriter = null;
    }
    logger.info(`${this.logPrefix()} Disconnected`);
  }

  // ── TS-layer reconnect ─────────────────────────────────────
  // SDK 内部已经跑无限指数退避（max_attempts=0, max_delay=300s），
  // TS 层只负责：(1) initClient 失败时安排兜底重试；(2) flap/kicked 接管路径见 takeoverReconnect。

  private scheduleReconnect(): void {
    // initClient 早期失败（auth / connect 阶段）走这里：用 fallback 延迟兜底
    this.takeoverReconnect(AUNChannel.FALLBACK_DELAY_MS, 'terminal');
  }

  /** Manually trigger reconnect (e.g. from /check reconnect command) */
  async reconnect(): Promise<string> {
    if (this.connected) return '已连接，无需重连';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.flapCount = 0;
    try {
      await this.initClient();
      return `重连成功 (${this._aid})`;
    } catch (err) {
      this.scheduleReconnect();
      return `重连失败: ${err}，已安排自动重试`;
    }
  }

  /** Set callback for when all reconnect attempts are exhausted (deprecated: 现在无限重试，不会触发) */
  setOnChannelDown(callback: () => void): void {
    this.onChannelDown = callback;
  }

  /** Get current connection status */
  getStatus(): { connected: boolean; aid?: string; flapCount: number; plaintextRecv: number } {
    return {
      connected: this.connected,
      aid: this._aid,
      flapCount: this.flapCount,
      plaintextRecv: this.plaintextRecv,
    };
  }

  /** 读取本地 agent.md 中的 name（用于身份上下文展示），若本地不存在则尝试远程拉取 */
  private loadSelfName(aid: string): string | undefined {
    try {
      const aidName = aid.startsWith('@') ? aid.slice(1) : aid;
      const mdPath = agentMdPathFn(aidName);
      if (!fs.existsSync(mdPath)) {
        // 异步拉取，不阻塞连接流程
        this.fetchAndCacheSelfName(aidName);
        return undefined;
      }
      const content = fs.readFileSync(mdPath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return undefined;
      const nameMatch = fmMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
      return nameMatch?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchAndCacheSelfName(aidName: string): Promise<void> {
    try {
      const { agentmdGet } = await import('../aun/aid/index.js');
      const content = await agentmdGet(aidName);
      if (content) {
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const nameMatch = fmMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
          const name = nameMatch?.[1]?.trim();
          if (name) {
            this._selfName = name;
            if (this.aidStatsCollector) this.aidStatsCollector.setSelfName(this.config.aid, name);
          }
        }
      }
    } catch {
      // ignore — name will remain undefined
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
      const selfAgentDir = path.join(resolvePaths().agentsDir, this.config.aid);
      const identity = await PeerIdentityCache.resolve('aun', aid, selfAgentDir, this.store!, false);
      const type: 'human' | 'ai' = identity.type === 'human' ? 'human' : 'ai';
      const name = identity.name || undefined;
      const info = { type, name };
      this.peerInfoCache.set(aid, info);
      setTimeout(() => this.peerInfoCache.delete(aid), 30 * 60 * 1000);
      return info;
    } catch (e) {
      logger.debug(`${this.logPrefix()} fetchPeerInfo failed for ${aid}: ${e}`);
      return { type: null };
    }
  }

  /** 同步取 peerInfo 缓存，未命中返回 undefined，不发起任何网络请求。 */
  private peerInfoCached(aid: string): { type: 'human' | 'ai'; name?: string } | undefined {
    return this.peerInfoCache.get(aid);
  }

  /** 后台预取 peerInfo（下次需要时缓存已就绪），任何错误吞掉。 */
  private prefetchPeerInfo(aid: string): void {
    if (this.peerInfoCache.has(aid)) return;
    void this.fetchPeerInfo(aid).catch(() => {});
  }

  async uploadAgentMd(content: string): Promise<void> {
    if (!this.store) throw new Error('not connected');
    const { agentmdPut } = await import('../aun/aid/agentmd.js');
    await agentmdPut(content, { aid: this.config.aid, store: this.store });
  }

  async downloadAgentMd(aid: string): Promise<string> {
    if (!this.store) throw new Error('not connected');
    const { agentmdSync } = await import('../aun/aid/agentmd.js');
    const result = await agentmdSync(aid, { store: this.store ?? undefined });
    return result.content ?? '';
  }

  /**
   * 取群显示名（group.get → group.name），进程内缓存。
   * 走长连接 callAndTrace，失败/未连接返回 undefined —— 绝不抛出阻塞消息处理。
   */
  async getGroupName(groupId: string): Promise<string | undefined> {
    if (!groupId) return undefined;
    const cached = this.groupNameCache.get(groupId);
    if (cached !== undefined) return cached || undefined;
    if (!this.client) return undefined;
    try {
      const result: any = await this.callAndTrace('group.get', { group_id: groupId });
      const name = result?.group?.name;
      if (typeof name === 'string' && name) {
        this.groupNameCache.set(groupId, name);
        return name;
      }
      this.groupNameCache.set(groupId, '');  // 负缓存：避免反复 RPC（空串视为无名）
      return undefined;
    } catch {
      return undefined;  // 不写缓存，下次仍可重试
    }
  }
}

// Plugin implementation
export class AUNChannelPlugin implements ChannelPlugin {
  readonly name = 'aun';

  async createInstance(inst: AunInst, ctx: ChannelBuildContext): Promise<ChannelInstance | null> {
    // AUN aid is the agent's own AID; loader injects it as inst.aid, ctx.agentName is the source of truth.
    const aid = (inst as any).aid ?? ctx.agentName;
    if (inst.enabled === false || !aid) return null;

    const channel = new AUNChannel({
      aid,
      keystorePath: (inst as any).keystorePath,
      gatewayUrl: inst.gatewayUrl,
      accessToken: inst.accessToken,
      flushDelay: inst.flushDelay,
      owner: (inst as any).owner ?? inst.owners?.[0],
      agentName: ctx.agentName,
      channelName: inst.name,
      aunTrace: ctx.debug?.aunTrace,
      aunSdkLog: ctx.debug?.aunSdkLog,
    });

    const mode = resolveShowActivities(inst);
    const adapter = {
      channelName: inst.name,
      channelKey: inst.name,  // channelName 实际上就是 channelKey
      capabilities: { file: true, image: true, interaction: true, markdown: true, thought: true, status: true, thread: true },
      send: async (envelope: any, payload: any) => {
        const replyCtx = envelope.replyContext;
        const channelId = envelope.channelId;
        switch (payload.kind) {
          case 'result.text': case 'command.result': case 'command.error':
          case 'system.notice': case 'system.error': case 'result.error': {
            const sendCtx: ReplyContext = { ...(replyCtx ?? {}) };
            if (payload.kind === 'result.text' && payload.isFinal) sendCtx.title = '✅ 最终回复:';
            await channel.sendMessage(channelId, payload.text, sendCtx);
            return;
          }
          case 'result.file':
            await channel.sendFile(channelId, payload.filePath, replyCtx);
            return;
          case 'result.image': {
            const buf = payload.data as Buffer;
            const b64 = buf.toString('base64');
            await channel.sendStructured(channelId, {
              type: 'image', alt: payload.alt, data_base64: b64, mime_type: payload.mimeType,
            }, replyCtx);
            return;
          }
          case 'activity.batch': {
            const aunPayload: Record<string, any> = {
              type: 'thought',
              items: payload.items,
              client_context: { task_id: envelope.taskId, chatmode: envelope.chatmode, agent_name: envelope.agentName },
            };
            if (replyCtx?.threadId) aunPayload.thread_id = replyCtx.threadId;
            if (envelope.chatmode === 'proactive') {
              await channel.sendThought(channelId, envelope.taskId, aunPayload, replyCtx);
            } else {
              await channel.sendStructured(channelId, aunPayload, replyCtx);
            }
            return;
          }
          case 'status.progress':
            channel.sendProcessingStatus(channelId, 'progress', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'status.started':
            channel.sendProcessingStatus(channelId, 'start', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'status.queued':
            channel.sendProcessingStatus(channelId, 'queued', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'status.completed':
            channel.sendProcessingStatus(channelId, 'done', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'status.interrupted':
            channel.sendProcessingStatus(channelId, 'interrupted', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'status.error':
            channel.sendProcessingStatus(channelId, 'error', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'status.timeout':
            channel.sendProcessingStatus(channelId, 'timeout', envelope.sessionId ?? envelope.taskId, envelope.taskId, replyCtx, payload.metadata); return;
          case 'interaction': {
            const req = payload.interaction;
            if (req.kind.kind === 'action') {
              const action = req.kind;
              const aunCard: Record<string, any> = {
                type: 'action_card',
                title: action.title,
                actions: (action as ActionInteraction).buttons.map(btn => ({
                  label: btn.label, value: btn.key, style: btn.style ?? 'default', behavior: 'reply',
                })),
              };
              if (action.body) aunCard.description = action.body;
              if (req.initiatorId && channel.isGroupId(channelId)) aunCard.initiator = req.initiatorId;
              if (replyCtx?.threadId) aunCard.thread_id = replyCtx.threadId;
              const msgId = await channel.sendStructured(channelId, aunCard, replyCtx);
              if (msgId) {
                channel.cardMessageIdMap.set(msgId, { requestId: req.id, isCommandCard: false, initiatorAid: req.initiatorId });
                setTimeout(() => channel.cardMessageIdMap.delete(msgId), 20 * 60 * 1000);
              }
            } else if (req.kind.kind === 'command-card') {
              const card = req.kind;
              const aunCard: Record<string, any> = {
                type: 'action_card',
                title: card.title,
                actions: (card as CommandCard).buttons.map(btn => ({
                  label: btn.label, value: btn.command, style: btn.style ?? 'default', behavior: 'reply',
                })),
              };
              if (card.body) aunCard.description = card.body;
              if (replyCtx?.threadId) aunCard.thread_id = replyCtx.threadId;
              const msgId = await channel.sendStructured(channelId, aunCard, replyCtx);
              if (msgId) {
                channel.cardMessageIdMap.set(msgId, { requestId: req.id, isCommandCard: true, initiatorAid: req.initiatorId });
                setTimeout(() => channel.cardMessageIdMap.delete(msgId), 20 * 60 * 1000);
              }
            } else if (payload.fallbackText) {
              await channel.sendMessage(channelId, payload.fallbackText, replyCtx);
            }
            return;
          }
          case 'custom': {
            const text = typeof payload.payload === 'string' ? payload.payload : JSON.stringify(payload.payload);
            channel.sendCustomPayload(channelId, text);
            return;
          }
          default:
            logger.warn(`[AUN] Unhandled payload kind: ${(payload as any).kind}`);
        }
      },
      acknowledge: (messageId: string) => { channel.acknowledge(messageId); return Promise.resolve(); },
      onInteraction: (cb: (r: InteractionResponse) => void) => { channel.interactionCallback = cb; },
      uploadAgentMd: (content: string) => channel.uploadAgentMd(content),
      downloadAgentMd: (aid: string) => channel.downloadAgentMd(aid),
      getGroupName: (groupId: string) => channel.getGroupName(groupId),
      _selfAid: () => channel.getStatus().aid,
      _selfName: () => channel.getSelfName(),
    };

    const policy = {
      canSwitchProject: (_: string, identity: string) => identity === 'owner' || identity === 'admin',
      canListProjects: (_: string, identity: string) => identity === 'owner' || identity === 'admin',
      canCreateSession: () => true,
      canDeleteSession: () => true,
      canImportCliSession: (_: string, identity: string) => identity === 'owner' || identity === 'admin',
      messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
      showMiddleResult: (chatType: string, identity: string) => showActivitiesPolicy(mode, chatType, identity),
      showIdleMonitor: (chatType: string, identity: string) => showActivitiesPolicy(mode, chatType, identity),
      accumulateErrors: () => true,
    };

    return {
      channelType: 'aun', adapter, channel,
      policy,
      options: { flushDelay: inst.flushDelay ?? 3, fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g },
      connect: () => channel.connect(),
      disconnect: () => channel.disconnect(),
      onProjectPathRequest: () => Promise.resolve(ctx.defaultProjectPath),
      registerBridge(bridge: MessageBridge, channelType: string) {
        bridge.register(
          adapter.channelName,
          (handler) => channel.onMessage(async (opts) => {
            handler(aunOptsToInbound(opts, adapter.channelName, channelType));
          }),
          (channelId, text, replyContext) => channel.sendMessage(channelId, text, replyContext),
          adapter, channelType,
        );
      },
      registerHooks(hookCtx: BridgeHookContext) {
        channel.setEventBus(hookCtx.eventBus);

        if (channel.setOnChannelDown) {
          channel.setOnChannelDown(() => {
            hookCtx.eventBus.publish({
              type: 'channel:error',
              channel: 'aun',
              channelName: adapter.channelName,
              status: 'auth_error',
              message: `⚠️ AUN 渠道 ${adapter.channelName} 断连，自动重试已用尽。\n使用 /check rty aun 手动重连`,
              timestamp: Date.now(),
            });
          });
        }

        if (typeof channel.setDispatchModeResolver === 'function') {
          channel.setDispatchModeResolver(async (channelId: string) => {
            const session = await hookCtx.sessionManager.getActiveSession(adapter.channelName, channelId);
            return session?.metadata?.dispatchMode;
          });
        }
      },
    };
  }
}
