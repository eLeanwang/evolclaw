import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigTarget, ensureFile, validateConfigWrite, write } from '../src/config/config-manager.js';
import { resolveEffectiveModel, resolvePermissionMode } from '../src/core/model/config-scope.js';

describe('role selector runtime behavior', () => {
  const aid = 'selector.agentid.pub';
  const peerKey = 'aun#selector.agentid.pub#main';

  beforeEach(() => {
    ensureFile(ConfigTarget.Agent, { self: aid });
    write(ConfigTarget.Agent, { aid, channels: [] }, { self: aid });
  });

  it('uses sel.role for permission mode constraints', () => {
    // v3: RelationBehavior → Relation
    write(ConfigTarget.Relation, { permissionMode: 'bypass' }, { self: aid, peerKey });

    expect(resolvePermissionMode({ self: aid, peerKey, role: 'owner' })).toBe('bypass');
    expect(resolvePermissionMode({ self: aid, peerKey, role: 'admin' })).toBe('request');
    expect(resolvePermissionMode({ self: aid, peerKey, role: 'visitor' })).toBe('readonly');
  });

  it('does not infer a role when sel.role is absent', () => {
    // v3: RelationBehavior → Relation
    write(ConfigTarget.Relation, { permissionMode: 'bypass' }, { self: aid, peerKey });

    expect(resolvePermissionMode({ self: aid, peerKey })).toBe('bypass');
  });

  it('does not use sel.role to override model configuration', () => {
    // v3: RelationBehavior → Relation
    write(
      ConfigTarget.Relation,
      { baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: aid, peerKey },
    );

    expect(resolveEffectiveModel({ self: aid, peerKey, role: 'owner' }, 'claude').model).toBe('claude-opus-4-8');
    expect(resolveEffectiveModel({ self: aid, peerKey, role: 'member' }, 'claude').model).toBe('claude-opus-4-8');
    expect(resolveEffectiveModel({ self: aid, peerKey, role: 'visitor' }, 'claude').model).toBe('claude-opus-4-8');
  });

  it('leaves model unset when agent and relation model config are empty', () => {
    expect(resolveEffectiveModel({ self: aid, peerKey, role: 'visitor' }, 'claude')).toMatchObject({
      model: undefined,
      effort: undefined,
    });
  });

  it('allows nested relation model config regardless of selector role', () => {
    // v3: RelationBehavior → Relation
    const validation = validateConfigWrite(
      ConfigTarget.Relation,
      { baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: aid, peerKey, role: 'visitor' },
    );

    expect(validation.valid).toBe(true);
    expect(validation.effectiveConfig.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });
});
