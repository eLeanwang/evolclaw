/**
 * 角色系统第二轮修复验证测试
 * 验证 P0-1, P0-2, P1-1, P1-2 的修复
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePermissionMode, resolveEffectiveModel } from '../src/core/model/config-scope.js';
import { write, ensureFile, ConfigTarget, validateConfigWrite } from '../src/config/config-manager.js';
import { formatPeerKey } from '../src/core/relation/peer-identity.js';
import type { AgentConfig } from '../src/types.js';

describe('Role System Second Round Fixes', () => {
  const testAgent = 'fix2-test.agentid.pub';
  const adminAid = 'admin.aid.pub';
  const guestAid = 'guest.aid.pub';

  beforeEach(() => {
    const config: Partial<AgentConfig> = {
      aid: testAgent,
      channels: [],
      owners: ['owner.aid.pub'],
      admins: [adminAid],
      members: ['member.aid.pub']
    };
    ensureFile(ConfigTarget.Agent, { self: testAgent });
    write(ConfigTarget.Agent, config, { self: testAgent });
  });

  describe('P0-1: Admin 默认权限应该是 request', () => {
    it('should return request for admin without relation config', () => {
      const adminPeerKey = formatPeerKey('aun', adminAid);

      // Admin 没有关系级配置
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: adminPeerKey,
        role: 'admin'
      });

      // 应该是 request，不是 bypass
      expect(mode).toBe('request');
    });

    it('should return request for admin fallback', () => {
      // 使用内置默认值
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: 'aun#admin.aid.pub',
        role: 'admin'
      });

      expect(mode).toBe('request');
    });
  });

  describe('P0-2: 优先使用 sel.role，避免重新计算', () => {
    it('should use sel.role instead of recalculating from peerKey', () => {
      const groupPeerKey = 'aun#group_12345'; // 群聊 peerKey

      // 写入 owner 的关系配置（但 peerKey 是 groupId）
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: groupPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        { permissionMode: 'bypass' },
        { self: testAgent, peerKey: groupPeerKey }
      );

      // 传入 sel.role = 'owner'
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: groupPeerKey,
        role: 'owner'
      });

      // 应该使用 sel.role='owner'，允许 bypass
      expect(mode).toBe('bypass');
    });

    it('should use sel.role for model constraints', () => {
      const feishuPeerKey = 'feishu#ou_xxxxx'; // Feishu 原生用户 ID

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: feishuPeerKey
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
        { self: testAgent, peerKey: feishuPeerKey }
      );

      // 传入 sel.role = 'guest'
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: feishuPeerKey,
        role: 'guest'
      }, 'claude');

      // 应该使用 sel.role='guest'，降级到 haiku
      expect(resolved.model).toBe('claude-haiku-4-5');
    });

    it('should fallback to resolveUserRole when sel.role is missing', () => {
      const adminPeerKey = formatPeerKey('aun', adminAid);

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: adminPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        { permissionMode: 'bypass' },
        { self: testAgent, peerKey: adminPeerKey }
      );

      // 不传 sel.role，应该从 peerKey 推导
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: adminPeerKey
      });

      // admin 不能 bypass
      expect(mode).toBe('request');
    });
  });

  describe('P1-1: 模型约束应覆盖 fallback', () => {
    it('should apply role default when no relation config exists', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      // Guest 没有任何关系级配置，会使用 agent fallback

      // 传入 sel.role = 'guest'
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: guestPeerKey,
        role: 'guest'
      }, 'claude');

      // 即使没有关系级配置，guest 也应该受限到 haiku
      expect(resolved.model).toBe('claude-haiku-4-5');
      expect(resolved.effort).toBe('low');
    });

    it('should apply role default for empty model', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      // 写入空的关系配置
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: guestPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        { chatmode: { private: 'proactive' } }, // 其他字段，没有 model
        { self: testAgent, peerKey: guestPeerKey }
      );

      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: guestPeerKey,
        role: 'guest'
      }, 'claude');

      // 应该应用角色默认
      expect(resolved.model).toBe('claude-haiku-4-5');
    });
  });

  describe('P1-2: 写入校验应支持嵌套配置', () => {
    it('should validate nested config structure', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      // 使用真实的嵌套结构（不是扁平键）
      const validation = validateConfigWrite(
        ConfigTarget.RelationBehavior,
        {
          baseagents: {
            claude: {
              model: 'claude-opus-4-8'
            }
          }
        },
        { self: testAgent, peerKey: guestPeerKey }
      );

      // 应该检测到 model 违规
      expect(validation.valid).toBe(false);
      expect(validation.violations.length).toBeGreaterThan(0);
      const modelViolation = validation.violations.find(v => v.field === 'baseagents.claude.model');
      expect(modelViolation).toBeDefined();
    });

    it('should validate nested permissionMode', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      const validation = validateConfigWrite(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          baseagents: {
            claude: {
              model: 'claude-haiku-4-5' // 允许的模型
            }
          }
        },
        { self: testAgent, peerKey: guestPeerKey }
      );

      // 应该检测到 permissionMode 违规，但 model 应该没问题
      expect(validation.valid).toBe(false);
      const modeViolation = validation.violations.find(v => v.field === 'permissionMode');
      expect(modeViolation).toBeDefined();
    });

    it('should validate deeply nested config', () => {
      const guestPeerKey = formatPeerKey('aun', guestAid);

      const validation = validateConfigWrite(
        ConfigTarget.RelationBehavior,
        {
          baseagents: {
            claude: {
              model: 'claude-opus-4-8',
              effort: 'high'
            },
            codex: {
              model: 'some-model'
            }
          }
        },
        { self: testAgent, peerKey: guestPeerKey }
      );

      // 应该检测到多个违规
      expect(validation.valid).toBe(false);
      expect(validation.violations.length).toBeGreaterThan(0);
    });
  });

  describe('Integration: All fixes working together', () => {
    it('should handle admin in group chat correctly', () => {
      const groupPeerKey = 'aun#group_conversation';

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: groupPeerKey
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
        { self: testAgent, peerKey: groupPeerKey }
      );

      // Admin 在群聊，传入 role
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: groupPeerKey,
        role: 'admin'
      });
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: groupPeerKey,
        role: 'admin'
      }, 'claude');

      // Admin 应该被正确约束
      expect(mode).toBe('request'); // 不是 bypass
      expect(resolved.model).toBe('claude-opus-4-8'); // opus 允许
    });

    it('should handle guest without any config', () => {
      const guestPeerKey = formatPeerKey('aun', 'unknown.aid.pub');

      // 完全没有配置
      const mode = resolvePermissionMode({
        self: testAgent,
        peerKey: guestPeerKey,
        role: 'guest'
      });
      const resolved = resolveEffectiveModel({
        self: testAgent,
        peerKey: guestPeerKey,
        role: 'guest'
      }, 'claude');

      // 应该应用角色默认
      expect(mode).toBe('readonly');
      expect(resolved.model).toBe('claude-haiku-4-5');
      expect(resolved.effort).toBe('low');
    });
  });
});
