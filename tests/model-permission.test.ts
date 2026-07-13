import { describe, expect, it, beforeEach } from 'vitest';
import {
  constrainResolvedModelForRole,
  filterModelsForRole,
  isModelAllowedForRoleBaseagent,
  validateModelSelectionForRole,
} from '../src/core/model/model-permission.js';
import { clearRolesCache } from '../src/config/roles.js';
import { ConfigTarget, write } from '../src/config/config-manager.js';

describe('model permission helpers', () => {
  beforeEach(() => {
    clearRolesCache();
  });

  const catalog = [
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'deepseek-v4-pro',
  ];

  it('does not filter the model catalog by role', () => {
    expect(filterModelsForRole('member', 'claude', catalog)).toEqual(catalog);
    expect(filterModelsForRole('visitor', 'claude', catalog)).toEqual(catalog);
    expect(filterModelsForRole('owner', 'claude', catalog)).toEqual(catalog);
  });

  it('allows alias when resolved model matches an allowed pattern', () => {
    const resolveModelId = (model: string) => model === 'sonnet' ? 'claude-sonnet-4-6' : model;
    expect(isModelAllowedForRoleBaseagent('member', 'claude', 'sonnet', resolveModelId)).toBe(true);
    expect(validateModelSelectionForRole({
      role: 'member',
      baseagent: 'claude',
      requestedModel: 'sonnet',
      models: catalog,
      resolveModelId,
    })).toMatchObject({ ok: true, model: 'claude-sonnet-4-6' });
  });

  it('allows model selections independently of role', () => {
    expect(validateModelSelectionForRole({
      role: 'member',
      baseagent: 'claude',
      requestedModel: 'claude-opus-4-8',
      models: catalog,
    })).toMatchObject({ ok: true, model: 'claude-opus-4-8' });
  });

  it('does not constrain resolved models by role', () => {
    expect(filterModelsForRole('visitor', 'claude', catalog)).toEqual(catalog);
    expect(validateModelSelectionForRole({
      role: 'visitor',
      baseagent: 'claude',
      requestedModel: 'claude-haiku-4-5-20251001',
      models: catalog,
    })).toMatchObject({ ok: true, model: 'claude-haiku-4-5-20251001' });
    expect(constrainResolvedModelForRole({
      role: 'visitor',
      baseagent: 'claude',
      model: 'claude-opus-4-8',
    })).toEqual({ model: 'claude-opus-4-8', constrained: false });
  });

  it('lists all allowed models even when override is disabled', () => {
    const selfAid = 'models.agentid.pub';
    write(ConfigTarget.Agent, {
      aid: selfAid,
      channels: [],
      roles: {
        definitions: {
          visitor: {
            description: 'visitor override',
            permissions: {
              'baseagents.claude.model': {
                default: 'claude-haiku-4-5-20251001',
                allowOverride: false,
                allowedModels: ['claude-haiku-*', 'claude-opus-4-8'],
              },
            },
          },
        },
      },
    }, { self: selfAid });
    clearRolesCache();

    expect(filterModelsForRole('visitor', 'claude', catalog, undefined, selfAid)).toEqual([
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ]);
    expect(validateModelSelectionForRole({
      role: 'visitor',
      baseagent: 'claude',
      requestedModel: 'claude-opus-4-8',
      models: catalog,
      selfAid,
    })).toMatchObject({ ok: false, code: 'MODEL_OVERRIDE_DISABLED' });
  });

  it('does not constrain non-claude baseagents without role permissions', () => {
    expect(filterModelsForRole('visitor', 'codex', ['gpt-5', 'gpt-5-mini'])).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(validateModelSelectionForRole({
      role: 'visitor',
      baseagent: 'codex',
      requestedModel: 'gpt-5',
      models: ['gpt-5'],
    })).toMatchObject({ ok: true, model: 'gpt-5' });
  });
});
