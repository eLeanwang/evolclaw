/**
 * 角色系统修复验证测试
 * 验证 P0-1 和 P0-2 的修复
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveUserRole } from '../src/config/role-resolver.js';
import { resolvePermissionMode, resolveEffectiveModel } from '../src/core/model/config-scope.js';
import { write, ensureFile, ConfigTarget } from '../src/config/config-manager.js';
import { formatPeerKey } from '../src/core/relation/peer-identity.js';
import type { AgentConfig } from '../src/types.js';

describe('Role System Fixes Verification', () => {
  const testAgent = 'fix-test.agentid.pub';
  const ownerAid = 'alice.aid.pub';
  const adminAid = 'bob.aid.pub';
  const memberAid = 'charlie.aid.pub';
  const guestAid = 'guest.aid.pub';

  beforeEach(() => {
    // 创建测试 agent
    const config: Partial<AgentConfig> = {
      aid: testAgent,
      channels: [],
      owners: [ownerAid],
      admins: [adminAid],
      members: [memberAid]
    };
    ensureFile(ConfigTarget.Agent, { self: testAgent });
    write(ConfigTarget.Agent, config, { self: testAgent });
  });

  describe('P0-2: peerKey 格式处理', () => {
    it('should correctly parse channel#encodedId format', () => {
      // 使用 channel#encodedId 格式
      const ownerPeerKey = formatPeerKey('aun', ownerAid);
      const adminPeerKey = formatPeerKey('aun', adminAid);
      const memberPeerKey = formatPeerKey('aun', memberAid);
      const guestPeerKey = formatPeerKey('aun', guestAid);

      expect(resolveUserRole(testAgent, ownerPeerKey)).toBe('owner');
      expect(resolveUserRole(testAgent, adminPeerKey)).toBe('admin');
      expect(resolveUserRole(testAgent, memberPeerKey)).toBe('member');
      expect(resolveUserRole(testAgent, guestPeerKey)).toBe('guest');
    });

    it('should still work with bare AID format', () => {
      // 直接使用裸 AID（兼容性）
      expect(resolveUserRole(testAgent, ownerAid)).toBe('owner');
      expect(resolveUserRole(testAgent, adminAid)).toBe('admin');
      expect(resolveUserRole(testAgent, memberAid)).toBe('member');
      expect(resolveUserRole(testAgent, guestAid)).toBe('guest');
    });

    it('should handle URL-encoded peerKey', () => {
      // 测试包含特殊字符的 AID
      const specialAid = 'user@special.aid.pub';
      const specialPeerKey = formatPeerKey('aun', specialAid);

      // 添加到 owners
      const config: Partial<AgentConfig> = {
        aid: testAgent,
        channels: [],
        owners: [specialAid] // 注意：存储的是未编码的 AID
      };
      write(ConfigTarget.Agent, config, { self: testAgent });

      // 使用编码后的 peerKey 应该能正确识别
      expect(resolveUserRole(testAgent, specialPeerKey)).toBe('owner');
    });
  });

  describe('P0-1: 运行时路径集成', () => {
    it('should apply role constraints in resolvePermissionMode', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      // Guest 尝试设置 bypass
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: guestPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        { permissionMode: 'bypass' },
        { self: testAgent, peerKey: guestPeerKey }
      );

      // resolvePermissionMode 应该应用角色约束
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: guestPeerKey
      });

      expect(mode).toBe('readonly'); // guest 被降级到 readonly
    });

    it('should apply role constraints in resolveEffectiveModel', () => {
      const memberPeerKey = formatPeerKey('aun', memberAid);

      // Member 尝试使用 opus
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: memberPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          baseagents: {
            claude: {
              model: 'claude-opus-4-8'
            }
          }
        },
        { self: testAgent, peerKey: memberPeerKey }
      );

      // resolveEffectiveModel 应该应用角色约束
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: memberPeerKey
      }, 'claude');

      // member 不能使用 opus，应该降级到默认
      expect(resolved.model).not.toBe('claude-opus-4-8');
      expect(resolved.model).toBe('claude-sonnet-4-6'); // member 默认
    });

    it('should allow owner to use any config in runtime path', () => {
      const ownerPeerKey = formatPeerKey('aun', ownerAid);

      // Owner 设置 bypass 和 opus
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: ownerPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          baseagents: {
            claude: {
              model: 'claude-opus-4-8'
            }
          }
        },
        { self: testAgent, peerKey: ownerPeerKey }
      );

      // Owner 应该可以使用
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: ownerPeerKey
      });
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: ownerPeerKey
      }, 'claude');

      expect(mode).toBe('bypass');
      expect(resolved.model).toBe('claude-opus-4-8');
    });

    it('should handle admin correctly in runtime path', () => {
      const adminPeerKey = formatPeerKey('aun', adminAid);

      // Admin 尝试设置 bypass
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: adminPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          baseagents: {
            claude: {
              model: 'claude-sonnet-4-6'
            }
          }
        },
        { self: testAgent, peerKey: adminPeerKey }
      );

      // Admin 应该被降级到 request
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: adminPeerKey
      });
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: adminPeerKey
      }, 'claude');

      expect(mode).toBe('request'); // admin 不能 bypass
      expect(resolved.model).toBe('claude-sonnet-4-6'); // sonnet 允许
    });
  });

  describe('End-to-end runtime verification', () => {
    it('should prevent guest from escalating in full flow', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      // 写入 guest 的配置
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: guestPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          baseagents: {
            claude: {
              model: 'claude-opus-4-8',
              effort: 'high'
            }
          }
        },
        { self: testAgent, peerKey: guestPeerKey }
      );

      // 运行时解析应该应用约束
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: guestPeerKey
      });
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: guestPeerKey
      }, 'claude');

      // 所有配置都应该被降级
      expect(mode).toBe('readonly');
      expect(resolved.model).toBe('claude-haiku-4-5');
      expect(resolved.effort).toBe('low');
    });
  });
});
