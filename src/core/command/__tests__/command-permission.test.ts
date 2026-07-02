import { describe, it, expect, beforeEach } from 'vitest';
import { authorizeCommand } from '../command-permission.js';
import { ConfigTarget, write } from '../../../config/config-manager.js';
import { clearRolesCache } from '../../../config/roles.js';
import type { CommandAuthorizationContext } from '../../../types.js';

describe('Command Permission', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  describe('Guest role permissions', () => {
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
      role: 'guest',
      isDaemonOwner: false,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should allow guest to execute model.list with proper constraints', () => {
      const decision = authorizeCommand(baseContext);
      expect(decision.allow).toBe(true);
      if (decision.allow) {
        expect(decision.operation).toBe('model.list');
        expect(decision.role).toBe('guest');
      }
    });

    it('should allow guest model.current', () => {
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

    it('should deny guest model.use because field override is not allowed', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        intent: {
          ...baseContext.intent,
          operation: 'model.use',
          args: { self: 'agent1', peer: 'user1', model: 'claude-haiku-4-5-20251001' },
        },
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should deny guest cli.exec.raw', () => {
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

    it('should deny guest when ownPeerOnly constraint fails', () => {
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

    it('should deny guest when ownAgentOnly constraint fails', () => {
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

    it('should deny guest in group chat (privateOnly)', () => {
      const ctx: CommandAuthorizationContext = {
        ...baseContext,
        chatType: 'group',
      };
      const decision = authorizeCommand(ctx);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should deny guest model.list when cli scope falls back to agent', () => {
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

  describe('Anonymous role permissions', () => {
    const anonContext: CommandAuthorizationContext = {
      intent: {
        operation: 'model.list',
        scope: 'relation',
        source: 'menu.cli',
        args: {},
      },
      role: 'anonymous',
      isDaemonOwner: false,
      fromControlChannel: false,
      source: 'menu.cli',
    };

    it('should deny anonymous all operations', () => {
      const decision = authorizeCommand(anonContext);
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ROLE_ACCESS_DENIED');
      }
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
        role: 'guest',
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
          scope: 'process', // guest's model.list only allows 'relation'
          source: 'menu.cli',
          args: {},
        },
        role: 'guest',
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
      });
      expect(ownerDecision.allow).toBe(true);

      const memberDecision = authorizeCommand({
        intent: {
          operation: 'role.assign',
          scope: 'agent',
          source: 'ecweb',
          args: { targetRole: 'guest' },
        },
        actorId: 'member.aid.pub',
        selfAid: 'agent1',
        role: 'member',
        source: 'ecweb',
      });
      expect(memberDecision.allow).toBe(false);
      if (!memberDecision.allow) {
        expect(memberDecision.code).toBe('NOT_ALLOWED');
      }
    });

    it('should enforce configured config key and prefix constraints', () => {
      write(ConfigTarget.Roles, {
        $schema_version: 4,
        defaultRoles: { private: 'anonymous', group: 'guest' },
        roles: {
          constrained: {
            description: 'constraint test role',
            allowAccess: true,
            permissions: {},
            commandPermissions: {
              'config.write': {
                allow: true,
                dangerous: true,
                scopes: ['process'],
                constraints: { allowedConfigKeys: ['debug.logLevel'] },
              },
              'file.fetch': {
                allow: true,
                scopes: ['filesystem'],
                constraints: { allowedPrefixes: ['/safe/'] },
              },
            },
          },
        },
      });
      clearRolesCache();

      expect(authorizeCommand({
        intent: {
          operation: 'config.write',
          scope: 'process',
          source: 'menu',
          args: { key: 'debug.logLevel' },
        },
        role: 'constrained',
        source: 'menu',
      }).allow).toBe(true);

      const badKeyDecision = authorizeCommand({
        intent: {
          operation: 'config.write',
          scope: 'process',
          source: 'menu',
          args: { key: 'owners' },
        },
        role: 'constrained',
        source: 'menu',
      });
      expect(badKeyDecision.allow).toBe(false);
      if (!badKeyDecision.allow) {
        expect(badKeyDecision.code).toBe('ARGUMENT_MISMATCH');
      }

      expect(authorizeCommand({
        intent: {
          operation: 'file.fetch',
          scope: 'filesystem',
          source: 'menu',
          args: { filePath: '/safe/report.txt' },
        },
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
        role: 'constrained',
        source: 'menu',
      });
      expect(badPrefixDecision.allow).toBe(false);
      if (!badPrefixDecision.allow) {
        expect(badPrefixDecision.code).toBe('ARGUMENT_MISMATCH');
      }
    });

    it('should enforce requireExplicitDangerousGrant when declared on a permission', () => {
      write(ConfigTarget.Roles, {
        $schema_version: 4,
        defaultRoles: { private: 'anonymous', group: 'guest' },
        roles: {
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
      });
      clearRolesCache();

      const decision = authorizeCommand({
        intent: {
          operation: 'role.assign',
          scope: 'agent',
          source: 'ecweb',
          args: { targetRole: 'guest' },
        },
        role: 'sensitive',
        source: 'ecweb',
      });
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('DANGEROUS_NOT_GRANTED');
      }
    });
  });
});
