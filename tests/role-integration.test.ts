/**
 * Role System Integration Tests
 * 测试角色系统在完整配置链路中的工作
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveEffective,
  validateConfigWrite,
  write,
  ensureFile,
  ConfigTarget
} from '../src/config/config-manager.js';
import type { AgentConfig } from '../src/types.js';

describe('Role System Integration', () => {
  const testAgent = 'integration-test.agentid.pub';

  beforeEach(() => {
    // 创建测试 agent 配置
    const config: Partial<AgentConfig> = {
      aid: testAgent,
      channels: [],
      owners: ['alice.aid.pub'],
      admins: ['bob.aid.pub'],
      members: ['charlie.aid.pub']
    };
    ensureFile(ConfigTarget.Agent, { self: testAgent });
    write(ConfigTarget.Agent, config, { self: testAgent });
  });

  describe('resolveEffective with role constraints', () => {
    it('should apply role constraints for guest trying to escalate permission', () => {
      // guest 尝试设置 bypass
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: 'guest.aid.pub'
      });
      write(
        ConfigTarget.RelationBehavior,
        { permissionMode: 'bypass' },
        { self: testAgent, peerKey: 'guest.aid.pub' }
      );

      const effective = resolveEffective({
        self: testAgent,
        peerKey: 'guest.aid.pub'
      });

      // 应该被降级到 readonly
      expect(effective.permissionMode).toBe('readonly');
    });

    it('should allow owner to use any config', () => {
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: 'alice.aid.pub'
      });
      write(
        ConfigTarget.RelationBehavior,
        {
          permissionMode: 'bypass',
          dispatch: 'broadcast'
        },
        { self: testAgent, peerKey: 'alice.aid.pub' }
      );

      const effective = resolveEffective({
        self: testAgent,
        peerKey: 'alice.aid.pub'
      });

      expect(effective.permissionMode).toBe('bypass');
      expect(effective.dispatch).toBe('broadcast');
    });

    it('should enforce model whitelist for member', () => {
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: 'charlie.aid.pub'
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
        { self: testAgent, peerKey: 'charlie.aid.pub' }
      );

      const effective = resolveEffective({
        self: testAgent,
        peerKey: 'charlie.aid.pub'
      });

      // member 不能使用 opus，应该降级到角色默认
      expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });

    it('should allow member to use sonnet', () => {
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey: 'charlie.aid.pub'
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
        { self: testAgent, peerKey: 'charlie.aid.pub' }
      );

      const effective = resolveEffective({
        self: testAgent,
        peerKey: 'charlie.aid.pub'
      });

      expect(effective.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });

    it('should not apply constraints when peerKey is missing', () => {
      // 没有 peerKey，不应用角色约束
      const effective = resolveEffective({
        self: testAgent
      });

      // 应该返回正常配置，不报错
      expect(effective.aid).toBe(testAgent);
    });
  });

  describe('validateConfigWrite', () => {
    it('should prevent guest from writing bypass permission', () => {
      const result = validateConfigWrite(
        ConfigTarget.RelationBehavior,
        { permissionMode: 'bypass' },
        { self: testAgent, peerKey: 'guest.aid.pub' }
      );

      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].field).toBe('permissionMode');
    });

    it('should allow owner to write any config', () => {
      const result = validateConfigWrite(
        ConfigTarget.RelationBehavior,
        { permissionMode: 'bypass', dispatch: 'broadcast' },
        { self: testAgent, peerKey: 'alice.aid.pub' }
      );

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should not validate non-behavior targets', () => {
      const result = validateConfigWrite(
        ConfigTarget.Agent,
        { anything: 'value' },
        { self: testAgent }
      );

      expect(result.valid).toBe(true);
    });

    it('should require self and peerKey for RelationBehavior', () => {
      expect(() => {
        validateConfigWrite(
          ConfigTarget.RelationBehavior,
          { permissionMode: 'bypass' },
          { self: testAgent }
        );
      }).toThrow('RelationBehavior requires self and peerKey');
    });
  });

  describe('end-to-end scenarios', () => {
    it('should handle complete workflow: write -> resolve -> validate', () => {
      const peerKey = 'workflow-test.aid.pub';

      // 1. 写入配置（member 尝试使用 opus）
      ensureFile(ConfigTarget.RelationBehavior, {
        self: testAgent,
        peerKey
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
        { self: testAgent, peerKey }
      );

      // 2. 解析配置（应该被约束）
      const effective = resolveEffective({
        self: testAgent,
        peerKey
      });

      // member 不能使用 opus
      expect(effective.baseagents?.claude?.model).not.toBe('claude-opus-4-8');

      // 3. 验证写入
      const validation = validateConfigWrite(
        ConfigTarget.RelationBehavior,
        { 'baseagents.claude.model': 'claude-opus-4-8' },
        { self: testAgent, peerKey }
      );

      expect(validation.valid).toBe(false);
    });

    it('should respect role hierarchy: owner > admin > member > guest', () => {
      const testCases = [
        { peerKey: 'alice.aid.pub', role: 'owner', canBypass: true },
        { peerKey: 'bob.aid.pub', role: 'admin', canBypass: false },
        { peerKey: 'charlie.aid.pub', role: 'member', canBypass: false },
        { peerKey: 'stranger.aid.pub', role: 'guest', canBypass: false }
      ];

      for (const { peerKey, role, canBypass } of testCases) {
        ensureFile(ConfigTarget.RelationBehavior, {
          self: testAgent,
          peerKey
        });
        write(
          ConfigTarget.RelationBehavior,
          { permissionMode: 'bypass' },
          { self: testAgent, peerKey }
        );

        const effective = resolveEffective({
          self: testAgent,
          peerKey
        });

        if (canBypass) {
          expect(effective.permissionMode).toBe('bypass');
        } else {
          expect(effective.permissionMode).not.toBe('bypass');
        }
      }
    });
  });

  describe('error handling', () => {
    it('should handle missing agent config gracefully', () => {
      const effective = resolveEffective({
        self: 'non-existent-agent.aid.pub',
        peerKey: 'user.aid.pub'
      });

      // 应该返回配置，不应该抛出错误
      expect(effective).toBeDefined();
    });

    it('should handle invalid role gracefully', () => {
      // 创建一个没有在任何列表中的用户
      const effective = resolveEffective({
        self: testAgent,
        peerKey: 'unknown-user'  // 未认证，anonymous
      });

      // 应该应用 anonymous 角色的约束
      expect(effective.permissionMode).toBe('readonly');
    });
  });
});
