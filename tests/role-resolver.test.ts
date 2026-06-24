/**
 * Role Resolver Tests
 * 测试角色解析逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveUserRole, isAuthenticated, resolveUserRoles } from '../src/config/role-resolver.js';
import { write, ensureFile, ConfigTarget } from '../src/config/config-manager.js';
import type { AgentConfig } from '../src/types.js';

describe('Role Resolver', () => {
  const testAgent = 'test-agent.agentid.pub';

  beforeEach(() => {
    // 创建测试 agent 配置
    const config: Partial<AgentConfig> = {
      aid: testAgent,
      channels: [],
      owners: ['alice.aid.pub', 'bob.agentid.pub'],
      admins: ['charlie.aid.pub'],
      members: ['dave.aid.pub', 'eve.agentid.pub']
    };
    ensureFile(ConfigTarget.Agent, { self: testAgent });
    write(ConfigTarget.Agent, config, { self: testAgent });
  });

  describe('resolveUserRole', () => {
    it('should resolve owner role', () => {
      const role = resolveUserRole(testAgent, 'alice.aid.pub');
      expect(role).toBe('owner');
    });

    it('should resolve owner role (agentid format)', () => {
      const role = resolveUserRole(testAgent, 'bob.agentid.pub');
      expect(role).toBe('owner');
    });

    it('should resolve admin role', () => {
      const role = resolveUserRole(testAgent, 'charlie.aid.pub');
      expect(role).toBe('admin');
    });

    it('should resolve member role', () => {
      const role = resolveUserRole(testAgent, 'dave.aid.pub');
      expect(role).toBe('member');
    });

    it('should resolve member role (agentid format)', () => {
      const role = resolveUserRole(testAgent, 'eve.agentid.pub');
      expect(role).toBe('member');
    });

    it('should resolve guest role for authenticated but unauthorized user', () => {
      const role = resolveUserRole(testAgent, 'stranger.aid.pub');
      expect(role).toBe('guest');
    });

    it('should resolve anonymous role for unauthenticated user', () => {
      const role = resolveUserRole(testAgent, 'unknown-user');
      expect(role).toBe('anonymous');
    });

    it('should resolve anonymous role for invalid AID format', () => {
      const role = resolveUserRole(testAgent, 'user@example.com');
      expect(role).toBe('anonymous');
    });

    it('should handle missing agent config gracefully', () => {
      const role = resolveUserRole('non-existent.aid.pub', 'alice.aid.pub');
      expect(role).toBe('anonymous'); // 安全降级
    });

    it('should prioritize owners over admins', () => {
      // 添加一个用户到多个列表
      const config: Partial<AgentConfig> = {
        aid: testAgent,
        channels: [],
        owners: ['multi.aid.pub'],
        admins: ['multi.aid.pub'],  // 同时在 admins 列表
        members: []
      };
      write(ConfigTarget.Agent, config, { self: testAgent });

      const role = resolveUserRole(testAgent, 'multi.aid.pub');
      expect(role).toBe('owner'); // owners 优先级最高
    });

    it('should prioritize admins over members', () => {
      const config: Partial<AgentConfig> = {
        aid: testAgent,
        channels: [],
        owners: [],
        admins: ['multi.aid.pub'],
        members: ['multi.aid.pub']  // 同时在 members 列表
      };
      write(ConfigTarget.Agent, config, { self: testAgent });

      const role = resolveUserRole(testAgent, 'multi.aid.pub');
      expect(role).toBe('admin'); // admins 优先级高于 members
    });

    it('should prioritize members over guest', () => {
      const config: Partial<AgentConfig> = {
        aid: testAgent,
        channels: [],
        owners: [],
        admins: [],
        members: ['member.aid.pub']
      };
      write(ConfigTarget.Agent, config, { self: testAgent });

      const role = resolveUserRole(testAgent, 'member.aid.pub');
      expect(role).toBe('member'); // members 优先于 guest
    });
  });

  describe('isAuthenticated', () => {
    it('should recognize .aid.pub format as authenticated', () => {
      expect(isAuthenticated('user.aid.pub')).toBe(true);
      expect(isAuthenticated('test-user.aid.pub')).toBe(true);
      expect(isAuthenticated('user_123.aid.pub')).toBe(true);
    });

    it('should recognize .agentid.pub format as authenticated', () => {
      expect(isAuthenticated('user.agentid.pub')).toBe(true);
      expect(isAuthenticated('test-agent.agentid.pub')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(isAuthenticated('user@example.com')).toBe(false);
      expect(isAuthenticated('username')).toBe(false);
      expect(isAuthenticated('user.com')).toBe(false);
      expect(isAuthenticated('user.aid.com')).toBe(false);
      expect(isAuthenticated('')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isAuthenticated('User.AID.PUB')).toBe(true);
      expect(isAuthenticated('USER.AGENTID.PUB')).toBe(true);
    });

    it('should accept hyphens and underscores in username', () => {
      expect(isAuthenticated('user-name.aid.pub')).toBe(true);
      expect(isAuthenticated('user_name.aid.pub')).toBe(true);
      expect(isAuthenticated('user-name_123.aid.pub')).toBe(true);
    });
  });

  describe('resolveUserRoles', () => {
    it('should resolve multiple users correctly', () => {
      const users = [
        'alice.aid.pub',      // owner
        'charlie.aid.pub',    // admin
        'dave.aid.pub',       // member
        'stranger.aid.pub',   // guest
        'anonymous-user'      // anonymous
      ];

      const roles = resolveUserRoles(testAgent, users);

      expect(roles.get('alice.aid.pub')).toBe('owner');
      expect(roles.get('charlie.aid.pub')).toBe('admin');
      expect(roles.get('dave.aid.pub')).toBe('member');
      expect(roles.get('stranger.aid.pub')).toBe('guest');
      expect(roles.get('anonymous-user')).toBe('anonymous');
    });

    it('should return empty map for empty user list', () => {
      const roles = resolveUserRoles(testAgent, []);
      expect(roles.size).toBe(0);
    });

    it('should handle single user', () => {
      const roles = resolveUserRoles(testAgent, ['alice.aid.pub']);
      expect(roles.size).toBe(1);
      expect(roles.get('alice.aid.pub')).toBe('owner');
    });
  });

  describe('Edge Cases', () => {
    it('should handle agent with no role lists', () => {
      const emptyAgent = 'empty-agent.aid.pub';
      const config: Partial<AgentConfig> = {
        aid: emptyAgent,
        channels: []
        // 没有 owners/admins/members
      };
      ensureFile(ConfigTarget.Agent, { self: emptyAgent });
      write(ConfigTarget.Agent, config, { self: emptyAgent });

      const role = resolveUserRole(emptyAgent, 'user.aid.pub');
      expect(role).toBe('guest'); // 已认证但未授权
    });

    it('should handle empty role lists', () => {
      const emptyAgent = 'empty-lists.aid.pub';
      const config: Partial<AgentConfig> = {
        aid: emptyAgent,
        channels: [],
        owners: [],
        admins: [],
        members: []
      };
      ensureFile(ConfigTarget.Agent, { self: emptyAgent });
      write(ConfigTarget.Agent, config, { self: emptyAgent });

      const role = resolveUserRole(emptyAgent, 'user.aid.pub');
      expect(role).toBe('guest');
    });
  });
});
