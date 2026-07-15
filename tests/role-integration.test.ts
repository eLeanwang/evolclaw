import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigTarget,
  ensureFile,
  resolveEffective,
  validateConfigWrite,
  write,
} from '../src/config/config-manager.js';

describe('role constraints integration', () => {
  const aid = 'integration.agentid.pub';
  const peerKey = 'aun#integration.agentid.pub#main';

  beforeEach(() => {
    ensureFile(ConfigTarget.Agent, { self: aid });
    write(ConfigTarget.Agent, { aid, channels: [] }, { self: aid });
  });

  it('applies role constraints only from the explicit selector role', () => {
    // v3: RelationBehavior → Relation（行为参数统一到 config.json）
    write(
      ConfigTarget.Relation,
      {
        permissionMode: 'bypass',
        baseagents: { claude: { model: 'claude-opus-4-8' } },
        mentionMode: 'disabled',
      },
      { self: aid, peerKey },
    );

    const visitorEffective = resolveEffective({ self: aid, peerKey, role: 'visitor' });
    expect(visitorEffective.permissionMode).toBe('readonly');
    expect(visitorEffective.baseagents?.claude?.model).toBe('claude-opus-4-8');
    expect(visitorEffective.mentionMode).toBe('disabled');

    const ownerEffective = resolveEffective({ self: aid, peerKey, role: 'owner' });
    expect(ownerEffective.permissionMode).toBe('bypass');
    expect(ownerEffective.baseagents?.claude?.model).toBe('claude-opus-4-8');
    expect(ownerEffective.mentionMode).toBe('disabled');
  });

  it('does not infer a role from peerKey when selector role is missing', () => {
    // v3: RelationBehavior → Relation
    write(
      ConfigTarget.Relation,
      { permissionMode: 'bypass', baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: aid, peerKey },
    );

    const effective = resolveEffective({ self: aid, peerKey });
    expect(effective.permissionMode).toBe('bypass');
    expect(effective.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });

  it('validates relation behavior writes only with provided role', () => {
    // v3: RelationBehavior → Relation
    const ownerResult = validateConfigWrite(
      ConfigTarget.Relation,
      { permissionMode: 'bypass' },
      { self: aid, peerKey, role: 'owner' },
    );
    expect(ownerResult.valid).toBe(true);

    const defaultResult = validateConfigWrite(
      ConfigTarget.Relation,
      { permissionMode: 'bypass' },
      { self: aid, peerKey },
    );
    expect(defaultResult.valid).toBe(true);
    expect(defaultResult.effectiveConfig.permissionMode).toBe('bypass');
  });

  it('does not apply constraints when peerKey is missing', () => {
    const effective = resolveEffective({ self: aid });
    expect(effective.aid).toBe(aid);
  });
});
