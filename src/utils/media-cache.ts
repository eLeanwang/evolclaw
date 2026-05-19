/**
 * 统一媒体下载/缓存/SSRF防护框架
 *
 * 提供跨通道复用的文件处理能力：
 * - 文件保存到 uploads 目录（自动去重、文件名清洗）
 * - 图片类型白名单 + 大小限制
 * - URL SSRF 防护（域名白名单 + 私有 IP 拦截）
 * - 下载缓存（相同 key 不重复下载）
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from './logger.js';

// ── 常量 ──────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 10 MB
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;   // 100 MB
const ALLOWED_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);
const UPLOADS_SUBDIR = '.evolclaw/uploads';

// ── SSRF 防护 ─────────────────────────────────────────────────────────────────

/** 已知安全的 CDN 域名白名单 */
const ALLOWED_CDN_HOSTS = new Set([
  'novac2c.cdn.weixin.qq.com',
  'open.feishu.cn',
  'internal-api-lark-file.feishu.cn',
  'oapi.dingtalk.com',
  'api.dingtalk.com',
]);

/** 私有 IP 段正则（IPv4） */
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|::1|fc|fd|fe80)/;

/**
 * 检查 URL 是否安全（非 SSRF）
 * - 拒绝私有 IP
 * - 仅允许 https（或白名单域名的 http）
 * - 可选：域名白名单模式
 */
export function validateUrl(url: string, opts?: { allowedHosts?: Set<string> }): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }

  // 协议检查
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  // 私有 IP 检查
  const host = parsed.hostname;
  if (PRIVATE_IP_RE.test(host)) {
    return { ok: false, reason: `Blocked private IP: ${host}` };
  }

  // 域名白名单（如果提供）
  const allowed = opts?.allowedHosts ?? ALLOWED_CDN_HOSTS;
  if (allowed.size > 0 && !allowed.has(host)) {
    return { ok: false, reason: `Host not in allowlist: ${host}` };
  }

  return { ok: true };
}

// ── 文件名清洗 ────────────────────────────────────────────────────────────────

/**
 * 清洗文件名：
 * - 移除路径穿越字符（只保留 basename）
 * - 替换非法字符
 * - 空结果兜底
 */
export function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_') || `file_${Date.now()}`;
}

// ── 图片验证 ──────────────────────────────────────────────────────────────────

/**
 * 验证图片 Buffer：类型白名单 + 大小限制
 * 返回检测到的 MIME 类型，验证失败返回 null + reason
 */
export async function validateImage(
  buffer: Buffer,
  opts?: { maxSize?: number; allowedMimes?: Set<string> }
): Promise<{ mime: string } | { mime: null; reason: string }> {
  const maxSize = opts?.maxSize ?? DEFAULT_MAX_IMAGE_SIZE;
  const allowed = opts?.allowedMimes ?? ALLOWED_IMAGE_MIMES;

  if (buffer.length === 0) {
    return { mime: null, reason: 'Empty buffer' };
  }
  if (buffer.length > maxSize) {
    return { mime: null, reason: `Image too large: ${buffer.length} bytes (max ${maxSize})` };
  }

  // 动态导入 image-type（ESM only）
  const { default: imageType } = await import('image-type');
  const type = await imageType(buffer);
  if (!type) {
    return { mime: null, reason: 'Unable to detect image type' };
  }
  if (!allowed.has(type.mime)) {
    return { mime: null, reason: `Unsupported image type: ${type.mime}` };
  }

  return { mime: type.mime };
}

// ── 文件保存 ──────────────────────────────────────────────────────────────────

export interface SaveResult {
  filePath: string;
  fileName: string;
  size: number;
}

/**
 * 保存 Buffer 到 uploads 目录
 * - 自动创建目录
 * - 文件名清洗
 * - 同名文件自动添加时间戳后缀
 */
export function saveToUploads(
  buffer: Buffer,
  rawFileName: string,
  projectPath: string,
  opts?: { dedup?: boolean }
): SaveResult {
  const fileName = sanitizeFileName(rawFileName);
  const uploadsDir = path.join(projectPath, UPLOADS_SUBDIR);
  fs.mkdirSync(uploadsDir, { recursive: true });

  let targetName = fileName;
  const targetPath = path.join(uploadsDir, targetName);

  // 去重：内容相同则复用
  if (opts?.dedup !== false && fs.existsSync(targetPath)) {
    const existingHash = hashFile(targetPath);
    const newHash = crypto.createHash('md5').update(buffer).digest('hex');
    if (existingHash === newHash) {
      logger.debug(`[MediaCache] Dedup hit: ${targetName}`);
      return { filePath: targetPath, fileName: targetName, size: buffer.length };
    }
    // 不同内容同名 → 加时间戳
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    targetName = `${base}_${Date.now()}${ext}`;
  }

  const finalPath = path.join(uploadsDir, targetName);
  fs.writeFileSync(finalPath, buffer);
  logger.info(`[MediaCache] Saved: ${finalPath} (${buffer.length} bytes)`);
  return { filePath: finalPath, fileName: targetName, size: buffer.length };
}

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

// ── 安全下载 ──────────────────────────────────────────────────────────────────

export interface DownloadOptions {
  /** 域名白名单（默认使用内置 CDN 白名单） */
  allowedHosts?: Set<string>;
  /** 跳过 SSRF 检查（仅用于已知安全的内部 API 调用） */
  skipSsrfCheck?: boolean;
  /** 最大下载大小（字节，默认 100MB） */
  maxSize?: number;
  /** 超时（毫秒，默认 30s） */
  timeout?: number;
}

/**
 * 安全下载 URL 内容，带 SSRF 防护
 */
export async function safeFetch(url: string, opts?: DownloadOptions): Promise<Buffer> {
  const maxSize = opts?.maxSize ?? DEFAULT_MAX_FILE_SIZE;
  const timeout = opts?.timeout ?? 30_000;

  // SSRF 检查
  if (!opts?.skipSsrfCheck) {
    const check = validateUrl(url, { allowedHosts: opts?.allowedHosts });
    if (!check.ok) {
      throw new Error(`SSRF blocked: ${check.reason}`);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

    // 检查 Content-Length（如果可用）
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > maxSize) {
      throw new Error(`File too large: ${contentLength} bytes (max ${maxSize})`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxSize) {
      throw new Error(`File too large: ${buffer.length} bytes (max ${maxSize})`);
    }

    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

// ── 下载缓存 ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  buffer: Buffer;
  createdAt: number;
}

/**
 * 内存级下载缓存
 * - 相同 key 不重复下载
 * - TTL 过期自动清理
 * - 最大条目限制防止内存泄漏
 */
export class DownloadCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxEntries: number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? 5 * 60 * 1000;  // 5 min
    this.maxEntries = opts?.maxEntries ?? 100;
  }

  /**
   * 获取或下载：缓存命中直接返回，否则执行 fetcher 并缓存结果
   */
  async getOrFetch(key: string, fetcher: () => Promise<Buffer>): Promise<Buffer> {
    this.evict();

    const cached = this.cache.get(key);
    if (cached) {
      logger.debug(`[DownloadCache] Hit: ${key}`);
      return cached.buffer;
    }

    const buffer = await fetcher();
    this.cache.set(key, { buffer, createdAt: Date.now() });

    // 超过 maxEntries 时删最旧
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }

    return buffer;
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// ── MIME / Size helpers ──────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
  '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};

export function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
