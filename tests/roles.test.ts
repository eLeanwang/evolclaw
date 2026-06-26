/**
 * Role Configuration Tests
 * 测试角色配置的读取、缓存和查询功能
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readRolesConfig,
  getRoleDefinition,
  getFieldPermission,
  clearRolesCache,
  getBuiltinRolesConfig
} from '../src/config/roles.js';

describe('Role Configuration', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  describe('readRolesConfig', () => {
    it('should return builtin config when file does not exist', () => {
      const config = readRolesConfig();
      expect(config).toBeDefined();
      expect(config.$schema_version).toBe(2);
      expect(config.defaultRole).toBe('anonymous');
      expect(config.roles).toBeDefined();
    });

    it('should have all five builtin roles', () => {
      const config = readRolesConfig();
      expect(config.roles.owner).toBeDefined();
      expect(config.roles.admin).toBeDefined();
      expect(config.roles.member).toBeDefined();
      expect(config.roles.guest).toBeDefined();
      expect(config.roles.anonymous).toBeDefined();
    });
  });

  describe('getRoleDefinition', () => {
    it('should get owner role definition', () => {
      const owner = getRoleDefinition('owner');
      expect(owner).toBeDefined();
      expect(owner?.description).toContain('所有者');
      expect(owner?.permissions).toBeDefined();
    });

    it('should get admin role definition', () => {
      const admin = getRoleDefinition('admin');
      expect(admin).toBeDefined();
      expect(admin?.description).toContain('管理员');
    });

    it('should get member role definition', () => {
      const member = getRoleDefinition('member');
      expect(member).toBeDefined();
      expect(member?.description).toContain('团队成员');
    });

    it('should get guest role definition', () => {
      const guest = getRoleDefinition('guest');
      expect(guest).toBeDefined();
      expect(guest?.description).toContain('访客');
    });

    it('should get anonymous role definition', () => {
      const anonymous = getRoleDefinition('anonymous');
      expect(anonymous).toBeDefined();
      expect(anonymous?.description).toContain('匿名');
    });

    it('should return null for unknown role', () => {
      const unknown = getRoleDefinition('unknown-role');
      expect(unknown).toBeNull();
    });

    it('should use cache on second call', () => {
      const first = getRoleDefinition('owner');
      const second = getRoleDefinition('owner');
      expect(first).toBe(second); // 同一个对象引用
    });
  });

  describe('getFieldPermission', () => {
    it('should get permissionMode for owner', () => {
      const perm = getFieldPermission('owner', 'permissionMode');
      expect(perm).toBeDefined();
      expect(perm?.default).toBe('bypass');
      expect(perm?.allowOverride).toBe(false);
    });

    it('should get permissionMode for admin', () => {
      const perm = getFieldPermission('admin', 'permissionMode');
      expect(perm).toBeDefined();
      expect(perm?.default).toBe('request');
      expect(perm?.allowOverride).toBe(false);
    });

    it('should get permissionMode for member', () => {
      const perm = getFieldPermission('member', 'permissionMode');
      expect(perm).toBeDefined();
      expect(perm?.default).toBe('auto');
      expect(perm?.allowOverride).toBe(false);
    });

    it('should get permissionMode for guest', () => {
      const perm = getFieldPermission('guest', 'permissionMode');
      expect(perm).toBeDefined();
      expect(perm?.default).toBe('readonly');
      expect(perm?.allowOverride).toBe(false);
    });

    it('should get nested field permission (baseagents.claude.model)', () => {
      const perm = getFieldPermission('owner', 'baseagents.claude.model');
      expect(perm).toBeDefined();
      expect(perm?.default).toBe('claude-opus-4-8');
      expect(perm?.allowOverride).toBe(true);
      expect(perm?.allowedModels).toContain('*');
    });

    it('should return null for unknown field', () => {
      const perm = getFieldPermission('owner', 'unknown-field');
      expect(perm).toBeNull();
    });

    it('should return null for unknown role', () => {
      const perm = getFieldPermission('unknown-role', 'permissionMode');
      expect(perm).toBeNull();
    });
  });

  describe('Role Permission Hierarchy', () => {
    it('owner should have bypass permission', () => {
      const perm = getFieldPermission('owner', 'permissionMode');
      expect(perm?.default).toBe('bypass');
    });

    it('admin should have request permission', () => {
      const perm = getFieldPermission('admin', 'permissionMode');
      expect(perm?.default).toBe('request');
    });

    it('member should have auto permission', () => {
      const perm = getFieldPermission('member', 'permissionMode');
      expect(perm?.default).toBe('auto');
    });

    it('guest should have readonly permission', () => {
      const perm = getFieldPermission('guest', 'permissionMode');
      expect(perm?.default).toBe('readonly');
    });

    it('anonymous should have readonly permission', () => {
      const perm = getFieldPermission('anonymous', 'permissionMode');
      expect(perm?.default).toBe('readonly');
    });
  });

  describe('Model Whitelist', () => {
    it('owner should allow all models', () => {
      const perm = getFieldPermission('owner', 'baseagents.claude.model');
      expect(perm?.allowedModels).toContain('*');
    });

    it('admin should allow opus, sonnet, haiku', () => {
      const perm = getFieldPermission('admin', 'baseagents.claude.model');
      expect(perm?.allowedModels).toEqual([
        'claude-opus-*',
        'claude-sonnet-*',
        'claude-haiku-*'
      ]);
    });

    it('member should allow sonnet and haiku only', () => {
      const perm = getFieldPermission('member', 'baseagents.claude.model');
      expect(perm?.allowedModels).toEqual([
        'claude-sonnet-*',
        'claude-haiku-*'
      ]);
    });

    it('guest should allow haiku only', () => {
      const perm = getFieldPermission('guest', 'baseagents.claude.model');
      expect(perm?.allowedModels).toEqual(['claude-haiku-*']);
    });

    it('anonymous should allow haiku only', () => {
      const perm = getFieldPermission('anonymous', 'baseagents.claude.model');
      expect(perm?.allowedModels).toEqual(['claude-haiku-*']);
    });
  });

  describe('Override Permissions', () => {
    it('owner can override most fields', () => {
      expect(getFieldPermission('owner', 'chatmode')?.allowOverride).toBe(true);
      expect(getFieldPermission('owner', 'dispatch')?.allowOverride).toBe(true);
      expect(getFieldPermission('owner', 'show_activities')?.allowOverride).toBe(true);
    });

    it('owner cannot override permissionMode', () => {
      expect(getFieldPermission('owner', 'permissionMode')?.allowOverride).toBe(false);
    });

    it('guest cannot override any fields', () => {
      expect(getFieldPermission('guest', 'permissionMode')?.allowOverride).toBe(false);
      expect(getFieldPermission('guest', 'chatmode')?.allowOverride).toBe(false);
      expect(getFieldPermission('guest', 'dispatch')?.allowOverride).toBe(false);
      expect(getFieldPermission('guest', 'baseagents.claude.model')?.allowOverride).toBe(false);
    });

    it('member can override some fields but not critical ones', () => {
      expect(getFieldPermission('member', 'permissionMode')?.allowOverride).toBe(false);
      expect(getFieldPermission('member', 'dispatch')?.allowOverride).toBe(false);
      expect(getFieldPermission('member', 'chatmode')?.allowOverride).toBe(true);
      expect(getFieldPermission('member', 'show_activities')?.allowOverride).toBe(true);
    });
  });

  describe('clearRolesCache', () => {
    it('should clear the cache', () => {
      getRoleDefinition('owner'); // 填充缓存
      clearRolesCache();
      // 无法直接测试缓存是否清空，但至少不应该报错
      const owner = getRoleDefinition('owner');
      expect(owner).toBeDefined();
    });
  });

  describe('getBuiltinRolesConfig', () => {
    it('should return valid config', () => {
      const config = getBuiltinRolesConfig();
      expect(config.$schema_version).toBe(2);
      expect(config.defaultRole).toBe('anonymous');
      expect(Object.keys(config.roles)).toHaveLength(5);
    });

    it('should have all required role properties', () => {
      const config = getBuiltinRolesConfig();
      for (const [roleName, roleDef] of Object.entries(config.roles)) {
        expect(roleDef.description).toBeDefined();
        expect(typeof roleDef.allowAccess).toBe('boolean');
        expect(roleDef.permissions).toBeDefined();
        expect(typeof roleDef.description).toBe('string');
        expect(typeof roleDef.permissions).toBe('object');
      }
    });
  });
});
