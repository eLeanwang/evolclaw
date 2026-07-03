import { describe, it, expect } from 'vitest';
import { parseEcOperationId, authorizeEcCommand } from '../../../src/core/command/ec-command-permission.js';
import type { EcCommandAuthorizationContext } from '../../../src/core/command/ec-command-permission.js';

describe('EC Command Permission', () => {
  describe('parseEcOperationId', () => {
    it('should parse ec msg send', () => {
      expect(parseEcOperationId('ec msg send self.aid peer.aid')).toBe('ec.msg.send');
    });

    it('should parse ec msg file', () => {
      expect(parseEcOperationId('ec msg file self.aid peer.aid /path/to/file')).toBe('ec.msg.file');
    });

    it('should parse ec group send', () => {
      expect(parseEcOperationId('ec group send self.aid group123')).toBe('ec.group.send');
    });

    it('should parse ec group file', () => {
      expect(parseEcOperationId('ec group file self.aid group123 /path/to/file')).toBe('ec.group.file');
    });

    it('should parse ec ctl send', () => {
      expect(parseEcOperationId('ec ctl send')).toBe('ec.ctl.send');
    });

    it('should parse ec ctl file', () => {
      expect(parseEcOperationId('ec ctl file /path/to/file')).toBe('ec.ctl.file');
    });

    it('should parse evolclaw variant', () => {
      expect(parseEcOperationId('evolclaw msg send self.aid peer.aid')).toBe('ec.msg.send');
      expect(parseEcOperationId('evolclaw ctl send')).toBe('ec.ctl.send');
    });

    it('should return null for non-ec commands', () => {
      expect(parseEcOperationId('ls -la')).toBeNull();
      expect(parseEcOperationId('npm install')).toBeNull();
      expect(parseEcOperationId('git status')).toBeNull();
    });

    it('should return null for unrecognized ec subcommands', () => {
      // ec ctl status / ec ctl queue 暂不纳入本次范围
      expect(parseEcOperationId('ec ctl status')).toBeNull();
      expect(parseEcOperationId('ec ctl queue')).toBeNull();
    });

    it('should return null for malformed ec commands', () => {
      expect(parseEcOperationId('ec')).toBeNull();
      expect(parseEcOperationId('ec msg')).toBeNull();
      expect(parseEcOperationId('ec msg send')).toBeNull(); // 缺少 targetId
    });

    it('should return null for shell control characters', () => {
      expect(parseEcOperationId('ec msg send a b; rm -rf /')).toBeNull();
      expect(parseEcOperationId('ec msg send a b | grep x')).toBeNull();
    });
  });

  describe('authorizeEcCommand', () => {
    const baseContext: EcCommandAuthorizationContext = {
      actorId: 'user1',
      channel: 'aun#user1',
      channelId: 'user1',
      chatType: 'private',
      selfAid: 'agent1.agentid.pub',
      peerKey: 'aun::user1',
      role: 'member',
      isDaemonOwner: false,
      fromControlChannel: false,
    };

    it('should allow member to use ec msg send with ownPeerOnly', () => {
      const decision = authorizeEcCommand('ec msg send agent1.agentid.pub user1 hello', baseContext);
      expect(decision).not.toBeNull();
      expect(decision?.allow).toBe(true);
      if (decision?.allow) {
        expect(decision.operation).toBe('ec.msg.send');
        expect(decision.role).toBe('member');
      }
    });

    it('should deny member ec msg send to other peer (ownPeerOnly constraint)', () => {
      const decision = authorizeEcCommand('ec msg send agent1.agentid.pub other-user hello', baseContext);
      expect(decision).not.toBeNull();
      if (!decision) return;
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
        expect(decision.reason).toContain('Only the actor peer can be targeted');
      }
    });

    it('should allow member ec group send in group chat', () => {
      const groupContext: EcCommandAuthorizationContext = {
        ...baseContext,
        chatType: 'group',
        channelId: 'group123',
      };
      const decision = authorizeEcCommand('ec group send agent1.agentid.pub group123 hello', groupContext);
      expect(decision).not.toBeNull();
      expect(decision?.allow).toBe(true);
      if (decision?.allow) {
        expect(decision.operation).toBe('ec.group.send');
      }
    });

    it('should deny member ec group send in private chat (groupOnly constraint)', () => {
      const decision = authorizeEcCommand('ec group send agent1.agentid.pub group123 hello', baseContext);
      expect(decision).not.toBeNull();
      if (!decision) return;
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.code).toBe('ARGUMENT_MISMATCH');
        expect(decision.reason).toContain('only allowed in group chats');
      }
    });

    it('should deny member ec ctl send (explicit deny in builtin-roles)', () => {
      const decision = authorizeEcCommand('ec ctl send', baseContext);
      expect(decision).not.toBeNull();
      if (!decision) return;
      expect(decision.allow).toBe(false);
      if (!decision.allow) {
        expect(decision.operation).toBe('ec.ctl.send');
      }
    });

    it('should allow guest ec msg send with strict constraints', () => {
      const guestContext: EcCommandAuthorizationContext = {
        ...baseContext,
        role: 'guest',
      };
      const decision = authorizeEcCommand('ec msg send agent1.agentid.pub user1 hello', guestContext);
      expect(decision).not.toBeNull();
      expect(decision?.allow).toBe(true);
      if (decision?.allow) {
        expect(decision.role).toBe('guest');
      }
    });

    it('should deny guest ec msg file (explicit deny in builtin-roles)', () => {
      const guestContext: EcCommandAuthorizationContext = {
        ...baseContext,
        role: 'guest',
      };
      const decision = authorizeEcCommand('ec msg file agent1.agentid.pub user1 /tmp/file', guestContext);
      expect(decision).not.toBeNull();
      if (!decision) return;
      expect(decision.allow).toBe(false);
    });

    it('should deny guest ec group send (explicit deny)', () => {
      const guestContext: EcCommandAuthorizationContext = {
        ...baseContext,
        role: 'guest',
        chatType: 'group',
      };
      const decision = authorizeEcCommand('ec group send agent1.agentid.pub group123 hello', guestContext);
      expect(decision).not.toBeNull();
      if (!decision) return;
      expect(decision.allow).toBe(false);
    });

    it('should return null for non-ec commands', () => {
      const decision = authorizeEcCommand('ls -la', baseContext);
      expect(decision).toBeNull();
    });

    it('should return null for unrecognized ec subcommands', () => {
      const decision = authorizeEcCommand('ec ctl status', baseContext);
      expect(decision).toBeNull();
    });
  });
});
