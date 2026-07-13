/**
 * Role Constraints Tests
 * 测试角色约束合并逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeWithRoleConstraints,
  isModelAllowedForRole,
  isModelAllowedByPatterns
} from '../src/config/role-constraints.js';
import { clearRolesCache } from '../src/config/roles.js';

describe('Role Constraints', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  describe('permissionMode constraint', () => {
    it('should prevent visitor from using bypass', () => {
      const result = mergeWithRoleConstraints('visitor', {
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
      const result = mergeWithRoleConstraints('visitor', {
        permissionMode: 'readonly'
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('model configuration', () => {
    it('should preserve visitor model configuration', () => {
      const result = mergeWithRoleConstraints('visitor', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-opus-4-8');
    });

    it('should preserve visitor sonnet configuration', () => {
      const result = mergeWithRoleConstraints('visitor', {
        'baseagents.claude.model': 'claude-sonnet-4-6'
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-sonnet-4-6');
    });

    it('should allow visitor to use haiku', () => {
      const result = mergeWithRoleConstraints('visitor', {
        'baseagents.claude.model': 'claude-haiku-4-5-20251001'
      });

      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should preserve member opus configuration', () => {
      const result = mergeWithRoleConstraints('member', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-opus-4-8');
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
        'baseagents.claude.model': 'claude-haiku-4-5-20251001'
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

  describe('dispatch configuration', () => {
    it('should preserve member broadcast', () => {
      const result = mergeWithRoleConstraints('member', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.dispatch).toBe('broadcast');
    });

    it('should preserve visitor dispatch', () => {
      const result = mergeWithRoleConstraints('visitor', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.dispatch).toBe('broadcast');
    });

    it('should allow admin to use mention', () => {
      const result = mergeWithRoleConstraints('admin', {
        dispatch: 'mention'
      });

      expect(result.valid).toBe(true);
    });

    it('should preserve admin broadcast', () => {
      const result = mergeWithRoleConstraints('admin', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.dispatch).toBe('broadcast');
    });

    it('should allow owner to use broadcast', () => {
      const result = mergeWithRoleConstraints('owner', {
        dispatch: 'broadcast'
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('chatmode constraint', () => {
    it('should preserve visitor chatmode', () => {
      const result = mergeWithRoleConstraints('visitor', {
        chatmode: {
          private: 'interactive',
          group: 'proactive'
        }
      });

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.chatmode.private).toBe('interactive');
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
    it('should only report permission mode violations', () => {
      const result = mergeWithRoleConstraints('visitor', {
        permissionMode: 'bypass',
        'baseagents.claude.model': 'claude-opus-4-8',
        dispatch: 'broadcast',
        chatmode: { private: 'interactive' }
      });

      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);

      const fields = result.violations.map(v => v.field);
      expect(fields).toContain('permissionMode');
      expect(fields).not.toContain('baseagents.claude.model');
    });

    it('should apply only the permission mode default', () => {
      const result = mergeWithRoleConstraints('visitor', {
        permissionMode: 'bypass',
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.effectiveConfig.permissionMode).toBe('readonly');
      expect(result.effectiveConfig.baseagents?.claude?.model).toBe('claude-opus-4-8');
    });
  });

  describe('undefined fields', () => {
    it('should use only the role permission default when relation config is empty', () => {
      const result = mergeWithRoleConstraints('owner', {});

      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.permissionMode).toBe('bypass');
      expect(result.effectiveConfig.baseagents?.claude?.model).toBeUndefined();
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
      expect(isModelAllowedForRole('admin', 'claude-haiku-4-5-20251001')).toBe(true);
    });

    it('should allow member to use any configured model', () => {
      expect(isModelAllowedForRole('member', 'claude-opus-4-8')).toBe(true);
      expect(isModelAllowedForRole('member', 'claude-sonnet-4-6')).toBe(true);
      expect(isModelAllowedForRole('member', 'claude-haiku-4-5-20251001')).toBe(true);
    });

    it('should allow visitor to use any configured model', () => {
      expect(isModelAllowedForRole('visitor', 'claude-opus-4-8')).toBe(true);
      expect(isModelAllowedForRole('visitor', 'claude-sonnet-4-6')).toBe(true);
      expect(isModelAllowedForRole('visitor', 'claude-haiku-4-5-20251001')).toBe(true);
    });

    it('should reject unknown roles', () => {
      expect(isModelAllowedForRole('unknown-role', 'claude-opus-4-8')).toBe(false);
      expect(isModelAllowedForRole('unknown-role', 'claude-sonnet-4-6')).toBe(false);
      expect(isModelAllowedForRole('unknown-role', 'claude-haiku-4-5-20251001')).toBe(false);
    });
  });

  describe('isModelAllowedByPatterns', () => {
    it('should match wildcard, prefix patterns, and exact model ids', () => {
      expect(isModelAllowedByPatterns('future-model', ['*'])).toBe(true);
      expect(isModelAllowedByPatterns('claude-sonnet-4-6', ['claude-sonnet-*'])).toBe(true);
      expect(isModelAllowedByPatterns('claude-opus-4-8', ['claude-sonnet-*'])).toBe(false);
      expect(isModelAllowedByPatterns('claude-haiku-4-5-20251001', ['claude-haiku-4-5-20251001'])).toBe(true);
    });
  });

  describe('unknown role fallback', () => {
    it('should fail closed for unknown role', () => {
      const result = mergeWithRoleConstraints('unknown-role', {
        'baseagents.claude.model': 'claude-opus-4-8'
      });

      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('override_not_allowed');
      expect(result.effectiveConfig).toEqual({});
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
