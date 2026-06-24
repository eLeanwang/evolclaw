/**
 * Role Constraints Tests
 * 测试角色约束合并逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeWithRoleConstraints,
  isModelAllowedForRole
} from '../src/config/role-constraints.js';
import { clearRolesCache } from '../src/config/roles.js';

describe('Role Constraints', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  describe('permissionMode constraint', () => {
    it('should prevent guest from using bypass', () => {
      const result = mergeWithRoleConstraints('guest', {
        permissionMode: 'bypass'
      });

      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].reason).toBe('override_not_allowed');
      expect(result.violations[0].field).toBe('permissionMode');
      expect(result.effectiveConfig.permissionMode).toBe('readonly');
    });

    it('should prevent member from changing permissionMode', () => {
      const result = mergeWithRoleConstraints('member', {
        permissionMode: 'bypass'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('override_not_allowed');
      expect(result.effectiveConfig.permissionMode).toBe('auto');
    });

    it('should prevent admin from changing permissionMode', () => {
      const result = mergeWithRoleConstraints('admin', {
        permissionMode: 'bypass'
      });

      expect(result.valid).toBe(false);
      expect(result.effectiveConfig.permissionMode).toBe('request');
    });

    it('should prevent owner from changing permissionMode', () => {
      const result = mergeWithRoleConstraints('owner', {
        permissionMode: 'readonly'
      });

      expect(result.valid).toBe(false);
      expect(result.effectiveConfig.permissionMode).toBe('bypass');
    });

    it('should allow if relation config matches role default', () => {
      const result = mergeWithRoleConstraints('guest', {
        permissionMode: 'readonly'
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('model whitelist constraint', () => {
    it('should prevent guest from using opus', () => {
      const result = mergeWithRoleConstraints('guest', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('override_not_allowed');
      expect(result.violations[0].field).toBe('baseagents.claude.model');
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-haiku-4-5');
    });

    it('should prevent guest from using sonnet', () => {
      const result = mergeWithRoleConstraints('guest', {
        'baseagents.claude.model': 'claude-sonnet-4-6'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('override_not_allowed');
    });

    it('should allow guest to use haiku', () => {
      const result = mergeWithRoleConstraints('guest', {
        'baseagents.claude.model': 'claude-haiku-4-5'
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should prevent member from using opus', () => {
      const result = mergeWithRoleConstraints('member', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('model_not_allowed');
    });

    it('should allow member to use sonnet', () => {
      const result = mergeWithRoleConstraints('member', {
        'baseagents.claude.model': 'claude-sonnet-4-6'
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });

    it('should allow member to use haiku', () => {
      const result = mergeWithRoleConstraints('member', {
        'baseagents.claude.model': 'claude-haiku-4-5'
      });

      expect(result.valid).toBe(true);
    });

    it('should allow admin to use opus', () => {
      const result = mergeWithRoleConstraints('admin', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(true);
    });

    it('should allow owner to use any model', () => {
      const result = mergeWithRoleConstraints('owner', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(true);

      const result2 = mergeWithRoleConstraints('owner', {
        'baseagents.claude.model': 'some-future-model'
      });

      expect(result2.valid).toBe(true);
    });

    it('should support wildcard patterns', () => {
      // member 允许 claude-sonnet-* 和 claude-haiku-*
      const sonnetResult = mergeWithRoleConstraints('member', {
        'baseagents.claude.model': 'claude-sonnet-3-5'
      });
      expect(sonnetResult.valid).toBe(true);

      const haikuResult = mergeWithRoleConstraints('member', {
        'baseagents.claude.model': 'claude-haiku-3-0'
      });
      expect(haikuResult.valid).toBe(true);
    });
  });

  describe('dispatch constraint', () => {
    it('should prevent member from using broadcast', () => {
      const result = mergeWithRoleConstraints('member', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('override_not_allowed');
      expect(result.effectiveConfig.dispatch).toBe('mention');
    });

    it('should prevent guest from changing dispatch', () => {
      const result = mergeWithRoleConstraints('guest', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(false);
      expect(result.effectiveConfig.dispatch).toBe('mention');
    });

    it('should allow admin to use mention', () => {
      const result = mergeWithRoleConstraints('admin', {
        dispatch: 'mention'
      });

      expect(result.valid).toBe(true);
    });

    it('should prevent admin from using broadcast due to allowedValues', () => {
      const result = mergeWithRoleConstraints('admin', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('value_not_allowed');
    });

    it('should allow owner to use broadcast', () => {
      const result = mergeWithRoleConstraints('owner', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('chatmode constraint', () => {
    it('should prevent guest from overriding chatmode', () => {
      const result = mergeWithRoleConstraints('guest', {
        chatmode: {
          private: 'interactive',
          group: 'proactive'
        }
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('chatmode');
      expect(result.effectiveConfig.chatmode.private).toBe('proactive');
    });

    it('should allow owner to customize chatmode', () => {
      const result = mergeWithRoleConstraints('owner', {
        chatmode: {
          private: 'proactive',
          group: 'interactive'
        }
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.chatmode.private).toBe('proactive');
    });

    it('should allow member to customize chatmode', () => {
      const result = mergeWithRoleConstraints('member', {
        chatmode: {
          private: 'proactive'
        }
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('multiple violations', () => {
    it('should record all violations', () => {
      const result = mergeWithRoleConstraints('guest', {
        permissionMode: 'bypass',
        'baseagents.claude.model': 'claude-opus-4-8',
        dispatch: 'broadcast',
        chatmode: { private: 'interactive' }
      });

      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(1);

      const fields = result.violations.map(v => v.field);
      expect(fields).toContain('permissionMode');
      expect(fields).toContain('baseagents.claude.model');
    });

    it('should apply defaults for all violated fields', () => {
      const result = mergeWithRoleConstraints('guest', {
        permissionMode: 'bypass',
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.effectiveConfig.permissionMode).toBe('readonly');
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-haiku-4-5');
    });
  });

  describe('undefined fields', () => {
    it('should use role defaults when relation config is empty', () => {
      const result = mergeWithRoleConstraints('owner', {});

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.permissionMode).toBe('bypass');
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-opus-4-8');
    });

    it('should preserve undefined fields not in role definition', () => {
      const result = mergeWithRoleConstraints('owner', {
        customField: 'custom-value'
      });

      expect(result.effectiveConfig.customField).toBe('custom-value');
    });
  });

  describe('isModelAllowedForRole', () => {
    it('should check owner can use any model', () => {
      expect(isModelAllowedForRole('owner', 'claude-opus-4-8')).toBe(true);
      expect(isModelAllowedForRole('owner', 'future-model')).toBe(true);
    });

    it('should check admin can use opus/sonnet/haiku', () => {
      expect(isModelAllowedForRole('admin', 'claude-opus-4-8')).toBe(true);
      expect(isModelAllowedForRole('admin', 'claude-sonnet-4-6')).toBe(true);
      expect(isModelAllowedForRole('admin', 'claude-haiku-4-5')).toBe(true);
    });

    it('should check member can only use sonnet/haiku', () => {
      expect(isModelAllowedForRole('member', 'claude-opus-4-8')).toBe(false);
      expect(isModelAllowedForRole('member', 'claude-sonnet-4-6')).toBe(true);
      expect(isModelAllowedForRole('member', 'claude-haiku-4-5')).toBe(true);
    });

    it('should check guest can only use haiku', () => {
      expect(isModelAllowedForRole('guest', 'claude-opus-4-8')).toBe(false);
      expect(isModelAllowedForRole('guest', 'claude-sonnet-4-6')).toBe(false);
      expect(isModelAllowedForRole('guest', 'claude-haiku-4-5')).toBe(true);
    });
  });

  describe('unknown role fallback', () => {
    it('should fallback to member for unknown role', () => {
      const result = mergeWithRoleConstraints('unknown-role', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      // member 不能使用 opus
      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('model_not_allowed');
    });
  });

  describe('edge cases', () => {
    it('should handle null values', () => {
      const result = mergeWithRoleConstraints('owner', {
        permissionMode: null as any
      });

      expect(result.valid).toBe(false); // null !== 'bypass'
      expect(result.effectiveConfig.permissionMode).toBe('bypass');
    });

    it('should handle undefined values', () => {
      const result = mergeWithRoleConstraints('owner', {
        permissionMode: undefined
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.permissionMode).toBe('bypass');
    });

    it('should handle nested objects correctly', () => {
      const result = mergeWithRoleConstraints('owner', {
        chatmode: {
          private: 'interactive',
          group: 'proactive',
          nothuman: 'proactive'
        }
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.chatmode).toEqual({
        private: 'interactive',
        group: 'proactive',
        nothuman: 'proactive'
      });
    });
  });
});
