/**
 * 角色系统第三轮修复验证测试
 * 验证 P0-1 (ConfigManager sel.role) 和 P0-2 (member 角色集成)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveEffective, write, ensureFile, ConfigTarget } from '../src/config/config-manager.js';
import { formatPeerKey } from '../src/core/relation/peer-identity.js';
import type { AgentConfig } from '../src/types.js';

describe('Role System Third Round Fixes', () => {
  const testAgent = 'fix3-test.agentid.pub';
  const ownerAid = 'owner.aid.pub';
  const memberAid = 'member.aid.pub';
  const guestAid = 'guest.aid.pub';

  beforeEach(() => {
    const config: Partial<AgentConfig> = {
      aid: testAgent,
      channels: [],
      owners: [ownerAid],
      admins: ['admin.aid.pub'],
      members: [memberAid]
    };
    ensureFile(ConfigTarget.Agent, { self: testAgent });
    write(ConfigTarget.Agent, config, { self: testAgent });
  });

  describe('P0-1: ConfigManager resolveEffective 应优先使用 sel.role', () => {
    it('should use sel.role in group chat for dispatch', () => {
      const groupPeerKey = 'aun#group_conversation_123';

      // 写入 owner 的关系配置
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: groupPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        { dispatch: 'broadcast' },
        { self: testAgent, peerKey: groupPeerKey }
      );

      // 传入 sel.role = 'owner'（群聊场景）
      const effective = resolveEffective({
        self: testAgent,
        peerKey: groupPeerKey,
        role: 'owner'
      });

      // Owner 应该能使用 broadcast
      expect(effective.dispatch).toBe('broadcast');
    });

    it('should use sel.role for chatmode in non-AUN channel', () => {
      const feishuPeerKey = 'feishu#ou_user_12345';

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: feishuPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          chatmode: {
            private: 'proactive'
          }
        },
        { self: testAgent, peerKey: feishuPeerKey }
      );

      // 传入 sel.role = 'owner'（Feishu 场景）
      const effective = resolveEffective({
        self: testAgent,
        peerKey: feishuPeerKey,
        role: 'owner'
      });

      // Owner 应该能使用自定义 chatmode
      expect(effective.chatmode?.private).toBe('proactive');
    });

    it('should apply guest constraints when sel.role is guest in group chat', () => {
      const groupPeerKey = 'aun#group_another';

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: groupPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          dispatch: 'broadcast',
          baseagents: {
            claude: {
              model: 'claude-opus-4-8'
            }
          }
        },
        { self: testAgent, peerKey: groupPeerKey }
      );

      // 传入 sel.role = 'guest'（群聊中的 guest）
      const effective = resolveEffective({
        self: testAgent,
        peerKey: groupPeerKey,
        role: 'guest'
      });

      // Guest 应该被约束
      expect(effective.dispatch).toBe('mention'); // guest 默认
      expect(effective.baseagents?.claude?.model).toBe('claude-haiku-4-5');
    });

    it('should fallback to resolveUserRole when sel.role is missing', () => {
      const memberPeerKey = formatPeerKey('aun', memberAid);

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

      // 不传 sel.role，应该从 peerKey 推导
      const effective = resolveEffective({
        self: testAgent,
        peerKey: memberPeerKey
      });

      // Member 不能用 opus
      expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('P0-2: Member 角色应完整集成到运行时', () => {
    it('should recognize member in role resolution', () => {
      const memberPeerKey = formatPeerKey('aun', memberAid);

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: memberPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          baseagents: {
            claude: {
              model: 'claude-sonnet-4-6' // Member 允许的模型
            }
          }
        },
        { self: testAgent, peerKey: memberPeerKey }
      );

      const effective = resolveEffective({
        self: testAgent,
        peerKey: memberPeerKey,
        role: 'member'
      });

      // Member 应该被约束到 auto，不能 bypass
      expect(effective.permissionMode).toBe('auto');
      // Sonnet 允许
      expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });

    it('should apply member defaults correctly', () => {
      const memberPeerKey = formatPeerKey('aun', memberAid);

      // Member 没有关系配置
      const effective = resolveEffective({
        self: testAgent,
        peerKey: memberPeerKey,
        role: 'member'
      });

      // 应该应用 member 默认值
      expect(effective.permissionMode).toBe('auto');
      expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
      expect(effective.dispatch).toBe('mention');
    });

    it('should rank member between admin and guest', () => {
      // 这个测试验证 member 在优先级中的位置
      // Member 应该高于 guest，低于 admin

      const memberPeerKey = formatPeerKey('aun', memberAid);
      const guestPeerKey = formatPeerKey('aun', guestAid);

      // Member 尝试用 sonnet
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: memberPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          baseagents: {
            claude: {
              model: 'claude-sonnet-4-6'
            }
          }
        },
        { self: testAgent, peerKey: memberPeerKey }
      );

      // Guest 尝试用 sonnet
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: guestPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          baseagents: {
            claude: {
              model: 'claude-sonnet-4-6'
            }
          }
        },
        { self: testAgent, peerKey: guestPeerKey }
      );

      const memberEffective = resolveEffective({
        self: testAgent,
        peerKey: memberPeerKey,
        role: 'member'
      });
      const guestEffective = resolveEffective({
        self: testAgent,
        peerKey: guestPeerKey,
        role: 'guest'
      });

      // Member 可以用 sonnet
      expect(memberEffective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
      // Guest 不能用 sonnet
      expect(guestEffective.baseagents?.claude?.model).toBe('claude-haiku-4-5');
    });
  });

  describe('Integration: Both fixes working together', () => {
    it('should handle member in group chat correctly', () => {
      const groupPeerKey = 'aun#group_team_chat';

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: groupPeerKey
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          dispatch: 'broadcast',
          baseagents: {
            claude: {
              model: 'claude-sonnet-4-6'
            }
          }
        },
        { self: testAgent, peerKey: groupPeerKey }
      );

      // Member 在群聊，传入 role
      const effective = resolveEffective({
        self: testAgent,
        peerKey: groupPeerKey,
        role: 'member'
      });

      // Member 应该被正确约束
      expect(effective.permissionMode).toBe('auto');
      expect(effective.dispatch).toBe('mention');
      expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });

    it('should handle all five roles correctly', () => {
      const testPeerKey = 'aun#test_all_roles';

      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: testPeerKey
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
        { self: testAgent, peerKey: testPeerKey }
      );

      const roles = ['owner', 'admin', 'member', 'guest', 'anonymous'] as const;
      const results = roles.map(role => ({
        role,
        effective: resolveEffective({
          self: testAgent,
          peerKey: testPeerKey,
          role
        })
      }));

      // Owner - 完全控制
      expect(results[0].effective.permissionMode).toBe('bypass');
      expect(results[0].effective.baseagents?.claude?.model).toBe('claude-opus-4-8');

      // Admin - 需要确认，可以用 opus
      expect(results[1].effective.permissionMode).toBe('request');
      expect(results[1].effective.baseagents?.claude?.model).toBe('claude-opus-4-8');

      // Member - 自动模式，只能 sonnet
      expect(results[2].effective.permissionMode).toBe('auto');
      expect(results[2].effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');

      // Guest - 只读，只能 haiku
      expect(results[3].effective.permissionMode).toBe('readonly');
      expect(results[3].effective.baseagents?.claude?.model).toBe('claude-haiku-4-5');

      // Anonymous - 只读，只能 haiku
      expect(results[4].effective.permissionMode).toBe('readonly');
      expect(results[4].effective.baseagents?.claude?.model).toBe('claude-haiku-4-5');
    });
  });
});
