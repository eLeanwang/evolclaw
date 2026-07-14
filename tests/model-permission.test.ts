import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  constrainResolvedModelForRole,
  filterModelsForRole,
  isModelAllowedForRoleBaseagent,
  validateModelSelectionForRole,
} from '../src/core/model/model-permission.js';
import { clearRolesCache } from '../src/config/roles.js';
import { ConfigTarget, write } from '../src/config/config-manager.js';
import { AgentRunner } from '../src/agents/claude-runner.js';

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

describe('claude model alias fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the last successful alias, keeps it while refreshing, and restores it after restart', async () => {
    const baseUrl = `https://model-alias-${Date.now()}.test`;
    const response = (ids: string[]) => ({
      ok: true,
      json: async () => ({ data: ids.map(id => ({ id })) }),
    } as Response);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(['claude-sonnet-5']));
    const runner = new AgentRunner('test-key', 'sonnet', undefined, baseUrl);

    await runner.listModels();
    expect(runner.resolveModelId('sonnet')).toBe('claude-sonnet-5');

    let finishRefresh!: (value: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise(resolve => {
      finishRefresh = resolve;
    }));
    const refreshedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(refreshedAt + 6 * 60 * 1000);

    await runner.listModels();
    expect(runner.resolveModelId('sonnet')).toBe('claude-sonnet-5');

    finishRefresh(response(['claude-sonnet-6']));
    await new Promise(resolve => setImmediate(resolve));
    expect(runner.resolveModelId('sonnet')).toBe('claude-sonnet-6');

    const cachePath = path.join(process.env.EVOLCLAW_HOME!, 'data', 'claude-model-cache.json');
    const persisted = fs.readFileSync(cachePath, 'utf-8');
    expect(persisted).toContain('claude-sonnet-6');
    expect(persisted).not.toContain(baseUrl);

    vi.resetModules();
    const { AgentRunner: ReloadedAgentRunner } = await import('../src/agents/claude-runner.js');
    const reloadedRunner = new ReloadedAgentRunner('test-key', 'sonnet', undefined, baseUrl);
    expect(reloadedRunner.resolveModelId('sonnet')).toBe('claude-sonnet-6');
    fetchSpy.mockRejectedValue(new Error('gateway unavailable after restart'));
    await expect(reloadedRunner.listModels()).resolves.toContain('claude-sonnet-6');
  });
});
