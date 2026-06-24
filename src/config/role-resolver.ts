/**
 * Role Resolver - 角色解析器
 *
 * 根据用户标识和 agent 配置，解析用户在该 agent 中的角色。
 * 优先级：owners > admins > members > 已认证用户(guest) > 匿名(anonymous)
 */

import { read, ConfigTarget } from './config-manager.js';
import { parsePeerKey } from '../core/relation/peer-identity.js';
import type { AgentConfig, BuiltinRole } from '../types.js';

/**
 * 解析用户角色
 *
 * @param self Agent ID
 * @param peerKey 用户标识（格式：channel#encodedId 或裸 AID）
 * @returns 用户角色
 */
export function resolveUserRole(
  self: string,
  peerKey: string
): BuiltinRole | 'guest' {
  try {
    const config = read<AgentConfig>(ConfigTarget.Agent, { self });
    if (!config) {
      console.warn(`[role-resolver] Agent config not found for ${self}, defaulting to anonymous`);
      return 'anonymous';
    }

    // 提取裸 ID（从 channel#encodedId 格式中提取 channelId）
    let peerId: string;
    try {
      const { channelId } = parsePeerKey(peerKey);
      peerId = channelId;
    } catch {
      // 如果解析失败，可能已经是裸 ID
      peerId = peerKey;
    }

    // 检查 owners（使用裸 ID）
    if (config.owners?.includes(peerId)) {
      return 'owner';
    }

    // 检查 admins
    if (config.admins?.includes(peerId)) {
      return 'admin';
    }

    // 检查 members
    if (config.members?.includes(peerId)) {
      return 'member';
    }

    // 已认证但未授权 -> guest
    if (isAuthenticated(peerId)) {
      return 'guest';
    }

    // 完全未认证 -> anonymous
    return 'anonymous';
  } catch (err) {
    console.warn(`[role-resolver] Failed to resolve role for ${peerKey}:`, err);
    return 'anonymous'; // 安全降级
  }
}

/**
 * 检查用户是否已认证
 * 判断裸 ID 是否符合 AID 格式
 *
 * @param peerId 裸用户 ID（已从 peerKey 中提取）
 * @returns 是否已认证
 */
export function isAuthenticated(peerId: string): boolean {
  // AID 格式：xxx.aid.pub 或 xxx.agentid.pub
  return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(peerId);
}

/**
 * 批量解析多个用户的角色
 *
 * @param self Agent ID
 * @param peerKeys 用户标识列表
 * @returns 用户标识 -> 角色的映射
 */
export function resolveUserRoles(
  self: string,
  peerKeys: string[]
): Map<string, BuiltinRole | 'guest'> {
  const result = new Map<string, BuiltinRole | 'guest'>();
  for (const peerKey of peerKeys) {
    result.set(peerKey, resolveUserRole(self, peerKey));
  }
  return result;
}
