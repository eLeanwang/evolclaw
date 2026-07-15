import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigTarget,
  ensureFile,
  resolveEffectiveFieldWithSource,
  resolveEffectiveWithSources,
  validateConfigWrite,
  write,
} from '../src/config/config-manager.js';
import { executeResolvedConfigCommand } from '../src/config/config-operation-service.js';
import { resolveConfigCommand } from '../src/config/resolved-config-op.js';
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

  it('attributes a role-locked permission to the role policy', () => {
    write(ConfigTarget.Relation, { permissionMode: 'bypass' }, { self: aid, peerKey });

    expect(resolveEffectiveFieldWithSource('permissionMode', {
      self: aid,
      peerKey,
      role: 'admin',
    })).toMatchObject({ value: 'request', source: 'role' });
  });

  it('uses the same effective source resolver for ec config get', () => {
    write(ConfigTarget.Relation, { permissionMode: 'bypass' }, { self: aid, peerKey });
    const resolved = resolveConfigCommand([
      'config',
      'get',
      'permissionMode',
      '--self',
      aid,
      '--peer',
      peerKey,
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(executeResolvedConfigCommand(resolved.command, { role: 'admin' })).toMatchObject({
      ok: true,
      subcommand: 'get',
      value: 'request',
      source: { target: 'role' },
    });

    const effective = resolveConfigCommand([
      'config',
      'effective',
      '--self',
      aid,
      '--peer',
      peerKey,
    ]);
    expect(effective.ok).toBe(true);
    if (!effective.ok) return;
    expect(executeResolvedConfigCommand(effective.command, { role: 'admin' })).toMatchObject({
      ok: true,
      subcommand: 'effective',
      effective: {
        permissionMode: { value: 'request', source: 'role' },
      },
    });
  });

  it('does not infer a role when sel.role is absent', () => {
    // v3: RelationBehavior → Relation
    write(ConfigTarget.Relation, { permissionMode: 'bypass' }, { self: aid, peerKey });

    expect(resolvePermissionMode({ self: aid, peerKey })).toBe('bypass');
  });

  it('uses fail-closed built-in defaults when no permission mode is configured', () => {
    expect(resolvePermissionMode({ self: aid, role: 'owner' })).toBe('bypass');
    expect(resolvePermissionMode({ self: aid, role: 'admin' })).toBe('request');
    expect(resolvePermissionMode({ self: aid, role: 'member' })).toBe('auto');
    expect(resolvePermissionMode({ self: aid, role: 'visitor' })).toBe('readonly');
    expect(resolvePermissionMode({ self: aid, role: 'none' })).toBe('readonly');
    expect(resolvePermissionMode({ self: aid })).toBe('readonly');
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
    expect(resolveEffectiveFieldWithSource('baseagents.claude.model', {
      self: aid,
      peerKey,
      role: 'visitor',
    })).toMatchObject({ value: 'claude-opus-4-8', source: 'relation' });
  });

  it('attributes model and effort fallbacks imposed by a custom role to role', () => {
    write(ConfigTarget.Agent, {
      aid,
      channels: [],
      roles: {
        definitions: {
          reviewer: {
            description: 'Restricted reviewer',
            permissions: {
              'baseagents.claude.model': {
                default: 'claude-sonnet-4-6',
                allowOverride: true,
                allowedModels: ['claude-sonnet-*'],
              },
              'baseagents.claude.effort': {
                default: 'low',
                allowOverride: true,
                allowedValues: ['low', 'medium'],
              },
              'baseagents.codex.model': {
                default: 'gpt-5.4',
                allowOverride: true,
                allowedModels: ['gpt-5.4'],
              },
              'baseagents.codex.reasoning': {
                default: 'medium',
                allowOverride: true,
                allowedValues: ['low', 'medium'],
              },
            },
          },
        },
      },
    }, { self: aid });
    write(ConfigTarget.Relation, {
      baseagents: {
        claude: { model: 'claude-opus-4-8', effort: 'high' },
        codex: { model: 'gpt-5.5', reasoning: 'xhigh' },
      },
    }, { self: aid, peerKey });

    expect(resolveEffectiveFieldWithSource('baseagents.claude.model', {
      self: aid,
      peerKey,
      role: 'reviewer',
    })).toMatchObject({ value: 'claude-sonnet-4-6', source: 'role' });
    expect(resolveEffectiveFieldWithSource('baseagents.claude.effort', {
      self: aid,
      peerKey,
      role: 'reviewer',
    })).toMatchObject({ value: 'low', source: 'role' });
    expect(resolveEffectiveFieldWithSource('baseagents.codex.model', {
      self: aid,
      peerKey,
      role: 'reviewer',
    })).toMatchObject({ value: 'gpt-5.4', source: 'role' });
    expect(resolveEffectiveFieldWithSource('baseagents.codex.reasoning', {
      self: aid,
      peerKey,
      role: 'reviewer',
    })).toMatchObject({ value: 'medium', source: 'role' });

    write(ConfigTarget.Relation, {
      baseagents: { claude: { model: 'claude-sonnet-4-6', effort: 'medium' } },
    }, { self: aid, peerKey });
    expect(resolveEffectiveFieldWithSource('baseagents.claude.model', {
      self: aid,
      peerKey,
      role: 'reviewer',
    })).toMatchObject({ value: 'claude-sonnet-4-6', source: 'relation' });
    expect(resolveEffectiveFieldWithSource('baseagents.claude.effort', {
      self: aid,
      peerKey,
      role: 'reviewer',
    })).toMatchObject({ value: 'medium', source: 'relation' });

    const full = resolveEffectiveWithSources({ self: aid, peerKey, role: 'reviewer' });
    expect(full['baseagents.claude.model']).toMatchObject({
      value: 'claude-sonnet-4-6',
      source: 'relation',
    });
    expect(full['baseagents.codex.model']).toMatchObject({ value: 'gpt-5.4', source: 'role' });
    expect(full['roles.definitions.reviewer.permissions']).toMatchObject({ source: 'agent' });
    expect(full['behavior.baseagents.claude.model']).toBeUndefined();
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
