import { describe, it, expect, beforeEach } from 'vitest';
import {
  readRolesConfig,
  getRoleDefinition,
  getFieldPermission,
  clearRolesCache,
  getBuiltinRolesConfig,
  getCommandPermissions,
} from '../src/config/roles.js';

describe('Role Configuration', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  describe('readRolesConfig', () => {
    it('returns builtin v4 config when file does not exist', () => {
      const config = readRolesConfig();
      expect(config.$schema_version).toBe(4);
      expect(config.defaultRoles).toEqual({ private: 'anonymous', group: 'guest' });
      expect(Object.keys(config.roles)).toEqual(['owner', 'admin', 'member', 'guest', 'anonymous']);
    });
  });

  describe('getRoleDefinition', () => {
    it('gets builtin role definitions', () => {
      expect(getRoleDefinition('owner')?.permissions).toBeDefined();
      expect(getRoleDefinition('admin')?.permissions).toBeDefined();
      expect(getRoleDefinition('member')?.permissions).toBeDefined();
      expect(getRoleDefinition('guest')?.permissions).toBeDefined();
      expect(getRoleDefinition('anonymous')?.allowAccess).toBe(false);
    });

    it('returns null for unknown role', () => {
      expect(getRoleDefinition('unknown-role')).toBeNull();
    });

    it('uses cache on second call', () => {
      const first = getRoleDefinition('owner');
      const second = getRoleDefinition('owner');
      expect(first).toBe(second);
    });
  });

  describe('getFieldPermission', () => {
    it('gets permission modes', () => {
      expect(getFieldPermission('owner', 'permissionMode')?.default).toBe('bypass');
      expect(getFieldPermission('admin', 'permissionMode')?.default).toBe('request');
      expect(getFieldPermission('member', 'permissionMode')?.default).toBe('auto');
      expect(getFieldPermission('guest', 'permissionMode')?.default).toBe('readonly');
      expect(getFieldPermission('anonymous', 'permissionMode')?.default).toBe('readonly');
    });

    it('gets nested field permission', () => {
      const perm = getFieldPermission('owner', 'baseagents.claude.model');
      expect(perm?.default).toBe('claude-opus-4-8');
      expect(perm?.allowOverride).toBe(true);
      expect(perm?.allowedModels).toContain('*');
    });

    it('returns null for unknown field or role', () => {
      expect(getFieldPermission('owner', 'unknown-field')).toBeNull();
      expect(getFieldPermission('unknown-role', 'permissionMode')).toBeNull();
    });
  });

  describe('Model Whitelist', () => {
    it('keeps builtin model allowlists', () => {
      expect(getFieldPermission('owner', 'baseagents.claude.model')?.allowedModels).toContain('*');
      expect(getFieldPermission('admin', 'baseagents.claude.model')?.allowedModels).toEqual([
        'claude-opus-*',
        'claude-sonnet-*',
        'claude-haiku-*',
      ]);
      expect(getFieldPermission('member', 'baseagents.claude.model')?.allowedModels).toEqual([
        'claude-sonnet-*',
        'claude-haiku-*',
      ]);
      expect(getFieldPermission('guest', 'baseagents.claude.model')?.allowedModels).toEqual(['claude-haiku-*']);
      expect(getFieldPermission('anonymous', 'baseagents.claude.model')?.allowedModels).toEqual(['claude-haiku-*']);
    });
  });

  describe('Override Permissions', () => {
    it('keeps builtin field override policy', () => {
      expect(getFieldPermission('owner', 'chatmode')?.allowOverride).toBe(true);
      expect(getFieldPermission('owner', 'permissionMode')?.allowOverride).toBe(false);
      expect(getFieldPermission('guest', 'chatmode')?.allowOverride).toBe(false);
      expect(getFieldPermission('guest', 'baseagents.claude.model')?.allowOverride).toBe(false);
      expect(getFieldPermission('member', 'chatmode')?.allowOverride).toBe(true);
      expect(getFieldPermission('member', 'dispatch')?.allowOverride).toBe(false);
    });
  });

  describe('commandPermissions', () => {
    it('exposes v4 command permissions', () => {
      expect(getCommandPermissions('owner')['dangerous:*']).toMatchObject({
        allow: true,
        dangerous: true,
        constraints: { requireDaemonOwner: true },
      });
      expect(getCommandPermissions('admin')['dangerous:*']?.constraints?.requireDaemonOwner).toBe(true);
      expect(getCommandPermissions('member')['model.*']).toBeDefined();
      expect(getCommandPermissions('guest')['model.list']).toBeDefined();
      expect(getCommandPermissions('anonymous')['*']?.allow).toBe(false);
    });
  });

  describe('clearRolesCache', () => {
    it('clears the cache without breaking reads', () => {
      getRoleDefinition('owner');
      clearRolesCache();
      expect(getRoleDefinition('owner')).toBeDefined();
    });
  });

  describe('getBuiltinRolesConfig', () => {
    it('returns valid builtin v4 config', () => {
      const config = getBuiltinRolesConfig();
      expect(config.$schema_version).toBe(4);
      expect(config.defaultRoles).toEqual({ private: 'anonymous', group: 'guest' });
      expect(Object.keys(config.roles)).toHaveLength(5);
    });

    it('has required role properties', () => {
      const config = getBuiltinRolesConfig();
      for (const roleDef of Object.values(config.roles)) {
        expect(typeof roleDef.description).toBe('string');
        expect(typeof roleDef.allowAccess).toBe('boolean');
        expect(typeof roleDef.permissions).toBe('object');
        expect(typeof roleDef.commandPermissions).toBe('object');
      }
    });
  });
});
