import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { logger } from '../utils/logger.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface WechatConfig {
  baseUrl: string;
  token: string;
}

export interface WechatMessageHandler {
  (channelId: string, content: string, userId?: string): Promise<void>;
}

const CHANNEL_VERSION = '1.0.0';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const TYPING_TICKET_TTL_MS = 5 * 60 * 1000; // 5 min cache

// ── ilink Protocol Types ────────────────────────────────────────────────────

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const MSG_STATE_FINISH = 2;

// ── Markdown → Plain Text ───────────────────────────────────────────────────

function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Tables: remove separator rows
  result = result.replace(/^\|[\s:|-]+\|$/gm, '');
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split('|').map(cell => cell.trim()).join('  ')
  );
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '$1');
  // Inline code
  result = result.replace(/`([^`]+)`/g, '$1');
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Blockquotes
  result = result.replace(/^>\s?/gm, '');
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '');
  // List markers
  result = result.replace(/^(\s*)[-*+]\s/gm, '$1');
  result = result.replace(/^(\s*)\d+\.\s/gm, '$1');
  return result.trim();
}

// ── Message Text Extraction ─────────────────────────────────────────────────

function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return '';
  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.type === MSG_ITEM_TEXT && ref.message_item.text_item?.text) {
        parts.push(ref.message_item.text_item.text);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(' | ')}]\n${text}`;
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

// ── WechatChannel ───────────────────────────────────────────────────────────

export class WechatChannel {
  private config: WechatConfig;
  private messageHandler?: WechatMessageHandler;
  private abortController?: AbortController;

  // 内部状态（不外泄到核心层）
  private contextTokenCache = new Map<string, string>();
  private typingTicketCache = new Map<string, { ticket: string; fetchedAt: number }>();
  private getUpdatesBuf = '';
  private syncBufPath: string;

  constructor(config: WechatConfig) {
    this.config = config;
    this.syncBufPath = path.join(resolvePaths().dataDir, 'wechat-sync-buf.txt');
  }

  // ── Public API ──────────────────────────────────────────────────────────

  onMessage(handler: WechatMessageHandler): void {
    this.messageHandler = handler;
  }

  async connect(): Promise<void> {
    if (!this.config.token) {
      throw new Error('WeChat token not configured');
    }

    // 恢复游标
    try {
      if (fs.existsSync(this.syncBufPath)) {
        this.getUpdatesBuf = fs.readFileSync(this.syncBufPath, 'utf-8');
        logger.info(`[WeChat] Restored sync cursor (${this.getUpdatesBuf.length} bytes)`);
      }
    } catch {
      // ignore
    }

    this.abortController = new AbortController();
    // 启动长轮询（不 await，后台运行）
    this.pollLoop(this.abortController.signal).catch(err => {
      if (this.abortController?.signal.aborted) return;
      logger.error('[WeChat] Poll loop fatal error:', err);
    });

    logger.info('[WeChat] Channel connected');
  }

  async disconnect(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    logger.info('[WeChat] Channel disconnected');
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!text || text.trim() === '') {
      logger.warn('[WeChat] Attempted to send empty message, skipping');
      return;
    }

    const contextToken = this.contextTokenCache.get(to);
    if (!contextToken) {
      logger.error(`[WeChat] No context_token for ${to}, cannot send message`);
      return;
    }

    // Markdown → 纯文本
    const plainText = markdownToPlainText(text);

    const clientId = `evolclaw-wechat:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: plainText } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    try {
      await this.apiFetch('ilink/bot/sendmessage', JSON.stringify(body), DEFAULT_API_TIMEOUT_MS);
      logger.debug(`[WeChat] Sent message to ${to}, clientId=${clientId}`);
    } catch (err) {
      logger.error(`[WeChat] Failed to send message to ${to}:`, err);
      throw err;
    }
  }

  // ── Long-Poll Loop ────────────────────────────────────────────────────

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;

    logger.info('[WeChat] Starting message polling...');

    while (!signal.aborted) {
      try {
        const body = JSON.stringify({
          get_updates_buf: this.getUpdatesBuf,
          base_info: { channel_version: CHANNEL_VERSION },
        });

        let rawText: string;
        try {
          rawText = await this.apiFetch('ilink/bot/getupdates', body, nextTimeoutMs, signal);
        } catch (err) {
          if (signal.aborted) return;
          // 长轮询超时是正常的
          if (err instanceof Error && err.name === 'AbortError') {
            continue;
          }
          throw err;
        }

        const resp: GetUpdatesResp = JSON.parse(rawText);

        // 更新服务端建议的轮询超时
        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        // API 错误处理
        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (isError) {
          consecutiveFailures++;
          logger.error(`[WeChat] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.error(`[WeChat] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off ${BACKOFF_DELAY_MS / 1000}s`);
            consecutiveFailures = 0;
            await this.sleep(BACKOFF_DELAY_MS, signal);
          } else {
            await this.sleep(RETRY_DELAY_MS, signal);
          }
          continue;
        }

        consecutiveFailures = 0;

        // 保存游标
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          try {
            fs.writeFileSync(this.syncBufPath, this.getUpdatesBuf, 'utf-8');
          } catch {
            // best-effort
          }
        }

        // 处理消息
        for (const msg of resp.msgs ?? []) {
          if (msg.message_type !== MSG_TYPE_USER) continue;

          const text = extractTextFromMessage(msg);
          if (!text) continue;

          const fromUserId = msg.from_user_id ?? '';

          // 缓存 context_token
          if (msg.context_token) {
            this.contextTokenCache.set(fromUserId, msg.context_token);
          }

          logger.info(`[WeChat] Received: from=${fromUserId} text=${text.slice(0, 50)}...`);

          // 发送 typing 指示器（异步，不阻塞）
          this.acknowledgeMessage(fromUserId, msg.context_token).catch(() => {});

          // 回调主流程
          if (this.messageHandler) {
            try {
              await this.messageHandler(fromUserId, text, fromUserId);
            } catch (err) {
              logger.error('[WeChat] Message handler error:', err);
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures++;
        logger.error(`[WeChat] Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await this.sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await this.sleep(RETRY_DELAY_MS, signal);
        }
      }
    }
  }

  // ── Acknowledge (sendTyping) ──────────────────────────────────────────

  private async acknowledgeMessage(fromUserId: string, contextToken?: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(fromUserId, contextToken);
      if (!ticket) return;

      const body = JSON.stringify({
        ilink_user_id: fromUserId,
        typing_ticket: ticket,
        status: 1, // typing
        base_info: { channel_version: CHANNEL_VERSION },
      });

      await this.apiFetch('ilink/bot/sendtyping', body, DEFAULT_CONFIG_TIMEOUT_MS);
      logger.debug(`[WeChat] Sent typing indicator to ${fromUserId}`);
    } catch {
      // 静默失败，不阻塞主流程（和 Feishu addAckReaction 一致）
    }
  }

  private async getTypingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const cached = this.typingTicketCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < TYPING_TICKET_TTL_MS) {
      return cached.ticket;
    }

    try {
      const body = JSON.stringify({
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      });
      const rawText = await this.apiFetch('ilink/bot/getconfig', body, DEFAULT_CONFIG_TIMEOUT_MS);
      const resp = JSON.parse(rawText) as { ret?: number; typing_ticket?: string };
      if (resp.ret === 0 && resp.typing_ticket) {
        this.typingTicketCache.set(userId, { ticket: resp.typing_ticket, fetchedAt: Date.now() });
        return resp.typing_ticket;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  // ── ilink API Helpers ─────────────────────────────────────────────────

  private async apiFetch(endpoint: string, body: string, timeoutMs: number, externalSignal?: AbortSignal): Promise<string> {
    const base = this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`;
    const url = new URL(endpoint, base).toString();
    const headers = this.buildHeaders(body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // 外部 signal（来自 disconnect）也要能中断
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return text;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private buildHeaders(body: string): Record<string, string> {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    const wechatUin = Buffer.from(String(uint32), 'utf-8').toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
      'X-WECHAT-UIN': wechatUin,
    };

    if (this.config.token?.trim()) {
      headers['Authorization'] = `Bearer ${this.config.token.trim()}`;
    }

    return headers;
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    });
  }
}
