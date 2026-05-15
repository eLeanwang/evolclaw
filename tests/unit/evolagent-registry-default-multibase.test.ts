import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EvolAgentRegistry } from '../../src/core/evolagent-registry.js';
import type { Config } from '../../src/types.js';

/**
 * R4 fix: buildDefaultAgent must include ALL declared baseagents from
 * evolclaw.json (not just defaultAgent), so AgentLoader creates runners
 * for each and /agent switching works.
 */

describe('EvolAgentRegistry buildDefaultAgent multi-baseagent (R4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-r4-'));
  });

  it('DefaultAgent includes all declared baseagents from globalConfig', () => {
    const registry = new EvolAgentRegistry(tmpDir);
    const config: Config = {
      agents: {
        defaultAgent: 'claude',
        claude: { model: 'sonnet', effort: 'high' },
        codex: { model: 'gpt-5.2' },
        gemini: { model: 'gemini-2.5-flash' },
      },
      channels: {},
      projects: { defaultPath: '/tmp/test' },
    } as any;

    registry.loadAll(config);
    const def = registry.get('[default]');
    expect(def).not.toBeNull();
    expect(def!.config.agents).toHaveProperty('claude');
    expect(def!.config.agents).toHaveProperty('codex');
    expect(def!.config.agents).toHaveProperty('gemini');
  });

  it('DefaultAgent with only defaultAgent declared still works', () => {
    const registry = new EvolAgentRegistry(tmpDir);
    const config: Config = {
      agents: { defaultAgent: 'claude' },
      channels: {},
      projects: { defaultPath: '/tmp/test' },
    } as any;

    registry.loadAll(config);
    const def = registry.get('[default]');
    expect(def).not.toBeNull();
    expect(def!.config.agents).toHaveProperty('claude');
    expect(def!.config.agents.claude).toEqual({});
  });

  it('DefaultAgent does not include undeclared baseagents', () => {
    const registry = new EvolAgentRegistry(tmpDir);
    const config: Config = {
      agents: {
        defaultAgent: 'claude',
        claude: { model: 'sonnet' },
      },
      channels: {},
      projects: { defaultPath: '/tmp/test' },
    } as any;

    registry.loadAll(config);
    const def = registry.get('[default]');
    expect(def!.config.agents).not.toHaveProperty('codex');
    expect(def!.config.agents).not.toHaveProperty('gemini');
  });
});
