/**
 * PeerIdentityCache - 对端身份缓存管理
 *
 * 职责：
 * 1. 从对端的 agent.md 确定身份（human / agent）
 * 2. 缓存到关系层文件（30天时效）
 * 3. 支持入站和出站消息的身份查询
 *
 * 信源：对端的 agent.md（通过 AUN SDK 下载并验签）
 * 判定规则：type !== 'human' → agent
 * 缓存位置：$AGENT_DIR/relations/<channel>#<urlEncode(peerId)>/peer-identity.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';

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
  private static getFilePath(channel: string, peerId: string, agentDir: string): string {
    const peerKey = `${channel}#${encodeURIComponent(peerId)}`;
    return path.join(agentDir, 'relations', peerKey, 'peer-identity.json');
  }

  /**
   * 从文件读取缓存
   * @returns PeerIdentity | null（缓存不存在）
   */
  static get(channel: string, peerId: string, agentDir: string): PeerIdentity | null {
    const filePath = this.getFilePath(channel, peerId, agentDir);
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
    channel: string,
    peerId: string,
    agentDir: string,
    maxAgeMs = this.CACHE_MAX_AGE_MS
  ): boolean {
    const cached = this.get(channel, peerId, agentDir);
    if (!cached) return true;
    return Date.now() - cached.lastCheckedAt > maxAgeMs;
  }

  /**
   * 从 agent.md 更新身份信息
   * @param agentMd 已验签的 agent.md 内容
   */
  private static updateFromAgentMd(
    channel: string,
    peerId: string,
    agentDir: string,
    agentMd: string,
    verifiedAt: number
  ): PeerIdentity {
    // 解析 type 和 name
    const typeMatch = agentMd.match(/^type:\s*["']?(\w+)["']?/m);
    const nameMatch = agentMd.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const type = typeMatch?.[1] || 'unknown';
    const isAgent = type !== 'human';
    const name = nameMatch?.[1]?.trim();

    // 计算 hash
    const agentMdHash = 'sha256:' + crypto.createHash('sha256').update(agentMd, 'utf-8').digest('hex');

    // 构建身份信息
    const identity: PeerIdentity = {
      aid: peerId,
      type,
      isAgent,
      name,
      agentMdHash,
      verifiedAt,
      lastCheckedAt: Date.now(),
      source: 'agentmd',
    };

    // 写入文件
    const filePath = this.getFilePath(channel, peerId, agentDir);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8');
      logger.debug(`[PeerIdentityCache] Updated: ${channel}#${peerId} type=${type} isAgent=${isAgent}`);
    } catch (err) {
      logger.warn(`[PeerIdentityCache] Failed to write cache: ${filePath} err=${err}`);
    }

    return identity;
  }

  /**
   * 标记为 unknown（验签失败或无 agent.md）
   */
  private static markUnknown(channel: string, peerId: string, agentDir: string): PeerIdentity {
    const identity: PeerIdentity = {
      aid: peerId,
      type: 'unknown',
      isAgent: true,  // 验签失败 → 当做 agent（安全策略）
      agentMdHash: '',
      verifiedAt: 0,
      lastCheckedAt: Date.now(),
      source: 'unknown',
    };

    const filePath = this.getFilePath(channel, peerId, agentDir);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8');
      logger.debug(`[PeerIdentityCache] Marked unknown: ${channel}#${peerId}`);
    } catch (err) {
      logger.warn(`[PeerIdentityCache] Failed to write unknown cache: ${filePath} err=${err}`);
    }

    return identity;
  }

  /**
   * 完整流程：检查缓存 → 需要刷新则下载 agent.md → 更新缓存
   *
   * @param channel 渠道类型（如 'aun'）
   * @param peerId 对端 ID（AUN 是 AID）
   * @param agentDir agent 数据根目录
   * @param aunClient AUN SDK client（需要有 fetchAgentMd 方法）
   * @param forceRefresh 强制刷新（忽略缓存时效）
   * @returns PeerIdentity
   */
  static async resolve(
    channel: string,
    peerId: string,
    agentDir: string,
    aunClient: any,
    forceRefresh = false
  ): Promise<PeerIdentity> {
    // 1. 检查缓存
    if (!forceRefresh && !this.needsRefresh(channel, peerId, agentDir)) {
      const cached = this.get(channel, peerId, agentDir);
      if (cached) {
        logger.debug(`[PeerIdentityCache] Cache hit: ${channel}#${peerId} type=${cached.type} age=${Math.floor((Date.now() - cached.lastCheckedAt) / 1000 / 60 / 60 / 24)}d`);
        return cached;
      }
    }

    // 2. 下载并验签 agent.md（SDK 自动验签）
    try {
      logger.debug(`[PeerIdentityCache] Fetching agent.md: ${channel}#${peerId}`);
      const result = await aunClient.fetchAgentMd(peerId);
      const agentMd = result.content;

      // 3. 更新缓存
      return this.updateFromAgentMd(channel, peerId, agentDir, agentMd, Date.now());
    } catch (err) {
      // 验签失败或下载失败 → 标记为 unknown，当做 agent
      logger.warn(`[PeerIdentityCache] Failed to fetch agent.md: ${channel}#${peerId} err=${err instanceof Error ? err.message : String(err)}`);
      return this.markUnknown(channel, peerId, agentDir);
    }
  }

  /**
   * 清除指定对端的缓存
   */
  static clear(channel: string, peerId: string, agentDir: string): void {
    const filePath = this.getFilePath(channel, peerId, agentDir);
    try {
      fs.unlinkSync(filePath);
      logger.debug(`[PeerIdentityCache] Cleared: ${channel}#${peerId}`);
    } catch {
      // 文件不存在，忽略
    }
  }
}
