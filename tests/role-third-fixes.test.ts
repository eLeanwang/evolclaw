import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigTarget, ensureFile, resolveEffective, write } from '../src/config/config-manager.js';

describe('resolveEffective role constraints', () => {
  const aid = 'effective.agentid.pub';
  const peerKey = 'aun#group_conversation';

  beforeEach(() => {
    ensureFile(ConfigTarget.Agent, { self: aid });
    write(ConfigTarget.Agent, { aid, channels: [] }, { self: aid });
  });

  it('allows owner-level relation behavior when role is explicit', () => {
    // v3: RelationBehavior → Relation
    write(
      ConfigTarget.Relation,
      {
        mentionMode: 'disabled',
        chatmode: { private: 'proactive' },
        baseagents: { claude: { model: 'claude-opus-4-8' } },
      },
      { self: aid, peerKey },
    );

    const effective = resolveEffective({ self: aid, peerKey, role: 'owner' });
    expect(effective.mentionMode).toBe('disabled');
    expect(effective.chatmode?.private).toBe('proactive');
    expect(effective.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });

  it('only constrains visitor permission mode when role is explicit', () => {
    // v3: RelationBehavior → Relation
    write(
      ConfigTarget.Relation,
      {
        permissionMode: 'bypass',
        mentionMode: 'disabled',
        baseagents: { claude: { model: 'claude-opus-4-8' } },
      },
      { self: aid, peerKey },
    );

    const effective = resolveEffective({ self: aid, peerKey, role: 'visitor' });
    expect(effective.permissionMode).toBe('readonly');
    expect(effective.mentionMode).toBe('disabled');
    expect(effective.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });

  it('keeps raw relation behavior when role is not supplied', () => {
    // v3: RelationBehavior → Relation
    write(
      ConfigTarget.Relation,
      {
        permissionMode: 'bypass',
        mentionMode: 'disabled',
        baseagents: { claude: { model: 'claude-opus-4-8' } },
      },
      { self: aid, peerKey },
    );

    const effective = resolveEffective({ self: aid, peerKey });
    expect(effective.permissionMode).toBe('bypass');
    expect(effective.mentionMode).toBe('disabled');
    expect(effective.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });

  it('applies all builtin role defaults consistently', () => {
    const roles = ['owner', 'admin', 'member', 'visitor', 'none'] as const;
    const results = roles.map(role => ({
      role,
      effective: resolveEffective({ self: aid, peerKey, role }),
    }));

    expect(results[0].effective.permissionMode).toBe('bypass');
    expect(results[1].effective.permissionMode).toBe('request');
    expect(results[2].effective.permissionMode).toBe('auto');
    expect(results[3].effective.permissionMode).toBe('readonly');
    expect(results[4].effective.permissionMode).toBeUndefined();
  });
});
