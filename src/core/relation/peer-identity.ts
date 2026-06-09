/**
 * PeerIdentityCache - 对端身份缓存管理
 *
 * 职责：
 * 1. 通过 agentmdSync 标准流程获取对端 agent.md（check → fetch if changed）
 * 2. 仅在 agent.md 内容变化时重写 peer-identity.json
 * 3. 支持入站和出站消息的身份查询
 *
 * 信源：对端的 agent.md（通过 AIDStore.checkAgentMd + downloadAgentMd，由 agentmdSync 封装）
 * 判定规则：type !== 'human' → agent
 * 缓存位置：$AGENT_DIR/relations/<channel>#<urlEncode(peerId)>/peer-identity.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AIDStore } from '@agentunion/fastaun';
import { logger } from '../../utils/logger.js';
import { agentMdPath } from '../../paths.js';

/**
 * peerKey: 关系层路由键，格式 `<channelType>#<urlEncode(channelId)>`。
 * 群聊场景下 channelId = groupId，所有发言者共用同一个 peerKey。
 */
export function formatPeerKey(channelType: string, channelId: string): string {
  return `${channelType}#${encodeURIComponent(channelId)}`;
}

export function parsePeerKey(key: string): { channelType: string; channelId: string } {
  const idx = key.indexOf('#');
  if (idx <= 0) throw new Error(`Invalid peer key: ${key}`);
  return {
    channelType: key.slice(0, idx),
    channelId: decodeURIComponent(key.slice(idx + 1)),
  };
}

/**
 * 对端身份信息
 */
export interface PeerIdentity {
  /** 对端 AID */
  aid: string;
  /** agent.md 的 type 字段（'human' | 'Claude Code' | 'Codex' | ...） */
  type: string;
  /** type !== 'human' */
  isAgent: boolean;
  /** 显示名 */
  name?: string;
  /** agent.md 内容的 SHA256（用于检测变化） */
  agentMdHash: string;
  /** agent.md 内容最后变化的时间戳 */
  agentMdUpdatedAt: number;
  /** 验签成功的时间戳（仅 source==='agentmd' 时有意义，未验签为 0） */
  verifiedAt: number;
  /** 最后检查 agent.md 的时间戳 */
  lastCheckedAt: number;
  /**
   * 身份来源与可信级别：
   * - agentmd：agent.md 验签通过，身份可信
   * - agentmd-unverified：agent.md 内容可解析但验签未通过（如对端 rekey 后用旧证书签名），
   *   type 仍按声明解析，但不应作为已验签身份信任
   * - unknown：无 agent.md 内容（拉取失败且本地无缓存）
   */
  source: 'agentmd' | 'agentmd-unverified' | 'unknown';
}

/**
 * 对端身份缓存管理器
 */
export class PeerIdentityCache {
  /** 缓存最大时效：30 天 */
  private static readonly CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * 获取 peer-identity.json 文件路径
   */
  private static getFilePath(channelType: string, peerId: string, agentDir: string): string {
    const peerKey = formatPeerKey(channelType, peerId);
    return path.join(agentDir, 'relations', peerKey, 'peer-identity.json');
  }

  /**
   * 从文件读取缓存
   * @returns PeerIdentity | null（缓存不存在）
   */
  static get(channelType: string, peerId: string, agentDir: string): PeerIdentity | null {
    const filePath = this.getFilePath(channelType, peerId, agentDir);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as PeerIdentity;
    } catch {
      return null;
    }
  }

  /**
   * 检查缓存是否需要刷新
   * @param maxAgeMs 最大缓存时间（默认 30 天）
   * @returns true=需要刷新
   */
  static needsRefresh(
    channelType: string,
    peerId: string,
    agentDir: string,
    maxAgeMs = this.CACHE_MAX_AGE_MS
  ): boolean {
    const cached = this.get(channelType, peerId, agentDir);
    if (!cached) return true;
    return Date.now() - cached.lastCheckedAt > maxAgeMs;
  }

  /**
   * 从 agent.md 更新身份信息
   * @param source 'agentmd'（验签通过）或 'agentmd-unverified'（内容可解析但验签未过）
   * @param verifiedAt 验签通过时间戳；未验签传 0
   */
  private static updateFromAgentMd(
    channelType: string,
    peerId: string,
    agentDir: string,
    agentMd: string,
    verifiedAt: number,
    source: 'agentmd' | 'agentmd-unverified' = 'agentmd'
  ): PeerIdentity {
    const typeMatch = agentMd.match(/^type:\s*["']?([^"'\n]+?)["']?\s*$/m);
    const nameMatch = agentMd.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const type = typeMatch?.[1] || 'unknown';
    const isAgent = type !== 'human';
    const name = nameMatch?.[1]?.trim();

    const agentMdHash = 'sha256:' + crypto.createHash('sha256').update(agentMd, 'utf-8').digest('hex');
    const now = Date.now();

    const identity: PeerIdentity = {
      aid: peerId,
      type,
      isAgent,
      name,
      agentMdHash,
      agentMdUpdatedAt: now,
      verifiedAt,
      lastCheckedAt: now,
      source,
    };

    const filePath = this.getFilePath(channelType, peerId, agentDir);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8');
      logger.debug(`[PeerIdentityCache] Updated: ${channelType}#${peerId} type=${type} isAgent=${isAgent} source=${source}`);
    } catch (err) {
      logger.warn(`[PeerIdentityCache] Failed to write cache: ${filePath} err=${err}`);
    }

    return identity;
  }

  /**
   * 仅更新 lastCheckedAt（内容未变时的轻量操作）
   */
  private static touchLastChecked(channelType: string, peerId: string, agentDir: string, cached: PeerIdentity): PeerIdentity {
    const updated = { ...cached, lastCheckedAt: Date.now() };
    const filePath = this.getFilePath(channelType, peerId, agentDir);
    try {
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
    } catch { /* ignore */ }
    return updated;
  }

  /**
   * 标记为 unknown（验签失败或无 agent.md）
   */
  private static markUnknown(channelType: string, peerId: string, agentDir: string): PeerIdentity {
    const identity: PeerIdentity = {
      aid: peerId,
      type: 'unknown',
      isAgent: true,
      agentMdHash: '',
      agentMdUpdatedAt: 0,
      verifiedAt: 0,
      lastCheckedAt: Date.now(),
      source: 'unknown',
    };

    const filePath = this.getFilePath(channelType, peerId, agentDir);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8');
      logger.debug(`[PeerIdentityCache] Marked unknown: ${channelType}#${peerId}`);
    } catch (err) {
      logger.warn(`[PeerIdentityCache] Failed to write unknown cache: ${filePath} err=${err}`);
    }

    return identity;
  }

  /**
   * 完整流程：缓存检查 → agentmdSync（check+fetch）→ 按 changed 决定是否重写
   *
   * @param channelType 渠道类型（如 'aun'）
   * @param peerId 对端 ID（AUN 是 AID）
   * @param agentDir agent 数据根目录
   * @param store AIDStore 实例（由调用方提供，负责 checkAgentMd + downloadAgentMd）
   * @param forceRefresh 强制刷新（忽略缓存时效）
   */
  static async resolve(
    channelType: string,
    peerId: string,
    agentDir: string,
    store: AIDStore,
    forceRefresh = false
  ): Promise<PeerIdentity> {
    // 1. 缓存检查
    if (!forceRefresh && !this.needsRefresh(channelType, peerId, agentDir)) {
      const cached = this.get(channelType, peerId, agentDir);
      if (cached) {
        logger.debug(`[PeerIdentityCache] Cache hit: ${channelType}#${peerId} type=${cached.type} age=${Math.floor((Date.now() - cached.lastCheckedAt) / 1000 / 60 / 60 / 24)}d`);
        return cached;
      }
    }

    // 2. 通过 agentmdSync 拉取（内部走 store.checkAgentMd → store.downloadAgentMd）
    try {
      logger.debug(`[PeerIdentityCache] Syncing agent.md: ${channelType}#${peerId}`);
      const { agentmdSync } = await import('../../aun/aid/agentmd.js');
      const result = await agentmdSync(peerId, { store });
      const content = result.content;

      if (!content) {
        throw new Error('agent.md content unavailable');
      }

      // 验签通过 → 可信（source=agentmd）；否则 type 仍解析但标记未验证
      const verified = result.verification?.status === 'verified';
      const source: 'agentmd' | 'agentmd-unverified' = verified ? 'agentmd' : 'agentmd-unverified';
      if (!verified) {
        logger.info(`[PeerIdentityCache] agent.md unverified for ${peerId}: status=${result.verification?.status ?? 'unknown'} reason=${result.verification?.reason ?? '-'} (type 仍按声明解析)`);
      }

      // 3. 比较 hash，内容与可信级别都未变时仅 touch
      const newHash = 'sha256:' + crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
      const cached = this.get(channelType, peerId, agentDir);
      if (cached && cached.agentMdHash === newHash && cached.source === source) {
        return this.touchLastChecked(channelType, peerId, agentDir, cached);
      }
      return this.updateFromAgentMd(channelType, peerId, agentDir, content, verified ? Date.now() : 0, source);

    } catch (err) {
      // 4. agentmdSync 抛错（非网络失败——网络失败时它内部已 fallback 返回本地内容；
      //    这里通常是无内容或解析异常）。兜底读本地文件，但无法重新验签，
      //    故沿用缓存里已有的可信级别，绝不凭空升级为已验签。
      const localPath = agentMdPath(peerId);
      try {
        if (fs.existsSync(localPath)) {
          const localContent = fs.readFileSync(localPath, 'utf-8');
          const cached = this.get(channelType, peerId, agentDir);
          logger.info(`[PeerIdentityCache] Using local agent.md for ${peerId} (cached source=${cached?.source ?? 'none'})`);
          const localHash = 'sha256:' + crypto.createHash('sha256').update(localContent, 'utf-8').digest('hex');
          if (cached && cached.agentMdHash === localHash && (cached.source === 'agentmd' || cached.source === 'agentmd-unverified')) {
            return this.touchLastChecked(channelType, peerId, agentDir, cached);
          }
          // 无匹配缓存可信级别 → 本地内容未经本次验签，标记为未验证
          const fallbackSource = cached?.source === 'agentmd' ? 'agentmd' : 'agentmd-unverified';
          return this.updateFromAgentMd(channelType, peerId, agentDir, localContent, cached?.verifiedAt ?? 0, fallbackSource);
        }
      } catch { /* ignore fs errors */ }

      logger.warn(`[PeerIdentityCache] Failed to resolve: ${channelType}#${peerId} err=${err instanceof Error ? err.message : String(err)}`);
      return this.markUnknown(channelType, peerId, agentDir);
    }
  }

  /**
   * 清除指定对端的缓存
   */
  static clear(channelType: string, peerId: string, agentDir: string): void {
    const filePath = this.getFilePath(channelType, peerId, agentDir);
    try {
      fs.unlinkSync(filePath);
      logger.debug(`[PeerIdentityCache] Cleared: ${channelType}#${peerId}`);
    } catch {
      // 文件不存在，忽略
    }
  }
}
