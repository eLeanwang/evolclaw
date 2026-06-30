import { describe, expect, it, beforeEach } from 'vitest';
import {
  constrainResolvedModelForRole,
  filterModelsForRole,
  isModelAllowedForRoleBaseagent,
  validateModelSelectionForRole,
} from '../src/core/model/model-permission.js';
import { clearRolesCache, getBuiltinRolesConfig } from '../src/config/roles.js';
import { writeRoles } from '../src/config/config-manager.js';

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

  it('filters model catalog by role allowedModels', () => {
    expect(filterModelsForRole('member', 'claude', catalog)).toEqual([
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
    expect(filterModelsForRole('guest', 'claude', catalog)).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
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

  it('rejects disallowed model selections', () => {
    expect(validateModelSelectionForRole({
      role: 'member',
      baseagent: 'claude',
      requestedModel: 'claude-opus-4-8',
      models: catalog,
    })).toMatchObject({ ok: false, code: 'MODEL_NOT_ALLOWED' });
  });

  it('rejects model switching when override is disabled', () => {
    expect(filterModelsForRole('guest', 'claude', catalog)).toEqual(['claude-haiku-4-5-20251001']);
    expect(validateModelSelectionForRole({
      role: 'guest',
      baseagent: 'claude',
      requestedModel: 'claude-haiku-4-5-20251001',
      models: catalog,
    })).toMatchObject({ ok: false, code: 'MODEL_OVERRIDE_DISABLED' });
    expect(constrainResolvedModelForRole({
      role: 'guest',
      baseagent: 'claude',
      model: 'claude-opus-4-8',
    })).toEqual({ model: 'claude-haiku-4-5-20251001', constrained: true });
  });

  it('lists all allowed models even when override is disabled', () => {
    const roles = getBuiltinRolesConfig();
    roles.roles.guest.permissions['baseagents.claude.model'] = {
      default: 'claude-haiku-4-5-20251001',
      allowOverride: false,
      allowedModels: ['claude-haiku-*', 'claude-opus-4-8'],
    };
    writeRoles(roles);
    clearRolesCache();

    expect(filterModelsForRole('guest', 'claude', catalog)).toEqual([
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ]);
    expect(validateModelSelectionForRole({
      role: 'guest',
      baseagent: 'claude',
      requestedModel: 'claude-opus-4-8',
      models: catalog,
    })).toMatchObject({ ok: false, code: 'MODEL_OVERRIDE_DISABLED' });
  });

  it('does not constrain non-claude baseagents without role permissions', () => {
    expect(filterModelsForRole('guest', 'codex', ['gpt-5', 'gpt-5-mini'])).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(validateModelSelectionForRole({
      role: 'guest',
      baseagent: 'codex',
      requestedModel: 'gpt-5',
      models: ['gpt-5'],
    })).toMatchObject({ ok: true, model: 'gpt-5' });
  });
});
