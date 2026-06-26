/**
 * Role Resolver - 角色解析器
 *
 * 根据用户标识和 agent 配置，解析用户在该 agent 中的角色。
 * 优先级：owners > admins > members > defaultRole（全局兜底角色，默认 anonymous）
 */

import { read, ConfigTarget, resolveRoles } from './config-manager.js';
import { parsePeerKey } from '../core/relation/peer-identity.js';
import type { AgentConfig, RelationConfig } from '../types.js';

function relationKeysFor(peerKey: string, peerId: string): string[] {
  const keys = [peerKey];
  const rawAunKey = `aun#${peerId}`;
  const aunKey = `aun#${encodeURIComponent(peerId)}`;
  if (!keys.includes(rawAunKey)) keys.push(rawAunKey);
  if (!keys.includes(aunKey)) keys.push(aunKey);
  return keys;
}

function readRelationRole(self: string, peerKey: string, peerId: string): string | undefined {
  for (const key of relationKeysFor(peerKey, peerId)) {
    const relation = read<RelationConfig>(ConfigTarget.Relation, { self, peerKey: key });
    if (typeof relation?.role === 'string' && relation.role.trim()) {
      return relation.role.trim();
    }
  }
  return undefined;
}

export function isAuthenticated(userId: string): boolean {
  return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(userId);
}

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
): string {
  try {
    const config = read<AgentConfig>(ConfigTarget.Agent, { self });
    if (!config) {
      console.warn(`[role-resolver] Agent config not found for ${self}, using global defaultRole`);
      return getDefaultRole();
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

    const relationRole = readRelationRole(self, peerKey, peerId);
    if (relationRole) {
      return relationRole;
    }

    // 未在名单 -> 使用全局默认角色
    if (isAuthenticated(peerId)) {
      return 'guest';
    }

    return getDefaultRole();
  } catch (err) {
    console.warn(`[role-resolver] Failed to resolve role for ${peerKey}:`, err);
    return getDefaultRole(); // 安全降级
  }
}

/**
 * 获取全局默认角色（从 roles.json 读取，兜底为 'anonymous'）
 */
function getDefaultRole(): string {
  try {
    const rolesConfig = resolveRoles({ cache: true });
    return rolesConfig.defaultRole || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

/**
 * 检查角色是否允许访问（从 roles.json 读取该角色的 allowAccess 配置）
 * @param role 角色名称
 * @returns 是否允许访问，默认 true（anonymous 默认 false）
 */
export function checkRoleAccess(role: string): boolean {
  try {
    const rolesConfig = resolveRoles({ cache: true });
    const roleDef = rolesConfig.roles[role];
    if (!roleDef) {
      // 未定义的角色，默认允许（安全兜底）
      return true;
    }
    // 读取 allowAccess，未配置时默认 true（anonymous 内置为 false）
    return roleDef.allowAccess ?? true;
  } catch (err) {
    console.warn(`[role-resolver] Failed to check access for role ${role}:`, err);
    return true; // 读取失败时默认允许，避免误拦截
  }
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
): Map<string, string> {
  const result = new Map<string, string>();
  for (const peerKey of peerKeys) {
    result.set(peerKey, resolveUserRole(self, peerKey));
  }
  return result;
}
