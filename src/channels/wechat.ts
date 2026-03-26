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
  (channelId: string, content: string, userId?: string,
   images?: Array<{ data: string; mimeType: string }>): Promise<void>;
}

const CHANNEL_VERSION = '1.0.0';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const TYPING_TICKET_TTL_MS = 5 * 60 * 1000; // 5 min cache
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_RETRY_DELAY_MS = 30_000;      // 短暂停：30s 后重试一次
const SESSION_PAUSE_DURATION_MS = 10 * 60 * 1000; // 长暂停：10 分钟

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

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; media?: CDNMedia };
  image_item?: { media?: CDNMedia; aeskey?: string; mid_size?: number };
  file_item?:  { media?: CDNMedia; file_name?: string; len?: string };
  video_item?: { media?: CDNMedia; video_size?: number };
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
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE  = 4;
const MSG_ITEM_VIDEO = 5;
const MSG_STATE_FINISH = 2;

// ── CDN + AES ───────────────────────────────────────────────────────────────

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
  '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
};

// Exported for unit testing
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii')))
    return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new Error(`Invalid aes_key length: ${decoded.length}`);
}

// Exported for unit testing
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Exported for unit testing
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function downloadMedia(cdnMedia: CDNMedia, hexKey?: string): Promise<Buffer> {
  const aesKeyBase64 = hexKey
    ? Buffer.from(hexKey, 'hex').toString('base64')
    : cdnMedia.aes_key;

  if (!cdnMedia.encrypt_query_param) throw new Error('No encrypt_query_param');

  const url = `${CDN_BASE_URL}/download?encrypted_query_param=${
    encodeURIComponent(cdnMedia.encrypt_query_param)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());

  if (!aesKeyBase64) return encrypted;  // 无 key = 明文
  return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
}

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
  private contextTokensPath: string;

  // Session expired 状态
  private sessionPausedUntil = 0;
  private onSessionExpired?: (message: string) => void;

  // Project path resolver（用于保存文件到 uploads 目录）
  private projectPathResolver?: (channelId: string) => Promise<string>;

  constructor(config: WechatConfig) {
    this.config = config;
    const dataDir = resolvePaths().dataDir;
    this.syncBufPath = path.join(dataDir, 'wechat-sync-buf.txt');
    this.contextTokensPath = path.join(dataDir, 'wechat-context-tokens.json');
  }

  // ── Public API ──────────────────────────────────────────────────────────

  onMessage(handler: WechatMessageHandler): void {
    this.messageHandler = handler;
  }

  /** 注册 session 过期通知回调（用于跨渠道通知用户） */
  onSessionExpiredNotify(handler: (message: string) => void): void {
    this.onSessionExpired = handler;
  }

  /** 当前是否处于 session 暂停状态 */
  isSessionPaused(): boolean {
    return Date.now() < this.sessionPausedUntil;
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

    // Session 暂停期间拒绝发送
    if (this.isSessionPaused()) {
      const remainingMin = Math.ceil((this.sessionPausedUntil - Date.now()) / 60_000);
      logger.warn(`[WeChat] Session paused, ${remainingMin}min remaining, dropping outbound to ${to}`);
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

  /** 注册 projectPath 解析器，用于保存接收的文件 */
  onProjectPathRequest(resolver: (channelId: string) => Promise<string>): void {
    this.projectPathResolver = resolver;
  }

  /** 发送文件（图片/视频/文件）给用户，通过 CDN 上传 */
  async sendFile(to: string, filePath: string): Promise<void> {
    // Session 暂停期间拒绝发送
    if (this.isSessionPaused()) {
      logger.warn(`[WeChat] Session paused, dropping file send to ${to}`);
      return;
    }

    const contextToken = this.contextTokenCache.get(to);
    if (!contextToken) {
      logger.error(`[WeChat] No context_token for ${to}, cannot send file`);
      return;
    }

    if (!fs.existsSync(filePath)) {
      logger.error(`[WeChat] File not found: ${filePath}`);
      return;
    }

    try {
      const plaintext = Buffer.from(fs.readFileSync(filePath));
      const rawsize = plaintext.length;
      const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
      const aeskey = crypto.randomBytes(16);
      const filekey = crypto.randomBytes(16).toString('hex');
      const filesize = Math.ceil((rawsize + 1) / 16) * 16;

      // MIME → UploadMediaType
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      const uploadMediaType = mime.startsWith('image/') ? 1
        : mime.startsWith('video/') ? 2 : 3;

      // Step 1: getuploadurl
      const uploadResp = await this.getUploadUrl({
        filekey, media_type: uploadMediaType, to_user_id: to,
        rawsize, rawfilemd5, filesize,
        aeskey: aeskey.toString('hex'),
        no_need_thumb: true,
      });

      // Step 2: encrypt + upload to CDN
      const ciphertext = encryptAesEcb(plaintext, aeskey);
      const downloadParam = await this.cdnUpload(uploadResp.upload_param!, filekey, ciphertext);

      // Step 3: sendmessage with CDN reference
      const cdnMedia: CDNMedia = {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
        encrypt_type: 1,
      };

      const itemType = mime.startsWith('image/') ? MSG_ITEM_IMAGE
        : mime.startsWith('video/') ? MSG_ITEM_VIDEO : MSG_ITEM_FILE;

      const item = this.buildMediaItem(itemType, cdnMedia, filePath, filesize, rawsize);
      await this.sendMediaMessage(to, item, contextToken);
    } catch (err) {
      logger.error(`[WeChat] Failed to send file ${filePath} to ${to}:`, err);
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
          // Session expired 专用处理
          const isSessionExpired =
            resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

          if (isSessionExpired) {
            consecutiveFailures = 0;
            logger.error(`[WeChat] Session expired (errcode=${resp.errcode}), retrying in ${SESSION_RETRY_DELAY_MS / 1000}s...`);

            // 短暂停后重试一次
            await this.sleep(SESSION_RETRY_DELAY_MS, signal);
            if (signal.aborted) return;

            // 重试 getupdates
            try {
              const retryBody = JSON.stringify({
                get_updates_buf: this.getUpdatesBuf,
                base_info: { channel_version: CHANNEL_VERSION },
              });
              const retryRaw = await this.apiFetch('ilink/bot/getupdates', retryBody, nextTimeoutMs, signal);
              const retryResp: GetUpdatesResp = JSON.parse(retryRaw);
              const retryExpired =
                retryResp.errcode === SESSION_EXPIRED_ERRCODE || retryResp.ret === SESSION_EXPIRED_ERRCODE;

              if (!retryExpired) {
                // 恢复成功，静默继续
                logger.info('[WeChat] Session recovered after retry');
                // 把 retryResp 当正常响应处理（更新游标和消息）
                if (retryResp.get_updates_buf) {
                  this.getUpdatesBuf = retryResp.get_updates_buf;
                  try { fs.writeFileSync(this.syncBufPath, this.getUpdatesBuf, 'utf-8'); } catch {}
                }
                for (const msg of retryResp.msgs ?? []) {
                  await this.handleInboundMessage(msg);
                }
                continue;
              }
            } catch (retryErr) {
              if (signal.aborted) return;
              logger.error('[WeChat] Retry after session expired also failed:', retryErr);
            }

            // 重试仍失败，进入长暂停
            const pauseMin = SESSION_PAUSE_DURATION_MS / 60_000;
            this.sessionPausedUntil = Date.now() + SESSION_PAUSE_DURATION_MS;
            logger.error(`[WeChat] Session still expired, pausing for ${pauseMin}min`);

            // 通知用户（通过其他渠道）
            if (this.onSessionExpired) {
              this.onSessionExpired(
                `⚠️ 微信 token 已过期，通道暂停 ${pauseMin} 分钟后自动重试。\n如需立即恢复，请运行: evolclaw init wechat`
              );
            }

            await this.sleep(SESSION_PAUSE_DURATION_MS, signal);
            if (signal.aborted) return;

            // 长暂停结束，清除暂停状态，循环自动重试
            this.sessionPausedUntil = 0;
            logger.info('[WeChat] Session pause ended, resuming polling');
            continue;
          }

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
          await this.handleInboundMessage(msg);
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

  // ── Inbound Message Handler ──────────────────────────────────────────

  private async handleInboundMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MSG_TYPE_USER) return;

    const fromUserId = msg.from_user_id ?? '';

    // 缓存 context_token
    if (msg.context_token) {
      this.contextTokenCache.set(fromUserId, msg.context_token);
      this.persistContextTokens();
    }

    // 提取文本（原有逻辑）
    const text = extractTextFromMessage(msg);

    // 提取媒体 → 下载
    const media = await this.extractMedia(msg, fromUserId);

    // 合成最终内容
    const finalContent = media.prompt
      ? (text ? `${text}\n\n${media.prompt}` : media.prompt)
      : text;
    if (!finalContent && !media.images.length) return;

    logger.info(`[WeChat] Received: from=${fromUserId} text=${(finalContent || '').slice(0, 50)} images=${media.images.length}...`);

    // 发送 typing 指示器（异步，不阻塞）
    this.acknowledgeMessage(fromUserId, msg.context_token).catch(() => {});

    // 回调主流程
    if (this.messageHandler) {
      try {
        await this.messageHandler(fromUserId, finalContent || '', fromUserId, media.images.length ? media.images : undefined);
      } catch (err) {
        logger.error('[WeChat] Message handler error:', err);
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

  // ── Media Extraction (Inbound) ────────────────────────────────────────

  private async extractMedia(msg: WeixinMessage, channelId: string): Promise<{
    prompt: string;
    images: Array<{ data: string; mimeType: string }>;
  }> {
    const images: Array<{ data: string; mimeType: string }> = [];
    const prompts: string[] = [];

    for (const item of msg.item_list ?? []) {
      try {
        if (item.type === MSG_ITEM_IMAGE && item.image_item?.media) {
          const buf = await downloadMedia(item.image_item.media, item.image_item.aeskey);
          images.push({ data: buf.toString('base64'), mimeType: 'image/jpeg' });
        } else if (item.type === MSG_ITEM_FILE && item.file_item?.media) {
          const buf = await downloadMedia(item.file_item.media);
          const fileName = this.sanitizeFileName(item.file_item.file_name || `file_${Date.now()}`);
          const savePath = await this.saveToUploads(buf, fileName, channelId);
          prompts.push(`用户发送了文件：${fileName}\n文件已保存到：${savePath}\n请使用 Read 工具读取并分析文件内容。`);
        } else if (item.type === MSG_ITEM_VIDEO && item.video_item?.media) {
          const buf = await downloadMedia(item.video_item.media);
          const fileName = `video_${Date.now()}.mp4`;
          const savePath = await this.saveToUploads(buf, fileName, channelId);
          prompts.push(`用户发送了视频：${fileName}\n文件已保存到：${savePath}`);
        }
      } catch (err) {
        logger.error(`[WeChat] Failed to download media type=${item.type}:`, err);
      }
    }

    return { prompt: prompts.join('\n\n'), images };
  }

  private async saveToUploads(buf: Buffer, fileName: string, channelId: string): Promise<string> {
    const projectPath = this.projectPathResolver
      ? await this.projectPathResolver(channelId)
      : process.cwd();
    const uploadsDir = path.join(projectPath, '.claude', 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const savePath = path.join(uploadsDir, fileName);
    fs.writeFileSync(savePath, buf);
    return savePath;
  }

  /** 清理文件名：移除路径穿越字符，只保留 basename */
  private sanitizeFileName(name: string): string {
    return path.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_') || `file_${Date.now()}`;
  }

  // ── Media Upload (Outbound) ──────────────────────────────────────────

  private async getUploadUrl(params: {
    filekey: string; media_type: number; to_user_id: string;
    rawsize: number; rawfilemd5: string; filesize: number;
    aeskey: string; no_need_thumb: boolean;
  }): Promise<{ upload_param?: string; thumb_upload_param?: string }> {
    const body = JSON.stringify({
      ...params,
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const raw = await this.apiFetch('ilink/bot/getuploadurl', body, DEFAULT_API_TIMEOUT_MS);
    const resp = JSON.parse(raw);
    if (!resp.upload_param) throw new Error('getuploadurl: no upload_param');
    return resp;
  }

  private async cdnUpload(uploadParam: string, filekey: string, ciphertext: Buffer): Promise<string> {
    const url = `${CDN_BASE_URL}/upload?encrypted_query_param=${
      encodeURIComponent(uploadParam)}&filekey=${filekey}`;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        });
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`CDN upload client error: ${res.status}`);
        }
        if (!res.ok) throw new Error(`CDN upload failed: ${res.status}`);

        const downloadParam = res.headers.get('x-encrypted-param');
        if (!downloadParam) throw new Error('Missing x-encrypted-param header');
        return downloadParam;
      } catch (err) {
        lastError = err as Error;
        if ((err as Error).message?.includes('client error')) throw err; // 4xx 不重试
      }
    }
    throw lastError!;
  }

  private buildMediaItem(
    itemType: number, cdnMedia: CDNMedia, filePath: string,
    ciphertextSize: number, plaintextSize: number
  ): MessageItem {
    if (itemType === MSG_ITEM_IMAGE) {
      return { type: MSG_ITEM_IMAGE, image_item: { media: cdnMedia, mid_size: ciphertextSize } };
    }
    if (itemType === MSG_ITEM_VIDEO) {
      return { type: MSG_ITEM_VIDEO, video_item: { media: cdnMedia, video_size: ciphertextSize } };
    }
    return {
      type: MSG_ITEM_FILE,
      file_item: {
        media: cdnMedia,
        file_name: path.basename(filePath),
        len: String(plaintextSize),
      },
    };
  }

  private async sendMediaMessage(to: string, item: MessageItem, contextToken: string): Promise<void> {
    const clientId = `evolclaw-wechat:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    await this.apiFetch('ilink/bot/sendmessage', JSON.stringify(body), DEFAULT_API_TIMEOUT_MS);
    logger.info(`[WeChat] Sent media to ${to}, type=${item.type}`);
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

  // ── Persistence ────────────────────────────────────────────────────

  /** 持久化 context_token 到文件，供 restart-monitor 等外部进程读取 */
  private persistContextTokens(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.contextTokenCache) {
        obj[k] = v;
      }
      fs.writeFileSync(this.contextTokensPath, JSON.stringify(obj), 'utf-8');
    } catch {
      // best-effort
    }
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
