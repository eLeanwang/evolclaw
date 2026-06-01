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
import { formatPeerKey } from './peer-key.js';

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
  /** 验签成功的时间戳 */
  verifiedAt: number;
  /** 最后检查 agent.md 的时间戳 */
  lastCheckedAt: number;
  /** agentmd=已验签，unknown=验签失败或无 agent.md */
  source: 'agentmd' | 'unknown';
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
   */
  private static updateFromAgentMd(
    channelType: string,
    peerId: string,
    agentDir: string,
    agentMd: string,
    verifiedAt: number
  ): PeerIdentity {
    const typeMatch = agentMd.match(/^type:\s*["']?(\w+)["']?/m);
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
      source: 'agentmd',
    };

    const filePath = this.getFilePath(channelType, peerId, agentDir);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8');
      logger.debug(`[PeerIdentityCache] Updated: ${channelType}#${peerId} type=${type} isAgent=${isAgent}`);
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

      // 3. 比较 hash，仅在变化时重写 peer-identity.json
      const newHash = 'sha256:' + crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
      const cached = this.get(channelType, peerId, agentDir);
      if (cached && cached.agentMdHash === newHash && cached.source === 'agentmd') {
        return this.touchLastChecked(channelType, peerId, agentDir, cached);
      }
      return this.updateFromAgentMd(channelType, peerId, agentDir, content, Date.now());

    } catch (err) {
      // 4. 网络失败，fallback 本地文件
      const localPath = agentMdPath(peerId);
      try {
        if (fs.existsSync(localPath)) {
          const localContent = fs.readFileSync(localPath, 'utf-8');
          logger.info(`[PeerIdentityCache] Network failed, using local agent.md for ${peerId}`);
          const localHash = 'sha256:' + crypto.createHash('sha256').update(localContent, 'utf-8').digest('hex');
          const cached = this.get(channelType, peerId, agentDir);
          if (cached && cached.agentMdHash === localHash && cached.source === 'agentmd') {
            return this.touchLastChecked(channelType, peerId, agentDir, cached);
          }
          return this.updateFromAgentMd(channelType, peerId, agentDir, localContent, cached?.verifiedAt ?? 0);
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
