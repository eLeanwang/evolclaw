import type { CommandPermission, FieldPermission, ManagementRole, RoleDefinition, RolesConfig } from '../types.js';

export const BUILTIN_USER_ROLES = ['member', 'visitor'] as const;
export const MANAGEMENT_ROLES = ['owner', 'admin'] as const;

export function isManagementRole(role: string | null | undefined): role is ManagementRole {
  return role === 'owner' || role === 'admin';
}

export function isReservedRoleName(role: string | null | undefined): boolean {
  return isManagementRole(role);
}

export function getBuiltinRolesConfig(): RolesConfig {
  return {
    $schema_version: 1,
    defaultRoles: {
      private: null,
      group: null,
    },
    roles: getBuiltinUserRoleDefinitions(),
  };
}

export function getBuiltinUserRoleDefinitions(): Record<string, RoleDefinition> {
  return {
    member: {
      description: 'Trusted user with own-scope access',
      allowAccess: true,
      usageLimits: {
        enabled: true,
        resetMode: 'daily',
        currency: 'CNY',
        limitAmount: 50,
        costBasis: 'gateway',
        scope: 'subject',
      },
      permissions: {
        permissionMode: { default: 'auto', allowOverride: false },
        'baseagents.claude.model': {
          default: 'claude-sonnet-4-6',
          allowOverride: true,
          allowedModels: ['claude-sonnet-*', 'claude-haiku-*'],
        },
        'baseagents.claude.effort': { default: 'medium', allowOverride: true },
        chatmode: { default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' }, allowOverride: true },
        dispatch: { default: 'mention', allowOverride: false },
        show_activities: { default: 'all', allowOverride: true },
        flush_delay: { default: 3, allowOverride: true },
        debounce: { default: 0, allowOverride: true },
        enable_rich_content: { default: false, allowOverride: true },
      },
      commandPermissions: {
        'role.assign': { allow: false },
        'role.revoke': { allow: false },
        'category:read': { allow: true },
        'category:write-own': { allow: true },
        'config.get': {
          allow: true,
          scopes: ['relation'],
          constraints: {
            currentRelationOnly: true,
            targetCurrentAgentOnly: true,
            configFieldPolicy: 'behavior-read',
          },
        },
        'config.set': {
          allow: true,
          scopes: ['relation'],
          constraints: {
            currentRelationOnly: true,
            targetCurrentAgentOnly: true,
            configFieldPolicy: 'role-overridable-write',
          },
        },
        'config.unset': {
          allow: true,
          scopes: ['relation'],
          constraints: {
            currentRelationOnly: true,
            targetCurrentAgentOnly: true,
            configFieldPolicy: 'role-overridable-write',
          },
        },
        'model.*': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'permission.current': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'permission.answer': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'permission.update': { allow: false },
        'chatmode.current': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'chatmode.update': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true, requireFieldOverride: 'chatmode' } },
        'dispatch.current': { allow: true, scopes: ['relation'], constraints: { groupOnly: true } },
        'dispatch.update': { allow: false },
        'ec.msg.send': { allow: true, constraints: { ownPeerOnly: true } },
        'ec.msg.file': { allow: true, constraints: { ownPeerOnly: true } },
        'ec.group.send': { allow: true, constraints: { groupOnly: true } },
        'ec.group.file': { allow: true, constraints: { groupOnly: true } },
        'ec.ctl.*': { allow: false },
        'cli.exec.raw': { allow: false, dangerous: true },
        'dangerous:*': { allow: false, dangerous: true },
      },
    },
    visitor: {
      description: 'Low-trust visitor with minimal own-scope access',
      allowAccess: true,
      usageLimits: {
        enabled: true,
        resetMode: 'daily',
        currency: 'CNY',
        limitAmount: 5,
        costBasis: 'gateway',
        scope: 'subject',
      },
      permissions: {
        permissionMode: { default: 'readonly', allowOverride: false },
        'baseagents.claude.model': {
          default: 'claude-haiku-4-5-20251001',
          allowOverride: false,
          allowedModels: ['claude-haiku-*'],
        },
        'baseagents.claude.effort': { default: 'low', allowOverride: false },
        chatmode: { default: { private: 'proactive', group: 'proactive', nothuman: 'proactive' }, allowOverride: false },
        dispatch: { default: 'mention', allowOverride: false },
        show_activities: { default: 'none', allowOverride: false },
        flush_delay: { default: 5, allowOverride: false },
        debounce: { default: 0, allowOverride: false },
        enable_rich_content: { default: false, allowOverride: false },
      },
      commandPermissions: {
        'role.assign': { allow: false },
        'role.revoke': { allow: false },
        'config.get': {
          allow: true,
          scopes: ['relation'],
          constraints: {
            currentRelationOnly: true,
            targetCurrentAgentOnly: true,
            configFieldPolicy: 'behavior-read',
          },
        },
        'model.list': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'model.current': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'model.use': {
          allow: true,
          scopes: ['relation'],
          constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true, requireFieldOverride: 'baseagents.claude.model' },
        },
        'permission.current': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'permission.answer': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'permission.update': { allow: false },
        'chatmode.current': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, targetCurrentAgentOnly: true } },
        'chatmode.update': { allow: false },
        'dispatch.current': { allow: true, scopes: ['relation'], constraints: { groupOnly: true } },
        'dispatch.update': { allow: false },
        'session.list': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true } },
        'ec.msg.send': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, privateOnly: true } },
        'ec.msg.file': { allow: false },
        'ec.group.send': { allow: true, scopes: ['relation'], constraints: { groupOnly: true } },
        'ec.group.file': { allow: false },
        'ec.ctl.*': { allow: false },
        'cli.exec.raw': { allow: false, dangerous: true },
        'dangerous:*': { allow: false, dangerous: true },
      },
    },
  };
}

export function getManagementFieldPermissions(role: ManagementRole): Record<string, FieldPermission> {
  if (role === 'owner') {
    return {
      permissionMode: { default: 'bypass', allowOverride: false },
      'baseagents.claude.model': { default: 'claude-opus-4-8', allowOverride: true, allowedModels: ['*'] },
      'baseagents.claude.effort': { default: 'high', allowOverride: true },
      chatmode: { default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' }, allowOverride: true },
      dispatch: { default: 'broadcast', allowOverride: true },
      show_activities: { default: 'all', allowOverride: true },
      flush_delay: { default: 3, allowOverride: true },
      debounce: { default: 0, allowOverride: true },
      enable_rich_content: { default: true, allowOverride: true },
    };
  }

  return {
    permissionMode: { default: 'request', allowOverride: false },
    'baseagents.claude.model': {
      default: 'claude-sonnet-4-6',
      allowOverride: true,
      allowedModels: ['claude-opus-*', 'claude-sonnet-*', 'claude-haiku-*'],
    },
    'baseagents.claude.effort': { default: 'medium', allowOverride: true },
    chatmode: { default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' }, allowOverride: true },
    dispatch: { default: 'mention', allowOverride: true, allowedValues: ['mention'] },
    show_activities: { default: 'all', allowOverride: true },
    flush_delay: { default: 3, allowOverride: true },
    debounce: { default: 0, allowOverride: true },
    enable_rich_content: { default: true, allowOverride: true },
  };
}

export function getManagementCommandPermissions(_role: ManagementRole): Record<string, CommandPermission> {
  const permissions: Record<string, CommandPermission> = {
    'role.assign': { allow: true, scopes: ['agent'] },
    'role.revoke': { allow: true, scopes: ['agent'] },
    'role.policy.read': { allow: true, scopes: ['agent'] },
    'role.policy.write': { allow: true, dangerous: true, scopes: ['agent'], constraints: { requireAgentOwner: true } },
    '*': { allow: true },
    'agent.reload': { allow: true, dangerous: true, scopes: ['agent'], constraints: { targetCurrentAgentOnly: true, requireAgentAdmin: true } },
    'dangerous:*': { allow: true, dangerous: true, constraints: { requireDaemonOwner: true } },
  };
  if (_role === 'admin') {
    permissions['role.policy.write'] = {
      allow: false,
      dangerous: true,
      scopes: ['agent'],
      reason: 'Role policy changes require agent owner permission',
    };
  }
  return permissions;
}

export function getManagementRoleDefinition(role: ManagementRole): RoleDefinition {
  return {
    description: role === 'owner'
      ? 'Agent owner with code-defined full control'
      : 'Agent admin with code-defined guarded management access',
    allowAccess: true,
    permissions: getManagementFieldPermissions(role),
    commandPermissions: getManagementCommandPermissions(role),
  };
}
