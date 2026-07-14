import { describe, it, expect, beforeEach } from 'vitest';
import {
  authorizeCommand,
  authorizeResolvedConfigCommand,
  authorizeResolvedConfigOperation,
  USER_PLANE_CAPABILITY_CEILING,
} from '../../../src/core/command/command-permission.js';
import { ConfigTarget, write } from '../../../src/config/config-manager.js';
import { clearRolesCache } from '../../../src/config/roles.js';
import { resolveConfigCommand, resolveConfigOperation } from '../../../src/config/resolved-config-op.js';
import type { CommandAuthorizationContext } from '../../../src/types.js';
import { authorizeAccess, buildAuthSubject } from '../../../src/core/auth/auth-gateway.js';

describe('Command Permission', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  describe('Visitor role permissions', () => {
    const baseContext: CommandAuthorizationContext = {
      intent: {
        operation: 'model.list',
        scope: 'relation',
        source: 'menu.cli',
        args: { self: 'agent1', peer: 'user1' },
      },
      actorId: 'user1',
      channel: 'test-channel',
      channelId: 'test-channel-id',
      chatType: 'private',
      selfAid: 'agent1',
      peerKey: 'aun::user1',
      role: 'visitor',
      isDaemonOwner: false,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should allow visitor to execute model.list with proper constraints', () => {
      const decision = authorizeCommand(baseContext);
      expect(decision.allow).toBe(true);
      if (decision.allow) {
        expect(decision.operation).toBe('model.list');
        expect(decision.role).toBe('visitor');
      }
    });

    it('should allow visitor model.current', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        intent: {
          ...baseContext.intent,
          operation: 'model.current',
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
    });

    it('should allow visitor model.use when no role model policy is configured', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        intent: {
          ...baseContext.intent,
          operation: 'model.use',
          args: { self: 'agent1', peer: 'user1', model: 'claude-haiku-4-5-20251001' },
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
    });

    it('should deny visitor cli.exec.raw', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        intent: {
          operation: 'cli.exec.raw',
          scope: 'raw-cli',
          source: 'menu.cli',
          args: {},
          dangerous: true,
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('NOT_ALLOWED');
      }
    });

    it('should deny visitor when ownPeerOnly constraint fails', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        actorId: 'other-user',
        intent: {
          ...baseContext.intent,
          args: { self: 'agent1', peer: 'user1' }, // peer doesn't match actorId
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should deny visitor when ownAgentOnly constraint fails', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        selfAid: 'agent2',
        intent: {
          ...baseContext.intent,
          args: { self: 'agent1', peer: 'user1' }, // self doesn't match selfAid
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should allow visitor group send when groupOnly constraint matches', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        chatType: 'group',
        intent: {
          operation: 'ec.group.send',
          scope: 'relation',
          source: 'agent-tool',
          args: {},
        },
        source: 'agent-tool',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
    });

    it('should deny visitor model.list when cli scope falls back to agent', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        intent: {
          operation: 'model.list',
          scope: 'agent',
          source: 'menu.cli',
          args: {},
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('SCOPE_MISMATCH');
      }
    });
  });

  describe('Owner role permissions', () => {
    const ownerContext: CommandAuthorizationContext = {
      intent: {
        operation: 'model.list',
        scope: 'agent',
        source: 'menu.cli',
        args: {},
      },
      actorId: 'owner1',
      role: 'owner',
      isDaemonOwner: true,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should allow owner all operations', () => {
      const decision = authorizeCommand(ownerContext);
      expect(decision.allow).toBe(true);
    });

    it('should allow owner dangerous operations', () => {
      const ctx: CommandAuthorizationContext = {
        ...ownerContext,
        intent: {
          operation: 'cli.exec.raw',
          scope: 'raw-cli',
          source: 'menu.cli',
          args: {},
          dangerous: true,
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
      if (decision.allow) {
        expect(decision.dangerous).toBe(true);
      }
    });

    it('should deny owner process operations without daemon owner by default', () => {
      const ctx: CommandAuthorizationContext = {
        ...ownerContext,
        intent: {
          operation: 'system.restart',
          scope: 'process',
          source: 'slash',
          args: {},
          dangerous: true,
        },
        isDaemonOwner: false,
        source: 'slash',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
      }
    });
  });

  describe('Admin role permissions', () => {
    const adminContext: CommandAuthorizationContext = {
      intent: {
        operation: 'model.list',
        scope: 'agent',
        source: 'menu.cli',
        args: {},
      },
      actorId: 'admin1',
      role: 'admin',
      isDaemonOwner: false,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should allow admin normal operations', () => {
      const decision = authorizeCommand(adminContext);
      expect(decision.allow).toBe(true);
    });

    it('should deny admin dangerous operations without daemon owner', () => {
      const ctx: CommandAuthorizationContext = {
        ...adminContext,
        intent: {
          operation: 'stats.rebuild',
          scope: 'process',
          source: 'menu.cli',
          args: {},
          dangerous: true,
        },
        isDaemonOwner: false,
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should allow admin dangerous operations with daemon owner', () => {
      const ctx: CommandAuthorizationContext = {
        ...adminContext,
        intent: {
          operation: 'stats.rebuild',
          scope: 'process',
          source: 'menu.cli',
          args: {},
          dangerous: true,
        },
        isDaemonOwner: true,
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
    });
  });

  describe('Member role permissions', () => {
    const memberContext: CommandAuthorizationContext = {
      intent: {
        operation: 'model.list',
        scope: 'relation',
        source: 'menu.cli',
        args: { self: 'agent1', peer: 'user1' },
      },
      actorId: 'user1',
      chatType: 'private',
      selfAid: 'agent1',
      peerKey: 'aun::user1',
      role: 'member',
      isDaemonOwner: false,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should allow member read operations', () => {
      const decision = authorizeCommand(memberContext);
      expect(decision.allow).toBe(true);
    });

    it('should allow member model operations with constraints', () => {
      const ctx: CommandAuthorizationContext = {
        ...memberContext,
        intent: {
          operation: 'model.use',
          scope: 'relation',
          source: 'menu.cli',
          args: { self: 'agent1', peer: 'user1' },
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
    });

    it('should deny member cli.exec.raw', () => {
      const ctx: CommandAuthorizationContext = {
        ...memberContext,
        intent: {
          operation: 'cli.exec.raw',
          scope: 'raw-cli',
          source: 'menu.cli',
          args: {},
          dangerous: true,
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
    });
  });

  describe('Config authorization', () => {
    const relationArgs = {
      self: 'agent1',
      peer: 'aun#group1',
      peerKey: 'aun#group1',
      configScope: 'relation',
    };
    const memberContext: CommandAuthorizationContext = {
      intent: {
        operation: 'config.get',
        scope: 'relation',
        source: 'menu.cli',
        args: { ...relationArgs, field: 'chatmode.private' },
      },
      actorId: 'member1',
      chatType: 'group',
      selfAid: 'agent1',
      peerKey: 'aun#group1',
      role: 'member',
      source: 'menu.cli',
    };

    const memberConfigContext: Omit<CommandAuthorizationContext, 'intent'> = {
      actorId: 'member1',
      chatType: 'group',
      selfAid: 'agent1',
      peerKey: 'aun#group1',
      role: 'member',
      source: 'menu.cli',
    };

    function resolveOp(argv: string[]) {
      const resolved = resolveConfigOperation(argv);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.reason}`);
      return resolved.op;
    }

    function authorizeConfig(
      argv: string[],
      context: Omit<CommandAuthorizationContext, 'intent'> = memberConfigContext,
    ) {
      return authorizeResolvedConfigOperation(resolveOp(argv), context);
    }

    function authorizeConfigCommand(
      argv: string[],
      context: Omit<CommandAuthorizationContext, 'intent'>,
    ) {
      const resolved = resolveConfigCommand(argv);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.reason}`);
      return authorizeResolvedConfigCommand(resolved.command, context);
    }

    it('fails closed when a field config intent has no resolved operation', () => {
      const decision = authorizeCommand(memberContext);
      expect(decision.allow).toBe(false);
      if (!decision.allow) expect(decision.code).toBe('NOT_ALLOWED');
    });

    it('allows member reads and role-overridable relation writes', () => {
      expect(authorizeConfig([
        'config', 'get', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#group1',
      ]).allow).toBe(true);
      expect(authorizeConfig([
        'config', 'set', 'chatmode.private', 'interactive', '--self', 'agent1', '--peer', 'aun#group1',
      ]).allow).toBe(true);
      expect(authorizeConfig([
        'config', 'unset', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#group1',
      ]).allow).toBe(true);
    });

    it('applies field type and explicit permission mode constraints', () => {
      expect(resolveConfigOperation([
        'config', 'set', 'chatmode.private', 'invalid', '--self', 'agent1', '--peer', 'aun#group1',
      ])).toMatchObject({ ok: false, code: 'INVALID_CONFIG_VALUE' });

      const permissionDecision = authorizeConfig([
        'config', 'set', 'permissionMode', 'bypass', '--self', 'agent1', '--peer', 'aun#group1',
      ]);
      expect(permissionDecision.allow).toBe(false);
      if (!permissionDecision.allow) expect(permissionDecision.code).toBe('ARGUMENT_MISMATCH');

      expect(authorizeConfig([
        'config', 'set', 'baseagents.claude.model', 'gpt-5',
        '--self', 'agent1', '--peer', 'aun#group1',
      ]).allow).toBe(true);
      expect(authorizeConfig([
        'config', 'set', 'baseagents.claude.model', 'claude-sonnet-4-6',
        '--self', 'agent1', '--peer', 'aun#group1',
      ]).allow).toBe(true);
    });

    it('keeps visitor config access read-only', () => {
      const visitorContext = { ...memberConfigContext, role: 'visitor' };
      const visitorRead = authorizeConfig([
        'config', 'get', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#group1',
      ], visitorContext);
      expect(visitorRead.allow).toBe(true);

      const visitorWrite = authorizeConfig([
        'config', 'set', 'chatmode.private', 'interactive', '--self', 'agent1', '--peer', 'aun#group1',
      ], visitorContext);
      expect(visitorWrite.allow).toBe(false);
      if (!visitorWrite.allow) expect(visitorWrite.code).toBe('NO_PERMISSION');
    });

    it('rejects non-management agent scope and other relation targets', () => {
      const agentDecision = authorizeConfig([
        'config', 'get', 'chatmode.private', '--self', 'agent1',
      ]);
      expect(agentDecision.allow).toBe(false);
      if (!agentDecision.allow) expect(agentDecision.code).toBe('SCOPE_MISMATCH');

      const otherPeerDecision = authorizeConfig([
        'config', 'get', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#other-group',
      ]);
      expect(otherPeerDecision.allow).toBe(false);
      if (!otherPeerDecision.allow) expect(otherPeerDecision.code).toBe('ARGUMENT_MISMATCH');
    });

    it('allows a group relation without comparing the group id to actor id', () => {
      expect(authorizeConfig([
        'config', 'get', 'chatmode.private', '--self', 'agent1', '--peer', 'aun#group1',
      ]).allow).toBe(true);
    });

    it('limits every group role to relation-scoped config mutations', () => {
      const groupOwnerContext: Omit<CommandAuthorizationContext, 'intent'> = {
        ...memberConfigContext,
        actorId: 'owner1',
        role: 'owner',
        isDaemonOwner: true,
      };

      for (const argv of [
        ['config', 'set', 'chatmode.group', 'interactive', '--self', 'agent1'],
        ['config', 'set', 'debug', 'true', '--process'],
      ]) {
        const decision = authorizeConfig(argv, groupOwnerContext);
        expect(decision.allow).toBe(false);
        if (!decision.allow) expect(decision.code).toBe('SCOPE_MISMATCH');
      }

      expect(authorizeConfig([
        'config', 'set', 'chatmode.group', 'interactive',
        '--self', 'agent1', '--peer', 'aun#group1',
      ], groupOwnerContext).allow).toBe(true);
      expect(authorizeConfig([
        'config', 'get', 'chatmode.group', '--self', 'agent1',
      ], groupOwnerContext).allow).toBe(true);
    });

    it('denies sensitive config operations to user roles', () => {
      const decision = authorizeConfig([
        'config', 'get', 'owners', '--self', 'agent1', '--peer', 'aun#group1',
      ]);
      expect(decision.allow).toBe(false);
      if (!decision.allow) expect(decision.code).toBe('DANGEROUS_NOT_GRANTED');
    });

    it('requires explicit config grants instead of category or global wildcards', () => {
      write(ConfigTarget.Agent, {
        aid: 'broad.agentid.pub',
        channels: [],
        roles: {
          definitions: {
            broad: {
              description: 'Broad config test role',
              allowAccess: true,
              permissions: { chatmode: { default: {}, allowOverride: true } },
              commandPermissions: {
                'category:read': { allow: true },
                'category:write-own': { allow: true },
                '*': { allow: true },
              },
            },
          },
        },
      }, { self: 'broad.agentid.pub' });

      const decision = authorizeConfig([
        'config', 'get', 'chatmode.private', '--self', 'broad.agentid.pub', '--peer', 'aun#group1',
      ], {
        ...memberConfigContext,
        selfAid: 'broad.agentid.pub',
        role: 'broad',
      });
      expect(decision.allow).toBe(false);
      if (!decision.allow) expect(decision.code).toBe('NO_PERMISSION');
    });

    it('allows explicit config wildcard grants for fields without role defaults', () => {
      write(ConfigTarget.Agent, {
        aid: 'explicit.agentid.pub',
        channels: [],
        roles: {
          definitions: {
            explicit: {
              description: 'Explicit config test role',
              allowAccess: true,
              permissions: { chatmode: { default: {}, allowOverride: true } },
              commandPermissions: { 'config.*': { allow: true, scopes: ['relation'] } },
            },
          },
        },
      }, { self: 'explicit.agentid.pub' });

      const context: Omit<CommandAuthorizationContext, 'intent'> = {
        ...memberConfigContext,
        selfAid: 'explicit.agentid.pub',
        role: 'explicit',
      };
      expect(authorizeConfig([
        'config', 'set', 'chatmode.private', 'proactive',
        '--self', 'explicit.agentid.pub', '--peer', 'aun#group1',
      ], context).allow).toBe(true);

      const allowed = authorizeConfig([
        'config', 'set', 'flush_delay', '1',
        '--self', 'explicit.agentid.pub', '--peer', 'aun#group1',
      ], context);
      expect(allowed.allow).toBe(true);
    });

    it('treats daemon owner as the global permission superset', () => {
      const adminDecision = authorizeCommand({
        intent: {
          operation: 'config.write',
          scope: 'agent',
          source: 'menu.cli',
          args: { self: 'agent1', field: 'owners', value: 'owner1' },
          dangerous: true,
        },
        selfAid: 'agent1',
        role: 'admin',
        isDaemonOwner: true,
        source: 'menu.cli',
      });
      expect(adminDecision.allow).toBe(true);

      const ownerWithoutDaemon = authorizeCommand({
        intent: {
          operation: 'config.write',
          scope: 'agent',
          source: 'menu.cli',
          args: { self: 'agent1', field: 'owners', value: 'owner1' },
          dangerous: true,
        },
        selfAid: 'agent1',
        role: 'owner',
        isDaemonOwner: false,
        source: 'menu.cli',
      });
      expect(ownerWithoutDaemon.allow).toBe(false);
      if (!ownerWithoutDaemon.allow) expect(ownerWithoutDaemon.code).toBe('ARGUMENT_MISMATCH');

      expect(authorizeCommand({
        intent: {
          operation: 'config.write',
          scope: 'agent',
          source: 'menu.cli',
          args: { self: 'agent1', field: 'owners', value: 'owner1' },
          dangerous: true,
        },
        selfAid: 'agent1',
        role: 'owner',
        isDaemonOwner: true,
        source: 'menu.cli',
      }).allow).toBe(true);
    });

    it('allows an agent owner full current-agent and current-relation config access', () => {
      const ownerContext: Omit<CommandAuthorizationContext, 'intent'> = {
        actorId: 'owner1',
        chatType: 'private',
        selfAid: 'agent1',
        peerKey: 'aun#owner1',
        role: 'owner',
        isDaemonOwner: false,
        source: 'agent-tool',
      };
      for (const argv of [
        ['config', 'get', 'owners', '--self', 'agent1'],
        ['config', 'set', 'owners', 'next-owner', '--self', 'agent1'],
        ['config', 'unset', 'owners', '--self', 'agent1'],
        ['config', 'show', '--self', 'agent1'],
        ['config', 'validate', '--self', 'agent1', '--peer', 'aun#owner1'],
      ]) {
        expect(authorizeConfigCommand(argv, ownerContext).allow).toBe(true);
      }

      for (const [argv, code] of [
        [['config', 'get', 'debug', '--process'], 'SCOPE_MISMATCH'],
        [['config', 'show', '--default'], 'SCOPE_MISMATCH'],
        [['config', 'history'], 'NOT_ALLOWED'],
      ] as Array<[string[], 'SCOPE_MISMATCH' | 'NOT_ALLOWED']>) {
        const decision = authorizeConfigCommand(argv, ownerContext);
        expect(decision.allow).toBe(false);
        if (!decision.allow) expect(decision.code).toBe(code);
      }
    });

    it('allows authenticated owner menu CLI to select another relation of the current agent', () => {
      const context: Omit<CommandAuthorizationContext, 'intent'> = {
        actorId: 'owner.agentid.pub',
        chatType: 'private',
        selfAid: 'agent1',
        peerKey: 'aun#owner.agentid.pub',
        role: 'owner',
        isDaemonOwner: false,
        allowExplicitRelationTarget: true,
        source: 'menu.cli',
      };

      expect(authorizeConfigCommand([
        'config', 'set', 'chatmode.group', 'proactive',
        '--self', 'agent1', '--peer', 'aun#group.example/42',
      ], context).allow).toBe(true);
      expect(authorizeConfigCommand([
        'config', 'set', 'chatmode.private', 'proactive',
        '--self', 'agent1', '--peer', 'aun#peer.agentid.pub',
      ], context).allow).toBe(true);
    });

    it('does not allow explicit cross-relation targets for user roles or non-menu sources', () => {
      const targetArgv = [
        'config', 'get', 'chatmode.group',
        '--self', 'agent1', '--peer', 'aun#group.example/42',
      ];

      const memberDecision = authorizeConfigCommand(targetArgv, {
        ...memberConfigContext,
        allowExplicitRelationTarget: true,
      });
      expect(memberDecision.allow).toBe(false);
      if (!memberDecision.allow) expect(memberDecision.code).toBe('ARGUMENT_MISMATCH');

      const agentToolDecision = authorizeConfigCommand(targetArgv, {
        actorId: 'owner.agentid.pub',
        chatType: 'private',
        selfAid: 'agent1',
        peerKey: 'aun#owner.agentid.pub',
        role: 'owner',
        isDaemonOwner: false,
        source: 'agent-tool',
      });
      expect(agentToolDecision.allow).toBe(false);
      if (!agentToolDecision.allow) expect(agentToolDecision.code).toBe('ARGUMENT_MISMATCH');
    });

    it('allows a daemon owner private global access but preserves the group mutation ceiling', () => {
      const privateContext: Omit<CommandAuthorizationContext, 'intent'> = {
        actorId: 'daemon-owner',
        chatType: 'private',
        selfAid: 'agent1',
        peerKey: 'aun#daemon-owner',
        role: 'owner',
        isDaemonOwner: true,
        source: 'agent-tool',
      };
      for (const argv of [
        ['config', 'get', 'debug', '--process'],
        ['config', 'show', '--default'],
        ['config', 'history'],
        ['config', 'restore', 'v1'],
      ]) {
        expect(authorizeConfigCommand(argv, privateContext).allow).toBe(true);
      }

      const groupContext = { ...privateContext, chatType: 'group' as const, peerKey: 'aun#group1' };
      for (const argv of [
        ['config', 'set', 'chatmode.group', 'interactive', '--self', 'agent1'],
        ['config', 'set', 'debug', 'true', '--process'],
        ['config', 'restore', 'v1'],
      ]) {
        const decision = authorizeConfigCommand(argv, groupContext);
        expect(decision.allow).toBe(false);
        if (!decision.allow) expect(decision.code).toBe('SCOPE_MISMATCH');
      }
      expect(authorizeConfigCommand([
        'config', 'set', 'chatmode.group', 'interactive',
        '--self', 'agent1', '--peer', 'aun#group1',
      ], groupContext).allow).toBe(true);
    });

    it('requires exact dangerous grants, explicit scopes, and config key allowlists', () => {
      write(ConfigTarget.Agent, {
        aid: 'danger.agentid.pub',
        channels: [],
        roles: {
          definitions: {
            exact: {
              description: 'Exact dangerous config role',
              allowAccess: true,
              permissions: {},
              commandPermissions: {
                'config.write': {
                  allow: true,
                  dangerous: true,
                  scopes: ['relation'],
                  constraints: { allowedConfigKeys: ['roles.assigned'] },
                },
                'config.show': { allow: true, dangerous: true, scopes: ['relation'] },
              },
            },
            broad: {
              description: 'Broad dangerous config role',
              allowAccess: true,
              permissions: {},
              commandPermissions: {
                'config.*': { allow: true, dangerous: true, scopes: ['relation'] },
                'dangerous:*': { allow: true, dangerous: true, scopes: ['relation'] },
              },
            },
          },
        },
      }, { self: 'danger.agentid.pub' });
      const context: Omit<CommandAuthorizationContext, 'intent'> = {
        actorId: 'member1',
        chatType: 'private',
        selfAid: 'danger.agentid.pub',
        peerKey: 'aun#member1',
        role: 'exact',
        source: 'agent-tool',
      };
      expect(authorizeConfigCommand([
        'config', 'set', 'roles.assigned', 'member',
        '--self', 'danger.agentid.pub', '--peer', 'aun#member1',
      ], context).allow).toBe(true);
      expect(authorizeConfigCommand([
        'config', 'show', '--self', 'danger.agentid.pub', '--peer', 'aun#member1',
      ], context).allow).toBe(true);

      for (const argv of [
        ['config', 'set', 'roles.assigned', 'member', '--self', 'danger.agentid.pub', '--peer', 'aun#member1'],
        ['config', 'show', '--self', 'danger.agentid.pub', '--peer', 'aun#member1'],
      ]) {
        const denied = authorizeConfigCommand(argv, { ...context, role: 'broad' });
        expect(denied.allow).toBe(false);
        if (!denied.allow) expect(denied.code).toBe('DANGEROUS_NOT_GRANTED');
      }
    });

    it('includes field config operations in the user-plane ceiling only', () => {
      expect(USER_PLANE_CAPABILITY_CEILING.allowOperations.has('config.get')).toBe(true);
      expect(USER_PLANE_CAPABILITY_CEILING.allowOperations.has('config.set')).toBe(true);
      expect(USER_PLANE_CAPABILITY_CEILING.allowOperations.has('config.unset')).toBe(true);
      expect(USER_PLANE_CAPABILITY_CEILING.allowOperations.has('config.write')).toBe(false);
    });
  });

  describe('No role permissions', () => {
    const anonContext: CommandAuthorizationContext = {
      intent: {
        operation: 'model.list',
        scope: 'relation',
        source: 'menu.cli',
        args: {},
      },
      role: 'none',
      isDaemonOwner: false,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should deny none all operations', () => {
      const decision = authorizeCommand(anonContext);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ROLE_ACCESS_DENIED');
      }
    });

    it('maps a daemon owner to an effective owner before inbound access checks', () => {
      const subject = buildAuthSubject({
        selfAid: 'agent1',
        actorId: 'daemon-owner',
        channel: 'aun',
        channelType: 'aun',
        channelId: 'daemon-owner',
        chatType: 'private',
        processOwners: ['daemon-owner'],
        roleDetail: {
          effectiveRole: null,
          source: 'none',
          isAuthenticated: true,
          allowAccess: false,
          roleExists: false,
        },
      });
      expect(subject).toMatchObject({ role: 'owner', isDaemonOwner: true, allowAccess: true });
      expect(subject.identity.role).toBe('owner');
      expect(authorizeAccess(subject).allow).toBe(true);
    });
  });

  describe('Rule matching priority', () => {
    it('should match exact operation over wildcard', () => {
      // This would require a custom role config, testing the logic
      const ctx: CommandAuthorizationContext = {
        intent: {
          operation: 'model.list',
          scope: 'relation',
          source: 'menu.cli',
          args: {},
        },
        role: 'visitor',
        isDaemonOwner: false,
        fromControlChannel: false,
        chatType: 'private',
        selfAid: 'agent1',
        actorId: 'user1',
        peerKey: 'aun::user1',
        source: 'menu.cli',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(true);
      if (decision.allow) {
        expect(decision.matchedRule).toBe('model.list');
      }
    });
  });

  describe('Scope validation', () => {
    it('should deny when scope is not in allowed scopes', () => {
      const ctx: CommandAuthorizationContext = {
        intent: {
          operation: 'model.list',
          scope: 'process', // visitor's model.list only allows 'relation'
          source: 'menu.cli',
          args: {},
        },
        role: 'visitor',
        isDaemonOwner: false,
        fromControlChannel: false,
        source: 'menu.cli',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('SCOPE_MISMATCH');
      }
    });
  });

  describe('Security semantics', () => {
    it('should deny operation from unsupported source', () => {
      const ctx: CommandAuthorizationContext = {
        intent: {
          operation: 'cli.exec.raw',
          scope: 'raw-cli',
          source: 'control',
          args: {},
          dangerous: true,
        },
        role: 'owner',
        isDaemonOwner: true,
        fromControlChannel: true,
        source: 'control',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('NOT_ALLOWED');
      }
    });

    it('should not allow dangerous operations through ordinary wildcard', () => {
      const ctx: CommandAuthorizationContext = {
        intent: {
          operation: 'cli.exec.raw',
          scope: 'raw-cli',
          source: 'menu.cli',
          args: {},
          dangerous: true,
        },
        role: 'member',
        isDaemonOwner: false,
        fromControlChannel: false,
        source: 'menu.cli',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
    });

    it('should authorize role assignment operations through command permissions', () => {
      const ownerDecision = authorizeCommand({
        intent: {
          operation: 'role.assign',
          scope: 'agent',
          source: 'ecweb',
          args: { targetRole: 'admin' },
        },
        actorId: 'owner.aid.pub',
        selfAid: 'agent1',
        role: 'owner',
        source: 'ecweb',
      }, { self: 'agent1' });
      expect(ownerDecision.allow).toBe(true);

      const memberDecision = authorizeCommand({
        intent: {
          operation: 'role.assign',
          scope: 'agent',
          source: 'ecweb',
          args: { targetRole: 'visitor' },
        },
        actorId: 'member.aid.pub',
        selfAid: 'agent1',
        role: 'member',
        source: 'ecweb',
      }, { self: 'agent1' });
      expect(memberDecision.allow).toBe(false);
      if (!memberDecision.allow) {
        expect(memberDecision.code).toBe('NOT_ALLOWED');
      }
    });

    it('should enforce configured config key and prefix constraints', () => {
      write(ConfigTarget.Agent, {
        aid: 'agent1.agentid.pub',
        channels: [],
        roles: {
          definitions: {
            constrained: {
              description: 'constraint test role',
              allowAccess: true,
              permissions: {},
              commandPermissions: {
                'file.fetch': {
                  allow: true,
                  scopes: ['filesystem'],
                  constraints: { allowedPrefixes: ['/safe/'] },
                },
              },
            },
          },
        },
      }, { self: 'agent1.agentid.pub' });
      clearRolesCache();

      expect(authorizeCommand({
        intent: {
          operation: 'file.fetch',
          scope: 'filesystem',
          source: 'menu',
          args: { filePath: '/safe/report.txt' },
        },
        selfAid: 'agent1.agentid.pub',
        role: 'constrained',
        source: 'menu',
      }).allow).toBe(true);

      const badPrefixDecision = authorizeCommand({
        intent: {
          operation: 'file.fetch',
          scope: 'filesystem',
          source: 'menu',
          args: { filePath: '/etc/passwd' },
        },
        selfAid: 'agent1.agentid.pub',
        role: 'constrained',
        source: 'menu',
      });
      expect(badPrefixDecision.allow).toBe(false);
      if (!badPrefixDecision.allow) {
        expect(badPrefixDecision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should allow user roles only within USER_PLANE_CAPABILITY_CEILING', () => {
      expect(USER_PLANE_CAPABILITY_CEILING.allowOperations.has('session.rename')).toBe(true);
      expect(USER_PLANE_CAPABILITY_CEILING.allowOperations.has('session.delete')).toBe(false);

      write(ConfigTarget.Agent, {
        aid: 'ceiling.agentid.pub',
        channels: [],
        roles: {
          definitions: {
            broad: {
              description: 'broad user role',
              allowAccess: true,
              permissions: {},
              commandPermissions: {
                'session.rename': { allow: true, scopes: ['relation'] },
                'session.delete': { allow: true, scopes: ['relation'] },
                'system.status': { allow: true, scopes: ['process'] },
                'agent.show': { allow: true, scopes: ['agent'] },
                'aid.lookupRemote': { allow: true, scopes: ['control'] },
              },
            },
          },
        },
      }, { self: 'ceiling.agentid.pub' });
      clearRolesCache();

      expect(authorizeCommand({
        intent: {
          operation: 'session.rename',
          scope: 'relation',
          source: 'slash',
          args: {},
        },
        selfAid: 'ceiling.agentid.pub',
        role: 'broad',
        source: 'slash',
      }).allow).toBe(true);

      for (const intent of [
        { operation: 'session.delete', scope: 'relation', source: 'slash' },
        { operation: 'system.status', scope: 'process', source: 'slash' },
        { operation: 'agent.show', scope: 'agent', source: 'menu.cli' },
        { operation: 'aid.lookupRemote', scope: 'control', source: 'menu.cli' },
      ] as const) {
        const decision = authorizeCommand({
          intent: {
            ...intent,
            args: {},
          },
          selfAid: 'ceiling.agentid.pub',
          role: 'broad',
          source: intent.source,
        });
        expect(decision.allow).toBe(false);
        if (!decision.allow) {
          expect(decision.code).toBe('NOT_ALLOWED');
          expect(decision.reason).toContain('outside the user permission plane');
        }
      }
    });

    it('should not apply user-plane ceiling to management roles', () => {
      const decision = authorizeCommand({
        intent: {
          operation: 'system.status',
          scope: 'process',
          source: 'slash',
          args: {},
        },
        role: 'owner',
        isDaemonOwner: false,
        source: 'slash',
      });

      expect(decision.allow).toBe(true);
    });

    it('should keep role assignment outside the user permission plane', () => {
      write(ConfigTarget.Agent, {
        aid: 'agent1.agentid.pub',
        channels: [],
        roles: {
          definitions: {
            sensitive: {
              description: 'explicit grant test role',
              allowAccess: true,
              permissions: {},
              commandPermissions: {
                'role.assign': {
                  allow: true,
                  scopes: ['agent'],
                  constraints: { requireExplicitDangerousGrant: true },
                },
              },
            },
          },
        },
      }, { self: 'agent1.agentid.pub' });
      clearRolesCache();

      const decision = authorizeCommand({
        intent: {
          operation: 'role.assign',
          scope: 'agent',
          source: 'ecweb',
          args: { targetRole: 'visitor' },
        },
        selfAid: 'agent1.agentid.pub',
        role: 'sensitive',
        source: 'ecweb',
      });
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('NOT_ALLOWED');
      }
    });
  });
});
