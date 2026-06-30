import type { RolesConfig } from '../types.js';

export function getBuiltinRolesConfig(): RolesConfig {
  return {
    $schema_version: 4,
    defaultRoles: {
      private: 'anonymous',
      group: 'guest',
    },
    roles: {
      owner: {
        description: 'Agent owner with full control',
        allowAccess: true,
        permissions: {
          permissionMode: { default: 'bypass', allowOverride: false },
          'baseagents.claude.model': { default: 'claude-opus-4-8', allowOverride: true, allowedModels: ['*'] },
          'baseagents.claude.effort': { default: 'high', allowOverride: true },
          chatmode: { default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' }, allowOverride: true },
          dispatch: { default: 'broadcast', allowOverride: true },
          show_activities: { default: 'all', allowOverride: true },
          flush_delay: { default: 3, allowOverride: true },
          debounce: { default: 0, allowOverride: true },
          enable_rich_content: { default: true, allowOverride: true },
        },
        commandPermissions: {
          '*': { allow: true },
          'dangerous:*': { allow: true, dangerous: true, constraints: { requireDaemonOwner: true } },
        },
      },
      admin: {
        description: 'Administrator with guarded dangerous access',
        allowAccess: true,
        permissions: {
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
        },
        commandPermissions: {
          '*': { allow: true },
          'dangerous:*': { allow: true, dangerous: true, constraints: { requireDaemonOwner: true } },
        },
      },
      member: {
        description: 'Team member with own-scope access',
        allowAccess: true,
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
          'category:read': { allow: true },
          'category:write-own': { allow: true },
          'model.*': { allow: true, scopes: ['relation', 'agent'], constraints: { ownPeerOnly: true, ownAgentOnly: true } },
          'cli.exec.raw': { allow: false, dangerous: true },
        },
      },
      guest: {
        description: 'Guest with private own-scope read access',
        allowAccess: true,
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
          'model.list': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, ownAgentOnly: true, privateOnly: true } },
          'model.current': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, ownAgentOnly: true, privateOnly: true } },
          'model.use': {
            allow: true,
            scopes: ['relation'],
            constraints: { ownPeerOnly: true, ownAgentOnly: true, privateOnly: true, requireFieldOverride: 'baseagents.claude.model' },
          },
          'session.list': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, privateOnly: true } },
          'cli.exec.raw': { allow: false, dangerous: true },
          'dangerous:*': { allow: false, dangerous: true },
        },
      },
      anonymous: {
        description: 'Anonymous user with no command access',
        allowAccess: false,
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
          flush_delay: { default: 10, allowOverride: false },
          debounce: { default: 0, allowOverride: false },
          enable_rich_content: { default: false, allowOverride: false },
        },
        commandPermissions: {
          '*': { allow: false },
        },
      },
    },
  };
}
