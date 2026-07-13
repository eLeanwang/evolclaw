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
    it('returns builtin user roles when agent config does not exist', () => {
      const config = readRolesConfig();
      expect(config.$schema_version).toBe(1);
      expect(config.defaultRoles).toEqual({ private: null, group: null });
      expect(Object.keys(config.roles)).toEqual(['member', 'visitor']);
    });
  });

  describe('getRoleDefinition', () => {
    it('gets builtin role definitions', () => {
      expect(getRoleDefinition('owner')?.permissions).toBeDefined();
      expect(getRoleDefinition('admin')?.permissions).toBeDefined();
      expect(getRoleDefinition('member')?.permissions).toBeDefined();
      expect(getRoleDefinition('visitor')?.permissions).toBeDefined();
      expect(getRoleDefinition('guest')).toBeNull();
      expect(getRoleDefinition('anonymous')).toBeNull();
    });

    it('returns null for unknown role', () => {
      expect(getRoleDefinition('unknown-role')).toBeNull();
    });

    it('returns equivalent definitions on repeated calls', () => {
      const first = getRoleDefinition('owner');
      const second = getRoleDefinition('owner');
      expect(second).toEqual(first);
    });
  });

  describe('getFieldPermission', () => {
    it('gets permission modes', () => {
      expect(getFieldPermission('owner', 'permissionMode')?.default).toBe('bypass');
      expect(getFieldPermission('admin', 'permissionMode')?.default).toBe('request');
      expect(getFieldPermission('member', 'permissionMode')?.default).toBe('auto');
      expect(getFieldPermission('visitor', 'permissionMode')?.default).toBe('readonly');
      expect(getFieldPermission('none', 'permissionMode')).toBeNull();
    });

    it('does not define role-level model permissions', () => {
      expect(getFieldPermission('owner', 'baseagents.claude.model')).toBeNull();
      expect(getFieldPermission('admin', 'baseagents.claude.model')).toBeNull();
      expect(getFieldPermission('member', 'baseagents.claude.model')).toBeNull();
      expect(getFieldPermission('visitor', 'baseagents.claude.model')).toBeNull();
    });

    it('returns null for unknown field or role', () => {
      expect(getFieldPermission('owner', 'unknown-field')).toBeNull();
      expect(getFieldPermission('unknown-role', 'permissionMode')).toBeNull();
    });
  });

  describe('Behavior Fields', () => {
    it('defines only permissionMode for builtin roles', () => {
      for (const role of ['owner', 'admin', 'member', 'visitor']) {
        expect(Object.keys(getRoleDefinition(role)?.permissions || {})).toEqual(['permissionMode']);
      }
    });
  });

  describe('Override Permissions', () => {
    it('keeps permission mode locked and leaves other fields unconfigured', () => {
      expect(getFieldPermission('owner', 'permissionMode')?.allowOverride).toBe(false);
      expect(getFieldPermission('visitor', 'chatmode')).toBeNull();
      expect(getFieldPermission('member', 'dispatch')).toBeNull();
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
      expect(getCommandPermissions('visitor')['model.list']).toBeDefined();
      expect(getCommandPermissions('none')['*']).toBeUndefined();
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
    it('returns valid builtin user role config', () => {
      const config = getBuiltinRolesConfig();
      expect(config.$schema_version).toBe(1);
      expect(config.defaultRoles).toEqual({ private: null, group: null });
      expect(Object.keys(config.roles)).toEqual(['member', 'visitor']);
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
